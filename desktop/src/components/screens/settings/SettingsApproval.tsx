import { Check, X } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { ApprovalConfig } from "@/components/screens/settings/Settings";

interface SettingsApprovalProps {
  config: ApprovalConfig;
  onChangeRequiredTools?: (tools: string[]) => void;
  onRemoveAlwaysAllow?: (scope: "project" | "global", tool: string) => void;
}

/**
 * Settings → Approval tab. DESIGN.md §9 Approval tab.
 *
 * Two stacks:
 *
 *   1. Approval-required tools — checkbox list. Default V0.1 set is
 *      code_run / file_write / file_patch / start_long_term_update;
 *      user can prune. Toggling triggers onChangeRequiredTools with
 *      the new full list.
 *
 *   2. Always-allow rules — split per-project / global, each row
 *      shows tool name + remove button. Toggling fires the toast
 *      "已应用到所有 session" upstream so the user sees the
 *      side-effect (DESIGN.md §9 故意决策).
 */
export function SettingsApproval({
  config,
  onChangeRequiredTools,
  onRemoveAlwaysAllow,
}: SettingsApprovalProps) {
  const toggleRequired = (tool: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...config.requiredTools, tool])]
      : config.requiredTools.filter((t) => t !== tool);
    onChangeRequiredTools?.(next);
  };

  return (
    <div className="space-y-7">
      <SectionTitle
        title="Approval"
        subtitle="哪些工具需要审批 · 哪些已加白名单"
      />

      <div>
        <SubLabel>Approval-required tools</SubLabel>
        <div className="mt-2 space-y-1">
          {DEFAULT_TOOLS.map((tool) => {
            const required = config.requiredTools.includes(tool);
            return (
              <label
                key={tool}
                className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-hover"
              >
                <Checkbox
                  checked={required}
                  onChange={(c) => toggleRequired(tool, c)}
                />
                <span className="font-mono text-[12.5px] text-ink">{tool}</span>
                <span className="ml-auto text-[11px] text-ink-muted">
                  {TOOL_DESCRIPTIONS[tool]}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <SubLabel>
          Always allow · Per-project ({config.alwaysAllowProject.length})
        </SubLabel>
        <RuleList
          rules={config.alwaysAllowProject}
          onRemove={(tool) => onRemoveAlwaysAllow?.("project", tool)}
          empty="没有 project 级白名单"
        />
      </div>

      <div>
        <SubLabel>
          Always allow · Global ({config.alwaysAllowGlobal.length})
        </SubLabel>
        <RuleList
          rules={config.alwaysAllowGlobal}
          onRemove={(tool) => onRemoveAlwaysAllow?.("global", tool)}
          empty="没有全局白名单"
        />
      </div>

      <div className="text-[12px] text-ink-muted">
        Always-allow 在审批弹窗里勾"always allow"后会出现在这里。
      </div>
    </div>
  );
}

// ---------------- internals ----------------

const DEFAULT_TOOLS = [
  "code_run",
  "file_write",
  "file_patch",
  "start_long_term_update",
];

const TOOL_DESCRIPTIONS: Record<string, string> = {
  code_run: "执行 shell / python / powershell",
  file_write: "覆盖或新建文件",
  file_patch: "修改已有文件",
  start_long_term_update: "写入 GA global memory",
};

function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <h2 className="m-0 font-serif text-[18px] font-medium text-ink">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 text-[12.5px] text-ink-muted">{subtitle}</p>
      )}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
      {children}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
        checked
          ? "border-ink bg-ink text-elevated"
          : "border-line bg-elevated hover:border-ink",
      )}
    >
      {checked && <Check size={10} weight="bold" />}
    </button>
  );
}

function RuleList({
  rules,
  empty,
  onRemove,
}: {
  rules: string[];
  empty: string;
  onRemove: (tool: string) => void;
}) {
  if (rules.length === 0) {
    return (
      <div className="mt-2 rounded-[8px] border border-dashed border-line px-3 py-3 text-[12.5px] italic text-ink-muted">
        {empty}
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1">
      {rules.map((tool) => (
        <div
          key={tool}
          className="flex items-center justify-between rounded-sm bg-surface px-3 py-2 text-[12.5px]"
        >
          <span className="font-mono text-ink">{tool}</span>
          <button
            type="button"
            onClick={() => onRemove(tool)}
            className="inline-flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-error"
            aria-label={`Remove ${tool}`}
            title="Remove rule"
          >
            <X size={12} weight="thin" />
          </button>
        </div>
      ))}
    </div>
  );
}
