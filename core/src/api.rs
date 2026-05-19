//! # Galley Core API surface (single source of truth)
//!
//! All commands the GUI, the CLI, and (B4+) Supervisor agents can issue
//! against Galley Core are defined as [`GalleyApi`] trait methods.
//! Both transports — Tauri's `invoke()` and the future Unix-socket /
//! named-pipe daemon — thin-wrap this trait. See
//! [invariants.md §I5](../../docs/refactor/invariants.md) for the
//! corollary rule.
//!
//! **B1 scope:** read-only methods. Write methods (`send_message`,
//! `create_session`, `archive_session`, …) land in B2 once runner
//! ownership migrates into Rust.

pub mod health;
pub mod message;
pub mod origin;
pub mod project;
pub mod search;
pub mod session;
pub mod status;

pub use health::{HealthCheck, HealthReport, HealthStatus};
pub use message::{MessageBrief, MessageId, MessageRole};
pub use origin::{Origin, OriginVia};
pub use project::{ProjectBrief, ProjectId};
pub use search::{SearchHit, SearchScope};
pub use session::{SessionBrief, SessionFilter, SessionId, SessionStatus};
pub use status::StatusSummary;

use async_trait::async_trait;

use crate::error::Result;

#[async_trait]
pub trait GalleyApi: Send + Sync {
    /// List sessions matching the filter. Default sort: pinned first,
    /// then `lastActivityAt` desc.
    async fn list_sessions(&self, filter: SessionFilter) -> Result<Vec<SessionBrief>>;

    /// Brief projection of one session by id.
    async fn session_brief(&self, id: SessionId) -> Result<SessionBrief>;

    /// Persisted messages for a session, oldest first. `tail` caps the
    /// returned count to the last N — useful for "what's the latest"
    /// quick reads from agents.
    async fn session_messages(
        &self,
        id: SessionId,
        tail: Option<usize>,
    ) -> Result<Vec<MessageBrief>>;

    /// FTS5 search across messages.
    async fn search_messages(
        &self,
        query: String,
        scope: SearchScope,
    ) -> Result<Vec<SearchHit>>;

    /// Aggregate counts useful for status dashboards.
    async fn status(&self) -> Result<StatusSummary>;

    /// Health probe — files exist, deps reachable, etc. B1 ships a
    /// partial set (filesystem-checkable only); Python-dependent probes
    /// land in B4 once the daemon mode exists. Each unimplemented check
    /// surfaces as [`HealthStatus::DeferredB4`].
    async fn health(&self) -> Result<HealthReport>;

    /// Persist a user message into a session. Writes the row to the
    /// `messages` table with the supplied [`Origin`] triple. Does NOT
    /// dispatch to the runner subprocess — the socket transport layer
    /// (or B3 Tauri command layer) wires `send_message` to
    /// [`RunnerManager::send_command`](crate::runner_manager::RunnerManager::send_command)
    /// after a successful persist.
    ///
    /// Returns the persisted [`MessageBrief`] with its server-assigned
    /// id and timestamp.
    async fn send_message(
        &self,
        session_id: SessionId,
        content: String,
        origin: Origin,
    ) -> Result<MessageBrief>;
}
