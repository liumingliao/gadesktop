import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Canonical button surface for Galley. Every new button should use
 * this component; existing buttons migrate organically as their
 * containing files are touched.
 *
 * Why a component instead of a class string constant: variant +
 * size combinations multiply quickly, and inlining the cn() calls
 * everywhere makes per-button drift inevitable. A component
 * concentrates the source of truth and provides a typed prop API.
 *
 * ## Variants
 *
 *   primary — Main CTA. Charcoal foreground (`bg-ink`), white text.
 *             Used for "确认 / 保存 / 创建 / 继续". One per dialog
 *             or screen; the eye should know where to land.
 *
 *   secondary — Border-only, neutral bg. Used for "取消 / Back / 次要
 *               操作". Pairs with a primary on the same row.
 *
 *   ghost — No border, no bg. Hover surfaces a subtle bg tint.
 *           Used for inline links / navigation aids ("Back" without
 *           a primary on the row, "Settings 中查看" tertiary links).
 *
 *   destructive — Red filled. Reserved for irreversible actions
 *                 ("彻底删除"). Use sparingly — its color cost is
 *                 the warning signal.
 *
 *   destructive-soft — Pale-red bg + red text. For "this opens a
 *                      destructive flow" entry buttons (e.g., the
 *                      "删除项目" button inside EditProjectDialog
 *                      that opens ConfirmDeleteProjectDialog).
 *                      Less alarming than `destructive`, still
 *                      distinct from `secondary`.
 *
 * ## Sizes
 *
 *   sm — `px-2.5 py-1 / 12px` — Inline pill-density actions.
 *   md — `px-3.5 py-1.5 / 12.5px` — Standard dialog buttons.
 *        **Default.**
 *   lg — `px-5 py-2 / 13.5px` — Onboarding / hero CTAs.
 *
 * ## Notes
 *
 *   - Disabled handling is universal: `opacity-40 + cursor-not-allowed`.
 *     We don't `disabled:hover:*` override — opacity already kills the
 *     hover visual cleanly.
 *   - All variants use `rounded-sm` and `transition-colors`. Override
 *     via `className` only when you have a specific reason (the
 *     ModeCard / Composer submit-pill remain hand-rolled outliers).
 *   - Icons (leadingIcon / trailingIcon) inherit the gap defined by
 *     the size. Caller is responsible for icon sizing + weight to
 *     match the button text.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "destructive"
  | "destructive-soft";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon node rendered before children. Sized + weighted by caller. */
  leadingIcon?: ReactNode;
  /** Icon node rendered after children. */
  trailingIcon?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: cn(
    "border border-ink bg-ink font-medium text-elevated",
    "hover:bg-ink/90",
  ),
  secondary: cn(
    "border border-line bg-elevated text-ink",
    "hover:bg-hover",
  ),
  ghost: cn(
    "border border-transparent text-ink-soft",
    "hover:bg-hover hover:text-ink",
  ),
  destructive: cn(
    "border border-error bg-error font-medium text-elevated",
    "hover:bg-error/90",
  ),
  "destructive-soft": cn(
    "border border-error/30 bg-error/[0.06] font-medium text-error",
    "hover:bg-error/[0.12]",
  ),
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "gap-1 px-2.5 py-1 text-[12px]",
  md: "gap-1.5 px-3.5 py-1.5 text-[12.5px]",
  lg: "gap-2 px-5 py-2 text-[13.5px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      leadingIcon,
      trailingIcon,
      className,
      children,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex select-none items-center justify-center rounded-sm transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-40",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...rest}
      >
        {leadingIcon}
        {children}
        {trailingIcon}
      </button>
    );
  },
);
