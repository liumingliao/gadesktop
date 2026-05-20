use serde::{Deserialize, Serialize};

/// Errors surfaced from the Galley Core API. Mapped 1-1 to the CLI exit
/// code categories per playbook T4.11 / agent-api.md (B1 M5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "error", content = "detail", rename_all = "snake_case")]
pub enum GalleyError {
    /// Resource not found (session id / message id / project id missing).
    /// CLI exit code 3.
    NotFound { message: String },
    /// Argument validation failure. CLI exit code 2.
    InvalidArgs { message: String },
    /// Database / backend unavailable. CLI exit code 4.
    DbUnavailable { message: String },
    /// Runner subprocess unreachable / IPC dispatch failed after persist
    /// succeeded (e.g. `session btw` with no live bridge, or `llm set`
    /// emit failed mid-flight). CLI exit code 5 (B4 M1; PRD §11.2 #3).
    RunnerError { message: String },
    /// Catch-all for unexpected internal failures. CLI exit code 1.
    Internal { message: String },
}

impl std::fmt::Display for GalleyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GalleyError::NotFound { message } => write!(f, "not_found: {message}"),
            GalleyError::InvalidArgs { message } => write!(f, "invalid_args: {message}"),
            GalleyError::DbUnavailable { message } => write!(f, "db_unavailable: {message}"),
            GalleyError::RunnerError { message } => write!(f, "runner_error: {message}"),
            GalleyError::Internal { message } => write!(f, "internal: {message}"),
        }
    }
}

impl std::error::Error for GalleyError {}

/// Convenience alias used by the trait + db module.
pub type Result<T> = std::result::Result<T, GalleyError>;
