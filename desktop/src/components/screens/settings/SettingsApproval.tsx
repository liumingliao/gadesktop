import * as Dialog from "@radix-ui/react-dialog";
import { Check, Lightning, X } from "@phosphor-icons/react";
import { useState } from "react";

import { IconTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ApprovalConfig } from "@/components/screens/settings/Settings";

interface SettingsApprovalProps {
  config: ApprovalConfig;
  yoloMode: boolean;
  /** Total project count. Used to conditionally render the
   * "Per-project" section — hidden when user has no projects AND no
   * existing per-project rules (don't surface a feature that points
   * at nothing). When projects exist OR there are legacy rules, the
   * section shows so the user can manage / clean up. */
  projectCount?: number;
  onChangeYoloMode: (enabled: boolean) => void;
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
  yoloMode,
  projectCount = 0,
  onChangeYoloMode,
  onChangeRequiredTools,
  onRemoveAlwaysAllow,
}: SettingsApprovalProps) {
  const showPerProject =
    projectCount > 0 || config.alwaysAllowProject.length > 0;
  const [activationOpen, setActivationOpen] = useState(false);
  const toggleRequired = (tool: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...config.requiredTools, tool])]
      : config.requiredTools.filter((t) => t !== tool);
    onChangeRequiredTools?.(next);
  };

  const handleYoloToggle = (next: boolean) => {
    if (next) {
      // OFF → ON requires the activation modal (PRD §11.5).
      setActivationOpen(true);
    } else {
      // ON → OFF is harmless; no confirm.
      onChangeYoloMode(false);
    }
  };

  return (
    <div className="space-y-7">
      <SectionTitle
        title="Approval"
        subtitle="哪些工具需要审批 · 哪些已加白名单"
      />

      <YoloSection enabled={yoloMode} onToggle={handleYoloToggle} />

      <YoloActivationModal
        open={activationOpen}
        onOpenChange={setActivationOpen}
        onConfirm={() => {
          onChangeYoloMode(true);
          setActivationOpen(false);
        }}
      />

      {/* "Rules are disabled" announcement banner — kept OUTSIDE the
          dimmed container below so it stays at full opacity (it's a
          status banner, not part of the disabled content) and so the
          outer space-y-7 gives it normal 28px clearance from the
          disabled section. Previously it lived inside the opacity-50
          container with a -mb-2 negative margin and ended up
          overlapping the "Approval-required tools" header. */}
      {yoloMode && (
        <div className="text-[12px] italic text-ink-muted">
          YOLO 已开启，下列规则当前不生效（关闭 YOLO 后恢复）。
        </div>
      )}

      <div
        className={cn(
          "space-y-7",
          yoloMode && "pointer-events-none opacity-50",
        )}
        aria-disabled={yoloMode}
        title={
          yoloMode
            ? "YOLO 已开启，下列规则当前不生效"
            : undefined
        }
      >
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
                  <span className="font-mono text-[12.5px] text-ink">
                    {tool}
                  </span>
                  <span className="ml-auto text-[11px] text-ink-muted">
                    {TOOL_DESCRIPTIONS[tool]}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {showPerProject && (
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
        )}

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
    </div>
  );
}

// ---------------- YOLO mode ----------------

/**
 * Top-of-tab YOLO mode block (PRD §11.5 / DESIGN.md §9 Approval).
 *
 * Visually distinct from the lower per-tool settings:
 * - Lightning icon + apricot/warning hue calls attention
 * - Sits in its own bordered card so it isn't read as "another
 *   checkbox in the list"
 *
 * The actual confirm-on-activation modal is handled by
 * YoloActivationModal — keeping that out of this section means the
 * Switch's disabled-state logic doesn't have to wait for the modal
 * to mount.
 */
function YoloSection({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] border bg-surface px-4 py-3.5",
        enabled
          ? "border-warning/30 bg-warning/5"
          : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Lightning
            size={18}
            weight="thin"
            className={cn(
              "mt-0.5 shrink-0",
              enabled ? "text-warning" : "text-ink-soft",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="font-serif text-[14px] font-medium text-ink">
              <IconTooltip text="You Only Live Once · 跳过审批让 agent 自主运行，适合在隔离环境完全信任 agent 时使用">
                <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-[3px]">
                  YOLO 模式
                </span>
              </IconTooltip>
            </div>
            <div className="mt-1 text-[12px] text-ink-muted">
              跳过所有操作的审批，agent 自主执行 — 适合完全信任 agent 的沙盒环境
            </div>
          </div>
        </div>
        <Switch checked={enabled} onChange={onToggle} />
      </div>
      {enabled && (
        <div className="mt-3 flex items-center justify-between border-t border-warning/20 pt-3 text-[12px]">
          <span className="text-warning">
            ⚡ YOLO 已启用 · TopBar 显示状态
          </span>
          <button
            type="button"
            onClick={() => onToggle(false)}
            className="rounded-sm px-2 py-1 text-[12px] text-ink-soft transition-colors hover:bg-hover hover:text-ink"
          >
            立即关闭
          </button>
        </div>
      )}
    </div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (c: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-warning" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-elevated shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/**
 * Activation modal — shown when toggling YOLO from off to on
 * (PRD §11.5). Confirm button copy "是的，我知道在做什么"
 * deliberately not "确定" to prevent reflexive clicks.
 */
function YoloActivationModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] w-[480px] max-w-[calc(100vw-32px)]",
            "-translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-line bg-elevated p-7 shadow-elevated",
          )}
        >
          <div className="flex items-center gap-2">
            <Lightning size={20} weight="thin" className="text-warning" />
            <Dialog.Title className="font-serif text-[18px] font-medium text-ink">
              打开 YOLO 模式？
            </Dialog.Title>
          </div>

          <div className="mt-4 space-y-3 text-[13px] text-ink-soft">
            <p>
              YOLO ="You Only Live Once"。所有 tool 调用将不经审批直接执行——包括：
            </p>
            <ul className="space-y-1 pl-1 font-mono text-[12.5px] text-ink">
              <li>· file_patch（修改文件）</li>
              <li>· file_write（写入文件）</li>
              <li>· code_run（执行命令）</li>
              <li>· 其他高风险操作</li>
            </ul>
            <p>
              <span className="text-ink">适合</span>
              ：完全信任 agent + 在沙盒环境工作（个人 repo / 临时虚拟机）
            </p>
            <p>
              <span className="text-ink">不适合</span>
              ：生产代码 / 共享系统 / 不熟悉的 agent / 敏感数据
            </p>
            <p className="text-[12px] text-ink-muted">
              打开后 TopBar 会显示 ⚡ YOLO 标识，随时可一键关闭。
            </p>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              autoFocus
              className="rounded-sm px-3 py-2 text-[13px] text-ink transition-colors hover:bg-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-sm bg-warning px-3 py-2 text-[13px] font-medium text-elevated transition-colors hover:bg-warning/90"
            >
              是的，我知道在做什么
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
