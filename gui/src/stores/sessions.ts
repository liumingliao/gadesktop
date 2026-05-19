import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { useUiStore } from "@/stores/ui";
import { makeAppError } from "@/types/app-error";
import type { Project, Session, SessionStatus } from "@/types/session";

/**
 * B3 M4b · sessionsStore — authoritative session/project list slice.
 *
 * Writes go through the Rust `GalleyApi` trait via Tauri invoke (see
 * `core/src/api.rs`); the front-end keeps an in-memory mirror so the
 * sidebar / TopBar / Composer can render synchronously. The slice
 * intentionally optimistic-updates: mutate in memory immediately, fire
 * invoke fire-and-forget, log on failure. SQLite errors are rare on a
 * trusted local DB; the alternative (round-trip awaits before
 * rendering) introduced visible lag during dogfood for archive/delete.
 *
 * This file does NOT own:
 *   - `_runtimes[sid]` (conversation turns / pending approvals / etc.)
 *     — stays in useAppStore until M5 messagesStore lands.
 *   - bridge lifecycle (status / pid / errors) — runtimeStore (M3b).
 *   - LLM list + per-session selected LLM — runtimeStore (M3a/b);
 *     the *persisted* row column is set via `setSessionLlm` here
 *     which routes through the Rust `set_session_llm` trait method.
 *
 * Cross-store reach: M4b couples to useAppStore for two transitional
 * paths (both marked TRANSITIONAL (M5) inline):
 *   - `applyDerivedFromRuntime` — applyRuntimeUpdate in useAppStore
 *     calls this to mirror status/pendingApprovalCount/hasPendingAskUser
 *     onto the session row. After M5 messagesStore + Rust event
 *     driving these fields, this entry-point goes away.
 *   - `_runtimes[sid]` cleanup on session delete/bulk-delete is done
 *     here by reaching into useAppStore.setState. M5 messagesStore
 *     subscribes to a `session-deleted` signal and cleans itself.
 */

// ---------------- types ----------------

// Mirror of Rust `SessionBrief` (see core/src/api/session.rs) — only
// the durable fields that ship over the Tauri invoke wire. The GUI's
// `Session` type adds runtime-only fields (pid, currentTool,
// pendingApprovalCount, etc.) that this slice initialises to defaults.
interface SessionBriefWire {
  id: string;
  projectId?: string;
  title: string;
  status: SessionStatus;
  summary?: string;
  turnCount?: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  hasUnread?: boolean;
  selectedLlmIndex?: number;
  selectedLlmDisplayName?: string;
}

// Mirror of Rust `ProjectBrief`.
interface ProjectBriefWire {
  id: string;
  name: string;
  rootPath?: string;
  icon?: string;
  color?: string;
  pinned: boolean;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

// Mirror of Rust `Origin`. GUI writes use `via: "gui"`; supervisor /
// system writes (B4) build their own. Created at module top so every
// invoke can share the same instance.
const GUI_ORIGIN = { via: "gui" } as const;

// Mirror of Rust `CreateSessionInput`.
interface CreateSessionInputWire {
  id: string;
  title: string;
  projectId?: string;
  selectedLlmIndex?: number;
  selectedLlmDisplayName?: string;
}

interface CreateProjectInputWire {
  id: string;
  name: string;
  rootPath?: string;
  icon?: string;
  color?: string;
}

// ---------------- helpers (private) ----------------

/**
 * Title length cap for the derived title path (`maybeDeriveTitle` —
 * called from useAppStore.appendUserTurn). Chinese chars eat one cell
 * each; ~30 fills the Sidebar row's truncate window without wrapping.
 */
const TITLE_DERIVE_MAX = 30;

function deriveTitleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_DERIVE_MAX) return oneLine;
  return oneLine.slice(0, TITLE_DERIVE_MAX) + "…";
}

/** "新对话" — seed title set by `createSession`. */
export const DEFAULT_NEW_SESSION_TITLE = "新对话";

/** Project icon default (PRD §8.2 / DESIGN.md project section). */
const DEFAULT_PROJECT_ICON = "📁";

function sessionFromBrief(b: SessionBriefWire): Session {
  return {
    id: b.id,
    projectId: b.projectId,
    title: b.title,
    status: b.status,
    summary: b.summary,
    turnCount: b.turnCount ?? 0,
    pendingApprovalCount: 0,
    errorCount: 0,
    currentTool: undefined,
    pid: undefined,
    cwd: undefined,
    pinned: b.pinned ?? false,
    hasUnread: b.hasUnread ?? false,
    lastActivityAt: b.lastActivityAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    selectedLlmIndex: b.selectedLlmIndex,
    selectedLlmDisplayName: b.selectedLlmDisplayName,
  };
}

function projectFromBrief(b: ProjectBriefWire): Project {
  return {
    id: b.id,
    name: b.name,
    rootPath: b.rootPath,
    icon: b.icon,
    color: b.color,
    pinned: b.pinned,
    lastActivityAt: b.lastActivityAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

/**
 * Update one session in `sessions` by id. Falls through to the
 * original array if the id isn't found — caller decides whether that
 * is a bug to surface or a silently-tolerable race.
 */
function patchSessionInList(
  sessions: Session[],
  sid: string,
  patch: Partial<Session> | ((s: Session) => Session),
): { sessions: Session[]; changed: boolean } {
  const idx = sessions.findIndex((s) => s.id === sid);
  if (idx === -1) return { sessions, changed: false };
  const next = sessions.slice();
  const old = sessions[idx];
  next[idx] = typeof patch === "function" ? patch(old) : { ...old, ...patch };
  return { sessions: next, changed: true };
}

/**
 * Cross-store cleanup: drop a session's `_runtimes[sid]` entry from
 * useAppStore. Used by delete + bulk delete. TRANSITIONAL (M5
 * messagesStore): once `_runtimes` moves out of useAppStore, the
 * sessionsStore will emit a `session-deleted` signal and messagesStore
 * subscribes — no cross-store setState needed.
 */
async function clearSessionRuntime(sid: string): Promise<void> {
  // Dynamic import to avoid a hard circular dependency at module
  // evaluation. useAppStore imports sessionsStore (during M4b
  // transition); without the dynamic boundary, evaluation order
  // depends on whoever Vite encounters first.
  const { useAppStore } = await import("@/stores/useAppStore");
  useAppStore.setState((state) => {
    if (!state._runtimes[sid]) return {};
    const _runtimes = { ...state._runtimes };
    delete _runtimes[sid];
    return { _runtimes };
  });
}

// ---------------- mock fixture (dev only) ----------------
//
// Kept inside sessionsStore (mapping § B "保留 — dev/contrib 起步").
// Used by `seedMockSessions` action and exposed via Settings dev
// command. Persistence is via createSession invoke — Rust assigns
// no special id, the mock id (`mock-<batch>-<i>`) is caller-supplied.

const MOCK_TITLES_TODAY = [
  "重构 IPC 协议的 dataclass 验证",
  "调研 Tauri v2 plugin-shell sidecar",
  "整理本周设计评审纪要",
];
const MOCK_TITLES_WEEK = [
  "修复 turn_end summary 偶尔丢失",
  "shadcn Command 组件样式对齐",
  "Sidebar 状态机的三态可视化",
  "Bridge LRU 5 alive 行为验证",
];
const MOCK_TITLES_EARLIER = [
  "Tauri vs Electron 调研结论",
  "DESIGN.md v0.2 token 表定稿",
  "SQLite FTS5 中文分词调研",
  "PRD §11 审批模型补完",
  "Stage 2 desktop skeleton 完成总结",
  "Onboarding fs.exists health check",
  "TopBar drag region 与 traffic light 冲突",
  "ApprovalDock 二段确认的交互草稿",
  "Composer auto-grow 行高计算",
  "Sidebar bucket grouping 时区边界 bug",
  "GA agent._turn_end_hooks 兼容测试",
  "Inspector 面板的 tool event 时序",
  "Settings → Approval tab 信息架构",
  "Error Card 四种 hint 变体定稿",
  "macOS DMG 公证流程笔记",
];
const MOCK_TITLES_PINNED = [
  "GA 0.4 升级 baseline 评估",
  "V0.2 路线图（Pin / Project / Search）",
];

const MOCK_SUMMARIES = [
  "GA 同意按方案 B 推进",
  "拆成 4 个独立 PR",
  "结论是先做 trigram 兜底",
  "等用户回 spec 后再继续",
  "已落 commit 9c3aa1f",
  "切到下一个 session 处理",
  "需要补一个 e2e case",
  "讨论后决定先不做",
];

const MOCK_STATUSES: Array<Session["status"]> = [
  "idle",
  "idle",
  "idle",
  "idle",
  "completed",
  "completed",
  "error",
];

let mockBatchCounter = 0;

function buildMockSessions(): Session[] {
  const batchId = ++mockBatchCounter;
  const now = Date.now();
  const day = 86_400_000;
  let titleCursor = 0;
  let summaryCursor = 0;
  let statusCursor = 0;
  let idCursor = 0;
  const make = (
    titlePool: string[],
    activityAtMs: number,
    overrides: Partial<Session> = {},
  ): Session => {
    const title = titlePool[titleCursor++ % titlePool.length]!;
    const summary = MOCK_SUMMARIES[summaryCursor++ % MOCK_SUMMARIES.length];
    const status =
      overrides.status ??
      MOCK_STATUSES[statusCursor++ % MOCK_STATUSES.length]!;
    const iso = new Date(activityAtMs).toISOString();
    const id = `mock-${batchId}-${++idCursor}`;
    return {
      id,
      title,
      status,
      summary,
      turnCount: 2 + ((idCursor * 7) % 12),
      pendingApprovalCount: status === "waiting_approval" ? 1 : 0,
      errorCount: status === "error" ? 1 : 0,
      lastActivityAt: iso,
      createdAt: iso,
      updatedAt: iso,
      ...overrides,
    };
  };

  const out: Session[] = [];
  MOCK_TITLES_PINNED.forEach((_, i) =>
    out.push(
      make(MOCK_TITLES_PINNED, now - (5 + i * 3) * day, {
        pinned: true,
        status: "idle",
      }),
    ),
  );
  out.push(make(MOCK_TITLES_TODAY, now - 30 * 60_000, { status: "running" }));
  out.push(
    make(MOCK_TITLES_TODAY, now - 2 * 3_600_000, {
      status: "waiting_approval",
    }),
  );
  out.push(make(MOCK_TITLES_TODAY, now - 5 * 3_600_000, { status: "idle" }));
  [1, 2, 4, 6].forEach((d) =>
    out.push(make(MOCK_TITLES_WEEK, now - d * day - 2 * 3_600_000)),
  );
  const earlierDayOffsets = [
    8, 11, 14, 19, 24, 32, 45, 58, 73, 95, 130, 180, 240, 330, 420,
  ];
  earlierDayOffsets.forEach((d) =>
    out.push(make(MOCK_TITLES_EARLIER, now - d * day)),
  );
  return out;
}

// ---------------- store shape ----------------

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | undefined;
  projects: Project[];
  activeProjectFilter: string | undefined;
}

interface SessionsActions {
  // ---- session list mutations ----
  setActiveSession: (id: string | undefined) => void;
  /** Synchronous create — returns the new id for chaining. Rust write
   * happens fire-and-forget; in-memory state updates immediately. */
  createSession: (projectId?: string) => string;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
  renameSession: (sessionId: string, newTitle: string) => void;
  togglePinSession: (sessionId: string) => void;
  deleteSessionPermanently: (sessionId: string) => Promise<void>;
  archiveSessionsBulk: (sessionIds: string[]) => void;
  unarchiveSessionsBulk: (sessionIds: string[]) => void;
  deleteSessionsPermanentlyBulk: (sessionIds: string[]) => Promise<void>;
  emptyArchive: () => Promise<number>;
  /** Server-side bump on turn_end. Optimistic in-memory update +
   * fire-and-forget invoke. Mark unread when target isn't active. */
  bumpSessionAfterTurn: (
    sessionId: string,
    summary?: string,
    stepNumber?: number,
  ) => void;
  /** Update the persisted per-session LLM choice. Called from
   * runtimeStore.replaceLLMs whenever a bridge picks a current LLM. */
  setSessionLlm: (
    sessionId: string,
    index: number,
    displayName: string,
  ) => Promise<void>;

  // ---- projects ----
  createProject: (input: { name: string; rootPath?: string }) => Promise<Project>;
  updateProject: (
    id: string,
    partial: Partial<Pick<Project, "name" | "rootPath" | "pinned">>,
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  assignSessionToProject: (
    sessionId: string,
    projectId: string | null,
  ) => Promise<void>;
  setActiveProjectFilter: (projectId: string | undefined) => void;

  // ---- runtime-driven mirroring (cross-store entry point) ----
  /**
   * Used by useAppStore.applyRuntimeUpdate to sync sidebar-visible
   * fields derived from runtime state. TRANSITIONAL (M5): after the
   * messagesStore lands and runtime → session sync moves to Rust
   * event emit, this entry point goes away.
   *
   * No-op when the patch matches the current row.
   */
  applyDerivedFromRuntime: (
    sessionId: string,
    patch: Partial<Pick<Session, "status" | "pendingApprovalCount" | "hasPendingAskUser">>,
  ) => void;
  /**
   * Used by useAppStore.appendUserTurn / appendUserTurnExternal on the
   * first user message in a fresh session: if the title is still the
   * seed placeholder, auto-derive from the message text. Server write
   * is fire-and-forget.
   *
   * No-op when the title has already been edited or the text trims to
   * empty. Returns the new title for the caller to log / scroll-snap.
   */
  maybeDeriveTitle: (sessionId: string, text: string) => string | null;
  /**
   * Used by IPC turn_end handler to refresh `lastStepIndex` on the
   * session row. In-memory only — transient field, not persisted (see
   * Session.lastStepIndex doc).
   */
  setLastStepIndex: (sessionId: string, step: number) => void;

  // ---- hydrate / dev ----
  /** Load sessions + projects from Rust core. Called by
   * useAppStore.hydrateFromDB. Mutates state directly; errors are
   * logged but don't throw — start-empty is a recoverable cold path. */
  hydrate: () => Promise<void>;
  seedMockSessions: () => Promise<void>;
}

export type SessionsStore = SessionsState & SessionsActions;

// ---------------- store ----------------

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  activeSessionId: undefined,
  projects: [],
  activeProjectFilter: undefined,

  // ---- session list mutations ----

  setActiveSession: (id) => {
    let toClear: string | null = null;
    set((state) => {
      if (!id) return { activeSessionId: undefined };
      const idx = state.sessions.findIndex((s) => s.id === id);
      if (idx === -1) return { activeSessionId: id };
      const row = state.sessions[idx];
      if (row.hasUnread) {
        const sessions = state.sessions.slice();
        sessions[idx] = { ...row, hasUnread: false };
        toClear = id;
        return { activeSessionId: id, sessions };
      }
      return { activeSessionId: id };
    });
    if (toClear) {
      void invoke("clear_session_unread", { id: toClear }).catch((e) => {
        console.debug("[sessions] clear_session_unread failed.", e);
      });
    }
  },

  createSession: (projectId) => {
    const id = `s-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const now = new Date().toISOString();
    const newSession: Session = {
      id,
      title: DEFAULT_NEW_SESSION_TITLE,
      status: "idle",
      projectId,
      pendingApprovalCount: 0,
      errorCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      sessions: [newSession, ...state.sessions],
      activeSessionId: id,
    }));
    void invoke("create_session", {
      input: {
        id,
        title: DEFAULT_NEW_SESSION_TITLE,
        projectId,
      } as CreateSessionInputWire,
      origin: GUI_ORIGIN,
    }).catch((e) => {
      console.debug("[sessions] create_session invoke failed.", e);
    });
    return id;
  },

  archiveSession: (sessionId) => {
    const now = new Date().toISOString();
    let archivedTitle: string | null = null;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          archivedTitle = s.title;
          return { ...s, status: "archived", updatedAt: now };
        },
      );
      if (!changed) return {};
      const out: Partial<SessionsState> = { sessions };
      if (state.activeSessionId === sessionId) {
        out.activeSessionId = undefined;
      }
      return out;
    });
    if (archivedTitle === null) return;
    void invoke("archive_session", { id: sessionId, origin: GUI_ORIGIN }).catch(
      (e) => console.debug("[sessions] archive_session invoke failed.", e),
    );
    // UX feedback: archiving makes the row vanish from the sidebar —
    // a short info toast confirms the action.
    useUiStore.getState().pushToast(
      makeAppError({
        category: "business",
        severity: "info",
        title: "已 Archive",
        message: archivedTitle,
        hint: null,
        retryable: false,
        context: "archiveSession",
        traceback: null,
      }),
    );
  },

  unarchiveSession: (sessionId) => {
    const now = new Date().toISOString();
    let changedAny = false;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          if (s.status !== "archived") return s;
          changedAny = true;
          return { ...s, status: "idle", updatedAt: now };
        },
      );
      return changed ? { sessions } : {};
    });
    if (!changedAny) return;
    void invoke("unarchive_session", { id: sessionId, origin: GUI_ORIGIN }).catch(
      (e) => console.debug("[sessions] unarchive_session invoke failed.", e),
    );
  },

  renameSession: (sessionId, newTitle) => {
    const cleaned = newTitle.trim();
    const finalTitle = cleaned === "" ? DEFAULT_NEW_SESSION_TITLE : cleaned;
    const now = new Date().toISOString();
    let changedAny = false;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          if (s.title === finalTitle) return s;
          changedAny = true;
          return { ...s, title: finalTitle, updatedAt: now };
        },
      );
      return changed ? { sessions } : {};
    });
    if (!changedAny) return;
    void invoke("rename_session", {
      id: sessionId,
      title: finalTitle,
      origin: GUI_ORIGIN,
    }).catch((e) => console.debug("[sessions] rename_session invoke failed.", e));
  },

  togglePinSession: (sessionId) => {
    const now = new Date().toISOString();
    let nextPinned: boolean | null = null;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          if (s.status === "archived") return s;
          nextPinned = !s.pinned;
          return { ...s, pinned: nextPinned, updatedAt: now };
        },
      );
      return changed ? { sessions } : {};
    });
    if (nextPinned === null) return;
    void invoke("set_session_pinned", {
      id: sessionId,
      pinned: nextPinned,
      origin: GUI_ORIGIN,
    }).catch((e) =>
      console.debug("[sessions] set_session_pinned invoke failed.", e),
    );
  },

  deleteSessionPermanently: async (sessionId) => {
    // Defensive: shut down any live bridge before yanking the row.
    // Archived sessions shouldn't have one (LRU 5 typically reaps),
    // but covering the edge so we don't leak a process pointing at
    // a deleted id.
    try {
      const { useRuntimeStore } = await import("@/stores/runtime");
      await useRuntimeStore.getState().shutdownBridge(sessionId);
    } catch (e) {
      console.warn(
        "[sessions] deleteSessionPermanently shutdownBridge failed.",
        e,
      );
    }
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const out: Partial<SessionsState> = { sessions };
      if (state.activeSessionId === sessionId) {
        out.activeSessionId = undefined;
      }
      return out;
    });
    await clearSessionRuntime(sessionId);
    try {
      await invoke("delete_session", { id: sessionId, origin: GUI_ORIGIN });
    } catch (e) {
      console.warn("[sessions] delete_session invoke failed.", e);
    }
  },

  archiveSessionsBulk: (sessionIds) => {
    if (sessionIds.length === 0) return;
    const now = new Date().toISOString();
    const idSet = new Set(sessionIds);
    let archivedCount = 0;
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (!idSet.has(s.id) || s.status === "archived") return s;
        archivedCount++;
        return { ...s, status: "archived" as SessionStatus, updatedAt: now };
      });
      const out: Partial<SessionsState> = { sessions };
      if (state.activeSessionId && idSet.has(state.activeSessionId)) {
        out.activeSessionId = undefined;
      }
      return out;
    });
    if (archivedCount === 0) return;
    void invoke("bulk_archive_sessions", {
      ids: sessionIds,
      origin: GUI_ORIGIN,
    }).catch((e) =>
      console.debug("[sessions] bulk_archive_sessions invoke failed.", e),
    );
    useUiStore.getState().pushToast(
      makeAppError({
        category: "business",
        severity: "info",
        title: `已归档 ${archivedCount} 个对话`,
        message: "",
        hint: null,
        retryable: false,
        context: "archiveSessionsBulk",
        traceback: null,
      }),
    );
  },

  unarchiveSessionsBulk: (sessionIds) => {
    if (sessionIds.length === 0) return;
    const now = new Date().toISOString();
    const idSet = new Set(sessionIds);
    let unarchivedCount = 0;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (!idSet.has(s.id) || s.status !== "archived") return s;
        unarchivedCount++;
        return { ...s, status: "idle" as SessionStatus, updatedAt: now };
      }),
    }));
    if (unarchivedCount === 0) return;
    void invoke("bulk_unarchive_sessions", {
      ids: sessionIds,
      origin: GUI_ORIGIN,
    }).catch((e) =>
      console.debug("[sessions] bulk_unarchive_sessions invoke failed.", e),
    );
  },

  deleteSessionsPermanentlyBulk: async (sessionIds) => {
    if (sessionIds.length === 0) return;
    // Sequential bridge teardown — racing N parallel shutdowns
    // against the same process tree caused flakiness in M3b dogfood.
    const { useRuntimeStore } = await import("@/stores/runtime");
    for (const id of sessionIds) {
      try {
        await useRuntimeStore.getState().shutdownBridge(id);
      } catch (e) {
        console.warn(
          `[sessions] deleteSessionsPermanentlyBulk shutdownBridge failed for ${id}.`,
          e,
        );
      }
    }
    const idSet = new Set(sessionIds);
    set((state) => {
      const sessions = state.sessions.filter((s) => !idSet.has(s.id));
      const out: Partial<SessionsState> = { sessions };
      if (state.activeSessionId && idSet.has(state.activeSessionId)) {
        out.activeSessionId = undefined;
      }
      return out;
    });
    await Promise.all(sessionIds.map((id) => clearSessionRuntime(id)));
    try {
      await invoke("bulk_delete_sessions", {
        ids: sessionIds,
        origin: GUI_ORIGIN,
      });
    } catch (e) {
      console.warn(
        "[sessions] bulk_delete_sessions invoke failed.",
        e,
      );
    }
  },

  emptyArchive: async () => {
    const archived = get().sessions.filter((s) => s.status === "archived");
    if (archived.length === 0) return 0;
    await get().deleteSessionsPermanentlyBulk(archived.map((s) => s.id));
    return archived.length;
  },

  bumpSessionAfterTurn: (sessionId, summary, stepNumber) => {
    const now = new Date().toISOString();
    const becameUnread = sessionId !== get().activeSessionId;
    let didUpdate = false;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          const turnCount = (s.turnCount ?? 0) + 1;
          // Truncate to keep the sidebar single-line. Mirrors the
          // Rust-side `truncate_summary` (80 + "…") used by the
          // invoke counterpart; both must agree or the in-memory and
          // persisted values diverge.
          const nextSummary =
            summary && summary.trim()
              ? truncateSummary(summary)
              : s.summary;
          return {
            ...s,
            turnCount,
            summary: nextSummary,
            lastStepIndex:
              typeof stepNumber === "number" && stepNumber > 0
                ? stepNumber
                : s.lastStepIndex,
            lastActivityAt: now,
            updatedAt: now,
            hasUnread: becameUnread ? true : s.hasUnread,
          };
        },
      );
      if (!changed) return {};
      didUpdate = true;
      return { sessions };
    });
    if (!didUpdate) return;
    void invoke("bump_session_after_turn", {
      id: sessionId,
      summary: summary ?? null,
      stepNumber: stepNumber ?? null,
      markUnread: becameUnread,
    }).catch((e) =>
      console.debug("[sessions] bump_session_after_turn invoke failed.", e),
    );
  },

  setSessionLlm: async (sessionId, index, displayName) => {
    let didUpdate = false;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          if (
            s.selectedLlmIndex === index &&
            s.selectedLlmDisplayName === displayName
          ) {
            return s;
          }
          didUpdate = true;
          return {
            ...s,
            selectedLlmIndex: index,
            selectedLlmDisplayName: displayName,
          };
        },
      );
      return changed ? { sessions } : {};
    });
    if (!didUpdate) return;
    try {
      await invoke("set_session_llm", {
        id: sessionId,
        index,
        displayName,
      });
    } catch (e) {
      console.debug("[sessions] set_session_llm invoke failed.", e);
    }
  },

  // ---- projects ----

  createProject: async ({ name, rootPath }) => {
    const id = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const next: Project = {
      id,
      name: name.trim(),
      rootPath: rootPath?.trim() || undefined,
      pinned: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
      icon: DEFAULT_PROJECT_ICON,
    };
    set((state) => ({ projects: [next, ...state.projects] }));
    try {
      await invoke("create_project", {
        input: {
          id,
          name: next.name,
          rootPath: next.rootPath,
          icon: next.icon,
        } as CreateProjectInputWire,
        origin: GUI_ORIGIN,
      });
    } catch (e) {
      console.debug("[sessions] create_project invoke failed.", e);
    }
    return next;
  },

  updateProject: async (id, partial) => {
    const now = new Date().toISOString();
    let updated: Project | null = null;
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== id) return p;
        updated = {
          ...p,
          ...partial,
          rootPath:
            partial.rootPath !== undefined
              ? partial.rootPath?.trim() || undefined
              : p.rootPath,
          name: partial.name !== undefined ? partial.name.trim() : p.name,
          updatedAt: now,
        };
        return updated;
      }),
    }));
    if (!updated) return;
    try {
      // Translate front-end Partial<Project> into Rust ProjectPatch:
      //   - name: Option<String>           (single Option — empty rejected server-side)
      //   - root_path: Option<Option<String>>
      //   - pinned: Option<bool>
      //
      // Double-Option pattern lets `Some(null)` clear root_path vs
      // `null` (not set, leave alone). The GUI's `partial.rootPath`
      // signal is binary (string or undefined) — we map undefined → omitted,
      // empty/whitespace → Some(null), non-empty → Some(value).
      const patch: Record<string, unknown> = {};
      if (partial.name !== undefined) patch.name = partial.name.trim();
      if (Object.prototype.hasOwnProperty.call(partial, "rootPath")) {
        const trimmed = partial.rootPath?.trim();
        patch.rootPath = trimmed ? trimmed : null;
      }
      if (partial.pinned !== undefined) patch.pinned = partial.pinned;
      await invoke("update_project", {
        id,
        patch,
        origin: GUI_ORIGIN,
      });
    } catch (e) {
      console.debug("[sessions] update_project invoke failed.", e);
    }
  },

  deleteProject: async (id) => {
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      // FK SET NULL on sessions.project_id; mirror in memory.
      sessions: state.sessions.map((s) =>
        s.projectId === id ? { ...s, projectId: undefined } : s,
      ),
      activeProjectFilter:
        state.activeProjectFilter === id
          ? undefined
          : state.activeProjectFilter,
    }));
    try {
      await invoke("delete_project", { id, origin: GUI_ORIGIN });
    } catch (e) {
      console.debug("[sessions] delete_project invoke failed.", e);
    }
  },

  assignSessionToProject: async (sessionId, projectId) => {
    const now = new Date().toISOString();
    let didUpdate = false;
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          didUpdate = true;
          return { ...s, projectId: projectId ?? undefined, updatedAt: now };
        },
      );
      return changed ? { sessions } : {};
    });
    if (!didUpdate) return;
    try {
      await invoke("assign_session_to_project", {
        sessionId,
        projectId,
        origin: GUI_ORIGIN,
      });
    } catch (e) {
      console.debug("[sessions] assign_session_to_project invoke failed.", e);
    }
  },

  setActiveProjectFilter: (projectId) =>
    set({ activeProjectFilter: projectId }),

  // ---- runtime-driven mirroring ----

  applyDerivedFromRuntime: (sessionId, patch) => {
    set((state) => {
      const idx = state.sessions.findIndex((s) => s.id === sessionId);
      if (idx === -1) return {};
      const s = state.sessions[idx];
      const newStatus = patch.status ?? s.status;
      const newCount = patch.pendingApprovalCount ?? s.pendingApprovalCount;
      const newAsk = patch.hasPendingAskUser ?? s.hasPendingAskUser ?? false;
      if (
        s.status === newStatus &&
        s.pendingApprovalCount === newCount &&
        (s.hasPendingAskUser ?? false) === newAsk
      ) {
        return {};
      }
      const sessions = state.sessions.slice();
      sessions[idx] = {
        ...s,
        status: newStatus,
        pendingApprovalCount: newCount,
        hasPendingAskUser: newAsk,
      };
      return { sessions };
    });
  },

  maybeDeriveTitle: (sessionId, text) => {
    let derived: string | null = null;
    set((state) => {
      const idx = state.sessions.findIndex((s) => s.id === sessionId);
      if (idx === -1) return {};
      const s = state.sessions[idx];
      if (s.title !== DEFAULT_NEW_SESSION_TITLE || !text.trim()) return {};
      const newTitle = deriveTitleFromText(text);
      const sessions = state.sessions.slice();
      sessions[idx] = { ...s, title: newTitle };
      derived = newTitle;
      return { sessions };
    });
    if (derived) {
      const out = derived as string;
      void invoke("rename_session", {
        id: sessionId,
        title: out,
        origin: GUI_ORIGIN,
      }).catch((e) =>
        console.debug("[sessions] maybeDeriveTitle invoke failed.", e),
      );
    }
    return derived;
  },

  setLastStepIndex: (sessionId, step) => {
    set((state) => {
      const { sessions, changed } = patchSessionInList(
        state.sessions,
        sessionId,
        (s) => {
          if (s.lastStepIndex === step) return s;
          return { ...s, lastStepIndex: step };
        },
      );
      return changed ? { sessions } : {};
    });
  },

  // ---- hydrate / dev ----

  hydrate: async () => {
    try {
      const briefs = await invoke<SessionBriefWire[]>("list_sessions", {
        filter: {},
      });
      set({ sessions: briefs.map(sessionFromBrief) });
    } catch (e) {
      console.warn("[sessions] hydrate sessions failed.", e);
    }
    try {
      const projects = await invoke<ProjectBriefWire[]>("list_projects");
      set({ projects: projects.map(projectFromBrief) });
    } catch (e) {
      console.debug("[sessions] hydrate projects failed.", e);
    }
  },

  seedMockSessions: async () => {
    const batch = buildMockSessions();
    set((state) => ({ sessions: [...batch, ...state.sessions] }));
    for (const s of batch) {
      try {
        await invoke("create_session", {
          input: {
            id: s.id,
            title: s.title,
            projectId: s.projectId,
          } as CreateSessionInputWire,
          origin: GUI_ORIGIN,
        });
      } catch (e) {
        console.debug("[sessions] seedMockSessions invoke failed.", e);
      }
    }
    console.info(`[sessions] seedMockSessions: inserted ${batch.length} rows.`);
  },
}));

/**
 * Mirror of summary truncation Rust does in `truncate_summary`
 * (core/src/db.rs SUMMARY_TRUNCATE_LEN = 80). Front-end keeps a
 * matching helper so optimistic in-memory state matches the value
 * Rust will persist — otherwise the freshly-rendered sidebar row
 * would diverge from the post-restart row by one char and surface
 * as a visual jitter when DB writes succeed slightly after the
 * in-memory mutation.
 *
 * NOTE: the GUI's prior local cap was 60; the Rust side picked 80
 * (more breathing room for a one-line preview). We adopt 80 here to
 * stay in sync with the persisted value.
 */
const SUMMARY_TRUNCATE_MAX = 80;
function truncateSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SUMMARY_TRUNCATE_MAX) return oneLine;
  return oneLine.slice(0, SUMMARY_TRUNCATE_MAX) + "…";
}
