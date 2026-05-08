import {
  Folder,
  FolderOpen,
  MagnifyingGlass,
  PauseCircle,
  Plus,
  Trash,
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
}: SidebarProps) {
  const isEmpty = sessions.length === 0;
  const buckets = groupSessions(sessions);

  return (
    <div className="flex h-full flex-col bg-app text-[13px] text-ink">
      <SidebarHeader runtimeStatus={runtimeStatus} />
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
                />
              ),
            )}

            {projects.length > 0 && <SidebarProjects projects={projects} />}
          </div>

          <SidebarFooter />
        </>
      )}
    </div>
  );
}

// ---------- subcomponents ----------

function SidebarHeader({ runtimeStatus }: { runtimeStatus: RuntimeStatus }) {
  // No top padding for traffic light here: the full-width TopBar above
  // the shell already covers it. The sidebar starts at y=44px (below
  // the TopBar's bottom border).
  return (
    <div className="border-b border-line px-4 py-3.5">
      <div className="font-serif text-[16px] font-medium tracking-[0.01em] text-ink">
        GA Workbench
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
}: {
  bucket: SessionBucket;
  sessions: Session[];
  activeId?: string;
  onSelectSession?: (id: string) => void;
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
}: {
  session: Session;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
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
        <div className="truncate text-[13px] font-medium text-ink">
          {session.title}
        </div>
        {session.summary && (
          <div className="mt-0.5 truncate text-[11px] leading-[1.4] text-ink-muted">
            {session.summary}
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

function SidebarFooter() {
  return (
    <div className="flex items-center gap-2 border-t border-line px-3.5 py-2 text-[11.5px] text-ink-muted">
      <Trash size={12} weight="thin" />
      <span>Trash</span>
    </div>
  );
}
