import {
  Check,
  CircleNotch,
  Pause,
  ShieldCheck,
  Warning,
  X,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { HealthCheckItem, HealthCheckState } from "@/types/inspector";

export interface HealthCheckCardProps {
  items: HealthCheckItem[];

  /**
   * Visual treatment:
   *
   *   standalone — full card chrome (surface-elevated bg, border,
   *                shadow, header with title + status pill). Used in
   *                Onboarding Step 2, Top Bar runtime popover, and
   *                Settings → Runtime → Re-run.
   *   embedded   — no card chrome (rows only). Used inside Inspector →
   *                Runtime tab where the surrounding panel already
   *                provides chrome.
   */
  variant?: "standalone" | "embedded";

  /** Title override; defaults to "Health Check". */
  title?: string;

  /**
   * Action callback for a failed item. The Card surfaces inline action
   * buttons under failed rows ("打开 GA 安装指南" / "选择其他路径" /
   * "View details") — the parent decides what each action means. The
   * action string is a stable id chosen by the action contributor.
   */
  onItemAction?: (item: HealthCheckItem, action: string) => void;

  /**
   * Per-item action map. Keyed by check name. Each entry is a list of
   * action buttons to show under the row when expanded. Defaults to
   * empty (no actions surfaced).
   */
  itemActions?: Record<string, ItemAction[]>;

  /**
   * Show counts of `Fix N issue(s)` / `All checks passed` etc. below
   * the rows. Default true for standalone, false for embedded.
   */
  showFooter?: boolean;
}

interface ItemAction {
  id: string;
  label: string;
}

/**
 * The Health Check Card — single component that powers all five
 * appearance contexts per DESIGN.md §6.1:
 *
 *   1. Onboarding Step 2 (standalone, blocking)
 *   2. Inspector → Runtime tab (embedded)
 *   3. Top Bar runtime row → popover (standalone)
 *   4. Settings → Runtime → Re-run (standalone)
 *   5. System auto-popup on GA anomaly (standalone)
 *
 * Six row states (pending / running / success / failed / warning /
 * blocked) follow the icon mapping in DESIGN.md §6.1; failed rows can
 * surface inline action buttons (provided by the parent via
 * itemActions) for "fix this and continue" workflows in Onboarding.
 */
export function HealthCheckCard({
  items,
  variant = "standalone",
  title = "Health Check",
  onItemAction,
  itemActions = {},
  showFooter,
}: HealthCheckCardProps) {
  const summary = summarize(items);
  const renderFooter = showFooter ?? variant === "standalone";

  if (variant === "embedded") {
    return (
      <div>
        {items.map((item) => (
          <HealthRow
            key={item.name}
            item={item}
            actions={itemActions[item.name] ?? []}
            onAction={(action) => onItemAction?.(item, action)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-line bg-elevated p-5 shadow-card">
      <div className="mb-1 flex items-center gap-2.5 border-b border-line pb-3">
        <ShieldCheck size={18} weight="thin" className="text-ink" />
        <div className="text-[14px] font-medium text-ink">{title}</div>
        <SummaryPill summary={summary} className="ml-auto" />
      </div>

      <div>
        {items.map((item, idx) => (
          <HealthRow
            key={item.name}
            item={item}
            index={idx + 1}
            total={items.length}
            actions={itemActions[item.name] ?? []}
            onAction={(action) => onItemAction?.(item, action)}
          />
        ))}
      </div>

      {renderFooter && (
        <div className="mt-3 border-t border-line pt-3 text-[12.5px] text-ink-soft">
          {summary.failed > 0
            ? `修复 ${summary.failed} 个问题后继续`
            : summary.running > 0
              ? "正在检查最后一项…"
              : "全部检查通过"}
        </div>
      )}
    </div>
  );
}

// ---------------- internals ----------------

function HealthRow({
  item,
  index,
  total,
  actions,
  onAction,
}: {
  item: HealthCheckItem;
  index?: number;
  total?: number;
  actions: ItemAction[];
  onAction: (action: string) => void;
}) {
  const showActions = item.state === "failed" && actions.length > 0;

  return (
    <div className="border-b border-line py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="inline-flex shrink-0">
          <RowIcon state={item.state} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] text-ink">{item.name}</div>
          {item.detail && (
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-muted">
              {item.detail}
            </div>
          )}
        </div>
        {index !== undefined && total !== undefined && (
          <span className="text-[11px] text-ink-muted">
            {index} / {total}
          </span>
        )}
      </div>

      {showActions && (
        <div className="ml-[26px] mt-2 flex flex-wrap gap-2">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onAction(a.id)}
              className="inline-flex items-center gap-1 rounded-sm border border-line px-2.5 py-1 text-[12px] font-medium text-brand-strong transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RowIcon({ state }: { state: HealthCheckState }) {
  const size = 16;
  switch (state) {
    case "success":
      return <Check size={size} weight="thin" className="text-success" />;
    case "failed":
      return <X size={size} weight="thin" className="text-error" />;
    case "warning":
      return <Warning size={size} weight="thin" className="text-warning" />;
    case "running":
      return (
        <span className="spin">
          <CircleNotch
            size={size}
            weight="thin"
            className="text-brand-strong"
          />
        </span>
      );
    case "blocked":
      return <Pause size={size} weight="thin" className="text-ink-muted" />;
    case "pending":
    default:
      return (
        <span
          className="inline-block size-2 rounded-full bg-ink-muted/60"
          aria-hidden
        />
      );
  }
}

interface Summary {
  total: number;
  passed: number;
  failed: number;
  running: number;
  pending: number;
}

function summarize(items: HealthCheckItem[]): Summary {
  let passed = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;
  for (const i of items) {
    if (i.state === "success") passed++;
    else if (i.state === "failed") failed++;
    else if (i.state === "running") running++;
    else pending++;
  }
  return { total: items.length, passed, failed, running, pending };
}

function SummaryPill({
  summary,
  className,
}: {
  summary: Summary;
  className?: string;
}) {
  const isAllPassed = summary.passed === summary.total && summary.total > 0;
  const hasFailures = summary.failed > 0;
  const inProgress = summary.running > 0 || summary.pending > 0;

  if (isAllPassed) {
    return (
      <span
        className={cn(
          "rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success",
          className,
        )}
      >
        all passed
      </span>
    );
  }
  if (hasFailures) {
    return (
      <span
        className={cn(
          "rounded-full bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error",
          className,
        )}
      >
        {summary.failed} failed
      </span>
    );
  }
  if (inProgress) {
    return (
      <span
        className={cn(
          "rounded-full bg-brand/[0.18] px-2 py-0.5 text-[10px] font-medium text-brand-strong",
          className,
        )}
      >
        {summary.passed} / {summary.total} passed
      </span>
    );
  }
  return null;
}
