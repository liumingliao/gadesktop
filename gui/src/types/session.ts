/**
 * Session / Project domain types — desktop-side.
 *
 * Mirrors PRD §8 (Data model). These are entities the desktop owns and
 * persists to SQLite; not to be confused with IPC events in types/ipc.ts
 * which are the wire protocol with the bridge subprocess.
 *
 * Field names follow TS / camelCase convention (matching the SQLite
 * column-to-row mapping done in the persistence layer, not the JSON
 * Lines wire format).
 */

/** Lifecycle states a session can be in. PRD §8.1. */
export type SessionStatus =
  | "idle"
  | "connecting"
  | "running"
  | "waiting_approval"
  | "error"
  | "completed"
  | "cancelled"
  | "archived";

/**
 * Sidebar grouping bucket. Computed from `lastActivityAt` and `pinned`
 * via `bucketSession()` — not stored on the entity.
 */
export type SessionBucket = "pinned" | "today" | "week" | "earlier";

export interface Session {
  id: string;
  projectId?: string;
  title: string;
  status: SessionStatus;

  /** "Turn N · {one-line summary}" — used on the sidebar row. */
  summary?: string;
  turnCount?: number;
  /** Tool name currently running, if status === "running". */
  currentTool?: string;

  pendingApprovalCount: number;
  errorCount: number;
  /**
   * "There is new content the user hasn't seen yet." Set when a
   * turn_end (or `error`) IPC event arrives for a session that is
   * NOT the active session; cleared when the user activates that
   * session via the sidebar. Persisted to SQLite (column
   * `has_unread`) so the inbox-style signal survives app restart.
   * Orthogonal to the runtime status — see DESIGN.md sidebar three-
   * way display (running spinner / idle + dot / idle).
   */
  hasUnread?: boolean;
  /**
   * Transient: GA called `ask_user` and is waiting for the user to reply.
   * Surfaces as the sidebar's fourth state (yellow "⏸ 等你回复"). Mirror
   * of the runtime's `pendingAskUser` — synced via applyRuntimeUpdate
   * so the sidebar can flip without reading runtime state directly.
   * NOT persisted (pending questions are cleared on app restart;
   * the conversation history still shows the question text).
   */
  hasPendingAskUser?: boolean;
  /**
   * GA-side per-message step the agent **most recently finished**
   * (the turnIndex passed in the last `turn_end` event for the
   * current user_message's loop). Surfaced by the Sidebar running
   * subline as "第 N 步 · {summary}" — each tick is a real
   * completed-step recap rather than a still-in-flight guess.
   *
   * The sidebar intentionally lags one step behind the main view:
   * we trade real-time accuracy for paired step-number + summary
   * (which only become consistent at turn_end). Users wanting the
   * truly-current step can click into the conversation, where the
   * thinking placeholder and TurnMarker surface live progress.
   *
   * Written by `bumpSessionAfterTurn` on each turn_end; transient
   * (in-memory only, not persisted — meaningful only while the
   * runtime is alive).
   */
  lastStepIndex?: number;

  /** ISO 8601 timestamps. lastActivityAt drives sidebar bucket. */
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;

  /** Subprocess identity (when bridge is alive for this session). */
  pid?: number;
  cwd?: string;

  pinned?: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** Historical bound cwd. Preserved on the DB row for forward
   * compatibility but no longer injected at bridge spawn time; see
   * devlog 2026-05-14 (rolled back to avoid breaking GA's relative
   * `./memory/...` reads). PRD §7.3 "B. cwd" describes the original
   * intent. */
  rootPath?: string;
  /** Default emoji: 📁. */
  icon?: string;
  color?: string;
  /** Pin to top in sidebar PROJECTS section. PRD §8.2. */
  pinned: boolean;
  /** max(sessions.lastActivityAt where projectId = this.id),
   * fallback to createdAt when project has no session.
   * Drives default sort (pinned desc, lastActivityAt desc). */
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}
