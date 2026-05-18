-- 001_init.sql · GA Workbench v0.1
-- Schema mirrors PRD §8 (Data model). Persisted via tauri-plugin-sql
-- in the user's app-data directory (sqlite:workbench.db).
--
-- All timestamps stored as ISO 8601 strings (TEXT) — readable in
-- queries, sortable lexicographically, no timezone surprises. Matches
-- the IPC wire format (every IPC event ships an ISO 8601 timestamp).

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  root_path         TEXT,
  icon              TEXT,
  color             TEXT,
  -- PRD §8.2: pin to top in sidebar PROJECTS section.
  pinned            INTEGER NOT NULL DEFAULT 0,
  -- PRD §8.2: max(sessions.last_activity_at) for sessions in this
  -- project; falls back to created_at when project has no session.
  -- Drives default sort (pinned desc, last_activity_at desc) in
  -- DESIGN.md §4.2 Project Section Spec / "F. Project 排序".
  last_activity_at  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE sessions (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title                    TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN
    ('idle','connecting','running','waiting_approval','error',
     'completed','cancelled','archived')),
  summary                  TEXT,
  turn_count               INTEGER NOT NULL DEFAULT 0,
  current_tool             TEXT,
  pending_approval_count   INTEGER NOT NULL DEFAULT 0,
  error_count              INTEGER NOT NULL DEFAULT 0,
  pid                      INTEGER,
  cwd                      TEXT,
  pinned                   INTEGER NOT NULL DEFAULT 0,
  -- Per-session LLM persistence (PRD §17.8): when this session
  -- resumes, ask the bridge to switch to this LLM index. The
  -- displayName is cached for offline rendering of the row.
  llm_index                INTEGER,
  llm_display_name         TEXT,
  last_activity_at         TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX sessions_by_last_activity
  ON sessions(last_activity_at DESC);

CREATE INDEX sessions_by_project
  ON sessions(project_id, last_activity_at DESC);

-- Conversation messages — user / assistant / tool rows ordered by
-- (session_id, turn_index, sequence). `tool_calls` / `tool_results`
-- shapes follow GA's NativeClaudeSession history blocks (Anthropic
-- native messages format) — see bridge/workbench_bridge.py
-- _load_history adapter for the canonical layout.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index    INTEGER NOT NULL,
  sequence      INTEGER NOT NULL,    -- order within turn
  role          TEXT NOT NULL CHECK (role IN
    ('system','user','assistant','tool')),
  content       TEXT NOT NULL,
  tool_calls    TEXT,                -- JSON array (nullable)
  tool_results  TEXT,                -- JSON array (nullable)
  thinking      TEXT,                -- 💭 thinking summary (assistant only)
  final_answer  TEXT,                -- final answer markdown (assistant only)
  created_at    TEXT NOT NULL
);

CREATE INDEX messages_by_session
  ON messages(session_id, turn_index, sequence);

-- Tool events — the Tool Timeline data feed. One row per dispatch.
-- Mirrors PRD §8.3 ToolEvent. Approval state lives here so we can
-- audit later who approved what without joining a separate table.
CREATE TABLE tool_events (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index      INTEGER NOT NULL,
  tool_name       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
    ('pending','running','success','failed',
     'waiting_approval','denied','cancelled')),
  args_json       TEXT,
  args_preview    TEXT,
  result_preview  TEXT,
  risk_level      TEXT CHECK (risk_level IN ('low','medium','high')),
  approval_id     TEXT,
  approval_decision TEXT CHECK (approval_decision IN
    ('allow_once','deny','always_allow_project','always_allow_global',
     'auto_allowed')),
  elapsed_ms      INTEGER,
  started_at      TEXT NOT NULL,
  ended_at        TEXT
);

CREATE INDEX tool_events_by_session
  ON tool_events(session_id, started_at DESC);

CREATE INDEX tool_events_by_approval
  ON tool_events(approval_id) WHERE approval_id IS NOT NULL;

-- Approval rules — durable always-allow lists (per-project + global).
-- Bridge gets the snapshot via SetApprovalRulesCommand at session
-- spawn; on user changes, desktop re-syncs to all live bridges.
CREATE TABLE approval_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL CHECK (scope IN ('project','global')),
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- A given (scope, project_id, tool_name) triple is unique. SQLite
  -- treats NULL as distinct, so the partial-unique index handles the
  -- global-scope case (project_id IS NULL).
  UNIQUE(scope, project_id, tool_name)
);

-- App-level preferences (key-value) for things like
-- "last selected LLM index", attached GA path, bridge python path,
-- approval-required tools list (JSON array), inspector visible flag.
CREATE TABLE prefs (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,        -- JSON
  updated_at  TEXT NOT NULL
);
