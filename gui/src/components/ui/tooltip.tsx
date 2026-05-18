import * as Tooltip from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

/**
 * Project-wide tooltip primitive. Built on Radix Tooltip so we get
 * portal positioning (doesn't get clipped by ancestor `overflow:
 * hidden`), keyboard focus support, and proper ARIA wiring out of
 * the box — the native `title` attribute's 500–700ms delay is a
 * spec behaviour we can't tune, so Radix is the only path to a
 * "responsive" hover affordance.
 *
 * Pair this with a single `<Tooltip.Provider delayDuration={100}>`
 * at the app root (App.tsx). The default 100ms feels immediate
 * without flickering on quick mouse drift.
 *
 * Usage:
 *
 *   <IconTooltip text="Copy">
 *     <button>...</button>
 *   </IconTooltip>
 *
 * The child must be a single element that accepts ref/props
 * (Radix's `asChild` requirement). Wrap a fragment with a single
 * element if you're composing multiple things.
 */
export interface IconTooltipProps {
  /** Tooltip body text. */
  text: string;
  /** Placement relative to the trigger. Default "top". */
  side?: "top" | "right" | "bottom" | "left";
  /** Per-instance override of the provider's default delay. Use
   * sparingly — consistent timing across the app is what makes the
   * tooltip system feel cohesive. */
  delay?: number;
  children: React.ReactNode;
}

export function IconTooltip({
  text,
  side = "top",
  delay,
  children,
}: IconTooltipProps) {
  const trigger = (
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
  );

  const content = (
    <Tooltip.Portal>
      <Tooltip.Content
        side={side}
        sideOffset={6}
        className={cn(
          "z-[80] select-none rounded-sm border border-line bg-elevated px-2 py-1",
          "text-[11.5px] leading-none text-ink-soft shadow-elevated",
        )}
      >
        {text}
      </Tooltip.Content>
    </Tooltip.Portal>
  );

  // Per-instance delay nests a local Provider inside the app-root
  // one so the global default isn't disturbed. Most callers should
  // skip the prop and let the root setting govern.
  if (delay != null) {
    return (
      <Tooltip.Provider delayDuration={delay}>
        <Tooltip.Root>
          {trigger}
          {content}
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }

  return (
    <Tooltip.Root>
      {trigger}
      {content}
    </Tooltip.Root>
  );
}
