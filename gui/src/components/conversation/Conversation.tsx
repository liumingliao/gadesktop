import { CaretDown } from "@phosphor-icons/react";
import { Fragment, useEffect, useState } from "react";

import { TypingDots } from "@/components/conversation/LiveIndicators";
import { MarkdownView } from "@/components/conversation/MarkdownView";
import { MessageAgent } from "@/components/conversation/MessageAgent";
import { MessageUser } from "@/components/conversation/MessageUser";
import { SystemMessageBubble } from "@/components/conversation/SystemMessageBubble";
import { ToolCallout } from "@/components/conversation/ToolCallout";
import { cn } from "@/lib/utils";
import type { AgentTurn, Turn } from "@/types/conversation";
import type { ApprovalDecision } from "@/types/ipc";

export interface ConversationProps {
  turns: Turn[];
  /** Map of approvalId -> recorded decision. When a tool's
   * approvalId is in this map its callout flips to the decided pill. */
  approvalDecisions?: Record<string, ApprovalDecision>;
  /** Decision callback. Receives the approval id and the user's choice. */
  onApprove?: (approvalId: string, decision: ApprovalDecision) => void;
  /** Name of the project the active session belongs to (if any) —
   * threaded down to ToolCallout → ApprovalForm so the "Always
   * allow in {projectName}" button reflects context. */
  projectName?: string;
  /**
   * Resend handler — invoked when the user clicks the ↻ button on a
   * past user-msg. Receives the message text. Host should prefill the
   * Composer (not delete history). Omitting hides the affordance.
   */
  onResendUserMessage?: (content: string) => void;
}

/**
 * The conversation document — user turns, agent turns, and the two
 * horizontal-rule rhythms that DESIGN.md §4.3 codifies:
 *
 *   - hr-strong  : full-width, at end of agent turn before finalAnswer.
 *                  "Result-first" rhythm — separates plan/execution from
 *                  conclusion.
 *   - hr-soft    : 60% centered, between turns. Quiet pacing.
 *
 * Both kinds use --color-line; the strong one uses line-strong width
 * via the visual contrast of full-width vs 60% rather than a different
 * color. (DESIGN.md says "稍深 1px 全宽 vs 极淡 1px 60% 居中"; opacity
 * 60% on the soft one approximates the prototype.)
 */
export function Conversation({
  turns,
  approvalDecisions,
  onApprove,
  projectName,
  onResendUserMessage,
}: ConversationProps) {
  return (
    <div>
      {turns.map((t, i) => (
        <Fragment key={i}>
          {t.role === "user" ? (
            <MessageUser content={t.content} onResend={onResendUserMessage} />
          ) : t.role === "system" ? (
            <SystemMessageBubble content={t.content} variant={t.variant} />
          ) : (
            <AgentTurnView
              turn={t}
              approvalDecisions={approvalDecisions}
              onApprove={onApprove}
              projectName={projectName}
            />
          )}
          {/* No divider between turns — the TurnMarker on each
              AgentTurn carries the chapter-break feel via its own
              top-margin and visual weight. Earlier iterations had
              a SoftHr here (my-9 → my-6 → my-5); even at 40px the
              hr-plus-marker stack felt like wasted vertical space.
              Removed in favour of marker-only separation. */}
        </Fragment>
      ))}
    </div>
  );
}

function AgentTurnView({
  turn,
  approvalDecisions,
  onApprove,
  projectName,
}: {
  turn: AgentTurn;
  approvalDecisions?: Record<string, ApprovalDecision>;
  onApprove?: (approvalId: string, decision: ApprovalDecision) => void;
  projectName?: string;
}) {
  // `finalAnswer` is what's left of GA's responseContent after the
  // <thinking> / <tool_use> / <file_content> / <summary> tags have
  // been stripped. The earlier assumption — intermediate turns are
  // 100% tags so post-strip is always "" — turns out to be false:
  // GA's LLM frequently emits a one-line narrator ("好的，我先看一下
  // X") *outside* any tag, before the tool_use block. That narrator
  // survives the strip and produced bogus Copy/Save chips on every
  // step that had preamble text.
  //
  // Correct rule: GA's loop stops only when the LLM emits no real
  // tools, so the *final* answer is the turn that contains nothing
  // but `no_tool` placeholders. (agent_loop.py line 63 synthesizes
  // a `[{tool_name: 'no_tool', args: {}}]` entry on turns where the
  // LLM produced no tool_calls — so `tools.length === 0` would
  // never be true even on the actual final turn. The placeholder is
  // already visually hidden by ToolCallout's `pickToolTier`.)
  // Intermediate turns still show their narrator (useful "voice of
  // GA" running commentary) but without the Copy/Save chips or the
  // conclusion-rhetoric StrongHr.
  const hasAnswerText =
    turn.finalAnswer !== null && turn.finalAnswer.trim() !== "";
  // `ask_user` is GA's interaction tool — bridge already emitted an
  // AskUserEvent (rendered separately as AskUserBubble at the
  // conversation tail). Showing it as a tool callout here would
  // duplicate the question on screen, so we filter it out for BOTH
  // live and replay paths (rowsToTurns produces the same shape).
  // We keep it in the underlying turn.tools (SQLite audit trail) and
  // only drop it at render time.
  const visibleTools = turn.tools.filter((t) => t.name !== "ask_user");
  const isFinalTurn = visibleTools.every((t) => t.name === "no_tool");

  return (
    <div>
      {turn.turnIndex !== undefined && (
        <TurnMarker
          index={turn.turnIndex}
          summary={turn.summary}
          thinkingContent={turn.thinking}
          preamble={turn.preamble}
        />
      )}

      {visibleTools.map((tool) => (
        <ToolCallout
          key={tool.id}
          tool={tool}
          approvalDecision={
            tool.approvalId ? approvalDecisions?.[tool.approvalId] : undefined
          }
          onApprove={(decision) => {
            if (tool.approvalId) onApprove?.(tool.approvalId, decision);
          }}
          projectName={projectName}
        />
      ))}

      {hasAnswerText && (
        <>
          {isFinalTurn && <StrongHr />}
          <MessageAgent showActions={isFinalTurn}>
            {turn.finalAnswer}
          </MessageAgent>
        </>
      )}
    </div>
  );
}

/**
 * Per-step header — sits above each agent turn's thinking summary
 * AND carries the chapter-break weight between turns now that
 * SoftHr is gone. Tuned for that double role:
 *   - mt-7 (28px) gives turn-to-turn breathing room comparable to
 *     the old SoftHr's my-5 (40px) without the visual noise of an
 *     actual rule
 *   - serif italic + muted ink puts it in the same voice family as
 *     the other "soft prompt" UI text in the product. The previous
 *     mono+uppercase+tracking treatment read as a sysmon log line
 *     and clashed with the Notion+Claude register.
 *   - 12px keeps it from competing with the body content below.
 *
 * Why "第 N 步" and not "第 N 轮": Chinese 「轮」 collides with the
 * conversational round (user message N) mental model. GA's turn is
 * the finer-grained "one LLM call + tool dispatch" cycle, and 「步」
 * is the natural Chinese word for that level of granularity.
 *
 * Three rendering modes:
 *
 *   thinking placeholder (`thinking={true}`):
 *     In-flight state — TypingDots + elapsed counter. No chevron,
 *     no expand. Mounted when the user submits and unmounted when
 *     turn_progress / turn_end takes over the row.
 *
 *   settled, no detail (`thinking={false}`, no thinking/preamble):
 *     Plain `第 N 步 · {summary}` line. No interaction.
 *
 *   settled, expandable (`thinking={false}` + thinkingContent or preamble):
 *     Same line + trailing chevron. Whole row is clickable: click
 *     toggles an inline DetailPanel that renders the LLM's thinking
 *     and "当前阶段：..." preamble below the step row, in the same
 *     italic ink-soft register as TurnMarker itself. Reveals the
 *     reasoning the LLM wrote before dispatching the tool, on demand
 *     — without forcing it onto users who don't care.
 */
export function TurnMarker({
  index,
  summary,
  thinking = false,
  thinkingContent,
  preamble,
}: {
  /**
   * GA-side step number. Optional because the thinking placeholder
   * mounts the instant the user submits (store sets `agentRunning`
   * synchronously) but the bridge's first `turn_start` IPC carrying
   * the step number arrives ~50-200ms later. Rendering during that
   * gap with `index` undefined just drops the "第 N 步" prefix and
   * shows "思考中" alone — better than not rendering at all.
   */
  index?: number;
  /**
   * GA-side third-person turn summary (from turn_end event's
   * `summary` field). When present, rendered on the same line after
   * a separator — mirrors the Sidebar two-liner format so the user
   * sees the same recap there and in the conversation document.
   * Omitted: marker shows just the step number, which is the right
   * minimum when GA didn't produce a summary.
   */
  summary?: string;
  /**
   * True while this step is in flight and we have nothing else to
   * show yet (no streaming partial, no approval card). Renders
   * "· 思考中" + TypingDots in place of the summary so the user
   * gets a live signal during LLM TTFT / tool dispatch gaps. An
   * elapsed-seconds counter joins after 5s so long waits (thinking
   * models, large generations) read as "system still running" not
   * "system frozen" — see useElapsedSeconds for details.
   *
   * Caller is expected to pass `key={index}` when the marker can
   * outlive multiple steps' worth of placeholder transitions, so
   * the elapsed clock resets per step.
   */
  thinking?: boolean;
  /**
   * `<thinking>...</thinking>` block content if the LLM emitted one.
   * Drives the DetailPanel along with `preamble`. Ignored when
   * `thinking` (placeholder) is true.
   */
  thinkingContent?: string;
  /**
   * "当前阶段：..." preamble paragraph the LLM wrote before dispatching
   * the tool. Drives the DetailPanel along with `thinkingContent`.
   * Ignored when `thinking` (placeholder) is true.
   */
  preamble?: string;
}) {
  const elapsedSec = useElapsedSeconds(thinking);
  const elapsedLabel = thinking && elapsedSec >= 5
    ? formatElapsedSeconds(elapsedSec)
    : null;
  const hasStepNumber = index != null;
  const hasDetail = !thinking && Boolean(thinkingContent || preamble);
  const [open, setOpen] = useState(false);

  return (
    <div>
      <div
        onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
        className={cn(
          "mb-2 mt-7 select-none font-serif text-[12px] italic text-ink-muted",
          hasDetail && "cursor-pointer transition-colors hover:text-ink-soft",
        )}
      >
        {hasStepNumber && <>第 {index} 步</>}
        {thinking ? (
          <>
            {hasStepNumber ? " · 思考中" : "思考中"}
            <TypingDots />
            {elapsedLabel && (
              <span className="text-ink-muted">{" · "}{elapsedLabel}</span>
            )}
          </>
        ) : summary ? (
          <>
            {" · "}
            <span className="text-ink-soft">{summary}</span>
          </>
        ) : null}
        {hasDetail && (
          <CaretDown
            size={11}
            weight="thin"
            className={cn(
              "ml-1.5 inline-block align-baseline text-ink-muted transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        )}
      </div>
      {hasDetail && open && (
        <DetailPanel thinking={thinkingContent} preamble={preamble} />
      )}
    </div>
  );
}

/**
 * Inline expansion of TurnMarker — surfaces the LLM's per-step
 * reasoning on demand. Reuses MarkdownView "thinking" variant so the
 * typography (italic serif ink-soft) matches the TurnMarker row above
 * and the content reads as a continuation of the same voice rather
 * than a separate callout block. No border, no background, no leading
 * icon — keeps the chrome out of the way so the prose stays the focus.
 *
 * Source order: thinking → preamble. Mirrors how the LLM actually
 * writes them inside `response.content` (thinking is the internal
 * monologue; preamble is the natural-language pre-tool reasoning).
 * If only one is present we just render that one; both null/undefined
 * means TurnMarker shouldn't have offered the chevron in the first
 * place (caller's `hasDetail` check gates the render path).
 */
function DetailPanel({
  thinking,
  preamble,
}: {
  thinking?: string;
  preamble?: string;
}) {
  return (
    <div className="mb-3 animate-fade-in space-y-2">
      {thinking && (
        <MarkdownView source={thinking} variant="thinking" />
      )}
      {preamble && (
        <MarkdownView source={preamble} variant="thinking" />
      )}
    </div>
  );
}

/**
 * Tick once per second while `active` is true; reports total seconds
 * elapsed since the hook started ticking. Returns 0 when inactive.
 *
 * Reset semantics: a fresh component mount = clock at 0 (via the
 * initial state of `useState`). Callers that need the clock to
 * reset between logical "occurrences" (e.g. each step's thinking
 * placeholder) should re-mount via React `key` rather than toggling
 * the active flag — toggling on the same instance would leave a
 * stale `sec` value between the false→true transition and the
 * first setInterval tick.
 */
function useElapsedSeconds(active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const id = window.setInterval(() => {
      setSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? sec : 0;
}

/**
 * Elapsed-time formatter for the thinking placeholder.
 *
 *   5-59s  → "23 秒"             (neutral info — "this is how long")
 *   60s+   → "已 1 分 23 秒"     ("已" prefix softens the longer wait,
 *                                  acknowledging the duration without
 *                                  alarming the user)
 *
 * Seconds component always shown past the minute boundary (including
 * "已 1 分 0 秒") so the display ticks continuously each second
 * rather than briefly flashing a shorter form on the round-minute.
 */
function formatElapsedSeconds(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const minutes = Math.floor(sec / 60);
  const remainder = sec % 60;
  return `已 ${minutes} 分 ${remainder} 秒`;
}

function StrongHr() {
  return (
    <hr className="my-4 border-0 border-t border-line-strong" aria-hidden />
  );
}

// SoftHr removed (2026-05-09): even at my-5 (40px) the hr+marker
// stack between turns felt heavy. TurnMarker's own top margin +
// uppercase tracking now carries the chapter-break feel.
