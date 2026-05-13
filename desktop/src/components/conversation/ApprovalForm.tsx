import {
  Check,
  CheckCircle,
  FolderSimple,
  Globe,
  Info,
  Prohibit,
  X,
} from "@phosphor-icons/react";

import { ApprovalRenderer } from "@/components/conversation/approval-renderers";
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
  /** Name of the project the active session belongs to, if any.
   * When set, the "Always allow in this Project" button shows the
   * actual project name ("Always allow in {projectName}") and the
   * always_allow_project decision becomes available. When
   * undefined, the button is hidden — at V0.1 we don't expose a
   * scoping affordance that points at nothing. */
  projectName?: string;
}

/**
 * Inline form rendered inside a `waiting_approval` ToolCallout body.
 * Per DESIGN.md §4.6 (Approval Card).
 *
 * #3 shipped the generic structure (risk pill, action sentence, args
 * fallback, four decision buttons, post-decision lock-in pill); #6
 * routes the body through ApprovalRenderer for tool-specific views
 * (file_patch split diff via PatchView, file_write path+mode +
 * disclaimer, code_run mono command + language pill,
 * start_long_term_update memory key + content preview).
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
  projectName,
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

      {/* Two-tier tool description: GA's actual tool name in mono
          (primary weight) so power users see the precise identifier,
          paired with a plain-Chinese explanation below for first-time
          / non-technical users. Preserves precision without crowding
          the approval moment with English jargon. */}
      <div className="mb-3 flex items-start gap-1.5">
        <Info
          size={12}
          weight="thin"
          className="mt-1 shrink-0 text-ink-muted"
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] leading-[1.4] text-ink">
            {tool.name}
          </div>
          <div className="mt-0.5 text-[11.5px] leading-[1.5] text-ink-soft">
            {reason}
          </div>
        </div>
      </div>

      {/*
       * Tool-specific renderer slot — dispatches by tool.name. See
       * components/conversation/approval-renderers.tsx for the
       * file_patch / file_write / code_run / start_long_term_update
       * branches and the generic args fallback.
       */}
      <ApprovalRenderer tool={tool} />

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
          {projectName && (
            <DecisionButton
              variant="brand-ghost"
              icon={<FolderSimple size={13} weight="thin" />}
              onClick={() => onApprove?.("always_allow_project")}
            >
              Always allow in {projectName}
            </DecisionButton>
          )}
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

// Short Chinese descriptions paired with the tool's English mono
// name in the JSX above (two-tier visual hierarchy — see render
// site for the layout rationale). Keep these factual and brief;
// the long-form "审批后 GA 才会执行" boilerplate is implied by
// the dialog's presence and the Allow / Deny buttons.
const APPROVAL_REASON: Record<string, string> = {
  file_patch: "修改现有文件的内容",
  file_write: "写入或覆盖文件",
  code_run: "执行代码或 shell 命令",
  start_long_term_update: "更新 GA 的长期记忆（持久化）",
};

const GENERIC_REASON = "默认审批列表里的工具，需要你确认后才能执行";

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
