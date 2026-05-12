import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUUpLeft,
  Trash,
  WarningCircle,
  X as XIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";

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
}

/**
 * Archived sessions browser. Two destructive operations live here:
 *
 *   - Single Delete (per row, right-side icon button): single-layer
 *     AlertDialog confirm. Lower stakes (one row), no checkbox.
 *
 *   - Empty all (header button): two-layer confirm. The button
 *     itself is destructive-styled (red + warning icon); clicking
 *     it opens an AlertDialog that REQUIRES checking an
 *     acknowledgement checkbox to enable the final "清空全部"
 *     button. Mirrors the GitHub "delete repository" pattern of
 *     making the user explicitly opt into the irreversible step.
 *
 * Restore is non-destructive — no confirm, just executes and the
 * row drops out of the archived list immediately.
 *
 * Layout matches the Settings dialog (Radix Dialog Portal + center
 * positioning + 14px rounded card) for consistency; size is a
 * little smaller since this is more of a list browser.
 */
export function ArchivedDialog({
  open,
  onOpenChange,
  sessions,
  onRestore,
  onDeletePermanently,
  onEmptyAll,
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
                      onRestore={() => onRestore(s.id)}
                      onDelete={() => setPendingDelete(s)}
                    />
                  ))}
                </ul>
              )}
            </div>
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
  onClose,
  onEmptyAll,
}: {
  count: number;
  onClose: () => void;
  onEmptyAll: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-elevated px-5 py-3.5">
      <Dialog.Title className="font-serif text-[16px] font-medium text-ink">
        Archived
      </Dialog.Title>
      <span className="text-[12.5px] text-ink-muted">
        {count > 0 ? `${count} 个已归档` : "暂无归档"}
      </span>

      <div className="ml-auto flex items-center gap-2">
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
        <Dialog.Close
          aria-label="Close"
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
  onRestore,
  onDelete,
}: {
  session: Session;
  onRestore: () => void;
  onDelete: () => void;
}) {
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
