import * as Tooltip from "@radix-ui/react-tooltip";
import { PauseCircle } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { PendingAskUser } from "@/types/conversation";

/**
 * Chip max display length before truncating with ellipsis. Longer
 * candidates still send their full text on click — only the visual
 * is shortened. A tooltip surfaces the full value on hover.
 */
const CHIP_MAX_CHARS = 40;

export interface AskUserBubbleProps {
  pending: PendingAskUser;
  /** Called with the full candidate text (or composer text in the
   * caller's own onSubmit path). The caller is responsible for
   * dispatching `ask_user_response` over IPC + clearing the pending
   * state — this component is presentational. */
  onPickCandidate: (candidateText: string) => void;
  /** When true, chips are disabled (e.g. bridge not connected). */
  disabled?: boolean;
}

/**
 * GA-initiated question awaiting a user reply.
 *
 * Anchored at the conversation tail when `pendingAskUser` is non-null
 * on the active session. Visual distinction from regular assistant
 * messages: warning-tinted left bar + PauseCircle icon, so the user
 * understands "the agent has stopped, the ball is in your court".
 * Candidates render as clickable chips; the Composer below remains
 * fully open for free-form replies (the caller wires both paths into
 * the same `ask_user_response` IPC command).
 *
 * Persistence: NOT in turns[]; lives in transient runtime state. On
 * app restart the chips disappear but the question itself remains
 * visible in the assistant's preceding turn content (the LLM usually
 * narrates the question before calling ask_user), so the user can
 * still answer via the Composer.
 */
export function AskUserBubble({
  pending,
  onPickCandidate,
  disabled = false,
}: AskUserBubbleProps) {
  return (
    <div
      data-role="ask-user-bubble"
      className="my-5 rounded-r-[6px] border-l-[3px] border-warning bg-warning/[0.04] px-4 py-2.5"
    >
      <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-warning">
        <PauseCircle size={12} weight="bold" />
        等你回复
      </div>
      <div className="mb-3 whitespace-pre-wrap text-[15px] leading-[1.65] text-ink">
        {pending.question}
      </div>
      {pending.candidates.length > 0 && (
        <Tooltip.Provider delayDuration={200}>
          <div className="flex flex-wrap gap-1.5">
            {pending.candidates.map((c, i) => (
              <CandidateChip
                key={`${i}-${c}`}
                text={c}
                onClick={() => onPickCandidate(c)}
                disabled={disabled}
              />
            ))}
          </div>
        </Tooltip.Provider>
      )}
    </div>
  );
}

function CandidateChip({
  text,
  onClick,
  disabled,
}: {
  text: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const truncated =
    text.length > CHIP_MAX_CHARS ? text.slice(0, CHIP_MAX_CHARS - 1) + "…" : text;
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-sm border border-line bg-surface px-2.5 py-1 text-[12.5px] text-ink-soft transition-colors",
        "hover:border-warning hover:bg-warning/10 hover:text-ink",
        disabled && "cursor-not-allowed opacity-50 hover:bg-surface hover:text-ink-soft",
      )}
    >
      {truncated}
    </button>
  );
  // Skip the Tooltip wrapper when not truncated — keeps the DOM
  // lean for the common short-candidate case.
  if (truncated === text) return button;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={4}
          className="z-50 max-w-[320px] rounded-sm border border-line bg-elevated px-2 py-1 text-[12px] text-ink shadow-card"
        >
          {text}
          <Tooltip.Arrow className="fill-elevated" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
