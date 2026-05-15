import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Info,
} from "@phosphor-icons/react";

import { HealthCheckCard } from "@/components/health-check/HealthCheckCard";
import { cn } from "@/lib/utils";
import type { HealthCheckItem } from "@/types/inspector";

interface StepHealthProps {
  items: HealthCheckItem[];
  onBack: () => void;
  onContinue: () => void;
  /**
   * Re-run the health checks against the current path. Surfaced as a
   * "重新检查" button next to Back when not all checks have passed —
   * lets the user fix files externally (e.g. create mykey.py) and
   * re-verify without going Back → Continue to re-enter the step.
   */
  onRetry?: () => void;
  /**
   * Action handler for failed/warning-row inline buttons. The
   * Onboarding controller maps action ids back to specific behaviors
   * (open tutorial modal, change path, etc).
   */
  onItemAction?: (item: HealthCheckItem, action: string) => void;
  itemActions?: Record<string, { id: string; label: string }[]>;
  /** Override "Back" button label. Used by the Settings revisit flow
   * to relabel as "取消" (since there's no Attach step to go back to —
   * Back is really cancellation). Default: "Back". */
  backLabel?: string;
  /** Override "进入 Galley" button label. Used by Settings revisit
   * flow to relabel as "返回 Settings". Default: "进入 Galley". */
  continueLabel?: string;
}

/**
 * Onboarding Step 2 — Health Check. DESIGN.md §5 Step 2.
 *
 * Five-row health check, all must pass before "Continue" is enabled.
 * No "skip" option — a Workbench without a working LLM has nothing
 * to do, so we don't pretend read-only mode is useful (DESIGN.md §5
 * "故意决策").
 *
 * The dry-run-skipped explanation lives at the bottom in a quiet info
 * box so users with quota concerns understand why we don't validate
 * the LLM session itself here.
 */
export function StepHealth({
  items,
  onBack,
  onContinue,
  onRetry,
  onItemAction,
  itemActions,
  backLabel = "Back",
  continueLabel = "进入 Galley",
}: StepHealthProps) {
  const allPassed =
    items.length > 0 && items.every((c) => c.state === "success");
  const settled =
    items.length > 0 &&
    items.every((c) => c.state !== "pending" && c.state !== "running");

  return (
    <div className="max-w-[580px]">
      <h1 className="m-0 font-serif text-[32px] font-medium leading-tight tracking-[0.005em] text-ink">
        检查 GA 运行环境
      </h1>
      <p className="mb-7 mt-2.5 font-serif text-[15.5px] italic leading-[1.55] text-ink-soft">
        全部通过后才能进入主界面 · Galley 不会修改你的 GA。
      </p>

      <HealthCheckCard
        items={items}
        variant="standalone"
        onItemAction={onItemAction}
        itemActions={itemActions}
      />

      <div className="mt-7 flex items-start gap-2.5 rounded-[8px] border border-line bg-surface p-3.5 text-[12.5px] leading-[1.55] text-ink-soft">
        <Info
          size={14}
          weight="thin"
          className="mt-0.5 shrink-0 text-ink-muted"
        />
        <div>
          跳过了 LLM 连接测试以节省费用。第一次发送消息时如有问题
          会提示具体错误并给出修复路径。
        </div>
      </div>

      <div className="mt-7 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <ArrowLeft size={13} weight="thin" />
          {backLabel}
        </button>
        {onRetry && settled && !allPassed && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-sm border border-line px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
          >
            <ArrowClockwise size={12} weight="thin" />
            重新检查
          </button>
        )}
        <button
          type="button"
          onClick={onContinue}
          disabled={!allPassed}
          className={cn(
            "ml-auto inline-flex items-center gap-2 rounded-sm border border-ink bg-ink px-5 py-2 text-[13.5px] font-medium text-elevated transition-colors hover:bg-ink/90",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          {continueLabel}
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>
    </div>
  );
}
