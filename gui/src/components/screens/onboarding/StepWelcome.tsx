import { ArrowRight, Prohibit } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

interface StepWelcomeProps {
  onStart: () => void;
}

/**
 * Onboarding Step 0 — welcome page.
 *
 * Two-mode entry point:
 *   1. "帮我安装 GenericAgent" — full-zero onboarding (install Python +
 *      download GA + configure mykey.py). Disabled in v0.1; we surface
 *      the card so the future path is discoverable without committing
 *      to the implementation.
 *   2. "接入已经安装的 GenericAgent" — the only live path in v0.1.
 *      Card click goes straight to Attach step.
 *
 * The trust note "Galley 不会修改你的 GA …" moved from a page-level
 * footer into Mode 2's body — it's the value prop of the attach path
 * specifically, not a global app fact, so it reads more honestly there.
 *
 * Title typography: 36px sentence-case "Galley" (Newsreader medium).
 * Per CLAUDE.md brand wordmark rules: small wordmark is UPPERCASE
 * GALLEY (Sidebar 16px / Settings 20px); hero size is sentence case
 * — softer first-meeting tone. Conscious dual-mode, not inconsistency.
 */
export function StepWelcome({ onStart }: StepWelcomeProps) {
  return (
    <div className="max-w-[580px]">
      <h1 className="m-0 font-serif text-[36px] font-medium leading-[1.1] tracking-[0.005em] text-ink">
        Galley
      </h1>
      <p className="mb-9 mt-3 font-serif text-[18px] italic leading-[1.55] text-ink-soft">
        GenericAgent 的本地桌面工作台
      </p>

      <div className="space-y-3">
        <ModeCard
          title="帮我安装 GenericAgent"
          body="敬请期待"
          disabled
        />
        <ModeCard
          title="接入已经安装的 GenericAgent"
          body="Galley 不会修改你的 GenericAgent。删除 Galley 后 GenericAgent 仍可独立运行。"
          onClick={onStart}
        />
      </div>
    </div>
  );
}

interface ModeCardProps {
  title: string;
  body: string;
  onClick?: () => void;
  disabled?: boolean;
}

/**
 * Single welcome-mode option. The whole card is the action target —
 * one click = decision + navigate, no separate Continue button. The
 * trailing icon visually disambiguates active (ArrowRight) from
 * disabled (Prohibit) at a glance.
 */
function ModeCard({ title, body, onClick, disabled }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-3 rounded-[10px] border px-5 py-4 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-line bg-app opacity-60"
          : "cursor-pointer border-line bg-elevated hover:border-line-strong hover:bg-surface",
      )}
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "font-serif text-[15.5px] font-medium",
            disabled ? "text-ink-soft" : "text-ink",
          )}
        >
          {title}
        </div>
        <div className="mt-1.5 text-[12.5px] leading-[1.55] text-ink-soft">
          {body}
        </div>
      </div>
      {disabled ? (
        <Prohibit
          size={16}
          weight="thin"
          className="mt-0.5 shrink-0 text-ink-muted"
        />
      ) : (
        <ArrowRight
          size={14}
          weight="thin"
          className="mt-1 shrink-0 text-ink-muted"
        />
      )}
    </button>
  );
}
