/**
 * Conversation view types — desktop-side rendering shapes.
 *
 * Distinct from `types/ipc.ts`:
 *   - ipc.ts mirrors the wire protocol (events the bridge emits)
 *   - conversation.ts is what the UI iterates over to render turns
 *
 * The state layer in #9 will be responsible for collapsing IPC events
 * into Turn / ToolEvent shapes. For #3 we hand-feed a demo Turn[] in
 * App.tsx until that store lands.
 */

import type { ApprovalDecision } from "@/types/ipc";

/**
 * 6 visual states for a Tool callout per DESIGN.md §4.5:
 *   - running             : currently executing (apricot spinner)
 *   - success-current     : just completed, current focus (apricot)
 *   - success-historical  : older success (faded; almost invisible)
 *   - waiting_approval    : forced-open form (amber tint accent)
 *   - failed              : forced-open with error detail (red tint)
 *   - denied              : user rejected; collapsed
 */
export type ToolEventStatus =
  | "running"
  | "success-current"
  | "success-historical"
  | "waiting_approval"
  | "failed"
  | "denied";

export type RiskLevel = "low" | "medium" | "high";

export interface ConversationToolEvent {
  id: string;
  /** Tool name like "file_read" / "file_patch" / "code_run". Mono font. */
  name: string;
  status: ToolEventStatus;
  /** One-line human description; shows when collapsed and as the lead
   * line when expanded. */
  summary?: string;
  /** Elapsed display ("120ms" / "—" for pending / "pending · 14s" etc.) */
  elapsed?: string;
  /** Risk level — drives the risk pill color in the Approval form. */
  riskLevel?: RiskLevel;
  /** Raw args dict (rendered as a fallback mono block when no tool-specific
   * renderer applies). file_patch / file_write specific renderers land in #6. */
  args?: Record<string, unknown>;
  /** ≤200 char preview when raw args is too large. */
  argsPreview?: string;
  /** ≤500 char tool result preview (when status is success / failed). */
  resultPreview?: string;
  /** Approval ID — present when status === "waiting_approval"; sent back
   * via ApprovalResponseCommand. */
  approvalId?: string;
}

export interface UserTurn {
  role: "user";
  content: string;
}

export interface AgentTurn {
  role: "agent";
  /** Optional 💭 thinking summary that opens the turn. */
  thinking?: string;
  tools: ConversationToolEvent[];
  /** Final answer markdown. null when the agent is still working
   * (e.g., waiting on approval). */
  finalAnswer: string | null;
}

export type Turn = UserTurn | AgentTurn;

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  /** Short target identifier shown in the Approval Dock — e.g. file path,
   * command summary, memory key. */
  target?: string;
  riskLevel: RiskLevel;
}

/** Decision callback shape used by the Approval form / Dock. */
export type OnApprove = (decision: ApprovalDecision) => void;
