import { useEffect, useState } from "react";

/**
 * Fake typewriter for streaming content. Given a `source` string
 * that grows over time (e.g. accumulated LLM partial), reveals
 * characters progressively via requestAnimationFrame so the UI
 * reads as smooth token-by-token typing — even when the upstream
 * pushes content in larger chunks.
 *
 * Motivation: GA's `agentmain.py` throttles its display_queue to
 * push deltas only when the accumulated response crosses ~50
 * chars. The desktop receives "chunk, pause, chunk" instead of
 * smooth streaming. The real fix is a GA-side change to make the
 * threshold configurable; this hook is the front-end mitigation
 * while that's pending.
 *
 * Behavior:
 *   - `source` grows monotonically (each new chunk appends to the
 *     end) → revealed creeps forward at `charsPerFrame` per raf
 *     tick until it catches up, then idles.
 *   - `source` resets to "" (turn boundary, store clears
 *     inFlightContent) → revealed snaps to "" on the next frame.
 *   - `source` swaps to a different string that doesn't extend
 *     the current revealed prefix → revealed snaps to source.
 *     Avoids the typewriter visibly "rewinding".
 *
 * Tuning: `charsPerFrame = 3` ≈ 180 chars/s at 60fps. Slow enough
 * to read as typing, fast enough to clear GA's ~50-char chunk in
 * ~280ms — so normal LLM cadence keeps the typewriter just behind
 * the source, which is the right perceived rhythm.
 *
 * Performance: each frame triggers one re-render of the consuming
 * component. Tolerable up to a few thousand characters per turn
 * when wrapped around MarkdownView.
 */
export function useTypewriter(source: string, charsPerFrame = 3): string {
  const [revealed, setRevealed] = useState(source);

  useEffect(() => {
    // `source` is captured by closure; the effect re-runs whenever
    // it changes (each new chunk → new effect with the latest
    // target). The cleanup cancels the prior loop's raf, so we
    // never overlap two loops racing on the same setState.
    let rafId: number | null = null;
    const step = () => {
      // setState writes happen here (inside the raf callback), not
      // in the effect body — react-hooks/set-state-in-effect lint
      // permits the deferred path.
      setRevealed((current) => {
        // Hard-reset paths: empty source (turn boundary), or
        // discontinuous swap (revealed is no longer a prefix of
        // source, or source shorter than revealed). Snap immediately
        // instead of rewinding visibly.
        if (
          source === "" ||
          !source.startsWith(current) ||
          source.length < current.length
        ) {
          rafId = null;
          return source;
        }
        if (current.length >= source.length) {
          // Caught up — idle until source grows again or effect
          // re-runs.
          rafId = null;
          return current;
        }
        const nextLen = Math.min(current.length + charsPerFrame, source.length);
        rafId = requestAnimationFrame(step);
        return source.slice(0, nextLen);
      });
    };
    rafId = requestAnimationFrame(step);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [source, charsPerFrame]);

  return revealed;
}
