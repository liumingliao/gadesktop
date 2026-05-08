import Database from "@tauri-apps/plugin-sql";

import type { Project, Session, SessionStatus } from "@/types/session";
import type { ProjectRow, SessionRow } from "@/types/db";

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

// ---------------- projects ----------------

export async function loadProjects(): Promise<Project[]> {
  const db = await getDB();
  const rows = await db.select<ProjectRow[]>(
    "SELECT * FROM projects ORDER BY name",
  );
  return rows.map(projectFromRow);
}

export async function persistProject(p: Project): Promise<void> {
  const db = await getDB();
  await db.execute(
    `INSERT INTO projects (
       id, name, root_path, icon, color, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       root_path  = excluded.root_path,
       icon       = excluded.icon,
       color      = excluded.color,
       updated_at = excluded.updated_at`,
    [
      p.id,
      p.name,
      p.rootPath ?? null,
      p.icon ?? null,
      p.color ?? null,
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
