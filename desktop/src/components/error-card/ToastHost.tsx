import { useEffect } from "react";

import {
  ErrorCard,
  type ErrorCardActions,
} from "@/components/error-card/ErrorCard";
import type { AppError } from "@/types/app-error";

interface ToastHostProps extends ErrorCardActions {
  /** Active toasts (typically AppErrors with category bridge / business). */
  toasts: AppError[];
  onDismiss: (id: string) => void;
  /** Auto-dismiss duration in ms. Default 6000. Set 0 to disable. */
  autoDismissMs?: number;
}

/**
 * Top-level toast container for non-runtime errors. DESIGN.md §6.2.
 *
 * Bridge / business errors render here so they don't fight for space
 * inside the conversation document. Stacks toasts in the top-right
 * corner under the macOS chrome (the `top-14` value clears the 44px
 * top bar + a bit of padding).
 *
 * Each toast auto-dismisses after `autoDismissMs` (default 6s) unless
 * the user dismisses it manually first.
 */
export function ToastHost({
  toasts,
  onDismiss,
  autoDismissMs = 6000,
  ...actions
}: ToastHostProps) {
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-40 flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <ToastFrame
          key={t.id}
          toast={t}
          onDismiss={onDismiss}
          autoDismissMs={autoDismissMs}
          actions={actions}
        />
      ))}
    </div>
  );
}

function ToastFrame({
  toast,
  onDismiss,
  autoDismissMs,
  actions,
}: {
  toast: AppError;
  onDismiss: (id: string) => void;
  autoDismissMs: number;
  actions: ErrorCardActions;
}) {
  useEffect(() => {
    if (autoDismissMs <= 0) return;
    const t = setTimeout(() => onDismiss(toast.id), autoDismissMs);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss, autoDismissMs]);

  return (
    <div className="pointer-events-auto animate-fade-in">
      <ErrorCard
        error={toast}
        variant="toast"
        onDismiss={() => onDismiss(toast.id)}
        {...actions}
      />
    </div>
  );
}
