import {
  Check,
  CheckCircle,
  FolderSimple,
  Globe,
  Info,
  Prohibit,
  X,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type {
  ConversationToolEvent,
  OnApprove,
  RiskLevel,
} from "@/types/conversation";
import type { ApprovalDecision } from "@/types/ipc";

interface ApprovalFormProps {
  tool: ConversationToolEvent;
  onApprove?: OnApprove;
  /** Once a decision is recorded, lock the form into the result state. */
  approvalDecision?: string;
}

/**
 * Inline form rendered inside a `waiting_approval` ToolCallout body.
 * Per DESIGN.md §4.6 (Approval Card).
 *
 * #3 ships the generic structure: risk pill, action sentence, args
 * fallback (mono block), four decision buttons, post-decision lock-in
 * pill. #6 adds tool-specific renderers (file_patch split diff,
 * file_write path+mode, code_run language-highlighted command).
 *
 * The "Always allow globally" button is disabled for high-sensitivity
 * tools that should never be globally auto-approved (per PRD §11.3:
 * `start_long_term_update`). Bridge does not enforce this; we do
 * defense-in-depth at the UI.
 */
export function ApprovalForm({
  tool,
  onApprove,
  approvalDecision,
}: ApprovalFormProps) {
  const decided = approvalDecision !== undefined && approvalDecision !== null;
  const reason = APPROVAL_REASON[tool.name] ?? GENERIC_REASON;
  const globalDisabled = HIGH_SENSITIVITY_TOOLS.has(tool.name);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        {tool.riskLevel && <RiskPill level={tool.riskLevel} />}
        <span className="text-[13px] text-ink-soft">
          {actionSentence(tool)}
        </span>
      </div>

      <div className="mb-3 flex items-start gap-1.5 text-[12.5px] leading-[1.5] text-ink-muted">
        <Info
          size={12}
          weight="thin"
          className="mt-0.5 shrink-0 text-ink-muted"
        />
        <span>{reason}</span>
      </div>

      {/*
       * Tool-specific renderer slot. #6 will branch here on tool.name:
       *   file_patch  → SplitDiff (@pierre/diffs)
       *   file_write  → path + mode pill + muted disclaimer
       *   code_run    → mono command block with language highlight
       *   default     → generic args mono block (this branch)
       */}
      {tool.args && Object.keys(tool.args).length > 0 && (
        <pre className="mb-3 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-app px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink-soft">
          {Object.entries(tool.args).map(([k, v]) => (
            <div key={k}>
              <span className="text-ink-muted">{k}: </span>
              <span>{JSON.stringify(v)}</span>
            </div>
          ))}
        </pre>
      )}

      {!decided ? (
        <div className="flex flex-wrap gap-2">
          <DecisionButton
            variant="primary"
            icon={<Check size={13} weight="bold" />}
            onClick={() => onApprove?.("allow_once")}
          >
            Allow once
          </DecisionButton>
          <DecisionButton
            variant="danger-ghost"
            icon={<X size={13} weight="bold" />}
            onClick={() => onApprove?.("deny")}
          >
            Deny
          </DecisionButton>
          <DecisionButton
            variant="brand-ghost"
            icon={<FolderSimple size={13} weight="thin" />}
            onClick={() => onApprove?.("always_allow_project")}
          >
            Always allow in this Project
          </DecisionButton>
          <DecisionButton
            variant="brand-ghost"
            icon={<Globe size={13} weight="thin" />}
            onClick={() => onApprove?.("always_allow_global")}
            disabled={globalDisabled}
            title={globalDisabled ? "高敏感工具不允许全局自动通过" : undefined}
          >
            Always allow globally
          </DecisionButton>
        </div>
      ) : (
        <DecisionPill decision={approvalDecision as ApprovalDecision} />
      )}
    </div>
  );
}

// ---------- internals ----------

const APPROVAL_REASON: Record<string, string> = {
  file_patch: "file_patch 会修改文件内容。审批后 GA 才会实际执行 dispatch。",
  file_write: "file_write 会覆盖或新建文件。审批后 GA 才会实际写盘。",
  code_run: "code_run 可执行任意代码或 shell 命令，可能触达网络/磁盘。",
  start_long_term_update:
    "会修改 GA 的 global memory（持久化）。审批后 GA 才会写入。",
};

const GENERIC_REASON = "该工具在默认审批列表里，需要你确认后才能执行。";

const HIGH_SENSITIVITY_TOOLS = new Set(["start_long_term_update"]);

function actionSentence(tool: ConversationToolEvent): string {
  // Prefer a short summary if the caller provided one.
  if (tool.summary) return tool.summary;
  switch (tool.name) {
    case "file_patch":
      return `Patch file at ${pathFromArgs(tool.args)}`;
    case "file_write":
      return `Write file at ${pathFromArgs(tool.args)}`;
    case "code_run":
      return "Run code";
    default:
      return `Run ${tool.name}`;
  }
}

function pathFromArgs(args?: Record<string, unknown>): string {
  if (args && typeof args.path === "string") return args.path;
  return "—";
}

function RiskPill({ level }: { level: RiskLevel }) {
  const text = `${level} risk`;
  const cls: Record<RiskLevel, string> = {
    low: "bg-info/10 text-info",
    medium: "bg-warning/[0.12] text-warning",
    high: "bg-error/[0.12] text-error",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-medium tracking-[0.02em]",
        cls[level],
      )}
    >
      {text}
    </span>
  );
}

interface DecisionButtonProps {
  variant: "primary" | "danger-ghost" | "brand-ghost";
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}

function DecisionButton({
  variant,
  icon,
  children,
  onClick,
  disabled,
  title,
}: DecisionButtonProps) {
  const cls = VARIANT_CLASS[variant];
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-3.5 py-1.5 text-[13px] font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        cls,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

const VARIANT_CLASS: Record<DecisionButtonProps["variant"], string> = {
  primary:
    "border-ink bg-ink text-elevated hover:bg-ink/90 disabled:hover:bg-ink",
  "danger-ghost":
    "border-transparent text-error hover:bg-error/[0.06] disabled:hover:bg-transparent",
  "brand-ghost":
    "border-line text-brand-strong hover:border-brand hover:bg-brand-soft disabled:hover:border-line disabled:hover:bg-transparent",
};

function DecisionPill({ decision }: { decision: ApprovalDecision }) {
  const isDeny = decision === "deny";
  const Icon = isDeny ? Prohibit : CheckCircle;
  const label: Record<ApprovalDecision, string> = {
    allow_once: "Allowed · 已通过本次执行",
    deny: "Denied · agent 将收到拒绝信号",
    always_allow_project: "已加入此 Project 白名单",
    always_allow_global: "已加入全局白名单",
  };
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-[8px] px-3.5 py-2 text-[13px] font-medium",
        isDeny
          ? "bg-error/[0.06] text-error"
          : "bg-brand-soft text-brand-strong",
      )}
    >
      <Icon size={14} weight="thin" />
      <span>{label[decision]}</span>
    </div>
  );
}
