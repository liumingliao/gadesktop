import {
  Archive,
  CheckCircle,
  Circle,
  CircleNotch,
  PauseCircle,
  Prohibit,
  XCircle,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/types/session";

/**
 * Maps SessionStatus to the Phosphor icon + color + weight it should
 * render with on session rows. Per DESIGN.md §4.2 Sidebar Spec +
 * prototype's chrome.jsx.
 *
 * - running: spinning brand-strong CircleNotch, BOLD weight so the
 *   "agent is working" state pops on sidebar scan. Thin weight at
 *   14px was visually too quiet to distinguish from idle even with
 *   the spin animation.
 * - completed: brand-strong CheckCircle (thin — passive success)
 * - waiting_approval: amber PauseCircle (thin)
 * - error: deep red XCircle (thin)
 * - idle / connecting / archived: muted (thin)
 * - cancelled: muted Prohibit (different from error — user-initiated)
 */
const STATUS_MAP: Record<
  SessionStatus,
  {
    Icon: typeof Circle;
    className: string;
    weight?: "thin" | "regular" | "bold";
    spin?: boolean;
  }
> = {
  idle: { Icon: Circle, className: "text-ink-muted" },
  connecting: { Icon: CircleNotch, className: "text-ink-muted", spin: true },
  running: {
    Icon: CircleNotch,
    className: "text-brand-strong",
    weight: "bold",
    spin: true,
  },
  waiting_approval: { Icon: PauseCircle, className: "text-warning" },
  error: { Icon: XCircle, className: "text-error" },
  cancelled: { Icon: Prohibit, className: "text-ink-muted" },
  completed: { Icon: CheckCircle, className: "text-brand-strong" },
  archived: { Icon: Archive, className: "text-ink-muted" },
};

export function StatusIcon({
  status,
  size = 14,
}: {
  status: SessionStatus;
  size?: number;
}) {
  const cfg = STATUS_MAP[status];
  const { Icon } = cfg;
  return (
    <span className={cn("inline-flex shrink-0", cfg.spin && "spin")}>
      <Icon size={size} weight={cfg.weight ?? "thin"} className={cfg.className} />
    </span>
  );
}
