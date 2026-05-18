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
  // Expand `~` and normalize separators / mixed slashes via Tauri's
  // path API. Critical on Windows — see `resolvePath` comment for the
  // user-reported bug this fixes.
  const resolved = await resolvePath(path);
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
    agentmainOk = await fsExists(await joinPath(resolved, "agentmain.py"));
  } catch (e) {
    console.warn("[onboarding] fs.exists(agentmain.py) failed:", e);
  }
  if (!agentmainOk) return { kind: "missing-agentmain", rawPath: path };
  return { kind: "ok", foundAgentmain: true, rawPath: path };
}

/**
 * Version of the bundled CPython, mirrored from
 * scripts/bundle-python.sh's `PBS_PYTHON_VERSION`. Surfaced in the
 * Health Check row + Settings → Runtime panel as the user-facing
 * version label. Update together when the bundle script's pin moves.
 */
export const BUNDLED_PYTHON_VERSION = "3.11.15";

/**
 * Run the health check against the chosen path. Each check fires
 * sequentially with a brief delay so the user sees the progression —
 * same visual rhythm as the original mock, just driven by real fs
 * probes. The last row is the Python interpreter status.
 *
 * Python row has two modes:
 *   - **Bundled (default, v0.1.1+)**: synthesized success row showing
 *     "Galley 内置 Python <version>". No subprocess spawn — the
 *     bundle ships with GA core deps pre-installed and is validated
 *     at build time by bundle-python.sh.
 *   - **External (`useExternalPython=true`)**: legacy behavior —
 *     spawn the python-probe subprocess to find a user-installed
 *     interpreter with GA's deps. Surfaces tutorial fix-it links if
 *     no candidate succeeds.
 *
 * Caller passes:
 *   - `path`: the validated GA path
 *   - `onUpdate(items)`: called every time the check list changes
 *     (running / success / warning state transitions)
 *   - `signal`: AbortSignal so the host can cancel if the user
 *     navigates away from the Health step mid-run
 *   - `options.useExternalPython`: when true, run the probe. Default
 *     false — synthesize the bundled-Python success row.
 *   - `options.onPythonProbed`: only fired when `useExternalPython`
 *     is true. Receives the winning alias (Tauri shell-capability
 *     name like "python-framework-3-14") or null when every
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
    useExternalPython?: boolean;
    onPythonProbed?: (alias: string | null, result: ProbeResult) => void;
  },
): Promise<HealthCheckItem[]> {
  const resolved = await resolvePath(path.trim());
  const probes: HealthProbe[] = [
    {
      name: "GA 路径存在",
      detail: path,
      check: () => fsExists(resolved),
    },
    {
      name: "agentmain.py 可见",
      detail: "GA 入口模块",
      check: async () => fsExists(await joinPath(resolved, "agentmain.py")),
    },
    {
      name: "mykey.py 存在",
      detail: "LLM 配置文件",
      check: async () => fsExists(await joinPath(resolved, "mykey.py")),
      // mykey.py is user-supplied + .gitignored; a missing file is a
      // warning rather than an error — the user can still attach and
      // configure later.
      warnOnMissing: true,
    },
    {
      name: "memory/ 目录可见",
      detail: "L1-L4 记忆存储",
      check: async () => fsExists(await joinPath(resolved, "memory")),
      warnOnMissing: true,
    },
    {
      name: "assets/ 目录可见",
      detail: "GA 资源目录",
      check: async () => fsExists(await joinPath(resolved, "assets")),
      warnOnMissing: true,
    },
  ];

  const useExternalPython = options?.useExternalPython ?? false;
  // Two row identities. The label diverges so the Onboarding
  // itemActions map (which keys by name) only attaches the "fix it"
  // tutorial buttons in external mode — bundled-mode row has no
  // failure path so no actions are needed.
  const pythonRow: HealthCheckItem = useExternalPython
    ? {
        name: "Python 解释器",
        detail: "查找能加载 GA 的 Python",
        state: "pending",
      }
    : {
        name: "Galley 内置 Python",
        detail: `CPython ${BUNDLED_PYTHON_VERSION} · 已附带 GA 依赖`,
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

  // Python row. Bundled mode (default v0.1.1+) synthesizes a success
  // row — no subprocess spawn, no probe. bundle-python.sh runs
  // `import agentmain` against the staged interpreter at build time;
  // by the time a .dmg / .exe ships, the bundle is already verified.
  // External mode runs the legacy spawn-based probe.
  if (signal.aborted) return items;
  const pythonIdx = items.length - 1;
  items = items.map((c, idx) =>
    idx === pythonIdx ? { ...c, state: "running" } : c,
  );
  onUpdate(items);

  if (!useExternalPython) {
    // Brief paced delay so the row reads as a deliberate check rather
    // than flashing past — matches the fs probes' rhythm above.
    await sleep(220);
    if (signal.aborted) return items;
    items = items.map((c, idx) =>
      idx === pythonIdx ? { ...c, state: "success" } : c,
    );
    onUpdate(items);
    return items;
  }

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
  // Routes through our custom `path_exists` Tauri command (Rust side,
  // core/src/lib.rs) instead of `@tauri-apps/plugin-fs`'s
  // `exists()`. The plugin-fs version is gated by `fs:scope` in
  // capabilities/default.json which defaults to a user-profile glob
  // allow-list — fine for Tauri's sandboxed-web threat model, but
  // wrong for Galley: a v0.1-alpha Windows user with GA at
  // `D:\projects_2026\GenericAgent` saw every health-check row fail
  // because `D:\` wasn't in the allow-list. See the command's doc
  // comment for the full rationale. Lazy import keeps a Vite-only
  // dev build loadable when the Tauri shim isn't present.
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("path_exists", { path });
}

/**
 * Expand `~` to the user's home directory **and** normalize the path
 * to the platform-native form via Tauri's path API.
 *
 * The normalize step was added 2026-05-15 after a Windows v0.1-alpha.1
 * user report: picking a valid GA folder via the OS dialog was still
 * flagged as "错误路径" by validateGAPath, but appending a trailing
 * `\` in the input box made it pass. Root cause was the old
 * `joinPath` doing string concat with a hardcoded `/`, producing
 * mixed-separator paths like `C:\Users\foo\GA/agentmain.py` that
 * Tauri's fs:scope check on Windows handles inconsistently — the
 * trailing `\` happened to nudge it into a code path that worked.
 * Routing both expansion and join through `@tauri-apps/api/path`
 * gives us platform-correct separators on all targets.
 */
async function resolvePath(path: string): Promise<string> {
  let p = path;
  if (p.startsWith("~")) {
    try {
      const { homeDir } = await import("@tauri-apps/api/path");
      const home = await homeDir();
      p = home + p.slice(1);
    } catch (e) {
      console.warn(
        "[onboarding] homeDir lookup failed; using raw path.",
        e,
      );
    }
  }
  try {
    const { normalize } = await import("@tauri-apps/api/path");
    p = await normalize(p);
  } catch (e) {
    console.warn(
      "[onboarding] path normalize failed; using raw path.",
      e,
    );
  }
  return p;
}

/**
 * Platform-native path join. Delegates to `@tauri-apps/api/path.join`
 * so Windows gets `\` and POSIX gets `/`. See `resolvePath` above for
 * the Windows-specific bug that motivated routing this through Tauri.
 */
async function joinPath(a: string, b: string): Promise<string> {
  try {
    const { join } = await import("@tauri-apps/api/path");
    return await join(a, b);
  } catch (e) {
    console.warn(
      "[onboarding] joinPath via Tauri API failed; falling back.",
      e,
    );
    // POSIX-only fallback; only hit if the Tauri path plugin isn't
    // loadable (Vite-only dev). Accept either trailing separator.
    if (a.endsWith("/") || a.endsWith("\\")) return a + b;
    return a + "/" + b;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
