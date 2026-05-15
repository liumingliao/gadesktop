/**
 * Onboarding validation primitives — Stage 3 Task 5.
 *
 * Replaces the mock validation that shipped with the Onboarding flow
 * (#5). Uses Tauri's fs plugin to do real `exists()` checks against
 * the user-picked path and the GA repo's expected layout.
 *
 * Filesystem layer + a Python interpreter probe (added 2026-05-15
 * after the first packaged-build dogfood revealed that the bridge's
 * Python in prod was the macOS-bundled 3.9.6 with no GA deps). The
 * probe is what catches the "anthropic missing" failure mode the user
 * would otherwise hit on first send-message. See lib/python-probe.ts
 * for the rationale.
 */

import type { PathValidation } from "@/components/screens/onboarding/StepAttach";
import { probePython, type ProbeResult } from "@/lib/python-probe";
import type { HealthCheckItem } from "@/types/inspector";

// Trimmed paths only — leading/trailing whitespace from the input is
// stripped before validation. Tauri's `exists()` is async; calls are
// debounced upstream so we don't query on every keystroke.

/**
 * Validate the user's chosen GA path for the Attach step.
 *
 * Three terminal outcomes:
 *   - `not-found`        path doesn't exist on disk
 *   - `missing-agentmain` path exists but agentmain.py is missing —
 *                         user picked a different directory
 *   - `ok`               path exists and contains agentmain.py
 *
 * Returns `null` for empty input (no feedback to show).
 */
export async function validateGAPath(rawPath: string): Promise<PathValidation> {
  const path = rawPath.trim();
  if (!path) return null;
  // Expand `~` since Tauri's exists() doesn't do shell-style expansion.
  // The picker dialog returns absolute paths so this only matters when
  // the user types manually.
  const resolved = await expandHome(path);
  let pathOk: boolean;
  try {
    pathOk = await fsExists(resolved);
  } catch (e) {
    console.warn("[onboarding] fs.exists(path) failed:", e);
    return { kind: "not-found", rawPath: path };
  }
  if (!pathOk) return { kind: "not-found", rawPath: path };

  let agentmainOk = false;
  try {
    agentmainOk = await fsExists(joinPath(resolved, "agentmain.py"));
  } catch (e) {
    console.warn("[onboarding] fs.exists(agentmain.py) failed:", e);
  }
  if (!agentmainOk) return { kind: "missing-agentmain", rawPath: path };
  return { kind: "ok", foundAgentmain: true, rawPath: path };
}

/**
 * Run the health check against the chosen path. Each check fires
 * sequentially with a brief delay so the user sees the progression —
 * same visual rhythm as the original mock, just driven by real fs
 * probes. The last row is a Python interpreter probe (see
 * lib/python-probe.ts) — the only check that exec'es a subprocess.
 *
 * Caller passes:
 *   - `path`: the validated GA path
 *   - `onUpdate(items)`: called every time the check list changes
 *     (running / success / warning state transitions)
 *   - `signal`: AbortSignal so the host can cancel if the user
 *     navigates away from the Health step mid-run
 *   - `options.onPythonProbed`: callback fired when the Python row
 *     resolves. Receives the winning alias (a Tauri shell-capability
 *     `name` like "python-framework-3-14") or null when every
 *     candidate failed. Onboarding uses this to seed gaConfig.python
 *     so the subsequent bridge spawn uses the right interpreter.
 *
 * Resolves when the run completes (or aborts). The final `items`
 * snapshot is also passed to onUpdate; callers don't need to track
 * the return value separately.
 */
export async function runHealthChecks(
  path: string,
  onUpdate: (items: HealthCheckItem[]) => void,
  signal: AbortSignal,
  options?: {
    onPythonProbed?: (alias: string | null, result: ProbeResult) => void;
  },
): Promise<HealthCheckItem[]> {
  const resolved = await expandHome(path.trim());
  const probes: HealthProbe[] = [
    {
      name: "GA 路径存在",
      detail: path,
      check: () => fsExists(resolved),
    },
    {
      name: "agentmain.py 可见",
      detail: "GA 入口模块",
      check: () => fsExists(joinPath(resolved, "agentmain.py")),
    },
    {
      name: "mykey.py 存在",
      detail: "LLM 配置文件",
      check: () => fsExists(joinPath(resolved, "mykey.py")),
      // mykey.py is user-supplied + .gitignored; a missing file is a
      // warning rather than an error — the user can still attach and
      // configure later.
      warnOnMissing: true,
    },
    {
      name: "memory/ 目录可见",
      detail: "L1-L4 记忆存储",
      check: () => fsExists(joinPath(resolved, "memory")),
      warnOnMissing: true,
    },
    {
      name: "assets/ 目录可见",
      detail: "GA 资源目录",
      check: () => fsExists(joinPath(resolved, "assets")),
      warnOnMissing: true,
    },
  ];

  const pythonRow: HealthCheckItem = {
    name: "Python 解释器",
    detail: "查找能加载 GA 的 Python",
    state: "pending",
  };
  let items: HealthCheckItem[] = [
    ...probes.map<HealthCheckItem>((p) => ({
      name: p.name,
      detail: p.detail,
      state: "pending",
    })),
    pythonRow,
  ];
  onUpdate(items);

  for (let i = 0; i < probes.length; i++) {
    if (signal.aborted) return items;
    // Flip current row to running so the user sees the spinner walk
    // down the list.
    items = items.map((c, idx) =>
      idx === i ? { ...c, state: "running" } : c,
    );
    onUpdate(items);

    // Brief paced delay so the animation reads as deliberate work
    // rather than a flash. Real fs.exists() is <1ms.
    await sleep(220);
    if (signal.aborted) return items;

    let ok: boolean;
    try {
      ok = await probes[i].check();
    } catch (e) {
      console.warn(`[onboarding] health probe ${probes[i].name} failed:`, e);
      ok = false;
    }
    const finalState: HealthCheckItem["state"] = ok
      ? "success"
      : probes[i].warnOnMissing
        ? "warning"
        : "failed";
    items = items.map((c, idx) =>
      idx === i ? { ...c, state: finalState } : c,
    );
    onUpdate(items);
  }

  // Python probe — the only row that actually spawns a subprocess.
  // Runs after the fs probes so the visual cascade is consistent.
  if (signal.aborted) return items;
  const pythonIdx = items.length - 1;
  items = items.map((c, idx) =>
    idx === pythonIdx ? { ...c, state: "running" } : c,
  );
  onUpdate(items);

  // Pass the GA path to the probe so it validates the actual import
  // chain (`sys.path.insert(0, gaPath); import agentmain`) rather
  // than a generic deps check. Catches venv mismatches that a
  // gaPath-agnostic probe would silently pass.
  const probeResult = await probePython(resolved, signal);
  if (signal.aborted) return items;

  if (probeResult.winner) {
    items = items.map((c, idx) =>
      idx === pythonIdx
        ? {
            ...c,
            state: "success",
            detail: `${probeResult.winner!.label} · ${probeResult.winner!.displayPath}`,
          }
        : c,
    );
    options?.onPythonProbed?.(probeResult.winner.alias, probeResult);
  } else {
    items = items.map((c, idx) =>
      idx === pythonIdx
        ? {
            ...c,
            state: "failed",
            detail:
              "在常见路径未找到能加载 GA 的 Python · 请先在 GA 目录把依赖装到一个 .venv 里",
          }
        : c,
    );
    options?.onPythonProbed?.(null, probeResult);
  }
  onUpdate(items);

  return items;
}

// ---------------- internals ----------------

interface HealthProbe {
  name: string;
  detail: string;
  check: () => Promise<boolean>;
  /** Treat false result as `warning` not `error`. For non-critical
   * files like mykey.py / memory/ that user may set up later. */
  warnOnMissing?: boolean;
}

async function fsExists(path: string): Promise<boolean> {
  // Lazy import so a Vite-only dev build doesn't fail to load just
  // because the Tauri plugin shim is missing.
  const { exists } = await import("@tauri-apps/plugin-fs");
  return exists(path);
}

/**
 * Replace leading `~` with the user's home directory. Tauri's
 * `homeDir()` returns absolute path; concat the rest of the input.
 * No-op when the input doesn't start with `~`.
 */
async function expandHome(path: string): Promise<string> {
  if (!path.startsWith("~")) return path;
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    const home = await homeDir();
    return home + path.slice(1);
  } catch (e) {
    console.warn("[onboarding] expandHome failed; using raw path.", e);
    return path;
  }
}

/** Trivial path-join — Tauri 的 fs 接受平台原生分隔符；macOS 上是 "/"。 */
function joinPath(a: string, b: string): string {
  if (a.endsWith("/")) return a + b;
  return a + "/" + b;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
