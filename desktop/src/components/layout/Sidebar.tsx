import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Archive,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  PauseCircle,
  Plus,
  SidebarSimple,
  WarningCircle,
} from "@phosphor-icons/react";

import { StatusIcon } from "@/lib/status-icon";
import {
  BUCKET_LABEL,
  groupSessions,
  SIDEBAR_BUCKET_ORDER,
} from "@/lib/sessions";
import { cn } from "@/lib/utils";
import type { Project, Session, SessionBucket } from "@/types/session";

export type RuntimeStatus = "healthy" | "warning" | "error";

export interface SidebarProps {
  sessions: Session[];
  projects?: Project[];
  activeId?: string;
  runtimeStatus?: RuntimeStatus;
  onSelectSession?: (id: string) => void;
  onNewChat?: () => void;
  onSearch?: () => void;
  /** Right-click → Archive. Hides the session from the bucketed list
   * but keeps the row in SQLite. */
  onArchiveSession?: (id: string) => void;
  /** Click the Archived footer button → open the Archived dialog
   * (list of archived sessions, with Restore / Delete / Empty all). */
  onOpenArchived?: () => void;
  /** Count of archived sessions — shown as a small numeral after the
   * footer label. Omit / 0 → just the label. */
  archivedCount?: number;
  /**
   * Collapse the sidebar. Lives on the Sidebar itself (in the header
   * row, right of the logo) rather than in the TopBar — co-locating the
   * affordance with its target avoids visual collision with the macOS
   * traffic light cluster. Wiring (collapse state + ⌘\ shortcut +
   * width persistence) lands together with the resizable panel work,
   * since both share the same sidebar visibility surface.
   */
  onToggle?: () => void;
}

/**
 * Left navigation panel. Per DESIGN.md §4.2 Sidebar Spec.
 *
 * Two visual modes, derived from `sessions.length`:
 *
 *   full  — sessions[] non-empty: header + quick actions + bucketed
 *           sections (pinned/today/week/earlier) + projects + trash
 *   empty — sessions[] empty: header + quick actions + muted hint
 *           "这里会出现你的 sessions"; no sections / projects / trash
 *
 * The active session row gets `bg-selected` (apricot tint) — this is a
 * brand moment, not just hover state.
 */
export function Sidebar({
  sessions,
  projects = [],
  activeId,
  runtimeStatus = "healthy",
  onSelectSession,
  onNewChat,
  onSearch,
  onArchiveSession,
  onOpenArchived,
  archivedCount = 0,
  onToggle,
}: SidebarProps) {
  const isEmpty = sessions.length === 0;
  const buckets = groupSessions(sessions);

  return (
    <div className="flex h-full flex-col bg-app text-[13px] text-ink">
      <SidebarHeader runtimeStatus={runtimeStatus} onToggle={onToggle} />
      <SidebarQuickActions onNewChat={onNewChat} onSearch={onSearch} />

      {isEmpty ? (
        <div className="flex-1 px-5 py-6 font-serif text-[12.5px] italic text-ink-muted">
          这里会出现你的 sessions。
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {SIDEBAR_BUCKET_ORDER.map((bucket) =>
              buckets[bucket].length === 0 ? null : (
                <SidebarBucket
                  key={bucket}
                  bucket={bucket}
                  sessions={buckets[bucket]}
                  activeId={activeId}
                  onSelectSession={onSelectSession}
                  onArchiveSession={onArchiveSession}
                />
              ),
            )}

            {projects.length > 0 && <SidebarProjects projects={projects} />}
          </div>

          <SidebarFooter
            count={archivedCount}
            onOpenArchived={onOpenArchived}
          />
        </>
      )}
    </div>
  );
}

// ---------- subcomponents ----------

function SidebarHeader({
  runtimeStatus,
  onToggle,
}: {
  runtimeStatus: RuntimeStatus;
  onToggle?: () => void;
}) {
  // No top padding for traffic light here: the full-width TopBar above
  // the shell already covers it. The sidebar starts at y=44px (below
  // the TopBar's bottom border).
  return (
    <div className="border-b border-line px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="font-serif text-[16px] font-medium tracking-[0.01em] text-ink">
          GA Workbench
        </div>
        <button
          type="button"
          title="Toggle sidebar · ⌘\\"
          aria-label="Toggle sidebar"
          onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <SidebarSimple size={16} weight="thin" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-soft">
        <RuntimeDot status={runtimeStatus} />
        <span>Runtime · {runtimeStatusLabel(runtimeStatus)}</span>
      </div>
    </div>
  );
}

function RuntimeDot({ status }: { status: RuntimeStatus }) {
  const map: Record<RuntimeStatus, string> = {
    healthy: "bg-success ring-2 ring-success/20",
    warning: "bg-warning ring-2 ring-warning/20",
    error: "bg-error ring-2 ring-error/20",
  };
  return <span className={cn("size-2 rounded-full", map[status])} />;
}

function runtimeStatusLabel(status: RuntimeStatus) {
  return status === "healthy" ? "healthy" : status;
}

function SidebarQuickActions({
  onNewChat,
  onSearch,
}: {
  onNewChat?: () => void;
  onSearch?: () => void;
}) {
  return (
    <div className="border-b border-line py-1.5">
      <QuickAction
        icon={<Plus size={14} weight="thin" />}
        label="New Chat"
        hint="⌘N"
        onClick={onNewChat}
      />
      <QuickAction
        icon={<MagnifyingGlass size={14} weight="thin" />}
        label="Search"
        hint="⌘K"
        onClick={onSearch}
      />
    </div>
  );
}

function QuickAction({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-hover"
    >
      <span className="text-ink-soft">{icon}</span>
      <span>{label}</span>
      {hint && (
        <span className="ml-auto text-[11px] text-ink-muted">{hint}</span>
      )}
    </button>
  );
}

function SidebarBucket({
  bucket,
  sessions,
  activeId,
  onSelectSession,
  onArchiveSession,
}: {
  bucket: SessionBucket;
  sessions: Session[];
  activeId?: string;
  onSelectSession?: (id: string) => void;
  onArchiveSession?: (id: string) => void;
}) {
  return (
    <>
      <SidebarSectionLabel>{BUCKET_LABEL[bucket]}</SidebarSectionLabel>
      {sessions.map((s) => (
        <SidebarSessionRow
          key={s.id}
          session={s}
          active={s.id === activeId}
          onClick={() => onSelectSession?.(s.id)}
          onArchive={
            onArchiveSession ? () => onArchiveSession(s.id) : undefined
          }
        />
      ))}
    </>
  );
}

function SidebarSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-1.5 pt-3.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
      {children}
    </div>
  );
}

function SidebarSessionRow({
  session,
  active,
  onClick,
  onArchive,
}: {
  session: Session;
  active?: boolean;
  onClick?: () => void;
  /** Provided when the host wires archiving; the right-click menu
   * is suppressed otherwise (no actions = no menu to show). */
  onArchive?: () => void;
}) {
  // Three-state sidebar display (Stage 3 round 7+10):
  //   1. running                 — bold brand spinner + italic "正在工作 · 第 N 步" subline
  //   2. idle  + hasUnread=true  — static icon + brand dot + bold title
  //   3. idle  + hasUnread=false — static icon, no dot
  // Active row is always treated as read (the user is looking at
  // it); even if turn_end fires there, bumpSessionAfterTurn skips
  // the unread mark for sessionId === activeSessionId.
  //
  // Running gets a second signal beyond the spinning icon: the
  // subline switches from the persisted turn-summary to a live
  // italic "正在工作 · 第 N 步". Color + typography + language all
  // shift so the running state is identifiable at a glance, not
  // just by the icon's rotation.
  const showUnread = !!session.hasUnread && !active;
  const isRunning = session.status === "running";
  // Subline composition:
  //
  //   running + step known → "正在工作 · 第 N 步"
  //   running + step unknown → "正在工作…"
  //     N comes from session.currentStepIndex, synced from
  //     runtime.currentTurnIndex by applyRuntimeUpdate on every
  //     turn_start. While the bridge hasn't emitted turn_start
  //     yet (e.g. immediately after user submits) currentStepIndex
  //     is undefined and we fall back to dots — the user still
  //     gets the "activity is happening" signal.
  //
  //   settled → "已完成 · {summary}"
  //     "Stops at 第 N 步" reads as "still mid-flight"; the
  //     past-tense "已完成 ·" prefix shifts the register to
  //     "this conversation is done, here's the recap". The {summary}
  //     itself is GA's third-person past-tense one-liner so it
  //     reads naturally after the prefix.
  //
  // Legacy data: pre-this-change rows wrote
  // "第 N 步 · {summary}" into session.summary directly. Strip
  // that prefix at render so old rows display in the new format
  // without a DB migration.
  const cleanSummary = session.summary
    ? stripLegacyStepPrefix(session.summary)
    : null;
  const sublineText = isRunning
    ? session.currentStepIndex != null
      ? `正在工作 · 第 ${session.currentStepIndex} 步`
      : "正在工作…"
    : cleanSummary
      ? `已完成 · ${cleanSummary}`
      : null;
  const row = (
    <div
      onClick={onClick}
      className={cn(
        "mx-1.5 flex min-h-[44px] cursor-pointer items-start gap-2 rounded-sm px-3 py-1.5 transition-colors",
        active ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className="pt-0.5">
        <StatusIcon status={session.status} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] text-ink",
              showUnread ? "font-semibold" : "font-medium",
            )}
          >
            {session.title}
          </div>
          {showUnread && (
            <span
              aria-label="未读"
              title="有新回复"
              className="size-2 shrink-0 rounded-full bg-brand"
            />
          )}
        </div>
        {sublineText && (
          <div
            className={cn(
              "mt-0.5 truncate text-[11px] leading-[1.4]",
              isRunning
                ? "font-serif italic text-ink-soft"
                : "text-ink-muted",
            )}
          >
            {sublineText}
          </div>
        )}
        {(session.pendingApprovalCount > 0 || session.errorCount > 0) && (
          <div className="mt-1 flex items-center gap-1">
            {session.pendingApprovalCount > 0 && (
              <Badge tone="warning">
                <PauseCircle size={10} weight="bold" />
                {session.pendingApprovalCount} 待审批
              </Badge>
            )}
            {session.errorCount > 0 && (
              <Badge tone="error">
                <WarningCircle size={10} weight="bold" />
                {session.errorCount} 错误
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (!onArchive) return row;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={cn(
            "z-50 min-w-[160px] rounded-md border border-line bg-elevated p-1 shadow-elevated",
          )}
        >
          <ContextMenu.Item
            onSelect={onArchive}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-[12.5px] text-ink-soft outline-none transition-colors",
              "data-[highlighted]:bg-hover data-[highlighted]:text-ink",
            )}
          >
            <Archive size={13} weight="thin" />
            Archive
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "warning" | "error";
  children: React.ReactNode;
}) {
  const map = {
    warning: "text-warning bg-warning/10",
    error: "text-error bg-error/10",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

function SidebarProjects({ projects }: { projects: Project[] }) {
  return (
    <>
      <SidebarSectionLabel>Projects</SidebarSectionLabel>
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          className="mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 rounded-sm px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-hover"
        >
          {p.rootPath ? (
            <FolderOpen
              size={14}
              weight="thin"
              className="shrink-0 text-ink-soft"
            />
          ) : (
            <Folder
              size={14}
              weight="thin"
              className="shrink-0 text-ink-muted"
            />
          )}
          <span className="truncate text-ink-soft">{p.name}</span>
        </button>
      ))}
    </>
  );
}

function SidebarFooter({
  count,
  onOpenArchived,
}: {
  count: number;
  onOpenArchived?: () => void;
}) {
  // "Archived" not "Trash": our archive flow keeps data forever
  // (status="archived", row preserved). Trash semantics would imply
  // a holding area that's eventually purged — not what we do. The
  // ArchivedDialog provides single-row Delete and an Empty-all
  // operation if the user wants to actually purge.
  return (
    <button
      type="button"
      onClick={onOpenArchived}
      className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2 text-left text-[11.5px] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
    >
      <Archive size={12} weight="thin" />
      <span>Archived</span>
      {count > 0 && <span className="ml-auto text-ink-soft">{count}</span>}
    </button>
  );
}

/**
 * Strip the legacy "第 N 步 · " prefix that earlier versions of
 * bumpSessionAfterTurn wrote into session.summary. The current
 * write path stores raw summary text and lets the renderer decide
 * which prefix to add (e.g. "已完成 · " when settled). This
 * keeps old rows displaying in the new format without a DB
 * migration — they'll re-save in the new format on next turn_end.
 */
function stripLegacyStepPrefix(s: string): string {
  return s.replace(/^第\s*\d+\s*步\s*·\s*/, "");
}
