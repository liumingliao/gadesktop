import { ApprovalDock } from "@/components/conversation/ApprovalDock";
import { Composer } from "@/components/conversation/Composer";
import { Conversation } from "@/components/conversation/Conversation";
import type { PendingApproval, Turn } from "@/types/conversation";
import type { ApprovalDecision } from "@/types/ipc";

export interface MainViewProps {
  turns: Turn[];
  llmDisplayName: string;
  pendingApprovals?: PendingApproval[];
  approvalDecisions?: Record<string, ApprovalDecision>;
  onSubmit?: (text: string) => void;
  onApprove?: (approvalId: string, decision: ApprovalDecision) => void;
  onAdvanceApproval?: (next: PendingApproval) => void;
  onStop?: () => void;
  /** When true, the agent is mid-run; the Composer hides Submit and
   * shows Stop, the LLM switcher disables. */
  isRunning?: boolean;
}

/**
 * Main view — the in-session screen. Per DESIGN.md §3 layout floor +
 * §4.3 conversation document + §4.6 approval dock + §4.4 composer.
 *
 * Three vertical regions, all aligned to a 760px reading column:
 *
 *   Conversation (scrollable, takes the bleeding flex-1 space)
 *   Approval Dock (sticky-ish, only renders when pending)
 *   Composer + keyboard hint row
 *
 * Title / runtime / inspector toggle live in the AppShell-level Top
 * Bar; nothing chrome-y belongs here.
 */
export function MainView({
  turns,
  llmDisplayName,
  pendingApprovals = [],
  approvalDecisions,
  onSubmit,
  onApprove,
  onAdvanceApproval,
  onStop,
  isRunning = false,
}: MainViewProps) {
  const stillWaiting = pendingApprovals.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      {/* Scrollable conversation column */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[760px]">
          <Conversation
            turns={turns}
            approvalDecisions={approvalDecisions}
            onApprove={onApprove}
          />
          {stillWaiting && (
            <div className="mt-4 pl-1 font-serif text-[13px] italic text-ink-muted">
              等待审批中 · agent 已暂停在 dispatch
            </div>
          )}
        </div>
      </div>

      {/* Bottom stack: dock + composer + hint */}
      <div className="bg-app px-8 pb-4">
        <div className="mx-auto max-w-[760px]">
          <ApprovalDock
            pending={pendingApprovals}
            onAdvance={onAdvanceApproval}
          />

          <Composer
            llmDisplayName={llmDisplayName}
            placeholder="继续这个对话…"
            onSubmit={onSubmit}
            stopMode={isRunning}
            onStop={onStop}
            disabled={false}
          />

          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-muted">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span>切换 LLM 不会丢失上下文</span>
          </div>
        </div>
      </div>
    </div>
  );
}
