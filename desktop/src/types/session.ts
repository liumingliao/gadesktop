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
  /** Optional emoji or icon identifier. */
  icon?: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
}
