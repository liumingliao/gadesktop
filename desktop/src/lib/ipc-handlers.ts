import { fromIPCError } from "@/types/app-error";
import type {
  AgentTurn,
  ConversationToolEvent,
  PendingApproval,
} from "@/types/conversation";
import type {
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
      s.replaceLLMs(
        event.availableLLMs.map((l) => ({
          index: l.index,
          displayName: l.displayName,
          isCurrent: l.isCurrent,
        })),
      );
      s.setBridgeStatus(event.sessionId, "connected");
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
      return;
    }

    case "llm_changed": {
      console.info("[ipc] llm_changed", {
        index: event.index,
        displayName: event.displayName,
      });
      s.replaceLLMs(
        s.llms.map((l) => ({
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
      console.info("[ipc] turn_end", {
        turnIndex: event.turnIndex,
        toolCallCount: event.toolCalls?.length ?? 0,
        hasFinalAnswer: !!event.responseContent,
      });
      const turn = turnFromTurnEnd(event);
      s.appendAgentTurn(event.sessionId, turn);
      // Defensive: appendAgentTurn already sets agentRunning=false in
      // its reducer, but call it again here so the IPC layer is
      // self-contained — anyone tracing event flow without reading
      // the store action sees the state transition explicitly.
      s.setAgentRunning(event.sessionId, false);
      // Update the session row (turn_count + last_activity_at) so
      // the Sidebar bucketing + "Turn N" badge stay current across
      // app restarts. SQLite write is best-effort.
      s.bumpSessionAfterTurn(event.sessionId);
      // Best-effort SQLite double-write. Silently swallow when the
      // backend isn't available (Vite dev / first launch / migration).
      void persistTurnEndToMessages(event);
      return;
    }

    case "tool_call_pending": {
      const target = pickTarget(event.args);
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        toolName: event.toolName,
        target,
        riskLevel: event.riskLevel,
        args: event.args,
      };
      s.addPendingApproval(event.sessionId, pending);
      // Best-effort SQLite double-write for audit trail. Silently
      // swallow when SQLite isn't available (Vite dev / first launch).
      void persistToolEventPendingFromIPC(event);
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
      // "Turn N · 思考中…" so users can see progress on long
      // multi-turn tasks. Cleared on run_complete / error.
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

    case "ask_user":
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
  toolCalls: IPCToolCall[];
  toolResults: IPCToolResult[];
  responseContent: string;
}): AgentTurn {
  const tools = event.toolCalls.map((tc, i) =>
    toolEventFromIPC(tc, event.toolResults[i], i),
  );
  return {
    role: "agent",
    thinking: extractThinking(event.responseContent),
    tools,
    finalAnswer: cleanFinalAnswer(event.responseContent),
    turnIndex: event.turnIndex,
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
    const { getDB } = await import("@/lib/db");
    const db = await getDB();
    const id = `msg_${event.sessionId}_${event.turnIndex}_assistant`;
    const createdAt = new Date().toISOString();
    await db.execute(
      `INSERT INTO messages (
         id, session_id, turn_index, sequence, role, content,
         tool_calls, tool_results, thinking, final_answer, created_at
       ) VALUES ($1, $2, $3, $4, 'assistant', $5,
                 $6, $7, $8, $9, $10)
       ON CONFLICT(id) DO UPDATE SET
         content       = excluded.content,
         tool_calls    = excluded.tool_calls,
         tool_results  = excluded.tool_results,
         thinking      = excluded.thinking,
         final_answer  = excluded.final_answer`,
      [
        id,
        event.sessionId,
        event.turnIndex,
        0,
        event.responseContent,
        JSON.stringify(event.toolCalls),
        JSON.stringify(event.toolResults),
        extractThinking(event.responseContent) ?? null,
        cleanFinalAnswer(event.responseContent),
        createdAt,
      ],
    );
  } catch (e) {
    console.debug("[ipc] persistTurnEndToMessages: SQLite unavailable.", e);
  }
}
