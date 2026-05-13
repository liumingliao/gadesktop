import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUUpLeft,
  CheckSquare,
  Square,
  Trash,
  WarningCircle,
  X as XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import type { Session } from "@/types/session";

export interface ArchivedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** All sessions (any status); the dialog filters to archived ones
   * internally so the parent doesn't have to derive a separate list. */
  sessions: Session[];
  onRestore: (id: string) => void;
  /** Permanent delete with no confirm flow at this level — caller is
   * the dialog that already showed a confirm. */
  onDeletePermanently: (id: string) => Promise<void>;
  /** Empty all archived. The dialog shows a second confirm prompt
   * (checkbox + destructive button) before calling this. */
  onEmptyAll: () => Promise<number>;
  /** Bulk restore — drains the user's checkbox selection into a
   * single store action. No confirm: restore is non-destructive. */
  onRestoreBulk: (ids: string[]) => void;
  /** Bulk permanent delete. The dialog shows a single-layer confirm
   * (count + cancel/confirm); the user already deliberated by
   * picking the rows, so the checkbox-acknowledge friction is
   * reserved for "empty all" where the destruction is undifferentiated. */
  onDeletePermanentlyBulk: (ids: string[]) => Promise<void>;
}

/**
 * Archived sessions browser. Three destructive operations live here:
 *
 *   - Single Delete (per row, right-side icon button): single-layer
 *     AlertDialog confirm. Lower stakes (one row), no checkbox.
 *
 *   - Bulk Delete (select mode → action bar): single-layer confirm
 *     showing the count. The user picked the rows explicitly, so
 *     no GitHub-style checkbox friction.
 *
 *   - Empty all (header button): two-layer confirm. The button
 *     itself is destructive-styled (red + warning icon); clicking
 *     it opens an AlertDialog that REQUIRES checking an
 *     acknowledgement checkbox to enable the final "清空全部"
 *     button. Mirrors the GitHub "delete repository" pattern for
 *     undifferentiated batch destruction.
 *
 * Restore is non-destructive — no confirm in any mode, just executes
 * and the row drops out of the archived list immediately.
 *
 * Select mode (Gmail-style): header `Select` button toggles in. In
 * select mode, rows show leading checkboxes, click toggles
 * selection (single-row inline Restore/Delete buttons hide), and a
 * sticky action bar with Restore / Delete actions appears at the
 * bottom. Same UX as EarlierDialog.
 */
export function ArchivedDialog({
  open,
  onOpenChange,
  sessions,
  onRestore,
  onDeletePermanently,
  onEmptyAll,
  onRestoreBulk,
  onDeletePermanentlyBulk,
}: ArchivedDialogProps) {
  const archived = useMemo(
    () =>
      [...sessions]
        .filter((s) => s.status === "archived")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions],
  );

  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset select mode + selection every time the dialog opens.
  // Stale selection across opens would be surprising.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setSelectMode(false);
      setSelected(new Set());
      setBulkDeleteConfirmOpen(false);
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const enterSelectMode = () => setSelectMode(true);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const allVisibleSelected =
    archived.length > 0 && archived.every((s) => selected.has(s.id));
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const s of archived) next.delete(s.id);
      } else {
        for (const s of archived) next.add(s.id);
      }
      return next;
    });
  };

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  return (
    <>
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
              count={archived.length}
              selectMode={selectMode}
              selectedCount={selected.size}
              onEnterSelectMode={enterSelectMode}
              onCancelSelectMode={exitSelectMode}
              onClose={() => onOpenChange(false)}
              onEmptyAll={() => setEmptyConfirmOpen(true)}
            />

            <div className="min-h-0 flex-1 overflow-y-auto bg-app">
              {archived.length === 0 ? (
                <EmptyState />
              ) : (
                <ul className="divide-y divide-line">
                  {archived.map((s) => (
                    <ArchivedRow
                      key={s.id}
                      session={s}
                      selectMode={selectMode}
                      isSelected={selected.has(s.id)}
                      onToggleSelect={() => toggleSelect(s.id)}
                      onRestore={() => onRestore(s.id)}
                      onDelete={() => setPendingDelete(s)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {selectMode && (
              <SelectActionBar
                selectedCount={selected.size}
                allVisibleSelected={allVisibleSelected}
                onToggleSelectAllVisible={toggleSelectAllVisible}
                onRestore={() => {
                  if (selectedIds.length === 0) return;
                  onRestoreBulk(selectedIds);
                  exitSelectMode();
                }}
                onDelete={() => {
                  if (selectedIds.length === 0) return;
                  setBulkDeleteConfirmOpen(true);
                }}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Per-row single-confirm dialog. Stacks above ArchivedDialog
          while open so the user has full context of the row's title. */}
      <ConfirmDeleteOneDialog
        session={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await onDeletePermanently(pendingDelete.id);
          setPendingDelete(null);
        }}
      />

      {/* Bulk delete confirm — single-layer (count, no checkbox). */}
      <ConfirmDeleteManyDialog
        open={bulkDeleteConfirmOpen}
        count={selectedIds.length}
        onCancel={() => setBulkDeleteConfirmOpen(false)}
        onConfirm={async () => {
          await onDeletePermanentlyBulk(selectedIds);
          setBulkDeleteConfirmOpen(false);
          exitSelectMode();
        }}
      />

      {/* Empty-all double-confirm dialog. */}
      <ConfirmEmptyAllDialog
        open={emptyConfirmOpen}
        count={archived.length}
        onCancel={() => setEmptyConfirmOpen(false)}
        onConfirm={async () => {
          await onEmptyAll();
          setEmptyConfirmOpen(false);
        }}
      />
    </>
  );
}

// ---------------- Header ----------------

function Header({
  count,
  selectMode,
  selectedCount,
  onEnterSelectMode,
  onCancelSelectMode,
  onClose,
  onEmptyAll,
}: {
  count: number;
  selectMode: boolean;
  selectedCount: number;
  onEnterSelectMode: () => void;
  onCancelSelectMode: () => void;
  onClose: () => void;
  onEmptyAll: () => void;
}) {
  const summary = selectMode
    ? `已选 ${selectedCount}`
    : count > 0
      ? `${count} 个已归档`
      : "暂无归档";

  return (
    <div className="flex items-center gap-3 border-b border-line bg-elevated px-5 py-3.5">
      <Dialog.Title className="font-serif text-[16px] font-medium text-ink">
        Archived
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
          <>
            {count > 0 && (
              <button
                type="button"
                onClick={onEnterSelectMode}
                className={cn(
                  "rounded-sm border border-line bg-elevated px-2.5 py-1 text-[12px] text-ink-soft",
                  "transition-colors hover:bg-hover hover:text-ink",
                )}
              >
                多选
              </button>
            )}
            {count > 0 && (
              <button
                type="button"
                onClick={onEmptyAll}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border border-error/30 bg-error/[0.06] px-2.5 py-1 text-[12px] font-medium text-error",
                  "transition-colors hover:bg-error/[0.12]",
                )}
                title="永久删除所有归档"
              >
                <WarningCircle size={12} weight="bold" />
                清空全部
              </button>
            )}
          </>
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

// ---------------- Row ----------------

function ArchivedRow({
  session,
  selectMode,
  isSelected,
  onToggleSelect,
  onRestore,
  onDelete,
}: {
  session: Session;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  if (selectMode) {
    return (
      <li
        onClick={onToggleSelect}
        className={cn(
          "flex cursor-pointer items-start gap-3 px-5 py-3 transition-colors",
          isSelected ? "bg-selected hover:bg-selected" : "hover:bg-hover",
        )}
      >
        <span className="pt-0.5 text-ink-soft">
          {isSelected ? (
            <CheckSquare size={14} weight="fill" className="text-brand-strong" />
          ) : (
            <Square size={14} weight="thin" />
          )}
        </span>
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
            {formatDate(session.updatedAt)}
            {session.turnCount !== undefined && session.turnCount > 0 && (
              <> · {session.turnCount} 步</>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-hover">
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
          {formatDate(session.updatedAt)}
          {session.turnCount !== undefined && session.turnCount > 0 && (
            <> · {session.turnCount} 步</>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={onRestore}
          title="恢复"
          aria-label="恢复"
          className="inline-flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-elevated hover:text-ink"
        >
          <ArrowUUpLeft size={14} weight="thin" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="永久删除"
          aria-label="永久删除"
          className="inline-flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-error/10 hover:text-error"
        >
          <Trash size={14} weight="thin" />
        </button>
      </div>
    </li>
  );
}

// ---------------- Select action bar ----------------

function SelectActionBar({
  selectedCount,
  allVisibleSelected,
  onToggleSelectAllVisible,
  onRestore,
  onDelete,
}: {
  selectedCount: number;
  allVisibleSelected: boolean;
  onToggleSelectAllVisible: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const disabled = selectedCount === 0;
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line bg-elevated px-4 py-2.5">
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

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onRestore}
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm border border-line bg-elevated px-2.5 py-1 text-[12px] text-ink-soft",
            "transition-colors hover:bg-hover hover:text-ink",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated disabled:hover:text-ink-soft",
          )}
        >
          <ArrowUUpLeft size={12} weight="thin" />
          恢复
          {selectedCount > 0 && (
            <span className="text-ink-muted">· {selectedCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm border border-error/30 bg-error/[0.06] px-2.5 py-1 text-[12px] font-medium text-error",
            "transition-colors hover:bg-error/[0.12]",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-error/[0.06]",
          )}
        >
          <Trash size={12} weight="thin" />
          永久删除
          {selectedCount > 0 && (
            <span className="text-error/70">· {selectedCount}</span>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------- Empty ----------------

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="font-serif text-[13.5px] italic text-ink-muted">
        没有已归档的对话。
      </p>
    </div>
  );
}

// ---------------- Confirm dialogs ----------------

/**
 * Single-layer confirm for per-row delete. Standard
 * destructive-action pattern: cancel button on the left (escape
 * also dismisses via Radix), destructive button on the right.
 */
function ConfirmDeleteOneDialog({
  session,
  onCancel,
  onConfirm,
}: {
  session: Session | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog.Root
      open={!!session}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          // role="alertdialog" instructs assistive tech to interrupt
          // and require explicit dismissal — appropriate for a
          // destructive confirmation.
          role="alertdialog"
          aria-describedby="confirm-delete-one-desc"
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] w-[420px] -translate-x-1/2 -translate-y-1/2",
            "rounded-[14px] border border-line bg-elevated p-5 shadow-elevated",
            "max-w-[calc(100vw-32px)]",
          )}
        >
          <Dialog.Title className="font-serif text-[15px] font-medium text-ink">
            永久删除这个对话？
          </Dialog.Title>
          <p
            id="confirm-delete-one-desc"
            className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft"
          >
            「{session?.title ?? ""}」连同它的所有对话记录将被永久删除。
            <span className="text-ink">此操作无法撤销。</span>
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              autoFocus
              className="rounded-sm border border-line bg-elevated px-3.5 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                void onConfirm();
              }}
              className={cn(
                "rounded-sm border border-error bg-error px-3.5 py-1.5 text-[12.5px] font-medium text-elevated",
                "transition-colors hover:bg-error/90",
              )}
            >
              永久删除
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Single-layer confirm for "Delete N selected". Mirrors the per-row
 * confirm — the user already deliberated by checking the rows, so
 * the empty-all checkbox-acknowledge friction would be redundant.
 */
function ConfirmDeleteManyDialog({
  open,
  count,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          role="alertdialog"
          aria-describedby="confirm-delete-many-desc"
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] w-[440px] -translate-x-1/2 -translate-y-1/2",
            "rounded-[14px] border border-line bg-elevated p-5 shadow-elevated",
            "max-w-[calc(100vw-32px)]",
          )}
        >
          <Dialog.Title className="font-serif text-[15px] font-medium text-ink">
            永久删除选中的 {count} 个对话？
          </Dialog.Title>
          <p
            id="confirm-delete-many-desc"
            className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft"
          >
            这些对话连同它们的所有消息和工具调用记录将被永久删除。
            <span className="text-ink">此操作无法撤销。</span>
          </p>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              autoFocus
              className="rounded-sm border border-line bg-elevated px-3.5 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                void onConfirm();
              }}
              className={cn(
                "rounded-sm border border-error bg-error px-3.5 py-1.5 text-[12.5px] font-medium text-elevated",
                "transition-colors hover:bg-error/90",
              )}
            >
              永久删除 {count} 个
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Two-layer confirm for "Empty all". The user must check the
 * "我了解此操作无法撤销" checkbox before the destructive button
 * becomes enabled. Mirrors GitHub's "delete repository" friction
 * for batch destructive operations.
 *
 * Resets the checkbox whenever the dialog opens so a previous
 * acknowledged state doesn't carry over.
 */
function ConfirmEmptyAllDialog({
  open,
  count,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  count: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setAcknowledged(false);
          onCancel();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          role="alertdialog"
          aria-describedby="confirm-empty-all-desc"
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] w-[460px] -translate-x-1/2 -translate-y-1/2",
            "rounded-[14px] border border-line bg-elevated p-5 shadow-elevated",
            "max-w-[calc(100vw-32px)]",
          )}
        >
          <div className="flex items-center gap-2">
            <WarningCircle size={18} weight="bold" className="text-error" />
            <Dialog.Title className="font-serif text-[15px] font-medium text-ink">
              清空所有归档？
            </Dialog.Title>
          </div>
          <p
            id="confirm-empty-all-desc"
            className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft"
          >
            将永久删除 <span className="font-medium text-ink">{count}</span>{" "}
            个已归档对话，包括它们的所有消息和工具调用记录。
            <span className="text-ink">此操作无法撤销。</span>
          </p>

          <label className="mt-4 flex cursor-pointer select-none items-start gap-2 rounded-sm border border-line bg-app px-3 py-2.5 text-[12.5px] text-ink transition-colors hover:border-line-strong">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 size-3.5 accent-error"
            />
            <span>我了解此操作无法撤销</span>
          </label>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAcknowledged(false);
                onCancel();
              }}
              autoFocus
              className="rounded-sm border border-line bg-elevated px-3.5 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-hover"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!acknowledged}
              onClick={() => {
                void onConfirm().then(() => setAcknowledged(false));
              }}
              className={cn(
                "rounded-sm border border-error bg-error px-3.5 py-1.5 text-[12.5px] font-medium text-elevated",
                "transition-colors hover:bg-error/90",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-error",
              )}
            >
              清空全部
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------- helpers ----------------

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
