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
   * GA-side per-message step the agent is currently on, surfaced
   * by `turn_start` IPC. Used by the Sidebar running subline
   * ("正在工作 · 第 N 步") so background sessions communicate
   * progress at a glance. Synced from `_runtimes[id].
   * currentTurnIndex` via `applyRuntimeUpdate`. Cleared (undefined)
   * on settled states; meaningless when `status !== "running"`.
   * Not persisted — purely a transient runtime projection.
   */
  currentStepIndex?: number;

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
  /** Bound cwd; sessions launched in this project use it as their
   * subprocess working dir. PRD §7.3 "B. cwd". */
  rootPath?: string;
  /** Default emoji: 📁 when no cwd, 📂 when cwd is set. */
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
