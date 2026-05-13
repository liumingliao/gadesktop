import { ArrowSquareOut } from "@phosphor-icons/react";

interface SettingsAboutProps {
  workbenchVersion: string;
  gaBaseline: string;
}

/**
 * Settings → About tab. DESIGN.md §9 About tab.
 *
 * Structure:
 *   1. Title + tagline
 *   2. Version table (Workbench + GA verified-commit; label aligned
 *      with Settings → Runtime's "已验证版本" terminology)
 *   3. Privacy stance — local-first / no telemetry / direct LLM calls.
 *      Surfaced as a real USP for a desktop dev tool audience.
 *   4. Links — Workbench source + GenericAgent upstream (explicit
 *      credit; Workbench is a shell around lsdefine/GenericAgent) +
 *      Issues for feedback.
 *   5. Footer with MIT license + warmer "欢迎 PR" line so the project
 *      reads as "ours" rather than "mine".
 */
export function SettingsAbout({
  workbenchVersion,
  gaBaseline,
}: SettingsAboutProps) {
  return (
    <div className="space-y-7">
      <div>
        {/* Wordmark uppercase treatment matches the Sidebar header
            (also a "small wordmark" size). Onboarding's 36px hero
            heading stays sentence-case because uppercase at that
            scale tips from "logotype mark" into "marketing banner"
            — see brand notes in CLAUDE.md / discussion thread
            2026-05-13. */}
        <h2 className="m-0 font-serif text-[20px] font-semibold uppercase tracking-[0.04em] text-ink">
          Galley
        </h2>
        <p className="mt-1 font-serif text-[14px] italic text-ink-soft">
          多对话 AI agent 的本地桌面工作台。
        </p>
      </div>

      {/* Origin story — the "Why Galley?" easter egg. Putting it in
          About means: insiders / curious users find the GenericAgent
          heritage when they look; new users see a clean standalone
          brand on the welcome screen. The GA capitalization is a
          quiet bow, not a billboard. */}
      <div className="rounded-md border border-line bg-elevated px-4 py-3 font-serif text-[13.5px] italic leading-[1.65] text-ink-soft">
        Galley started as a workbench for{" "}
        <span className="not-italic">GenericAgent</span>. The first two
        letters of our name are a quiet bow to where we came from.
      </div>

      <dl className="m-0 grid grid-cols-[120px_1fr] gap-y-2 text-[12.5px]">
        <dt className="text-ink-muted">Galley 版本</dt>
        <dd className="m-0 font-mono text-ink">v{workbenchVersion}</dd>

        <dt className="text-ink-muted">已验证 GA 版本</dt>
        <dd className="m-0 font-mono text-ink">{gaBaseline.slice(0, 7)}</dd>
      </dl>

      {/* Privacy stance — structured as a bulleted list under a
          「本地优先」 SubLabel so it reads as a proper section
          parallel to Links below, rather than orphaning at the
          tail of the version table. Three discrete claims (data
          storage / telemetry / LLM calls) deserve three discrete
          bullets — easier to scan and each can be mentally checked
          off independently. Middle-dot bullet (·) matches the
          rest of the app's separator vocabulary rather than the
          web-default disc. mt-10 mirrors the Links section's
          deliberate 40px section break above. */}
      <div className="mt-10">
        <SubLabel>本地优先</SubLabel>
        <ul className="mt-3 space-y-1.5 text-[12.5px] text-ink-soft">
          <li className="before:mr-2 before:text-ink-muted before:content-['·']">
            数据本地存储
          </li>
          <li className="before:mr-2 before:text-ink-muted before:content-['·']">
            不收集使用数据
          </li>
          <li className="before:mr-2 before:text-ink-muted before:content-['·']">
            LLM 调用直达你配置的 API
          </li>
        </ul>
      </div>

      {/* Links section gets explicit `mt-10` instead of relying on
          the parent's `space-y-7`. The dl above is visually dense
          (12.5px rows + small gaps), and the Link section's
          uppercase SubLabel is similar weight — the default 28px
          gap reads as "still part of the same block". 40px breaks
          that visual coupling cleanly. */}
      <div className="mt-10">
        <SubLabel>Links</SubLabel>
        <div className="mt-3 space-y-1.5">
          <ExternalLink href="https://github.com/wangjc683/galley">
            Galley · github.com/wangjc683/galley
          </ExternalLink>
          <ExternalLink href="https://github.com/lsdefine/GenericAgent">
            GenericAgent · github.com/lsdefine/GenericAgent
          </ExternalLink>
          <ExternalLink href="https://github.com/wangjc683/galley/issues">
            反馈建议 · GitHub Issues
          </ExternalLink>
        </div>
      </div>

      {/* "Also by" section — indie / single-maker convention: tells
          users this is a real person who builds things, builds trust
          for an open-source project. Mt-10 mirrors the Links section's
          spacing so the page reads as a uniform rhythm of breaks.
          SubSage listed first (adjacent domain, more likely useful to
          Workbench's AI-builder audience); 15perf70mm second
          (off-topic but adds personality — signals the maker has
          interests beyond AI). */}
      <div className="mt-10">
        <SubLabel>Also by wangjc683</SubLabel>
        <div className="mt-3 space-y-1.5">
          <ExternalLink href="https://subsage.top">
            SubSage · AI Agent 原生订阅管家 · subsage.top
          </ExternalLink>
          <ExternalLink href="https://15perf70mm.com">
            15perf70mm · IMAX 胶片电影资料库 · 15perf70mm.com
          </ExternalLink>
        </div>
      </div>

      <div className="border-t border-line pt-4 text-[12px] text-ink-muted">
        Made by wangjc683 · MIT licensed · 欢迎 PR
      </div>
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

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft transition-colors hover:text-brand-strong"
    >
      <span>{children}</span>
      <ArrowSquareOut size={11} weight="thin" />
    </a>
  );
}
