import { ArrowRight } from "@phosphor-icons/react";

interface StepWelcomeProps {
  onStart: () => void;
}

/**
 * Onboarding Step 0 — welcome page. DESIGN.md §5 Step 0.
 *
 * Big serif title, italic muted subtitle, three-line feature
 * summary, charcoal "开始" CTA, footer trust note. Linear /
 * Raycast-grade minimal — no marketing copy, no screenshots.
 */
export function StepWelcome({ onStart }: StepWelcomeProps) {
  return (
    <div className="max-w-[580px]">
      <h1 className="m-0 font-serif text-[36px] font-medium leading-[1.1] tracking-[0.005em] text-ink">
        Galley
      </h1>
      <p className="mb-9 mt-3 font-serif text-[18px] italic leading-[1.55] text-ink-soft">
        GenericAgent 的本地桌面工作台。
      </p>

      <ul className="m-0 space-y-2.5 p-0 text-[13.5px] text-ink">
        <Feature>多对话并行运行</Feature>
        <Feature>对高风险工具调用做审批</Feature>
        <Feature>查看与恢复历史对话</Feature>
      </ul>

      <button
        type="button"
        onClick={onStart}
        className="mt-9 inline-flex items-center gap-2 rounded-sm border border-ink bg-ink px-5 py-2 text-[13.5px] font-medium text-elevated transition-colors hover:bg-ink/90"
      >
        开始
        <ArrowRight size={13} weight="bold" />
      </button>

      <div className="mt-12 text-[12px] text-ink-muted">
        Galley 不会修改你的 GA。删除 Galley 后 GA 独立可用。
      </div>
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-baseline gap-2.5">
      <span className="text-ink-muted">·</span>
      <span>{children}</span>
    </li>
  );
}
