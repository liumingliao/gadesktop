import { useEffect, useMemo, useState } from "react";

import {
  StepAttach,
  type PathValidation,
} from "@/components/screens/onboarding/StepAttach";
import { StepHealth } from "@/components/screens/onboarding/StepHealth";
import { StepWelcome } from "@/components/screens/onboarding/StepWelcome";
import { TutorialModal } from "@/components/screens/onboarding/TutorialModal";
import {
  runHealthChecks,
  validateGAPath,
} from "@/lib/onboarding-validation";
import {
  TUTORIALS,
  type Tutorial,
  type TutorialId,
} from "@/lib/onboarding-tutorials";
import { EXAMPLE_GA_PATH } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/useAppStore";
import type { HealthCheckItem } from "@/types/inspector";

export type OnboardingStep = "welcome" | "attach" | "health";

export interface OnboardingProps {
  /** Called when the user completes Step 2 successfully. The host
   * unmounts the Onboarding screen and renders the main app.
   *
   * `pythonAlias` is the Tauri shell-capability name (e.g.
   * "python-framework-3-14") for the interpreter the probe found —
   * what `Command.create()` takes as its first argument. The host
   * persists it to gaConfig so subsequent bridge spawns use the right
   * interpreter. Null when probe failed (the Continue button is
   * disabled in that case, so this is mostly a type-safety hatch). */
  onComplete: (gaPath: string, pythonAlias: string | null) => void;
  /**
   * Flow mode. Default `"fresh"` is the first-launch path: Welcome →
   * Attach → Health → Main view. `"revisit"` is the Settings → "Re-run
   * Health Check" path: jumps straight to Health step (uses the
   * already-saved GA path), relabels Back → "取消" and "进入 Galley"
   * → "返回 Settings", and requires an `onCancel` callback for the
   * Back button (since there's no Attach step to step back to).
   */
  mode?: "fresh" | "revisit";
  /**
   * Required when `mode="revisit"`. Called when the user clicks the
   * (renamed) Back button to abort without re-saving. The host should
   * return the user to wherever they were before triggering the
   * revisit (typically: re-open the Settings dialog).
   */
  onCancel?: () => void;
  /**
   * Required when `mode="revisit"`. Pre-populates the Health step's
   * path input with the user's already-saved GA path so the cascade
   * runs against the right directory without going through Attach.
   */
  initialPath?: string;
}

const STEP_LABELS: { key: OnboardingStep | "done"; label: string }[] = [
  { key: "welcome", label: "欢迎" },
  { key: "attach", label: "接入 GA" },
  { key: "health", label: "Health Check" },
  { key: "done", label: "完成" },
];

/**
 * Top-level Onboarding controller — manages step state, mocked path
 * validation, and a sequential health-check animation. DESIGN.md §5.
 *
 * No AppShell here: Onboarding is a takeover screen, no sidebar or
 * inspector. We reserve top-left padding for the macOS traffic light
 * (which is positioned at {16, 16} via tauri.conf.json).
 *
 * #5 ships with mocked validation + check progression so we can see
 * the full flow without a real bridge subprocess. Real validation
 * (path existence, agentmain.py import, mykey.py parse, LLM config
 * count) wires up in #10 alongside IPC.
 */
export function Onboarding({
  onComplete,
  mode = "fresh",
  onCancel,
  initialPath,
}: OnboardingProps) {
  const isRevisit = mode === "revisit";
  // Revisit jumps straight to Health (Settings already has a saved GA
  // path; user just wants to re-validate). Welcome/Attach are unreachable
  // in this mode — the StepProgress dots still render the full chain for
  // visual continuity, but step state can't backtrack past health.
  const [step, setStep] = useState<OnboardingStep>(
    isRevisit ? "health" : "welcome",
  );
  const [path, setPath] = useState(initialPath ?? EXAMPLE_GA_PATH);
  const [validation, setValidation] = useState<PathValidation>(null);
  // Active tutorial modal id; null = closed. Set by StepAttach
  // tutorial buttons and StepHealth row-action clicks. Surfaces the
  // matching hand-written snippet from `lib/onboarding-tutorials`.
  const [activeTutorial, setActiveTutorial] = useState<TutorialId | null>(
    null,
  );
  // Bumped by the "重新检查" button to re-trigger the runHealthChecks
  // effect without going Back → Continue. Same dep array; an integer
  // change forces the effect to re-fire and cancels any in-flight run.
  const [healthRunNonce, setHealthRunNonce] = useState(0);
  // Tauri shell-capability alias for the Python interpreter the probe
  // chose — survives across re-runs so we don't lose it if the user
  // clicks 重新检查 after a successful first probe. Persisted into
  // gaConfig by onComplete.
  const [probedPython, setProbedPython] = useState<string | null>(null);

  // Debounced real path validation via Tauri fs plugin. The
  // setTimeout pacing keeps the UI responsive while the user is still
  // typing; we don't fire a probe on every keystroke. setState calls
  // are scheduled on a tick to satisfy the
  // react-hooks/set-state-in-effect rule.
  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    if (!path.trim()) {
      timers.push(
        setTimeout(() => {
          if (!cancelled) setValidation(null);
        }, 0),
      );
      return () => {
        cancelled = true;
        timers.forEach(clearTimeout);
      };
    }

    timers.push(
      setTimeout(() => {
        if (!cancelled) setValidation({ kind: "checking" });
      }, 0),
    );

    timers.push(
      setTimeout(() => {
        if (cancelled) return;
        // Real fs check. Errors fall through to "not-found" — same UX
        // since either way the path isn't usable. The picker is the
        // happy path; manual typing surfaces typos here.
        void validateGAPath(path).then((result) => {
          if (cancelled) return;
          setValidation(result);
        });
      }, 350),
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [path]);

  // Health check progression. Driven by real fs probes via
  // runHealthChecks(); each check transitions pending → running →
  // success/warning/failed in sequence. The runner does its own
  // pacing so we don't need a manual setTimeout cascade here.
  const [healthChecks, setHealthChecks] = useState<HealthCheckItem[]>([]);

  // v0.1.1+: when gaConfig.useExternalPython is false (the default),
  // runHealthChecks synthesizes the Python row as a success without
  // spawning anything. Only the legacy external-Python mode runs the
  // probe + populates probedPython. We still subscribe to the toggle
  // value so a user flipping the Settings switch mid-revisit triggers
  // a re-run with the new mode.
  const useExternalPython = useAppStore(
    (s) => s.gaConfig.useExternalPython,
  );

  useEffect(() => {
    if (step !== "health") return;
    const controller = new AbortController();
    void runHealthChecks(path, setHealthChecks, controller.signal, {
      useExternalPython,
      onPythonProbed: (alias) => setProbedPython(alias),
    });
    return () => controller.abort();
  }, [step, path, healthRunNonce, useExternalPython]);

  // Tutorial mapping: each named health check (and StepAttach failure)
  // maps to one fix-it snippet. The action id we hand to
  // HealthCheckCard is the same string as the tutorial id, so the
  // onItemAction handler can look it up directly without a separate
  // dispatch table.
  const itemActions = useMemo<
    Record<string, { id: string; label: string }[]>
  >(
    () => ({
      "GA 路径存在": [{ id: "download-ga", label: "查看教程：下载 GA" }],
      "agentmain.py 可见": [
        { id: "wrong-directory", label: "查看教程：选对目录" },
      ],
      "mykey.py 存在": [
        { id: "mykey-setup", label: "查看教程：配置 API 密钥" },
      ],
      "memory/ 目录可见": [
        { id: "memory-info", label: "查看：为什么是警告" },
      ],
      "assets/ 目录可见": [
        { id: "assets-missing", label: "查看教程：重装 GA" },
      ],
      "Python 解释器": [
        {
          id: "python-missing-anthropic",
          label: "查看教程：在 GA 目录创建 venv",
        },
      ],
    }),
    [],
  );

  const handleItemAction = (
    _item: HealthCheckItem,
    actionId: string,
  ) => {
    if (isTutorialId(actionId)) setActiveTutorial(actionId);
  };

  const handleShowTutorial = (id: TutorialId) => {
    setActiveTutorial(id);
  };

  const activeTutorialEntry: Tutorial | null = activeTutorial
    ? TUTORIALS[activeTutorial]
    : null;

  const handleContinueAttach = () => {
    if (validation?.kind !== "ok") return;
    setStep("health");
  };

  const handleFinish = () => {
    onComplete(path, probedPython);
  };

  return (
    // Outer container is a Tauri drag region so the user can move the
    // window by dragging the empty padding around the content (Onboarding
    // has no TopBar to drag from). The inner 700px content wrapper opts
    // back out so text stays selectable and buttons / inputs work
    // normally — Tauri's drag region inherits down the DOM tree.
    <div
      data-tauri-drag-region
      className="flex h-screen min-h-[720px] w-screen min-w-[1120px] flex-col overflow-y-auto bg-app pl-[80px] pr-16 pt-16"
    >
      <div
        data-tauri-drag-region="false"
        className="mx-auto flex w-full max-w-[700px] flex-col"
      >
        <StepProgress step={step} />

        <div className="mt-10">
          {step === "welcome" && (
            <StepWelcome onStart={() => setStep("attach")} />
          )}
          {step === "attach" && (
            <StepAttach
              path={path}
              validation={validation}
              onPathChange={setPath}
              onPickFolder={() => {
                void pickFolder().then((picked) => {
                  if (picked) setPath(picked);
                });
              }}
              onBack={() => setStep("welcome")}
              onContinue={handleContinueAttach}
              onShowTutorial={handleShowTutorial}
            />
          )}
          {step === "health" && (
            <StepHealth
              items={healthChecks}
              onBack={isRevisit ? (onCancel ?? handleFinish) : () => setStep("attach")}
              onContinue={handleFinish}
              onRetry={() => setHealthRunNonce((n) => n + 1)}
              onItemAction={handleItemAction}
              itemActions={itemActions}
              backLabel={isRevisit ? "取消" : "Back"}
              continueLabel={isRevisit ? "返回 Settings" : "进入 Galley"}
            />
          )}
        </div>
      </div>

      <TutorialModal
        tutorial={activeTutorialEntry}
        onClose={() => setActiveTutorial(null)}
      />
    </div>
  );
}

function isTutorialId(s: string): s is TutorialId {
  return (
    s === "download-ga" ||
    s === "wrong-directory" ||
    s === "mykey-setup" ||
    s === "assets-missing" ||
    s === "memory-info" ||
    s === "python-missing-anthropic"
  );
}

// ---------------- Progress dots ----------------

function StepProgress({ step }: { step: OnboardingStep }) {
  const stepIndex: Record<OnboardingStep | "done", number> = {
    welcome: 0,
    attach: 1,
    health: 2,
    done: 3,
  };
  const current = stepIndex[step];

  return (
    <div className="flex items-center gap-2.5">
      {STEP_LABELS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s.key} className="flex items-center gap-2.5">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span
                className={cn(
                  "inline-flex size-[18px] items-center justify-center rounded-full text-[11px] font-semibold",
                  done && "bg-brand text-ink",
                  active && "bg-ink text-elevated",
                  !done &&
                    !active &&
                    "border border-line-strong text-ink-muted",
                )}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={cn(
                  active ? "font-medium text-ink" : "text-ink-muted",
                )}
              >
                {s.label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <span className="h-px w-[60px] bg-line" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- Folder picker ----------------

/**
 * Tauri dialog folder picker. Lazy import keeps Vite-only dev from
 * choking on the plugin shim. Returns the picked path or null on
 * cancel / error.
 */
async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 GenericAgent 仓库目录",
    });
    return typeof selected === "string" && selected.length > 0
      ? selected
      : null;
  } catch (e) {
    console.warn("[onboarding] pickFolder failed.", e);
    return null;
  }
}

