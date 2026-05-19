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
    GalleyApi, HealthCheck, HealthReport, HealthStatus, MessageBrief, MessageId, MessageRole,
    SearchHit, SearchScope, SessionBrief, SessionFilter, SessionId, SessionStatus, StatusSummary,
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
