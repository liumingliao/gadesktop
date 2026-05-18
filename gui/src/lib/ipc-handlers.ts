import { fromIPCError, makeAppError } from "@/types/app-error";
import type {
  AgentTurn,
  ConversationToolEvent,
  PendingApproval,
} from "@/types/conversation";
import type { MessageRow } from "@/types/db";
import type {
  ConversationMessage,
  IPCEvent,
  ToolCall as IPCToolCall,
  ToolResult as IPCToolResult,
} from "@/types/ipc";

import type { useAppStore } from "@/stores/useAppStore";

/**
 * Routes an IPC event from the bridge into store actions.
 *
 * #10b coverage:
 *
 *   ready             → connected status + replace LLMs
 *   llm_changed       → flip currentness in llms[]
 *   error             → push toast (fromIPCError)
 *   turn_end          → append agent turn (thinking + tools + final
 *                       answer), persisted to messages table
 *   tool_call_pending → add to pendingApprovals
 *   tool_call_end     → no-op for V0.1 (the conversation rebuilds the
 *                       tool's final state from turn_end's
 *                       toolResults; we don't need a separate row)
 *   tool_call_progress→ debug log (not in conversation rendering)
 *   ask_user          → V0.1: log; ask_user surfaces via the existing
 *                       conversation flow when GA exits the loop
 *   run_complete      → log; pending list is already cleared by the
 *                       desktop when the user records a decision
 *   history_loaded    → log
 *
 * Tool ids: turn_end's toolCalls / toolResults are positional, so we
 * walk them in order with synthetic ids when none is supplied.
 */
export function dispatchIPCEvent(
  event: IPCEvent,
  store: typeof useAppStore,
): void {
  const s = store.getState();

  switch (event.kind) {
    case "ready": {
      console.info("[ipc] ready", {
        sessionId: event.sessionId,
        ga: event.gaCommit,
        llm: event.llmName,
        availableLLMs: event.availableLLMs.length,
      });
      // Per-session LLM list — N-active multi-session means each
      // bridge has its own currently-selected LLM. The active session's
      // pair projects up to top-level `llms` / `llmDisplayName` for
      // Composer / Command Palette / Inspector reads.
      s.replaceLLMs(
        event.sessionId,
        event.availableLLMs.map((l) => ({
          index: l.index,
          displayName: l.displayName,
          isCurrent: l.isCurrent,
        })),
      );
      s.setBridgeStatus(event.sessionId, "connected");
      // Sync the user's actual GA HEAD into runtimeInfo so the
      // Settings → Runtime panel shows "GA 版本: cf65515 · 2026-05-11"
      // alongside the workbench-tested baseline. gaCommit/Date are
      // the same across every bridge (they all run against the same
      // ga_path), so writing on every `ready` is safe — N-active
      // background bridges don't conflict.
      store.setState((state) => ({
        runtimeInfo: {
          ...state.runtimeInfo,
          gaCommit: event.gaCommit,
          gaCommitDate: event.gaCommitDate,
          bridgePid: event.pid,
        },
      }));
      // Sync session-scoped state to the freshly-spawned bridge.
      // YOLO mode (PRD §11.5): the bridge boots with yolo_mode=false;
      // if the user has it persisted as on, push the override now —
      // it's queued in the bridge's command pipeline and processed
      // before any subsequent user message can trigger a tool call.
      if (s.yoloMode) {
        void s.sendIPCCommand(event.sessionId, {
          kind: "set_yolo_mode",
          enabled: true,
        });
      }
      // Session Restore (Stage 3 Task 3). If this session has prior
      // turn history on disk, replay it into GA `backend.history` via
      // load_history. Bridge processes commands in FIFO order — even
      // if the user submits a `user_message` immediately, this lands
      // first.
      //
      // The session-list check uses `turnCount > 0` rather than the
      // SQLite query result so we skip the round-trip for newly
      // created sessions (the common case). For the cold-start case
      // turnCount comes from `loadSessions` during hydrate.
      const session = store
        .getState()
        .sessions.find((x) => x.id === event.sessionId);
      if (session && (session.turnCount ?? 0) > 0) {
        void replayHistoryToBridge(event.sessionId, store);
      }
      return;
    }

    case "llm_changed": {
      console.info("[ipc] llm_changed", {
        index: event.index,
        displayName: event.displayName,
        sessionId: event.sessionId,
      });
      // Re-read this session's current LLM list from the store rather
      // than the top-level projection — the `llm_changed` event might
      // be for a non-active session (background bridge that the user
      // had set_llm'd before switching sessions), in which case
      // `s.llms` projects the wrong session.
      const rtLLMs = s._runtimes[event.sessionId]?.llms ?? s.llms;
      s.replaceLLMs(
        event.sessionId,
        rtLLMs.map((l) => ({
          ...l,
          isCurrent: l.index === event.index,
        })),
      );
      return;
    }

    case "error": {
      console.warn("[ipc] error", event);
      s.pushToast(fromIPCError(event));
      // Bridge errors usually mean turn_end won't arrive — clear the
      // running flag so the thinking placeholder + Stop-mode Composer
      // don't get stuck on. Categories like `quota_exceeded` /
      // `network` show the error toast instead.
      s.setAgentRunning(event.sessionId, false);
      s.setCurrentTurnIndex(event.sessionId, null);
      s.clearInFlightContent(event.sessionId);
      return;
    }

    case "turn_end": {
      // GA's agent_runner_loop resets turn=1 on every put_task
      // (per-message), so event.turnIndex is the per-message
      // step (the value users want to see in "第 N 步"). For
      // SQLite, we add the runtime's offset to get an absolute
      // session-wide turn index — the primary key
      // `msg_${sessionId}_${turnIndex}_assistant` would collide
      // across user messages otherwise. See SessionRuntime
      // `turnIndexOffset` doc comment for full background.
      const offset = s._runtimes[event.sessionId]?.turnIndexOffset ?? 0;
      const absoluteTurnIndex = event.turnIndex + offset;
      console.info("[ipc] turn_end", {
        gaTurnIndex: event.turnIndex,
        absoluteTurnIndex,
        offset,
        toolCallCount: event.toolCalls?.length ?? 0,
        hasFinalAnswer: !!event.responseContent,
      });
      // UI: AgentTurn.turnIndex = per-message step (raw GA value).
      // TurnMarker renders "第 N 步" against this — resetting to 1
      // on every new user message is GA's native semantic and what
      // the user expects.
      const turn = turnFromTurnEnd(event);
      s.appendAgentTurn(event.sessionId, turn);
      // No setAgentRunning(false) here — turn_end is per-step inside
      // GA's agent_runner_loop, not the run terminus. agentRunning
      // stays true until `run_complete` / `error` / bridge close so
      // the sidebar and main view correctly reflect a multi-step
      // run in progress. (Prior code cleared it on every turn_end,
      // which made the sidebar flip to "已完成" after step 1 of an
      // N-step run.)
      // Update the session row (turn_count + last_activity_at +
      // summary). Sidebar `第 N 步 · {summary}` previews also use
      // the per-message step (matches what the user sees in the
      // main view). turn_count itself keeps incrementing in
      // absolute terms — that's the offset's source of truth.
      s.bumpSessionAfterTurn(event.sessionId, event.summary, event.turnIndex);
      // SQLite: persist under the ABSOLUTE turn index. rowsToTurns
      // reconstructs the per-message step at restore by tracking
      // the latest user row's turn_index as a per-message base.
      void persistTurnEndToMessages({ ...event, turnIndex: absoluteTurnIndex });
      return;
    }

    case "tool_call_pending": {
      const offset = s._runtimes[event.sessionId]?.turnIndexOffset ?? 0;
      const target = pickTarget(event.args);
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        toolName: event.toolName,
        target,
        riskLevel: event.riskLevel,
        args: event.args,
      };
      s.addPendingApproval(event.sessionId, pending);
      // Best-effort SQLite double-write for audit trail. tool_events
      // joins to messages by (session_id, turn_index) — must use
      // absolute turn index so the join works after restore.
      void persistToolEventPendingFromIPC({
        ...event,
        turnIndex: event.turnIndex + offset,
      });
      return;
    }

    case "tool_call_end": {
      // turn_end carries the same toolResults; we don't need an
      // independent state shape for finished tools.
      console.debug("[ipc] tool_call_end", event);
      return;
    }

    case "run_complete": {
      console.debug("[ipc] run_complete", event);
      // Last-resort clear: turn_end already cleared agentRunning for
      // the normal happy path; this catches ABORTED / DENIED exits
      // where turn_end_callback didn't fire on the GA side.
      s.setAgentRunning(event.sessionId, false);
      s.setCurrentTurnIndex(event.sessionId, null);
      s.clearInFlightContent(event.sessionId);
      return;
    }

    case "turn_start": {
      // Reflects which GA-side iteration the agent is currently on.
      // The thinking placeholder reads this to render
      // "第 N 步 · 思考中…". N is the per-message step (GA-native,
      // resets to 1 on each new user message) — matches what
      // completed TurnMarkers show, what the Sidebar preview
      // shows. No offset applied; raw GA value is the display.
      console.debug("[ipc] turn_start", event);
      s.setCurrentTurnIndex(event.sessionId, event.turnIndex);
      // New turn starts → drop whatever streaming buffer the previous
      // turn left, so the in-flight render doesn't bleed across turns.
      s.clearInFlightContent(event.sessionId);
      return;
    }

    case "turn_progress": {
      // Streaming partial. Append delta; MainView re-renders the
      // in-flight reply with cleanPartialContent stripping GA's
      // internal tags.
      s.appendInFlightDelta(event.sessionId, event.delta);
      return;
    }

    case "ask_user": {
      // GA called the `ask_user` tool — bridge has already EXITED the
      // agent loop and is waiting for an `ask_user_response` (or
      // equivalent `user_message`). Surface the question via the
      // inline AskUserBubble + Sidebar yellow "⏸ 等你回复" dot.
      // Conversation history will also show this turn's regular
      // assistant content + tool callouts; the ask_user tool callout
      // itself is suppressed at render time (see Conversation.tsx).
      console.info("[ipc] ask_user", {
        sessionId: event.sessionId,
        candidateCount: event.candidates.length,
      });
      s.setPendingAskUser(event.sessionId, {
        question: event.question,
        candidates: event.candidates,
      });
      return;
    }

    case "tools_reinjected": {
      console.info("[ipc] tools_reinjected", {
        sessionId: event.sessionId,
        blocksAdded: event.blocksAdded,
      });
      s.pushToast(
        makeAppError({
          category: "business",
          severity: "info",
          title: "工具已重新注入",
          message: `已为本 session 注入 ${event.blocksAdded} 条工具定义。`,
          hint: null,
          retryable: false,
          context: "reinject_tools",
          traceback: null,
        }),
      );
      return;
    }

    case "pet_attached": {
      console.info("[ipc] pet_attached", {
        sessionId: event.sessionId,
        port: event.port,
      });
      s.setPetAttachedSession(event.sessionId);
      // Clear any stale migration target so a future detach can't
      // re-trigger an attach on a session the user no longer wants.
      s.setPendingPetMigration(null);
      s.pushToast(
        makeAppError({
          category: "business",
          severity: "info",
          title: "桌面宠物已启动",
          message: "宠物会实时显示本对话的进展。",
          hint: null,
          retryable: false,
          context: "attach_pet",
          traceback: null,
        }),
      );
      return;
    }

    case "pet_detached": {
      console.info("[ipc] pet_detached", {
        sessionId: event.sessionId,
      });
      // Only clear top-level if it was attached to this session —
      // defensive against out-of-order events. In practice the bridge
      // only emits pet_detached for the session it was attached to.
      if (s.petAttachedSessionId === event.sessionId) {
        s.setPetAttachedSession(null);
      }
      // Implicit-migration relay: the user clicked "桌面宠物" in a
      // non-holder session; we detached the holder, and now (port
      // released, hook removed) we fire the follow-up attach. Skip
      // the "已关闭" toast in this case — the about-to-arrive
      // pet_attached toast tells the right story for migrations.
      const pendingTarget = s.pendingPetMigrationTo;
      if (pendingTarget) {
        s.setPendingPetMigration(null);
        void s.sendIPCCommand(pendingTarget, {
          kind: "attach_pet",
          port: 41983,
        });
        return;
      }
      s.pushToast(
        makeAppError({
          category: "business",
          severity: "info",
          title: "桌面宠物已关闭",
          message: "",
          hint: null,
          retryable: false,
          context: "detach_pet",
          traceback: null,
        }),
      );
      return;
    }

    case "system_message": {
      console.info("[ipc] system_message", {
        sessionId: event.sessionId,
        variant: event.variant,
        length: event.content.length,
      });
      s.appendSystemTurn(event.sessionId, {
        role: "system",
        content: event.content,
        variant: event.variant,
      });
      return;
    }

    case "history_loaded":
    case "tool_call_start":
    case "tool_call_progress": {
      console.debug(`[ipc] ${event.kind}`, event);
      return;
    }

    default: {
      const exhaustive: never = event;
      console.warn("[ipc] unknown event kind", exhaustive);
    }
  }
}

// ---------------- Turn-end → AgentTurn ----------------

function turnFromTurnEnd(event: {
  turnIndex: number;
  summary: string;
  toolCalls: IPCToolCall[];
  toolResults: IPCToolResult[];
  responseContent: string;
}): AgentTurn {
  const tools = event.toolCalls.map((tc, i) =>
    toolEventFromIPC(tc, event.toolResults[i], i),
  );
  // GA's summary occasionally arrives as the literal placeholder
  // text when the LLM didn't produce a meaningful one. Trim + treat
  // empty as undefined so the UI doesn't render a hollow line.
  const trimmedSummary = event.summary?.trim();
  // Intermediate turns (tool-only, no user-facing answer) produce a
  // responseContent that's entirely <thinking>...</thinking> +
  // <tool_use>...</tool_use> tags; after cleanFinalAnswer strips
  // everything what's left is "". Normalize to null so Conversation's
  // `showFinalAnswer = finalAnswer !== null` check correctly hides
  // the MessageAgent + its Copy/Save actions for these turns.
  const cleanedAnswer = cleanFinalAnswer(event.responseContent);
  // Detect "final-answer turn" (GA's synthetic `no_tool` placeholder
  // or zero real tools). For those, the surviving narrator IS the
  // final answer and renders through MessageAgent — capturing it
  // also as preamble would double-render the same prose under
  // TurnMarker. Intermediate turns keep the preamble extraction.
  const isFinalTurn =
    tools.length === 0 || tools.every((t) => t.name === "no_tool");
  return {
    role: "agent",
    thinking: extractThinking(event.responseContent),
    preamble: isFinalTurn
      ? undefined
      : extractPreamble(event.responseContent),
    tools,
    finalAnswer: cleanedAnswer.trim() ? cleanedAnswer : null,
    turnIndex: event.turnIndex,
    summary: trimmedSummary ? trimmedSummary : undefined,
  };
}

function toolEventFromIPC(
  tc: IPCToolCall,
  result: IPCToolResult | undefined,
  index: number,
): ConversationToolEvent {
  const id =
    (typeof result?.toolUseId === "string" && result.toolUseId) ||
    (typeof tc.toolUseId === "string" && tc.toolUseId) ||
    `t-${index}`;

  let resultPreview: string | undefined;
  const content = result?.content;
  if (typeof content === "string") {
    resultPreview = content.slice(0, 500);
  } else if (content !== undefined) {
    try {
      resultPreview = JSON.stringify(content).slice(0, 500);
    } catch {
      resultPreview = String(content).slice(0, 500);
    }
  }

  return {
    id,
    name: tc.toolName,
    // turn_end is the post-completion state — by definition every
    // tool here finished. The conversation view fades older success
    // tools via "success-historical".
    status: "success-historical",
    args: tc.args,
    resultPreview,
  };
}

function pickTarget(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") return args.command.slice(0, 60);
  if (typeof args.code === "string") return args.code.slice(0, 60);
  return undefined;
}

// ---------------- GA tag stripping ----------------

const GA_TAG_PATTERNS: RegExp[] = [
  /<thinking>[\s\S]*?<\/thinking>/g,
  /<summary>[\s\S]*?<\/summary>/g,
  /<tool_use>[\s\S]*?<\/tool_use>/g,
  /<file_content[^>]*>[\s\S]*?<\/file_content>/g,
];

const FILE_REF_PATTERN = /\[FILE:[^\]]+\]/g;

/**
 * GA's `agent_loop.py` prints `LLM Running (Turn N) ...` (sometimes
 * wrapped in `**...**`) to the display queue at the start of every
 * turn. It's a frontend-side marker — every official GA frontend
 * (dcapp / tgapp / qtapp / stapp / wechatapp) strips it before
 * showing the user. We do the same: this string should never reach
 * the conversation document; our own per-turn placeholder
 * ("第 N 轮 · 思考中…") covers the same UX intent in the product's
 * voice.
 *
 * Pattern matches the line on its own row, with optional surrounding
 * `**` markdown bold markers, leading/trailing whitespace, and any
 * turn number.
 */
const LLM_RUNNING_MARKER =
  /^\s*\*{0,2}LLM Running \(Turn \d+\) \.\.\.\*{0,2}\s*$/gm;

/**
 * GA's `agent_loop.py:73` yields a display-only line of the form
 * `🛠️ tool_name(compact_args)` to the display queue every time a
 * tool dispatches. It's meant for GA's terminal frontends (dcapp /
 * tgapp / qtapp) — the structured tool call arrives separately via
 * turn_end's `toolCalls[]`, which the conversation renders as a
 * proper ToolCallout pill.
 *
 * Without stripping, the streaming partial flashes the raw marker as
 * Newsreader serif prose, then snaps to the compact pill when
 * turn_end fires — a noticeable "floppy" transition users notice
 * right away.
 *
 * The variation selector after the hammer (`️`) is optional —
 * some renderers and terminal pipes drop it.
 */
const TOOL_DISPATCH_MARKER_LINE =
  /^🛠️?\s+\w+\(.*\)[ \t]*$/gm;

/**
 * Mid-stream partial of the dispatch marker — chunk boundary fell
 * after the prefix but before the closing paren. Same role as the
 * unclosed-tag truncation: avoid showing "🛠 web_exec" for one
 * frame while we wait for the rest of the chunk.
 */
const TOOL_DISPATCH_MARKER_PARTIAL = /🛠️?\s+\w+\(/;

/**
 * Verbose-mode tool dispatch marker — emitted by `agent_loop.py:72`
 * when GA runs with `verbose=True` (which Galley's bridge sets so
 * the LLM streams per-token). Format:
 *
 *   🛠️ Tool: `tool_name`  📥 args:
 *   ````text
 *   {pretty JSON args}
 *   ````
 *
 * Different shape from the compact form (above) — multi-line, with
 * a 4-backtick fenced args block. Same role though: this is GA's
 * terminal-frontend chrome, not content the user should read in
 * Galley's document register. ToolCallout renders the structured
 * version on turn_end.
 */
const TOOL_DISPATCH_VERBOSE_BLOCK =
  /🛠️?\s+Tool:\s+`[^`\n]+`\s+📥\s+args:\n````text\n[\s\S]*?\n````\n?/g;

/**
 * Partial-truncation pattern for the verbose marker — chunk
 * boundary fell anywhere inside the block before the closing
 * 4-backtick fence. Truncating at the leading 🛠 keeps the partial
 * render clean while the rest of the block arrives.
 */
const TOOL_DISPATCH_VERBOSE_PARTIAL = /🛠️?\s+Tool:\s+`/;

/**
 * 5-backtick fenced block — wraps the streamed stdout/stderr of a
 * tool's dispatch generator while GA is in verbose mode
 * (`agent_loop.py:79-81`):
 *
 *   `````
 *   <tool's yielded output, potentially many lines / chunks>
 *   `````
 *
 * Stripped wholesale (including content). The structured outcome
 * lands at turn_end via `toolResults[]`; ToolCallout's resultPreview
 * surfaces it there. Showing raw tool stdout as Newsreader prose
 * during streaming is uglier than a brief "stream pauses" feel
 * during tool execution.
 */
const FIVE_BACKTICK_BLOCK = /`{5}\n[\s\S]*?\n`{5}\n?/g;

/**
 * Trailing 5-backtick fence open without a matching close — chunk
 * boundary fell after the fence opener but before any line of
 * content has arrived (or before the closer arrives). Truncate at
 * the fence start to avoid rendering "`````" plus partial stdout
 * as prose.
 */
const FIVE_BACKTICK_PARTIAL = /`{5}\n?$/;

/**
 * GA tool-dispatch yields all start with `[Action] ...` — first
 * line of every `do_*` tool method (ga.py:18, :360, :378, :408,
 * etc.) ahead of any subprocess output. These live INSIDE the
 * 5-backtick fence that wraps tool output in verbose mode, so the
 * fence truncation below `should` catch them — but if chunk timing
 * ever delivers the [Action] line without the fence-open in the
 * same partial-render window, the line would leak as prose. This
 * line-level strip is the defensive belt-and-suspenders for that.
 *
 * Subprocess stdout that follows the [Action] line is also inside
 * the fence and likewise caught there; we don't have a pattern for
 * arbitrary stdout, so the fence is the only defense for it.
 */
const TOOL_ACTION_LINE = /^\[Action\] [^\n]*$/gm;

/**
 * "当前阶段：..." preamble that GA's [sys_prompt.txt:4] obliges the
 * LLM to write before every tool call ("调用工具前先推演：当前阶段、
 * 上步结果是否符合预期、下步策略"). The structured `<summary>` form
 * of the same content lands as TurnMarker副标题 via turn_end's
 * `summary` field — the prose preamble is a verbose duplicate.
 *
 * Pattern matches the line beginning + everything up to the next
 * blank line (or end-of-buffer for partials). The optional `**`
 * wrapping covers the cases where the LLM markdown-bolds the
 * label. `[：:]` handles both full-width and half-width colon.
 *
 * If the LLM's entire intermediate-turn prose is just this
 * preamble, stripping it leaves the partial empty → the
 * ThinkingMarker placeholder takes over, which is the right UX
 * (a tight "思考中" beats verbose "当前阶段：还在走 Google 搜索"
 * filler).
 */
const PHASE_PREAMBLE =
  /^\*{0,2}当前阶段\*{0,2}\s*[：:][\s\S]*?(?=\n\n|$)/gm;

/**
 * Mirror of bridge's `_clean_response_for_display`. Strips GA's
 * structured tags so the user sees the prose-ish final answer
 * Newsreader can render directly. Bridge emits the raw responseContent
 * in turn_end (to keep the wire faithful); this is the desktop
 * equivalent of that python helper.
 */
function cleanFinalAnswer(text: string): string {
  if (!text) return "";
  let out = text;
  for (const p of GA_TAG_PATTERNS) out = out.replace(p, "");
  out = out.replace(LLM_RUNNING_MARKER, "");
  out = out.replace(TOOL_ACTION_LINE, "");
  out = out.replace(PHASE_PREAMBLE, "");
  out = out.replace(FILE_REF_PATTERN, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

const GA_TAG_NAMES = ["thinking", "summary", "tool_use", "file_content"];

/**
 * Stripping for **partial** GA output (turn_progress streaming).
 *
 * Different from cleanFinalAnswer because the input may end mid-tag:
 *   - "Some text <thi"        → could be the start of <thinking>
 *   - "Some text <thinking>x" → inside an open tag, content not yet
 *                                complete
 *   - "Some text <thinking>x</thinking> rest" → complete, strip block
 *
 * Strategy:
 *   1. Strip every well-formed <tag>...</tag> block.
 *   2. Find the leftmost unclosed open tag (one of GA_TAG_NAMES).
 *      Truncate the string at that position — content past it
 *      belongs to the in-flight tag and shouldn't be rendered.
 *   3. Find a trailing partial open-tag start (e.g. "<thi" with no
 *      closing ">") and truncate it too — otherwise the user would
 *      see a stray "<thi" rendered as text for one frame.
 *   4. Strip [FILE:...] refs and normalise blank-line runs.
 *
 * Result: a string the user can read at any sampling instant
 * without seeing GA's internal scaffolding flash through.
 */
export function cleanPartialContent(text: string): string {
  if (!text) return "";
  let out = text;

  // 1. Complete blocks.
  for (const p of GA_TAG_PATTERNS) out = out.replace(p, "");

  // 1b. Strip GA's per-turn `LLM Running (Turn N) ...` marker. This
  //     is a frontend-side string GA writes to its display queue;
  //     our own thinking placeholder covers the same UX in product
  //     voice. Done before the unclosed-tag truncation so the
  //     marker doesn't accidentally survive when the partial ends
  //     mid-line. The /gm flag handles multiple occurrences in
  //     accumulated streaming buffers (multi-turn runs).
  out = out.replace(LLM_RUNNING_MARKER, "");

  // 1c. Strip GA's compact `🛠️ tool_name(args)` dispatch markers.
  //     Emitted by `agent_loop.py:73` in verbose=False mode. Galley
  //     now runs verbose=True so these don't appear in practice, but
  //     the stripper stays as backstop in case the user runs against
  //     an older GA baseline where the bridge still falls back.
  out = out.replace(TOOL_DISPATCH_MARKER_LINE, "");

  // 1d. Mid-stream partial of the compact dispatch marker (chunk
  //     arrived with just the prefix, no closing paren yet).
  const partialMarkerIdx = out.search(TOOL_DISPATCH_MARKER_PARTIAL);
  if (partialMarkerIdx !== -1) out = out.slice(0, partialMarkerIdx);

  // 1e. Verbose-mode `🛠️ Tool: ... 📥 args: ...` multi-line marker
  //     block. Same role as the compact marker but with a 4-backtick
  //     fenced args section underneath. Complete blocks first, then
  //     partial truncation if the chunk boundary fell inside.
  out = out.replace(TOOL_DISPATCH_VERBOSE_BLOCK, "");
  const partialVerboseIdx = out.search(TOOL_DISPATCH_VERBOSE_PARTIAL);
  if (partialVerboseIdx !== -1) out = out.slice(0, partialVerboseIdx);

  // 1f. 5-backtick fenced tool-output blocks (verbose mode wraps the
  //     tool's dispatch stream in these). Strip wholesale — the
  //     structured result lands at turn_end via toolResults[] and
  //     ToolCallout renders the preview from there.
  out = out.replace(FIVE_BACKTICK_BLOCK, "");
  // Trailing un-closed 5-fence — truncate so the user doesn't see
  // raw stdout-as-prose pile up between the opener and the chunk
  // carrying the closer.
  const fenceOpenIdx = out.search(/`{5}\n/);
  if (fenceOpenIdx !== -1) {
    out = out.slice(0, fenceOpenIdx);
  } else if (FIVE_BACKTICK_PARTIAL.test(out)) {
    // Chunk ended exactly on a fence open, no newline yet.
    out = out.replace(FIVE_BACKTICK_PARTIAL, "");
  }

  // 1g. Defensive line-level strip for GA tool-output lines that
  //     start with [Action]. See TOOL_ACTION_LINE — these live
  //     inside the 5-backtick fence and should already be hidden
  //     by the fence truncation above, but chunk-timing edge cases
  //     can leave the fence context out of the partial-render
  //     window. The line strip is cheap and harmless when the fence
  //     already caught them.
  out = out.replace(TOOL_ACTION_LINE, "");

  // 1h. Strip "当前阶段：..." preamble paragraphs that GA's
  //     sys_prompt obliges the LLM to write before every tool call.
  //     The same content arrives in structured form via <summary>
  //     → TurnMarker副标题; the prose preamble is a duplicate the
  //     user reads twice. See PHASE_PREAMBLE comment.
  out = out.replace(PHASE_PREAMBLE, "");

  // 2. Unclosed open tag — truncate at its position.
  let earliestUnclosed = -1;
  for (const name of GA_TAG_NAMES) {
    // Look for an opener that has no matching closer further along.
    // The complete-block regex above already removed matched pairs,
    // so any remaining opener is by construction unclosed.
    const openRe = new RegExp(`<${name}(?:\\s[^>]*)?>`);
    const m = out.match(openRe);
    if (m && m.index !== undefined) {
      if (earliestUnclosed === -1 || m.index < earliestUnclosed) {
        earliestUnclosed = m.index;
      }
    }
  }
  if (earliestUnclosed !== -1) out = out.slice(0, earliestUnclosed);

  // 3. Trailing partial open-tag start ("<thi", "<sum", etc.).
  // Find the last "<" — if what follows it is a prefix of any GA tag
  // name AND there's no ">" yet, drop it.
  const lastLt = out.lastIndexOf("<");
  if (lastLt !== -1 && out.indexOf(">", lastLt) === -1) {
    const tail = out.slice(lastLt + 1).toLowerCase();
    const couldBeTag =
      tail === "" ||
      tail === "/" ||
      GA_TAG_NAMES.some(
        (n) =>
          n.startsWith(tail) ||
          // closing form like "</thi" → tail = "/thi"
          (tail.startsWith("/") && n.startsWith(tail.slice(1))),
      );
    if (couldBeTag) out = out.slice(0, lastLt);
  }

  // 4. Cleanups.
  out = out.replace(FILE_REF_PATTERN, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

function extractThinking(text: string): string | undefined {
  const m = text.match(/<thinking>([\s\S]*?)<\/thinking>/);
  if (!m) return undefined;
  const inner = m[1].trim();
  return inner || undefined;
}

/**
 * Pull the LLM's natural-language pre-tool reasoning prose out of a
 * raw response.content. GA's sys_prompt asks the LLM to "推演：当前阶
 * 段、上步结果是否符合预期、下步策略" before each tool call but
 * doesn't pin a specific format — different LLMs surface this as:
 *
 *   - "当前阶段：xxx；上一步：yyy；下一步：zzz"  (some Claude variants)
 *   - "我需要先 X 因为 Y，然后再 Z"            (freeform narrator)
 *   - "1. 当前阶段...\n2. 上一步..."           (bullet-numbered)
 *   - Nothing outside <summary> at all          (terse models)
 *
 * Instead of pattern-matching one specific phrase, we strip every
 * structured tag and known frontend marker — whatever natural-
 * language prose remains IS the preamble. Captures all of the above
 * styles uniformly; empty result (LLM wrote nothing outside tags)
 * naturally returns undefined and the TurnMarker chevron stays
 * hidden — correct UX, nothing to expand.
 *
 * Used in two paths:
 *   - turn_end (settled): callers gate on "is this an intermediate
 *     turn" so a final-answer turn's prose doesn't double-render as
 *     both preamble AND finalAnswer.
 *   - turn_progress (streaming): MainView feeds the in-flight buffer
 *     directly; the TurnTicker shows whatever's available as live
 *     process feedback.
 */
export function extractPreamble(text: string): string | undefined {
  if (!text) return undefined;
  let segment = text;
  // Structured-tag blocks: stripped wholesale so the remainder is
  // pure narrator prose.
  segment = segment.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
  segment = segment.replace(/<summary>[\s\S]*?<\/summary>/g, "");
  segment = segment.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, "");
  segment = segment.replace(
    /<file_content[^>]*>[\s\S]*?<\/file_content>/g,
    "",
  );
  // Frontend / dispatch markers that occasionally leak into raw
  // response content (see cleanPartialContent for the full set; we
  // care about the ones that produce text noise).
  segment = segment.replace(LLM_RUNNING_MARKER, "");
  segment = segment.replace(TOOL_DISPATCH_MARKER_LINE, "");
  segment = segment.replace(TOOL_ACTION_LINE, "");
  segment = segment.replace(FILE_REF_PATTERN, "");
  // Streaming-partial case: an open tag without a matching close
  // means the chunk fell mid-block. Truncate at the open so we
  // don't leak partial tag content into the preamble display.
  segment = segment.replace(
    /<(thinking|summary|tool_use|file_content)(?:\s[^>]*)?>[\s\S]*$/,
    "",
  );
  segment = segment.replace(/\n{3,}/g, "\n\n");
  const trimmed = segment.trim();
  return trimmed || undefined;
}

// ---------------- SQLite persistence (best-effort) ----------------

/**
 * Best-effort SQLite write. Imported lazily so a non-Tauri runtime
 * (Vite-only dev) doesn't fail hard at IPC dispatch time; if the DB
 * isn't available we just log and move on.
 */
/**
 * Best-effort SQLite write for the audit trail. See db.ts
 * `persistToolEventPending` for the v0.1 scoping rationale (audit only,
 * no completion rows).
 */
async function persistToolEventPendingFromIPC(event: {
  sessionId: string;
  approvalId: string;
  turnIndex: number;
  toolName: string;
  args: Record<string, unknown>;
  argsPreview: string;
  riskLevel: string;
  timestamp: string;
}): Promise<void> {
  try {
    const { persistToolEventPending } = await import("@/lib/db");
    // Bridge sends riskLevel as a free string per the wire format; map
    // unexpected values to 'medium' to keep the column constraint happy.
    const risk: "low" | "medium" | "high" =
      event.riskLevel === "low" || event.riskLevel === "high"
        ? event.riskLevel
        : "medium";
    await persistToolEventPending({
      approvalId: event.approvalId,
      sessionId: event.sessionId,
      turnIndex: event.turnIndex,
      toolName: event.toolName,
      args: event.args,
      argsPreview: event.argsPreview,
      riskLevel: risk,
      startedAt: event.timestamp,
    });
  } catch (e) {
    console.debug("[ipc] persistToolEventPending: SQLite unavailable.", e);
  }
}

async function persistTurnEndToMessages(event: {
  sessionId: string;
  turnIndex: number;
  toolCalls: IPCToolCall[];
  toolResults: IPCToolResult[];
  responseContent: string;
  summary: string;
}): Promise<void> {
  try {
    const { getDB, indexMessageFts } = await import("@/lib/db");
    const db = await getDB();
    const id = `msg_${event.sessionId}_${event.turnIndex}_assistant`;
    const createdAt = new Date().toISOString();
    const trimmedSummary = event.summary?.trim() ?? "";
    const finalAnswer = cleanFinalAnswer(event.responseContent);
    // Mirrors turnFromTurnEnd's gate: only intermediate turns persist
    // a preamble. Final-answer turn's narrator IS the final answer
    // and lives in `final_answer`; storing it again as `preamble`
    // would double-render on restore.
    const isFinalTurn =
      event.toolCalls.length === 0 ||
      event.toolCalls.every((tc) => tc.toolName === "no_tool");
    const persistedPreamble = isFinalTurn
      ? null
      : (extractPreamble(event.responseContent) ?? null);
    await db.execute(
      `INSERT INTO messages (
         id, session_id, turn_index, sequence, role, content,
         tool_calls, tool_results, thinking, final_answer, summary,
         preamble, created_at
       ) VALUES ($1, $2, $3, $4, 'assistant', $5,
                 $6, $7, $8, $9, $10,
                 $11, $12)
       ON CONFLICT(id) DO UPDATE SET
         content       = excluded.content,
         tool_calls    = excluded.tool_calls,
         tool_results  = excluded.tool_results,
         thinking      = excluded.thinking,
         final_answer  = excluded.final_answer,
         summary       = excluded.summary,
         preamble      = excluded.preamble`,
      [
        id,
        event.sessionId,
        event.turnIndex,
        // Sequence within turn: user is 0 (persistUserMessage in
        // db.ts), assistant is 1. `loadMessagesBySession` orders by
        // (turn_index, sequence) — both halves of a turn need
        // distinct sequences for restore to come out in the right
        // order.
        1,
        event.responseContent,
        JSON.stringify(event.toolCalls),
        JSON.stringify(event.toolResults),
        extractThinking(event.responseContent) ?? null,
        finalAnswer,
        // GA's third-person turn summary. NULL when empty so the
        // TurnMarker renders the bare "第 N 步" instead of an
        // empty separator.
        trimmedSummary ? trimmedSummary : null,
        // LLM pre-tool reasoning prose for DetailPanel restore. See
        // isFinalTurn gate above — final answers don't persist here.
        persistedPreamble,
        createdAt,
      ],
    );
    // Index the markdown body for CommandPalette content search.
    // We index `final_answer` rather than raw `content` so raw
    // <thinking> blocks don't pollute search hits. Best-effort —
    // a failure here shouldn't unwind the message write.
    try {
      if (finalAnswer && finalAnswer.trim() !== "") {
        await indexMessageFts({
          messageId: id,
          sessionId: event.sessionId,
          role: "assistant",
          turnIndex: event.turnIndex,
          body: finalAnswer,
        });
      }
    } catch (e) {
      console.debug("[ipc] persistTurnEndToMessages indexMessageFts failed.", e);
    }
  } catch (e) {
    console.debug("[ipc] persistTurnEndToMessages: SQLite unavailable.", e);
  }
}

// ---------------- Session restore ----------------

/**
 * Replay this session's SQLite message history into the bridge's
 * GA backend via `load_history` IPC. Called from the `ready` event
 * handler when `session.turnCount > 0` indicates prior conversation.
 *
 * GA's `_load_history` (bridge/workbench_bridge.py L739) wraps the
 * `{role, content: string}` shape into NativeClaudeSession's native
 * blocks format. The assistant `content` column we wrote on turn_end
 * is GA's raw `responseContent` (with <thinking>/<tool_use> tags
 * intact) — exactly what GA's backend expects to see for full context
 * fidelity. User content is the verbatim text we wrote on
 * `appendUserTurn`.
 *
 * Best-effort: errors swallowed. A failed restore leaves the bridge
 * with empty history; the user can still continue the conversation,
 * just without GA remembering earlier turns. We log at debug so dev
 * builds see the failure without polluting the console for users.
 */
async function replayHistoryToBridge(
  sessionId: string,
  store: typeof useAppStore,
): Promise<void> {
  try {
    const { loadMessagesBySession } = await import("@/lib/db");
    const rows = await loadMessagesBySession(sessionId);
    if (rows.length === 0) return;
    const messages = rowsToConversationMessages(rows);
    await store.getState().sendIPCCommand(sessionId, {
      kind: "load_history",
      messages,
    });
    console.info("[ipc] load_history sent", {
      sessionId,
      messageCount: messages.length,
    });
  } catch (e) {
    console.debug("[ipc] replayHistoryToBridge failed.", e);
  }
}

function rowsToConversationMessages(
  rows: MessageRow[],
): ConversationMessage[] {
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
    }));
}
