import { ArrowRight, Pause } from "@phosphor-icons/react";

import type { PendingApproval } from "@/types/conversation";

export interface ApprovalDockProps {
  /** All currently pending approvals; component renders nothing when empty. */
  pending: PendingApproval[];
  /** "Advance" handler — scroll the conversation to the next pending
   * callout (or focus its decision buttons). Wired up in #4. */
  onAdvance?: (next: PendingApproval) => void;
}

/**
 * Sticky bar above the Composer when one or more approvals are pending.
 * Per DESIGN.md §4.6.
 *
 *   - amber-tint background + 3px deep-amber left bar
 *   - shows count + next tool + advance button
 *   - NOT dismissable (must-process state must remain surfaced)
 *   - hovering the row should preview the tool — V0.2 (tooltip)
 *   - clicking advance is a navigator action, not a decider; the
 *     decision still has to happen in the callout's ApprovalForm
 *
 * Returns null when no approvals pending; the parent doesn't have to
 * worry about an empty wrapper.
 */
export function ApprovalDock({ pending, onAdvance }: ApprovalDockProps) {
  if (pending.length === 0) return null;
  const next = pending[0];

  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-warning/30 border-l-[3px] border-l-warning bg-brand-soft px-3.5 py-2.5 text-[13px] text-ink">
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <Pause size={14} weight="thin" className="text-warning" />
        {pending.length} pending approval{pending.length > 1 ? "s" : ""}
      </span>

      <span className="text-[12.5px] text-ink-soft">
        Next:{" "}
        <span className="rounded-[4px] bg-hover px-1.5 py-px font-mono text-[12px] text-ink-soft">
          {next.toolName}
        </span>
        {next.target && (
          <>
            {" on "}
            <span className="rounded-[4px] bg-hover px-1.5 py-px font-mono text-[12px] text-ink-soft">
              {next.target}
            </span>
          </>
        )}
      </span>

      <button
        type="button"
        onClick={() => onAdvance?.(next)}
        className="ml-auto inline-flex items-center gap-1.5 rounded-sm border border-transparent px-3 py-1 text-[12.5px] font-medium text-ink transition-colors hover:bg-hover"
      >
        Advance
        <ArrowRight size={12} weight="thin" />
      </button>
    </div>
  );
}
