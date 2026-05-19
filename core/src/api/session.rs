use serde::{Deserialize, Serialize};

/// Opaque session identifier. Persisted shape is a short string like
/// `sess_abc123…`; treat as opaque on the agent side.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Session lifecycle states. Wire-compatible with the existing TS
/// `SessionStatus` union — snake_case on the JSON side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Connecting,
    Running,
    WaitingApproval,
    Error,
    Completed,
    Cancelled,
    Archived,
}

/// Summary projection of a session — the fields a sidebar row needs.
/// "Brief" means: enough to list / display, not enough to render the
/// full conversation. For history, see [`super::MessageBrief`] plus
/// [`crate::api::GalleyApi::session_messages`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrief {
    pub id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub title: String,
    pub status: SessionStatus,
    /// "Turn N · {one-line summary}" — used on the sidebar row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<u32>,
    /// ISO 8601. Drives sidebar bucket (today/week/earlier).
    pub last_activity_at: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    /// New activity arrived while this session wasn't the active one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_unread: Option<bool>,
    /// Last LLM the user picked for this session (`agent.set_llm` index).
    /// Restored at bridge respawn so the user's choice survives app
    /// restart instead of reverting to the GA default in mykey.py.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_llm_index: Option<u32>,
    /// Display name of the persisted LLM. Cached alongside the index so
    /// the sidebar can label the pill before the bridge ready event
    /// re-confirms with the live `availableLLMs` list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_llm_display_name: Option<String>,
}

/// Filter / scope for `list_sessions`. All fields optional — None means
/// "no constraint on this dimension".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    pub project_id: Option<String>,
    pub status: Option<SessionStatus>,
    /// When None, archived sessions are excluded (matches GUI sidebar
    /// default). Set Some(true) to fetch only archived, Some(false) to
    /// force-exclude.
    pub archived: Option<bool>,
}
