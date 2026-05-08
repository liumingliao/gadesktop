import type { Session, SessionBucket } from "@/types/session";

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
