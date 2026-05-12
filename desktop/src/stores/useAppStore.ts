import { create } from "zustand";

import type { ApprovalConfig } from "@/components/screens/settings/Settings";
import {
  type BridgeClient,
  type BridgeSpawnArgs,
  spawnBridge as spawnBridgeProcess,
} from "@/lib/bridge";
import {
  deleteDemoSessions,
  deleteEmptyNewSessions,
  getPref,
  loadMessagesBySession,
  loadSessions,
  persistSession,
  persistToolEventApprovalDecision,
  persistUserMessage,
  setPref,
} from "@/lib/db";
import { dispatchIPCEvent } from "@/lib/ipc-handlers";
import { deriveSessionStatus } from "@/lib/sessions";
import {
  DEMO_APPROVAL_CONFIG,
  DEMO_APPROVAL_RECORDS,
  DEMO_GA_CONFIG,
  DEMO_LLM_DISPLAY_NAME,
  DEMO_LLMS,
  DEMO_RUNTIME_INFO,
  DEMO_SESSIONS,
} from "@/stores/demo";
import { type AppError, makeAppError } from "@/types/app-error";
import type {
  AgentTurn,
  ConversationToolEvent,
  PendingApproval,
  Turn,
  UserTurn,
} from "@/types/conversation";
import type { MessageRow } from "@/types/db";
import type { ApprovalRecord, RuntimeInfo } from "@/types/inspector";
import type { ApprovalDecision, IPCCommand } from "@/types/ipc";
import type { Session } from "@/types/session";

/**
 * Multi-session bridge subprocess map (V0.1 #10b N-active model).
 *
 * Each entry is one live GA bridge process keyed by sessionId.
 * Bridge clients aren't serializable (hold function refs to write/
 * kill), so they live outside the Zustand state. Per-session
 * `bridgeStatus` / `bridgeError` / `bridgePid` inside `_runtimes`
 * are the source of truth for "is this session's bridge alive";
 * this map is just the IO handle store.
 *
 * Background-session continuity is the core v0.1 promise: switching
 * the active session does NOT kill other sessions' bridges. App
 * shutdown calls `shutdownAllBridges` to clean up.
 */
const _bridgeClients = new Map<string, BridgeClient>();

export function getBridgeClient(sessionId: string): BridgeClient | null {
  return _bridgeClients.get(sessionId) ?? null;
}

/**
 * LRU resource governor for multi-session bridges (Stage 3 Task 2.5).
 *
 * Power users open dozens of sessions in a day. Keeping every session's
 * GA subprocess alive forever is a resource bomb (~150MB RSS + an LLM
 * client per process). 1-active was rejected (background tasks must
 * keep running — see 2026-05-11 devlog). The middle ground: cap the
 * concurrent alive count, suspend the least-recently-used to make
 * room. Re-activating a suspended session re-spawns + replays
 * `load_history` from SQLite, which Stage 3 Task 3 just made viable.
 *
 * `_lruOrder` holds session ids of every alive bridge with the most-
 * recently-activated at the END (push to end on touch). Suspending
 * pulls from the FRONT.
 *
 * Cap is 5 alive bridges — wide enough that the working set
 * ("today's active sessions") stays hot, tight enough that opening
 * a 20th session doesn't grind the machine. User-facing: silent in
 * the happy path; the suspended bridge's session row stays in the
 * sidebar so the user can re-click to bring it back.
 */
const _lruOrder: string[] = [];
const LRU_CAP = 5;

/** Mark `sessionId` as most-recently-used. Idempotent + safe to call
 * before `_bridgeClients.set` (touch tracks intent, not actual liveness). */
function _lruTouch(sessionId: string): void {
  const idx = _lruOrder.indexOf(sessionId);
  if (idx !== -1) _lruOrder.splice(idx, 1);
  _lruOrder.push(sessionId);
}

/** Remove `sessionId` from the LRU. Called when a bridge actually
 * shuts down (planned suspend OR external crash via onClose). */
function _lruRemove(sessionId: string): void {
  const idx = _lruOrder.indexOf(sessionId);
  if (idx !== -1) _lruOrder.splice(idx, 1);
}

/**
 * Shut down the oldest non-active, non-running bridges until the LRU
 * is at or under cap. Awaited so the caller can sequence subsequent
 * work after suspended processes are actually gone. Errors are caught
 * per-victim — one failing shutdown shouldn't block the rest.
 *
 * Two classes of session are PROTECTED from eviction:
 *   1. The active session — suspending the one the user is looking
 *      at would be the worst possible UX.
 *   2. Sessions with `agentRunning === true` — N-active's core
 *      promise is "background long tasks keep running". Killing a
 *      mid-turn bridge loses the in-flight LLM call + tool dispatch;
 *      the conversation is left in an indeterminate state (no
 *      turn_end will arrive). Better to temporarily exceed the cap
 *      by 1-2 alive bridges than break that promise — once a
 *      protected session finishes, the next spawn will trim it on
 *      the way out.
 *
 * If every alive bridge falls into one of these categories, the
 * function returns without shutting anything down. The cap will
 * self-correct on the next spawn after one of them completes.
 */
async function _enforceLRUCap(): Promise<void> {
  while (_lruOrder.length > LRU_CAP) {
    const state = useAppStore.getState();
    const activeId = state.activeSessionId;
    // Re-evaluate protections every iteration: a previous shutdown
    // might have changed _runtimes / activeSessionId.
    const victim = _lruOrder.find(
      (id) => id !== activeId && !state._runtimes[id]?.agentRunning,
    );
    if (!victim) {
      // Everyone left is either active or mid-turn. Bail and let the
      // next spawn trigger try again after agents have finished.
      console.info(
        `[lru] no eviction candidate (cap=${LRU_CAP}, alive=${_lruOrder.length}); all alive bridges are active or running`,
      );
      return;
    }
    try {
      await useAppStore.getState().shutdownBridge(victim);
    } catch (e) {
      console.warn(`[lru] suspend ${victim} failed.`, e);
      // shutdownBridge calls _lruRemove on success only — for failed
      // shutdowns we still pull from the LRU so the loop can progress;
      // the leaked bridge will at least disappear on app exit's
      // shutdownAllBridges.
      _lruRemove(victim);
    }
  }
}

export type Screen = "onboarding" | "empty" | "main";

export interface LLMOption {
  index: number;
  displayName: string;
  isCurrent: boolean;
}

export type BridgeStatus =
  | "idle"
  | "spawning"
  | "connected"
  | "closed"
  | "error";

/**
 * All per-session runtime fields. The store maintains one entry per
 * session in `_runtimes`; the top-level projection fields below
 * mirror `_runtimes[activeSessionId]` so existing component read
 * paths (`s.turns`, `s.pendingApprovals`, ...) keep working without
 * changes. Writes go through `applyRuntimeUpdate`, which updates
 * both the internal map and the projection when the targeted
 * session is active.
 */
export interface SessionRuntime {
  turns: Turn[];
  pendingApprovals: PendingApproval[];
  agentRunning: boolean;
  currentTurnIndex: number | null;
  userSubmitTick: number;
  inFlightContent: string;
  approvalDecisions: Record<string, ApprovalDecision>;
  bridgeStatus: BridgeStatus;
  bridgeError: string | null;
  bridgePid: number | null;
  /**
   * LLM list + currently-selected LLM **for this session's bridge**.
   * N-active multi-session means each bridge has its own currently-
   * selected LLM (the user can `set_llm` per-session). The top-level
   * `llms` / `llmDisplayName` are the projection of the active
   * session's pair, so switching sessions reflects the right LLM in
   * Composer / Command Palette / Inspector.
   *
   * Seeded with the demo list so the empty-state Composer can render
   * a believable LLM name pre-bridge; gets overwritten the moment the
   * bridge sends `ready`.
   */
  llms: LLMOption[];
  llmDisplayName: string;
}

/**
 * Title length cap for the derived title path (`appendUserTurn` first
 * call). Chinese chars eat one cell each; ~30 fills the Sidebar
 * row's truncate window without wrapping. Beyond this we append "…"
 * to signal truncation.
 */
const TITLE_DERIVE_MAX = 30;

/** Same idea, for the Sidebar second-line "第 N 步 · {summary}". */
const SUMMARY_TRUNCATE_MAX = 60;

function deriveTitleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_DERIVE_MAX) return oneLine;
  return oneLine.slice(0, TITLE_DERIVE_MAX) + "…";
}

function truncateSummary(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SUMMARY_TRUNCATE_MAX) return oneLine;
  return oneLine.slice(0, SUMMARY_TRUNCATE_MAX) + "…";
}

/** "新对话" is the seed title set by `createSession`. We only auto-
 * derive a title when the row is still wearing the default placeholder
 * — once the user (or restoration) renames the session we leave it
 * alone. */
const DEFAULT_NEW_SESSION_TITLE = "新对话";

/**
 * Convert SQLite `messages` rows back into UI `Turn[]`. Walks rows in
 * (turn_index, sequence) order — user rows (sequence=0) become
 * UserTurn; assistant rows (sequence=1) become AgentTurn with
 * tool_calls / tool_results JSON re-hydrated into
 * ConversationToolEvent[].
 *
 * `system` and `tool` rows are skipped — V0.1 collapses tools into the
 * assistant row's JSON columns; future Memory Inspector work can
 * surface them.
 *
 * Tools restored from history are always marked `success-historical`:
 * by the time a turn is persisted, every dispatched tool has
 * completed (turn_end is the canonical "finished" signal). The
 * conversation view fades them appropriately.
 */
function rowsToTurns(rows: MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      turns.push({ role: "user", content: row.content } as UserTurn);
    } else if (row.role === "assistant") {
      const toolCalls = safeParseJsonArray(row.tool_calls);
      const toolResults = safeParseJsonArray(row.tool_results);
      const tools: ConversationToolEvent[] = toolCalls.map((tc, i) => {
        const result = toolResults[i];
        const resultPreview = previewFromContent(result?.content);
        const id =
          (typeof result?.toolUseId === "string" && result.toolUseId) ||
          (typeof tc.toolUseId === "string" && tc.toolUseId) ||
          `t-${row.turn_index}-${i}`;
        return {
          id,
          name: typeof tc.toolName === "string" ? tc.toolName : "(unknown)",
          status: "success-historical",
          args: (tc.args as Record<string, unknown>) ?? {},
          resultPreview,
        };
      });
      const turn: AgentTurn = {
        role: "agent",
        thinking: row.thinking ?? undefined,
        tools,
        finalAnswer: row.final_answer ?? null,
        turnIndex: row.turn_index,
      };
      turns.push(turn);
    }
    // system / tool rows: skipped at v0.1.
  }
  return turns;
}

/** Defensive JSON.parse — returns `[]` on malformed / null / non-array. */
function safeParseJsonArray(raw: string | null): Record<string, unknown>[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** Mirror of ipc-handlers' resultPreview logic — keep ≤500 char preview. */
function previewFromContent(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return content.slice(0, 500);
  try {
    return JSON.stringify(content).slice(0, 500);
  } catch {
    return String(content).slice(0, 500);
  }
}

function emptyRuntime(): SessionRuntime {
  return {
    turns: [],
    pendingApprovals: [],
    agentRunning: false,
    currentTurnIndex: null,
    userSubmitTick: 0,
    inFlightContent: "",
    approvalDecisions: {},
    bridgeStatus: "idle",
    bridgeError: null,
    bridgePid: null,
    llms: DEMO_LLMS,
    llmDisplayName: DEMO_LLM_DISPLAY_NAME,
  };
}

interface State {
  // ---- UI ----
  screen: Screen;
  paletteOpen: boolean;
  settingsOpen: boolean;
  inspectorVisible: boolean;

  // ---- Sessions ----
  sessions: Session[];
  activeSessionId: string | undefined;
  /**
   * Projection of `_runtimes[activeSessionId].llms` — see SessionRuntime
   * for the rationale (LLM list is per-bridge in N-active).
   */
  llms: LLMOption[];
  /**
   * Projection of `_runtimes[activeSessionId].llmDisplayName`. Mirrors
   * Composer / Inspector display.
   */
  llmDisplayName: string;
  runtimeInfo: RuntimeInfo;

  // ---- Approval (global) ----
  /**
   * GA subprocess spawn config. `python` + `gaPath` are user-editable
   * via Settings → Runtime path pickers (Stage 3 Task 4); `bridgeCwd`
   * is internal (workbench repo root in dev / app bundle resources
   * dir in production — set by the macOS bundle Task).
   *
   * Falls back to DEMO_GA_CONFIG on first launch before the user has
   * opened Settings. Persists to prefs key `ga_config` (JSON).
   */
  gaConfig: {
    python: string;
    gaPath: string;
    bridgeCwd: string;
  };

  approvalConfig: ApprovalConfig;
  approvalRecords: ApprovalRecord[];
  /**
   * YOLO mode (PRD §11.5). When true, every tool dispatch on every
   * alive bridge bypasses the approval gate. Persisted to prefs
   * (sticky across launches). Global, not per-session — flipping
   * this notifies every alive bridge.
   */
  yoloMode: boolean;

  // ---- Errors (global) ----
  toasts: AppError[];

  // ---- Per-session runtimes (internal, keyed by sessionId) ----
  /**
   * Internal map of per-session runtime state. Components should
   * normally read the top-level projection fields below (mirror of
   * the active session). Read `_runtimes` directly only when you
   * need state from sessions other than the active one — e.g.
   * Sidebar rendering pending-approval badges across all sessions.
   */
  _runtimes: Record<string, SessionRuntime>;

  // ---- Projection of _runtimes[activeSessionId] ----
  // These fields exist for read-path back-compat with the V0.1 #10a
  // single-session layer. Writers must keep them synced via
  // `applyRuntimeUpdate`. Components that only care about the
  // active session can keep reading these as before.
  //
  // `llms` / `llmDisplayName` are declared above (in the Sessions
  // group) — same field, just grouped with related session state.
  turns: Turn[];
  pendingApprovals: PendingApproval[];
  agentRunning: boolean;
  /**
   * GA-side turn number currently running (1-based) for the active
   * session. See SessionRuntime for the same field's semantics.
   */
  currentTurnIndex: number | null;
  /**
   * Monotonic counter incremented every time the user submits a
   * message on the active session (via `appendUserTurn`). MainView's
   * scroll effect uses this as a trigger to snap the just-submitted
   * user message to the viewport top.
   */
  userSubmitTick: number;
  inFlightContent: string;
  approvalDecisions: Record<string, ApprovalDecision>;
  bridgeStatus: BridgeStatus;
  bridgeError: string | null;
  bridgePid: number | null;
}

interface Actions {
  // UI
  setScreen: (s: Screen) => void;
  setPaletteOpen: (o: boolean) => void;
  togglePalette: () => void;
  setSettingsOpen: (o: boolean) => void;
  toggleSettings: () => void;
  setInspectorVisible: (v: boolean) => void;
  toggleInspector: () => void;

  // Sessions
  setActiveSession: (id: string | undefined) => void;
  /**
   * Create a new session row (persisted best-effort), make it the
   * active session, and seed an empty runtime. Returns the new id
   * so the caller can chain `activateSession(id)` to spawn its
   * bridge. Pushes a soft-limit warning toast once `sessions.length`
   * exceeds 10 — the architecture supports more, but the UX scales
   * poorly past that and the LLM-API budget grows linearly.
   */
  createSession: () => string;
  /**
   * Make `id` the active session and ensure its bridge is alive.
   * Idempotent — if a connected bridge already exists for `id`,
   * this is just a session switch. Re-spawns on `idle` / `closed` /
   * `error` so a crashed session recovers when the user re-clicks
   * its sidebar row.
   */
  activateSession: (id: string) => Promise<void>;
  /**
   * Bump a session's turn_count + last_activity_at on turn_end and
   * persist back to SQLite. Called from the IPC layer when a turn
   * completes so Sidebar bucketing (today / week / earlier) and the
   * "第 N 步" badge reflect activity without a full reload.
   *
   * Status is set to "idle" — turn_end is the canonical "agent
   * finished this round" signal; subsequent runs flip status back
   * to "running" via setBridgeStatus + agentRunning.
   *
   * `summary` (optional) is GA's per-turn summary from turn_end. When
   * present, written into `session.summary` as `第 N 步 · {summary}`
   * for the Sidebar two-line preview. Truncated to keep the line
   * single-row.
   */
  bumpSessionAfterTurn: (sessionId: string, summary?: string) => void;
  /**
   * Archive a session: flip its status to "archived" and persist.
   * Archived sessions are hidden from the Sidebar's bucketed list
   * (V0.1 simplification — no separate Archive view yet; the row
   * stays in SQLite so a future Settings → Archive page can surface
   * it). If the archived session has a live bridge, we keep it
   * alive — the user might be archiving the row visually but still
   * have an in-flight turn they want to read. Re-activation later
   * un-archives via `unarchiveSession`.
   *
   * If the archived session was active, we clear activeSessionId so
   * the main view falls back to its empty / placeholder state.
   */
  archiveSession: (sessionId: string) => void;
  /** Reverse archiveSession: status back to "idle" + persist. */
  unarchiveSession: (sessionId: string) => void;
  /**
   * Restore a session's `turns` from SQLite — Stage 3 Task 3 Session
   * Restore. Called by `activateSession` when the runtime is fresh
   * (no in-memory turns yet) and the session has prior turn history
   * on disk. Idempotent: safe to call when there are no rows.
   *
   * Only writes to `_runtimes[sessionId].turns`; does NOT touch GA
   * `backend.history`. The bridge-side history injection happens in
   * the IPC `ready` handler, which reads the same messages table and
   * sends `load_history` — keeping the two halves decoupled so a
   * bridge crash + respawn re-injects history without needing to
   * touch the UI state.
   */
  restoreSessionTurns: (sessionId: string) => Promise<void>;

  // Approval (global)
  setApprovalRequiredTools: (tools: string[]) => void;
  removeAlwaysAllow: (scope: "project" | "global", tool: string) => void;
  /**
   * Set the YOLO mode flag. Persists to prefs and broadcasts the new
   * state to **every** alive bridge over IPC. The Settings UI is
   * responsible for showing the activation confirm modal (DESIGN.md
   * §9 Approval tab) before calling this with `true`; the store
   * does not gate it.
   */
  setYoloMode: (enabled: boolean) => Promise<void>;
  /**
   * Update the GA spawn config and persist to prefs. `partial` lets
   * callers pick one field at a time (Settings has separate pickers
   * for python vs gaPath). Also writes through to runtimeInfo so the
   * Inspector / Settings → Runtime tab reflect the new path
   * immediately. Existing alive bridges keep their old config — DESIGN
   * §9 commits to "restart Workbench to apply" rather than killing
   * in-flight sessions silently; we push a toast to remind the user.
   */
  setGAConfig: (
    partial: Partial<{ python: string; gaPath: string; bridgeCwd: string }>,
  ) => Promise<void>;

  // Errors
  pushToast: (e: AppError) => void;
  dismissToast: (id: string) => void;

  /**
   * Replace this session's LLM list (and currently-selected
   * displayName, derived from `llms.find(l => l.isCurrent)`). Called
   * by ipc-handlers on `ready` (initial list) and `llm_changed`
   * (after a successful `set_llm`). Per-session because each bridge
   * has its own currently-selected LLM in N-active.
   */
  replaceLLMs: (sessionId: string, llms: LLMOption[]) => void;

  // Conversation (per-session — sessionId required)
  appendUserTurn: (sessionId: string, text: string) => void;
  appendAgentTurn: (sessionId: string, turn: AgentTurn) => void;
  addPendingApproval: (sessionId: string, p: PendingApproval) => void;
  removePendingApproval: (sessionId: string, approvalId: string) => void;
  recordApprovalDecision: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => void;
  clearConversation: (sessionId: string) => void;
  setAgentRunning: (sessionId: string, running: boolean) => void;
  setCurrentTurnIndex: (sessionId: string, idx: number | null) => void;
  appendInFlightDelta: (sessionId: string, delta: string) => void;
  clearInFlightContent: (sessionId: string) => void;

  // Bridge runtime (per-session — sessionId required)
  setBridgeStatus: (sessionId: string, status: BridgeStatus) => void;
  /**
   * Spawn a GA bridge subprocess for `args.sessionId`. If that
   * session already has an alive bridge, this shuts it down first
   * (one process per sessionId). Other sessions' bridges are
   * untouched — that's the multi-session core promise.
   */
  spawnBridge: (args: BridgeSpawnArgs) => Promise<void>;
  shutdownBridge: (sessionId: string) => Promise<void>;
  /** Shutdown every alive bridge. Used on app exit. */
  shutdownAllBridges: () => Promise<void>;
  sendIPCCommand: (sessionId: string, cmd: IPCCommand) => Promise<void>;

  // Persistence
  hydrateFromDB: () => Promise<void>;
}

export type AppStore = State & Actions;

/**
 * Helper: apply an updater to a single session's runtime, refresh
 * the top-level projection when that session is active, and sync
 * the sidebar-visible fields (status, pendingApprovalCount) onto
 * the corresponding row in `sessions`. Returns a partial state to
 * pass to Zustand's `set`.
 *
 * **Why sync `sessions` inline instead of deriving in the UI**: a
 * useShallow / useMemo selector in App.tsx hit React 19's
 * `useSyncExternalStore` getSnapshot stability check (the inline
 * arrow selector + new array result every call triggered a
 * "getSnapshot should be cached" warning + Maximum update depth
 * loop). The fix is to make `state.sessions` itself the source of
 * truth: only generate a new `sessions` array when sidebar-visible
 * fields actually change, so a plain `useAppStore(s => s.sessions)`
 * with default strict-equality stays stable across frequent
 * non-sidebar updates like turn_progress streaming.
 *
 * Lazily initializes the runtime entry if missing — the IPC layer
 * may emit events (turn_start, turn_progress, tool_call_pending)
 * for a session that the store hasn't seen yet.
 */
function applyRuntimeUpdate(
  state: State,
  sessionId: string,
  updater: (rt: SessionRuntime) => SessionRuntime,
): Partial<State> {
  const oldRt = state._runtimes[sessionId] ?? emptyRuntime();
  const newRt = updater(oldRt);
  const out: Partial<State> = {
    _runtimes: { ...state._runtimes, [sessionId]: newRt },
  };
  if (sessionId === state.activeSessionId) {
    Object.assign(out, projectionFrom(newRt));
  }
  // Sync sidebar-visible fields onto the session row, but only if
  // they actually changed — otherwise `sessions` reference stays
  // identical and subscribers don't re-render.
  const sessionIndex = state.sessions.findIndex((s) => s.id === sessionId);
  if (sessionIndex !== -1) {
    const session = state.sessions[sessionIndex];
    const newStatus = deriveSessionStatus(session, newRt);
    const newCount = newRt.pendingApprovals.length;
    if (
      session.status !== newStatus ||
      session.pendingApprovalCount !== newCount
    ) {
      const sessions = state.sessions.slice();
      sessions[sessionIndex] = {
        ...session,
        status: newStatus,
        pendingApprovalCount: newCount,
      };
      out.sessions = sessions;
    }
  }
  return out;
}

/**
 * Pure mapping from a SessionRuntime to the State projection fields.
 * Used by setActiveSession + applyRuntimeUpdate to keep the top-level
 * fields in sync with `_runtimes[activeSessionId]`.
 */
function projectionFrom(rt: SessionRuntime): {
  turns: Turn[];
  pendingApprovals: PendingApproval[];
  agentRunning: boolean;
  currentTurnIndex: number | null;
  userSubmitTick: number;
  inFlightContent: string;
  approvalDecisions: Record<string, ApprovalDecision>;
  bridgeStatus: BridgeStatus;
  bridgeError: string | null;
  bridgePid: number | null;
  llms: LLMOption[];
  llmDisplayName: string;
} {
  return {
    turns: rt.turns,
    pendingApprovals: rt.pendingApprovals,
    agentRunning: rt.agentRunning,
    currentTurnIndex: rt.currentTurnIndex,
    userSubmitTick: rt.userSubmitTick,
    inFlightContent: rt.inFlightContent,
    approvalDecisions: rt.approvalDecisions,
    bridgeStatus: rt.bridgeStatus,
    bridgeError: rt.bridgeError,
    bridgePid: rt.bridgePid,
    llms: rt.llms,
    llmDisplayName: rt.llmDisplayName,
  };
}

/**
 * Single Zustand store. We intentionally keep one store rather than
 * splitting per domain — the surface stays small enough at V0.1
 * that a slice-pattern would be ceremony without payoff.
 *
 * #10b wires bridge IPC events into these actions via
 * `event.sessionId` routing (every wire event carries sessionId):
 *   - turn_end          → appendAgentTurn(sessionId, ...)
 *   - turn_start        → setCurrentTurnIndex(sessionId, ...)
 *   - turn_progress     → appendInFlightDelta(sessionId, ...)
 *   - tool_call_pending → addPendingApproval(sessionId, ...)
 *   - error             → pushToast (global) + setAgentRunning(sessionId, false)
 *   - run_complete      → setAgentRunning(sessionId, false)
 *   - llm_changed       → replaceLLMs (global — LLM list is shared)
 *   - ready             → replaceLLMs + setBridgeStatus(sessionId, "connected")
 *
 * The initial state is seeded with demo fixtures so the dev build
 * has something to render before bridge is connected.
 */
export const useAppStore = create<AppStore>((set, get) => ({
  // ---- Initial state (demo fixtures) ----
  screen: "empty",
  paletteOpen: false,
  settingsOpen: false,
  inspectorVisible: true,

  sessions: DEMO_SESSIONS,
  activeSessionId: undefined,
  // llms / llmDisplayName are populated by the trailing
  // `...projectionFrom(emptyRuntime())` spread below — emptyRuntime
  // seeds DEMO_LLMS / DEMO_LLM_DISPLAY_NAME so Composer renders a
  // plausible LLM pre-bridge.
  runtimeInfo: DEMO_RUNTIME_INFO,

  gaConfig: DEMO_GA_CONFIG,

  approvalConfig: DEMO_APPROVAL_CONFIG,
  approvalRecords: DEMO_APPROVAL_RECORDS,
  yoloMode: false,

  toasts: [],

  _runtimes: {},

  // Top-level projection starts as the empty runtime (no active
  // session yet). setActiveSession refreshes these.
  ...projectionFrom(emptyRuntime()),

  // ---- UI actions ----
  setScreen: (s) => set({ screen: s }),
  setPaletteOpen: (o) => set({ paletteOpen: o }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  setSettingsOpen: (o) => set({ settingsOpen: o }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  setInspectorVisible: (v) => set({ inspectorVisible: v }),
  toggleInspector: () => set({ inspectorVisible: !get().inspectorVisible }),

  // ---- Sessions actions ----
  setActiveSession: (id) => {
    // Clearing unread on activation is the inbox metaphor — opening
    // a session counts as reading it. Persist the cleared row so
    // the read state survives restart. Done outside the set callback
    // because it's a side-effect (SQLite write) we want to fire only
    // when the targeted row actually has unread=true, not on every
    // setActiveSession call.
    let toPersist: Session | null = null;
    set((state) => {
      if (!id) {
        return {
          activeSessionId: undefined,
          ...projectionFrom(emptyRuntime()),
        };
      }
      // Lazy-init the runtime so subsequent setters can operate on
      // the initialized entry rather than fall through to emptyRuntime.
      const existing = state._runtimes[id];
      const rt = existing ?? emptyRuntime();
      const _runtimes = existing
        ? state._runtimes
        : { ...state._runtimes, [id]: rt };
      // Clear has_unread on the activated session.
      const sessionIndex = state.sessions.findIndex((s) => s.id === id);
      let sessions = state.sessions;
      if (sessionIndex !== -1) {
        const s = state.sessions[sessionIndex];
        if (s.hasUnread) {
          const cleared = { ...s, hasUnread: false };
          sessions = state.sessions.slice();
          sessions[sessionIndex] = cleared;
          toPersist = cleared;
        }
      }
      return {
        activeSessionId: id,
        _runtimes,
        sessions,
        ...projectionFrom(rt),
      };
    });
    if (toPersist) {
      void persistSession(toPersist).catch((e) => {
        console.debug("[store] setActiveSession persistSession failed.", e);
      });
    }
  },

  createSession: () => {
    const id = `s-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const now = new Date().toISOString();
    const newSession: Session = {
      id,
      title: DEFAULT_NEW_SESSION_TITLE,
      status: "idle",
      pendingApprovalCount: 0,
      errorCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      const rt = emptyRuntime();
      return {
        sessions: [newSession, ...state.sessions],
        activeSessionId: id,
        _runtimes: { ...state._runtimes, [id]: rt },
        ...projectionFrom(rt),
      };
    });
    // Best-effort persist. SQLite may not be available (Vite dev /
    // first launch before tauri-plugin-sql finishes init); the in-
    // memory session list still drives UI for this app instance.
    void persistSession(newSession).catch((e) => {
      console.debug("[store] createSession persistSession failed.", e);
    });
    // Soft limit warning. The store doesn't block — power users can
    // dismiss the toast and keep going. Counts only NON-archived
    // rows: archived sessions are already "cleaned up" from the
    // sidebar (App.tsx filters them out of visibleSessions), so the
    // user shouldn't be nagged about needing to archive sessions
    // they've already archived. Previously this counted
    // `sessions.length` and produced "48 sessions" alarms when the
    // user had archived 40 of them — a real-world bug surfaced in
    // dev verify round 8.
    const liveNow = get().sessions.filter(
      (s) => s.status !== "archived",
    ).length;
    if (liveNow > 10) {
      get().pushToast(
        makeAppError({
          category: "business",
          severity: "warning",
          title: "Session 数量较多",
          message: `已开 ${liveNow} 个 session — 建议先 archive 几个旧的，否则后台 bridge 进程会越来越占资源。`,
          hint: null,
          retryable: false,
          context: "createSession",
          traceback: null,
        }),
      );
    }
    return id;
  },

  bumpSessionAfterTurn: (sessionId, summary) => {
    const now = new Date().toISOString();
    // Inbox-style unread: a finished turn in a non-active session
    // is new content the user hasn't seen. The active session
    // stays read — the user is on it and presumably reading.
    // Sidebar reflects this with a brand dot + bold title via
    // SidebarSessionRow.
    const becameUnread = sessionId !== get().activeSessionId;
    let updated: Session | null = null;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const turnCount = (s.turnCount ?? 0) + 1;
        // Compose sidebar two-liner: "Turn N · {one-line summary}".
        // We strip newlines + clamp length so it fits the row's
        // truncate ellipsis without wrapping. When the bridge didn't
        // emit a summary we keep the previous one rather than wipe
        // it — staleness beats blanking the row on every turn.
        // Sidebar二行预览：用「第 N 步」跟 TurnMarker 一致，避免
        // 跟用户对话「轮次」混淆。N 是 GA 内核 turn_index（单条
        // user message 可能触发多个 step），不是 session 中第几条
        // user 发言。
        const nextSummary =
          summary && summary.trim()
            ? `第 ${turnCount} 步 · ${truncateSummary(summary)}`
            : s.summary;
        updated = {
          ...s,
          turnCount,
          summary: nextSummary,
          lastActivityAt: now,
          updatedAt: now,
          status: "idle",
          hasUnread: becameUnread ? true : s.hasUnread,
        };
        return updated;
      }),
    }));
    // Best-effort write-back to SQLite. Vite-only dev / first launch
    // are non-fatal; the in-memory bump still drives sidebar rendering
    // for the current app instance.
    if (updated) {
      void persistSession(updated).catch((e) => {
        console.debug("[store] bumpSessionAfterTurn persistSession failed.", e);
      });
    }
  },

  activateSession: async (id) => {
    // setActiveSession lazy-inits the runtime and refreshes the
    // top-level projection from _runtimes[id].
    get().setActiveSession(id);
    // Restore conversation turns from SQLite when this is the first
    // time we're touching this session in the current app instance.
    // `_runtimes[id].turns.length === 0` is a safe proxy for "fresh
    // runtime" because once IPC starts streaming, even an empty
    // SQLite history won't keep turns at zero. We skip restoration
    // for sessions that already have in-memory turns to avoid
    // duplicating rows across multiple activations.
    const rt = get()._runtimes[id];
    const session = get().sessions.find((s) => s.id === id);
    const looksFresh = !rt || rt.turns.length === 0;
    const hasHistory = (session?.turnCount ?? 0) > 0;
    if (looksFresh && hasHistory) {
      try {
        await get().restoreSessionTurns(id);
      } catch (e) {
        console.warn("[store] activateSession restoreSessionTurns failed.", e);
      }
    }
    // Auto-spawn the bridge when this session has no live one.
    // Re-spawn on `closed` / `error` lets a kill or crash recover
    // by simply re-clicking the session. `closed` is also how the
    // LRU governor signals "suspended" — re-activation regenerates
    // the bridge and the IPC `ready` handler replays SQLite history.
    const rtAfter = get()._runtimes[id];
    const needsSpawn =
      !rtAfter ||
      rtAfter.bridgeStatus === "idle" ||
      rtAfter.bridgeStatus === "closed" ||
      rtAfter.bridgeStatus === "error";
    if (needsSpawn) {
      await get().spawnBridge({
        ...get().gaConfig,
        sessionId: id,
      });
    } else {
      // Already alive — mark as most-recently-used so the LRU
      // governor protects it on the next overflow.
      _lruTouch(id);
    }
  },

  archiveSession: (sessionId) => {
    const now = new Date().toISOString();
    let updated: Session | null = null;
    let archivedTitle = "";
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        archivedTitle = s.title;
        updated = { ...s, status: "archived", updatedAt: now };
        return updated;
      });
      // Clear active session if the one being archived was active —
      // the main view falls back to the empty state seamlessly.
      const activeSessionId =
        state.activeSessionId === sessionId
          ? undefined
          : state.activeSessionId;
      return { sessions, activeSessionId };
    });
    if (updated) {
      void persistSession(updated).catch((e) => {
        console.debug("[store] archiveSession persistSession failed.", e);
      });
      // UX feedback: archiving makes the row vanish from the
      // sidebar, which on its own reads as "did anything happen?".
      // A short info toast confirms the action — eventually V0.2
      // upgrades this to include an Undo affordance.
      get().pushToast(
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
    }
  },

  unarchiveSession: (sessionId) => {
    const now = new Date().toISOString();
    let updated: Session | null = null;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        updated = { ...s, status: "idle", updatedAt: now };
        return updated;
      }),
    }));
    if (updated) {
      void persistSession(updated).catch((e) => {
        console.debug("[store] unarchiveSession persistSession failed.", e);
      });
    }
  },

  restoreSessionTurns: async (sessionId) => {
    let rows: MessageRow[];
    try {
      rows = await loadMessagesBySession(sessionId);
    } catch (e) {
      console.debug(
        "[store] restoreSessionTurns: SQLite unavailable.",
        e,
      );
      return;
    }
    if (rows.length === 0) return;
    const turns = rowsToTurns(rows);
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns,
      })),
    );
  },

  // ---- Approval (global) ----
  setApprovalRequiredTools: (tools) =>
    set((state) => ({
      approvalConfig: { ...state.approvalConfig, requiredTools: tools },
    })),

  removeAlwaysAllow: (scope, tool) =>
    set((state) => ({
      approvalConfig:
        scope === "project"
          ? {
              ...state.approvalConfig,
              alwaysAllowProject:
                state.approvalConfig.alwaysAllowProject.filter(
                  (t) => t !== tool,
                ),
            }
          : {
              ...state.approvalConfig,
              alwaysAllowGlobal: state.approvalConfig.alwaysAllowGlobal.filter(
                (t) => t !== tool,
              ),
            },
    })),

  setYoloMode: async (enabled) => {
    set({ yoloMode: enabled });
    // Best-effort persist: SQLite may be absent in Vite-only dev. The
    // in-memory state still drives UI + IPC for the current launch.
    try {
      await setPref("yolo_mode", enabled);
    } catch (e) {
      console.warn("[store] setYoloMode: pref persistence failed.", e);
    }
    // YOLO is global — notify every alive bridge. Sessions spawned
    // later sync via the on-`ready` handler in ipc-handlers.ts.
    for (const [sid, client] of _bridgeClients) {
      try {
        await client.send({ kind: "set_yolo_mode", enabled });
      } catch (e) {
        console.warn(`[store] setYoloMode: bridge ${sid} notify failed.`, e);
      }
    }
  },

  setGAConfig: async (partial) => {
    const merged = { ...get().gaConfig, ...partial };
    set((state) => ({
      gaConfig: merged,
      // Reflect into runtimeInfo so the Settings → Runtime tab and
      // Inspector → Runtime card show the new path immediately.
      // pythonVersion is intentionally repurposed to display the
      // interpreter path — users see the path they picked.
      runtimeInfo: {
        ...state.runtimeInfo,
        gaPath: merged.gaPath,
        pythonVersion: merged.python,
      },
    }));
    try {
      await setPref("ga_config", merged);
    } catch (e) {
      console.warn("[store] setGAConfig: pref persistence failed.", e);
    }
    // Existing alive bridges keep their old config. Tell the user
    // that the change takes effect on next launch — DESIGN §9 §"改动
    // 后需要重启 Workbench". Skip the toast if nothing changed (no-op
    // call), since the picker might fire even when the user re-picks
    // the same path.
    const changedField = Object.entries(partial).find(
      ([, v]) => v !== undefined && v !== "",
    );
    if (changedField) {
      get().pushToast(
        makeAppError({
          category: "business",
          severity: "info",
          title: "已保存路径配置",
          message: "重启 Workbench 才能让现有 session 生效",
          hint: null,
          retryable: false,
          context: "setGAConfig",
          traceback: null,
        }),
      );
    }
  },

  // ---- Errors ----
  pushToast: (e) =>
    set((state) => ({
      toasts: [e, ...state.toasts.filter((t) => t.id !== e.id)],
    })),

  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  // ---- LLMs ----
  replaceLLMs: (sessionId, llms) =>
    set((state) => {
      // displayName follows isCurrent. If for some reason no entry
      // is flagged current, keep the previous displayName to avoid
      // a flash of empty string in the Composer.
      const current = llms.find((l) => l.isCurrent);
      return applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        llms,
        llmDisplayName: current?.displayName ?? rt.llmDisplayName,
      }));
    }),

  // ---- Conversation (per-session) ----
  appendUserTurn: (sessionId, text) => {
    let titleDerived: { sessionId: string; title: string } | null = null;
    set((state) => {
      const update = applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, { role: "user", content: text } as UserTurn],
        // The agent will start running on the bridge shortly. Set
        // synchronously rather than wait for `turn_start` over IPC —
        // the round-trip would re-introduce the latency we're
        // masking with the thinking placeholder.
        agentRunning: true,
        // Drive MainView's stick-to-top scroll. See `userSubmitTick`
        // doc comment in State.
        userSubmitTick: rt.userSubmitTick + 1,
        // Wipe leftover streaming buffer from a previous turn.
        inFlightContent: "",
      }));
      // Derive a Sidebar title from the first user message — but only
      // once, and only when the row is still wearing the seed
      // "新对话" placeholder. Renaming a user-edited title would be
      // worse than no rename.
      //
      // `applyRuntimeUpdate` may have already produced a new `sessions`
      // (sidebar status / approval-count sync), so we layer this on
      // top of whichever array is freshest.
      const baseSessions = update.sessions ?? state.sessions;
      const idx = baseSessions.findIndex((s) => s.id === sessionId);
      if (idx !== -1) {
        const session = baseSessions[idx];
        if (session.title === DEFAULT_NEW_SESSION_TITLE && text.trim()) {
          const newTitle = deriveTitleFromText(text);
          const sessions = baseSessions.slice();
          sessions[idx] = { ...session, title: newTitle };
          update.sessions = sessions;
          titleDerived = { sessionId, title: newTitle };
        }
      }
      return update;
    });
    if (titleDerived) {
      // Best-effort persist so the derived title survives an app
      // restart. SQLite unavailable in pre-Tauri dev is non-fatal.
      const snap = get().sessions.find(
        (s) => s.id === titleDerived!.sessionId,
      );
      if (snap) {
        void persistSession(snap).catch((e) => {
          console.debug("[store] appendUserTurn persistSession failed.", e);
        });
      }
    }
    // Persist the user message to SQLite for Session Restore. turnIndex
    // is derived as `turnCount + 1` because GA hasn't emitted turn_start
    // yet — that event arrives after the bridge starts processing
    // user_message and confirms our local guess. The pairing holds
    // because GA always assigns one turn per user message.
    const sessionSnap = get().sessions.find((s) => s.id === sessionId);
    const nextTurnIndex = (sessionSnap?.turnCount ?? 0) + 1;
    void persistUserMessage({
      sessionId,
      turnIndex: nextTurnIndex,
      content: text,
    }).catch((e) => {
      console.debug("[store] appendUserTurn persistUserMessage failed.", e);
    });
  },

  appendAgentTurn: (sessionId, turn) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, turn],
        // turn_end is the canonical "agent finished this round"
        // signal. ipc-handlers also clears agentRunning on `error`/
        // `run_complete` for the failure paths where turn_end never
        // arrives.
        agentRunning: false,
        // Finalised turn replaces the streaming buffer.
        inFlightContent: "",
      })),
    ),

  addPendingApproval: (sessionId, p) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        // de-dupe on approvalId so a re-emitted pending event doesn't
        // create twin entries
        pendingApprovals: [
          ...rt.pendingApprovals.filter((x) => x.approvalId !== p.approvalId),
          p,
        ],
      })),
    ),

  removePendingApproval: (sessionId, approvalId) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        pendingApprovals: rt.pendingApprovals.filter(
          (x) => x.approvalId !== approvalId,
        ),
      })),
    ),

  recordApprovalDecision: (sessionId, approvalId, decision) => {
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        approvalDecisions: {
          ...rt.approvalDecisions,
          [approvalId]: decision,
        },
      })),
    );
    // Best-effort SQLite double-write for the approval audit trail.
    // The matching `pending` row was written when tool_call_pending
    // arrived (see ipc-handlers.persistToolEventPendingFromIPC); this
    // update fills in approval_decision + terminal status.
    void persistToolEventApprovalDecision(
      approvalId,
      decision,
      new Date().toISOString(),
    ).catch((e) => {
      console.debug("[store] persistToolEventApprovalDecision failed.", e);
    });
  },

  clearConversation: (sessionId) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [],
        pendingApprovals: [],
        approvalDecisions: {},
        agentRunning: false,
        currentTurnIndex: null,
        inFlightContent: "",
      })),
    ),

  setAgentRunning: (sessionId, running) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        agentRunning: running,
      })),
    ),

  setCurrentTurnIndex: (sessionId, idx) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        currentTurnIndex: idx,
      })),
    ),

  appendInFlightDelta: (sessionId, delta) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        inFlightContent: rt.inFlightContent + delta,
      })),
    ),

  clearInFlightContent: (sessionId) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        inFlightContent: "",
      })),
    ),

  // ---- Bridge runtime ----
  setBridgeStatus: (sessionId, status) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        bridgeStatus: status,
      })),
    ),

  spawnBridge: async (args) => {
    const sessionId = args.sessionId;
    // One process per sessionId. If that session already has a live
    // bridge, shut it down first. Other sessions' bridges are NOT
    // touched — multi-session is the v0.1 core promise.
    if (_bridgeClients.has(sessionId)) {
      console.warn(
        `[store] spawnBridge(${sessionId}) called while a bridge for that session is alive; shutting down first.`,
      );
      await useAppStore.getState().shutdownBridge(sessionId);
    }

    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        bridgeStatus: "spawning",
        bridgeError: null,
      })),
    );

    try {
      const client = await spawnBridgeProcess(args, {
        onEvent: (event) => dispatchIPCEvent(event, useAppStore),
        onStderr: (line) =>
          console.warn(`[bridge ${sessionId} stderr]`, line),
        onClose: (code, signal) => {
          console.info(`[bridge ${sessionId}] closed`, { code, signal });
          _bridgeClients.delete(sessionId);
          // Drop from LRU regardless of why it closed — planned
          // shutdownBridge already removed it; crashes / external
          // kills get cleaned up here. Defensive: indexOf check
          // makes the second remove a no-op.
          _lruRemove(sessionId);
          useAppStore.setState((state) =>
            applyRuntimeUpdate(state, sessionId, (rt) => ({
              ...rt,
              bridgeStatus: "closed",
              bridgePid: null,
            })),
          );
        },
        onError: (msg) => {
          console.error(`[bridge ${sessionId}] error`, msg);
          useAppStore.setState((state) =>
            applyRuntimeUpdate(state, sessionId, (rt) => ({
              ...rt,
              bridgeStatus: "error",
              bridgeError: msg,
            })),
          );
        },
        onMalformedLine: (line) =>
          console.warn(
            `[bridge ${sessionId}] malformed stdout line:`,
            line,
          ),
      });
      _bridgeClients.set(sessionId, client);
      _lruTouch(sessionId);
      // Status flips to "connected" only after the bridge sends its
      // `ready` event (handled in ipc-handlers). Keep "spawning"
      // here so the UI knows to show a loading affordance.
      set((state) =>
        applyRuntimeUpdate(state, sessionId, (rt) => ({
          ...rt,
          bridgePid: client.pid,
        })),
      );
      // Enforce LRU cap — suspend the oldest non-active bridges so
      // resource use stays bounded even after the user opens 20+
      // sessions. The suspended session's row keeps showing in the
      // sidebar; clicking it later re-spawns + replays history.
      // Fire-and-forget so spawn returns to the caller promptly;
      // overflow shutdown happens in the background.
      void _enforceLRUCap();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      _bridgeClients.delete(sessionId);
      set((state) =>
        applyRuntimeUpdate(state, sessionId, (rt) => ({
          ...rt,
          bridgeStatus: "error",
          bridgeError: msg,
          bridgePid: null,
        })),
      );
    }
  },

  shutdownBridge: async (sessionId) => {
    const client = _bridgeClients.get(sessionId);
    if (!client) return;
    try {
      await client.shutdown();
    } finally {
      _bridgeClients.delete(sessionId);
      _lruRemove(sessionId);
      set((state) =>
        applyRuntimeUpdate(state, sessionId, (rt) => ({
          ...rt,
          bridgeStatus: "closed",
          bridgePid: null,
        })),
      );
    }
  },

  shutdownAllBridges: async () => {
    const ids = Array.from(_bridgeClients.keys());
    await Promise.all(
      ids.map((id) => useAppStore.getState().shutdownBridge(id)),
    );
  },

  sendIPCCommand: async (sessionId, cmd) => {
    const client = _bridgeClients.get(sessionId);
    if (!client) {
      console.warn(
        `[store] sendIPCCommand(${sessionId}) called but no bridge is alive:`,
        cmd,
      );
      return;
    }
    await client.send(cmd);
  },

  // ---- Persistence ----
  //
  // Called once at app mount. Loads sessions from SQLite; if the DB
  // is empty, seeds the demo fixtures into it so the dev build has
  // something to render. Falls back silently to the demo seed in
  // initial state if SQLite isn't available (Vite-only dev / first
  // launch before tauri-plugin-sql finishes init).
  hydrateFromDB: async () => {
    try {
      // Sweep accumulated empty "新对话" rows from prior launches —
      // each auto-created session that the user never typed into
      // would otherwise stick around forever and crowd the sidebar.
      // Done before loadSessions so the in-memory list reflects the
      // cleanup state.
      try {
        const removed = await deleteEmptyNewSessions();
        if (removed > 0) {
          console.info(
            `[store] hydrateFromDB: pruned ${removed} empty 新对话 row(s).`,
          );
        }
      } catch (e) {
        console.debug(
          "[store] hydrateFromDB: deleteEmptyNewSessions failed.",
          e,
        );
      }
      // One-time cleanup of the v0.1 demo placeholder sessions
      // (s-today-* / s-week-* / s-earlier-* from stores/demo.ts).
      // Stage 3 ships real onboarding + restore, so these
      // hard-coded fixtures are pure noise. Idempotent — safe to
      // run on every launch.
      try {
        const removed = await deleteDemoSessions();
        if (removed > 0) {
          console.info(
            `[store] hydrateFromDB: pruned ${removed} legacy demo session(s).`,
          );
        }
      } catch (e) {
        console.debug(
          "[store] hydrateFromDB: deleteDemoSessions failed.",
          e,
        );
      }
      const sessions = await loadSessions();
      // No demo-seed on first launch. DEMO_SESSIONS stay as the
      // in-memory initial state for the brief moment before
      // hydrate resolves; if the user has zero real sessions, the
      // sidebar shows its empty-state hint and prompts a "New chat".
      set({ sessions });
    } catch (e) {
      // Non-Tauri context (Vite dev) or migration not yet applied.
      console.warn(
        "[store] hydrateFromDB: SQLite unavailable, using demo seed.",
        e,
      );
    }
    // YOLO mode (PRD §11.5) — sticky preference. Best-effort load;
    // defaults to `false` from initial state when SQLite is
    // unavailable. We don't call setYoloMode() here so as not to
    // double-persist on startup or attempt to notify a bridge that
    // doesn't exist yet — the on-`ready` IPC handler does that sync
    // when a bridge does spawn.
    try {
      const yolo = await getPref<boolean>("yolo_mode");
      if (yolo === true) set({ yoloMode: true });
    } catch (e) {
      console.warn("[store] hydrateFromDB: yolo pref load failed.", e);
    }
    // GA spawn config (Stage 3 Task 4). Fall back to DEMO_GA_CONFIG in
    // initial state when missing — first launch sees the demo path
    // until the user opens Settings → Runtime and picks one.
    try {
      const saved = await getPref<{
        python: string;
        gaPath: string;
        bridgeCwd: string;
      }>("ga_config");
      if (saved && saved.gaPath) {
        set((state) => ({
          gaConfig: saved,
          runtimeInfo: {
            ...state.runtimeInfo,
            gaPath: saved.gaPath,
            pythonVersion: saved.python,
          },
        }));
      }
    } catch (e) {
      console.warn("[store] hydrateFromDB: ga_config pref load failed.", e);
    }
  },
}));

// Expose the store on `window.__store` in dev so the user can
// inspect / mutate state from the DevTools console without React
// DevTools. Stripped in production by `import.meta.env.DEV`.
//
// Usage in console:
//   __store.getState().agentRunning
//   __store.setState({ agentRunning: false })  // unblock if stuck
if (import.meta.env.DEV) {
  (globalThis as { __store?: typeof useAppStore }).__store = useAppStore;
}
