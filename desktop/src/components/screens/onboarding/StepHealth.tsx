import { ArrowLeft, ArrowRight, Info } from "@phosphor-icons/react";

import { HealthCheckCard } from "@/components/health-check/HealthCheckCard";
import { cn } from "@/lib/utils";
import type { HealthCheckItem } from "@/types/inspector";

interface StepHealthProps {
  items: HealthCheckItem[];
  onBack: () => void;
  onContinue: () => void;
  /**
   * Action handler for failed-row inline buttons. The Onboarding
   * controller maps action ids back to specific behaviors (open
   * docs, change path, retry).
   */
  onItemAction?: (item: HealthCheckItem, action: string) => void;
  itemActions?: Record<string, { id: string; label: string }[]>;
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
  onItemAction,
  itemActions,
}: StepHealthProps) {
  const allPassed =
    items.length > 0 && items.every((c) => c.state === "success");

  return (
    <div className="max-w-[580px]">
      <h1 className="m-0 font-serif text-[32px] font-medium leading-tight tracking-[0.005em] text-ink">
        检查 GA 运行环境
      </h1>
      <p className="mb-7 mt-2.5 font-serif text-[15.5px] italic leading-[1.55] text-ink-soft">
        全部通过后才能进入主界面 · Workbench 不会修改你的 GA。
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
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!allPassed}
          className={cn(
            "ml-auto inline-flex items-center gap-2 rounded-sm border border-ink bg-ink px-5 py-2 text-[13.5px] font-medium text-elevated transition-colors hover:bg-ink/90",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          进入 Workbench
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>
    </div>
  );
}
