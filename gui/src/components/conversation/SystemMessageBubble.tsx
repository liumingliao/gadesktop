import { ChatCircleDots, Info } from "@phosphor-icons/react";

import { MarkdownView } from "@/components/conversation/MarkdownView";

/**
 * Standalone, non-agent-loop message — currently used for `/btw`
 * side-question replies (variant=`"side_question"`) and any future
 * slash-command confirmations like `/session.x=v`
 * (variant=`"system"`).
 *
 * Visual register splits by variant:
 *   - "side_question": warning (apricot-yellow) family —
 *     `border-warning + bg-warning/[0.04]`, header chip "侧问".
 *     Matches AskUserBubble's color vocabulary because both
 *     "你的提问" and "agent paused for you" sit in the same
 *     attention register.
 *   - "system": neutral — `border-ink-soft + bg-surface`. Catch-
 *     all for non-attention-seeking confirmations.
 *
 * Content is markdown source (the formatted reply from GA's
 * btw_cmd, or whatever the system handler emitted). We render
 * through MarkdownView so code fences / tables / emphasis all
 * resolve, with the variant=`"agent"` register inside the bubble
 * chrome.
 */
interface SystemMessageBubbleProps {
  content: string;
  variant: "side_question" | "system";
}

export function SystemMessageBubble({
  content,
  variant,
}: SystemMessageBubbleProps) {
  if (variant === "side_question") {
    return (
      <div
        data-role="system-bubble"
        className="my-5 rounded-r-[6px] border-l-[3px] border-warning bg-warning/[0.04] px-4 py-2.5"
      >
        <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-warning">
          <ChatCircleDots size={12} weight="bold" />
          侧问
        </div>
        <MarkdownView source={content} variant="agent" />
      </div>
    );
  }
  return (
    <div
      data-role="system-bubble"
      className="my-5 rounded-r-[6px] border-l-[3px] border-ink-soft bg-surface px-4 py-2.5"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-muted">
        <Info size={12} weight="bold" />
        系统
      </div>
      <MarkdownView source={content} variant="agent" />
    </div>
  );
}
