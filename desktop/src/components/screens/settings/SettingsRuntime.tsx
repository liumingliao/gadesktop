import {
  ArrowsClockwise,
  CheckCircle,
  FolderOpen,
  Info,
} from "@phosphor-icons/react";

import { HealthCheckCard } from "@/components/health-check/HealthCheckCard";
import { cn } from "@/lib/utils";
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
        subtitle="GenericAgent 的启动参数 · 改动后需要重启 Galley"
      />

      <PathField label="GA Path" value={info.gaPath} onPick={onChangeGAPath} />

      <PathField
        label="Python"
        value={info.pythonVersion}
        // Picker intentionally not wired — Tauri's shell:allow-spawn
        // capability only permits the `python3` / `python` aliases
        // (resolved via PATH). A self-picked absolute path would be
        // rejected at spawn time. To use a non-PATH interpreter,
        // edit src-tauri/capabilities/default.json.
        onPick={onChangeBridgePython}
        readOnly
        hint="使用系统默认的 python3 · 自定义路径需手动编辑 Galley 配置文件"
      />

      <GAVersionCard
        gaCommit={info.gaCommit}
        gaCommitDate={info.gaCommitDate}
        gaBaseline={info.gaBaseline}
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
        Galley v{info.workbenchVersion}
      </div>
    </div>
  );
}

// ---------------- GA Version ----------------

/**
 * "GA Version" card — surfaces what GA commit the user is actually
 * running (gaCommit / gaCommitDate from the ReadyEvent) alongside the
 * workbench-tested baseline. Per the 2026-05-12 product decision:
 * users drive GA's upgrade cadence via `git pull` on their local
 * GenericAgent repo. This row makes the version legible without
 * pretending to police it — no auto-update, no "outdated" badge.
 *
 * Match states:
 *   - Equal commits      → green check ✓ "已对齐 baseline"
 *   - Different commits  → muted info dot "你已自行升级"
 *   - "unknown" commit   → no comparison row (ga_path isn't a git
 *                          checkout — tarball/zip install)
 */
function GAVersionCard({
  gaCommit,
  gaCommitDate,
  gaBaseline,
}: {
  gaCommit: string;
  gaCommitDate: string;
  gaBaseline: string;
}) {
  const isUnknown = gaCommit === "unknown" || gaCommit === "";
  const isMatched = !isUnknown && gaCommit === gaBaseline;
  const currentShort = isUnknown ? "unknown" : gaCommit.slice(0, 7);
  const baselineShort = gaBaseline.slice(0, 7);
  const currentDate = formatCommitDate(gaCommitDate);

  return (
    <div>
      <SubLabel>GenericAgent 版本</SubLabel>
      <div className="mt-2 rounded-sm border border-line bg-surface px-3 py-2.5">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-ink">
          <span className="text-ink-muted">当前版本</span>
          <span>{currentShort}</span>
          {currentDate && (
            <span className="text-ink-muted">· {currentDate}</span>
          )}
        </div>
        {!isUnknown && (
          <div className="mt-1 flex items-center gap-2 font-mono text-[12px] text-ink-soft">
            <span className="text-ink-muted">已验证版本</span>
            <span>{baselineShort}</span>
            <span
              className={cn(
                "ml-1 inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[11px] not-italic",
                isMatched
                  ? "bg-success/10 text-success"
                  : "bg-hover text-ink-muted",
              )}
            >
              {isMatched ? (
                <>
                  <CheckCircle size={11} weight="fill" />
                  已对齐
                </>
              ) : (
                <>
                  <Info size={11} weight="bold" />
                  你已自行升级
                </>
              )}
            </span>
          </div>
        )}
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.55] text-ink-muted">
        新 commit 可能引入兼容问题，下次启动时会自动检查并报告。
      </p>
    </div>
  );
}

/**
 * Extract YYYY-MM-DD from the commit's own ISO timestamp without
 * routing through `new Date()` — that would convert to the viewer's
 * local timezone and silently shift a commit authored late at +08 to
 * "yesterday" for a PST viewer. The commit is a single artifact with
 * one authored date; we display it as the author wrote it, matching
 * what `git log` shows.
 */
function formatCommitDate(iso: string): string {
  if (!iso || iso === "unknown") return "";
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
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
  readOnly = false,
}: {
  label: string;
  value: string;
  hint?: string;
  onPick?: () => void;
  /** When true, the field shows the value but suppresses the picker —
   * used for Bridge Python (see capabilities constraint comment above). */
  readOnly?: boolean;
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
        {!readOnly && (
          <button
            type="button"
            onClick={onPick}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 py-2 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
          >
            <FolderOpen size={13} weight="thin" />
            选择
          </button>
        )}
      </div>
      {hint && <div className="mt-1.5 text-[12px] text-ink-muted">{hint}</div>}
    </div>
  );
}
