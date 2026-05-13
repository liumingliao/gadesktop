import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, X as XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the validated input when the user clicks 创建. The
   * caller (App.tsx) is responsible for invoking `createProject` on
   * the store and any post-create navigation (e.g., filter into the
   * new project). Resolves after the store action completes so the
   * dialog can close synchronously. */
  onCreate: (input: { name: string; rootPath?: string }) => Promise<void>;
}

/**
 * Create a new Project. Per PRD §7.3 Project = pure 归类 + optional
 * cwd binding. The dialog reflects that with just two inputs — name
 * (required) and folder (optional via native picker). Icon / color
 * customisation lives in V0.2 polish; V0.1 ships with a single 📂
 * default to keep first-create friction near zero.
 *
 * Sized smaller than EarlierDialog (420 vs 640) — this is a quick
 * create flow, not a browser. Esc / click-outside dismiss via Radix.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Reset on open. Deferred via setTimeout so the reset doesn't
  // run synchronously inside the effect body
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setName("");
      setRootPath("");
      setSubmitting(false);
      nameInputRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onCreate({
        name: trimmedName,
        rootPath: rootPath.trim() || undefined,
      });
      onOpenChange(false);
    } catch (e) {
      console.warn("[CreateProjectDialog] onCreate failed.", e);
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
      console.warn("[CreateProjectDialog] folder pick failed.", e);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            // ⌘/Ctrl + Enter submits without forcing the user to
            // tab to the 创建 button. Plain Enter is reserved for
            // submitting from the name input (handled by form).
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
              新建项目
            </Dialog.Title>
            <Dialog.Close
              aria-label="关闭"
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
                placeholder="项目名"
                className={cn(
                  "h-9 w-full rounded-sm border border-line bg-app px-3 text-[13px] text-ink",
                  "placeholder:text-ink-muted focus:border-line-strong focus:outline-none",
                )}
              />
            </Field>

            <Field
              label="项目文件夹"
              hint="可选 · 项目里的对话以此文件夹为工作区"
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
                onClick={() => onOpenChange(false)}
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
                创建
              </button>
            </div>
          </form>
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
