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
