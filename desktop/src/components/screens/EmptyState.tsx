import {
  Composer,
  type ComposerLLMOption,
} from "@/components/conversation/Composer";
import { cn } from "@/lib/utils";

interface QuickPrompt {
  label: string;
  /** Optional explicit prompt text; defaults to label. */
  prompt?: string;
}

/**
 * Empty-state prompt suggestions — each is a complete, runnable
 * showcase of GA's multi-step / multi-source capability. They span
 * four "task shapes" so a first-time user can pick whichever matches
 * their interest:
 *
 *   - 新闻：web scan across multiple sources
 *   - Downloads：local filesystem ops + analysis
 *   - 电影资讯：multi-source web research
 *   - 哲学 × LLM：pure-reasoning demo (no tools, shows GA is also a
 *     thoughtful conversational layer)
 *
 * Labels ARE the prompt — what the line says is what the agent
 * receives, no surprise.
 */
const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  { label: "这两天有什么有趣的新闻？" },
  { label: "列出 Downloads 里面最大的 10 个文件" },
  { label: "查电影《奥德赛》的最新资讯" },
  { label: "聊聊维特根斯坦与 LLM" },
];

export interface EmptyStateProps {
  llmDisplayName: string;
  onSubmit?: (text: string) => void;
  /** Click handler for a prompt suggestion. Receives the prompt text
   * (label by default; can be overridden per row via QuickPrompt.prompt). */
  onQuickPrompt?: (prompt: string) => void;
  prompts?: QuickPrompt[];
  /** LLM list for the Composer's inline picker. Drives the popover
   * under the model pill — see Composer's LLMPill. */
  llms?: ComposerLLMOption[];
  /** Called when the user picks an LLM from the inline dropdown. */
  onSelectLLM?: (index: number) => void;
  /** Fallback for pre-bridge / dev when `llms` is empty. */
  onOpenLLMSwitcher?: () => void;
  /**
   * Width mode from the TopBar toggle. EmptyState's hero block tracks
   * the same setting so the toggle has a visible effect even when no
   * conversation column exists yet (otherwise the user clicking the
   * button on the welcome screen sees nothing change — looks broken).
   * compact = 560 (intimate hero feel), wide = 1200 (matches MainView).
   */
  conversationWidth?: "compact" | "wide";
}

/**
 * Empty state — what the user sees the first time they launch Galley
 * (and any time no session is active). Per DESIGN.md §7.
 *
 * Minimalist Linear-style: no heading, Composer is the focal point.
 * Placeholder "今天交代什么？" carries the invitation in product voice
 * ("交代" implies handing a task to an agent — more honest than
 * "你想做什么？" Q&A framing).
 *
 * Below the Composer, four prompt suggestions appear as ambient
 * italic-serif hints rather than chip-style buttons. The visual
 * weight is deliberately quiet — these are positioning signals
 * (Galley is built for web research / local-file ops / multi-source
 * comparison / reasoning), not call-to-action chips. A reader's eye
 * walks the Composer first; the prompts read as "btw, here are some
 * directions" only when they choose to look down.
 *
 * Click any line → submits that prompt directly (still actionable,
 * just without button chrome).
 */
export function EmptyState({
  llmDisplayName,
  onSubmit,
  onQuickPrompt,
  prompts = DEFAULT_QUICK_PROMPTS,
  llms,
  onSelectLLM,
  onOpenLLMSwitcher,
  conversationWidth = "compact",
}: EmptyStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-app px-16 py-12">
      <div
        className={cn(
          "w-full",
          conversationWidth === "wide" ? "max-w-[1200px]" : "max-w-[560px]",
        )}
      >
        <Composer
          llmDisplayName={llmDisplayName}
          placeholder="今天交代什么？"
          onSubmit={onSubmit}
          autoFocus
          llms={llms}
          onSelectLLM={onSelectLLM}
          onOpenLLMSwitcher={onOpenLLMSwitcher}
        />

        <ul className="mt-6 flex flex-col items-center gap-2 text-center">
          {prompts.map((p) => (
            <li key={p.label}>
              <button
                type="button"
                onClick={() => onQuickPrompt?.(p.prompt ?? p.label)}
                className={cn(
                  "rounded-sm font-serif text-[12.5px] italic leading-[1.55] text-ink-muted",
                  "transition-colors hover:text-ink",
                )}
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>

        {/* Keyboard hints intentionally not shown here. Empty state
            is the user's first impression; loading it with shortcut
            chrome dilutes focus on the composer. The full shortcut
            list lives in Settings → Shortcuts. */}
      </div>
    </div>
  );
}
