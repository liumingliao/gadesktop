/**
 * Production defaults — fallback values consumed before the bridge
 * `ready` event or SQLite hydrate populates real state.
 *
 * Previously lived in `stores/demo.ts` under the `DEMO_*` prefix; the
 * naming was misleading since these are load-bearing in shipping
 * builds, not test fixtures.
 *
 * Lifecycle:
 *   - `DEFAULT_GA_CONFIG` / `DEFAULT_APPROVAL_CONFIG` — `prefs.ts`
 *     initial state. Overwritten by SQLite-persisted prefs if any.
 *   - `DEFAULT_LLMS` / `DEFAULT_LLM_DISPLAY_NAME` — `runtime.ts`
 *     fallback when no per-session LLM list is known yet (e.g. the
 *     onboarding picker before any bridge has connected).
 *   - `DEFAULT_RUNTIME_INFO` — `runtime.ts` initial state. The
 *     `workbenchVersion` field is overwritten by `hydrate.ts` via
 *     `@tauri-apps/api/app.getVersion()`; the empty-string sentinel
 *     here renders as `v` if the hydrate call ever fails, which is
 *     a louder signal than silently displaying a stale literal.
 */

import type { ApprovalConfig } from "@/components/screens/settings/Settings";
import { isWindows } from "@/lib/platform";
import type { RuntimeInfo } from "@/types/inspector";

/**
 * Initial `gaConfig` for the prefs store. `python` is the alias used
 * when `useExternalPython === true`; v0.1.1+ defaults to the Galley-
 * bundled interpreter, so the alias is just the escape-hatch target
 * for users on a custom GA fork or venv. `gaPath` / `bridgeCwd` are
 * placeholders — the user picks the real paths in onboarding.
 */
export const DEFAULT_GA_CONFIG = {
  // Windows ships `python.exe` (no version suffix); macOS / Linux
  // commonly expose `python3` while bare `python` may still point at
  // a stale Python 2 on older systems. Use the right alias per OS.
  python: isWindows ? "python" : "python3",
  gaPath: "/Users/inkstone/Documents/GenericAgent",
  bridgeCwd: "/Users/inkstone/Documents/genericagent-webui",
  useExternalPython: false,
};

export const DEFAULT_LLM_DISPLAY_NAME = "Claude Sonnet 4.5";

export const DEFAULT_LLMS = [
  { index: 0, displayName: "GLM 5.1", isCurrent: false },
  { index: 1, displayName: "Claude Sonnet 4.5", isCurrent: true },
  { index: 2, displayName: "GPT 4o", isCurrent: false },
  { index: 3, displayName: "Gemini 2.5 Pro", isCurrent: false },
];

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  requiredTools: [
    "code_run",
    "file_write",
    "file_patch",
    "start_long_term_update",
  ],
  alwaysAllowProject: ["file_read", "web_scan"],
  alwaysAllowGlobal: [],
};

export const DEFAULT_RUNTIME_INFO: RuntimeInfo = {
  gaPath: "~/Documents/GenericAgent",
  pythonVersion: "3.11.9 (system)",
  llmDisplayName: DEFAULT_LLM_DISPLAY_NAME,
  bridgePid: 48213,
  gaCommit: "cf6551516fcc836f21dcdad592b07c703d09e1d8",
  // Matches cf65515's actual `git log -1 --format=%cI`. Bump alongside
  // the baseline pin in CLAUDE.md whenever the baseline moves; this is
  // only the pre-bridge placeholder, overwritten by the bridge `ready`
  // event in production.
  gaCommitDate: "2026-05-12T12:59:30+08:00",
  gaBaseline: "cf6551516fcc836f21dcdad592b07c703d09e1d8",
  // Empty string is the honest "not yet known" sentinel — `hydrate.ts`
  // overwrites with the real value from `getVersion()` during app boot.
  workbenchVersion: "",
};
