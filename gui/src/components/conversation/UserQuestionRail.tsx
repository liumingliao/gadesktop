import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { Turn } from "@/types/conversation";

/**
 * Right-edge "question index" rail — one dot per user message in the
 * conversation, positioned proportionally to where that user-msg sits
 * inside the scroll content. Solves the long-conversation "I need to
 * find a question I asked 30 turns ago" navigation pain that ⌥↑/⌥↓
 * (linear keyboard step) and apricot user-msg anchors (visual scan)
 * only partially address.
 *
 * Position model:
 *   - Each dot at `(userMsg.offsetTop / scrollContent.scrollHeight) * 100%`
 *     of the rail's vertical extent. Adjacent user-msgs in agent-heavy
 *     stretches naturally spread apart on the rail; clusters of
 *     follow-up questions show as adjacent dots. Mirrors the native
 *     scrollbar's position semantics.
 *   - "Active" dot = the topmost user-msg whose top is at or above the
 *     viewport's TOP_PADDING anchor line (matches the same line MainView
 *     uses for submit-snap and ⌥↑/⌥↓).
 *
 * Click jumps to that user-msg via the same scrollBy delta pattern as
 * MainView's keyboard nav (no jarring instant jump, no scroll-into-view
 * blocked-by-flex-parent gotcha).
 *
 * Hover (and keyboard focus) reveals a tooltip on the left with the
 * first 50 chars of the question, so users don't have to click-guess
 * which dot is which.
 *
 * Hidden under 3 user-msgs — short conversations don't need an index.
 *
 * Anchored DOM: queries `[data-role="user-msg"]` from the passed
 * scroll container ref. That selector is the same stable hook
 * `MessageUser.tsx` exposes and `MainView` already uses for
 * userSubmitTick / ⌥↑/⌥↓ scroll math — DOM order matches the order of
 * `role === "user"` turns in the `turns` array, so indices align 1:1.
 */
const TOP_PADDING = 32;
const MIN_USER_MSGS_TO_SHOW = 3;
const PREVIEW_CHARS = 50;

interface UserQuestionRailProps {
  turns: Turn[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

interface DotPosition {
  /** Index into the array of user-msgs (matches DOM order and the
   * filtered userContents array). */
  index: number;
  /** Truncated content for the hover tooltip. */
  preview: string;
  /** Vertical position within the rail, expressed as % of
   * scroll-content height — the same axis the native scrollbar uses. */
  topPercent: number;
}

export function UserQuestionRail({
  turns,
  scrollContainerRef,
}: UserQuestionRailProps) {
  // Extract user-msg text in turn order. Indices in this array
  // align with the [data-role="user-msg"] DOM nodes inside the
  // scroll container — Conversation.tsx renders one MessageUser per
  // UserTurn in `turns` order.
  const userContents = useMemo(
    () => turns.flatMap((t) => (t.role === "user" ? [t.content] : [])),
    [turns],
  );

  const [dotPositions, setDotPositions] = useState<DotPosition[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  // Re-measure dot positions on layout commits. ResizeObserver covers
  // streaming chunks growing the content, Shiki settling code blocks,
  // and window resizes. useLayoutEffect runs before paint so the rail
  // never shows stale positions for a frame after content changes.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const measure = () => {
      const userMsgs = container.querySelectorAll<HTMLElement>(
        '[data-role="user-msg"]',
      );
      const scrollHeight = container.scrollHeight;
      if (scrollHeight === 0 || userMsgs.length === 0) {
        setDotPositions([]);
        return;
      }
      const positions: DotPosition[] = [];
      userMsgs.forEach((el, i) => {
        const topPercent = (el.offsetTop / scrollHeight) * 100;
        const raw = userContents[i] ?? "";
        const preview =
          raw.length > PREVIEW_CHARS
            ? raw.slice(0, PREVIEW_CHARS).trimEnd() + "…"
            : raw;
        positions.push({ index: i, topPercent, preview });
      });
      setDotPositions(positions);
    };

    measure();

    const observer = new ResizeObserver(measure);
    const inner = container.firstElementChild;
    if (inner instanceof HTMLElement) observer.observe(inner);

    return () => observer.disconnect();
  }, [scrollContainerRef, userContents]);

  // Track which dot is "current" — the most recent user-msg whose
  // top is at or above the viewport's TOP_PADDING anchor (where
  // MainView parks user-msgs after submit / keyboard nav). Same
  // 8px tolerance as MainView's ⌥↑/⌥↓ math so the boundary feels
  // identical.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      const userMsgs = container.querySelectorAll<HTMLElement>(
        '[data-role="user-msg"]',
      );
      if (userMsgs.length === 0) return;
      const anchorTop = container.scrollTop + TOP_PADDING + 8;
      let last = -1;
      userMsgs.forEach((el, i) => {
        if (el.offsetTop <= anchorTop) last = i;
      });
      setActiveIndex(last);
    };

    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, userContents]);

  if (userContents.length < MIN_USER_MSGS_TO_SHOW) return null;

  const handleJump = (idx: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const userMsgs = container.querySelectorAll<HTMLElement>(
      '[data-role="user-msg"]',
    );
    const target = userMsgs[idx];
    if (!target) return;
    const delta =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      TOP_PADDING;
    container.scrollBy({ top: delta, behavior: "smooth" });
  };

  return (
    <div
      role="navigation"
      aria-label="提问索引"
      className="pointer-events-none absolute right-1.5 top-6 bottom-6 z-10 w-5"
    >
      <div className="relative h-full">
        {/* Hairline spine — 1px line-subtle vertical, centered under
            the dot column, runs full rail height. Threads the dots
            into a single visual group instead of a loose constellation.
            Layered behind the dots: inactive rings let it show through
            their transparent center (reads as a quiet through-line),
            active filled discs sit on top and break it visually
            wherever the user currently is. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-line-subtle"
        />
        {dotPositions.map((dot) => (
          <div
            key={dot.index}
            className="group pointer-events-auto absolute right-0 -translate-y-1/2"
            style={{ top: `${dot.topPercent}%` }}
          >
            <button
              type="button"
              onClick={() => handleJump(dot.index)}
              aria-label={`跳到第 ${dot.index + 1} 条提问`}
              className="grid size-5 place-items-center focus:outline-none"
            >
              {/* Active = filled apricot disc; inactive = hollow ring.
                  Single-axis state (fill vs no-fill) at fixed 8px
                  size — same visual weight slot for both states, the
                  ink reading does all the work. */}
              <span
                className={cn(
                  "block size-2 rounded-full border-[1.5px] transition-colors",
                  dot.index === activeIndex
                    ? "border-brand-strong bg-brand-strong"
                    : "border-line-strong bg-transparent group-hover:border-ink-soft",
                )}
              />
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute right-full top-1/2 z-10 mr-2 flex max-w-[320px] -translate-y-1/2 items-baseline gap-1.5 truncate whitespace-nowrap rounded-sm border border-line bg-elevated px-2 py-1 text-[11.5px] text-ink-soft opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <span className="font-mono text-[10.5px] text-ink-muted">
                {dot.index + 1}
              </span>
              <span className="truncate">{dot.preview}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
