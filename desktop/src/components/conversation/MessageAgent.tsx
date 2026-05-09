import { isValidElement, type ReactNode } from "react";

import { MarkdownView } from "@/components/conversation/MarkdownView";
import { MessageActions } from "@/components/conversation/MessageActions";

/**
 * Final agent answer — Newsreader 16.5px, no callout chrome, "floats
 * in the document". Per DESIGN.md §4.3 + the prototype's msg-agent
 * style.
 *
 * Markdown rendering: a `string` child is parsed via react-markdown
 * + remark-gfm + Shiki (see MarkdownView). A pre-built ReactNode
 * passes through unchanged so demo fixtures and tests can still
 * inject hand-built content.
 *
 * Message actions (Copy / Save): rendered below the markdown when
 * we have a string source (i.e. a real LLM reply). ReactNode demo
 * children skip them — there's no canonical markdown source to copy
 * back out, and demos rarely need actions.
 */
export function MessageAgent({ children }: { children: ReactNode }) {
  if (typeof children === "string") {
    return (
      <div>
        <MarkdownView source={children} variant="agent" />
        <MessageActions source={children} />
      </div>
    );
  }
  // Already-rendered ReactNodes (demo / tests / future inline edit).
  // We fall back to the same outer wrapper styles as the markdown
  // path so the visual register is identical regardless of source.
  return (
    <div className="font-serif text-[16.5px] leading-[1.7] tracking-[0.005em] text-ink [&_code]:rounded-[4px] [&_code]:bg-hover [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[14px] [&_code]:text-ink-soft [&_p]:mb-3 [&_p:last-child]:mb-0">
      {/* Trivial guard: undefined / null children render nothing.
          isValidElement is here to make it explicit that React
          elements are intentional pass-throughs. */}
      {isValidElement(children) || children !== undefined ? children : null}
    </div>
  );
}
