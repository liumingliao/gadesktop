/**
 * User message — Inter 500, left 2px muted bar (PRD §13.2 "user vs
 * agent three-way distinction"). NOT a chat bubble; this is a document.
 *
 * Per DESIGN.md §4.3:
 *   - font-sans 15px medium
 *   - left border 2px text-ink-muted
 *   - left padding 16px from the bar
 */
export function MessageUser({ content }: { content: string }) {
  return (
    <div className="my-4 border-l-2 border-ink-muted py-1 pl-4 text-[15px] font-medium leading-[1.65] text-ink">
      {content}
    </div>
  );
}
