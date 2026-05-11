import { create } from "zustand";

import type { ApprovalConfig } from "@/components/screens/settings/Settings";
import {
  type BridgeClient,
  type BridgeSpawnArgs,
  spawnBridge as spawnBridgeProcess,
} from "@/lib/bridge";
import {
  getPref,
  loadSessions,
  persistSession,
  persistToolEventApprovalDecision,
  setPref,
} from "@/lib/db";
import { dispatchIPCEvent } from "@/lib/ipc-handlers";
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
  PendingApproval,
  Turn,
  UserTurn,
} from "@/types/conversation";
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
  llms: LLMOption[];
  llmDisplayName: string;
  runtimeInfo: RuntimeInfo;

  // ---- Approval (global) ----
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
   * "Turn N" badge reflect activity without a full reload.
   *
   * Status is set to "idle" — turn_end is the canonical "agent
   * finished this round" signal; subsequent runs flip status back
   * to "running" via setBridgeStatus + agentRunning.
   */
  bumpSessionAfterTurn: (sessionId: string) => void;

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

  // Errors
  pushToast: (e: AppError) => void;
  dismissToast: (id: string) => void;

  // LLMs (replaceLLMs is called by ipc-handlers on ready / llm_changed)
  replaceLLMs: (llms: LLMOption[]) => void;

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
 * Helper: apply an updater to a single session's runtime, and
 * refresh the top-level projection when that session is the active
 * one. Returns a partial state to be passed to Zustand's `set`.
 *
 * Lazily initializes the runtime entry if missing — the IPC layer
 * may emit events (turn_start, turn_progress, tool_call_pending)
 * for a session that the store hasn't seen yet (e.g., a bridge
 * spawn started but the runtime wasn't pre-seeded). We accept
 * those updates rather than dropping them.
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
  llms: DEMO_LLMS,
  llmDisplayName: DEMO_LLM_DISPLAY_NAME,
  runtimeInfo: DEMO_RUNTIME_INFO,

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
  setActiveSession: (id) =>
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
      return {
        activeSessionId: id,
        _runtimes,
        ...projectionFrom(rt),
      };
    }),

  createSession: () => {
    const id = `s-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const now = new Date().toISOString();
    const newSession: Session = {
      id,
      title: "新对话",
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
    // dismiss the toast and keep going. The number is a "you might
    // want to archive some" line, not a hard limit.
    const totalNow = get().sessions.length;
    if (totalNow > 10) {
      get().pushToast(
        makeAppError({
          category: "business",
          severity: "warning",
          message: `已开 ${totalNow} 个 session — 建议先 archive 几个旧的，否则后台 bridge 进程会越来越占资源。`,
          hint: null,
          retryable: false,
          context: "createSession",
          traceback: null,
        }),
      );
    }
    return id;
  },

  bumpSessionAfterTurn: (sessionId) => {
    const now = new Date().toISOString();
    let updated: Session | null = null;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        updated = {
          ...s,
          turnCount: (s.turnCount ?? 0) + 1,
          lastActivityAt: now,
          updatedAt: now,
          status: "idle",
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
    // Auto-spawn the bridge when this session has no live one.
    // Re-spawn on `closed` / `error` lets a kill or crash recover
    // by simply re-clicking the session.
    const rt = get()._runtimes[id];
    const needsSpawn =
      !rt ||
      rt.bridgeStatus === "idle" ||
      rt.bridgeStatus === "closed" ||
      rt.bridgeStatus === "error";
    if (needsSpawn) {
      await get().spawnBridge({
        ...DEMO_GA_CONFIG,
        sessionId: id,
      });
    }
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
  replaceLLMs: (llms) => set({ llms }),

  // ---- Conversation (per-session) ----
  appendUserTurn: (sessionId, text) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
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
      })),
    ),

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
      // Status flips to "connected" only after the bridge sends its
      // `ready` event (handled in ipc-handlers). Keep "spawning"
      // here so the UI knows to show a loading affordance.
      set((state) =>
        applyRuntimeUpdate(state, sessionId, (rt) => ({
          ...rt,
          bridgePid: client.pid,
        })),
      );
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
      const sessions = await loadSessions();
      if (sessions.length === 0) {
        await Promise.all(DEMO_SESSIONS.map(persistSession));
        // Initial state already has DEMO_SESSIONS — no setState needed.
      } else {
        set({ sessions });
      }
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
