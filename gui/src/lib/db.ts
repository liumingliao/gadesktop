import Database from "@tauri-apps/plugin-sql";

import type { MessageRow, ToolEventRow } from "@/types/db";
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
//
// All session writes (create / archive / rename / pin / delete +
// bulk variants + project CRUD) moved to sessionsStore in M4b
// (2026-05-19). They invoke the Rust GalleyApi trait methods through
// Tauri commands; the tauri-plugin-sql direct SQL surface that used
// to live here is gone. The mapper helpers + a couple of sweep
// utilities are still in this file because they have no good slice
// home (yet).

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

// Session + project row mappers moved to sessionsStore in M4b
// (sessionFromBrief / projectFromBrief — both translate the Rust
// SessionBrief / ProjectBrief wire shape instead of mapping raw SQLite
// rows now that writes don't touch this file).

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
  // Index for CommandPalette content search. Best-effort: a failure
  // here shouldn't roll back the user message write.
  try {
    await indexMessageFts({
      messageId: id,
      sessionId: p.sessionId,
      role: "user",
      turnIndex: p.turnIndex,
      body: p.content,
    });
  } catch (e) {
    console.debug("[db] persistUserMessage indexMessageFts failed.", e);
  }
}

/**
 * Maintain the messages_fts index for a single message. Called on
 * every persistUserMessage / persistTurnEndToMessages write. We
 * DELETE then INSERT (instead of using ON CONFLICT) because FTS5
 * external-content tables don't enforce uniqueness on UNINDEXED
 * columns; the delete/insert pair is the documented update pattern.
 *
 * Empty `body` is skipped (no point indexing nothing). This means
 * tool-only assistant turns whose `final_answer` is empty don't
 * pollute the index.
 */
export async function indexMessageFts(p: {
  messageId: string;
  sessionId: string;
  role: "user" | "assistant";
  turnIndex: number;
  body: string;
}): Promise<void> {
  if (!p.body || p.body.trim() === "") return;
  const db = await getDB();
  await db.execute("DELETE FROM messages_fts WHERE message_id = $1", [
    p.messageId,
  ]);
  await db.execute(
    `INSERT INTO messages_fts (message_id, session_id, role, turn_index, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [p.messageId, p.sessionId, p.role, p.turnIndex, p.body],
  );
}

/**
 * One-time backfill of messages_fts from existing messages rows.
 * Runs on hydrate when the FTS table is empty but `messages` has
 * content — covers (a) fresh upgrade to the FTS migration, and
 * (b) recovery if the index ever gets out of sync (deleted from
 * SQLite shell, etc.).
 *
 * Idempotent: returns immediately if FTS row count >= eligible
 * message count, so subsequent hydrates skip the scan.
 *
 * Assistant rows index `final_answer` rather than raw `content` —
 * the markdown the user reads, not the response wrapper that
 * contains raw <thinking> blocks (which would inflate the index
 * with text that isn't user-facing).
 */
export async function backfillFtsIfEmpty(): Promise<number> {
  const db = await getDB();
  const [msgCnt] = await db.select<Array<{ cnt: number }>>(
    `SELECT COUNT(*) AS cnt FROM messages
     WHERE role IN ('user','assistant')
       AND COALESCE(NULLIF(TRIM(CASE
         WHEN role = 'user' THEN content
         WHEN role = 'assistant' THEN COALESCE(final_answer, content)
       END), ''), '') != ''`,
  );
  const [ftsCnt] = await db.select<Array<{ cnt: number }>>(
    "SELECT COUNT(*) AS cnt FROM messages_fts",
  );
  if (ftsCnt.cnt >= msgCnt.cnt) return 0;
  await db.execute("DELETE FROM messages_fts");
  const result = await db.execute(
    `INSERT INTO messages_fts (message_id, session_id, role, turn_index, body)
     SELECT
       id,
       session_id,
       role,
       turn_index,
       CASE
         WHEN role = 'user' THEN content
         WHEN role = 'assistant' THEN COALESCE(final_answer, content)
       END AS body
     FROM messages
     WHERE role IN ('user','assistant')
       AND COALESCE(NULLIF(TRIM(CASE
         WHEN role = 'user' THEN content
         WHEN role = 'assistant' THEN COALESCE(final_answer, content)
       END), ''), '') != ''`,
  );
  return result.rowsAffected ?? 0;
}

/**
 * Message hit returned by `searchMessages`. Snippet markers `«` /
 * `»` come from SQLite FTS5's `snippet()` function and wrap the
 * matched substring(s); the renderer splits on these to overlay
 * <mark> tags.
 */
export interface MessageSearchHit {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  role: "user" | "assistant";
  turnIndex: number;
  /** Snippet with `«` / `»` delimiters around match windows. */
  snippet: string;
  /** Session's last activity, used for ordering and rendering. */
  sessionActivityAt: string;
}

/**
 * Full-text search across persisted message bodies. Two paths:
 *
 *   - query.length >= 3 → FTS5 MATCH with trigram tokenizer. Fast
 *     even on tens of thousands of rows; supports CJK + ASCII
 *     uniformly.
 *   - query.length === 2 → LIKE substring fallback. Trigram can't
 *     match 2-char queries, but they're common in Chinese ("审批",
 *     "调研"). LIKE is slower (full table scan) but acceptable for
 *     V1 message volumes.
 *   - query.length < 2 → returns [] (no implicit broad scan).
 *
 * Results JOIN sessions for the title + recency ordering. Hits are
 * deduped at the message level — one message produces one hit even
 * if its body matches multiple times.
 */
/**
 * @deprecated B1 M3 — Rust port available at `galley_core_lib::db::SqliteGalley::search_messages`.
 * Migrate call sites to `invoke("search_messages", {...})` then delete this
 * once no callers remain. Kept alive in parallel per refactor/invariants.md §I1.
 */
export async function searchMessages(
  query: string,
  limit = 20,
): Promise<MessageSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const db = await getDB();

  if (q.length >= 3) {
    // Wrap as an FTS5 phrase. Escape embedded double-quotes by
    // doubling them per SQLite's standard escape rule.
    const escaped = `"${q.replace(/"/g, '""')}"`;
    try {
      const rows = await db.select<RawHitRow[]>(
        `SELECT
           fts.message_id    AS message_id,
           fts.session_id    AS session_id,
           fts.role          AS role,
           fts.turn_index    AS turn_index,
           snippet(messages_fts, 4, '«', '»', '…', 16) AS snippet,
           s.title           AS session_title,
           s.last_activity_at AS session_activity_at
         FROM messages_fts fts
         JOIN sessions s ON s.id = fts.session_id
         WHERE messages_fts MATCH $1
           AND s.status != 'archived'
         ORDER BY s.last_activity_at DESC
         LIMIT $2`,
        [escaped, limit],
      );
      return rows.map(rowToHit);
    } catch (e) {
      // FTS5 MATCH can throw on malformed input (rare with our
      // phrase wrapping but possible with weird unicode). Fall
      // through to LIKE so the search still returns something.
      console.debug("[db] searchMessages FTS5 query failed.", e);
    }
  }

  // 2-char fallback (or FTS error recovery) — LIKE substring.
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db.select<RawHitRow[]>(
    `SELECT
       m.id              AS message_id,
       m.session_id      AS session_id,
       m.role            AS role,
       m.turn_index      AS turn_index,
       substr(
         CASE
           WHEN m.role = 'user' THEN m.content
           WHEN m.role = 'assistant' THEN COALESCE(m.final_answer, m.content)
         END,
         1, 200
       )                 AS snippet,
       s.title           AS session_title,
       s.last_activity_at AS session_activity_at
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE m.role IN ('user','assistant')
       AND s.status != 'archived'
       AND (
         m.content LIKE $1 ESCAPE '\\'
         OR m.final_answer LIKE $1 ESCAPE '\\'
       )
     ORDER BY s.last_activity_at DESC
     LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => rowToHit({ ...r, snippet: highlightLike(r.snippet, q) }));
}

interface RawHitRow {
  message_id: string;
  session_id: string;
  role: string;
  turn_index: number;
  snippet: string;
  session_title: string;
  session_activity_at: string;
}

function rowToHit(r: RawHitRow): MessageSearchHit {
  return {
    messageId: r.message_id,
    sessionId: r.session_id,
    sessionTitle: r.session_title,
    role: r.role === "user" ? "user" : "assistant",
    turnIndex: r.turn_index,
    snippet: r.snippet,
    sessionActivityAt: r.session_activity_at,
  };
}

/**
 * Wrap the first occurrence of `q` in the LIKE-fallback snippet
 * with FTS5-style `«` `»` delimiters so both paths produce
 * uniformly-renderable output. Case-insensitive match.
 */
function highlightLike(snippet: string, q: string): string {
  const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return snippet;
  const before = snippet.slice(0, idx);
  const hit = snippet.slice(idx, idx + q.length);
  const after = snippet.slice(idx + q.length);
  return `${before}«${hit}»${after}`;
}

/**
 * Load all messages for a session in conversation order. Returns raw
 * SQLite rows; callers convert to either `Turn[]` (for UI hydration
 * via `restoreSessionTurns`) or `ConversationMessage[]` (for GA
 * `load_history` IPC). The two consumers need slightly different
 * shapes — keep the conversion out of this primitive.
 */
/**
 * @deprecated B1 M3 — Rust port available at `galley_core_lib::db::SqliteGalley::session_messages`.
 * Migrate call sites to `invoke("session_messages", {...})` then delete this
 * once no callers remain. Kept alive in parallel per refactor/invariants.md §I1.
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
