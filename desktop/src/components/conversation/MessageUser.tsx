/**
 * User message — document-style callout, NOT a chat bubble.
 *
 * Per DESIGN.md §4.3 (as amended 2026-05-14):
 *   - font-sans 15px medium
 *   - left border 3px brand-strong (apricot) — primary visual anchor
 *     for scroll-back. In long conversations users navigate by their
 *     own questions; the brand bar makes each user turn a strong
 *     "checkpoint" in the scroll.
 *   - bg-brand-soft (solid) — apricot tint matching the Sidebar
 *     active-row / filter-banner / ApprovalDock vocabulary. "I'm
 *     in focus" is a single visual language across the product;
 *     the user's own turns sit in the same family. Still a
 *     document callout (full-width, left-anchored), not an IM
 *     bubble.
 *   - rounded-r-[6px] — softens the trailing edge into a callout
 *     shape (a touch less round than ThinkingSummary's 8px so the
 *     hierarchy reads user > thinking).
 *
 * `data-role="user-msg"` is a stable anchor that MainView's scroll
 * effect uses to find the just-submitted user message and snap its
 * top edge to ~32px below the viewport top. Don't rename without
 * updating MainView's selector.
 */
export function MessageUser({ content }: { content: string }) {
  return (
    <div
      data-role="user-msg"
      className="my-5 rounded-r-[6px] border-l-[3px] border-brand-strong bg-brand-soft px-4 py-2.5 text-[15px] font-medium leading-[1.65] text-ink"
    >
      {content}
    </div>
  );
}
