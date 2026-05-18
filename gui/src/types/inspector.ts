/**
 * Runtime payload types — desktop-side.
 *
 * Historical note (2026-05-12): this file is named `inspector.ts`
 * because the shapes here originally fed a right-pane Inspector with
 * Details / Approvals / Runtime tabs. That panel was retired and
 * `ApprovalRecord` (the audit log shape) went with it; `RuntimeInfo`
 * still drives Settings → Runtime. The filename stays the same to
 * avoid a wave of import-path churn — rename to `runtime.ts`
 * whenever we're already touching every importer.
 */

/**
 * Health check single check. Driven from the bridge's `ready` event
 * and any subsequent re-runs. Follows DESIGN.md §6.1's six states.
 */
export type HealthCheckState =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "warning"
  | "blocked";

export interface HealthCheckItem {
  name: string;
  detail?: string;
  state: HealthCheckState;
}

/**
 * Runtime tab payload. Combines the Health Check status with
 * bridge-level metadata that the user often wants at a glance.
 */
export interface RuntimeInfo {
  /** ~/Documents/GenericAgent or wherever the user attached. */
  gaPath: string;
  pythonVersion: string;
  /** Active LLM (display name from bridge prettifier). */
  llmDisplayName: string;
  /** Bridge subprocess PID for the active session, if any. */
  bridgePid?: number;
  /** User's actual GA HEAD commit (full SHA from ReadyEvent.gaCommit).
   * `"unknown"` if ga_path isn't a git checkout. Distinct from
   * `gaBaseline` below: this is what the user is *running right
   * now*, baseline is what we tested with. */
  gaCommit: string;
  /** ISO 8601 commit date of the user's GA HEAD. Same `"unknown"`
   * fallback. Pairs with `gaCommit` for the Settings → Runtime
   * version row. */
  gaCommitDate: string;
  /** Workbench-side tested baseline commit (from CLAUDE.md GA
   * Baseline section). Hardcoded — bumped whenever we re-verify
   * upstream compatibility. */
  gaBaseline: string;
  /** Workbench app version (e.g. "0.1.0"). */
  workbenchVersion: string;
}
