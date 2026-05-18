/**
 * Python interpreter probe.
 *
 * Background — why this exists:
 *
 * In dev (`pnpm tauri dev`), the bridge subprocess inherits the
 * terminal's PATH, so `python3` resolves to whatever the user has
 * installed (Homebrew, Python.org framework, pyenv, conda, etc.) —
 * usually a Python that can load GA's `agentmain`.
 *
 * In a packaged `.app` launched from Finder, PATH is the launchd
 * default (`/usr/bin:/bin:...`). `python3` resolves to
 * `/Library/Developer/CommandLineTools/usr/bin/python3` (macOS-bundled,
 * 3.9.6) which has none of GA's deps — bridge dies on import.
 *
 * The probe walks a list of well-known Python paths registered in the
 * Tauri shell capability allowlist and, for each, executes a short
 * Python script that does the bare-minimum equivalent of what the
 * bridge will do: `sys.path.insert(0, gaPath); import agentmain`.
 * First candidate that prints `ok` wins. Caller persists the winning
 * alias name to `prefs.ga_config.python` so subsequent launches skip
 * the probe.
 *
 * Why this validation surface (vs. e.g. `import anthropic`):
 *   - GA calls LLM HTTP endpoints with raw `requests` — it does NOT
 *     use the `anthropic` / `openai` SDKs. The first iteration of
 *     this probe used those imports and false-negatived JC's Mac.
 *   - `import agentmain` is the most faithful check: it exercises
 *     the exact import chain the bridge takes (requests, bs4, bottle,
 *     and whatever GA's internals pull in). If this succeeds, the
 *     bridge will at minimum spawn — actual LLM calls still require
 *     mykey.py to be valid, which is a separate health-check row.
 *
 * Constraints:
 *   - Tauri's `shell:allow-spawn` doesn't support regex validators on
 *     the `cmd` field, so every candidate must be pre-registered in
 *     `core/capabilities/default.json`. The CANDIDATES list below
 *     mirrors that allowlist verbatim — keep them in sync.
 *
 * V0.2 will move bridge spawn to a Rust-side `tauri::command` and
 * accept arbitrary Python paths, retiring this static list.
 */

import { Command } from "@tauri-apps/plugin-shell";

import { isWindows } from "@/lib/platform";

/**
 * A candidate Python interpreter the probe will try.
 *
 * `alias` matches a `name` entry in capabilities/default.json — that's
 * what `Command.create()` takes as its first argument. `displayPath`
 * is the human-readable path users see in Settings → Runtime → Python;
 * it mirrors the `cmd` field of the same capability entry.
 */
export interface PythonCandidate {
  /** Tauri shell-capability `name` — also used in gaConfig.python. */
  alias: string;
  /** Resolved absolute path. `$HOME` is expanded at probe time. */
  displayPath: string;
  /** Human-readable label for picker UIs ("GA venv", "Homebrew", …). */
  label: string;
}

/**
 * Probe candidates in priority order. The GA venv comes first because
 * if the user followed the most common GA install path (clone + create
 * `.venv` + `pip install -r requirements.txt`), this is the Python
 * that's guaranteed to have the right deps.
 *
 * IMPORTANT: every alias here must have matching entries in
 * `shell:allow-spawn` / `shell:allow-stdin-write` / `shell:allow-kill`
 * in `core/capabilities/default.json`. The capability uses `$HOME`
 * so we keep the same prefix in `displayPath`; the probe expands it
 * before passing to spawn args (`$HOME` substitution is the shell
 * plugin's job, but we want a real path for diagnostics).
 */
const HOME_PLACEHOLDER = "$HOME";

const RAW_CANDIDATES: ReadonlyArray<{
  alias: string;
  rawPath: string;
  label: string;
}> = [
  {
    alias: "python-ga-venv",
    rawPath: `${HOME_PLACEHOLDER}/Documents/GenericAgent/.venv/bin/python`,
    label: "GA 项目 venv (.venv)",
  },
  {
    alias: "python-ga-venv-alt",
    rawPath: `${HOME_PLACEHOLDER}/Documents/GenericAgent/venv/bin/python`,
    label: "GA 项目 venv (venv)",
  },
  {
    alias: "python-brew-arm",
    rawPath: "/opt/homebrew/bin/python3",
    label: "Homebrew (Apple Silicon)",
  },
  {
    alias: "python-brew-intel",
    rawPath: "/usr/local/bin/python3",
    label: "Homebrew (Intel)",
  },
  {
    alias: "python-framework-3-14",
    rawPath:
      "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3",
    label: "Python.org 3.14",
  },
  {
    alias: "python-framework-3-13",
    rawPath:
      "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
    label: "Python.org 3.13",
  },
  {
    alias: "python-framework-3-12",
    rawPath:
      "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    label: "Python.org 3.12",
  },
  {
    alias: "python-framework-3-11",
    rawPath:
      "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
    label: "Python.org 3.11",
  },
  {
    alias: "python3",
    rawPath: "python3 (PATH)",
    label: "系统 PATH 上的 python3",
  },
  {
    alias: "python",
    rawPath: "python (PATH)",
    label: "系统 PATH 上的 python",
  },
];

let cachedCandidates: PythonCandidate[] | null = null;

/**
 * Look up a candidate by Tauri shell-capability alias. Returns null
 * for unrecognized aliases (e.g. legacy values in `prefs.ga_config`
 * from before the probe shipped). Used to translate the alias stored
 * in gaConfig.python back into a user-readable path for Settings.
 */
export async function findCandidateByAlias(
  alias: string,
): Promise<PythonCandidate | null> {
  const list = await listPythonCandidates();
  return list.find((c) => c.alias === alias) ?? null;
}

/**
 * Resolve `$HOME` placeholders against the user's actual home dir
 * (Tauri provides it) and return the canonical candidate list. Cached
 * for the lifetime of the page — homeDir() won't change at runtime.
 */
export async function listPythonCandidates(): Promise<PythonCandidate[]> {
  if (cachedCandidates) return cachedCandidates;
  let home = "";
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    home = (await homeDir()).replace(/\/$/, "");
  } catch (e) {
    console.warn(
      "[python-probe] homeDir() failed — $HOME tokens will not expand.",
      e,
    );
  }
  cachedCandidates = RAW_CANDIDATES.map((c) => ({
    alias: c.alias,
    label: c.label,
    displayPath: c.rawPath.replace(HOME_PLACEHOLDER, home),
  }));
  return cachedCandidates;
}

export interface ProbeAttempt {
  candidate: PythonCandidate;
  /** "ok" → spawned + import succeeded; "spawn-failed" → process
   * couldn't even start (typically: binary doesn't exist or capability
   * rejected the path); "import-failed" → spawned but `anthropic`
   * import errored; "timeout" → probe took >TIMEOUT_MS. */
  outcome: "ok" | "spawn-failed" | "import-failed" | "timeout";
  /** Free-form diagnostic (stderr line, exit code, etc.) for UI. */
  detail?: string;
}

export interface ProbeResult {
  /** Winner of the probe. Null if every candidate failed. */
  winner: PythonCandidate | null;
  /** Every attempt's outcome, in candidate order. Used for the "tried
   * these paths and here's what happened" failure UI. */
  attempts: ProbeAttempt[];
}

const PROBE_TIMEOUT_MS = 4000;

/**
 * Build the Python one-liner the probe will exec. When `gaPath` is
 * provided (the common case: Onboarding's StepHealth knows it from the
 * preceding StepAttach), the script does the real `import agentmain`
 * the bridge will do. Without `gaPath` (e.g. an early-bird probe
 * before the user picked a path), fall back to a coarse "the common
 * deps load" check.
 */
function buildValidationScript(gaPath: string | null): string {
  if (gaPath && gaPath.trim()) {
    // JSON-stringify to handle paths with quotes / backslashes — Tauri
    // passes argv list-style so we don't need shell-escaping, but the
    // gaPath ends up inside a Python string literal.
    const escaped = JSON.stringify(gaPath);
    return `import sys; sys.path.insert(0, ${escaped}); import agentmain; print('ok')`;
  }
  return "import requests, bs4, bottle; print('ok')";
}

/**
 * Run the probe against every candidate in order. Stops at the first
 * "ok" outcome. Returns the winner plus the full attempt log so the
 * caller can render a useful "we tried these and here's what we saw"
 * report when nothing matched.
 *
 * `gaPath` is the user-chosen GenericAgent root. When provided, the
 * probe imports `agentmain` to validate the exact chain the bridge
 * will take. When null/empty, falls back to a deps-only check
 * (suitable for "just tell me which Python is usable").
 *
 * `signal` lets the caller cancel if the user navigates away
 * mid-probe.
 */
export async function probePython(
  gaPath: string | null = null,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const candidates = await listPythonCandidates();
  const script = buildValidationScript(gaPath);
  const attempts: ProbeAttempt[] = [];

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    const outcome = await runSingleProbe(candidate, script);
    attempts.push(outcome);
    if (outcome.outcome === "ok") {
      return { winner: candidate, attempts };
    }
  }
  return { winner: null, attempts };
}

async function runSingleProbe(
  candidate: PythonCandidate,
  validationScript: string,
): Promise<ProbeAttempt> {
  // Skip path-based candidates on Windows entirely — the absolute Mac
  // paths obviously aren't there. The `python` / `python3` PATH
  // fallbacks (last two entries) still get attempted on Windows;
  // V0.2 will add Win-native candidate paths.
  if (isWindows && candidate.displayPath.startsWith("/")) {
    return {
      candidate,
      outcome: "spawn-failed",
      detail: "skipped on Windows",
    };
  }

  let stdoutLine = "";
  let stderrLine = "";

  try {
    const command = Command.create(candidate.alias, [
      "-c",
      validationScript,
    ]);
    command.stdout.on("data", (line) => {
      const trimmed = line.trim();
      if (trimmed) stdoutLine = trimmed;
    });
    command.stderr.on("data", (line) => {
      const trimmed = line.trim();
      if (trimmed) stderrLine = trimmed;
    });

    const child = await command.spawn();
    const exited = await Promise.race<{ code: number | null } | "timeout">([
      new Promise<{ code: number | null }>((resolve) => {
        command.on("close", (payload) => {
          resolve({ code: payload.code });
        });
      }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS),
      ),
    ]);

    if (exited === "timeout") {
      try {
        await child.kill();
      } catch {
        /* already dead */
      }
      return { candidate, outcome: "timeout", detail: "no exit in 3s" };
    }
    if (exited.code === 0 && stdoutLine === "ok") {
      return { candidate, outcome: "ok" };
    }
    // Exit code non-zero — most often `ModuleNotFoundError: No module
    // named 'anthropic'`. Pass stderr through so the UI can show it.
    return {
      candidate,
      outcome: "import-failed",
      detail: stderrLine || `exit code ${exited.code}`,
    };
  } catch (e) {
    // Spawn itself failed — usually because the binary doesn't exist
    // at the configured path, or capability rejected it. Tauri's error
    // message is reasonably specific ("program not found", "scope
    // forbids", etc.) — surface it.
    return {
      candidate,
      outcome: "spawn-failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
