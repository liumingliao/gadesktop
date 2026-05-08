import {
  ArrowSquareOut,
  CaretDown,
  Cube,
  FileCode,
  Info,
  Warning,
  X as XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import type {
  AppError,
  AppErrorHint,
  AppErrorSeverity,
} from "@/types/app-error";

export interface ErrorCardActions {
  /** Retry the original request. Shown when error.retryable is true. */
  onRetry?: () => void;
  /** Switch LLM (used by quota_exceeded hint). */
  onSwitchLLM?: () => void;
  /** Open mykey.py path in editor / Finder (check_llm_config hint). */
  onOpenMyKey?: () => void;
  /** Open the GA install / config docs (check_llm_config hint). */
  onOpenGADocs?: () => void;
}

interface ErrorCardProps extends ErrorCardActions {
  error: AppError;
  /**
   * "Toast"   — standalone with chrome + close button (top-level toast).
   * "Inline"  — same chrome but no close (conversation history).
   * "Card"    — embedded standalone with chrome (e.g. health check).
   */
  variant?: "toast" | "inline" | "card";
  onDismiss?: () => void;
}

/**
 * The Error Card visual. DESIGN.md §6.2.
 *
 * Same chrome regardless of where it lands (toast / inline / card),
 * with three severity skins and an optional hint variant that wraps
 * the message in actionable guidance ("LLM 配置可能有问题" + buttons,
 * not "401 Unauthorized" + nothing).
 *
 * The expandable "Details" panel surfaces the raw traceback / source —
 * power-user audit trail; default users never see it.
 */
export function ErrorCard({
  error,
  variant = "card",
  onDismiss,
  onRetry,
  onSwitchLLM,
  onOpenMyKey,
  onOpenGADocs,
}: ErrorCardProps) {
  const [open, setOpen] = useState(false);
  const isInline = variant === "inline";
  const sev = SEVERITY_CONFIG[error.severity];
  const hintCfg = error.hint ? HINT_CONFIG[error.hint] : null;

  const title = hintCfg?.title ?? defaultTitle(error);
  const brief = hintCfg?.brief ?? error.message;
  const actions = hintCfg?.actions ?? defaultActions(error);

  return (
    <div
      className={cn(
        "rounded-md border bg-elevated p-4 shadow-card",
        sev.borderClass,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex shrink-0">
          <SeverityIcon severity={error.severity} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{title}</div>
          <div className="mt-1 text-[13px] text-ink-soft">{brief}</div>
        </div>
        {!isInline && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-m-1 inline-flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <XIcon size={12} weight="thin" />
          </button>
        )}
      </div>

      {actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a) => (
            <ActionButton
              key={a.id}
              action={a}
              error={error}
              onRetry={onRetry}
              onSwitchLLM={onSwitchLLM}
              onOpenMyKey={onOpenMyKey}
              onOpenGADocs={onOpenGADocs}
              onToggleDetails={() => setOpen((v) => !v)}
              detailsOpen={open}
            />
          ))}
        </div>
      )}

      {open && (error.traceback || error.context) && (
        <div className="mt-3 rounded-[6px] border border-line bg-app p-2.5">
          {error.context && (
            <div className="font-mono text-[11px] text-ink-muted">
              context: {error.context}
            </div>
          )}
          {error.traceback && (
            <pre className="mt-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-[1.55] text-ink-soft">
              {error.traceback}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- internals ----------------

interface ActionDef {
  id: string;
  label: string;
  /** "primary" = brand-soft button, "ghost" = no border. */
  kind: "primary" | "ghost";
  handler:
    | "onRetry"
    | "onSwitchLLM"
    | "onOpenMyKey"
    | "onOpenGADocs"
    | "toggleDetails";
}

interface SeverityConfig {
  icon: typeof Warning;
  borderClass: string;
  iconClass: string;
}

const SEVERITY_CONFIG: Record<AppErrorSeverity, SeverityConfig> = {
  error: {
    icon: XIcon,
    borderClass: "border-error/30",
    iconClass: "text-error",
  },
  warning: {
    icon: Warning,
    borderClass: "border-warning/30",
    iconClass: "text-warning",
  },
  info: {
    icon: Info,
    borderClass: "border-line",
    iconClass: "text-info",
  },
};

function SeverityIcon({ severity }: { severity: AppErrorSeverity }) {
  const cfg = SEVERITY_CONFIG[severity];
  const Icon = cfg.icon;
  return <Icon size={16} weight="thin" className={cfg.iconClass} />;
}

interface HintConfig {
  title: string;
  brief: string;
  actions: ActionDef[];
}

const HINT_CONFIG: Record<AppErrorHint, HintConfig> = {
  check_llm_config: {
    title: "LLM 配置可能有问题",
    brief: "首次发送失败，通常是 API key 或配置问题。",
    actions: [
      {
        id: "open-mykey",
        label: "检查 mykey.py",
        kind: "primary",
        handler: "onOpenMyKey",
      },
      {
        id: "open-docs",
        label: "查看 GA 文档",
        kind: "ghost",
        handler: "onOpenGADocs",
      },
      {
        id: "details",
        label: "View raw error",
        kind: "ghost",
        handler: "toggleDetails",
      },
    ],
  },
  network: {
    title: "网络无法连接",
    brief: "请求未能到达 LLM provider，可能是超时或 DNS 问题。",
    actions: [
      { id: "retry", label: "Retry", kind: "primary", handler: "onRetry" },
      {
        id: "details",
        label: "View raw error",
        kind: "ghost",
        handler: "toggleDetails",
      },
    ],
  },
  quota_exceeded: {
    title: "API 配额耗尽",
    brief: "可切换其他 LLM 继续。",
    actions: [
      {
        id: "switch-llm",
        label: "Switch LLM",
        kind: "primary",
        handler: "onSwitchLLM",
      },
      {
        id: "details",
        label: "View raw error",
        kind: "ghost",
        handler: "toggleDetails",
      },
    ],
  },
};

function defaultTitle(error: AppError): string {
  switch (error.category) {
    case "runtime":
      return "工具执行失败";
    case "bridge":
      return "Bridge 错误";
    case "business":
      return "操作未能完成";
  }
}

function defaultActions(error: AppError): ActionDef[] {
  const actions: ActionDef[] = [];
  if (error.retryable) {
    actions.push({
      id: "retry",
      label: "Retry",
      kind: "primary",
      handler: "onRetry",
    });
  }
  if (error.traceback || error.context) {
    actions.push({
      id: "details",
      label: "View details",
      kind: "ghost",
      handler: "toggleDetails",
    });
  }
  return actions;
}

function ActionButton({
  action,
  error: _error,
  onRetry,
  onSwitchLLM,
  onOpenMyKey,
  onOpenGADocs,
  onToggleDetails,
  detailsOpen,
}: {
  action: ActionDef;
  error: AppError;
  onRetry?: () => void;
  onSwitchLLM?: () => void;
  onOpenMyKey?: () => void;
  onOpenGADocs?: () => void;
  onToggleDetails: () => void;
  detailsOpen: boolean;
}) {
  const handler = (() => {
    switch (action.handler) {
      case "onRetry":
        return onRetry;
      case "onSwitchLLM":
        return onSwitchLLM;
      case "onOpenMyKey":
        return onOpenMyKey;
      case "onOpenGADocs":
        return onOpenGADocs;
      case "toggleDetails":
        return onToggleDetails;
    }
  })();
  const disabled = !handler;
  const Icon = ACTION_ICONS[action.handler];

  return (
    <button
      type="button"
      onClick={handler}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-3 py-1 text-[12.5px] font-medium transition-colors",
        action.kind === "primary"
          ? "border-line bg-elevated text-brand-strong hover:border-brand hover:bg-brand-soft hover:text-ink"
          : "border-transparent text-ink-soft hover:bg-hover hover:text-ink",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {Icon && (
        <Icon
          size={12}
          weight="thin"
          className={cn(
            action.handler === "toggleDetails" &&
              "transition-transform duration-150",
            action.handler === "toggleDetails" && detailsOpen && "rotate-180",
          )}
        />
      )}
      {action.label}
    </button>
  );
}

const ACTION_ICONS: Partial<Record<ActionDef["handler"], typeof Cube>> = {
  onSwitchLLM: Cube,
  onOpenMyKey: FileCode,
  onOpenGADocs: ArrowSquareOut,
  toggleDetails: CaretDown,
};
