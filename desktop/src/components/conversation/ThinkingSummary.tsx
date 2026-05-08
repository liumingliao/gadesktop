/**
 * Thinking summary — opens an agent turn. Per DESIGN.md §4.3:
 *
 *   - 💭 emoji anchor (the deliberate emoji exception in our otherwise
 *     Phosphor-only icon set; document-region Notion-style is OK)
 *   - font-serif italic 14px
 *   - 3px apricot left bar + 6% apricot tint background — adds the
 *     "this is the lead, not just commentary" weight the prototype
 *     introduced and DESIGN.md §11 will codify in the next patch.
 */
export function ThinkingSummary({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-3 flex items-start gap-2.5 rounded-r-[8px] border-l-[3px] border-brand bg-brand/[0.06] px-3.5 py-2.5 font-serif text-[14px] italic leading-[1.55] text-ink-soft">
      <span className="text-[14px] leading-none">💭</span>
      <span>{children}</span>
    </div>
  );
}
