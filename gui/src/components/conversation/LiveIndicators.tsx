import { cn } from "@/lib/utils";

/**
 * Three-dot typing indicator (ChatGPT / Claude / Telegram pattern).
 * Used as the trailing affordance after "思考中" while GA hasn't
 * pushed its first partial chunk yet — without it, the placeholder
 * line reads as static even when the agent is actively working.
 *
 * CSS-driven: `.typing-dot` keyframes live in `styles/globals.css`.
 * Three children with the same class get :nth-child stagger so the
 * dots pulse in sequence.
 */
export function TypingDots() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-flex translate-y-[-1px] gap-[2px] align-baseline"
    >
      <span className="typing-dot">.</span>
      <span className="typing-dot">.</span>
      <span className="typing-dot">.</span>
    </span>
  );
}

/**
 * Blinking cursor appended to mid-turn streaming content. GA throttles
 * its display_queue to push ~50-char deltas, which without this
 * affordance creates the "chunk appears, then dead silence, then
 * another chunk" experience the user reported. The cursor keeps a
 * liveness signal on screen during the gap between pushes.
 *
 * Real fix (token-level streaming) requires a GA-side change —
 * tracked separately. This is the UI-side mitigation only.
 *
 * Width 2px / height 1em matches a thin caret; brand-tinted at 70%
 * so it reads as agentic, not a system caret.
 */
export function StreamingCursor({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "streaming-cursor ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-brand-strong/70 align-baseline",
        className,
      )}
    />
  );
}
