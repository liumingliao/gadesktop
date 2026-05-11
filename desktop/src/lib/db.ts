import Database from "@tauri-apps/plugin-sql";

import type { Project, Session, SessionStatus } from "@/types/session";
import type {
  MessageRow,
  ProjectRow,
  SessionRow,
  ToolEventRow,
} from "@/types/db";
import type { ApprovalDecision } from "@/types/ipc";

/**
 * SQLite client wrapper. Migrations run automatically on first
 * connect via tauri-plugin-sql; we just call `getDB()` and translate
 * rows to domain types.
 *
 * V0.1 #9 ships sessions + projects read/write. Messages,
 * tool_events, approval_rules wiring lands in #10 alongside IPC
 * event handlers (each event maps to an INSERT/UPDATE here).
 */

const DB_URL = "sqlite:workbench.db";

let _db: Database | null = null;
let _loadPromise: Promise<Database> | null = null;

/**
 * Lazy-loaded singleton DB connection. Subsequent calls return the
 * same instance; the in-flight Promise is reused so concurrent
 * callers don't trigger duplicate `Database.load`.
 */
export async function getDB(): Promise<Database> {
  if (_db) return _db;
  if (_loadPromise) return _loadPromise;
  _loadPromise = Database.load(DB_URL).then((db) => {
    _db = db;
    return db;
  });
  return _loadPromise;
}

/**
 * Reset the cached connection (test helper). Real callers should
 * never need this.
 */
export function _resetDBForTest(): void {
  _db = null;
  _loadPromise = null;
}

// ---------------- sessions ----------------

export async function loadSessions(): Promise<Session[]> {
  const db = await getDB();
  const rows = await db.select<SessionRow[]>(
    "SELECT * FROM sessions ORDER BY last_activity_at DESC",
  );
  return rows.map(sessionFromRow);
}

export async function persistSession(s: Session): Promise<void> {
  const db = await getDB();
  await db.execute(
    `INSERT INTO sessions (
       id, project_id, title, status, summary, turn_count, current_tool,
       pending_approval_count, error_count, pid, cwd, pinned,
       llm_index, llm_display_name, last_activity_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17
     )
     ON CONFLICT(id) DO UPDATE SET
       project_id             = excluded.project_id,
       title                  = excluded.title,
       status                 = excluded.status,
       summary                = excluded.summary,
       turn_count             = excluded.turn_count,
       current_tool           = excluded.current_tool,
       pending_approval_count = excluded.pending_approval_count,
       error_count            = excluded.error_count,
       pid                    = excluded.pid,
       cwd                    = excluded.cwd,
       pinned                 = excluded.pinned,
       llm_index              = excluded.llm_index,
       llm_display_name       = excluded.llm_display_name,
       last_activity_at       = excluded.last_activity_at,
       updated_at             = excluded.updated_at`,
    [
      s.id,
      s.projectId ?? null,
      s.title,
      s.status,
      s.summary ?? null,
      s.turnCount ?? 0,
      s.currentTool ?? null,
      s.pendingApprovalCount,
      s.errorCount,
      s.pid ?? null,
      s.cwd ?? null,
      s.pinned ? 1 : 0,
      null, // llm_index — wired in #10
      null, // llm_display_name — wired in #10
      s.lastActivityAt,
      s.createdAt,
      s.updatedAt,
    ],
  );
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDB();
  await db.execute("DELETE FROM sessions WHERE id = $1", [id]);
}

/**
 * Sweep "absolutely empty" sessions on launch — title still at the
 * default "新对话" seed AND no turns have happened yet. These are
 * the residue of opening the app, getting an auto-created session,
 * and closing without ever sending a message. Without cleanup they
 * pile up indefinitely in the sidebar and crowd out real
 * conversations.
 *
 * Sessions with a user-edited title are preserved even at
 * turn_count=0 (the user might be coming back to a planned chat
 * that hasn't started yet). Archived sessions are also preserved
 * — the user chose to keep them visible somewhere.
 *
 * Returns the number of rows deleted, so callers can log it for
 * debugging cleanups that prune more than expected.
 */
export async function deleteEmptyNewSessions(): Promise<number> {
  const db = await getDB();
  // tauri-plugin-sql's execute returns { rowsAffected, lastInsertId }.
  const result = await db.execute(
    `DELETE FROM sessions
     WHERE title = '新对话'
       AND turn_count = 0
       AND status != 'archived'`,
  );
  return result.rowsAffected ?? 0;
}

/**
 * One-time migration: delete the v0.1 demo session fixtures
 * (`stores/demo.ts` DEMO_SESSIONS) from SQLite. Earlier hydrate
 * logic seeded these on first launch as visual placeholders for
 * the empty sidebar. Stage 3 ships real Session Restore +
 * onboarding, so the placeholders are now pure noise. Safe to
 * call repeatedly — `DELETE ... WHERE id IN (...)` is idempotent.
 *
 * Returns rows deleted, primarily for debug logging.
 */
export async function deleteDemoSessions(): Promise<number> {
  const db = await getDB();
  const result = await db.execute(
    `DELETE FROM sessions
     WHERE id IN ('s-today-1','s-today-2','s-today-3',
                  's-week-1','s-week-2','s-earlier-1')`,
  );
  return result.rowsAffected ?? 0;
}

// ---------------- projects ----------------

export async function loadProjects(): Promise<Project[]> {
  const db = await getDB();
  // Sort order matches DESIGN.md §4.2 "F. Project 排序":
  //   pinned desc, last_activity_at desc.
  const rows = await db.select<ProjectRow[]>(
    "SELECT * FROM projects ORDER BY pinned DESC, last_activity_at DESC",
  );
  return rows.map(projectFromRow);
}

export async function persistProject(p: Project): Promise<void> {
  const db = await getDB();
  await db.execute(
    `INSERT INTO projects (
       id, name, root_path, icon, color, pinned, last_activity_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       name             = excluded.name,
       root_path        = excluded.root_path,
       icon             = excluded.icon,
       color            = excluded.color,
       pinned           = excluded.pinned,
       last_activity_at = excluded.last_activity_at,
       updated_at       = excluded.updated_at`,
    [
      p.id,
      p.name,
      p.rootPath ?? null,
      p.icon ?? null,
      p.color ?? null,
      p.pinned ? 1 : 0,
      p.lastActivityAt,
      p.createdAt,
      p.updatedAt,
    ],
  );
}

// ---------------- mappers ----------------

function sessionFromRow(r: SessionRow): Session {
  return {
    id: r.id,
    projectId: r.project_id ?? undefined,
    title: r.title,
    status: r.status as SessionStatus,
    summary: r.summary ?? undefined,
    turnCount: r.turn_count,
    currentTool: r.current_tool ?? undefined,
    pendingApprovalCount: r.pending_approval_count,
    errorCount: r.error_count,
    pid: r.pid ?? undefined,
    cwd: r.cwd ?? undefined,
    pinned: r.pinned === 1,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function projectFromRow(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path ?? undefined,
    icon: r.icon ?? undefined,
    color: r.color ?? undefined,
    pinned: r.pinned === 1,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------- messages ----------------
//
// Stage 3 Task 3 (Session Restore) — `messages` is the source of truth
// for conversation history that survives restart. Two writers:
//
//   - `persistUserMessage` (this file) — called from store
//     `appendUserTurn` the moment the user submits, so a crash before
//     turn_end doesn't lose the question.
//   - `persistTurnEndToMessages` (lib/ipc-handlers.ts) — called on
//     `turn_end`, writes the assistant row with thinking / tool_calls /
//     tool_results / final_answer + GA's raw responseContent (the latter
//     is what the bridge replays on `load_history`).
//
// `turn_index` is GA's 1-based turn counter. Store derives the user
// row's turn_index from `session.turnCount + 1` because the user
// message is submitted *before* GA emits turn_start. GA's turn_end
// later writes the assistant row at the matching turn_index — they
// align because GA always pairs one user message with one turn cycle.
//
// `sequence` is the order *within* a turn: user is always 0, assistant
// always 1. Tool rows would be 2+ but V0.1 collapses them into the
// assistant row's tool_calls / tool_results JSON columns.

export interface PersistUserMessageParams {
  sessionId: string;
  turnIndex: number;
  content: string;
}

export async function persistUserMessage(
  p: PersistUserMessageParams,
): Promise<void> {
  const db = await getDB();
  const id = `msg_${p.sessionId}_${p.turnIndex}_user`;
  const createdAt = new Date().toISOString();
  await db.execute(
    `INSERT INTO messages (
       id, session_id, turn_index, sequence, role, content,
       tool_calls, tool_results, thinking, final_answer, created_at
     ) VALUES ($1, $2, $3, 0, 'user', $4,
               NULL, NULL, NULL, NULL, $5)
     ON CONFLICT(id) DO UPDATE SET
       content    = excluded.content,
       created_at = excluded.created_at`,
    [id, p.sessionId, p.turnIndex, p.content, createdAt],
  );
}

/**
 * Load all messages for a session in conversation order. Returns raw
 * SQLite rows; callers convert to either `Turn[]` (for UI hydration
 * via `restoreSessionTurns`) or `ConversationMessage[]` (for GA
 * `load_history` IPC). The two consumers need slightly different
 * shapes — keep the conversion out of this primitive.
 */
export async function loadMessagesBySession(
  sessionId: string,
): Promise<MessageRow[]> {
  const db = await getDB();
  return db.select<MessageRow[]>(
    `SELECT * FROM messages
     WHERE session_id = $1
     ORDER BY turn_index ASC, sequence ASC`,
    [sessionId],
  );
}

// ---------------- tool_events ----------------
//
// V0.1 scope: persist **approval-related rows only** — one row per
// tool_call_pending event, updated when the user records a decision.
// This delivers the schema's stated core use case ("Approval state
// lives here so we can audit later who approved what" — 001_init.sql
// L82) without requiring an IPC protocol change.
//
// What we explicitly DON'T persist here:
//   - tool_call_start / tool_call_end / tool_call_progress events
//   - Auto-allowed tools (no preceding `pending`)
//   - Completion data for approved tools (success/failed/elapsed_ms)
//
// Rationale: conversation rendering already rebuilds tool state from
// turn_end's toolCalls/toolResults (persisted in `messages` table via
// persistTurnEndToMessages). Full tool-timeline persistence —
// including auto-allowed tools and execution outcomes — is V0.2 work,
// likely paired with the Memory Inspector that surfaces it.
//
// Status semantics for the rows we DO write:
//   - 'waiting_approval' — initial state on pending arrival
//   - 'denied'           — user denied; row is terminal
//   - 'running'          — user approved (allow_once / always_allow_*);
//                          row stays at 'running' since we don't track
//                          completion. Join messages.tool_results by
//                          (session_id, turn_index, tool_name) for the
//                          actual outcome.

export interface PersistToolEventPendingParams {
  approvalId: string;
  sessionId: string;
  turnIndex: number;
  toolName: string;
  args: Record<string, unknown>;
  argsPreview: string;
  riskLevel: "low" | "medium" | "high";
  startedAt: string;
}

/**
 * INSERT a tool_events row on tool_call_pending. Uses approvalId as
 * the primary key — every pending event from the bridge carries a
 * unique approvalId, so re-emitted pending events upsert harmlessly.
 */
export async function persistToolEventPending(
  p: PersistToolEventPendingParams,
): Promise<void> {
  const db = await getDB();
  let argsJson: string | null;
  try {
    argsJson = JSON.stringify(p.args);
  } catch {
    argsJson = null;
  }
  await db.execute(
    `INSERT INTO tool_events (
       id, session_id, turn_index, tool_name, status,
       args_json, args_preview, result_preview,
       risk_level, approval_id, approval_decision,
       elapsed_ms, started_at, ended_at
     ) VALUES (
       $1, $2, $3, $4, 'waiting_approval',
       $5, $6, NULL,
       $7, $1, NULL,
       NULL, $8, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       session_id   = excluded.session_id,
       turn_index   = excluded.turn_index,
       tool_name    = excluded.tool_name,
       args_json    = excluded.args_json,
       args_preview = excluded.args_preview,
       risk_level   = excluded.risk_level,
       started_at   = excluded.started_at`,
    [
      p.approvalId,
      p.sessionId,
      p.turnIndex,
      p.toolName,
      argsJson,
      p.argsPreview,
      p.riskLevel,
      p.startedAt,
    ],
  );
}

/**
 * UPDATE the existing tool_events row when the user records an
 * approval decision. No-op (zero rows affected) if the matching
 * `pending` row was never persisted — caller is best-effort anyway.
 *
 * Sets `ended_at` only for terminal decisions (deny). Approved rows
 * stay open (`ended_at` NULL, status 'running') since we don't track
 * the subsequent tool execution in this table.
 */
export async function persistToolEventApprovalDecision(
  approvalId: string,
  decision: ApprovalDecision,
  decidedAt: string,
): Promise<void> {
  const db = await getDB();
  const denied = decision === "deny";
  await db.execute(
    `UPDATE tool_events
       SET status            = $1,
           approval_decision = $2,
           ended_at          = $3
     WHERE id = $4`,
    [
      denied ? "denied" : "running",
      decision,
      denied ? decidedAt : null,
      approvalId,
    ],
  );
}

/**
 * Load all tool_events rows for a session, ordered by start time.
 * Used by Session restore + Memory Inspector (Stage 3 follow-ups).
 */
export async function loadToolEventsBySession(
  sessionId: string,
): Promise<ToolEventRow[]> {
  const db = await getDB();
  return db.select<ToolEventRow[]>(
    "SELECT * FROM tool_events WHERE session_id = $1 ORDER BY started_at ASC",
    [sessionId],
  );
}

// ---------------- prefs ----------------
//
// Generic key/value preference store backed by the `prefs` table
// (PRD §8 / 001_init.sql). Values are stored as JSON strings so any
// JSON-serialisable type round-trips cleanly. Keys live in the
// caller's namespace — there's no schema for what's allowed.

interface PrefRow {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * Load a typed pref by key. Returns `undefined` when missing or when
 * SQLite isn't available (callers fall back to their default state).
 *
 * Note: `T` is a type assertion — JSON has no type system, so a
 * caller asking for `boolean` on a key that was written as a string
 * gets an unsafe cast. Keep keys consistent with their types.
 */
export async function getPref<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const rows = await db.select<PrefRow[]>(
    "SELECT * FROM prefs WHERE key = $1",
    [key],
  );
  if (rows.length === 0) return undefined;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    // Corrupted JSON — treat as missing. Logging upstream is the
    // store's job; we surface `undefined` to keep this primitive thin.
    return undefined;
  }
}

/**
 * Persist a pref by key. UPSERT on conflict so subsequent writes
 * replace earlier values. `updated_at` is stamped with the current
 * ISO timestamp; column is required by the schema and useful for
 * future sync / debugging.
 */
export async function setPref<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO prefs (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET
       value      = excluded.value,
       updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now],
  );
}
