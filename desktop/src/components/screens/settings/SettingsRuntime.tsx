import { ArrowsClockwise, FolderOpen } from "@phosphor-icons/react";

import { HealthCheckCard } from "@/components/health-check/HealthCheckCard";
import type { RuntimeInfo } from "@/types/inspector";

interface SettingsRuntimeProps {
  info: RuntimeInfo;
  onChangeGAPath?: () => void;
  onChangeBridgePython?: () => void;
  onReRunHealthCheck?: () => void;
}

/**
 * Settings → Runtime tab. DESIGN.md §9 Runtime tab.
 *
 * GA path + Bridge Python paths are immutable inputs that route to a
 * folder picker (Tauri shell integration in #10). Changing GA path
 * pops a confirm dialog "重启 Workbench 才能生效"; we don't kill
 * sessions silently — that's per the §9 decision.
 *
 * Re-run health check returns the user to a transient HealthCheckCard
 * popup; today we just embed the card inline.
 *
 * baseline + version are read-only mono labels at the bottom.
 */
export function SettingsRuntime({
  info,
  onChangeGAPath,
  onChangeBridgePython,
  onReRunHealthCheck,
}: SettingsRuntimeProps) {
  return (
    <div className="space-y-7">
      <SectionTitle
        title="Runtime"
        subtitle="GA 子进程的启动参数 · 改动后需要重启 Workbench"
      />

      <PathField label="GA Path" value={info.gaPath} onPick={onChangeGAPath} />

      <PathField
        label="Bridge Python"
        value={info.pythonVersion}
        onPick={onChangeBridgePython}
        hint="用于运行 bridge，影响 GA 子进程"
      />

      <div>
        <SubLabel>Health Check</SubLabel>
        <div className="mt-2">
          <HealthCheckCard
            items={info.healthChecks}
            variant="standalone"
            showFooter={false}
          />
        </div>
        <button
          type="button"
          onClick={onReRunHealthCheck}
          className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
        >
          <ArrowsClockwise size={13} weight="thin" />
          Re-run health check
        </button>
      </div>

      <div className="border-t border-line pt-4 font-mono text-[11px] text-ink-muted">
        GA baseline: {info.gaBaseline.slice(0, 7)} · Workbench v
        {info.workbenchVersion}
      </div>
    </div>
  );
}

// ---------------- atoms ----------------

function SectionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <h2 className="m-0 font-serif text-[18px] font-medium text-ink">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-1 text-[12.5px] text-ink-muted">{subtitle}</p>
      )}
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

function PathField({
  label,
  value,
  hint,
  onPick,
}: {
  label: string;
  value: string;
  hint?: string;
  onPick?: () => void;
}) {
  return (
    <div>
      <SubLabel>{label}</SubLabel>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={value}
          readOnly
          className="min-w-0 flex-1 rounded-sm border border-line bg-surface px-3 py-2 font-mono text-[12.5px] text-ink outline-none"
        />
        <button
          type="button"
          onClick={onPick}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 py-2 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
        >
          <FolderOpen size={13} weight="thin" />
          选择
        </button>
      </div>
      {hint && <div className="mt-1.5 text-[12px] text-ink-muted">{hint}</div>}
    </div>
  );
}
