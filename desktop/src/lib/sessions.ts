import type { SessionRuntime } from "@/stores/useAppStore";
import type { Session, SessionBucket, SessionStatus } from "@/types/session";

/**
 * Derive the live session status by overlaying runtime state (from
 * `_runtimes[id]`) onto the persisted Session row. Long-term states
 * the user / persistence sets (`archived` / `completed` / `cancelled`)
 * always win — they're "this is what this session IS", not "what's
 * happening right now". The remaining states reflect what the bridge
 * + agent are doing this second:
 *
 *   pendingApprovals.length > 0 → waiting_approval (highest priority —
 *                                  drives the amber pause icon)
 *   agentRunning                 → running         (apricot spinner)
 *   bridgeStatus === "spawning"  → connecting      (subtle loader)
 *   bridgeStatus === "error"     → error           (red dot)
 *   otherwise                    → idle
 *
 * Used by Sidebar enrichment (in App.tsx) so per-row status icons
 * + badges reflect background-session activity without each
 * component poking at `_runtimes` directly.
 */
export function deriveSessionStatus(
  session: Session,
  runtime: SessionRuntime | undefined,
): SessionStatus {
  if (
    session.status === "archived" ||
    session.status === "completed" ||
    session.status === "cancelled"
  ) {
    return session.status;
  }
  if (!runtime) return session.status;
  if (runtime.pendingApprovals.length > 0) return "waiting_approval";
  if (runtime.agentRunning) return "running";
  if (runtime.bridgeStatus === "spawning") return "connecting";
  if (runtime.bridgeStatus === "error") return "error";
  return "idle";
}

/**
 * Apply `deriveSessionStatus` + the live `pendingApprovalCount` to a
 * Session, returning a row safe to feed into the Sidebar (which
 * renders these fields as static values).
 *
 * **Stable identity**: when neither the derived status nor the
 * pending count changes, returns the input `session` object by
 * reference. This is load-bearing for performance — combined with
 * `useShallow` in the App.tsx selector, frequent runtime mutations
 * like `inFlightContent` streaming (which don't affect status or
 * pending count) no longer trigger Sidebar re-renders. Without
 * this, every token of streaming output would invalidate every
 * session row's identity and re-render the whole sidebar tree.
 */
export function enrichSession(
  session: Session,
  runtime: SessionRuntime | undefined,
): Session {
  if (!runtime) return session;
  const newStatus = deriveSessionStatus(session, runtime);
  const newCount = runtime.pendingApprovals.length;
  if (
    session.status === newStatus &&
    session.pendingApprovalCount === newCount
  ) {
    return session;
  }
  return {
    ...session,
    status: newStatus,
    pendingApprovalCount: newCount,
  };
}

/**
 * Compute which sidebar bucket a session falls into.
 *
 *   pinned   — pinned flag wins regardless of date
 *   today    — lastActivityAt is on the calendar day of `now`
 *   week     — within 7 days but not today
 *   earlier  — older, including archived
 *
 * Bucket is purely a view concern; we don't store it on the entity.
 */
export function bucketSession(
  s: Session,
  now: Date = new Date(),
): SessionBucket {
  if (s.pinned) return "pinned";
  const last = new Date(s.lastActivityAt).getTime();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  if (last >= todayMs) return "today";
  const weekAgoMs = todayMs - 7 * 24 * 3600 * 1000;
  if (last >= weekAgoMs) return "week";
  return "earlier";
}

const BUCKET_ORDER: SessionBucket[] = ["pinned", "today", "week", "earlier"];

export type GroupedSessions = Record<SessionBucket, Session[]>;

/**
 * Group sessions into the four sidebar buckets, sorted within each by
 * lastActivityAt descending (most recent first).
 *
 * Empty buckets are returned as empty arrays — the sidebar decides
 * whether to render the section header.
 */
export function groupSessions(
  sessions: Session[],
  now: Date = new Date(),
): GroupedSessions {
  const buckets: GroupedSessions = {
    pinned: [],
    today: [],
    week: [],
    earlier: [],
  };
  const sorted = [...sessions].sort((a, b) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
  for (const s of sorted) {
    buckets[bucketSession(s, now)].push(s);
  }
  return buckets;
}

export const SIDEBAR_BUCKET_ORDER = BUCKET_ORDER;

export const BUCKET_LABEL: Record<SessionBucket, string> = {
  pinned: "Pinned",
  today: "Today",
  week: "This week",
  earlier: "Earlier",
};
