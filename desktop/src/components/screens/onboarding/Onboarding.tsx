import { useEffect, useState } from "react";

import {
  StepAttach,
  type PathValidation,
} from "@/components/screens/onboarding/StepAttach";
import { StepHealth } from "@/components/screens/onboarding/StepHealth";
import { StepWelcome } from "@/components/screens/onboarding/StepWelcome";
import { cn } from "@/lib/utils";
import type { HealthCheckItem } from "@/types/inspector";

export type OnboardingStep = "welcome" | "attach" | "health";

export interface OnboardingProps {
  /** Called when the user completes Step 2 successfully. The host
   * unmounts the Onboarding screen and renders the main app. */
  onComplete: (gaPath: string) => void;
}

const STEP_LABELS: { key: OnboardingStep | "done"; label: string }[] = [
  { key: "welcome", label: "欢迎" },
  { key: "attach", label: "Attach GA" },
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
export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [path, setPath] = useState("~/Documents/GenericAgent");
  const [validation, setValidation] = useState<PathValidation>(null);

  // Debounced mock path validation. Real validation routes through a
  // Tauri command in #10.
  //
  // All setState calls are scheduled on a tick so we satisfy the
  // react-hooks/set-state-in-effect rule (no synchronous setState
  // inside the effect body).
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
        // Mock: path containing "GenericAgent" or "GA" is valid;
        // ending with "incomplete" triggers the missing-agentmain
        // warning state for visual demo; otherwise not-found.
        if (path.endsWith("incomplete")) {
          setValidation({ kind: "missing-agentmain", rawPath: path });
        } else if (path.includes("GenericAgent") || path.includes("GA")) {
          setValidation({ kind: "ok", foundAgentmain: true, rawPath: path });
        } else {
          setValidation({ kind: "not-found", rawPath: path });
        }
      }, 350),
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [path]);

  // Health check progression. Each check transitions
  // pending -> running -> success in sequence with short delays.
  const [healthChecks, setHealthChecks] = useState<HealthCheckItem[]>(() =>
    initialHealthChecks(path),
  );

  useEffect(() => {
    if (step !== "health") return;

    // All state writes are inside setTimeout callbacks (so the
    // synchronous-setState-in-effect rule stays happy).
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const baseDelay = 100;
    const runDelay = 350;
    const interTick = 220;

    // Reset to pending at the start of the run.
    timers.push(
      setTimeout(() => {
        if (!cancelled) setHealthChecks(initialHealthChecks(path));
      }, 0),
    );

    const tickAt = (i: number, atMs: number) => {
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setHealthChecks((prev) =>
            prev.map((c, idx) => (idx === i ? { ...c, state: "running" } : c)),
          );
        }, atMs),
      );
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setHealthChecks((prev) =>
            prev.map((c, idx) => (idx === i ? { ...c, state: "success" } : c)),
          );
        }, atMs + runDelay),
      );
    };

    for (let i = 0; i < 5; i++) {
      tickAt(i, baseDelay + i * (runDelay + interTick));
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [step, path]);

  const handleContinueAttach = () => {
    if (validation?.kind !== "ok") return;
    setStep("health");
  };

  const handleFinish = () => {
    onComplete(path);
  };

  return (
    <div className="flex h-screen min-h-[720px] w-screen min-w-[1120px] flex-col overflow-y-auto bg-app pl-[80px] pr-16 pt-16">
      <div className="mx-auto flex w-full max-w-[700px] flex-col">
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
              onPickFolder={() =>
                console.info("[onboarding] folder picker — wired in #10")
              }
              onBack={() => setStep("welcome")}
              onContinue={handleContinueAttach}
            />
          )}
          {step === "health" && (
            <StepHealth
              items={healthChecks}
              onBack={() => setStep("attach")}
              onContinue={handleFinish}
            />
          )}
        </div>
      </div>
    </div>
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

// ---------------- Mock data ----------------

function initialHealthChecks(path: string): HealthCheckItem[] {
  return [
    { name: "路径存在", detail: path, state: "pending" },
    {
      name: "Python 可用",
      detail: "Python 3.11.9 (system)",
      state: "pending",
    },
    {
      name: "agentmain.py 可 import",
      detail: "GA baseline 6a3eecc · OK",
      state: "pending",
    },
    {
      name: "mykey.py 存在",
      detail: `${path}/mykey.py · 5 LLM`,
      state: "pending",
    },
    {
      name: "至少一个 LLM 配置可解析",
      detail: "Claude / OAI / Gemini · parse OK",
      state: "pending",
    },
  ];
}
