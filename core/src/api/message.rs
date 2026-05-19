use serde::{Deserialize, Serialize};

use super::origin::Origin;
use super::session::SessionId;

/// Opaque message identifier. The `messages.id` column is `TEXT` —
/// runner / GUI assign string ids like `msg_…`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MessageId(pub String);

/// Role of a message in the conversation history. Mirrors GA's roles
/// plus Galley's "system" pseudo-role for /btw side questions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Agent,
    System,
}

/// Summary of one persisted message. Full conversation rendering needs
/// more fields (tool calls, approvals, etc.); B1's read APIs surface
/// just enough for sidebar peek + agent CLI display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBrief {
    pub id: MessageId,
    pub session_id: SessionId,
    pub role: MessageRole,
    pub content: String,
    /// ISO 8601.
    pub created_at: String,
    /// One-line digest produced by the runner at turn_end; falls back
    /// to the first line of content when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Turn index this message belongs to (the user_message that started
    /// the agent loop). Useful for grouping replies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_index: Option<u32>,
    /// Where this message came from (B2 M5+). Optional on read APIs to
    /// keep backward-compatible JSON shape; always present on
    /// `send_message` responses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
}
