import { ArrowDown } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ApprovalDock } from "@/components/conversation/ApprovalDock";
import { AskUserBubble } from "@/components/conversation/AskUserBubble";
import {
  Composer,
  type ComposerHandle,
  type ComposerLLMOption,
} from "@/components/conversation/Composer";
import { Conversation, TurnMarker } from "@/components/conversation/Conversation";
import { StreamingCursor } from "@/components/conversation/LiveIndicators";
import { MarkdownView } from "@/components/conversation/MarkdownView";
import { ToolCallout } from "@/components/conversation/ToolCallout";
import { TurnTicker } from "@/components/conversation/TurnTicker";
import { UserQuestionRail } from "@/components/conversation/UserQuestionRail";
import { IconTooltip } from "@/components/ui/tooltip";
import { useTypewriter } from "@/hooks/useTypewriter";
import { cleanPartialContent, extractPreamble } from "@/lib/ipc-handlers";
import { cn } from "@/lib/utils";
import type {
  ConversationToolEvent,
  PendingApproval,
  PendingAskUser,
  Turn,
} from "@/types/conversation";
import type { ApprovalDecision } from "@/types/ipc";

export interface MainViewProps {
  turns: Turn[];
  llmDisplayName: string;
  pendingApprovals?: PendingApproval[];
  approvalDecisions?: Record<string, ApprovalDecision>;
  /** Name of the project the active session belongs to (if any).
   * Threaded through to ToolCallout → ApprovalForm so the "Always
   * allow in {projectName}" decision button can show context. */
  projectName?: string;
  /** Active session's id. MainView watches it to scroll to the bottom
   * of the new conversation when the user switches sessions. The
   * component doesn't read or display the id, just uses identity
   * change as the trigger. Undefined during pre-session screens. */
  activeSessionId?: string;
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
  /**
   * GA-initiated question waiting for a user reply. When non-null,
   * the AskUserBubble renders at the conversation tail (with chip
   * candidates) and the Composer's placeholder switches to a reply
   * prompt. Submitting (chip click OR Composer text) routes through
   * `onSubmit` — App.tsx checks the same flag to send
   * `ask_user_response` instead of `user_message`.
   */
  pendingAskUser?: PendingAskUser | null;
  /**
   * Conversation column width mode (TopBar toggle). "compact" caps
   * the scrollable reading column at 760px (typography sweet spot
   * for 16.5px Newsreader prose); "wide" caps it at 1200px — a
   * compromise between Notion's prose-only 1040 and the original
   * 1400 proposal, sized for Workbench's mixed prose + code block
   * + tool callout content (~108ch prose / ~135ch code per line).
   *
   * Both the scrollable conversation column AND the bottom stack
   * (ApprovalDock + Composer + hint) follow this mode in lockstep.
   * Earlier iterations kept the bottom stack narrow on the
   * "input doesn't need to be wide" theory; this turned out to be
   * wrong: (a) the EmptyState toggle then had no visible effect
   * since EmptyState only contains a Composer, and (b) the Dock and
   * Composer at different widths produced visual misalignment in
   * MainView. Single width keeps the affordance consistent and
   * predictable across all screens.
   */
  conversationWidth?: "compact" | "wide";
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
  projectName,
  activeSessionId,
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
  pendingAskUser,
  conversationWidth = "compact",
}: MainViewProps) {
  const stillWaiting = pendingApprovals.length > 0;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Imperative handle to the Composer — used by the MessageUser ↻
  // resend button. The handler routes through composerRef.prefillText
  // rather than hoisting Composer to controlled mode, which would
  // require lifting its paste-fold registry state too.
  const composerRef = useRef<ComposerHandle>(null);
  // Stripped partial — empty when nothing renderable yet (e.g. only
  // `<thinking>...` partial has come through). We hide the
  // ThinkingSummary placeholder once we have user-visible streaming
  // content; otherwise the document briefly shows two "still
  // working" affordances.
  const visiblePartial = inFlightContent
    ? cleanPartialContent(inFlightContent).trim()
    : "";
  // Live preamble for the streaming-step TurnTicker. Read from the
  // raw buffer (not visiblePartial — preamble is stripped from that
  // path so it doesn't double-render with the answer prose).
  const livePreamble = inFlightContent
    ? extractPreamble(inFlightContent)
    : undefined;
  // Fake-typewriter pass to smooth over GA's ~50-char chunked
  // delta pushes. See useTypewriter docs for the mitigation
  // rationale. When the GA-side throttle is eventually fixed and
  // we get true token-level streaming, this hook becomes a no-op
  // (reveal already keeps pace with arrivals) and can be removed
  // without behavior change.
  const typedPartial = useTypewriter(visiblePartial);

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

  // Follow-the-bottom: while atBottom, pin scroll position to the
  // bottom whenever the conversation grows. useLayoutEffect runs
  // synchronously after the new content renders, before the browser
  // paints — so the user never sees a glimpse of the
  // bottom-having-moved-up before we snap it back.
  //
  // Deps cover every source of bottom-anchored growth:
  //   - typedPartial:           streaming chunks (typewriter-revealed)
  //   - turns.length:           each turn_end commits a new AgentTurn
  //   - pendingApprovals.length: approval card lands
  //   - pendingAskUser:         AskUserBubble appears
  //
  // Originally this only watched typedPartial — fine for the
  // single-turn / streaming-heavy case, but in multi-step runs where
  // the partial stays empty for stretches (tool-heavy turns,
  // dispatch markers stripped) each new step would commit invisibly
  // below the fold. User would only see progress when the final
  // turn's streaming naturally triggered a snap. Widening the deps
  // makes follow-mode catch every step's structural commit too.
  //
  // scrollTop assignment is O(1) so re-firing per render is fine.
  useLayoutEffect(() => {
    if (!atBottom) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    typedPartial,
    atBottom,
    turns.length,
    pendingApprovals.length,
    pendingAskUser,
  ]);

  const onClickScrollToBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    // The smooth-scroll arrives at bottom asynchronously; we
    // optimistically flip atBottom now so subsequent stream chunks
    // are followed without a frame's gap.
    setAtBottom(true);
  };

  // atBottom mirror for use inside async callbacks (ResizeObserver
  // below) where the captured closure would otherwise see a stale
  // boolean. The effect-based sync (rather than a render-phase
  // assignment) keeps the react-hooks lint rule happy.
  const atBottomRef = useRef(atBottom);
  useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);

  // Scroll-to-bottom on session switch. Three compounding races make
  // a single scrollTop assignment unreliable:
  //
  //   1. activateSession async-restores turns from SQLite — the
  //      restored turns commit in a *later* render than the one
  //      our useEffect runs after. Our first scrollHeight read
  //      sees the pre-restore (empty / smaller) layout.
  //   2. MarkdownView's CodeBlock uses Shiki for syntax highlighting
  //      asynchronously (WASM + dynamic grammar import). Highlighted
  //      <pre><code> blocks settle to their final height ~50–500ms
  //      after first render; line wrapping in the highlighted
  //      version often differs from the plain fallback.
  //   3. WKWebView (Tauri on macOS) sometimes skips repainting after
  //      a rapid DOM swap until an input event nudges it — which is
  //      exactly the "blank window → scroll a bit → content appears"
  //      symptom users hit. Assigning scrollTop to the same pixel
  //      it already was at gets optimized away and doesn't trigger
  //      paint either.
  //
  // Strategy: snap to bottom now (post-commit RAF), then watch the
  // inner content for height changes via ResizeObserver for a 500ms
  // window. Every height change inside the window re-snaps — that
  // catches both the SQLite restore commit and Shiki's
  // highlight-completion reflow. Each scrollTop write also serves
  // as a paint trigger for WKWebView.
  //
  // Bail out of the observer if the user scrolls away from bottom
  // during the window — they're reading older content and shouldn't
  // be yanked back. The existing scroll listener (above) keeps
  // `atBottom` in sync, mirrored here via atBottomRef.
  useEffect(() => {
    if (activeSessionId === undefined) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const rafId = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    });

    let observer: ResizeObserver | null = null;
    let timeoutId: number | null = null;
    const inner = el.firstElementChild;
    if (inner instanceof HTMLElement) {
      observer = new ResizeObserver(() => {
        if (!atBottomRef.current) {
          observer?.disconnect();
          observer = null;
          return;
        }
        el.scrollTop = el.scrollHeight;
      });
      observer.observe(inner);
      timeoutId = window.setTimeout(() => {
        observer?.disconnect();
        observer = null;
      }, 500);
    }

    return () => {
      cancelAnimationFrame(rafId);
      observer?.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [activeSessionId]);

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

  // ⌥↑ / ⌥↓ jump to previous / next user message. The user-msg
  // block is now a strong visual anchor (apricot fill, see 2026-05-14
  // commit) — power users in long conversations want a fast keyboard
  // path between their own questions without trackpad-scrolling
  // through dozens of agent steps.
  //
  // Bound to document, not the container — the conversation column
  // doesn't take focus naturally (it isn't tabbable). We bail out
  // when an editable element is focused so we don't steal Option+Up
  // from text-cursor-by-paragraph navigation inside Composer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          active.isContentEditable
        ) {
          return;
        }
      }

      const container = scrollContainerRef.current;
      if (!container) return;

      const userMsgs = Array.from(
        container.querySelectorAll<HTMLElement>('[data-role="user-msg"]'),
      );
      if (userMsgs.length === 0) return;

      const containerRect = container.getBoundingClientRect();
      const TOP_PADDING = 32;
      // ±8px tolerance so the message currently parked at ~32px
      // below container top doesn't count as both "above" and
      // "below" the cursor when rounding error nudges it.
      const TOLERANCE = 8;

      const tops = userMsgs.map(
        (el) => el.getBoundingClientRect().top - containerRect.top,
      );

      let target: HTMLElement | undefined;
      if (e.key === "ArrowDown") {
        // Next user-msg whose top is below the current anchor line.
        target = userMsgs.find((_, i) => tops[i] > TOP_PADDING + TOLERANCE);
      } else {
        // Previous user-msg whose top is above the current anchor line.
        for (let i = userMsgs.length - 1; i >= 0; i--) {
          if (tops[i] < TOP_PADDING - TOLERANCE) {
            target = userMsgs[i];
            break;
          }
        }
      }
      if (!target) return;

      e.preventDefault();
      const delta =
        target.getBoundingClientRect().top - containerRect.top - TOP_PADDING;
      container.scrollBy({ top: delta, behavior: "smooth" });
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-app">
      {/* Scrollable conversation column. Width follows the TopBar
          toggle: 760px (typography sweet spot) by default, 1200px
          in wide mode. Bottom stack matches — see MainViewProps doc
          for the lockstep rationale.

          Wrapped in `relative min-h-0 flex-1` so the UserQuestionRail
          (sibling below) can sit at the right edge of the visible
          conversation area without scrolling with content. The inner
          scrollContainerRef takes the flex extent via `absolute
          inset-0` — same scroll behavior as before; the wrapper just
          gives the rail a fixed-height parent to position against. */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        className="absolute inset-0 overflow-y-auto px-8 py-6"
      >
        <div
          className={cn(
            "mx-auto",
            conversationWidth === "wide" ? "max-w-[1200px]" : "max-w-[760px]",
          )}
        >
          <Conversation
            turns={turns}
            approvalDecisions={approvalDecisions}
            onApprove={onApprove}
            projectName={projectName}
            onResendUserMessage={(content) =>
              composerRef.current?.prefillText(content)
            }
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
                  projectName={projectName}
                />
              ))}
            </div>
          )}

          {/* In-flight placeholder. User sent a message; the bridge
              is dispatching but turn_end hasn't come back yet (LLM
              TTFT can be several seconds). Without this the
              conversation looks frozen. Hidden once an Approval Card
              shows up (already covers "agent waiting on you") OR
              once streaming content has begun (the partial render
              is itself the live signal).

              Renders as TurnMarker in thinking mode — same italic
              serif 12px register as the settled marker, just with
              "· 思考中" + TypingDots in place of the summary. Used
              to live inside a ThinkingSummary callout (bg-surface
              + bar) but that chrome was sized for multi-paragraph
              thinking content, not a one-liner "still working"
              line. Sharing visual register with TurnMarker collapses
              the before/after into one per-step rhythm. */}
          {isRunning && !stillWaiting && !visiblePartial && (
            // `key` ties the TurnMarker instance to the current step
            // (when known) so the elapsed clock inside resets when
            // the step changes — step 1 took 30s; step 2's clock
            // starts at 0 again. Falls back to "pending" while we
            // wait for the bridge's first `turn_start` to land
            // (synchronously-set `agentRunning` outruns it by a
            // few hundred ms); when `currentTurnIndex` arrives the
            // key flips, the placeholder remounts, and the clock
            // resets there too — which is fine since the user just
            // saw "思考中" for that brief window.
            <div>
              <TurnMarker
                key={currentTurnIndex ?? "pending"}
                index={currentTurnIndex ?? undefined}
                thinking
              />
              {livePreamble && <TurnTicker text={livePreamble} />}
            </div>
          )}

          {/* In-flight streaming partial (DESIGN.md §4.3 streaming
              generation). Renders the LLM's tokens as they arrive
              via turn_progress IPC events. Replaced by the canonical
              AgentTurn the moment turn_end fires (store clears
              inFlightContent in appendAgentTurn).
              StreamingCursor below the markdown gives liveness
              feedback during the gaps between GA's ~50-char delta
              pushes — without it the partial reads as "stalled"
              between chunks. Real fix needs token-level streaming
              from GA core; this is the UI-side mitigation. */}
          {isRunning && !stillWaiting && visiblePartial && (
            <div>
              {currentTurnIndex != null && (
                <TurnMarker index={currentTurnIndex} />
              )}
              {livePreamble && <TurnTicker text={livePreamble} />}
              {/* `typedPartial` is the typewriter-throttled view of
                  `visiblePartial`. The condition above gates on
                  visiblePartial (so the placeholder→partial swap
                  happens the instant GA's first chunk arrives, not
                  a frame later); the actual render uses typedPartial
                  so the content reveals character-by-character. */}
              <MarkdownView source={typedPartial} variant="agent" />
              <div className="mt-1 leading-none">
                <StreamingCursor />
              </div>
            </div>
          )}

          {/* GA-initiated question awaiting reply. Always at the
              conversation tail — by the time ask_user fires, the
              agent has EXITED its run loop so `isRunning` is false
              and the placeholder / streaming partial above won't
              render. Submitting (chip OR Composer text) clears this
              via store.appendUserTurn. */}
          {pendingAskUser && (
            <AskUserBubble
              pending={pendingAskUser}
              onPickCandidate={(text) => onSubmit?.(text)}
            />
          )}
        </div>
      </div>

        {/* Right-edge question index — one dot per user-msg, click to
            jump. Sibling of the scroll container (not inside it) so
            it doesn't scroll with content. Hidden under 3 user-msgs. */}
        <UserQuestionRail
          turns={turns}
          scrollContainerRef={scrollContainerRef}
        />
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

      {/* Bottom stack: dock + composer + hint. Matches the conversation
          column width in lockstep — see MainViewProps `conversationWidth`
          doc for why we don't keep this narrower. */}
      <div className="bg-app px-8 pb-4">
        <div
          className={cn(
            "mx-auto",
            conversationWidth === "wide" ? "max-w-[1200px]" : "max-w-[760px]",
          )}
        >
          <ApprovalDock
            pending={pendingApprovals}
            onAdvance={onAdvanceApproval}
          />

          <Composer
            ref={composerRef}
            llmDisplayName={llmDisplayName}
            placeholder={
              pendingAskUser
                ? "回复以继续，或选择上方候选"
                : "继续这个对话…"
            }
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
            <span>
              切换{" "}
              <IconTooltip text="Large Language Model · GPT / Claude / DeepSeek 等大语言模型的统称">
                <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-[3px]">
                  LLM
                </span>
              </IconTooltip>{" "}
              不会丢失上下文
            </span>
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
