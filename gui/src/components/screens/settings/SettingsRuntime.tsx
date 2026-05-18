import {
  ArrowsClockwise,
  Check,
  CheckCircle,
  CircleNotch,
  FolderOpen,
  Info,
  Package,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { PathValidation } from "@/components/screens/onboarding/StepAttach";
import {
  BUNDLED_PYTHON_VERSION,
  validateGAPath,
} from "@/lib/onboarding-validation";
import { cn } from "@/lib/utils";
import type { RuntimeInfo } from "@/types/inspector";

interface SettingsRuntimeProps {
  info: RuntimeInfo;
  /**
   * v0.1.1+: when false (default), Galley spawns its own bundled Python
   * interpreter and the Python panel is a read-only info card. When
   * true, the legacy picker UI is shown so the user can point Galley
   * at an external interpreter (their own venv, conda env, etc).
   */
  useExternalPython: boolean;
  onChangeGAPath?: () => void;
  onChangeBridgePython?: () => void;
  onReRunHealthCheck?: () => void;
  /**
   * Toggle the bundled-vs-external Python mode. Persisted via
   * `setGAConfig({ useExternalPython })`. Takes effect on the next
   * bridge spawn — running sessions keep their current Python.
   */
  onToggleExternalPython?: (useExternal: boolean) => void;
  /**
   * Commit a manually-typed GA path. Called on Enter / blur when the
   * draft differs from the saved value and validation hasn't returned
   * `not-found`. App-level handler should run the same
   * `setGAConfig({ gaPath })` flow as the folder picker.
   */
  onCommitGAPath?: (path: string) => Promise<void>;
}

/**
 * Settings → Runtime tab. DESIGN.md §9 Runtime tab.
 *
 * GA Path supports both the folder picker (Tauri shell integration)
 * and manual typing — the latter covers paste-from-elsewhere, paths
 * that don't exist yet (preconfiguring before `git clone`), and quick
 * tweaks. Bridge Python stays picker-suppressed; the python-probe
 * (lib/python-probe.ts) owns interpreter selection in V0.1.
 *
 * Re-run health check routes back through Onboarding's StepHealth in
 * revisit mode — one canonical health-check UX.
 *
 * baseline + version are read-only mono labels at the bottom.
 */
export function SettingsRuntime({
  info,
  useExternalPython,
  onChangeGAPath,
  onChangeBridgePython,
  onReRunHealthCheck,
  onToggleExternalPython,
  onCommitGAPath,
}: SettingsRuntimeProps) {
  return (
    <div className="space-y-7">
      <SectionTitle
        title="Runtime"
        subtitle="GenericAgent 的启动参数 · 改动后需要重启 Galley"
      />

      <PathField
        label="GA Path"
        value={info.gaPath}
        onPick={onChangeGAPath}
        onCommit={onCommitGAPath}
        hint="点「选择」走文件夹选取，或直接在框里输入 / 粘贴路径 · 回车提交"
      />

      <PythonPanel
        useExternal={useExternalPython}
        externalPath={info.pythonVersion}
        onChangeExternalPath={onChangeBridgePython}
        onToggle={onToggleExternalPython}
      />

      <GAVersionCard
        gaCommit={info.gaCommit}
        gaCommitDate={info.gaCommitDate}
        gaBaseline={info.gaBaseline}
      />

      <div>
        <SubLabel>Health Check</SubLabel>
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft">
          不知道哪儿出问题了？跑一次完整体检 ——
          重新探测 Python 解释器、检查 GA 路径和必要文件。
        </p>
        <button
          type="button"
          onClick={onReRunHealthCheck}
          className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
        >
          <ArrowsClockwise size={13} weight="thin" />
          跑一次 Health Check
        </button>
      </div>

      <div className="border-t border-line pt-4 font-mono text-[11px] text-ink-muted">
        Galley v{info.workbenchVersion}
      </div>
    </div>
  );
}

// ---------------- Python (bundled / external) ----------------

/**
 * Python interpreter panel. Two visual modes:
 *
 *   - **Bundled (default, v0.1.1+)**: read-only card showing
 *     "Galley 内置 Python <version>". Galley ships its own CPython
 *     with GA deps pre-staged via scripts/bundle-python.sh, so the
 *     user doesn't pick anything. A small "使用外部 Python…" toggle
 *     under the card reveals the legacy picker for advanced users
 *     (custom GA forks, live venv iteration).
 *
 *   - **External**: a read-only PathField mirrors the
 *     python-probe-selected path the way it did pre-v0.1.1. Same
 *     "Re-run Health Check" button below (in the parent) re-triggers
 *     the probe. A "改回 Galley 内置 Python" toggle returns to
 *     bundled mode.
 *
 * Toggle hands off to the parent via `onToggle(bool)` — caller
 * persists through `setGAConfig({useExternalPython})`. UI confirms
 * implicitly: changing the toggle is the user's intent declaration.
 */
function PythonPanel({
  useExternal,
  externalPath,
  onChangeExternalPath,
  onToggle,
}: {
  useExternal: boolean;
  externalPath: string;
  onChangeExternalPath?: () => void;
  onToggle?: (useExternal: boolean) => void;
}) {
  if (!useExternal) {
    return (
      <div>
        <SubLabel>Python</SubLabel>
        <div className="mt-2 flex items-center gap-3 rounded-sm border border-line bg-surface px-3 py-2.5">
          <Package
            size={18}
            weight="thin"
            className="shrink-0 text-ink-soft"
          />
          <div className="min-w-0">
            <div className="font-mono text-[12.5px] text-ink">
              CPython {BUNDLED_PYTHON_VERSION}
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-muted">
              Galley 内置 · 已附带 GA 依赖，零配置可用
            </div>
          </div>
        </div>
        {onToggle && (
          <button
            type="button"
            onClick={() => onToggle(true)}
            className="mt-2 text-[11.5px] text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            使用外部 Python…
          </button>
        )}
      </div>
    );
  }
  return (
    <div>
      <PathField
        label="Python"
        value={externalPath}
        // External mode keeps the V0.1-era picker-suppressed behavior:
        // the probe owns selection; we surface the resolved path for
        // visibility, and Re-run Health Check (button below in
        // parent) re-probes when needed.
        onPick={onChangeExternalPath}
        readOnly
        hint="外部 Python · 改变后用下方 Re-run 重新探测"
      />
      {onToggle && (
        <button
          type="button"
          onClick={() => onToggle(false)}
          className="mt-2 text-[11.5px] text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          改回 Galley 内置 Python
        </button>
      )}
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

/**
 * Path field with three modes:
 *   - readonly: display-only (Python — value comes from probe)
 *   - picker:   value + folder picker button (no manual typing)
 *   - editable: input is typeable; commit on Enter / blur. Folder
 *               picker stays available when `onPick` is also provided.
 *
 * Editable mode runs `validateGAPath` debounced (300ms) and renders an
 * inline status line. Commit is blocked only on `not-found` — picker
 * also accepts whatever the OS dialog returns without validation, so
 * typed paths follow the same trust model except for the impossible
 * case.
 */
function PathField({
  label,
  value,
  hint,
  onPick,
  onCommit,
  readOnly = false,
}: {
  label: string;
  value: string;
  hint?: string;
  onPick?: () => void;
  /** When provided, the input becomes editable + validates on type +
   * commits on Enter / blur. Picker (if `onPick` set) still works in
   * parallel. */
  onCommit?: (path: string) => Promise<void>;
  /** When true, the field shows the value but suppresses the picker —
   * used for Bridge Python (see capabilities constraint comment above). */
  readOnly?: boolean;
}) {
  const editable = !!onCommit;
  const [draft, setDraft] = useState(value);
  const [validation, setValidation] = useState<PathValidation>(null);

  // Re-sync draft + validation when the saved value changes externally
  // (picker commit, store hydration). Uses React's "adjust state on
  // prop change" pattern — compare during render, write state, let
  // React bail out and re-render with the new value. Avoids the
  // cascading-render issue of doing the same in an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSyncedValue, setLastSyncedValue] = useState(value);
  if (lastSyncedValue !== value) {
    setLastSyncedValue(value);
    setDraft(value);
    setValidation(null);
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setDraft(next);
    // Decide synchronously whether validation will be needed; the
    // async fs probe is scheduled in the effect below. Doing the
    // null / checking transition here (driven by user input) keeps
    // the effect free of synchronous setState in its body.
    const trimmed = next.trim();
    if (trimmed === "" || trimmed === value) {
      setValidation(null);
    } else {
      setValidation({ kind: "checking" });
    }
  };

  // Debounced async validation. The effect body itself does no
  // synchronous state writes — only schedules a timeout that calls
  // setValidation inside its callback (which is fine per the
  // set-state-in-effect rule). State transitions for the trivial
  // cases happen in handleChange + the prop-sync block above.
  useEffect(() => {
    if (!editable) return;
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === value) return;
    const id = setTimeout(() => {
      void (async () => {
        const v = await validateGAPath(trimmed);
        setValidation(v);
      })();
    }, 300);
    return () => clearTimeout(id);
  }, [draft, editable, value]);

  const tryCommit = async () => {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === value) {
      // Empty or no-op → silently revert UI to saved value.
      setDraft(value);
      setValidation(null);
      return;
    }
    // Force a settled validation result so a fast Enter doesn't slip
    // a `not-found` path through during the debounce window.
    setValidation({ kind: "checking" });
    const v = await validateGAPath(trimmed);
    setValidation(v);
    if (v?.kind === "not-found") {
      // Block commit; keep draft + error visible so the user can fix.
      return;
    }
    await onCommit!(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(value);
      setValidation(null);
      e.currentTarget.blur();
    }
  };

  return (
    <div>
      <SubLabel>{label}</SubLabel>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={editable ? draft : value}
          readOnly={!editable}
          onChange={editable ? handleChange : undefined}
          onBlur={editable ? () => void tryCommit() : undefined}
          onKeyDown={editable ? handleKeyDown : undefined}
          spellCheck={false}
          className={cn(
            "min-w-0 flex-1 rounded-sm border border-line bg-surface px-3 py-2 font-mono text-[12.5px] text-ink outline-none",
            editable &&
              "focus:border-brand focus:ring-[3px] focus:ring-brand/20",
          )}
        />
        {!readOnly && (
          <button
            type="button"
            // Prevent the input's blur-commit from firing before the
            // picker's selection lands. Otherwise a dirty draft would
            // commit, then immediately get overwritten by the picker
            // result — double toast, confusing audit trail.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPick}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 py-2 text-[12.5px] text-ink-soft transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink"
          >
            <FolderOpen size={13} weight="thin" />
            选择
          </button>
        )}
      </div>
      {editable && <ValidationLine validation={validation} />}
      {hint && <div className="mt-1.5 text-[12px] text-ink-muted">{hint}</div>}
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
          路径有效
          {validation.foundAgentmain && (
            <span className="text-ink-muted">· agentmain.py 可见</span>
          )}
        </div>
      );
    case "missing-agentmain":
      return (
        <div className={cn(cls, "text-warning")}>
          <Warning size={12} weight="thin" />
          路径存在但未找到 agentmain.py — 仍会保存，但确认这是 GA 目录？
        </div>
      );
    case "not-found":
      return (
        <div className={cn(cls, "text-error")}>
          <X size={12} weight="thin" />
          路径不存在 · 不会保存
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
