import {
  BookOpenText,
  NotePencil,
  TerminalWindow,
  Translate,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

import { Composer } from "@/components/conversation/Composer";
import { cn } from "@/lib/utils";

interface QuickPrompt {
  label: string;
  Icon: PhosphorIcon;
  /** Optional explicit prompt text; defaults to label. */
  prompt?: string;
}

const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  { label: "翻译", Icon: Translate },
  { label: "整理会议笔记", Icon: NotePencil },
  { label: "论文查询", Icon: BookOpenText },
  { label: "写脚本", Icon: TerminalWindow },
];

export interface EmptyStateProps {
  llmDisplayName: string;
  onSubmit?: (text: string) => void;
  /** Click handler for a quick prompt chip. Receives the prompt text
   * (label by default; can be overridden per chip via QuickPrompt.prompt). */
  onQuickPrompt?: (prompt: string) => void;
  prompts?: QuickPrompt[];
}

/**
 * Empty state — what the user sees the first time they launch
 * Workbench (and any time no session is active). Per DESIGN.md §7.
 *
 * Hero composer floats vertically centered with the apricot-italic
 * "你想做什么？" question above. Four quick-prompt chips below — tilted
 * deliberately *non-coding* (translation / notes / papers / scripts) to
 * embody the "general agent" mental model.
 */
export function EmptyState({
  llmDisplayName,
  onSubmit,
  onQuickPrompt,
  prompts = DEFAULT_QUICK_PROMPTS,
}: EmptyStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-app px-16 py-12">
      <div className="w-full max-w-[560px]">
        <div className="mb-6 text-center font-serif text-[22px] italic leading-tight tracking-[0.005em] text-ink-soft">
          你想做什么？
        </div>

        <Composer
          llmDisplayName={llmDisplayName}
          placeholder="问点什么，或粘贴一段文字 / 文件路径…"
          onSubmit={onSubmit}
          autoFocus
        />

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {prompts.map((p) => (
            <PromptChip
              key={p.label}
              icon={<p.Icon size={14} weight="thin" />}
              label={p.label}
              onClick={() => onQuickPrompt?.(p.prompt ?? p.label)}
            />
          ))}
        </div>

        <div className="mt-10 text-center text-[12px] text-ink-muted">
          ⌘K 打开命令面板 · ⌘N 新建对话 · ⌘\ 折叠 sidebar
        </div>
      </div>
    </div>
  );
}

function PromptChip({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-[12.5px] text-ink-soft",
        "transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink",
      )}
    >
      <span className="text-ink-soft">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
