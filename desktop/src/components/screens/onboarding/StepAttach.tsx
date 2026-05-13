import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  Check,
  CircleNotch,
  FolderOpen,
  Warning,
  X,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

export type PathValidation =
  | { kind: "ok"; foundAgentmain: boolean; rawPath: string }
  | { kind: "missing-agentmain"; rawPath: string }
  | { kind: "not-found"; rawPath: string }
  | { kind: "checking" }
  | null;

interface StepAttachProps {
  path: string;
  validation: PathValidation;
  onPathChange: (path: string) => void;
  onPickFolder: () => void;
  onBack: () => void;
  onContinue: () => void;
}

/**
 * Onboarding Step 1 — Attach existing GA. DESIGN.md §5 Step 1.
 *
 * Path input + folder picker button + real-time validation feedback +
 * continue CTA (disabled until validation === "ok"). The validation
 * itself happens in the parent — bridge or Tauri shell can answer
 * "does this path exist? does it contain agentmain.py?" without
 * blocking the UI.
 *
 * The "还没装 GenericAgent？" link is a quiet escape hatch for new
 * users; opens in the system browser.
 */
export function StepAttach({
  path,
  validation,
  onPathChange,
  onPickFolder,
  onBack,
  onContinue,
}: StepAttachProps) {
  const ready = validation?.kind === "ok";

  return (
    <div className="max-w-[580px]">
      <h1 className="m-0 font-serif text-[32px] font-medium leading-tight tracking-[0.005em] text-ink">
        Attach 已安装的 GenericAgent
      </h1>
      <p className="mb-7 mt-2.5 font-serif text-[15.5px] italic leading-[1.55] text-ink-soft">
        指向你本地的 GA 安装目录 · Workbench 会用它启动 GA。
      </p>

      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
        GA Path
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder="~/Documents/GenericAgent"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-sm border border-line bg-elevated px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors focus:border-brand focus:ring-[3px] focus:ring-brand/20"
        />
        <button
          type="button"
          onClick={onPickFolder}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 py-2 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
        >
          <FolderOpen size={13} weight="thin" />
          选择
        </button>
      </div>

      <div className="min-h-[20px]">
        <ValidationLine validation={validation} />
      </div>

      <a
        href="https://github.com/lsdefine/GenericAgent"
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 text-[12px] text-ink-muted transition-colors hover:text-brand-strong"
      >
        还没装 GenericAgent？前往安装
        <ArrowSquareOut size={11} weight="thin" />
      </a>

      <div className="mt-9 flex items-center gap-2">
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
          disabled={!ready}
          className={cn(
            "ml-auto inline-flex items-center gap-2 rounded-sm border border-ink bg-ink px-5 py-2 text-[13.5px] font-medium text-elevated transition-colors hover:bg-ink/90",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          继续
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>
    </div>
  );
}

function ValidationLine({ validation }: { validation: PathValidation }) {
  if (!validation) return null;
  const cls = "mt-2 flex items-center gap-1.5 text-[12.5px]";
  switch (validation.kind) {
    case "ok":
      return (
        <div className={cn(cls, "text-success")}>
          <Check size={12} weight="thin" />
          找到 GA 安装{" "}
          {validation.foundAgentmain && (
            <span className="text-ink-muted">· agentmain.py 可见</span>
          )}
        </div>
      );
    case "missing-agentmain":
      return (
        <div className={cn(cls, "text-warning")}>
          <Warning size={12} weight="thin" />
          路径存在但未找到 agentmain.py — 确认这是 GA 安装目录？
        </div>
      );
    case "not-found":
      return (
        <div className={cn(cls, "text-error")}>
          <X size={12} weight="thin" />
          路径不存在
        </div>
      );
    case "checking":
      return (
        <div className={cn(cls, "text-ink-muted")}>
          <span className="spin">
            <CircleNotch size={12} weight="thin" />
          </span>
          检查中…
        </div>
      );
  }
}
