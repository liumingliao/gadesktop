import * as Popover from "@radix-ui/react-popover";
import {
  ArrowUp,
  CaretUp,
  Check,
  Cube,
  Plus,
  Stop,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface ComposerLLMOption {
  index: number;
  displayName: string;
  isCurrent: boolean;
}

/**
 * Maximum textarea height in pixels (auto-grow cap). 280px ≈ 10 lines
 * at our 14.5px / 1.55 line-height. Past this the textarea scrolls
 * internally — beyond ~10 lines the layout would crowd the
 * conversation document above.
 */
const COMPOSER_MAX_HEIGHT_PX = 280;

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

  /**
   * LLM list for the inline dropdown. When provided + non-empty, the
   * Composer renders its own Radix Popover under the LLM pill (the
   * ChatGPT / Claude UX). When empty / undefined, the pill becomes a
   * fallback button that calls `onOpenLLMSwitcher` instead — used by
   * pre-bridge states or by callers that prefer the Command Palette
   * route.
   */
  llms?: ComposerLLMOption[];
  /** Called when the user picks an LLM from the inline dropdown. */
  onSelectLLM?: (index: number) => void;
  /** Fallback click handler for the LLM pill when `llms` is not
   * provided. Today the only caller using this path is the dev-toggle
   * harness; production wires `llms` + `onSelectLLM`. */
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
  llms,
  onSelectLLM,
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

  // Auto-grow: reset height to `auto` (so scrollHeight reflects
  // content, not previous height) then snap to scrollHeight. Capped
  // at COMPOSER_MAX_HEIGHT_PX — beyond that the textarea scrolls
  // internally. ChatGPT / Claude / Notion all do this pattern; users
  // expect multi-line input to expand the composer rather than
  // disappear behind a fixed-height window.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    el.style.height = `${next}px`;
  }, [text]);

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
        rows={2}
        disabled={disabled}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={{ maxHeight: COMPOSER_MAX_HEIGHT_PX }}
        // `resize-none` keeps the corner grab handle hidden — the
        // height auto-grows via the effect above, so manual resize
        // would just fight it. `overflow-y-auto` handles the rare
        // case where content exceeds the max-height cap.
        className="block w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[14.5px] leading-[1.55] text-ink outline-none placeholder:text-ink-muted"
      />

      <div className="mt-2 flex items-center gap-2">
        <ComposerCornerButton title="Add (V0.2)" disabled>
          <Plus size={14} weight="thin" />
        </ComposerCornerButton>

        <LLMPill
          llmDisplayName={llmDisplayName}
          llms={llms}
          onSelectLLM={onSelectLLM}
          onOpenLLMSwitcher={onOpenLLMSwitcher}
          disabled={disabled || stopMode}
          stopMode={stopMode}
        />

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

/**
 * LLM pill — clickable label showing the current model, opens a
 * dropdown of available models for one-click switching (DESIGN.md §4.4).
 *
 * Two modes:
 *   - `llms` provided (production): renders a Radix Popover with the
 *     model list, mirroring ChatGPT / Claude's inline picker UX.
 *   - `llms` empty / undefined: falls back to `onOpenLLMSwitcher`
 *     callback (e.g. opens Command Palette) so pre-bridge states
 *     and dev tooling still have a click target.
 *
 * `stopMode` (agent mid-run) disables both — switching LLMs while a
 * turn is in flight would race the in-progress request and produce
 * inconsistent state. PRD §13.2.
 */
function LLMPill({
  llmDisplayName,
  llms,
  onSelectLLM,
  onOpenLLMSwitcher,
  disabled,
  stopMode,
}: {
  llmDisplayName: string;
  llms?: ComposerLLMOption[];
  onSelectLLM?: (index: number) => void;
  onOpenLLMSwitcher?: () => void;
  disabled: boolean;
  stopMode: boolean;
}) {
  const title = stopMode
    ? "运行中无法切换 LLM"
    : `切换 LLM · 当前 ${llmDisplayName}`;

  const pillClasses = cn(
    "flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[12.5px] text-ink-soft transition-colors hover:bg-hover hover:text-ink",
    disabled && "cursor-not-allowed opacity-60",
  );

  // Fallback path — no llms list available, defer to the parent's
  // legacy handler. Same visual treatment as the popover trigger.
  if (!llms || llms.length === 0) {
    return (
      <button
        type="button"
        onClick={onOpenLLMSwitcher}
        disabled={disabled}
        className={pillClasses}
        title={title}
      >
        <Cube size={13} weight="thin" className="text-ink-muted" />
        <span>{llmDisplayName}</span>
        <CaretUp size={10} weight="thin" className="text-ink-muted" />
      </button>
    );
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={pillClasses}
          title={title}
        >
          <Cube size={13} weight="thin" className="text-ink-muted" />
          <span>{llmDisplayName}</span>
          <CaretUp size={10} weight="thin" className="text-ink-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          className={cn(
            "z-50 min-w-[200px] max-w-[320px] rounded-md border border-line bg-elevated p-1 shadow-elevated",
          )}
        >
          {llms.map((llm) => (
            <Popover.Close asChild key={llm.index}>
              <button
                type="button"
                onClick={() => onSelectLLM?.(llm.index)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover",
                  llm.isCurrent ? "text-ink" : "text-ink-soft",
                )}
              >
                <span className="flex w-3.5 shrink-0 items-center justify-center">
                  {llm.isCurrent && (
                    <Check
                      size={12}
                      weight="bold"
                      className="text-brand-strong"
                    />
                  )}
                </span>
                <span className="truncate">{llm.displayName}</span>
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
