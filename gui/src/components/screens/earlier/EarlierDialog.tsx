import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Archive,
  CheckSquare,
  MagnifyingGlass,
  PushPin,
  PushPinSlash,
  Square,
  X as XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import { StatusIcon } from "@/lib/status-icon";
import { cn } from "@/lib/utils";
import type { Session } from "@/types/session";

export interface EarlierDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sessions in the `earlier` bucket — caller groups; we just
   * render whatever it passes, sorted by lastActivityAt desc. */
  sessions: Session[];
  /** Open a session (same handler as Sidebar row click). The dialog
   * closes itself afterwards. */
  onSelectSession: (id: string) => void;
  /** Right-click → Archive, mirroring the Sidebar context menu so
   * the user can prune as they browse old sessions. */
  onArchiveSession: (id: string) => void;
  /** Right-click → Pin / Unpin. Pinning here lifts a session out
   * of the earlier bucket and back into the Sidebar's Pinned bucket. */
  onTogglePinSession: (id: string) => void;
  /** Bulk archive — drains the user's checkbox selection into a
   * single store action so 50 rows don't trigger 50 re-renders.
   * Pin doesn't have a bulk counterpart here: the dialog's reason
   * for existing is cleanup, so the action bar stays focused on
   * Archive. The rare "I want to promote this old session back to
   * Pinned" workflow is still served by the per-row right-click
   * menu's Pin item. */
  onArchiveSessionsBulk: (ids: string[]) => void;
}

/**
 * Browser for the `earlier` bucket (sessions older than 7 days).
 *
 * Replaces the sidebar's old infinite "Earlier" list once that bucket
 * grows past a handful of rows — the sidebar is for current work, and
 * surfacing hundreds of rows there made it unusable. Visual style
 * follows ArchivedDialog so the two read as siblings (one is "old but
 * still active", the other "explicitly retired").
 *
 * Two rendering modes:
 *
 *   - Browse (search empty): rows are grouped by year-month with
 *     section headers ("April 2026") — mirrors ChatGPT-style sidebar
 *     grouping so the user has temporal structure to scan against.
 *   - Filtered (search non-empty): grouping collapses to a flat
 *     hit list ordered by date desc. Grouping with 3 hits across
 *     5 months reads as noise, not structure.
 *
 * Select mode (Gmail-style):
 *   - User clicks header "Select" → rows show leading checkboxes,
 *     row click toggles selection instead of opening, context menu
 *     suppressed, sticky action bar appears at bottom with Pin /
 *     Archive / 全选 actions. Cancel or dialog close exits the mode.
 *   - Selection is by session ID, so filtering/clearing the search
 *     while in select mode doesn't lose what you've already picked.
 *
 * Differences from ArchivedDialog:
 *   - Click row → open session (not Restore). These rows aren't
 *     archived, they're just stale.
 *   - No Delete / Empty-all destructive actions. Pruning happens via
 *     Archive (right-click or bulk action bar) — soft removal.
 */
export function EarlierDialog({
  open,
  onOpenChange,
  sessions,
  onSelectSession,
  onArchiveSession,
  onTogglePinSession,
  onArchiveSessionsBulk,
}: EarlierDialogProps) {
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset state every time the dialog opens. Stale filter + stale
  // selection across opens would be surprising — closing then
  // reopening should feel like a fresh entry into the archive view.
  // Deferred via setTimeout so we don't setState synchronously in
  // the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setQuery("");
      setSelectMode(false);
      setSelected(new Set());
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const sorted = useMemo(
    () =>
      [...sessions].sort((a, b) =>
        b.lastActivityAt.localeCompare(a.lastActivityAt),
      ),
    [sessions],
  );

  const trimmedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (trimmedQuery === "") return sorted;
    return sorted.filter((s) => {
      const hay = `${s.title}\n${s.summary ?? ""}`.toLowerCase();
      return hay.includes(trimmedQuery);
    });
  }, [sorted, trimmedQuery]);

  const groups = useMemo(() => groupByMonth(filtered), [filtered]);

  const showGroups = trimmedQuery === "";

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const enterSelectMode = () => {
    setSelectMode(true);
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  // "Select all visible" toggles between selecting every currently-
  // filtered row and clearing them. Other (non-visible) rows the
  // user may have already picked under a different filter stay
  // selected — toggling the visible set is the principle of least
  // surprise when filters and selection are independent.
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((s) => selected.has(s.id));
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const s of filtered) next.delete(s.id);
      } else {
        for (const s of filtered) next.add(s.id);
      }
      return next;
    });
  };

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[520px] w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-[14px] border border-line bg-elevated shadow-elevated",
            "max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)]",
          )}
        >
          <Header
            total={sorted.length}
            shown={filtered.length}
            filtered={!showGroups}
            selectMode={selectMode}
            selectedCount={selected.size}
            onEnterSelectMode={enterSelectMode}
            onCancelSelectMode={exitSelectMode}
            onClose={() => onOpenChange(false)}
          />

          <SearchBar query={query} onChange={setQuery} />

          <div className="min-h-0 flex-1 overflow-y-auto bg-app">
            {filtered.length === 0 ? (
              <EmptyState filtered={!showGroups} />
            ) : showGroups ? (
              <GroupedList
                groups={groups}
                selectMode={selectMode}
                selected={selected}
                onSelectSession={(id) => {
                  onSelectSession(id);
                  onOpenChange(false);
                }}
                onToggleSelect={toggleSelect}
                onArchiveSession={onArchiveSession}
                onTogglePinSession={onTogglePinSession}
              />
            ) : (
              <FlatList
                rows={filtered}
                selectMode={selectMode}
                selected={selected}
                onSelectSession={(id) => {
                  onSelectSession(id);
                  onOpenChange(false);
                }}
                onToggleSelect={toggleSelect}
                onArchiveSession={onArchiveSession}
                onTogglePinSession={onTogglePinSession}
              />
            )}
          </div>

          {selectMode && (
            <SelectActionBar
              selectedCount={selected.size}
              allVisibleSelected={allVisibleSelected}
              onToggleSelectAllVisible={toggleSelectAllVisible}
              onArchive={() => {
                if (selectedIds.length === 0) return;
                onArchiveSessionsBulk(selectedIds);
                exitSelectMode();
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Header({
  total,
  shown,
  filtered,
  selectMode,
  selectedCount,
  onEnterSelectMode,
  onCancelSelectMode,
  onClose,
}: {
  total: number;
  shown: number;
  filtered: boolean;
  selectMode: boolean;
  selectedCount: number;
  onEnterSelectMode: () => void;
  onCancelSelectMode: () => void;
  onClose: () => void;
}) {
  // Right-side summary mirrors filter + select state so the user can
  // see at a glance whether they're viewing all, a subset, or
  // operating on a selection.
  const summary = selectMode
    ? `已选 ${selectedCount}`
    : filtered
      ? shown === 0
        ? "无匹配"
        : `${shown} / ${total} 命中`
      : total > 0
        ? `${total} 个 7 天前的对话`
        : "暂无早期对话";

  return (
    <div className="flex items-center gap-3 border-b border-line bg-elevated px-5 py-3.5">
      <Dialog.Title className="font-serif text-[16px] font-medium text-ink">
        Earlier
      </Dialog.Title>
      <span className="text-[12.5px] text-ink-muted">{summary}</span>

      <div className="ml-auto flex items-center gap-2">
        {selectMode ? (
          <button
            type="button"
            onClick={onCancelSelectMode}
            className={cn(
              "rounded-sm border border-line bg-elevated px-2.5 py-1 text-[12px] text-ink-soft",
              "transition-colors hover:bg-hover hover:text-ink",
            )}
          >
            取消
          </button>
        ) : (
          <button
            type="button"
            onClick={onEnterSelectMode}
            disabled={total === 0}
            className={cn(
              "rounded-sm border border-line bg-elevated px-2.5 py-1 text-[12px] text-ink-soft",
              "transition-colors hover:bg-hover hover:text-ink",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated disabled:hover:text-ink-soft",
            )}
          >
            多选
          </button>
        )}
        <Dialog.Close
          aria-label="关闭"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink"
        >
          <XIcon size={14} weight="thin" />
        </Dialog.Close>
      </div>
    </div>
  );
}

function SearchBar({
  query,
  onChange,
}: {
  query: string;
  onChange: (q: string) => void;
}) {
  return (
    <div className="relative shrink-0 border-b border-line bg-elevated px-4 py-2.5">
      <MagnifyingGlass
        size={14}
        weight="thin"
        className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-ink-muted"
      />
      <input
        type="text"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="按标题或摘要过滤…"
        autoFocus
        className={cn(
          "h-7 w-full rounded-sm border border-line bg-app pl-7 pr-3 text-[12.5px] text-ink",
          "placeholder:text-ink-muted focus:border-line-strong focus:outline-none",
        )}
      />
    </div>
  );
}

function GroupedList({
  groups,
  selectMode,
  selected,
  onSelectSession,
  onToggleSelect,
  onArchiveSession,
  onTogglePinSession,
}: {
  groups: { label: string; sessions: Session[] }[];
  selectMode: boolean;
  selected: Set<string>;
  onSelectSession: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onTogglePinSession: (id: string) => void;
}) {
  return (
    <div>
      {groups.map((g) => (
        <section key={g.label}>
          <div className="sticky top-0 z-10 border-b border-line bg-app px-5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {g.label}
            <span className="ml-1.5 text-ink-soft normal-case tracking-normal">
              · {g.sessions.length}
            </span>
          </div>
          <ul className="divide-y divide-line">
            {g.sessions.map((s) => (
              <EarlierRow
                key={s.id}
                session={s}
                selectMode={selectMode}
                isSelected={selected.has(s.id)}
                onSelect={() => onSelectSession(s.id)}
                onToggleSelect={() => onToggleSelect(s.id)}
                onArchive={() => onArchiveSession(s.id)}
                onTogglePin={() => onTogglePinSession(s.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FlatList({
  rows,
  selectMode,
  selected,
  onSelectSession,
  onToggleSelect,
  onArchiveSession,
  onTogglePinSession,
}: {
  rows: Session[];
  selectMode: boolean;
  selected: Set<string>;
  onSelectSession: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onArchiveSession: (id: string) => void;
  onTogglePinSession: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((s) => (
        <EarlierRow
          key={s.id}
          session={s}
          selectMode={selectMode}
          isSelected={selected.has(s.id)}
          onSelect={() => onSelectSession(s.id)}
          onToggleSelect={() => onToggleSelect(s.id)}
          onArchive={() => onArchiveSession(s.id)}
          onTogglePin={() => onTogglePinSession(s.id)}
        />
      ))}
    </ul>
  );
}

function EarlierRow({
  session,
  selectMode,
  isSelected,
  onSelect,
  onToggleSelect,
  onArchive,
  onTogglePin,
}: {
  session: Session;
  selectMode: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggleSelect: () => void;
  onArchive: () => void;
  onTogglePin: () => void;
}) {
  const handleClick = selectMode ? onToggleSelect : onSelect;

  const row = (
    <li
      onClick={handleClick}
      className={cn(
        "group flex cursor-pointer items-start gap-3 px-5 py-3 transition-colors",
        selectMode && isSelected ? "bg-selected hover:bg-selected" : "hover:bg-hover",
      )}
    >
      {selectMode ? (
        <span className="pt-0.5 text-ink-soft">
          {isSelected ? (
            <CheckSquare size={14} weight="fill" className="text-brand-strong" />
          ) : (
            <Square size={14} weight="thin" />
          )}
        </span>
      ) : (
        <span className="pt-0.5">
          <StatusIcon status={session.status} size={14} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">
          {session.title}
        </div>
        {session.summary && (
          <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">
            {session.summary}
          </div>
        )}
        <div className="mt-1 text-[10.5px] text-ink-muted">
          {formatDate(session.lastActivityAt)}
          {session.turnCount !== undefined && session.turnCount > 0 && (
            <> · {session.turnCount} 步</>
          )}
          {session.pinned && (
            <span className="ml-1.5 text-brand-strong">· pinned</span>
          )}
        </div>
      </div>
    </li>
  );

  // Context menu disabled in select mode — right-click in select
  // mode would conflict with the bulk-action mental model, and the
  // sticky action bar already covers Pin / Archive for the chosen
  // set.
  if (selectMode) return row;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={cn(
            "z-[60] min-w-[160px] rounded-md border border-line bg-elevated p-1 shadow-elevated",
          )}
        >
          <ContextMenu.Item
            onSelect={onTogglePin}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-[12.5px] text-ink-soft outline-none transition-colors",
              "data-[highlighted]:bg-hover data-[highlighted]:text-ink",
            )}
          >
            {session.pinned ? (
              <>
                <PushPinSlash size={13} weight="thin" />
                Unpin
              </>
            ) : (
              <>
                <PushPin size={13} weight="thin" />
                Pin
              </>
            )}
          </ContextMenu.Item>
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

function SelectActionBar({
  selectedCount,
  allVisibleSelected,
  onToggleSelectAllVisible,
  onArchive,
}: {
  selectedCount: number;
  allVisibleSelected: boolean;
  onToggleSelectAllVisible: () => void;
  onArchive: () => void;
}) {
  const disabled = selectedCount === 0;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-line bg-elevated px-4 py-2.5",
      )}
    >
      <button
        type="button"
        onClick={onToggleSelectAllVisible}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[12px] text-ink-soft",
          "transition-colors hover:bg-hover hover:text-ink",
        )}
      >
        {allVisibleSelected ? (
          <CheckSquare size={13} weight="fill" className="text-brand-strong" />
        ) : (
          <Square size={13} weight="thin" />
        )}
        {allVisibleSelected ? "取消全选" : "全选"}
      </button>

      <button
        type="button"
        onClick={onArchive}
        disabled={disabled}
        className={cn(
          "ml-auto inline-flex items-center gap-1.5 rounded-sm border border-line bg-elevated px-2.5 py-1 text-[12px] text-ink-soft",
          "transition-colors hover:bg-hover hover:text-ink",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated disabled:hover:text-ink-soft",
        )}
      >
        <Archive size={12} weight="thin" />
        Archive
        {selectedCount > 0 && (
          <span className="text-ink-muted">· {selectedCount}</span>
        )}
      </button>
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="font-serif text-[13.5px] italic text-ink-muted">
        {filtered ? "没有匹配的对话。" : "7 天前还没有对话。"}
      </p>
    </div>
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function groupByMonth(rows: Session[]): { label: string; sessions: Session[] }[] {
  const out: { label: string; sessions: Session[] }[] = [];
  let lastKey = "";
  for (const s of rows) {
    const d = new Date(s.lastActivityAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key !== lastKey) {
      out.push({
        label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
        sessions: [],
      });
      lastKey = key;
    }
    out[out.length - 1]!.sessions.push(s);
  }
  return out;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  } catch {
    return iso;
  }
}
