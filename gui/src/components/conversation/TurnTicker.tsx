/**
 * Live preamble ticker — sits under the streaming-step TurnMarker
 * and shows the LLM's most recent "当前阶段：..." paragraph as it's
 * being written. Disappears once the step settles (turn_end fires →
 * MainView swaps in the settled TurnMarker + ToolCallout pills).
 *
 * Why this exists: in a long multi-step run the per-step `summary`
 * doesn't appear until turn_end, but the LLM is actively writing
 * preamble prose during the LLM call. Without a live surface, users
 * staring at the conversation see "思考中…" + a slowly-ticking elapsed
 * clock — no sense of *what* the agent is reasoning about. The ticker
 * gives a "process visible" signal without committing real estate to
 * a full expansion: capped at 3 lines via `line-clamp-3`, italic
 * muted register so it sits below the TurnMarker rather than
 * competing with it.
 *
 * Caller is expected to feed in the current preamble text — extracted
 * upstream from the raw streaming buffer via `extractPreamble`. We
 * don't reach for `inFlightContent` ourselves so the ticker stays
 * test-friendly and the streaming flow stays explicit in MainView.
 */
export function TurnTicker({ text }: { text: string }) {
  return (
    <div className="-mt-1 mb-2 line-clamp-3 overflow-hidden font-serif text-[11px] italic leading-[1.5] text-ink-muted">
      {text}
    </div>
  );
}
