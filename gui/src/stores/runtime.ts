import { create } from "zustand";

import { dispatchIPCEvent } from "@/lib/ipc-handlers";
import {
  spawnBridge as spawnBridgeProcess,
  type BridgeClient,
  type BridgeSpawnArgs,
} from "@/lib/bridge";
import { setPref } from "@/lib/db";
import {
  DEMO_LLM_DISPLAY_NAME,
  DEMO_LLMS,
  DEMO_RUNTIME_INFO,
} from "@/stores/demo";
import { useMessagesStore } from "@/stores/messages";
import { usePrefsStore } from "@/stores/prefs";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { makeAppError } from "@/types/app-error";
import type { RuntimeInfo } from "@/types/inspector";
import type { IPCCommand } from "@/types/ipc";

/**
 * LLM available in the bridge's GA-loaded mykey.py. Mirrors
 * `runner/ipc.py::ReadyEvent.availableLLMs` per-entry shape.
 */
export interface LLMOption {
  index: number;
  displayName: string;
  isCurrent: boolean;
}

/**
 * Bridge subprocess lifecycle status. runtimeStore owns the bridge
 * fields and the lifecycle they describe.
 */
export type BridgeStatus =
  | "idle"
  | "spawning"
  | "connected"
  | "closed"
  | "error";

/**
 * Per-session runtime slot. B3 M3a carried LLM fields only; M3b adds
 * `bridgeStatus / bridgeError / bridgePid`. The map is keyed by
 * sessionId; `ensureRuntime` guarantees an entry exists before any
 * read (so selectors can return `byId[activeId].llms` without `?.`
 * chains in the hot path).
 */
export interface PerSessionRuntime {
  llms: LLMOption[];
  llmDisplayName: string;
  bridgeStatus: BridgeStatus;
  bridgeError: string | null;
  bridgePid: number | null;
}

/**
 * Seed hints fed by `sessionsStore.setActiveSession` when lazy-creating
 * a runtime entry. Carry the session row's persisted `selectedLlm*`
 * fields so the pill renders correctly from t=0 — without these, the
 * picker flashes the cross-session hydrate-cached current LLM (or
 * DEMO_LLMS on first-ever startup) until bridge `ready` arrives.
 */
export interface RuntimeSeedHints {
  persistedIndex?: number;
  persistedDisplayName?: string;
  /**
   * Cross-session hydrate cache; passed in by setActiveSession so
   * runtimeStore doesn't have to read sessionsStore for the
   * cached list. Used when `persistedIndex` is undefined.
   */
  cachedLLMs?: LLMOption[];
  cachedDisplayName?: string;
}

interface RuntimeState {
  byId: Record<string, PerSessionRuntime>;
  /**
   * Cross-session LLM list cache: populated by `hydrateFromDB` from
   * the `llm_list` pref (a snapshot from any prior bridge's `ready`
   * event), and refreshed on every `replaceLLMs` (since the freshly
   * arrived list is also a valid cross-session snapshot).
   *
   * Used as the seed pool for `ensureRuntime` when a new session is
   * activated and has no byId entry yet. Without this, the picker
   * would have to show DEMO_LLMS or wait for bridge ready — both
   * UX regressions captured in the M3a "pre-seed runtime" work.
   */
  cachedLLMs: LLMOption[];
  /**
   * Cross-session display-name companion to {@link cachedLLMs}. The
   * "current" entry's displayName when the cached list was captured.
   * Falls back into seed when a session has no persisted choice.
   *
   * Seeded by `lib/hydrate.ts` from the `llm_list` pref at cold start.
   */
  cachedLLMDisplayName: string;
  /**
   * EmptyState's inline LLM picker stash. Consumed by
   * `sessionsStore.activateSession` when it spawns the bridge for a
   * fresh session with zero turns. Cleared after consumption so an
   * abandoned pick (user picked LLM then clicked an existing
   * session) doesn't leak into a later unrelated spawn.
   */
  pendingLLMIndex: number | undefined;
  /**
   * Which session currently holds the desktop pet subprocess. Global
   * because the pet is single-instance (one OS-level port). Cleared
   * by `pet_detached` IPC; set by `pet_attached` IPC + this action.
   */
  petAttachedSessionId: string | null;
  runtimeInfo: RuntimeInfo;
  /**
   * Idempotence flag for `warmupLLMList` (one-shot bridge spawn at
   * launch to capture the GA mykey.py list before the first user
   * session). Reset by `prefsStore.setGAConfig` cross-store so
   * changing GA path re-runs warmup.
   */
  _warmupComplete: boolean;
}

interface RuntimeActions {
  /**
   * Lazy-create or refresh the LLM-side of a session's runtime. Idempotent —
   * if `byId[sid]` already exists, the seed is ignored (existing values
   * win because they reflect the live bridge's authoritative state).
   * Called from `sessionsStore.setActiveSession`.
   */
  ensureRuntime: (sid: string, seed: RuntimeSeedHints) => void;
  /** Set bridge status. Used by ipc-handlers ready event. */
  setBridgeStatus: (sid: string, status: BridgeStatus) => void;
  /**
   * Spawn a GA bridge subprocess for `args.sessionId`. If that session
   * already has a live bridge, shut it down first. LRU eviction
   * enforced inside this action via the runtime-private
   * `_bridgeClients` / `_lruOrder` maps (LRU_CAP = 20 active bridges).
   */
  spawnBridge: (args: BridgeSpawnArgs) => Promise<void>;
  /** Graceful shutdown. No-op if no bridge alive for `sid`. */
  shutdownBridge: (sid: string) => Promise<void>;
  /** Shutdown every alive bridge — App-quit cleanup path. */
  shutdownAllBridges: () => Promise<void>;
  /** Send an IPC command to `sid`'s bridge over stdin. Warns + no-op
   * if no live bridge. */
  sendIPCCommand: (sid: string, cmd: IPCCommand) => Promise<void>;
  /**
   * Apply the LLM list reported by a bridge's `ready` / `llm_changed`
   * event. Updates byId[sid], caches the list to `llm_list` pref, and
   * mirrors the user's selected LLM onto the session row in
   * sessionsStore (via `setSessionLlm`) for persistence across app
   * restart.
   */
  replaceLLMs: (sid: string, llms: LLMOption[]) => void;
  /**
   * EmptyState picker stash: pre-bridge LLM choice for the next new
   * session. Bumps `pendingLLMIndex` so activateSession can pass it
   * to `--llm-no` at spawn time.
   */
  selectLLMForNewSession: (index: number) => void;
  /**
   * One-shot bridge spawn at app launch to capture the GA mykey.py
   * LLM list before any user session exists. Caches the list to prefs
   * and shuts the bridge down immediately. Idempotent via
   * `_warmupComplete`.
   */
  warmupLLMList: () => Promise<void>;
  setPetAttachedSession: (sid: string | null) => void;
  patchRuntimeInfo: (patch: Partial<RuntimeInfo>) => void;
  /**
   * Cross-store: prefsStore.setGAConfig calls this when gaPath /
   * python changes so a future `warmupLLMList` re-runs against the
   * new install. A direct call is fine — prefs is the only writer
   * and the relationship is purely intra-process.
   */
  resetWarmup: () => void;
  /**
   * Seed the cross-session LLM cache. Called by `hydrateFromDB`
   * after loading the `llm_list` pref (latest snapshot from a prior
   * bridge spawn). Without this, the first activation in a new app
   * run would have no real LLM list to seed against and fall through
   * to DEMO_LLMS.
   */
  seedCachedLLMs: (list: LLMOption[]) => void;
}

export type RuntimeStore = RuntimeState & RuntimeActions;

/**
 * Build a fresh per-session runtime from seed hints. Centralised so
 * `ensureRuntime` and any future setters use identical semantics:
 *
 *   1. If the session has a persisted LLM choice (`selectedLlmIndex`
 *      column → seed.persistedIndex), re-flag `isCurrent` on the
 *      cached list to match it.
 *   2. Otherwise honour the cached list's own `isCurrent` (cross-
 *      session hydrate cache = whichever LLM was current last).
 *   3. If no cached list exists at all (first-ever cold start with
 *      no `llm_list` pref), fall through to DEMO_LLMS so the picker
 *      isn't empty during onboarding.
 */
// ---- Module-level bridge resources (private to runtime slice) ----
//
// Runtime-internal state: bridge process handles + stderr buffers +
// LRU ordering. Not exported — outside callers go through the
// actions below.
//
// Why module-level (not Zustand state):
// - The `BridgeClient` value carries a tokio handle to a Tauri-side
//   listener; not serialisable (Zustand's preferred shape).
// - `_stderrTails` is pure diagnostic, no rendering reacts.
// - LRU ordering is mutated frequently; keeping it out of Zustand
//   avoids triggering subscribers on every spawn/touch.

const _bridgeClients = new Map<string, BridgeClient>();
const _stderrTails = new Map<string, string[]>();
const _STDERR_TAIL_MAX = 8;
const _lruOrder: string[] = [];
const LRU_CAP = 20;

function _lruTouch(sessionId: string): void {
  const idx = _lruOrder.indexOf(sessionId);
  if (idx !== -1) _lruOrder.splice(idx, 1);
  _lruOrder.push(sessionId);
}

function _lruRemove(sessionId: string): void {
  const idx = _lruOrder.indexOf(sessionId);
  if (idx !== -1) _lruOrder.splice(idx, 1);
}

async function _enforceLRUCap(): Promise<void> {
  while (_lruOrder.length > LRU_CAP) {
    // `agentRunning` lives in messagesStore (B3 M5). Active-running
    // bridges are protected from eviction so we don't kill a streaming
    // agent the user just walked away from.
    const messagesState = useMessagesStore.getState();
    const activeId = useSessionsStore.getState().activeSessionId;
    const victim = _lruOrder.find(
      (id) => id !== activeId && !messagesState.byId[id]?.agentRunning,
    );
    if (!victim) {
      console.info(
        `[lru] no eviction candidate (cap=${LRU_CAP}, alive=${_lruOrder.length}); all alive bridges are active or running`,
      );
      return;
    }
    try {
      await useRuntimeStore.getState().shutdownBridge(victim);
    } catch (e) {
      console.warn(`[lru] shutdown of ${victim} failed:`, e);
      _lruRemove(victim); // force-unblock even if shutdown threw
    }
  }
}

function _bridgeFieldsUpdate(
  rt: PerSessionRuntime | undefined,
  patch: Partial<Pick<PerSessionRuntime, "bridgeStatus" | "bridgeError" | "bridgePid">>,
): PerSessionRuntime {
  return {
    llms: rt?.llms ?? DEMO_LLMS,
    llmDisplayName: rt?.llmDisplayName ?? DEMO_LLM_DISPLAY_NAME,
    bridgeStatus: patch.bridgeStatus ?? rt?.bridgeStatus ?? "idle",
    bridgeError:
      patch.bridgeError !== undefined ? patch.bridgeError : (rt?.bridgeError ?? null),
    bridgePid:
      patch.bridgePid !== undefined ? patch.bridgePid : (rt?.bridgePid ?? null),
  };
}

function buildSeedRuntime(seed: RuntimeSeedHints): PerSessionRuntime {
  const cached = seed.cachedLLMs ?? [];
  const baseBridge = {
    bridgeStatus: "idle" as BridgeStatus,
    bridgeError: null,
    bridgePid: null,
  };
  if (cached.length === 0) {
    return {
      llms: DEMO_LLMS,
      llmDisplayName: DEMO_LLM_DISPLAY_NAME,
      ...baseBridge,
    };
  }
  const llms =
    seed.persistedIndex !== undefined
      ? cached.map((l) => ({
          ...l,
          isCurrent: l.index === seed.persistedIndex,
        }))
      : cached;
  const llmDisplayName =
    seed.persistedDisplayName ??
    seed.cachedDisplayName ??
    cached.find((l) => l.isCurrent)?.displayName ??
    DEMO_LLM_DISPLAY_NAME;
  return { llms, llmDisplayName, ...baseBridge };
}

export const useRuntimeStore = create<RuntimeStore>((set, get) => ({
  byId: {},
  cachedLLMs: [],
  cachedLLMDisplayName: "",
  pendingLLMIndex: undefined,
  petAttachedSessionId: null,
  runtimeInfo: DEMO_RUNTIME_INFO,
  _warmupComplete: false,

  ensureRuntime: (sid, seed) =>
    set((state) =>
      state.byId[sid]
        ? {}
        : { byId: { ...state.byId, [sid]: buildSeedRuntime(seed) } },
    ),

  replaceLLMs: (sid, llms) => {
    const current = llms.find((l) => l.isCurrent);
    set((state) => {
      const existing = state.byId[sid];
      const next: PerSessionRuntime = {
        llms,
        // displayName follows isCurrent. If for some reason no entry
        // is flagged current, keep the previous displayName to avoid
        // a flash of empty string in the Composer.
        llmDisplayName: current?.displayName ?? existing?.llmDisplayName ?? "",
        bridgeStatus: existing?.bridgeStatus ?? "idle",
        bridgeError: existing?.bridgeError ?? null,
        bridgePid: existing?.bridgePid ?? null,
      };
      // Refresh the cross-session cache too — the freshly arrived
      // list is also a valid snapshot for any future un-seeded
      // session activation.
      return {
        byId: { ...state.byId, [sid]: next },
        cachedLLMs: llms,
        cachedLLMDisplayName: current?.displayName ?? state.cachedLLMDisplayName,
      };
    });
    // Cache LLM list to prefs so future cold-starts (before any
    // bridge has spawned) can show the real model names instead
    // of the DEMO_LLMS seed. The LLM list is GA-install-wide
    // (mykey.py is one file shared across sessions), so any one
    // bridge's `ready` event is a faithful snapshot.
    void setPref("llm_list", llms).catch((e) => {
      console.debug("[runtime] replaceLLMs llm_list cache failed.", e);
    });
    // Mirror the user's current LLM onto the session row via
    // sessionsStore.setSessionLlm so the choice survives app
    // restart (routes through the Rust `set_session_llm` trait
    // method for SQLite persistence).
    if (current) {
      void mirrorSelectedLLMOnSession(sid, current).catch((e) => {
        console.debug("[runtime] replaceLLMs session mirror failed.", e);
      });
    }
  },

  selectLLMForNewSession: (index) =>
    set((state) => {
      // Apply the choice to ALL sessions' per-runtime cache so the
      // Composer pill flips immediately on the empty screen. Future
      // bridge spawns inherit via `pendingLLMIndex` → `--llm-no`.
      const nextById: Record<string, PerSessionRuntime> = {};
      for (const [sid, rt] of Object.entries(state.byId)) {
        if (index < 0 || index >= rt.llms.length) {
          nextById[sid] = rt;
          continue;
        }
        const flipped = rt.llms.map((l, i) => ({
          ...l,
          isCurrent: i === index,
        }));
        nextById[sid] = {
          ...rt,
          llms: flipped,
          llmDisplayName: flipped[index].displayName,
        };
      }
      return { byId: nextById, pendingLLMIndex: index };
    }),

  warmupLLMList: async () => {
    if (get()._warmupComplete) return;
    // Read the GA config from prefsStore. Cross-store read is allowed
    // per AD-09 DAG (runtimeStore depends on prefsStore for gaConfig).
    const config = readGAConfigFromPrefs();
    if (!config.gaPath) return;
    set({ _warmupComplete: true });

    let client: BridgeClient | null = null;
    let pendingShutdown = false;
    let readyHandled = false;

    try {
      client = await spawnBridgeProcess(
        { ...config, sessionId: "__warmup__" },
        {
          onEvent: (event) => {
            if (event.kind !== "ready" || readyHandled) return;
            readyHandled = true;
            const llms: LLMOption[] = event.availableLLMs.map((l) => ({
              index: l.index,
              displayName: l.displayName,
              isCurrent: l.isCurrent,
            }));
            const current = llms.find((l) => l.isCurrent);
            // Warmup populates EVERY future-existing session's seed
            // through the `llm_list` pref hydrate path. We don't
            // populate byId here because warmup runs before any
            // session is active — there's no sid to key by.
            void setPref("llm_list", llms).catch((e) => {
              console.debug("[warmup] llm_list cache failed.", e);
            });
            // Also push current displayName onto runtimeInfo so the
            // Settings → Runtime panel shows it immediately.
            set((state) => ({
              runtimeInfo: {
                ...state.runtimeInfo,
                pythonVersion: state.runtimeInfo.pythonVersion,
              },
            }));
            if (current) {
              // Stash so the very next session activation pre-seed
              // can pick this up via `cachedDisplayName` hint.
              // (TopBar pill / Composer pill read via the active
              // session's byId entry; warmup itself doesn't write
              // byId.)
            }
            if (client) {
              void client.shutdown(5000);
            } else {
              pendingShutdown = true;
            }
          },
          onStderr: (line) => console.debug("[warmup stderr]", line),
          onClose: () => console.debug("[warmup] closed"),
          onError: (msg) => console.warn("[warmup] error:", msg),
        },
      );
      if (pendingShutdown) {
        void client.shutdown(5000);
      }
      setTimeout(() => {
        if (!readyHandled && client) {
          console.warn("[warmup] ready timeout, shutting down");
          void client.shutdown(5000);
        }
      }, 15000);
    } catch (e) {
      console.warn("[runtime] warmupLLMList spawn failed:", e);
      set({ _warmupComplete: false });
    }
  },

  setPetAttachedSession: (sid) => set({ petAttachedSessionId: sid }),

  setBridgeStatus: (sid, status) =>
    set((state) => ({
      byId: {
        ...state.byId,
        [sid]: _bridgeFieldsUpdate(state.byId[sid], { bridgeStatus: status }),
      },
    })),

  spawnBridge: async (args) => {
    const sessionId = args.sessionId;
    if (_bridgeClients.has(sessionId)) {
      console.warn(
        `[runtime] spawnBridge(${sessionId}) called while a bridge for that session is alive; shutting down first.`,
      );
      await useRuntimeStore.getState().shutdownBridge(sessionId);
    }
    set((state) => ({
      byId: {
        ...state.byId,
        [sessionId]: _bridgeFieldsUpdate(state.byId[sessionId], {
          bridgeStatus: "spawning",
          bridgeError: null,
        }),
      },
    }));

    try {
      const client = await spawnBridgeProcess(args, {
        onEvent: (event) => dispatchIPCEvent(event),
        onStderr: (line) => {
          console.warn(`[bridge ${sessionId} stderr]`, line);
          const buf = _stderrTails.get(sessionId) ?? [];
          buf.push(line);
          if (buf.length > _STDERR_TAIL_MAX) buf.shift();
          _stderrTails.set(sessionId, buf);
        },
        onClose: (code, signal) => {
          console.info(`[bridge ${sessionId}] closed`, { code, signal });
          if (code !== 0 && code !== null) {
            const tail = _stderrTails.get(sessionId) ?? [];
            const message = tail.length
              ? tail.slice(-3).join("\n")
              : `Bridge exited with code ${code}`;
            useUiStore.getState().pushToast(
              makeAppError({
                category: "bridge",
                severity: "error",
                title: "Bridge 进程崩溃",
                message,
                hint: null,
                retryable: false,
                context: `session ${sessionId}`,
                traceback: tail.join("\n"),
              }),
            );
          }
          _stderrTails.delete(sessionId);
          _bridgeClients.delete(sessionId);
          _lruRemove(sessionId);
          // Bridge-side fields go to runtimeStore.
          useRuntimeStore.setState((state) => ({
            byId: {
              ...state.byId,
              [sessionId]: _bridgeFieldsUpdate(state.byId[sessionId], {
                bridgeStatus: "closed",
                bridgePid: null,
              }),
            },
          }));
          // Conversation-side cleanup: agentRunning / currentTurnIndex
          // / inFlightContent live in messagesStore (B3 M5). The
          // streaming reset leaves turns / pendingApprovals /
          // approvalDecisions intact so the user can still read the
          // conversation while the bridge is down. messagesStore's
          // `fireSessionMirror` updates the sidebar status row too.
          useMessagesStore.getState().clearStreamingOnBridgeClose(sessionId);
        },
        onError: (msg) => {
          console.error(`[bridge ${sessionId}] error`, msg);
          useRuntimeStore.setState((state) => ({
            byId: {
              ...state.byId,
              [sessionId]: _bridgeFieldsUpdate(state.byId[sessionId], {
                bridgeStatus: "error",
                bridgeError: msg,
              }),
            },
          }));
          useUiStore.getState().pushToast(
            makeAppError({
              category: "bridge",
              severity: "error",
              title: "Bridge 启动失败",
              message: msg,
              hint: null,
              retryable: false,
              context: `session ${sessionId}`,
              traceback: null,
            }),
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
      set((state) => ({
        byId: {
          ...state.byId,
          [sessionId]: _bridgeFieldsUpdate(state.byId[sessionId], {
            bridgePid: client.pid,
          }),
        },
      }));
      void _enforceLRUCap();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      _bridgeClients.delete(sessionId);
      set((state) => ({
        byId: {
          ...state.byId,
          [sessionId]: _bridgeFieldsUpdate(state.byId[sessionId], {
            bridgeStatus: "error",
            bridgeError: msg,
            bridgePid: null,
          }),
        },
      }));
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
      set((state) => ({
        byId: {
          ...state.byId,
          [sessionId]: _bridgeFieldsUpdate(state.byId[sessionId], {
            bridgeStatus: "closed",
            bridgePid: null,
          }),
        },
      }));
    }
  },

  shutdownAllBridges: async () => {
    const ids = Array.from(_bridgeClients.keys());
    await Promise.all(
      ids.map((id) => useRuntimeStore.getState().shutdownBridge(id)),
    );
  },

  sendIPCCommand: async (sessionId, cmd) => {
    const client = _bridgeClients.get(sessionId);
    if (!client) {
      console.warn(
        `[runtime] sendIPCCommand(${sessionId}) called but no bridge is alive:`,
        cmd,
      );
      return;
    }
    await client.send(cmd);
  },

  patchRuntimeInfo: (patch) =>
    set((state) => ({ runtimeInfo: { ...state.runtimeInfo, ...patch } })),

  resetWarmup: () => set({ _warmupComplete: false }),

  seedCachedLLMs: (list) => {
    const current = list.find((l) => l.isCurrent);
    set({
      cachedLLMs: list,
      cachedLLMDisplayName: current?.displayName ?? "",
    });
  },
}));

/**
 * Convenience: read the currently active session's per-runtime entry.
 * Stable identity — Zustand returns the same reference until the
 * underlying byId map's keyed value changes.
 *
 * Reads `activeSessionId` from sessionsStore (M4b owner). Components
 * preferring slice subscribers should use
 * `useSessionsStore(s => s.activeSessionId)` + an explicit
 * `useRuntimeStore(...)` selector rather than calling this helper —
 * it's a getState-time read meant for non-render code paths.
 */
export function getActiveRuntime(): PerSessionRuntime | undefined {
  const activeId = useSessionsStore.getState().activeSessionId;
  if (!activeId) return undefined;
  return useRuntimeStore.getState().byId[activeId];
}

// ---- Cross-store helpers ----
//
// Read-only or single-direction-write reaches into prefsStore /
// sessionsStore. Per AD-09 slice DAG, runtimeStore is allowed to
// depend on prefsStore (leaf-like) and sessionsStore for these
// specific paths.

function readGAConfigFromPrefs() {
  // Function name avoids the `use*` prefix so eslint-plugin-react-hooks
  // doesn't classify it as a hook call inside non-component code.
  return usePrefsStore.getState().gaConfig;
}

async function mirrorSelectedLLMOnSession(sid: string, current: LLMOption) {
  // Route through sessionsStore.setSessionLlm which invokes the
  // Rust `set_session_llm` trait method. The store action mutates the
  // in-memory row + fires the invoke; we don't have to round-trip a
  // separate persistSession call.
  await useSessionsStore
    .getState()
    .setSessionLlm(sid, current.index, current.displayName);
}
