//! Galley CLI — agent-first interface to Galley Core.
//!
//! B1 M4 ships six **read-only** commands that all open the local
//! SQLite database directly (no daemon yet; B4 introduces the
//! socket-backed transport per refactor invariant B1-I5).
//!
//! Output discipline:
//!   - Success → JSON on stdout. List-returning commands emit
//!     NDJSON (one object per line) so agents can stream-parse.
//!   - Error   → JSON on stdout matching `GalleyError`'s
//!     `{"error": "<category>", "detail": …}` shape. **Errors go to
//!     stdout, not stderr** — agents read one stream. stderr is
//!     reserved for unrecoverable runtime panics.
//!   - Exit code maps `GalleyError` variants to fixed categories
//!     (see [`run`]) so SOPs can branch without parsing.

use std::process::ExitCode;

use clap::{Parser, Subcommand};
use galley_core_lib::api::{
    GalleyApi, SearchScope, SessionFilter, SessionId, SessionStatus,
};
use galley_core_lib::db::SqliteGalley;
use galley_core_lib::error::GalleyError;
use galley_core_lib::socket_listener::socket_path;
use serde_json::Value;

const SCHEMA_VERSION: u32 = 1;

#[derive(Parser, Debug)]
#[command(
    name = "galley",
    version,
    about = "Agent-first interface to Galley (the local agent team orchestrator)."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Operations on multiple sessions (list / search).
    #[command(subcommand)]
    Sessions(SessionsCmd),

    /// Operations on a single session (brief / show).
    #[command(subcommand)]
    Session(SessionCmd),

    /// Aggregate counts: total / running / waiting_input / errored.
    Status,

    /// Run the partial B1 health probe (SQLite-checkable rows only;
    /// Python-dependent rows surface as `deferred_b4`).
    Health,

    /// Print the CLI + schema version.
    Version,

    /// Project operations (create / list / delete). v0.5 has no
    /// reversible "archive" surface — `delete` is destructive (FK SET
    /// NULL detaches child sessions to ungrouped). A future v0.6+ ships
    /// `archive` separately with reversible semantics (sub-plan O2).
    #[command(subcommand)]
    Project(ProjectCmd),

    /// LLM configuration commands. `llm list` reads the cached
    /// `llm_list` pref that the GUI seeds after a bridge warmup —
    /// requires Galley GUI to have been opened at least once. `llm set`
    /// persists a per-session pick + best-effort tells any live runner.
    #[command(subcommand)]
    Llm(LlmCmd),
}

#[derive(Subcommand, Debug)]
enum ProjectCmd {
    /// Create a project.
    Create {
        /// Project name (will be trimmed; empty → exit 2).
        name: String,
        /// Optional filesystem root path. Historical — currently stored
        /// on the row but no longer injected at runner spawn (see
        /// 2026-05-14 devlog on the rootPath rollback).
        #[arg(long)]
        root_path: Option<String>,
        /// Optional emoji icon. Defaults to GUI's `📁` if omitted.
        #[arg(long)]
        icon: Option<String>,
        /// Optional accent color (hex e.g. `#7c84ff`).
        #[arg(long)]
        color: Option<String>,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// List all projects ordered pinned-first then by recency.
    /// Read-only — opens SQLite directly without requiring Galley Core
    /// to be running.
    List,
    /// Permanently delete a project. Child sessions auto-detach to
    /// ungrouped (FK SET NULL); the sessions themselves survive.
    /// Response includes `detachedSessions` count + the list of
    /// affected session ids so a supervisor agent can log the side
    /// effect.
    ///
    /// v0.5: this is destructive. v0.6+ will ship a separate
    /// `archive` command with reversible semantics (sub-plan O2).
    Delete {
        /// Project id.
        project_id: String,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum LlmCmd {
    /// List LLMs configured in the user's `mykey.py`. Read-only — opens
    /// SQLite directly. Returns the same `{index, name}` shape the GUI
    /// caches after a bridge warmup. Empty NDJSON when the cache is
    /// unwarmed (open the GUI once to populate).
    List,
    /// Pick the LLM for a session by display name (case-insensitive).
    /// Persists `selectedLlmIndex` + `selectedLlmDisplayName` on the
    /// session row + best-effort tells the live runner via
    /// `IpcCommand::SetLlm`. The DB write is the source of truth; the
    /// runner dispatch is opportunistic. `dispatch=dispatched` /
    /// `persisted_only` indicates which path ran.
    Set {
        /// Session id.
        session_id: String,
        /// Display name of the LLM as it appears in `galley llm list`
        /// (case-insensitive).
        llm_name: String,
    },
}

#[derive(Subcommand, Debug)]
enum SessionsCmd {
    /// List sessions, ordered pinned first then by recency.
    List {
        /// Filter to one project id.
        #[arg(long)]
        project: Option<String>,
        /// Filter to one session status (idle / running / archived / …).
        #[arg(long)]
        status: Option<String>,
        /// Include only archived sessions.
        #[arg(long)]
        archived: bool,
        /// Include archived + active sessions (overrides --archived).
        #[arg(long)]
        all: bool,
    },
    /// FTS5 trigram search across persisted message bodies.
    Search {
        /// Query string. Returns no hits for <2 chars; LIKE fallback
        /// for 2-char queries; FTS5 phrase match for >=3 chars.
        query: String,
        /// Search archived sessions too (default: active only).
        #[arg(long)]
        all: bool,
    },
}

#[derive(Subcommand, Debug)]
enum SessionCmd {
    /// One-row summary for a session id.
    Brief {
        /// Session id (e.g. `sess_abc…`).
        id: String,
    },
    /// Conversation messages for a session.
    Show {
        /// Session id.
        id: String,
        /// Return only the last N messages instead of the full
        /// transcript. Useful for agents catching up.
        #[arg(long)]
        tail: Option<usize>,
    },
    /// Send a user message into a session (B2 M4). Persists to the
    /// `messages` table with the supplied origin triple + dispatches
    /// to the live runner subprocess (if one is alive). Requires Galley
    /// Core to be running (exit 4 if the socket isn't reachable).
    Send {
        /// Session id.
        id: String,
        /// Message body.
        content: String,
        /// Supervisor label — the agent identity / SOP name (e.g.
        /// "ga-claude-1"). Required for via=supervisor; optional for
        /// via=cli.
        #[arg(long)]
        supervisor: Option<String>,
        /// Free-text reason for the action. Shows up in audit/log views.
        #[arg(long)]
        reason: Option<String>,
    },
    /// Stream live IPC events from a session's runner (B2 M4). NDJSON
    /// on stdout — one event per line. Exits cleanly when the
    /// subprocess terminates (`{"stream":"end",...}`) or the user
    /// sends SIGINT.
    Watch {
        /// Session id.
        id: String,
    },
    /// Create a new session with a first user message (B4 M1). Atomic:
    /// session row + first message commit together or roll back together.
    /// Returns `{session, message, dispatch}` — `dispatch` is `dispatched`
    /// when the runner subprocess was alive and received the message, or
    /// `persisted_only` when there's no live bridge (CLI doesn't spawn
    /// runners; the GUI or a subsequent `session send` warms them up).
    New {
        /// First user message. Doubles as the seed for title derivation
        /// after the bridge finishes the first turn.
        task: String,
        /// Optional project id. Session is detached (ungrouped) if omitted.
        #[arg(long)]
        project: Option<String>,
        /// Optional LLM display name (case-insensitive). Resolved against
        /// the `llm_list` pref cached by the GUI after warmup; if the
        /// cache is empty or the name is unknown, exits 2 (invalid args).
        #[arg(long)]
        llm: Option<String>,
        /// Supervisor label — agent identity / SOP name. Sets origin via
        /// to `supervisor`; omit for via=`cli`.
        #[arg(long)]
        supervisor: Option<String>,
        /// Free-text reason for the action. Surfaces in audit views.
        #[arg(long)]
        reason: Option<String>,
    },
    /// Send a transient "by the way" side question into a running session
    /// (B4 M1). The runner detects the `/btw` prefix and bypasses its
    /// task queue — useful for asking the agent a quick question mid-run
    /// without disturbing the main thread. Not persisted to the messages
    /// table (v0.1 transient policy); requires an alive bridge (exit 5
    /// otherwise).
    Btw {
        /// Session id.
        id: String,
        /// Side question body.
        question: String,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Stop the current turn in a session (B4 M1). Sends `Abort` to the
    /// runner — the agent's loop exits and emits `run_complete` with the
    /// `ABORTED` marker, but the bridge process stays alive so a
    /// subsequent `session send` resumes without paying the respawn cost.
    /// Idempotent: stopping an already-idle session returns
    /// `{dispatch: "already_stopped"}` and exit 0.
    Stop {
        /// Session id.
        id: String,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Archive a session — flips status to `archived` and hides it from
    /// the GUI sidebar's active list. Reversible via `session restore`.
    Archive {
        /// Session id.
        id: String,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Restore (unarchive) a previously archived session. Flips status
    /// from `archived` back to `idle`; no-op if the session wasn't
    /// archived.
    Restore {
        /// Session id.
        id: String,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Move a session into / out of a project (B4 M1). `--to=<project-id>`
    /// attaches; omit `--to` to detach (move to ungrouped). The session is
    /// the subject of the move — projects don't shuffle, sessions migrate
    /// between them (sub-plan O3 noun-as-subject grammar).
    Move {
        /// Session id.
        id: String,
        /// Target project id. Omit to detach from any project.
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        supervisor: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // Error → JSON on stdout (agents read one stream).
            let json = serde_json::to_string(&e)
                .unwrap_or_else(|_| format!("{{\"error\":\"internal\",\"detail\":{{\"message\":\"{}\"}}}}", e));
            println!("{json}");
            ExitCode::from(exit_code_for(&e))
        }
    }
}

/// Map `GalleyError` variants to stable exit code categories. SOPs can
/// branch on these without parsing the error JSON.
fn exit_code_for(e: &GalleyError) -> u8 {
    match e {
        GalleyError::NotFound { .. } => 3,
        GalleyError::InvalidArgs { .. } => 2,
        GalleyError::DbUnavailable { .. } => 4,
        GalleyError::RunnerError { .. } => 5,
        GalleyError::Internal { .. } => 1,
    }
}

async fn run(cli: Cli) -> Result<(), GalleyError> {
    match cli.command {
        Command::Sessions(SessionsCmd::List {
            project,
            status,
            archived,
            all,
        }) => {
            let galley = SqliteGalley::open().await?;
            let archived_flag = if all {
                None
            } else if archived {
                Some(true)
            } else {
                Some(false)
            };
            let filter = SessionFilter {
                project_id: project,
                status: status
                    .as_deref()
                    .map(parse_status_arg)
                    .transpose()?,
                archived: archived_flag,
            };
            let rows = galley.list_sessions(filter).await?;
            // NDJSON — one object per line, so agents can stream-parse.
            for row in rows {
                emit_json(&row)?;
            }
            Ok(())
        }
        Command::Sessions(SessionsCmd::Search { query, all }) => {
            let galley = SqliteGalley::open().await?;
            let scope = if all {
                SearchScope::All
            } else {
                SearchScope::Active
            };
            let hits = galley.search_messages(query, scope).await?;
            for hit in hits {
                emit_json(&hit)?;
            }
            Ok(())
        }
        Command::Session(SessionCmd::Brief { id }) => {
            let galley = SqliteGalley::open().await?;
            let brief = galley.session_brief(SessionId(id)).await?;
            emit_json(&brief)?;
            Ok(())
        }
        Command::Session(SessionCmd::Show { id, tail }) => {
            let galley = SqliteGalley::open().await?;
            let msgs = galley.session_messages(SessionId(id), tail).await?;
            for m in msgs {
                emit_json(&m)?;
            }
            Ok(())
        }
        Command::Session(SessionCmd::Send {
            id,
            content,
            supervisor,
            reason,
        }) => session_send(id, content, supervisor, reason).await,
        Command::Session(SessionCmd::Watch { id }) => session_watch(id).await,
        Command::Session(SessionCmd::New {
            task,
            project,
            llm,
            supervisor,
            reason,
        }) => session_new(task, project, llm, supervisor, reason).await,
        Command::Session(SessionCmd::Btw {
            id,
            question,
            supervisor,
            reason,
        }) => session_btw(id, question, supervisor, reason).await,
        Command::Session(SessionCmd::Stop {
            id,
            supervisor,
            reason,
        }) => session_stop(id, supervisor, reason).await,
        Command::Session(SessionCmd::Archive {
            id,
            supervisor,
            reason,
        }) => session_archive(id, supervisor, reason).await,
        Command::Session(SessionCmd::Restore {
            id,
            supervisor,
            reason,
        }) => session_restore(id, supervisor, reason).await,
        Command::Session(SessionCmd::Move {
            id,
            to,
            supervisor,
            reason,
        }) => session_move(id, to, supervisor, reason).await,
        Command::Status => {
            let galley = SqliteGalley::open().await?;
            let s = galley.status().await?;
            emit_json(&s)?;
            Ok(())
        }
        Command::Health => {
            let galley = SqliteGalley::open().await?;
            let report = galley.health().await?;
            emit_json(&report)?;
            Ok(())
        }
        Command::Version => {
            #[derive(serde::Serialize)]
            struct VersionPayload<'a> {
                galley_version: &'a str,
                schema_version: u32,
            }
            emit_json(&VersionPayload {
                galley_version: env!("CARGO_PKG_VERSION"),
                schema_version: SCHEMA_VERSION,
            })?;
            Ok(())
        }
        Command::Project(ProjectCmd::Create {
            name,
            root_path,
            icon,
            color,
            supervisor,
            reason,
        }) => project_create(name, root_path, icon, color, supervisor, reason).await,
        Command::Project(ProjectCmd::List) => project_list().await,
        Command::Project(ProjectCmd::Delete {
            project_id,
            supervisor,
            reason,
        }) => project_delete(project_id, supervisor, reason).await,
        Command::Llm(LlmCmd::List) => llm_list().await,
        Command::Llm(LlmCmd::Set {
            session_id,
            llm_name,
        }) => llm_set(session_id, llm_name).await,
    }
}

fn parse_status_arg(s: &str) -> Result<SessionStatus, GalleyError> {
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
            return Err(GalleyError::InvalidArgs {
                message: format!(
                    "unknown --status `{other}`. Allowed: idle, connecting, running, \
                     waiting_approval, error, completed, cancelled, archived"
                ),
            })
        }
    })
}

fn emit_json<T: serde::Serialize>(value: &T) -> Result<(), GalleyError> {
    let s = serde_json::to_string(value).map_err(|e| GalleyError::Internal {
        message: format!("serialize output: {e}"),
    })?;
    println!("{s}");
    Ok(())
}

// ---- socket transport helpers (B2 M4) ----

/// One round-trip request → response over the Unix socket / Windows
/// named pipe. Maps connect errors to `DbUnavailable` (exit 4) per the
/// CLI exit-code contract.
#[cfg(unix)]
async fn socket_send_recv(req: serde_json::Value) -> Result<String, GalleyError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    let path = socket_path();
    let stream = UnixStream::connect(&path).await.map_err(|e| {
        GalleyError::DbUnavailable {
            message: format!(
                "Galley Core not running (socket {}: {})",
                path.display(),
                e
            ),
        }
    })?;
    let (read_half, mut write_half) = stream.into_split();
    let line = serde_json::to_string(&req).unwrap();
    write_half
        .write_all(line.as_bytes())
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("socket write: {e}"),
        })?;
    write_half
        .write_all(b"\n")
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("socket write: {e}"),
        })?;
    write_half
        .flush()
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("socket flush: {e}"),
        })?;
    let mut lines = BufReader::new(read_half).lines();
    let resp = lines
        .next_line()
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("socket read: {e}"),
        })?
        .ok_or_else(|| GalleyError::DbUnavailable {
            message: "socket EOF before response".into(),
        })?;
    Ok(resp)
}

#[cfg(windows)]
async fn socket_send_recv(req: serde_json::Value) -> Result<String, GalleyError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;
    let path = socket_path();
    let path_str = path.to_str().ok_or_else(|| GalleyError::Internal {
        message: "named pipe path not UTF-8".into(),
    })?;
    let stream = ClientOptions::new()
        .open(path_str)
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("Galley Core not running (pipe {}: {})", path_str, e),
        })?;
    let (read_half, mut write_half) = tokio::io::split(stream);
    let line = serde_json::to_string(&req).unwrap();
    write_half
        .write_all(line.as_bytes())
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("pipe write: {e}"),
        })?;
    write_half
        .write_all(b"\n")
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("pipe write: {e}"),
        })?;
    write_half
        .flush()
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("pipe flush: {e}"),
        })?;
    let mut lines = BufReader::new(read_half).lines();
    let resp = lines
        .next_line()
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("pipe read: {e}"),
        })?
        .ok_or_else(|| GalleyError::DbUnavailable {
            message: "pipe EOF before response".into(),
        })?;
    Ok(resp)
}

async fn session_send(
    id: String,
    content: String,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.send",
        "args": {
            "sessionId": id,
            "content": content,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    let resp_line = socket_send_recv(req).await?;
    // Parse + decide whether to surface as success (exit 0) or map to
    // a CLI error (exit code based on the `error` discriminant).
    let parsed: serde_json::Value =
        serde_json::from_str(&resp_line).map_err(|e| GalleyError::Internal {
            message: format!("malformed socket response: {e}"),
        })?;
    if parsed["ok"] == serde_json::Value::Bool(true) {
        // Pass the result through as-is so agents can parse the
        // assigned message id + dispatch status.
        println!("{}", parsed["result"]);
        Ok(())
    } else {
        let tag = parsed["error"].as_str().unwrap_or("internal");
        let msg = parsed["message"].as_str().unwrap_or("").to_string();
        Err(map_error_tag(tag, msg))
    }
}

async fn session_watch(id: String) -> Result<(), GalleyError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    // Streaming subscription: we hand-roll the loop here rather than
    // reusing socket_send_recv because we keep the connection open.
    let req = serde_json::json!({
        "command": "session.watch",
        "args": { "sessionId": id },
        "schemaVersion": SCHEMA_VERSION,
    });

    #[cfg(unix)]
    let (read_half, mut write_half) = {
        use tokio::net::UnixStream;
        let path = socket_path();
        let stream = UnixStream::connect(&path).await.map_err(|e| {
            GalleyError::DbUnavailable {
                message: format!(
                    "Galley Core not running (socket {}: {})",
                    path.display(),
                    e
                ),
            }
        })?;
        stream.into_split()
    };
    #[cfg(windows)]
    let (read_half, mut write_half) = {
        use tokio::net::windows::named_pipe::ClientOptions;
        let path = socket_path();
        let path_str = path.to_str().ok_or_else(|| GalleyError::Internal {
            message: "named pipe path not UTF-8".into(),
        })?;
        let stream = ClientOptions::new()
            .open(path_str)
            .map_err(|e| GalleyError::DbUnavailable {
                message: format!("Galley Core not running (pipe {}: {})", path_str, e),
            })?;
        tokio::io::split(stream)
    };

    let line = serde_json::to_string(&req).unwrap();
    write_half
        .write_all(line.as_bytes())
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("watch write: {e}"),
        })?;
    write_half
        .write_all(b"\n")
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("watch write: {e}"),
        })?;
    write_half
        .flush()
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("watch flush: {e}"),
        })?;

    let mut lines = BufReader::new(read_half).lines();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| GalleyError::DbUnavailable {
            message: format!("watch read: {e}"),
        })?
    {
        // Print every line as-is; agents stream-parse the NDJSON. End
        // sentinel ({"stream":"end",...}) flows through unchanged and
        // the loop exits because the server closes the connection.
        println!("{line}");
        let parsed: serde_json::Value =
            serde_json::from_str(&line).unwrap_or(serde_json::Value::Null);
        // Stream-end + initial-error responses both close the loop.
        if parsed["stream"] == "end" {
            break;
        }
        if parsed["ok"] == serde_json::Value::Bool(false) {
            let tag = parsed["error"].as_str().unwrap_or("internal");
            let msg = parsed["message"].as_str().unwrap_or("").to_string();
            return Err(map_error_tag(tag, msg));
        }
    }
    Ok(())
}

/// Shared socket round-trip for the unary write commands (`session.new`,
/// `session.btw`, `session.stop`, `session.archive`, `session.restore`,
/// `session.move`). All return JSON-shaped success payloads, so we just
/// pass the `result` field through to stdout.
async fn unary_command(req: serde_json::Value) -> Result<(), GalleyError> {
    let resp_line = socket_send_recv(req).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&resp_line).map_err(|e| GalleyError::Internal {
            message: format!("malformed socket response: {e}"),
        })?;
    if parsed["ok"] == serde_json::Value::Bool(true) {
        println!("{}", parsed["result"]);
        Ok(())
    } else {
        let tag = parsed["error"].as_str().unwrap_or("internal");
        let msg = parsed["message"].as_str().unwrap_or("").to_string();
        Err(map_error_tag(tag, msg))
    }
}

async fn session_new(
    task: String,
    project: Option<String>,
    llm: Option<String>,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.new",
        "args": {
            "task": task,
            "projectId": project,
            "llmName": llm,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

async fn session_btw(
    id: String,
    question: String,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.btw",
        "args": {
            "sessionId": id,
            "question": question,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

async fn session_stop(
    id: String,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.stop",
        "args": {
            "sessionId": id,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

async fn session_archive(
    id: String,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.archive",
        "args": {
            "sessionId": id,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

async fn session_restore(
    id: String,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.restore",
        "args": {
            "sessionId": id,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

async fn session_move(
    id: String,
    to: Option<String>,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "session.move",
        "args": {
            "sessionId": id,
            "to": to,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

// ---- B4 M1.3 helpers · project + llm ----

async fn project_create(
    name: String,
    root_path: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "project.create",
        "args": {
            "name": name,
            "rootPath": root_path,
            "icon": icon,
            "color": color,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

/// `project list` bypasses the socket and opens SQLite directly —
/// inventory-style read, mirror of `sessions list`. Works even when
/// Galley Core isn't running.
async fn project_list() -> Result<(), GalleyError> {
    let galley = SqliteGalley::open().await?;
    let projects = galley.list_projects().await?;
    for p in projects {
        emit_json(&p)?;
    }
    Ok(())
}

async fn project_delete(
    project_id: String,
    supervisor: Option<String>,
    reason: Option<String>,
) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "project.delete",
        "args": {
            "projectId": project_id,
            "supervisor": supervisor,
            "reason": reason,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

/// `llm list` bypasses the socket and reads the cached `llm_list` pref
/// directly. Sub-plan §1.6 chose this path over a socket round-trip so
/// the command stays sub-50ms regardless of bridge spawn cost.
/// `index` is `u32` — guard against bogus pref values by skipping
/// entries that don't parse cleanly.
async fn llm_list() -> Result<(), GalleyError> {
    let galley = SqliteGalley::open().await?;
    let Some(raw) = galley.get_pref_json("llm_list").await? else {
        return Ok(()); // empty stdout, exit 0 — cache unwarmed
    };
    // Expected shape: `[{"index": <u32>, "name": "<str>"}, ...]`. Other
    // shapes mean a future GUI rev changed the schema — print what's
    // there and let the caller notice.
    let arr = match raw {
        Value::Array(xs) => xs,
        other => {
            return Err(GalleyError::InvalidArgs {
                message: format!(
                    "pref llm_list is not an array: {}",
                    other
                ),
            });
        }
    };
    for entry in arr {
        emit_json(&entry)?;
    }
    Ok(())
}

async fn llm_set(session_id: String, llm_name: String) -> Result<(), GalleyError> {
    let req = serde_json::json!({
        "command": "llm.set",
        "args": {
            "sessionId": session_id,
            "llmName": llm_name,
        },
        "schemaVersion": SCHEMA_VERSION,
    });
    unary_command(req).await
}

/// Map a server-side error discriminant tag onto the CLI's typed
/// error so exit_code_for() picks the right exit code.
fn map_error_tag(tag: &str, msg: String) -> GalleyError {
    match tag {
        "not_found" => GalleyError::NotFound { message: msg },
        "invalid_args" => GalleyError::InvalidArgs { message: msg },
        "db_unavailable" => GalleyError::DbUnavailable { message: msg },
        "runner_error" => GalleyError::RunnerError { message: msg },
        _ => GalleyError::Internal { message: msg },
    }
}
