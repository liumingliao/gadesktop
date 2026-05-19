//! SQLite-backed implementation of [`GalleyApi`].
//!
//! Connection pool is held inside [`SqliteGalley`] which is `Clone`able
//! (the inner `sqlx::SqlitePool` is `Arc`-shared). Tauri commands grab
//! a handle from app state and `await` reads concurrently. The pool
//! sits on `sqlx` 0.8 — the same version `tauri-plugin-sql` already
//! brings in via Cargo.lock, so the binding to `libsqlite3-sys 0.30.x`
//! is shared (one set of SQLite symbols in the binary, FTS5 + trigram
//! tokenizer available on the same flags the GUI's writes use).
//!
//! **Path resolution.** The DB file lives in the platform-specific
//! app-data directory under the Tauri identifier `app.galley` —
//! exactly where `tauri-plugin-sql`'s `Database.load("sqlite:workbench.db")`
//! places it. [`db_path`] reproduces that lookup without an `AppHandle`
//! so the future Galley CLI binary (no Tauri context) can find the
//! same DB. **Identifier change == data move** — see
//! [CLAUDE.md "Tauri Identifier 不可随意改"](../../../CLAUDE.md).

use std::path::PathBuf;

use async_trait::async_trait;
use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};

use crate::api::{
    CreateProjectInput, CreateSessionInput, GalleyApi, HealthCheck, HealthReport, HealthStatus,
    MessageBrief, MessageId, MessageRole, Origin, ProjectBrief, ProjectId, ProjectPatch, SearchHit,
    SearchScope, SessionBrief, SessionFilter, SessionId, SessionStatus, StatusSummary,
};
use crate::error::{GalleyError, Result};

/// Tauri bundle identifier. Must match `tauri.conf.json:identifier`
/// otherwise the CLI binary will look in a different directory than
/// the GUI writes to. See [CLAUDE.md "Tauri Identifier 不可随意改"](../../../CLAUDE.md).
const APP_IDENTIFIER: &str = "app.galley";

/// File name inside `app_data_dir/`. Matches `tauri-plugin-sql`'s URL
/// `sqlite:workbench.db`.
const DB_FILENAME: &str = "workbench.db";

/// Resolve the absolute path of Galley's SQLite database file. Works
/// both inside a Tauri process (no `AppHandle` needed) and inside the
/// CLI binary. Returns `None` if the platform's app-data directory
/// can't be determined (very rare — would mean `$HOME` / `%APPDATA%`
/// are both unset).
///
/// **Override.** `GALLEY_DB_PATH` env var, when set, takes precedence
/// — Galley uses that exact file path. Intended for CLI integration
/// tests (point at a fixture) and advanced agent SOPs that want to
/// read from a snapshot. The Tauri GUI process inherits the user's
/// env so setting it for an interactive session works too.
pub fn db_path() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("GALLEY_DB_PATH") {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }
    // `directories` parses the identifier as `qualifier.organization.application`
    // but Tauri stores under the full identifier as a single segment. We pass
    // ("", "", "app.galley") so it produces `<base>/app.galley/` rather than
    // `<base>/app/galley/`.
    let dirs = ProjectDirs::from("", "", APP_IDENTIFIER)?;
    Some(dirs.data_dir().join(DB_FILENAME))
}

/// SQLite-backed Galley Core. Cheap to clone (pool internally is
/// `Arc<sqlx::PoolInner>`).
#[derive(Clone)]
pub struct SqliteGalley {
    pool: SqlitePool,
}

impl SqliteGalley {
    /// Open a pool against the resolved [`db_path`]. Fails with
    /// `DbUnavailable` when the file is missing or unopenable —
    /// indicates the GUI has never run on this machine. CLI callers
    /// should surface a "Galley hasn't been initialized" message rather
    /// than auto-creating an empty schema (which would mask a
    /// configuration mistake).
    pub async fn open() -> Result<Self> {
        let path = db_path().ok_or_else(|| GalleyError::DbUnavailable {
            message: "platform app-data directory unavailable".into(),
        })?;
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            // Do not auto-create: B1 reads against a DB the GUI owns
            // and populates. M3 read failure on a missing DB should
            // surface clearly instead of silently returning empty
            // rows from an auto-created blank schema.
            .create_if_missing(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await
            .map_err(|e| GalleyError::DbUnavailable {
                message: format!("opening {}: {e}", path.display()),
            })?;
        Ok(Self { pool })
    }

    /// Construct directly from an existing pool — used by tests against
    /// an in-memory DB and by future code paths that share a pool with
    /// `tauri-plugin-sql`.
    pub fn from_pool(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

// ---------------- internal row structs ----------------

#[derive(Debug, FromRow)]
struct SessionRow {
    id: String,
    project_id: Option<String>,
    title: String,
    status: String,
    summary: Option<String>,
    turn_count: i64,
    pinned: i64,
    has_unread: i64,
    last_activity_at: String,
    created_at: String,
    updated_at: String,
    llm_index: Option<i64>,
    llm_display_name: Option<String>,
}

impl SessionRow {
    fn into_brief(self) -> Result<SessionBrief> {
        Ok(SessionBrief {
            id: SessionId(self.id),
            project_id: self.project_id,
            title: self.title,
            status: parse_session_status(&self.status)?,
            summary: self.summary,
            turn_count: Some(self.turn_count.max(0) as u32),
            last_activity_at: self.last_activity_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
            pinned: Some(self.pinned != 0),
            has_unread: Some(self.has_unread != 0),
            selected_llm_index: self.llm_index.and_then(|n| {
                if n < 0 { None } else { Some(n as u32) }
            }),
            selected_llm_display_name: self.llm_display_name,
        })
    }
}

#[derive(Debug, FromRow)]
struct MessageRow {
    id: String,
    session_id: String,
    turn_index: i64,
    role: String,
    content: String,
    summary: Option<String>,
    created_at: String,
}

impl MessageRow {
    fn into_brief(self) -> Result<MessageBrief> {
        Ok(MessageBrief {
            id: MessageId(self.id),
            session_id: SessionId(self.session_id),
            role: parse_message_role(&self.role)?,
            content: self.content,
            created_at: self.created_at,
            summary: self.summary,
            turn_index: Some(self.turn_index.max(0) as u32),
            // Read APIs don't currently project origin onto MessageBrief
            // — the column exists from migration 006 but the read path
            // here was written before B2 M5 added the field. Returning
            // None keeps the JSON shape backward-compatible. A follow-up
            // can extend MessageRow + this projection if a consumer
            // needs it (e.g. v0.5 supervisor activity log in the GUI).
            origin: None,
        })
    }
}

#[derive(Debug, FromRow)]
struct SearchHitRow {
    message_id: String,
    session_id: String,
    snippet: String,
    /// FTS5 BM25 ranking — lower is better. Absent in the LIKE fallback
    /// (decoded as `0.0`).
    #[sqlx(default)]
    rank: f64,
}

#[derive(Debug, FromRow)]
struct StatusCounts {
    total: i64,
    running: i64,
    waiting_input: i64,
    errored: i64,
}

#[derive(Debug, FromRow)]
struct ProjectRow {
    id: String,
    name: String,
    root_path: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    pinned: i64,
    last_activity_at: String,
    created_at: String,
    updated_at: String,
}

impl ProjectRow {
    fn into_brief(self) -> ProjectBrief {
        ProjectBrief {
            id: ProjectId(self.id),
            name: self.name,
            root_path: self.root_path,
            icon: self.icon,
            color: self.color,
            pinned: self.pinned != 0,
            last_activity_at: self.last_activity_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

// ---------------- enum parsers ----------------

fn parse_session_status(s: &str) -> Result<SessionStatus> {
    Ok(match s {
        "idle" => SessionStatus::Idle,
        "connecting" => SessionStatus::Connecting,
        "running" => SessionStatus::Running,
        "waiting_approval" => SessionStatus::WaitingApproval,
        "error" => SessionStatus::Error,
        "completed" => SessionStatus::Completed,
        "cancelled" => SessionStatus::Cancelled,
        "archived" => SessionStatus::Archived,
        other => {
            return Err(GalleyError::Internal {
                message: format!("unknown session status: {other}"),
            })
        }
    })
}

fn session_status_sql(s: SessionStatus) -> &'static str {
    match s {
        SessionStatus::Idle => "idle",
        SessionStatus::Connecting => "connecting",
        SessionStatus::Running => "running",
        SessionStatus::WaitingApproval => "waiting_approval",
        SessionStatus::Error => "error",
        SessionStatus::Completed => "completed",
        SessionStatus::Cancelled => "cancelled",
        SessionStatus::Archived => "archived",
    }
}

fn parse_message_role(s: &str) -> Result<MessageRole> {
    Ok(match s {
        "user" => MessageRole::User,
        "assistant" => MessageRole::Agent,
        "system" => MessageRole::System,
        // GA's schema also persists role="tool" message rows for tool
        // results. The agent-facing API merges them into the agent's
        // turn rather than surfacing them as a distinct role.
        "tool" => MessageRole::Agent,
        other => {
            return Err(GalleyError::Internal {
                message: format!("unknown message role: {other}"),
            })
        }
    })
}

fn map_sqlx_err(e: sqlx::Error) -> GalleyError {
    GalleyError::Internal {
        message: format!("sqlx: {e}"),
    }
}

/// FK / CHECK constraint violations bubble out of sqlx as
/// `Database(...)` with no Rust-level discriminator. We want them to
/// surface as `invalid_args` (exit code 2) rather than `internal`
/// (exit code 1) so SOPs can distinguish "you passed a bad project id"
/// from "something blew up server-side". This shim looks at the SQLite
/// error message; everything else falls through to [`map_sqlx_err`].
fn map_constraint_err(context: &str, e: sqlx::Error) -> GalleyError {
    if let sqlx::Error::Database(ref db_err) = e {
        let msg = db_err.message().to_ascii_lowercase();
        if msg.contains("foreign key")
            || msg.contains("unique")
            || msg.contains("check")
            || msg.contains("primary key")
        {
            return GalleyError::InvalidArgs {
                message: format!("{context}: {}", db_err.message()),
            };
        }
    }
    map_sqlx_err(e)
}

/// Server-side title fallback. Mirrors the GUI's
/// `DEFAULT_NEW_SESSION_TITLE = "新对话"` constant so renames /
/// creates that trim to empty don't end up with a literal blank.
const DEFAULT_NEW_SESSION_TITLE: &str = "新对话";

/// Summary truncation budget. Matches `gui/src/stores/useAppStore.ts`
/// `truncateSummary` (80 char cap then `…`). Sidebar layout assumes
/// no wider than this for a single-line summary row.
const SUMMARY_TRUNCATE_LEN: usize = 80;

fn truncate_summary(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= SUMMARY_TRUNCATE_LEN {
        return trimmed.to_string();
    }
    let prefix: String = trimmed.chars().take(SUMMARY_TRUNCATE_LEN).collect();
    format!("{prefix}…")
}

/// Normalise `Option<Option<String>>` patch behaviour for nullable
/// string columns. Returns `(should_write, value)`:
/// - `None` (outer) → leave the column alone
/// - `Some(None)` → write SQL NULL
/// - `Some(Some(s))` → write `s` (with leading/trailing whitespace trimmed;
///   empty after trim also lands as NULL to match the GUI's "trim → undefined" behaviour)
fn project_nullable_patch(field: &Option<Option<String>>) -> (bool, Option<String>) {
    match field {
        None => (false, None),
        Some(None) => (true, None),
        Some(Some(v)) => {
            let t = v.trim();
            if t.is_empty() {
                (true, None)
            } else {
                (true, Some(t.to_string()))
            }
        }
    }
}

// ---------------- trait impl ----------------

const SESSIONS_SELECT_COLS: &str = "id, project_id, title, status, summary, turn_count, \
    pinned, has_unread, last_activity_at, created_at, updated_at, \
    llm_index, llm_display_name";

#[async_trait]
impl GalleyApi for SqliteGalley {
    async fn list_sessions(&self, filter: SessionFilter) -> Result<Vec<SessionBrief>> {
        // Hand-build WHERE so we can bind only the filters that are
        // set. sqlx doesn't have a fluent builder; query_builder works
        // but verbose for this scale.
        let mut sql = format!(
            "SELECT {SESSIONS_SELECT_COLS} FROM sessions WHERE 1=1"
        );
        if filter.project_id.is_some() {
            sql.push_str(" AND project_id = ?");
        }
        if filter.status.is_some() {
            sql.push_str(" AND status = ?");
        }
        // Standard Option<bool> filter semantics:
        //   None        → no archived filter (active + archived both returned)
        //   Some(false) → exclude archived
        //   Some(true)  → only archived
        // The CLI's `--all` flag passes None for this; the CLI default
        // and the GUI sidebar pass Some(false). GUI's `loadSessions`
        // historically returned everything (no filter) — matches None.
        match filter.archived {
            Some(false) => sql.push_str(" AND status != 'archived'"),
            Some(true) => sql.push_str(" AND status = 'archived'"),
            None => {}
        }
        sql.push_str(" ORDER BY pinned DESC, last_activity_at DESC");

        let mut q = sqlx::query_as::<_, SessionRow>(&sql);
        if let Some(pid) = filter.project_id.as_deref() {
            q = q.bind(pid);
        }
        if let Some(status) = filter.status {
            q = q.bind(session_status_sql(status));
        }
        let rows = q.fetch_all(&self.pool).await.map_err(map_sqlx_err)?;
        rows.into_iter().map(SessionRow::into_brief).collect()
    }

    async fn session_brief(&self, id: SessionId) -> Result<SessionBrief> {
        let row = sqlx::query_as::<_, SessionRow>(&format!(
            "SELECT {SESSIONS_SELECT_COLS} FROM sessions WHERE id = ? LIMIT 1"
        ))
        .bind(id.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sqlx_err)?
        .ok_or_else(|| GalleyError::NotFound {
            message: format!("session {id} not found"),
        })?;
        row.into_brief()
    }

    async fn session_messages(
        &self,
        id: SessionId,
        tail: Option<usize>,
    ) -> Result<Vec<MessageBrief>> {
        // No `tail` → full transcript, oldest-first.
        // `tail = Some(n)` → last n turns, returned in chronological
        // order. Implemented as ORDER BY DESC LIMIT n + reverse client-
        // side; subquery+ORDER BY ASC would work too but adds noise.
        let rows = if let Some(n) = tail {
            let limit = i64::try_from(n).unwrap_or(i64::MAX);
            let mut rows: Vec<MessageRow> = sqlx::query_as::<_, MessageRow>(
                "SELECT id, session_id, turn_index, role, content, summary, created_at \
                 FROM messages \
                 WHERE session_id = ? \
                 ORDER BY turn_index DESC, sequence DESC \
                 LIMIT ?",
            )
            .bind(id.as_str())
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
            rows.reverse();
            rows
        } else {
            sqlx::query_as::<_, MessageRow>(
                "SELECT id, session_id, turn_index, role, content, summary, created_at \
                 FROM messages \
                 WHERE session_id = ? \
                 ORDER BY turn_index ASC, sequence ASC",
            )
            .bind(id.as_str())
            .fetch_all(&self.pool)
            .await
            .map_err(map_sqlx_err)?
        };
        rows.into_iter().map(MessageRow::into_brief).collect()
    }

    async fn search_messages(
        &self,
        query: String,
        scope: SearchScope,
    ) -> Result<Vec<SearchHit>> {
        let q = query.trim();
        if q.len() < 2 {
            return Ok(vec![]);
        }
        const LIMIT: i64 = 20;

        // FTS5 trigram path (>= 3 chars). Wraps as a phrase so SQLite
        // treats the whole thing as a literal — matches the GUI's
        // searchMessages() behaviour exactly.
        if q.chars().count() >= 3 {
            let phrase = format!("\"{}\"", q.replace('"', "\"\""));
            let scope_clause = match scope {
                SearchScope::All => "",
                SearchScope::Active => " AND s.status != 'archived'",
            };
            let sql = format!(
                "SELECT fts.message_id AS message_id, \
                        fts.session_id AS session_id, \
                        snippet(messages_fts, 4, '<mark>', '</mark>', '…', 16) AS snippet, \
                        bm25(messages_fts) AS rank \
                 FROM messages_fts fts \
                 JOIN sessions s ON s.id = fts.session_id \
                 WHERE messages_fts MATCH ?{scope_clause} \
                 ORDER BY rank ASC \
                 LIMIT ?"
            );
            let res = sqlx::query_as::<_, SearchHitRow>(&sql)
                .bind(&phrase)
                .bind(LIMIT)
                .fetch_all(&self.pool)
                .await;
            match res {
                Ok(rows) => return Ok(rows.into_iter().map(into_search_hit).collect()),
                Err(e) => {
                    // FTS5 MATCH can fail on weird inputs (rare with
                    // phrase wrapping but possible). Fall through to
                    // LIKE so the search still returns something.
                    eprintln!("[galley-core] FTS5 search failed, falling back: {e}");
                }
            }
        }

        // 2-char fallback (and FTS error recovery). LIKE substring,
        // no highlight wrapping — GUI handles highlighting client-side.
        let like = format!("%{}%", escape_like(q));
        let scope_clause = match scope {
            SearchScope::All => "",
            SearchScope::Active => " AND s.status != 'archived'",
        };
        let sql = format!(
            "SELECT m.id AS message_id, \
                    m.session_id AS session_id, \
                    substr(m.content, 1, 200) AS snippet \
             FROM messages m \
             JOIN sessions s ON s.id = m.session_id \
             WHERE m.role IN ('user','assistant') \
               AND m.content LIKE ? ESCAPE '\\'{scope_clause} \
             ORDER BY s.last_activity_at DESC \
             LIMIT ?"
        );
        let rows = sqlx::query_as::<_, SearchHitRow>(&sql)
            .bind(&like)
            .bind(LIMIT)
            .fetch_all(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(rows.into_iter().map(into_search_hit).collect())
    }

    async fn status(&self) -> Result<StatusSummary> {
        // Persistence reality check: GUI only persists durable statuses
        // (archived / completed / cancelled), coercing transient ones
        // (running / waiting_approval / error) to "idle" before write
        // (see gui/src/lib/db.ts `persistableStatus`). So running/
        // waiting_input/errored will usually read as 0 here unless we
        // catch a write race. Real runtime counts will land via the
        // runner-manager (B2+); B1 surfaces the persisted truth.
        let counts: StatusCounts = sqlx::query_as(
            "SELECT \
               COUNT(*) AS total, \
               SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running, \
               SUM(CASE WHEN status='waiting_approval' THEN 1 ELSE 0 END) AS waiting_input, \
               SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errored \
             FROM sessions \
             WHERE status != 'archived'",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        Ok(StatusSummary {
            total: counts.total.max(0) as u32,
            running: counts.running.max(0) as u32,
            waiting_input: counts.waiting_input.max(0) as u32,
            errored: counts.errored.max(0) as u32,
        })
    }

    async fn health(&self) -> Result<HealthReport> {
        // B1 partial: filesystem / SQLite-only checks. Python /
        // agentmain / LLM-config probes need to spawn a runner sub-
        // process and are deferred to B4 daemon stage (see playbook G8 +
        // running note for T3.9 decision).
        let mut checks: Vec<HealthCheck> = Vec::new();

        // 1. DB readable — the fact this call ran means the pool
        // opened. Surface it explicitly so absent-DB scenarios still
        // produce a useful report.
        let probe: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .unwrap_or(0);
        checks.push(HealthCheck {
            id: "db_readable".into(),
            status: if probe == 1 {
                HealthStatus::Ok
            } else {
                HealthStatus::Fail
            },
            detail: db_path().map(|p| p.display().to_string()),
        });

        // 2. GA path (from prefs.ga_config JSON, field `gaPath`).
        // The pref key is snake_case (`ga_config`) but the inner JSON
        // uses camelCase to match the TS gaConfig shape — see
        // gui/src/stores/useAppStore.ts setPref("ga_config", ...).
        let ga_path: Option<String> = sqlx::query_scalar::<_, Option<String>>(
            "SELECT json_extract(value, '$.gaPath') FROM prefs WHERE key = 'ga_config' LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sqlx_err)?
        .flatten();
        match ga_path.as_deref() {
            Some(p) if std::path::Path::new(p).is_dir() => {
                checks.push(HealthCheck {
                    id: "ga_path".into(),
                    status: HealthStatus::Ok,
                    detail: Some(p.to_string()),
                });
            }
            Some(p) => {
                checks.push(HealthCheck {
                    id: "ga_path".into(),
                    status: HealthStatus::Fail,
                    detail: Some(format!("not a directory: {p}")),
                });
            }
            None => {
                checks.push(HealthCheck {
                    id: "ga_path".into(),
                    status: HealthStatus::Warn,
                    detail: Some("not set — finish Onboarding to attach a GA install".into()),
                });
            }
        }

        // 3. mykey.py — readability gated on ga_path being valid.
        match ga_path.as_deref() {
            Some(p) if std::path::Path::new(p).is_dir() => {
                let mykey = std::path::Path::new(p).join("mykey.py");
                if mykey.is_file() {
                    checks.push(HealthCheck {
                        id: "mykey_py".into(),
                        status: HealthStatus::Ok,
                        detail: Some(mykey.display().to_string()),
                    });
                } else {
                    checks.push(HealthCheck {
                        id: "mykey_py".into(),
                        status: HealthStatus::Fail,
                        detail: Some(format!("missing: {}", mykey.display())),
                    });
                }
            }
            _ => {
                checks.push(HealthCheck {
                    id: "mykey_py".into(),
                    status: HealthStatus::DeferredB4,
                    detail: Some("gated on ga_path".into()),
                });
            }
        }

        // 4. agentmain importable — needs a Python spawn. B4.
        checks.push(HealthCheck {
            id: "agentmain_import".into(),
            status: HealthStatus::DeferredB4,
            detail: Some("requires runner spawn — see B4 daemon".into()),
        });

        // 5. LLM session init — also a Python probe. B4.
        checks.push(HealthCheck {
            id: "llm_session_init".into(),
            status: HealthStatus::DeferredB4,
            detail: Some("requires runner spawn — see B4 daemon".into()),
        });

        Ok(HealthReport { checks })
    }

    async fn send_message(
        &self,
        session_id: SessionId,
        content: String,
        origin: crate::api::Origin,
    ) -> Result<MessageBrief> {
        // Validate target session exists + isn't archived. Cheap up-front
        // check — fails fast for malformed CLI calls, avoids a partial
        // write where the message row exists but the runner never sees it.
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT id, status FROM sessions WHERE id = ?",
        )
        .bind(&session_id.0)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sqlx_err)?;

        let (_id, status) = row.ok_or_else(|| GalleyError::NotFound {
            message: format!("session '{}' does not exist", session_id.0),
        })?;
        if status == "archived" {
            return Err(GalleyError::InvalidArgs {
                message: format!("session {} is archived", session_id.0),
            });
        }

        // Next turn_index = max(messages.turn_index) + 1. Reads concurrent
        // with another writer could pick the same turn_index — but SQLite's
        // WAL + the messages PK (id) means only one writer wins. For B2
        // M4 the only writers are GUI (one at a time via Composer) + CLI
        // (one at a time per session); race window narrow.
        let next_turn: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(turn_index), -1) + 1 FROM messages WHERE session_id = ?",
        )
        .bind(&session_id.0)
        .fetch_one(&self.pool)
        .await
        .map_err(map_sqlx_err)?;

        // Server-assigned id + timestamp. Format matches the existing
        // GUI convention (`msg_<random>` — see runner/workbench_bridge.py).
        // Using a UUIDv4 here would be cleaner but introduces a new dep
        // for ~36 chars of randomness; for now we use a timestamp +
        // counter pseudo-id good enough to be unique within a session.
        // Replace with uuid in B3 when we have the dep there anyway.
        let now = chrono_now_iso();
        let msg_id = format!("msg_{}_{}", now.replace([':', '-', '.', 'T', '+'], ""), next_turn);

        sqlx::query(
            "INSERT INTO messages \
             (id, session_id, turn_index, sequence, role, content, created_at, \
              created_via, supervisor, origin_note) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&msg_id)
        .bind(&session_id.0)
        .bind(next_turn)
        .bind(0_i64)
        .bind("user")
        .bind(&content)
        .bind(&now)
        .bind(origin.via.as_sql())
        .bind(&origin.supervisor)
        .bind(&origin.reason)
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;

        // Touch session.last_activity_at so the sidebar sort surfaces
        // this session at the top.
        sqlx::query(
            "UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(&now)
        .bind(&session_id.0)
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;

        Ok(MessageBrief {
            id: MessageId(msg_id),
            session_id,
            role: crate::api::message::MessageRole::User,
            content,
            created_at: now,
            summary: None,
            turn_index: Some(next_turn.max(0) as u32),
            origin: Some(origin),
        })
    }

    // ============= B3 M4a · session writes =============

    async fn create_session(
        &self,
        input: CreateSessionInput,
        origin: Origin,
    ) -> Result<SessionBrief> {
        let title = input.title.trim();
        if title.is_empty() {
            return Err(GalleyError::InvalidArgs {
                message: "create_session: title must not be empty".into(),
            });
        }
        let id = input.id.trim();
        if id.is_empty() {
            return Err(GalleyError::InvalidArgs {
                message: "create_session: id must not be empty".into(),
            });
        }
        let now = chrono_now_iso();
        let llm_idx: Option<i64> = input.selected_llm_index.map(|v| v as i64);
        sqlx::query(
            "INSERT INTO sessions (id, project_id, title, status, summary, turn_count, \
                pending_approval_count, error_count, pinned, has_unread, \
                llm_index, llm_display_name, last_activity_at, created_at, updated_at, \
                created_via, created_by_supervisor, created_origin_note) \
             VALUES (?, ?, ?, 'idle', NULL, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(&input.project_id)
        .bind(title)
        .bind(llm_idx)
        .bind(&input.selected_llm_display_name)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind(origin.via.as_sql())
        .bind(&origin.supervisor)
        .bind(&origin.reason)
        .execute(&self.pool)
        .await
        .map_err(|e| map_constraint_err("create_session", e))?;
        self.session_brief(SessionId(id.to_string())).await
    }

    async fn archive_session(&self, id: SessionId, _origin: Origin) -> Result<SessionBrief> {
        let now = chrono_now_iso();
        let res = sqlx::query(
            "UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(id.as_str())
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("session {id} not found"),
            });
        }
        self.session_brief(id).await
    }

    async fn unarchive_session(&self, id: SessionId, _origin: Origin) -> Result<SessionBrief> {
        let now = chrono_now_iso();
        // Only flip rows that are currently archived. A no-op on a
        // non-archived row is still a success (returns the unchanged
        // brief) so the GUI doesn't have to pre-check status.
        let _ = sqlx::query(
            "UPDATE sessions SET status = 'idle', updated_at = ? \
             WHERE id = ? AND status = 'archived'",
        )
        .bind(&now)
        .bind(id.as_str())
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        // Confirm the row exists — UPDATE returns 0 rows_affected for
        // both "row missing" AND "row not archived"; we need a real
        // existence probe to distinguish NotFound from no-op.
        self.session_brief(id).await
    }

    async fn rename_session(
        &self,
        id: SessionId,
        title: String,
        _origin: Origin,
    ) -> Result<SessionBrief> {
        let trimmed = title.trim();
        let final_title: &str = if trimmed.is_empty() {
            DEFAULT_NEW_SESSION_TITLE
        } else {
            trimmed
        };
        let now = chrono_now_iso();
        let res = sqlx::query(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
        )
        .bind(final_title)
        .bind(&now)
        .bind(id.as_str())
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("session {id} not found"),
            });
        }
        self.session_brief(id).await
    }

    async fn set_session_pinned(
        &self,
        id: SessionId,
        pinned: bool,
        _origin: Origin,
    ) -> Result<SessionBrief> {
        // Reject pin on archived rows up-front so the caller gets a
        // distinct error category instead of a silent no-op.
        let current_status: Option<String> =
            sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
                .bind(id.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(map_sqlx_err)?;
        let status = current_status.ok_or_else(|| GalleyError::NotFound {
            message: format!("session {id} not found"),
        })?;
        if status == "archived" {
            return Err(GalleyError::InvalidArgs {
                message: format!("session {id} is archived; cannot change pinned"),
            });
        }
        let now = chrono_now_iso();
        sqlx::query("UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?")
            .bind(if pinned { 1_i64 } else { 0_i64 })
            .bind(&now)
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        self.session_brief(id).await
    }

    async fn delete_session(&self, id: SessionId, _origin: Origin) -> Result<()> {
        let res = sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("session {id} not found"),
            });
        }
        Ok(())
    }

    async fn assign_session_to_project(
        &self,
        session_id: SessionId,
        project_id: Option<String>,
        _origin: Origin,
    ) -> Result<SessionBrief> {
        let now = chrono_now_iso();
        let res = sqlx::query(
            "UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&project_id)
        .bind(&now)
        .bind(session_id.as_str())
        .execute(&self.pool)
        .await
        .map_err(|e| map_constraint_err("assign_session_to_project", e))?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("session {session_id} not found"),
            });
        }
        self.session_brief(session_id).await
    }

    async fn set_session_llm(
        &self,
        id: SessionId,
        index: Option<u32>,
        display_name: Option<String>,
    ) -> Result<SessionBrief> {
        let now = chrono_now_iso();
        let idx: Option<i64> = index.map(|v| v as i64);
        let res = sqlx::query(
            "UPDATE sessions SET llm_index = ?, llm_display_name = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(idx)
        .bind(&display_name)
        .bind(&now)
        .bind(id.as_str())
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("session {id} not found"),
            });
        }
        self.session_brief(id).await
    }

    async fn bump_session_after_turn(
        &self,
        id: SessionId,
        summary: Option<String>,
        step_number: Option<u32>,
        mark_unread: bool,
    ) -> Result<SessionBrief> {
        let now = chrono_now_iso();
        // Only refresh summary when caller passed a non-empty value.
        // Bridge sometimes emits turn_end with empty summary (no recap
        // generated this round); we keep the previous summary so the
        // sidebar row doesn't blank out mid-conversation.
        let new_summary: Option<String> = summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(truncate_summary);
        let step = step_number.map(|n| n as i64);

        // bumpSessionAfterTurn historically didn't touch
        // `last_step_index` if the bridge didn't send `stepNumber`.
        // Sqlite COALESCE keeps the previous value when the bind is NULL.
        if let Some(s) = new_summary {
            let res = sqlx::query(
                "UPDATE sessions SET \
                    turn_count = turn_count + 1, \
                    summary = ?, \
                    last_activity_at = ?, \
                    updated_at = ?, \
                    has_unread = CASE WHEN ? = 1 THEN 1 ELSE has_unread END \
                 WHERE id = ?",
            )
            .bind(&s)
            .bind(&now)
            .bind(&now)
            .bind(if mark_unread { 1_i64 } else { 0_i64 })
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
            if res.rows_affected() == 0 {
                return Err(GalleyError::NotFound {
                    message: format!("session {id} not found"),
                });
            }
        } else {
            let res = sqlx::query(
                "UPDATE sessions SET \
                    turn_count = turn_count + 1, \
                    last_activity_at = ?, \
                    updated_at = ?, \
                    has_unread = CASE WHEN ? = 1 THEN 1 ELSE has_unread END \
                 WHERE id = ?",
            )
            .bind(&now)
            .bind(&now)
            .bind(if mark_unread { 1_i64 } else { 0_i64 })
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
            if res.rows_affected() == 0 {
                return Err(GalleyError::NotFound {
                    message: format!("session {id} not found"),
                });
            }
        }

        // last_step_index isn't a column on the sessions table — it's
        // a transient runtime field the GUI computes from per-turn
        // events. Persisting it here was discussed in the M4 sub-plan
        // but rejected: bumpSessionAfterTurn's GUI counterpart only
        // mirrors it into in-memory state, not SQLite. Suppress the
        // unused param to keep the signature stable for B4+ where a
        // future audit table may pick it up.
        let _ = step;
        self.session_brief(id).await
    }

    async fn clear_session_unread(&self, id: SessionId) -> Result<()> {
        let now = chrono_now_iso();
        let res = sqlx::query(
            "UPDATE sessions SET has_unread = 0, updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(id.as_str())
        .execute(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("session {id} not found"),
            });
        }
        Ok(())
    }

    async fn bulk_archive_sessions(
        &self,
        ids: Vec<SessionId>,
        _origin: Origin,
    ) -> Result<u32> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut tx = self.pool.begin().await.map_err(map_sqlx_err)?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let now = chrono_now_iso();
        let sql = format!(
            "UPDATE sessions SET status = 'archived', updated_at = ? \
             WHERE id IN ({placeholders}) AND status != 'archived'",
        );
        let mut q = sqlx::query(&sql).bind(&now);
        for id in &ids {
            q = q.bind(id.as_str());
        }
        let res = q.execute(&mut *tx).await.map_err(map_sqlx_err)?;
        tx.commit().await.map_err(map_sqlx_err)?;
        Ok(res.rows_affected() as u32)
    }

    async fn bulk_unarchive_sessions(
        &self,
        ids: Vec<SessionId>,
        _origin: Origin,
    ) -> Result<u32> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut tx = self.pool.begin().await.map_err(map_sqlx_err)?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let now = chrono_now_iso();
        let sql = format!(
            "UPDATE sessions SET status = 'idle', updated_at = ? \
             WHERE id IN ({placeholders}) AND status = 'archived'",
        );
        let mut q = sqlx::query(&sql).bind(&now);
        for id in &ids {
            q = q.bind(id.as_str());
        }
        let res = q.execute(&mut *tx).await.map_err(map_sqlx_err)?;
        tx.commit().await.map_err(map_sqlx_err)?;
        Ok(res.rows_affected() as u32)
    }

    async fn bulk_delete_sessions(
        &self,
        ids: Vec<SessionId>,
        _origin: Origin,
    ) -> Result<u32> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut tx = self.pool.begin().await.map_err(map_sqlx_err)?;
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!("DELETE FROM sessions WHERE id IN ({placeholders})");
        let mut q = sqlx::query(&sql);
        for id in &ids {
            q = q.bind(id.as_str());
        }
        let res = q.execute(&mut *tx).await.map_err(map_sqlx_err)?;
        tx.commit().await.map_err(map_sqlx_err)?;
        Ok(res.rows_affected() as u32)
    }

    // ============= B3 M4a · project writes =============

    async fn list_projects(&self) -> Result<Vec<ProjectBrief>> {
        let rows = sqlx::query_as::<_, ProjectRow>(
            "SELECT id, name, root_path, icon, color, pinned, \
                last_activity_at, created_at, updated_at \
             FROM projects \
             ORDER BY pinned DESC, last_activity_at DESC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        Ok(rows.into_iter().map(ProjectRow::into_brief).collect())
    }

    async fn create_project(
        &self,
        input: CreateProjectInput,
        _origin: Origin,
    ) -> Result<ProjectBrief> {
        let id = input.id.trim();
        if id.is_empty() {
            return Err(GalleyError::InvalidArgs {
                message: "create_project: id must not be empty".into(),
            });
        }
        let name = input.name.trim();
        if name.is_empty() {
            return Err(GalleyError::InvalidArgs {
                message: "create_project: name must not be empty".into(),
            });
        }
        let root_path = input
            .root_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let now = chrono_now_iso();
        sqlx::query(
            "INSERT INTO projects (id, name, root_path, icon, color, pinned, \
                last_activity_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(&root_path)
        .bind(&input.icon)
        .bind(&input.color)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .map_err(|e| map_constraint_err("create_project", e))?;
        self.fetch_project(id).await
    }

    async fn update_project(
        &self,
        id: ProjectId,
        patch: ProjectPatch,
        _origin: Origin,
    ) -> Result<ProjectBrief> {
        // Existence check up-front gives a clean NotFound vs silently
        // 0-row UPDATE when every patch field is None.
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM projects WHERE id = ?")
                .bind(id.as_str())
                .fetch_optional(&self.pool)
                .await
                .map_err(map_sqlx_err)?;
        if exists.is_none() {
            return Err(GalleyError::NotFound {
                message: format!("project {id} not found"),
            });
        }
        // Build SET clause incrementally so omitted patch fields stay
        // at their current SQL value.
        let mut sets: Vec<&str> = Vec::with_capacity(6);
        let now = chrono_now_iso();
        let mut name_val: Option<String> = None;
        if let Some(raw) = patch.name.as_ref() {
            let t = raw.trim();
            if t.is_empty() {
                return Err(GalleyError::InvalidArgs {
                    message: "update_project: name must not be empty".into(),
                });
            }
            name_val = Some(t.to_string());
            sets.push("name = ?");
        }
        let (write_root, root_val) = project_nullable_patch(&patch.root_path);
        if write_root {
            sets.push("root_path = ?");
        }
        let (write_icon, icon_val) = project_nullable_patch(&patch.icon);
        if write_icon {
            sets.push("icon = ?");
        }
        let (write_color, color_val) = project_nullable_patch(&patch.color);
        if write_color {
            sets.push("color = ?");
        }
        if patch.pinned.is_some() {
            sets.push("pinned = ?");
        }
        sets.push("updated_at = ?");

        let sql = format!("UPDATE projects SET {} WHERE id = ?", sets.join(", "));
        let mut q = sqlx::query(&sql);
        if let Some(v) = name_val.as_ref() {
            q = q.bind(v);
        }
        if write_root {
            q = q.bind(&root_val);
        }
        if write_icon {
            q = q.bind(&icon_val);
        }
        if write_color {
            q = q.bind(&color_val);
        }
        if let Some(p) = patch.pinned {
            q = q.bind(if p { 1_i64 } else { 0_i64 });
        }
        q = q.bind(&now).bind(id.as_str());
        q.execute(&self.pool).await.map_err(map_sqlx_err)?;
        self.fetch_project(id.as_str()).await
    }

    async fn delete_project(&self, id: ProjectId, _origin: Origin) -> Result<()> {
        let res = sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        if res.rows_affected() == 0 {
            return Err(GalleyError::NotFound {
                message: format!("project {id} not found"),
            });
        }
        Ok(())
    }
}

impl SqliteGalley {
    /// Internal helper used by `create_project` / `update_project` to
    /// re-read the row after a write. Returns NotFound when the id
    /// vanished between the write and the read (should never happen
    /// outside of an external concurrent DELETE, but explicit beats
    /// `unwrap`).
    async fn fetch_project(&self, id: &str) -> Result<ProjectBrief> {
        let row = sqlx::query_as::<_, ProjectRow>(
            "SELECT id, name, root_path, icon, color, pinned, \
                last_activity_at, created_at, updated_at \
             FROM projects WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sqlx_err)?
        .ok_or_else(|| GalleyError::NotFound {
            message: format!("project {id} not found"),
        })?;
        Ok(row.into_brief())
    }
}

/// Best-effort ISO 8601 timestamp. We avoid the `chrono` dep (one extra
/// crate + transitive deps for one format call) by using `std::time` +
/// hand-rolled UTC offset = 0. This is fine because the wire format
/// consumes any valid ISO 8601 with offset, and downstream sorting is
/// lexicographic.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = dur.as_secs() as i64;
    let days = total_secs / 86_400;
    let rem = total_secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    // Civil-from-days algorithm (Howard Hinnant) for date components.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}+00:00",
        y, m, d, hour, min, sec
    )
}

fn into_search_hit(r: SearchHitRow) -> SearchHit {
    SearchHit {
        session_id: SessionId(r.session_id),
        message_id: MessageId(r.message_id),
        snippet: r.snippet,
        rank: r.rank,
    }
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(c);
            }
            other => out.push(other),
        }
    }
    out
}
