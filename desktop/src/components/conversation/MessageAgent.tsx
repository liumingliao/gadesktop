/**
 * Final agent answer — Newsreader 16.5px, no callout chrome, "floats in
 * the document". Per DESIGN.md §4.3 + the prototype's msg-agent style.
 *
 * Inline `<code>` runs through font-mono with a subtle hover tint
 * background, matching DESIGN.md's mono register.
 *
 * Children take a string (markdown rendered by the caller) or already-
 * rendered ReactNodes. We don't bundle a markdown lib here — that's a
 * #3+ concern; for now the demo data passes plain strings or ReactNodes.
 */
export function MessageAgent({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-3.5 font-serif text-[16.5px] leading-[1.7] tracking-[0.005em] text-ink [&_code]:rounded-[4px] [&_code]:bg-hover [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[14px] [&_code]:text-ink-soft [&_p]:mb-3 [&_p:last-child]:mb-0">
      {children}
    </div>
  );
}
