import * as Dialog from "@radix-ui/react-dialog";
import {
  FolderOpen,
  Trash,
  WarningCircle,
  X as XIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { Project } from "@/types/session";

export interface EditProjectDialogProps {
  /** Project to edit. `null` = closed. The parent owns this state so
   * right-clicking different projects can re-open with fresh data
   * without a full unmount/remount cycle. */
  project: Project | null;
  onClose: () => void;
  /** Persist name / rootPath edits. Resolves after the store action
   * completes so the dialog can close synchronously. */
  onSave: (
    id: string,
    partial: { name: string; rootPath?: string },
  ) => Promise<void>;
  /** Trigger delete confirm flow. Called when the user clicks the
   * destructive "删除 Project" button; a separate AlertDialog handles
   * the confirm step (parent owns it for consistency with the
   * existing ConfirmDelete* pattern in ArchivedDialog). */
  onRequestDelete: (project: Project) => void;
}

/**
 * Edit Project — rename + re-bind rootPath. Same 420px frame as
 * CreateProjectDialog so the two read as siblings; the only
 * structural difference is the destructive "删除 Project" row at
 * the bottom (separated by a divider so a stray click doesn't slip
 * into it).
 *
 * Per Q2 in the design plan: deleting a project unassigns its
 * sessions (projectId → NULL) but doesn't delete them. The actual
 * delete confirm dialog is owned by the parent.
 */
export function EditProjectDialog({
  project,
  onClose,
  onSave,
  onRequestDelete,
}: EditProjectDialogProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!project) return;
    const t = setTimeout(() => {
      setName(project.name);
      setRootPath(project.rootPath ?? "");
      setSubmitting(false);
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [project]);

  const trimmedName = name.trim();
  const canSubmit =
    !!project &&
    trimmedName.length > 0 &&
    !submitting &&
    // No-op detection: same name + same rootPath = don't bother
    // round-tripping the store. Lets the user use Esc / close
    // without thinking "did I change anything?".
    (trimmedName !== project.name ||
      (rootPath.trim() || undefined) !== project.rootPath);

  const handleSubmit = async () => {
    if (!project || !canSubmit) return;
    setSubmitting(true);
    try {
      await onSave(project.id, {
        name: trimmedName,
        rootPath: rootPath.trim() || undefined,
      });
      onClose();
    } catch (e) {
      console.warn("[EditProjectDialog] onSave failed.", e);
      setSubmitting(false);
    }
  };

  const handlePickFolder = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择项目根目录",
      });
      if (typeof selected === "string" && selected.length > 0) {
        setRootPath(selected);
      }
    } catch (e) {
      console.warn("[EditProjectDialog] folder pick failed.", e);
    }
  };

  const isOpen = !!project;

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2",
            "rounded-[14px] border border-line bg-elevated p-5 shadow-elevated",
            "max-w-[calc(100vw-32px)]",
          )}
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-serif text-[16px] font-medium text-ink">
              Edit Project
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <XIcon size={14} weight="thin" />
            </Dialog.Close>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
            className="mt-5 space-y-4"
          >
            <Field label="名称" required>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={cn(
                  "h-9 w-full rounded-sm border border-line bg-app px-3 text-[13px] text-ink",
                  "placeholder:text-ink-muted focus:border-line-strong focus:outline-none",
                )}
              />
            </Field>

            <Field
              label="项目文件夹"
              hint="修改后已有对话需重启 Workbench 后生效"
            >
              <div className="flex gap-2">
                <input
                  type="text"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                  placeholder="未绑定文件夹"
                  className={cn(
                    "h-9 min-w-0 flex-1 rounded-sm border border-line bg-app px-3 font-mono text-[12.5px] text-ink",
                    "placeholder:text-ink-muted focus:border-line-strong focus:outline-none",
                  )}
                />
                <button
                  type="button"
                  onClick={() => void handlePickFolder()}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-elevated px-3 text-[12.5px] text-ink-soft",
                    "transition-colors hover:border-brand hover:bg-brand-soft hover:text-ink",
                  )}
                >
                  <FolderOpen size={13} weight="thin" />
                  选择
                </button>
              </div>
            </Field>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-sm border border-line bg-elevated px-3.5 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-hover"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className={cn(
                  "rounded-sm border border-brand-strong bg-brand-strong px-3.5 py-1.5 text-[12.5px] font-medium text-elevated",
                  "transition-colors hover:bg-brand-strong/90",
                  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-brand-strong",
                )}
              >
                保存
              </button>
            </div>
          </form>

          <div className="mt-5 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => project && onRequestDelete(project)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border border-error/30 bg-error/[0.06] px-2.5 py-1 text-[12px] font-medium text-error",
                "transition-colors hover:bg-error/[0.12]",
              )}
            >
              <Trash size={12} weight="thin" />
              删除 Project
            </button>
            <span className="ml-2 text-[11px] text-ink-muted">
              里面的 session 不会被删除，自动解绑回 timeline
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface ConfirmDeleteProjectDialogProps {
  project: Project | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Single-layer confirm before deleting a project. Same pattern as
 * ArchivedDialog's ConfirmDeleteOne — the user already deliberated
 * by navigating into Edit and clicking destructive, so no
 * checkbox-acknowledge friction needed.
 */
export function ConfirmDeleteProjectDialog({
  project,
  onCancel,
  onConfirm,
}: ConfirmDeleteProjectDialogProps) {
  return (
    <Dialog.Root
      open={!!project}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          role="alertdialog"
          aria-describedby="confirm-delete-project-desc"
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] w-[420px] -translate-x-1/2 -translate-y-1/2",
            "rounded-[14px] border border-line bg-elevated p-5 shadow-elevated",
            "max-w-[calc(100vw-32px)]",
          )}
        >
          <div className="flex items-center gap-2">
            <WarningCircle size={18} weight="bold" className="text-error" />
            <Dialog.Title className="font-serif text-[15px] font-medium text-ink">
              删除 Project「{project?.name ?? ""}」？
            </Dialog.Title>
          </div>
          <p
            id="confirm-delete-project-desc"
            className="mt-2 text-[12.5px] leading-[1.55] text-ink-soft"
          >
            该 Project 下的 sessions 不会被删除，会自动解绑回 timeline。
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
              删除 Project
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
        {label}
        {required && <span className="ml-0.5 text-error">*</span>}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <div className="mt-1 text-[11.5px] text-ink-muted">{hint}</div>
      )}
    </div>
  );
}
