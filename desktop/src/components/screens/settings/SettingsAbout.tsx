import { ArrowSquareOut } from "@phosphor-icons/react";

interface SettingsAboutProps {
  workbenchVersion: string;
  gaBaseline: string;
}

/**
 * Settings → About tab. DESIGN.md §9 About tab.
 *
 * Static content: app icon (Newsreader title placeholder for V0.1),
 * versions, external links (GitHub / docs / report issue), MIT
 * license note, "Made by JCONE · Open source" footer.
 */
export function SettingsAbout({
  workbenchVersion,
  gaBaseline,
}: SettingsAboutProps) {
  return (
    <div className="space-y-7">
      <div>
        <h2 className="m-0 font-serif text-[20px] font-medium tracking-[0.005em] text-ink">
          GenericAgent Workbench
        </h2>
        <p className="mt-1 font-serif text-[14px] italic text-ink-soft">
          GA 的本地桌面工作台。
        </p>
      </div>

      <dl className="m-0 grid grid-cols-[120px_1fr] gap-y-2 text-[12.5px]">
        <dt className="text-ink-muted">Version</dt>
        <dd className="m-0 font-mono text-ink">v{workbenchVersion}</dd>

        <dt className="text-ink-muted">GA baseline</dt>
        <dd className="m-0 font-mono text-ink">{gaBaseline.slice(0, 7)}</dd>

        <dt className="text-ink-muted">License</dt>
        <dd className="m-0 text-ink">MIT</dd>
      </dl>

      <div>
        <SubLabel>Links</SubLabel>
        <div className="mt-2 flex flex-col gap-1.5">
          <ExternalLink href="https://github.com/wangjc683/genericagent-workbench">
            GitHub
          </ExternalLink>
          <ExternalLink href="https://github.com/wangjc683/genericagent-workbench#readme">
            Documentation
          </ExternalLink>
          <ExternalLink href="https://github.com/wangjc683/genericagent-workbench/issues/new">
            Report issue
          </ExternalLink>
        </div>
      </div>

      <div className="border-t border-line pt-4 text-[12px] text-ink-muted">
        Made by JCONE · Open source
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
