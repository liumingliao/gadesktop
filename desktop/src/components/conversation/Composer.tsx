import { ArrowUp, CaretDown, Cube, Plus, Stop } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface ComposerProps {
  /** Display name of the currently active LLM (e.g., "Claude Sonnet 4.5"). */
  llmDisplayName: string;

  /** Controlled value (optional; uncontrolled if omitted). */
  value?: string;
  onChange?: (text: string) => void;

  /** Submit handler. Triggered by Enter (without Shift) or clicking the
   * submit button. Receives the trimmed text. */
  onSubmit?: (text: string) => void;

  /** When true, hide submit and show the deep-amber stop button. */
  stopMode?: boolean;
  onStop?: () => void;

  /** When true, the textarea is read-only and submit/stop are disabled. */
  disabled?: boolean;

  placeholder?: string;
  autoFocus?: boolean;

  /** Hook for opening the LLM dropdown popover. Real popover lands in #6
   * (shadcn DropdownMenu); for now this just prints a no-op or wires
   * through to a parent handler. */
  onOpenLLMSwitcher?: () => void;
}

/**
 * Composer — text input + LLM switcher + submit/stop. Per DESIGN.md §4.4.
 *
 * Apricot focus ring is the brand moment; submit button is the only
 * place we use apricot as a CTA fill. When the agent is running,
 * stopMode replaces submit with a deep-amber Stop button at the same
 * position.
 */
export function Composer({
  llmDisplayName,
  value,
  onChange,
  onSubmit,
  stopMode = false,
  onStop,
  disabled = false,
  placeholder = "问点什么…",
  autoFocus = false,
  onOpenLLMSwitcher,
}: ComposerProps) {
  // Hybrid controlled / uncontrolled. When `value` prop is provided
  // we render it directly; otherwise we maintain an internal copy.
  // Avoid syncing prop -> internal in an effect (React 19 / Compiler
  // flags that as cascading-render-prone) — derive on render instead.
  const [internal, setInternal] = useState("");
  const isControlled = value !== undefined;
  const text = isControlled ? value : internal;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || stopMode) return;
    onSubmit?.(trimmed);
    if (!isControlled) setInternal("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border border-line bg-elevated px-3.5 pb-2 pt-3.5 shadow-card transition-all",
        "focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/20",
        disabled && "opacity-60",
      )}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        disabled={disabled}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="block w-full resize-none border-0 bg-transparent p-0 text-[14.5px] leading-[1.55] text-ink outline-none placeholder:text-ink-muted"
      />

      <div className="mt-2 flex items-center gap-2">
        <ComposerCornerButton title="Add (V0.2)" disabled>
          <Plus size={14} weight="thin" />
        </ComposerCornerButton>

        <button
          type="button"
          onClick={onOpenLLMSwitcher}
          disabled={disabled || stopMode}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[12.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink",
            (disabled || stopMode) && "cursor-not-allowed opacity-60",
          )}
          title={
            stopMode
              ? "运行中无法切换 LLM"
              : `切换 LLM · 当前 ${llmDisplayName}`
          }
        >
          <Cube size={13} weight="thin" className="text-ink-muted" />
          <span>{llmDisplayName}</span>
          <CaretDown size={10} weight="thin" className="text-ink-muted" />
        </button>

        {stopMode ? (
          <button
            type="button"
            onClick={onStop}
            title="Stop"
            aria-label="Stop"
            className="ml-auto flex size-8 items-center justify-center rounded-full bg-warning text-white transition-colors hover:bg-warning/90"
          >
            <Stop size={14} weight="fill" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={disabled || !text?.trim()}
            title="Send · Enter"
            aria-label="Send"
            className={cn(
              "ml-auto flex size-8 items-center justify-center rounded-full bg-brand text-ink transition-colors hover:bg-brand-strong hover:text-white",
              (disabled || !text?.trim()) &&
                "cursor-not-allowed opacity-50 hover:bg-brand hover:text-ink",
            )}
          >
            <ArrowUp size={16} weight="bold" />
          </button>
        )}
      </div>
    </div>
  );
}

function ComposerCornerButton({
  children,
  title,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink-soft",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}
