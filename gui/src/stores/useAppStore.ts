import { create } from "zustand";

import type { ApprovalConfig } from "@/components/screens/settings/Settings";
import {
  backfillFtsIfEmpty,
  deleteDemoSessions,
  deleteEmptyNewSessions,
  getPref,
  loadMessagesBySession,
  persistToolEventApprovalDecision,
  persistUserMessage,
  setPref,
} from "@/lib/db";
import { deriveSessionStatus } from "@/lib/sessions";
import { DEMO_APPROVAL_CONFIG, DEMO_GA_CONFIG } from "@/stores/demo";
import { useRuntimeStore } from "@/stores/runtime";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { makeAppError } from "@/types/app-error";
import type {
  AgentTurn,
  ConversationToolEvent,
  PendingApproval,
  PendingAskUser,
  SystemTurn,
  Turn,
  UserTurn,
} from "@/types/conversation";
import type { MessageRow } from "@/types/db";
import type { ApprovalDecision } from "@/types/ipc";


// LLMOption now lives in runtime.ts (M3a). Re-export here so existing
// imports (`import { LLMOption } from "@/stores/useAppStore"`) keep
// working during the transitional period; remove the re-export when
// no callers reference it via useAppStore (M3b / M4 cleanup grep).
import type { LLMOption } from "./runtime";
export type { LLMOption };

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
  inFlightContent: string;
  approvalDecisions: Record<string, ApprovalDecision>;
  // Bridge lifecycle fields (bridgeStatus / bridgeError / bridgePid)
  // moved to runtime.ts (M3b, 2026-05-19). LLM fields moved in M3a.
  // useAppStore._runtimes[sid] now holds only conversation-side state
  // that M5 messagesStore will eventually claim.
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
   *
   * Moved to runtimeStore.byId[sid] in M3a (2026-05-19). The fields
   * `llms` and `llmDisplayName` are gone from this interface — read
   * via `useRuntimeStore(s => s.byId[activeId]?.llms)` instead.
   */
  /**
   * GA-initiated question awaiting reply (V0.2 ask_user wiring).
   * Set when bridge emits an `ask_user` IPC event; cleared when
   * the user submits a reply (either by clicking a candidate chip
   * or by sending text through the Composer). Not persisted —
   * across app restarts, the conversation history still shows the
   * question text but `pendingAskUser` returns to null.
   */
  pendingAskUser: PendingAskUser | null;
  /**
   * Base offset added to every `turnIndex` from this session's
   * bridge (turn_end / turn_start / tool_call_*) before
   * persisting or rendering. Set by `appendUserTurn` to the
   * session's current turnCount.
   *
   * Why: GA's `agent_runner_loop` (agent_loop.py) declares
   * `turn = 0` locally and increments per LLM call within one
   * invocation. Each new `put_task(user_message)` starts a fresh
   * loop, so the very first turn of every user message arrives as
   * `turnIndex=1` — regardless of how many prior turns the
   * session has accumulated. Without the offset, two consecutive
   * user messages each produce an assistant row with the same
   * `msg_${sessionId}_1_assistant` primary key; the SQLite ON
   * CONFLICT UPDATE then silently overwrites the older one.
   * Restore reads back a single assistant covering both turns,
   * manifesting as "the conversation lost some replies and the
   * rest is out of order" — the dev-verify regression that
   * surfaced this bug.
   *
   * Offset = current turnCount means turn 1 of a new user_message
   * lands at `turnCount + 1`, which equals the user row's own
   * turn_index (also `turnCount + 1`) — pairing them correctly in
   * the (turn_index, sequence) ordering used by restore.
   */
  turnIndexOffset: number;
}

/**
 * deriveTitleFromText / truncateSummary / DEFAULT_NEW_SESSION_TITLE all
 * moved to gui/src/stores/sessions.ts (B3 M4b). The runtime / message
 * actions that still live in this file route through
 * `useSessionsStore.getState().maybeDeriveTitle(...)`.
 */

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
  // Per-message step recovery: AgentTurn.turnIndex is the GA-side
  // per-message step (1 for the first turn of each user message,
  // 2 for the second, etc) — that's what the user expects to see
  // in the "第 N 步" UI. SQLite however stores the **absolute**
  // session-wide turn_index to avoid primary-key collisions
  // between different user messages' assistant rows (see
  // turnIndexOffset rationale on SessionRuntime).
  //
  // To map back from absolute to per-message at restore, we walk
  // rows in (turn_index, sequence) order and track the latest
  // user row's turn_index as the base of the current user_message
  // "block". Each assistant row's display step is then
  // `absolute - base + 1`.
  let currentMessageBase = 0;
  for (const row of rows) {
    if (row.role === "user") {
      currentMessageBase = row.turn_index;
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
      const displayStep = currentMessageBase
        ? row.turn_index - currentMessageBase + 1
        : row.turn_index; // defensive: no preceding user row found
      // Normalize empty-string final_answer back to null (same as
      // ipc-handlers turnFromTurnEnd does for live events). Old rows
      // written before commit 1d0c404's fix may have stored "" for
      // tool-only intermediate turns; surfacing them as null here
      // keeps the Copy/Save actions from appearing under those turns.
      const finalAnswerRaw = row.final_answer ?? "";
      const finalAnswer = finalAnswerRaw.trim() ? finalAnswerRaw : null;
      const turn: AgentTurn = {
        role: "agent",
        thinking: row.thinking ?? undefined,
        // LLM "当前阶段：..." preamble (added in migration v5). Pre-
        // v5 rows have NULL — TurnMarker DetailPanel chevron stays
        // hidden when preamble is undefined and there's no
        // thinking either.
        preamble: row.preamble ?? undefined,
        tools,
        finalAnswer,
        turnIndex: displayStep,
        // GA turn summary (added in migration v3). Pre-v3 rows
        // have NULL — TurnMarker collapses to just "第 N 步"
        // when summary is undefined, which is the right behavior
        // for those rows since the data never existed on disk.
        summary: row.summary ?? undefined,
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
    inFlightContent: "",
    approvalDecisions: {},
    // bridgeStatus / bridgeError / bridgePid moved to runtimeStore in
    // M3b. llms / llmDisplayName moved in M3a. setActiveSession calls
    // useRuntimeStore.ensureRuntime to lazy-init the runtime store
    // entry — emptyRuntime here only carries messagesStore-bound
    // fields that M5 will own.
    pendingAskUser: null,
    turnIndexOffset: 0,
  };
}

interface State {
  // ---- Sessions / Projects ----
  // Moved to sessionsStore in M4b (2026-05-19). Read via:
  //   - useSessionsStore(s => s.sessions)
  //   - useSessionsStore(s => s.activeSessionId)
  //   - useSessionsStore(s => s.projects)
  //   - useSessionsStore(s => s.activeProjectFilter)
  //
  // llms / llmDisplayName / pendingLLMIndex / runtimeInfo all moved
  // to runtimeStore in M3a (2026-05-19). Read via:
  //   - useRuntimeStore(s => s.byId[activeId]?.llms ?? [])
  //   - useRuntimeStore(s => s.byId[activeId]?.llmDisplayName ?? "")
  //   - useRuntimeStore(s => s.pendingLLMIndex)
  //   - useRuntimeStore(s => s.runtimeInfo)

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
    /**
     * v0.1.1+: Galley ships its own Python interpreter at
     * `$RESOURCE/python/` (see scripts/bundle-python.sh + tauri.conf
     * bundle.resources). The default is to spawn that bundle. Flip
     * this to `true` from Settings → Runtime → advanced to fall back
     * to the user-configured `python` field — the escape hatch for
     * users with custom GA forks that need deps the bundle doesn't
     * carry, or for live-iterating on GA in a venv.
     */
    useExternalPython: boolean;
  };

  approvalConfig: ApprovalConfig;
  /**
   * YOLO mode (PRD §11.5). When true, every tool dispatch on every
   * alive bridge bypasses the approval gate. Persisted to prefs
   * (sticky across launches). Global, not per-session — flipping
   * this notifies every alive bridge.
   *
   * Default `true` for v0.1 — Galley's first-batch users are GA
   * heavy users who run agents without approval. The first-launch
   * `YoloIntroDialog` discloses this state and offers a one-click
   * revert to approval mode for those who want it.
   */
  yoloMode: boolean;
  /**
   * Has the user dismissed the first-launch YOLO disclosure modal?
   * Persisted to prefs (`yolo_intro_seen`). Initial state defaults
   * to `true` so the modal stays hidden during cold start; the
   * hydrate step flips it to `false` when the pref is missing,
   * which is the only case that should surface the modal. Set
   * back to `true` by either CTA on the modal.
   */
  yoloIntroSeen: boolean;
  /**
   * petAttachedSessionId moved to runtimeStore in M3a (2026-05-19).
   * Read via `useRuntimeStore(s => s.petAttachedSessionId)`.
   */
  /**
   * Conversation reading column width. Notion-style two-mode toggle
   * (DESIGN.md tbd):
   *   - "compact": 760px max-width — typographic sweet spot
   *     (~70-78 chars/line at 16.5px Newsreader), preserves the
   *     "document you're reading" feel that anchors the product
   *     register. The default on first launch.
   *   - "wide":   1400px max-width — for wide-monitor users who
   *     don't want most of the screen to be empty margin, and for
   *     sessions with lots of long code blocks / tool callouts /
   *     file_read outputs that get cramped at 760.
   *
   * Applies ONLY to the scrollable conversation column. The bottom
   * stack (ApprovalDock + Composer + hint) stays at 760 regardless
   * — the input zone is fixed-width so the textarea doesn't grow
   * into hard-to-track horizontal sweep when toggled wide.
   *
   * Global preference, not per-session: your monitor doesn't change
   * between sessions so your preference shouldn't either. Persisted
   * to prefs `conversation_width`.
   */
  conversationWidth: "compact" | "wide";

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
   * Global monotonic counter incremented every time the user submits
   * a message (via `appendUserTurn`) in ANY session. MainView's
   * stick-to-top scroll effect uses this as a trigger.
   *
   * Used to be per-session (lived on SessionRuntime); moved global so
   * switching sessions doesn't change the projection value and thus
   * doesn't misfire the scroll effect. The effect only ever cares
   * about "did the user just submit?" — there's no use case for
   * "remember per-session submit counts", so per-session storage was
   * an over-abstraction.
   */
  userSubmitTick: number;
  inFlightContent: string;
  /** Projection of `_runtimes[activeSessionId].pendingAskUser`. Reads
   * fine from any component that already subscribes to the top-level
   * fields; non-active sessions surface "yellow dot" via the
   * session.hasPendingAskUser mirror written by applyRuntimeUpdate. */
  pendingAskUser: PendingAskUser | null;
  /**
   * Per-app-instance flag: have we successfully fetched a fresh LLM
   * list from GA's mykey.py this session? Cold start hydrates
   * `state.llms` from a stale prefs cache, so if the user edited
   * mykey.py since the last bridge ready event, new models won't
   * appear in EmptyState's LLM picker until they activate an
   * existing session. `warmupLLMList` solves this by spawning a
   * _warmupComplete moved to runtimeStore (private) in M3a.
   * setGAConfig now calls `useRuntimeStore.getState().resetWarmup()`.
   */
  approvalDecisions: Record<string, ApprovalDecision>;
  // bridgeStatus / bridgeError / bridgePid moved to runtimeStore in M3b.
  // Read via useRuntimeStore(s => s.byId[activeId]?.bridge*).
}

interface Actions {
  // Sessions / Projects — all CRUD moved to sessionsStore in M4b.
  // Call via useSessionsStore.getState().<action>(...) or
  // useSessionsStore(s => s.<action>).
  //
  // The activateSession orchestrator stays here because it composes
  // sessionsStore.setActiveSession + restoreSessionTurns (which reads
  // _runtimes still owned here) + runtimeStore.spawnBridge.
  activateSession: (id: string) => Promise<void>;
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
   * Dismiss the first-launch YOLO disclosure modal. Optionally
   * reverts YOLO to off (when the user picked "改回审批模式" rather
   * than "知道了"). Persists `yolo_intro_seen=true` so the modal
   * never resurfaces on this device.
   */
  acknowledgeYoloIntro: (revertToApproval?: boolean) => Promise<void>;
  /**
   * Toggle / set the conversation column width mode. Persists to
   * prefs (`conversation_width`) so the choice survives restart.
   * The TopBar icon button calls this with the opposite of the
   * current mode; other callers (Settings, palette commands) can
   * set explicitly.
   */
  setConversationWidth: (mode: "compact" | "wide") => Promise<void>;
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
    partial: Partial<{
      python: string;
      gaPath: string;
      bridgeCwd: string;
      useExternalPython: boolean;
    }>,
  ) => Promise<void>;

  /**
   * One-shot LLM list refresh on app launch (and after gaConfig
   * changes). Spawns a temporary bridge with sessionId="__warmup__",
   * captures its `ready` event's `availableLLMs`, writes them into
   * top-level `state.llms` + `prefs["llm_list"]` cache, then shuts
  /**
   * LLM-related actions (warmupLLMList / replaceLLMs /
   * selectLLMForNewSession) moved to runtimeStore in M3a. Call via:
   *   useRuntimeStore.getState().warmupLLMList()
   *   useRuntimeStore.getState().replaceLLMs(sid, list)
   *   useRuntimeStore.getState().selectLLMForNewSession(index)
   */

  // Conversation (per-session — sessionId required)
  appendUserTurn: (sessionId: string, text: string) => void;
  /**
   * Append a user turn that was persisted out-of-band by Rust core
   * (`socket_listener::dispatch_session_send`). Skips the SQLite write
   * that `appendUserTurn` does because the row is already in DB.
   * Triggered by the `user-message-persisted` Tauri event whenever CLI
   * / supervisor agents call `galley session send`.
   *
   * Otherwise identical to `appendUserTurn`: appends a UserTurn, sets
   * `agentRunning=true` (the bridge has been dispatched), bumps
   * `userSubmitTick` so the conversation scrolls to the new message,
   * derives the sidebar title on first message.
   */
  appendUserTurnExternal: (sessionId: string, text: string) => void;
  /**
   * Append a transient user message for `/btw` side questions.
   * Distinct from `appendUserTurn`:
   *   - Doesn't touch agentRunning / inFlightContent /
   *     currentTurnIndex / pendingAskUser — /btw runs in its own
   *     bridge worker; main agent state is untouched
   *   - Doesn't derive sidebar title (/btw isn't a "topic")
   *   - Doesn't persist to SQLite (ephemeral by design)
   * Still bumps `userSubmitTick` so the scroll-to-bottom-anchor
   * effect fires — user wants to see their question appear.
   */
  appendSideQuestionUserTurn: (sessionId: string, text: string) => void;
  appendAgentTurn: (sessionId: string, turn: AgentTurn) => void;
  /**
   * Append a non-agent-loop system message (currently from /btw
   * side-question replies; future: /session.x=v confirmations).
   * Distinct from `appendAgentTurn`:
   *   - Doesn't carry tool calls or turn index
   *   - Doesn't affect agentRunning / currentTurnIndex
   *   - Renders with a callout chrome rather than the bare prose
   *     of an agent final answer
   * Transient — no SQLite write for V0.1. See implementation.
   */
  appendSystemTurn: (sessionId: string, turn: SystemTurn) => void;
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
  /**
   * Set / clear the GA-side pending question for a session. `null`
   * clears (typically after the user submits a reply). Also lights
   * up the Sidebar yellow "⏸ 等你回复" indicator via the session row
   * mirror written in applyRuntimeUpdate.
   */
  setPendingAskUser: (sessionId: string, value: PendingAskUser | null) => void;
  /**
   * setPetAttachedSession moved to runtimeStore in M3a. Call via
   * `useRuntimeStore.getState().setPetAttachedSession(sid)`.
   */

  // Bridge runtime actions (setBridgeStatus / spawnBridge / shutdownBridge
  // / shutdownAllBridges / sendIPCCommand) all moved to runtimeStore in
  // M3b. Call via `useRuntimeStore.getState().<action>(...)`.

  // Persistence
  hydrateFromDB: () => Promise<void>;

  /**
   * DEV-only: seed a batch of mock sessions across all sidebar
   * buckets (pinned / today / week / earlier) so the developer can
   * dogfood the Earlier-fold + Pin/Unpin flow without waiting for
   * real sessions to age. Each mock session is persisted to SQLite
   * with id prefix `mock-` so it survives reload; calling repeatedly
   * appends fresh batches (does not de-duplicate).
   */
  seedMockSessions: () => Promise<void>;
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
  // Top-level projection: only when this session is the active one.
  // activeSessionId now lives in sessionsStore (M4b); read at call time.
  const activeSessionId = useSessionsStore.getState().activeSessionId;
  if (sessionId === activeSessionId) {
    Object.assign(out, projectionFrom(newRt));
  }
  // Sidebar-visible fields derived from runtime — mirror to the
  // session row via sessionsStore. Cross-store write here is the
  // M4b transitional pattern: useAppStore owns `_runtimes` (until
  // M5), sessionsStore owns `sessions`. After M5 messagesStore +
  // Rust event driving, this entry point goes away.
  const sessionsState = useSessionsStore.getState();
  const session = sessionsState.sessions.find((s) => s.id === sessionId);
  if (session) {
    const bridgeStatus =
      useRuntimeStore.getState().byId[sessionId]?.bridgeStatus;
    const newStatus = deriveSessionStatus(session, newRt, bridgeStatus);
    sessionsState.applyDerivedFromRuntime(sessionId, {
      status: newStatus,
      pendingApprovalCount: newRt.pendingApprovals.length,
      hasPendingAskUser: newRt.pendingAskUser !== null,
    });
  }
  return out;
}

/**
 * Pure mapping from a SessionRuntime to the State projection fields.
 * Used by activateSession's top-level mirror refresh + applyRuntimeUpdate
 * to keep the top-level fields in sync with `_runtimes[activeSessionId]`.
 */
function projectionFrom(rt: SessionRuntime): {
  turns: Turn[];
  pendingApprovals: PendingApproval[];
  agentRunning: boolean;
  currentTurnIndex: number | null;
  inFlightContent: string;
  approvalDecisions: Record<string, ApprovalDecision>;
  pendingAskUser: PendingAskUser | null;
} {
  return {
    turns: rt.turns,
    pendingApprovals: rt.pendingApprovals,
    agentRunning: rt.agentRunning,
    currentTurnIndex: rt.currentTurnIndex,
    inFlightContent: rt.inFlightContent,
    approvalDecisions: rt.approvalDecisions,
    pendingAskUser: rt.pendingAskUser,
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

// Mock session fixtures + buildMockSessions moved to sessions.ts in
// M4b (2026-05-19). seedMockSessions now lives there too.

export const useAppStore = create<AppStore>((set, get) => ({
  // ---- Initial state (demo fixtures) ----
  gaConfig: DEMO_GA_CONFIG,
  approvalConfig: DEMO_APPROVAL_CONFIG,
  yoloMode: true,
  yoloIntroSeen: true,
  conversationWidth: "compact",

  _runtimes: {},

  // Global counter, not projected from any runtime — see State's
  // userSubmitTick doc comment.
  userSubmitTick: 0,

  // Top-level projection starts as the empty runtime (no active
  // session yet). sessionsStore.setActiveSession refreshes these
  // through activateSession's projection refresh below.
  ...projectionFrom(emptyRuntime()),

  // ---- Sessions actions ----
  //
  // CRUD (setActive / create / archive / unarchive / rename / pin /
  // delete / bulk / project ops) all moved to sessionsStore in M4b.
  // What remains here:
  //   - activateSession orchestrator — composes sessionsStore
  //     setActive + restoreSessionTurns + runtimeStore.spawnBridge
  //   - restoreSessionTurns — touches _runtimes[sid].turns (M5)
  //
  // The orchestrator stays out of sessionsStore so the cross-store
  // coordination is visible (it touches all three slices). After M5
  // and the runtime → Rust event refactor this entire function moves
  // to sessionsStore.

  activateSession: async (id) => {
    // Step 1: refresh the active session pointer (clears unread on
    // the row via Rust + sets sessionsStore.activeSessionId).
    useSessionsStore.getState().setActiveSession(id);
    // Step 2: lazy-init the runtime entry — LLM seed comes from the
    // session row's persisted choice + cross-session cache.
    const session = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === id);
    const runtimeStore = useRuntimeStore.getState();
    runtimeStore.ensureRuntime(id, {
      persistedIndex: session?.selectedLlmIndex,
      persistedDisplayName: session?.selectedLlmDisplayName,
      cachedLLMs: runtimeStore.cachedLLMs,
      cachedDisplayName: runtimeStore.cachedLLMDisplayName,
    });
    // Step 3: lazy-init _runtimes[id] + refresh top-level projection.
    set((state) => {
      const existing = state._runtimes[id];
      if (existing) {
        return projectionFrom(existing);
      }
      const rt = emptyRuntime();
      return {
        _runtimes: { ...state._runtimes, [id]: rt },
        ...projectionFrom(rt),
      };
    });
    // Step 4: restore conversation turns from SQLite on first touch
    // in this app instance. `_runtimes[id].turns.length === 0` is a
    // safe proxy for "fresh runtime" — once IPC starts streaming,
    // even an empty SQLite history won't keep turns at zero.
    const rt = get()._runtimes[id];
    const looksFresh = !rt || rt.turns.length === 0;
    const hasHistory = (session?.turnCount ?? 0) > 0;
    if (looksFresh && hasHistory) {
      try {
        await get().restoreSessionTurns(id);
      } catch (e) {
        console.warn("[store] activateSession restoreSessionTurns failed.", e);
      }
    }
    // Step 5: auto-spawn the bridge when this session has no live
    // one. Re-spawn on `closed` / `error` lets a kill or crash
    // recover by simply re-clicking the session. `closed` is also
    // how the LRU governor signals "suspended" — re-activation
    // regenerates the bridge and the IPC `ready` handler replays
    // SQLite history.
    const bridgeStatus =
      useRuntimeStore.getState().byId[id]?.bridgeStatus ?? "idle";
    const needsSpawn =
      bridgeStatus === "idle" ||
      bridgeStatus === "closed" ||
      bridgeStatus === "error";
    if (needsSpawn) {
      // Project = pure grouping. We deliberately do NOT inject the
      // project's rootPath as the bridge cwd here — doing so would
      // chdir away from the GA install dir and silently break GA's
      // relative `./memory/...` reads (memory_management_sop, any
      // user SOP, etc.). See devlog 2026-05-14 rootPath rollback.
      //
      // EmptyState's inline LLM picker stashes `pendingLLMIndex`
      // because there was no live bridge to set_llm against. Apply
      // it here as `--llm-no` only when the session is genuinely
      // fresh — re-activating an existing session must respect that
      // session's own `set_llm` history. Always clear pending after
      // this activation so an abandoned pick (user picked LLM,
      // then clicked an existing session) doesn't leak into a later
      // unrelated spawn.
      const runtimeStoreSnap = useRuntimeStore.getState();
      const pendingLLMIndex = runtimeStoreSnap.pendingLLMIndex;
      const rtNow = get()._runtimes[id];
      const isFreshSession =
        (session?.turnCount ?? 0) === 0 &&
        (!rtNow || rtNow.turns.length === 0);
      const consumePending =
        isFreshSession && pendingLLMIndex !== undefined;
      if (pendingLLMIndex !== undefined) {
        useRuntimeStore.setState({ pendingLLMIndex: undefined });
      }
      // Restore the persisted LLM choice on respawn of an existing
      // session. Without this `set_llm` is in-memory only — bridge
      // exits, mykey.py default takes over on next spawn. Pending
      // pick (Empty State LLM picker) wins when present because the
      // user just made a fresh choice that hasn't reached SQLite yet.
      const restoredLlmIndex =
        !consumePending && !isFreshSession
          ? session?.selectedLlmIndex
          : undefined;
      await useRuntimeStore.getState().spawnBridge({
        ...get().gaConfig,
        sessionId: id,
        cwd: undefined,
        llmIndex: consumePending ? pendingLLMIndex : restoredLlmIndex,
      });
    }
    // Already alive — runtimeStore.spawnBridge internally LRU-touches
    // on each call, so the alive-bridge branch is now a no-op here.
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
    // Iterate runtimeStore entries that look connected; sendIPCCommand
    // internally no-ops if the slot's bridge isn't actually alive.
    const runtimeSlots = useRuntimeStore.getState().byId;
    for (const sid of Object.keys(runtimeSlots)) {
      try {
        await useRuntimeStore
          .getState()
          .sendIPCCommand(sid, { kind: "set_yolo_mode", enabled });
      } catch (e) {
        console.warn(`[store] setYoloMode: bridge ${sid} notify failed.`, e);
      }
    }
  },

  acknowledgeYoloIntro: async (revertToApproval = false) => {
    // Order matters: flip YOLO before marking the modal seen so
    // bridges receive the new state alongside the prefs write.
    if (revertToApproval) {
      await useAppStore.getState().setYoloMode(false);
    }
    set({ yoloIntroSeen: true });
    try {
      await setPref("yolo_intro_seen", true);
    } catch (e) {
      console.warn(
        "[store] acknowledgeYoloIntro: pref persistence failed.",
        e,
      );
    }
  },

  setConversationWidth: async (mode) => {
    set({ conversationWidth: mode });
    try {
      await setPref("conversation_width", mode);
    } catch (e) {
      console.warn("[store] setConversationWidth: pref persistence failed.", e);
    }
  },

  setGAConfig: async (partial) => {
    const merged = { ...get().gaConfig, ...partial };
    // Translate the python alias (Tauri shell-capability `name` like
    // "python-framework-3-14") to its resolved display path for the
    // Settings → Runtime "Python" field. Falls back to the raw alias
    // for unknown values so Settings never shows an empty field.
    const { findCandidateByAlias } = await import("@/lib/python-probe");
    const displayCandidate = await findCandidateByAlias(merged.python);
    const pythonDisplay = displayCandidate?.displayPath ?? merged.python;
    set({ gaConfig: merged });
    // Reflect into runtimeInfo (now lives in runtimeStore) so the
    // Settings → Runtime tab and Inspector → Runtime card show the
    // new path immediately. pythonVersion is intentionally repurposed
    // to display the resolved interpreter path — users see where the
    // bridge will spawn from, not the internal capability alias.
    useRuntimeStore.getState().patchRuntimeInfo({
      gaPath: merged.gaPath,
      pythonVersion: pythonDisplay,
    });
    // Reset the warmup flag so a new gaPath (or python interpreter)
    // re-triggers a one-shot LLM list refresh against the new
    // mykey.py. TRANSITIONAL (M6 prefsStore): when gaConfig moves to
    // prefsStore, this becomes runtimeStore's listener on a
    // prefs-updated event.
    useRuntimeStore.getState().resetWarmup();
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
      useUiStore.getState().pushToast(
        makeAppError({
          category: "business",
          severity: "info",
          title: "已保存路径配置",
          message: "重启 Galley 才能让现有对话生效",
          hint: null,
          retryable: false,
          context: "setGAConfig",
          traceback: null,
        }),
      );
      // Retrigger warmup with the new gaConfig so the LLM picker
      // reflects mykey.py from the new GA install without requiring
      // a Workbench restart. (Existing sessions still need a restart
      // — their bridges are already running.)
      void useRuntimeStore.getState().warmupLLMList();
    }
  },

  // ---- LLMs (DELETED M3a — replaceLLMs / selectLLMForNewSession /
  // warmupLLMList all moved to runtime.ts) ----

  // ---- Conversation (per-session) ----
  appendUserTurn: (sessionId, text) => {
    // Snapshot turnCount before any state mutation; this is the
    // offset that should map GA's 1-based per-loop turn indices
    // onto absolute session-wide indices. See SessionRuntime
    // doc comment for the full rationale.
    const sessionsState = useSessionsStore.getState();
    const currentTurnCount =
      sessionsState.sessions.find((s) => s.id === sessionId)?.turnCount ?? 0;
    set((state) => {
      const update = applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, { role: "user", content: text } as UserTurn],
        // The agent will start running on the bridge shortly. Set
        // synchronously rather than wait for `turn_start` over IPC —
        // the round-trip would re-introduce the latency we're
        // masking with the thinking placeholder.
        agentRunning: true,
        // Wipe leftover streaming buffer from a previous turn.
        inFlightContent: "",
        // Reset currentTurnIndex so the Sidebar's "正在工作 · 第 N 步"
        // doesn't briefly show the last turn's step number before
        // the new agent_runner_loop's turn_start arrives. New
        // message = new loop = step counter restarts at 1.
        currentTurnIndex: null,
        // Any GA-initiated ask_user is by definition answered by
        // this submission — clear the bubble + yellow sidebar dot
        // so the conversation reverts to normal running visuals.
        pendingAskUser: null,
        // Anchor the offset for the upcoming agent_runner_loop's
        // turn indices. GA will emit turn_end with turnIndex=1,2,3
        // for this user_message; we add this offset to get absolute
        // session-wide turn indices used by SQLite and the UI.
        turnIndexOffset: currentTurnCount,
      }));
      // Bump the global submit tick (top-level, not on the runtime)
      // so MainView's stick-to-top scroll fires. Lives at top-level
      // because session switching shouldn't trigger this effect —
      // see `userSubmitTick` doc comment in State.
      update.userSubmitTick = state.userSubmitTick + 1;
      return update;
    });
    // Derive a Sidebar title from the first user message — but only
    // once, and only when the row is still wearing the seed "新对话"
    // placeholder. sessionsStore handles the trim / fallback / Rust
    // persist; this call is a no-op when the title has been edited.
    useSessionsStore.getState().maybeDeriveTitle(sessionId, text);
    // Persist the user message to SQLite for Session Restore. turnIndex
    // is derived as `turnCount + 1` because GA hasn't emitted turn_start
    // yet — that event arrives after the bridge starts processing
    // user_message and confirms our local guess. The pairing holds
    // because GA always assigns one turn per user message.
    const nextTurnIndex = currentTurnCount + 1;
    void persistUserMessage({
      sessionId,
      turnIndex: nextTurnIndex,
      content: text,
    }).catch((e) => {
      console.debug("[store] appendUserTurn persistUserMessage failed.", e);
    });
  },

  appendUserTurnExternal: (sessionId, text) => {
    // Mirror of appendUserTurn — see that action's comments for rationale
    // on each field. Difference: skips `persistUserMessage` because Rust
    // already wrote the row before emitting `user-message-persisted`.
    const currentTurnCount =
      useSessionsStore.getState().sessions.find((s) => s.id === sessionId)
        ?.turnCount ?? 0;
    set((state) => {
      const update = applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, { role: "user", content: text } as UserTurn],
        agentRunning: true,
        inFlightContent: "",
        currentTurnIndex: null,
        pendingAskUser: null,
        turnIndexOffset: currentTurnCount,
      }));
      update.userSubmitTick = state.userSubmitTick + 1;
      return update;
    });
    useSessionsStore.getState().maybeDeriveTitle(sessionId, text);
  },

  appendAgentTurn: (sessionId, turn) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, turn],
        // turn_end is per-step inside GA's agent_runner_loop, NOT the
        // terminal signal — a single user message can produce 20+
        // turn_end events before the run actually exits. Keep
        // agentRunning true so the sidebar stays on "正在工作 · 第 N
        // 步" and the main view keeps showing the thinking placeholder
        // / streaming partial across step boundaries. Only
        // `run_complete` / `error` / bridge `onClose` flip it false.
        // currentTurnIndex clears so the brief gap between this
        // turn_end and the next turn_start renders as generic
        // "正在工作…" / "思考中…" instead of stale "第 N 步".
        currentTurnIndex: null,
        // Finalised turn replaces the streaming buffer.
        inFlightContent: "",
      })),
    ),

  appendSystemTurn: (sessionId, turn) =>
    // Transient append — no DB persistence for V0.1. The /btw side
    // question + reply are ephemeral by design ("不打断主任务" 已经
    // 暗示了"不进入主线"). On session reopen the /btw exchange is
    // gone from view — consistent with the "side, not main" mental
    // model. If users complain in dogfood we promote to persisted
    // (messages.role='system' rows + rowsToTurns handling).
    //
    // Also intentionally NOT touching agentRunning / currentTurnIndex
    // — /btw runs in its own worker, doesn't drive the main agent's
    // running state.
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, turn],
      })),
    ),

  appendSideQuestionUserTurn: (sessionId, text) => {
    set((state) => {
      const update = applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        turns: [...rt.turns, { role: "user", content: text } as UserTurn],
        // Deliberately NOT touching agentRunning / inFlightContent /
        // currentTurnIndex / pendingAskUser — /btw is a side worker
        // path that doesn't interfere with the main agent loop.
      }));
      update.userSubmitTick = state.userSubmitTick + 1;
      return update;
    });
  },

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

  setPendingAskUser: (sessionId, value) =>
    set((state) =>
      applyRuntimeUpdate(state, sessionId, (rt) => ({
        ...rt,
        pendingAskUser: value,
      })),
    ),

  // setPetAttachedSession moved to runtime.ts (M3a, 2026-05-19).


  // ---- Persistence ----
  //
  // Called once at app mount. Loads sessions from SQLite; if the DB
  // is empty, seeds the demo fixtures into it so the dev build has
  // something to render. Falls back silently to the demo seed in
  // initial state if SQLite isn't available (Vite-only dev / first
  // launch before tauri-plugin-sql finishes init).
  hydrateFromDB: async () => {
    // Replace the demo fixture's hardcoded workbenchVersion ("0.1.0",
    // a lie since alpha.1) with the real value baked into tauri.conf.json
    // at build time. Tauri's getVersion() returns the same string the
    // bundler stamped into the .app, so Settings → About always matches
    // the installed release. Failing fetch keeps the demo value — not
    // worth blocking hydration on this.
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      const realVersion = await getVersion();
      useRuntimeStore
        .getState()
        .patchRuntimeInfo({ workbenchVersion: realVersion });
    } catch (e) {
      console.debug("[store] hydrateFromDB: app.getVersion failed.", e);
    }
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
      // B3 M4b: sessions + projects hydrate moved to sessionsStore.
      // The slice talks to Rust core (`list_sessions` / `list_projects`
      // Tauri commands) directly; useAppStore just kicks off the load
      // so the in-memory state is ready by the time the sidebar
      // renders.
      await useSessionsStore.getState().hydrate();
      // One-time backfill of the FTS index for users upgrading
      // past the 004 migration. Idempotent — returns immediately
      // when the index is already in sync.
      try {
        const indexed = await backfillFtsIfEmpty();
        if (indexed > 0) {
          console.info(
            `[store] hydrateFromDB: backfilled ${indexed} message(s) into messages_fts.`,
          );
        }
      } catch (e) {
        console.debug("[store] hydrateFromDB: backfillFtsIfEmpty failed.", e);
      }
    } catch (e) {
      // Non-Tauri context (Vite dev) or migration not yet applied.
      console.warn(
        "[store] hydrateFromDB: SQLite unavailable, using demo seed.",
        e,
      );
    }
    // YOLO mode (PRD §11.5) — sticky preference. Best-effort load.
    // Initial state defaults to `true` (Galley first-launch behavior
    // for GA heavy users); we honor any explicit boolean from prefs.
    // We don't call setYoloMode() here so as not to double-persist
    // on startup or attempt to notify a bridge that doesn't exist
    // yet — the on-`ready` IPC handler does that sync when a bridge
    // does spawn.
    let userHasYoloPref = false;
    try {
      const yolo = await getPref<boolean>("yolo_mode");
      if (typeof yolo === "boolean") {
        set({ yoloMode: yolo });
        userHasYoloPref = true;
      }
    } catch (e) {
      console.warn("[store] hydrateFromDB: yolo pref load failed.", e);
    }
    // YOLO intro modal — surfaces once for true-new users to disclose
    // that YOLO is the default. Initial state is `true` (hidden) so
    // the modal doesn't flash during cold start; only flip to `false`
    // when both prefs say "user has never expressed a YOLO opinion on
    // this device". Existing dogfood users who already toggled YOLO
    // (pref present) skip the dialog — their preference is settled,
    // the disclosure would be confusing.
    if (!userHasYoloPref) {
      try {
        const seen = await getPref<boolean>("yolo_intro_seen");
        if (seen !== true) set({ yoloIntroSeen: false });
      } catch (e) {
        console.warn(
          "[store] hydrateFromDB: yolo_intro_seen pref load failed.",
          e,
        );
      }
    }
    try {
      const width = await getPref<"compact" | "wide">("conversation_width");
      // Defensive: only honor known values, fall back to the
      // "compact" default for anything else (corrupt prefs / older
      // schema / future "fluid" mode that this build doesn't know).
      if (width === "wide" || width === "compact") {
        set({ conversationWidth: width });
      }
    } catch (e) {
      console.warn("[store] hydrateFromDB: conversation_width pref load failed.", e);
    }
    // Restore cached LLM list (written by replaceLLMs whenever a
    // bridge's `ready` event arrives). Lets cold-start cosmetics
    // — Composer's LLM picker dropdown, the model pill — show
    // the user's real GA-configured models instead of DEMO_LLMS
    // before any bridge has spawned in this session.
    try {
      const cachedLLMs = await getPref<LLMOption[]>("llm_list");
      if (cachedLLMs && cachedLLMs.length > 0) {
        useRuntimeStore.getState().seedCachedLLMs(cachedLLMs);
      }
    } catch (e) {
      console.warn("[store] hydrateFromDB: llm_list pref load failed.", e);
    }
    // GA spawn config (Stage 3 Task 4). When `ga_config` pref is
    // absent the user is fresh-from-install: route them to Onboarding
    // so they can pick a GA path + run health checks (which probe for
    // a Python interpreter that has GA's deps installed — see
    // lib/python-probe.ts for why this matters in packaged builds).
    let hasGAConfig = false;
    try {
      const saved = await getPref<{
        python: string;
        gaPath: string;
        bridgeCwd: string;
        useExternalPython?: boolean;
      }>("ga_config");
      if (saved && saved.gaPath) {
        hasGAConfig = true;
        // Translate alias → display path for the Settings field, same
        // as setGAConfig. See its comment for the rationale.
        const { findCandidateByAlias } = await import(
          "@/lib/python-probe"
        );
        const displayCandidate = await findCandidateByAlias(saved.python);
        const pythonDisplay = displayCandidate?.displayPath ?? saved.python;
        // Migrate legacy alpha.2 configs (no useExternalPython field).
        // Default to false so upgrading users automatically pick up
        // the bundled Python — they keep their old `python` alias on
        // file as the escape hatch if anything goes sideways. Same
        // default as DEMO_GA_CONFIG for fresh installs.
        const migrated = {
          ...saved,
          useExternalPython: saved.useExternalPython ?? false,
        };
        set({ gaConfig: migrated });
        useRuntimeStore.getState().patchRuntimeInfo({
          gaPath: saved.gaPath,
          pythonVersion: pythonDisplay,
        });
      }
    } catch (e) {
      console.warn("[store] hydrateFromDB: ga_config pref load failed.", e);
    }
    if (!hasGAConfig) {
      // First launch — surface Onboarding. Skip the LLM warmup below:
      // bridge spawn with the demo path would either succeed by
      // accident (if the demo path happens to point at a real GA on
      // this machine — dogfood case) or fail silently because the
      // packaged-build `python3` PATH has no anthropic. Either way the
      // user hasn't picked their real config yet, so warmup is noise.
      useUiStore.getState().setScreen("onboarding");
      return;
    }

    // After hydrate completes (sessions / projects / prefs all loaded
    // and gaConfig finalized), kick off a warmup bridge to refresh
    // the LLM list from mykey.py. The prefs cache loaded above is
    // stale if the user edited mykey.py since the last bridge ready
    // event; warmup ensures EmptyState shows the current list before
    // the user clicks the LLM picker. Fire-and-forget — warmup runs
    // in the background and doesn't block hydrate completion.
    void useRuntimeStore.getState().warmupLLMList();
  },

  seedMockSessions: async () => {
    // Forwarded to sessionsStore — fixtures + persistence both live
    // there now. Kept as a top-level action so existing dev shortcuts
    // (`__store.getState().seedMockSessions()` in DevTools) keep
    // working without a doc update.
    await useSessionsStore.getState().seedMockSessions();
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
