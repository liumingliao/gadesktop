import { create } from "zustand";

import type { ApprovalConfig } from "@/components/screens/settings/Settings";
import {
  type BridgeClient,
  type BridgeSpawnArgs,
  spawnBridge as spawnBridgeProcess,
} from "@/lib/bridge";
import {
  backfillFtsIfEmpty,
  deleteDemoSessions,
  deleteEmptyNewSessions,
  deleteProject as deleteProjectFromDB,
  deleteSession as deleteSessionFromDB,
  getPref,
  loadMessagesBySession,
  loadProjects,
  loadSessions,
  persistProject,
  persistSession,
  persistToolEventApprovalDecision,
  persistUserMessage,
  setPref,
} from "@/lib/db";
import { dispatchIPCEvent } from "@/lib/ipc-handlers";
import { deriveSessionStatus } from "@/lib/sessions";
import {
  DEMO_APPROVAL_CONFIG,
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
  PendingAskUser,
  SystemTurn,
  Turn,
  UserTurn,
} from "@/types/conversation";
import type { MessageRow } from "@/types/db";
import type { RuntimeInfo } from "@/types/inspector";
import type { ApprovalDecision, IPCCommand } from "@/types/ipc";
import type { Project, Session } from "@/types/session";

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

/**
 * Per-session rolling buffer of the last few stderr lines. Used to
 * surface "bridge died with this Python error" toasts on abnormal
 * exit — without this, an ImportError on the bridge side just makes
 * messages silently disappear (the prod-build failure mode we hit
 * 2026-05-15 on first .dmg dogfood). Kept as a module-level Map (not
 * Zustand state) because it's pure ephemeral diagnostic data — no
 * rendering reacts to it. */
const _stderrTails = new Map<string, string[]>();
const _STDERR_TAIL_MAX = 8;

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
    bridgeStatus: "idle",
    bridgeError: null,
    bridgePid: null,
    llms: DEMO_LLMS,
    llmDisplayName: DEMO_LLM_DISPLAY_NAME,
    pendingAskUser: null,
    turnIndexOffset: 0,
  };
}

interface State {
  // ---- UI ----
  screen: Screen;
  paletteOpen: boolean;
  settingsOpen: boolean;

  // ---- Sessions ----
  sessions: Session[];
  activeSessionId: string | undefined;
  /**
   * Projects: user-defined drawers for grouping sessions. Pure 归类 —
   * no cwd binding (the rootPath field is preserved on the DB row for
   * possible future live-sync IPC, but is no longer injected into the
   * bridge spawn; see devlog 2026-05-14). Hydrated from SQLite once
   * on startup; mutations persist via best-effort writes (same pattern
   * as sessions). Per PRD §7.3, Projects never alter GA's behavior.
   */
  projects: Project[];
  /**
   * When set, the Sidebar filters to show only sessions assigned to
   * this project (plus the "Showing: ProjectName ×" banner). Not
   * persisted across launches — fresh start = global view, fewer
   * "where did my recents go?" moments.
   */
  activeProjectFilter: string | undefined;
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
  /**
   * One-shot LLM index to apply when the *next* freshly-created
   * session spawns its bridge. Set by EmptyState's inline LLM picker
   * (no active session yet, so there's no live bridge to `set_llm`
   * against). Consumed by `activateSession` when it spawns a bridge
   * for a session with zero turns; cleared on any activateSession
   * call so the pick doesn't leak into a later, unrelated session.
   *
   * Not persisted — a fresh launch should fall back to GA's mykey.py
   * default until the user picks again.
   */
  pendingLLMIndex: number | undefined;
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
   * Desktop Pet attached session id. Pet is a global feature (only
   * one instance can run at a time since it binds a fixed local
   * port), so we store one session id at the top level rather than
   * on a per-session runtime. `null` when no pet is attached.
   *
   * Surfaced in two places:
   *   - Sidebar session row: a small Cat badge appears next to the
   *     title of whichever session currently holds the pet, so the
   *     user can see "where the pet is" from any view.
   *   - SessionTitleMenu: when the active session === this id, the
   *     menu item label flips to "关闭桌面宠物"; otherwise it stays
   *     "桌面宠物" and a click implicitly migrates the pet to the
   *     active session (see pendingPetMigrationTo for the relay).
   *
   * Not persisted: pet's subprocess dies on app exit anyway, so
   * "remember it across restart" would lie about state.
   */
  petAttachedSessionId: string | null;
  /**
   * Implicit-migration target: when the user clicks "桌面宠物" in a
   * session that doesn't currently hold the pet, we send detach_pet
   * to the holder and stash the target here. The pet_detached IPC
   * handler relays an attach_pet to this target once the old pet's
   * port is released. Cleared in both pet_attached and pet_detached
   * handlers so a stale value can't trigger spurious attaches.
   */
  pendingPetMigrationTo: string | null;
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
   * one-shot "warmup" bridge after hydrate. This flag prevents
   * re-running the warmup on every app render. Reset to false by
   * `setGAConfig` so a path change retriggers the warmup.
   */
  _warmupComplete: boolean;
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
  /** Create a session row + activate it. Optional `projectId` ties
   * the session to a project at birth — used when "+ New Chat" fires
   * while the sidebar is in project-filter mode, so the new chat
   * inherits the same drawer (and, in Phase 4, the project's cwd). */
  createSession: (projectId?: string) => string;
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
   *
   * `stepNumber` is the per-message step the user sees ("第 N 步").
   * Comes straight from `event.turnIndex` (GA-native, resets per
   * user message). Distinct from the session's absolute turnCount
   * (which keeps growing forever, used internally as the
   * turnIndexOffset source).
   */
  bumpSessionAfterTurn: (
    sessionId: string,
    summary?: string,
    stepNumber?: number,
  ) => void;
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
   * Rename a session's title (user-facing label in the sidebar /
   * TopBar). Trims input + falls back to the default placeholder on
   * empty. Persists best-effort to SQLite.
   *
   * Interaction with first-message auto-derivation: `appendUserTurn`
   * only auto-derives the title when it's still equal to
   * DEFAULT_NEW_SESSION_TITLE. Once the user manually sets ANY other
   * title (including their own choice), auto-derive stops touching
   * the row — manual rename wins. No extra "manually-named" flag is
   * needed.
   */
  renameSession: (sessionId: string, newTitle: string) => void;
  /**
   * Toggle the `pinned` flag on a session. Pinned sessions move to
   * the Sidebar's Pinned bucket regardless of date — the user's
   * escape valve for "this isn't recent but I still need it visible".
   * Persisted to SQLite (column `pinned`) so the pin survives
   * restart. No-op for archived sessions (they're not in the
   * bucketed list anyway).
   */
  togglePinSession: (sessionId: string) => void;
  /**
   * Permanently delete an archived session. Cascades to its
   * `messages` and `tool_events` rows via the SQLite FK ON DELETE
   * CASCADE clause (001_init.sql). Destructive — UI must confirm
   * before invoking.
   *
   * If the deleted session is somehow still active (shouldn't be —
   * archive flow already cleared activeSessionId), the projection
   * resets to the empty runtime. Also shuts down any leftover
   * alive bridge for the session id (very rare; defensive).
   */
  deleteSessionPermanently: (sessionId: string) => Promise<void>;
  /**
   * Bulk variants for multi-select operations in EarlierDialog and
   * ArchivedDialog. Each batches the in-memory state update into a
   * single `set(...)` call so a 50-row archive doesn't trigger 50
   * cascading re-renders, and dispatches all SQLite writes in
   * parallel (the connection is async but cheap; serialization
   * isn't needed). Single-row paths above stay untouched — they
   * carry richer side-effects like the post-archive toast that
   * doesn't translate cleanly to bulk.
   */
  archiveSessionsBulk: (sessionIds: string[]) => void;
  unarchiveSessionsBulk: (sessionIds: string[]) => void;
  deleteSessionsPermanentlyBulk: (sessionIds: string[]) => Promise<void>;

  // ---- Projects ----
  /**
   * Create a new project. Returns the persisted Project so the UI
   * (CreateProjectDialog) can optimistically navigate / select it.
   * `rootPath` is preserved in the type for forward compatibility but
   * is no longer wired to bridge cwd; see devlog 2026-05-14.
   */
  createProject: (input: { name: string; rootPath?: string }) => Promise<Project>;
  /** Rename / toggle pin via a partial update. `rootPath` is still
   * accepted to keep DB rows round-trippable but has no runtime
   * effect; see devlog 2026-05-14. */
  updateProject: (
    id: string,
    partial: Partial<Pick<Project, "name" | "rootPath" | "pinned">>,
  ) => Promise<void>;
  /** Permanent delete; sessions auto-unassigned via FK SET NULL. */
  deleteProject: (id: string) => Promise<void>;
  /**
   * Assign a session to a project (or pass `null` to unassign).
   * Updates the session row only — no bridge restart, no cwd change.
   */
  assignSessionToProject: (
    sessionId: string,
    projectId: string | null,
  ) => Promise<void>;
  /** Enter / exit filter mode. `undefined` clears the filter. */
  setActiveProjectFilter: (projectId: string | undefined) => void;
  /**
   * Permanently delete every archived session. Destructive — UI
   * must double-confirm (checkbox + destructive button) before
   * invoking. Returns the count of rows deleted so the caller can
   * show a feedback toast.
   */
  emptyArchive: () => Promise<number>;
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
   * the bridge down. The whole thing finishes in ~2-3s in the
   * background, so by the time the user clicks the LLM picker in
   * EmptyState, the latest list (reflecting any mykey.py edits) is
   * already there. Idempotent via `_warmupComplete` flag; skipped
   * entirely when gaConfig is invalid (e.g. pre-onboarding).
   */
  warmupLLMList: () => Promise<void>;

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
  /**
   * Pick the LLM for the next freshly-created session. Used by
   * EmptyState's inline picker — there's no live bridge yet, so we
   * can't `set_llm` over IPC; instead we stash `pendingLLMIndex` and
   * let `activateSession`'s spawnBridge call forward it as
   * `--llm-no`. Also flips `isCurrent` on the top-level `llms`
   * projection so the Composer pill reflects the pick immediately.
   */
  selectLLMForNewSession: (index: number) => void;

  // Conversation (per-session — sessionId required)
  appendUserTurn: (sessionId: string, text: string) => void;
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
   * Set the session id that Desktop Pet is currently attached to.
   * `null` means no pet is running. Called from the IPC handlers
   * when `pet_attached` / `pet_detached` events arrive — never call
   * directly from UI; UI should send the IPC command and let the
   * bridge's response flip this flag.
   */
  setPetAttachedSession: (sessionId: string | null) => void;
  /**
   * Stage the target session for an implicit pet migration. Set by
   * the title-menu click in a non-holder session; consumed by the
   * pet_detached IPC handler to fire the follow-up attach_pet.
   */
  setPendingPetMigration: (sessionId: string | null) => void;

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
    const newHasAsk = newRt.pendingAskUser !== null;
    // Sidebar's running subline used to sync runtime.currentTurnIndex
    // → session.currentStepIndex here to show the live "正在工作 ·
    // 第 N 步" header. That field is gone now — the sidebar reads
    // `session.lastStepIndex` (written by bumpSessionAfterTurn on
    // each turn_end) instead, trading one step of lag for paired
    // step-number + summary. Main-view's thinking placeholder still
    // reads `runtime.currentTurnIndex` directly (via the top-level
    // projection), so the live step number is preserved where it
    // actually matters.
    if (
      session.status !== newStatus ||
      session.pendingApprovalCount !== newCount ||
      (session.hasPendingAskUser ?? false) !== newHasAsk
    ) {
      const sessions = state.sessions.slice();
      sessions[sessionIndex] = {
        ...session,
        status: newStatus,
        pendingApprovalCount: newCount,
        hasPendingAskUser: newHasAsk,
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
  inFlightContent: string;
  approvalDecisions: Record<string, ApprovalDecision>;
  bridgeStatus: BridgeStatus;
  bridgeError: string | null;
  bridgePid: number | null;
  llms: LLMOption[];
  llmDisplayName: string;
  pendingAskUser: PendingAskUser | null;
} {
  return {
    turns: rt.turns,
    pendingApprovals: rt.pendingApprovals,
    agentRunning: rt.agentRunning,
    currentTurnIndex: rt.currentTurnIndex,
    inFlightContent: rt.inFlightContent,
    approvalDecisions: rt.approvalDecisions,
    bridgeStatus: rt.bridgeStatus,
    bridgeError: rt.bridgeError,
    bridgePid: rt.bridgePid,
    llms: rt.llms,
    llmDisplayName: rt.llmDisplayName,
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

// ---------------- Mock session builder (dev only) ----------------

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
  // Pinned: 2 rows (dates don't matter, pinned wins)
  MOCK_TITLES_PINNED.forEach((_, i) =>
    out.push(
      make(MOCK_TITLES_PINNED, now - (5 + i * 3) * day, {
        pinned: true,
        status: "idle",
      }),
    ),
  );
  // Today: 3 rows, mix one running + one waiting_approval for icon variety
  out.push(make(MOCK_TITLES_TODAY, now - 30 * 60_000, { status: "running" }));
  out.push(
    make(MOCK_TITLES_TODAY, now - 2 * 3_600_000, {
      status: "waiting_approval",
    }),
  );
  out.push(make(MOCK_TITLES_TODAY, now - 5 * 3_600_000, { status: "idle" }));
  // This week: 4 rows spread across days 1-6
  [1, 2, 4, 6].forEach((d) =>
    out.push(make(MOCK_TITLES_WEEK, now - d * day - 2 * 3_600_000)),
  );
  // Earlier: 15 rows, days 8 .. ~420 (spans >1 year for realism)
  const earlierDayOffsets = [
    8, 11, 14, 19, 24, 32, 45, 58, 73, 95, 130, 180, 240, 330, 420,
  ];
  earlierDayOffsets.forEach((d) =>
    out.push(make(MOCK_TITLES_EARLIER, now - d * day)),
  );
  return out;
}

export const useAppStore = create<AppStore>((set, get) => ({
  // ---- Initial state (demo fixtures) ----
  screen: "empty",
  paletteOpen: false,
  settingsOpen: false,

  sessions: DEMO_SESSIONS,
  activeSessionId: undefined,
  projects: [],
  activeProjectFilter: undefined,
  pendingLLMIndex: undefined,
  // llms / llmDisplayName are populated by the trailing
  // `...projectionFrom(emptyRuntime())` spread below — emptyRuntime
  // seeds DEMO_LLMS / DEMO_LLM_DISPLAY_NAME so Composer renders a
  // plausible LLM pre-bridge.
  runtimeInfo: DEMO_RUNTIME_INFO,

  gaConfig: DEMO_GA_CONFIG,

  approvalConfig: DEMO_APPROVAL_CONFIG,
  yoloMode: true,
  yoloIntroSeen: true,
  conversationWidth: "compact",
  petAttachedSessionId: null,
  pendingPetMigrationTo: null,

  toasts: [],

  _runtimes: {},

  // Global counter, not projected from any runtime — see State's
  // userSubmitTick doc comment.
  userSubmitTick: 0,

  _warmupComplete: false,

  // Top-level projection starts as the empty runtime (no active
  // session yet). setActiveSession refreshes these.
  ...projectionFrom(emptyRuntime()),

  // ---- UI actions ----
  setScreen: (s) => set({ screen: s }),
  setPaletteOpen: (o) => set({ paletteOpen: o }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  setSettingsOpen: (o) => set({ settingsOpen: o }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),

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
        // Clearing the active session (e.g. user clicked "New Chat"
        // → lazy path). Conversation projection resets to empty, but
        // KEEP `llms` / `llmDisplayName` — LLM config is shared
        // across the whole GA install (mykey.py is one file), so any
        // previously-spawned bridge has already populated the real
        // list. Falling back to emptyRuntime's DEMO_LLMS here would
        // make the empty-screen Composer dropdown show fake model
        // names ("GLM 5.1" etc.) until the user lands on a session.
        return {
          activeSessionId: undefined,
          ...projectionFrom(emptyRuntime()),
          llms: state.llms,
          llmDisplayName: state.llmDisplayName,
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

  createSession: (projectId) => {
    const id = `s-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const now = new Date().toISOString();
    const newSession: Session = {
      id,
      title: DEFAULT_NEW_SESSION_TITLE,
      status: "idle",
      // Inherit project assignment at birth when caller passes it
      // (Sidebar "+ New Chat" while in filter mode, or EmptyState
      // composer submit). Project = grouping only — bridge cwd is
      // unaffected (see devlog 2026-05-14).
      projectId: projectId,
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
    // No "too many sessions" warning: LRU 5 (see _enforceLRUCap
    // above) already caps alive bridge processes regardless of how
    // many session rows exist; archived rows don't hold any bridge
    // at all. Disk footprint per row is ~KB. The previous nag
    // ("后台 bridge 进程会越来越占资源") was based on a wrong
    // assumption and got triggered even for users who'd just done
    // the recommended thing (archive). Sidebar searchability for
    // very long lists is what ⌘K / bucket grouping addresses, not
    // a forced cleanup prompt.
    return id;
  },

  bumpSessionAfterTurn: (sessionId, summary, stepNumber) => {
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
        // Store raw summary text — no "第 N 步 · " or "已完成 · "
        // prefix at the storage layer. Sidebar rendering decides
        // what prefix to add based on the session's current state
        // ("第 N 步 · {summary}" while running, "已完成 · {summary}"
        // once settled). Same summary string serves both, no DB
        // migration needed.
        //
        // stepNumber is the per-message GA turnIndex of the step
        // that just finished. We pair it with the summary so the
        // sidebar running subline "第 N 步 · X" shows the
        // most-recently-completed step's number AND its recap —
        // both pieces describe the same step, no semantic mismatch.
        //
        // When the bridge didn't emit a summary we keep the
        // previous one rather than wipe it — staleness beats
        // blanking the row on every turn.
        const nextSummary =
          summary && summary.trim() ? truncateSummary(summary) : s.summary;
        // Don't write `status: "idle"` here — status is derived
        // from runtime by `deriveSessionStatus` (via
        // `applyRuntimeUpdate`'s in-place sync). turn_end is
        // per-step, not terminal; forcing "idle" here was the
        // reason the sidebar flipped to "已完成" mid-run.
        updated = {
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
      // Project = pure grouping. We deliberately do NOT inject the
      // project's rootPath as the bridge cwd here — doing so would
      // chdir away from the GA install dir and silently break GA's
      // relative `./memory/...` reads (memory_management_sop, any
      // user SOP, etc.). See devlog 2026-05-14 rootPath rollback.
      const session = get().sessions.find((s) => s.id === id);
      // EmptyState's inline LLM picker stashes `pendingLLMIndex`
      // because there was no live bridge to set_llm against. Apply
      // it here as `--llm-no` only when the session is genuinely
      // fresh — re-activating an existing session must respect that
      // session's own `set_llm` history. Always clear pending after
      // this activation so an abandoned pick (user picked LLM,
      // then clicked an existing session) doesn't leak into a later
      // unrelated spawn.
      const pendingLLMIndex = get().pendingLLMIndex;
      const rtNow = get()._runtimes[id];
      const isFreshSession =
        (session?.turnCount ?? 0) === 0 &&
        (!rtNow || rtNow.turns.length === 0);
      const consumePending =
        isFreshSession && pendingLLMIndex !== undefined;
      if (pendingLLMIndex !== undefined) {
        set({ pendingLLMIndex: undefined });
      }
      await get().spawnBridge({
        ...get().gaConfig,
        sessionId: id,
        cwd: undefined,
        llmIndex: consumePending ? pendingLLMIndex : undefined,
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

  renameSession: (sessionId, newTitle) => {
    // Trim + sanitize. Empty after trim → fall back to default
    // placeholder so we never persist a literally-empty title (which
    // would render the sidebar row as a blank line with no anchor).
    const cleaned = newTitle.trim();
    const finalTitle = cleaned === "" ? DEFAULT_NEW_SESSION_TITLE : cleaned;
    const now = new Date().toISOString();
    let updated: Session | null = null;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        if (s.title === finalTitle) return s; // no-op if unchanged
        updated = { ...s, title: finalTitle, updatedAt: now };
        return updated;
      }),
    }));
    if (updated) {
      void persistSession(updated).catch((e) => {
        console.debug("[store] renameSession persistSession failed.", e);
      });
    }
  },

  togglePinSession: (sessionId) => {
    const now = new Date().toISOString();
    let updated: Session | null = null;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        if (s.status === "archived") return s;
        updated = { ...s, pinned: !s.pinned, updatedAt: now };
        return updated;
      }),
    }));
    if (updated) {
      void persistSession(updated).catch((e) => {
        console.debug("[store] togglePinSession persistSession failed.", e);
      });
    }
  },

  // ---- Projects ----

  createProject: async ({ name, rootPath }) => {
    const now = new Date().toISOString();
    const id = `proj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const next: Project = {
      id,
      name: name.trim(),
      rootPath: rootPath?.trim() || undefined,
      pinned: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({ projects: [next, ...state.projects] }));
    try {
      await persistProject(next);
    } catch (e) {
      console.debug("[store] createProject persistProject failed.", e);
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
          // Normalise empty rootPath to undefined for DB tidiness.
          // The field has no runtime effect post-2026-05-14 rollback.
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
    if (updated) {
      try {
        await persistProject(updated);
      } catch (e) {
        console.debug("[store] updateProject persistProject failed.", e);
      }
    }
  },

  deleteProject: async (id) => {
    // FK `ON DELETE SET NULL` on sessions.project_id auto-unassigns
    // any rows that pointed here — sessions stay, just lose their
    // project. We mirror that in memory so the sidebar doesn't show
    // ghost assignments after the row is gone.
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      sessions: state.sessions.map((s) =>
        s.projectId === id ? { ...s, projectId: undefined } : s,
      ),
      activeProjectFilter:
        state.activeProjectFilter === id ? undefined : state.activeProjectFilter,
    }));
    try {
      await deleteProjectFromDB(id);
    } catch (e) {
      console.debug("[store] deleteProject DB failed.", e);
    }
  },

  assignSessionToProject: async (sessionId, projectId) => {
    const now = new Date().toISOString();
    let updated: Session | null = null;
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        updated = {
          ...s,
          projectId: projectId ?? undefined,
          updatedAt: now,
        };
        return updated;
      });
      return { sessions };
    });
    if (updated) {
      try {
        await persistSession(updated);
      } catch (e) {
        console.debug("[store] assignSessionToProject persistSession failed.", e);
      }
    }
  },

  setActiveProjectFilter: (projectId) =>
    set({ activeProjectFilter: projectId }),

  // ---- Bulk variants (multi-select in EarlierDialog / ArchivedDialog) ----
  //
  // Each one does the in-memory update in a single `set` so the
  // sidebar doesn't re-render N times when the user archives a big
  // batch, then persists each row to SQLite in parallel. Toast
  // feedback for archive uses a single rolled-up message rather
  // than N individual ones.

  archiveSessionsBulk: (sessionIds) => {
    if (sessionIds.length === 0) return;
    const now = new Date().toISOString();
    const idSet = new Set(sessionIds);
    const updatedRows: Session[] = [];
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (!idSet.has(s.id)) return s;
        if (s.status === "archived") return s;
        const next: Session = { ...s, status: "archived", updatedAt: now };
        updatedRows.push(next);
        return next;
      });
      const activeSessionId =
        state.activeSessionId && idSet.has(state.activeSessionId)
          ? undefined
          : state.activeSessionId;
      return { sessions, activeSessionId };
    });
    void Promise.all(
      updatedRows.map((s) =>
        persistSession(s).catch((e) => {
          console.debug(
            `[store] archiveSessionsBulk persistSession failed for ${s.id}.`,
            e,
          );
        }),
      ),
    );
    if (updatedRows.length > 0) {
      get().pushToast(
        makeAppError({
          category: "business",
          severity: "info",
          title: `已归档 ${updatedRows.length} 个对话`,
          message: "",
          hint: null,
          retryable: false,
          context: "archiveSessionsBulk",
          traceback: null,
        }),
      );
    }
  },

  unarchiveSessionsBulk: (sessionIds) => {
    if (sessionIds.length === 0) return;
    const now = new Date().toISOString();
    const idSet = new Set(sessionIds);
    const updatedRows: Session[] = [];
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (!idSet.has(s.id)) return s;
        if (s.status !== "archived") return s;
        const next: Session = { ...s, status: "idle", updatedAt: now };
        updatedRows.push(next);
        return next;
      }),
    }));
    void Promise.all(
      updatedRows.map((s) =>
        persistSession(s).catch((e) => {
          console.debug(
            `[store] unarchiveSessionsBulk persistSession failed for ${s.id}.`,
            e,
          );
        }),
      ),
    );
  },

  deleteSessionsPermanentlyBulk: async (sessionIds) => {
    if (sessionIds.length === 0) return;
    // Defensive bridge teardown for each — the same guard the
    // single-row path does. Done sequentially with awaits so we
    // don't fire N parallel shutdowns racing the same process tree.
    for (const id of sessionIds) {
      if (getBridgeClient(id)) {
        try {
          await useAppStore.getState().shutdownBridge(id);
        } catch (e) {
          console.warn(
            `[store] deleteSessionsPermanentlyBulk shutdownBridge failed for ${id}.`,
            e,
          );
        }
      }
    }
    const idSet = new Set(sessionIds);
    set((state) => {
      const sessions = state.sessions.filter((s) => !idSet.has(s.id));
      const _runtimes = { ...state._runtimes };
      for (const id of sessionIds) delete _runtimes[id];
      const out: Partial<typeof state> = { sessions, _runtimes };
      if (state.activeSessionId && idSet.has(state.activeSessionId)) {
        out.activeSessionId = undefined;
        Object.assign(out, projectionFrom(emptyRuntime()));
      }
      return out;
    });
    await Promise.all(
      sessionIds.map((id) =>
        deleteSessionFromDB(id).catch((e) => {
          console.warn(
            `[store] deleteSessionsPermanentlyBulk SQLite delete failed for ${id}.`,
            e,
          );
        }),
      ),
    );
  },

  deleteSessionPermanently: async (sessionId) => {
    // Defensive: kill any lingering bridge before yanking the row.
    // Archived sessions shouldn't have a live bridge (archiveSession
    // doesn't kill one, but LRU 5 typically reaps them); covering
    // the edge so we don't leak a process pointing at a deleted id.
    if (getBridgeClient(sessionId)) {
      try {
        await useAppStore.getState().shutdownBridge(sessionId);
      } catch (e) {
        console.warn(
          "[store] deleteSessionPermanently shutdownBridge failed.",
          e,
        );
      }
    }
    // Remove from in-memory state first so the UI updates even if
    // SQLite is unavailable (Vite-only dev). _runtimes entry is
    // also dropped so memory doesn't slowly leak per delete.
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const _runtimes = { ...state._runtimes };
      delete _runtimes[sessionId];
      const out: Partial<typeof state> = { sessions, _runtimes };
      if (state.activeSessionId === sessionId) {
        out.activeSessionId = undefined;
        Object.assign(out, projectionFrom(emptyRuntime()));
      }
      return out;
    });
    // Drop SQLite row (FK ON DELETE CASCADE handles messages +
    // tool_events). Best-effort: if SQLite is unavailable the
    // in-memory state is already updated; the row will be a ghost
    // until next app run + load. That's an accepted trade-off given
    // we don't want to block the UI on disk.
    try {
      await deleteSessionFromDB(sessionId);
    } catch (e) {
      console.warn(
        "[store] deleteSessionPermanently SQLite delete failed.",
        e,
      );
    }
  },

  emptyArchive: async () => {
    const archived = get().sessions.filter((s) => s.status === "archived");
    if (archived.length === 0) return 0;
    // Sequential rather than Promise.all — each one talks to SQLite
    // and the operations are cheap; serial keeps the in-memory state
    // and DB ordering predictable, and any failure can be logged
    // against the specific session that broke.
    for (const s of archived) {
      try {
        await useAppStore.getState().deleteSessionPermanently(s.id);
      } catch (e) {
        console.warn(
          `[store] emptyArchive: failed to delete ${s.id}.`,
          e,
        );
      }
    }
    return archived.length;
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
    set((state) => ({
      gaConfig: merged,
      // Reflect into runtimeInfo so the Settings → Runtime tab and
      // Inspector → Runtime card show the new path immediately.
      // pythonVersion is intentionally repurposed to display the
      // resolved interpreter path — users see where the bridge will
      // spawn from, not the internal capability alias.
      runtimeInfo: {
        ...state.runtimeInfo,
        gaPath: merged.gaPath,
        pythonVersion: pythonDisplay,
      },
      // Reset the warmup flag so a new gaPath (or python interpreter)
      // re-triggers a one-shot LLM list refresh against the new
      // mykey.py. Without this, switching GA installs would leave
      // the old install's LLM list cached in state.llms.
      _warmupComplete: false,
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
      void get().warmupLLMList();
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
  replaceLLMs: (sessionId, llms) => {
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
    });
    // Cache LLM list to prefs so future cold-starts (before any
    // bridge has spawned) can show the real model names instead
    // of the DEMO_LLMS seed. The LLM list is GA-install-wide
    // (mykey.py is one file shared across sessions), so any one
    // bridge's `ready` event is a faithful snapshot.
    void setPref("llm_list", llms).catch((e) => {
      console.debug("[store] replaceLLMs llm_list cache failed.", e);
    });
  },

  selectLLMForNewSession: (index) => {
    set((state) => {
      const list = state.llms;
      if (index < 0 || index >= list.length) return {};
      const next = list.map((opt, i) => ({ ...opt, isCurrent: i === index }));
      return {
        llms: next,
        llmDisplayName: next[index].displayName,
        pendingLLMIndex: index,
      };
    });
  },

  warmupLLMList: async () => {
    if (get()._warmupComplete) return;
    const config = get().gaConfig;
    // Pre-onboarding / invalid config — bridge spawn would just error.
    // setGAConfig will re-trigger us once the user picks a real path.
    if (!config.gaPath) return;

    // Set early to dedupe concurrent calls (e.g. App.tsx triggers
    // hydrate which triggers us, while a separate effect also pings).
    set({ _warmupComplete: true });

    // Race guard: spawnBridgeProcess's stdout listener can fire
    // `ready` between command.spawn() resolution and `client`
    // assignment. We capture the ready inside the handler regardless
    // and use a deferred-shutdown flag for the late case.
    let client: BridgeClient | null = null;
    let pendingShutdown = false;
    let readyHandled = false;

    try {
      client = await spawnBridgeProcess(
        {
          ...config,
          sessionId: "__warmup__",
        },
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
            set((state) => ({
              llms,
              llmDisplayName:
                current?.displayName ?? state.llmDisplayName,
            }));
            void setPref("llm_list", llms).catch((e) => {
              console.debug("[warmup] llm_list cache failed.", e);
            });
            // Shutdown the warmup bridge — we only needed the
            // ready event. If client isn't yet assigned (the
            // spawn promise hasn't resolved on this microtask
            // yet), defer to post-assignment below.
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
      // Belt-and-suspenders: if `ready` never arrives within 15s
      // (bad gaPath, mykey.py syntax error, etc.), kill the orphan
      // bridge so we don't leak a Python process. _warmupComplete
      // stays true so we don't retry this app instance — the user
      // will see stale list and can restart or update gaConfig.
      setTimeout(() => {
        if (!readyHandled && client) {
          console.warn("[warmup] ready timeout, shutting down");
          void client.shutdown(5000);
        }
      }, 15000);
    } catch (e) {
      console.warn("[store] warmupLLMList spawn failed:", e);
      // Reset so a future setGAConfig (or app restart) can retry.
      set({ _warmupComplete: false });
    }
  },

  // ---- Conversation (per-session) ----
  appendUserTurn: (sessionId, text) => {
    let titleDerived: { sessionId: string; title: string } | null = null;
    // Snapshot turnCount before any state mutation; this is the
    // offset that should map GA's 1-based per-loop turn indices
    // onto absolute session-wide indices. See SessionRuntime
    // doc comment for the full rationale.
    const currentTurnCount =
      get().sessions.find((s) => s.id === sessionId)?.turnCount ?? 0;
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

  setPetAttachedSession: (sessionId) =>
    set({ petAttachedSessionId: sessionId }),

  setPendingPetMigration: (sessionId) =>
    set({ pendingPetMigrationTo: sessionId }),

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
        onStderr: (line) => {
          console.warn(`[bridge ${sessionId} stderr]`, line);
          // Keep a rolling tail so onClose can show what went wrong.
          const buf = _stderrTails.get(sessionId) ?? [];
          buf.push(line);
          if (buf.length > _STDERR_TAIL_MAX) buf.shift();
          _stderrTails.set(sessionId, buf);
        },
        onClose: (code, signal) => {
          console.info(`[bridge ${sessionId}] closed`, { code, signal });
          // Abnormal exit → surface a toast with the last stderr lines
          // so the user sees the real failure (ImportError, syntax
          // error in mykey.py, etc.) instead of just "nothing
          // happened". `code === 0` means graceful shutdown; null code
          // with no signal means we shut it down ourselves via
          // child.kill() — also not user-facing. Anything else is a
          // real crash worth surfacing.
          if (code !== 0 && code !== null) {
            const tail = _stderrTails.get(sessionId) ?? [];
            const message = tail.length
              ? tail.slice(-3).join("\n")
              : `Bridge exited with code ${code}`;
            useAppStore.getState().pushToast(
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
              // Safety net for bridge crash / kill / LRU suspend:
              // turn_end no longer clears agentRunning (it's per-step,
              // not terminal), so without this `onClose` cleanup a
              // bridge dying mid-run would leave the sidebar stuck on
              // "正在工作". `run_complete` / `error` cover the graceful
              // exits; onClose catches everything else.
              agentRunning: false,
              currentTurnIndex: null,
              inFlightContent: "",
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
          // Spawn-time failures (binary missing, capability rejected,
          // permission denied) — also worth a toast so the user sees
          // something concrete instead of "the chat is just frozen".
          useAppStore.getState().pushToast(
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
    // Replace the demo fixture's hardcoded workbenchVersion ("0.1.0",
    // a lie since alpha.1) with the real value baked into tauri.conf.json
    // at build time. Tauri's getVersion() returns the same string the
    // bundler stamped into the .app, so Settings → About always matches
    // the installed release. Failing fetch keeps the demo value — not
    // worth blocking hydration on this.
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      const realVersion = await getVersion();
      set((state) => ({
        runtimeInfo: { ...state.runtimeInfo, workbenchVersion: realVersion },
      }));
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
      const sessions = await loadSessions();
      // No demo-seed on first launch. DEMO_SESSIONS stay as the
      // in-memory initial state for the brief moment before
      // hydrate resolves; if the user has zero real sessions, the
      // sidebar shows its empty-state hint and prompts a "New chat".
      set({ sessions });
      // Projects hydrate alongside sessions — they're the drawers
      // sessions can live in, so loading them in the same pass keeps
      // the sidebar render path consistent (no half-state where
      // sessions reference projectIds that aren't in memory yet).
      try {
        const projects = await loadProjects();
        set({ projects });
      } catch (e) {
        console.debug("[store] hydrateFromDB: loadProjects failed.", e);
      }
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
        const current = cachedLLMs.find((l) => l.isCurrent);
        set((state) => ({
          llms: cachedLLMs,
          llmDisplayName: current?.displayName ?? state.llmDisplayName,
        }));
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
        set((state) => ({
          gaConfig: migrated,
          runtimeInfo: {
            ...state.runtimeInfo,
            gaPath: saved.gaPath,
            pythonVersion: pythonDisplay,
          },
        }));
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
      set({ screen: "onboarding" });
      return;
    }

    // After hydrate completes (sessions / projects / prefs all loaded
    // and gaConfig finalized), kick off a warmup bridge to refresh
    // the LLM list from mykey.py. The prefs cache loaded above is
    // stale if the user edited mykey.py since the last bridge ready
    // event; warmup ensures EmptyState shows the current list before
    // the user clicks the LLM picker. Fire-and-forget — warmup runs
    // in the background and doesn't block hydrate completion.
    void get().warmupLLMList();
  },

  seedMockSessions: async () => {
    const batch = buildMockSessions();
    set((state) => ({ sessions: [...batch, ...state.sessions] }));
    // Persist sequentially — the batch is small (~20 rows) and
    // SQLite writes are fast; parallel awaits would just race on
    // the same connection.
    for (const s of batch) {
      try {
        await persistSession(s);
      } catch (e) {
        console.debug("[store] seedMockSessions persistSession failed.", e);
      }
    }
    console.info(`[store] seedMockSessions: inserted ${batch.length} rows.`);
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
