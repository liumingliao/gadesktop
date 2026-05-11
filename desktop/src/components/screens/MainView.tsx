import { ArrowDown } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ApprovalDock } from "@/components/conversation/ApprovalDock";
import {
  Composer,
  type ComposerLLMOption,
} from "@/components/conversation/Composer";
import { Conversation, TurnMarker } from "@/components/conversation/Conversation";
import { MarkdownView } from "@/components/conversation/MarkdownView";
import { ThinkingSummary } from "@/components/conversation/ThinkingSummary";
import { ToolCallout } from "@/components/conversation/ToolCallout";
import { cleanPartialContent } from "@/lib/ipc-handlers";
import { cn } from "@/lib/utils";
import type {
  ConversationToolEvent,
  PendingApproval,
  Turn,
} from "@/types/conversation";
import type { ApprovalDecision } from "@/types/ipc";

export interface MainViewProps {
  turns: Turn[];
  llmDisplayName: string;
  pendingApprovals?: PendingApproval[];
  approvalDecisions?: Record<string, ApprovalDecision>;
  onSubmit?: (text: string) => void;
  onApprove?: (approvalId: string, decision: ApprovalDecision) => void;
  onAdvanceApproval?: (next: PendingApproval) => void;
  onStop?: () => void;
  /** When true, the agent is mid-run; the Composer hides Submit and
   * shows Stop, the LLM switcher disables. */
  isRunning?: boolean;
  /**
   * GA-side turn currently being run, surfaced into the thinking
   * placeholder (Turn N · 思考中…) and into pending Approval Card
   * headers when the agent has a request mid-turn. `null` / undefined
   * during quiet states.
   */
  currentTurnIndex?: number | null;
  /**
   * Counter that increments every time the user submits a message.
   * MainView watches it to scroll the just-submitted user message
   * to the viewport top (DESIGN.md §4.3 scroll behaviour). Stay
   * stateless about the value itself — only changes matter.
   */
  userSubmitTick?: number;
  /**
   * Streaming partial output from the bridge. Renders mid-turn
   * after the completed turns and any pending Approval Card. Empty
   * string when no streaming is active.
   */
  inFlightContent?: string;
  /** LLM list for the Composer's inline picker. */
  llms?: ComposerLLMOption[];
  /** Called when the user picks an LLM from the inline dropdown. */
  onSelectLLM?: (index: number) => void;
  /** Fallback for pre-bridge / dev when `llms` is empty. */
  onOpenLLMSwitcher?: () => void;
}

/**
 * Main view — the in-session screen. Per DESIGN.md §3 layout floor +
 * §4.3 conversation document + §4.6 approval dock + §4.4 composer.
 *
 * Three vertical regions, all aligned to a 760px reading column:
 *
 *   Conversation (scrollable, takes the bleeding flex-1 space)
 *   Approval Dock (sticky-ish, only renders when pending)
 *   Composer + keyboard hint row
 *
 * Title / runtime / inspector toggle live in the AppShell-level Top
 * Bar; nothing chrome-y belongs here.
 */
export function MainView({
  turns,
  llmDisplayName,
  pendingApprovals = [],
  approvalDecisions,
  onSubmit,
  onApprove,
  onAdvanceApproval,
  onStop,
  isRunning = false,
  currentTurnIndex,
  userSubmitTick = 0,
  inFlightContent = "",
  llms,
  onSelectLLM,
  onOpenLLMSwitcher,
}: MainViewProps) {
  const stillWaiting = pendingApprovals.length > 0;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Stripped partial — empty when nothing renderable yet (e.g. only
  // `<thinking>...` partial has come through). We hide the
  // ThinkingSummary placeholder once we have user-visible streaming
  // content; otherwise the document briefly shows two "still
  // working" affordances.
  const visiblePartial = inFlightContent
    ? cleanPartialContent(inFlightContent).trim()
    : "";

  // Sticky-bottom mode for streaming: when the user is "near the
  // bottom" we follow newly-arrived tokens; if they've scrolled up
  // to read older content we don't yank them down.
  //
  // `atBottom` is the currently-tracked position; updated on scroll
  // events with a 24px tolerance so flicker around the boundary
  // doesn't toggle the mode.
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(distFromBottom < 24);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Stream-follow: while atBottom, pin scroll position to the bottom
  // as inFlightContent grows. useLayoutEffect runs synchronously
  // after the new content renders, before the browser paints — so
  // the user never sees a glimpse of the bottom-having-moved-up
  // before we snap it back.
  useLayoutEffect(() => {
    if (!atBottom) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [inFlightContent, atBottom]);

  const onClickScrollToBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // The smooth-scroll arrives at bottom asynchronously; we
    // optimistically flip atBottom now so subsequent stream chunks
    // are followed without a frame's gap.
    setAtBottom(true);
  };

  // Stick-to-user-message-top scroll behaviour (DESIGN.md §4.3).
  // Effect fires only when the user submits a new message — keying
  // on `turns.length` would also fire on every turn_end (pushing
  // the user away mid-read of the agent's reply). The store's
  // `userSubmitTick` is a counter that only the submit path bumps.
  //
  // Why we don't use scrollIntoView({block: "start"}): it doesn't
  // accept a top-padding argument. We compute the offset manually
  // so the user message lands ~32px below the scroll container's
  // top edge (gives the thinking placeholder + first reply lines
  // visible breathing room without burying the prompt off-screen).
  useEffect(() => {
    if (userSubmitTick === 0) return; // initial render — nothing to scroll
    const container = scrollContainerRef.current;
    if (!container) return;
    // RAF defers to after the new <MessageUser data-role="user-msg">
    // has actually mounted from the appendUserTurn state update.
    const handle = requestAnimationFrame(() => {
      const userMsgs = container.querySelectorAll<HTMLElement>(
        '[data-role="user-msg"]',
      );
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return;
      const containerRect = container.getBoundingClientRect();
      const targetTop = last.getBoundingClientRect().top;
      const TOP_PADDING = 32;
      const delta = targetTop - containerRect.top - TOP_PADDING;
      if (Math.abs(delta) < 1) return;
      container.scrollBy({ top: delta, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(handle);
  }, [userSubmitTick]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-app">
      {/* Scrollable conversation column */}
      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto px-8 py-6"
      >
        <div className="mx-auto max-w-[760px]">
          <Conversation
            turns={turns}
            approvalDecisions={approvalDecisions}
            onApprove={onApprove}
          />
          {/* In-flight pending approvals — rendered after the
              completed turns. The agent has emitted tool_call_pending
              but the turn hasn't ended yet, so these tools aren't in
              `turns[].tools` (turn_end is what folds them in). We
              render them inline as ToolCallouts so the user sees the
              full Approval Card (diff / args / buttons), not just an
              "等待审批中" placeholder. Once the user decides, the
              store removes the pending entry; the eventual turn_end
              brings the same tool back as part of a finalized turn. */}
          {stillWaiting && (
            // No wrapper margin — TurnMarker provides its own
            // mt-7, and ToolCallout's my-3 spaces successive cards.
            // space-y-2 stays for the multi-pending case.
            <div className="space-y-2">
              {currentTurnIndex != null && (
                <TurnMarker index={currentTurnIndex} />
              )}
              {pendingApprovals.map((p) => (
                <ToolCallout
                  key={p.approvalId}
                  tool={pendingToToolEvent(p)}
                  onApprove={(decision) => onApprove?.(p.approvalId, decision)}
                />
              ))}
            </div>
          )}

          {/* Thinking placeholder (DESIGN.md §4.3). User sent a
              message; the bridge is dispatching but turn_end hasn't
              come back yet (LLM TTFT can be several seconds). Without
              this the conversation looks frozen. We hide it once an
              Approval Card shows up (already covers "agent waiting
              on you") OR once streaming content has begun (the
              partial render is itself the live signal).
              The turn number folds into the ThinkingSummary line
              ("第 N 轮 · 思考中…") rather than sitting as a separate
              header — keeps the placeholder a single soft prompt
              instead of header + body. */}
          {isRunning && !stillWaiting && !visiblePartial && (
            <ThinkingSummary>
              <>
                {currentTurnIndex != null && `第 ${currentTurnIndex} 步 · `}
                思考中…
              </>
            </ThinkingSummary>
          )}

          {/* In-flight streaming partial (DESIGN.md §4.3 streaming
              generation). Renders the LLM's tokens as they arrive
              via turn_progress IPC events. Replaced by the canonical
              AgentTurn the moment turn_end fires (store clears
              inFlightContent in appendAgentTurn). */}
          {isRunning && !stillWaiting && visiblePartial && (
            <div>
              {currentTurnIndex != null && (
                <TurnMarker index={currentTurnIndex} />
              )}
              <MarkdownView source={visiblePartial} variant="agent" />
            </div>
          )}
        </div>
      </div>

      {/* Scroll-to-bottom floating button (DESIGN.md §4.3 streaming
          generation). Visible only when the user has scrolled away
          from the bottom. Anchored just above the Composer so it
          doesn't fight with the dock for space when both are
          present. */}
      {!atBottom && (
        <button
          type="button"
          onClick={onClickScrollToBottom}
          aria-label="Scroll to latest"
          className={cn(
            "absolute bottom-[140px] right-8 z-10 inline-flex size-9 items-center justify-center rounded-full",
            "border border-line bg-elevated text-ink-soft shadow-elevated",
            "transition-colors hover:bg-hover hover:text-ink",
          )}
        >
          <ArrowDown size={16} weight="thin" />
        </button>
      )}

      {/* Bottom stack: dock + composer + hint */}
      <div className="bg-app px-8 pb-4">
        <div className="mx-auto max-w-[760px]">
          <ApprovalDock
            pending={pendingApprovals}
            onAdvance={onAdvanceApproval}
          />

          <Composer
            llmDisplayName={llmDisplayName}
            placeholder="继续这个对话…"
            onSubmit={onSubmit}
            stopMode={isRunning}
            onStop={onStop}
            disabled={false}
            llms={llms}
            onSelectLLM={onSelectLLM}
            onOpenLLMSwitcher={onOpenLLMSwitcher}
          />

          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-muted">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span>切换 LLM 不会丢失上下文</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Synthesize a ConversationToolEvent from a PendingApproval so
 * ToolCallout (which expects the full event shape) can render the
 * in-flight Approval Card. Status is hard-coded "waiting_approval"
 * — that's the only state pendings ever appear in. `args` is what
 * lets the tool-specific renderers (PatchView for file_patch,
 * command preview for code_run) light up; without it ToolCallout
 * falls back to the raw mono args block.
 */
function pendingToToolEvent(p: PendingApproval): ConversationToolEvent {
  return {
    id: p.approvalId,
    name: p.toolName,
    status: "waiting_approval",
    args: p.args,
    riskLevel: p.riskLevel,
    approvalId: p.approvalId,
  };
}
