import { DotsThreeOutline, MagnifyingGlass } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

export interface TopBarProps {
  /**
   * Current session title to display in the center-left.
   * Empty / undefined = no session active (Empty State); we render an
   * italic muted "新对话" placeholder so the bar always has a title slot.
   */
  sessionTitle?: string;
  onOpenCommandPalette?: () => void;
  /**
   * Padding on the left to clear the macOS traffic light (which is
   * positioned at {16, 16} via tauri.conf.json titleBarStyle "Overlay").
   * Three buttons × 12px + gaps + safety = ~70px.
   */
  trafficLightPadding?: number;
}

/**
 * Top bar — full-window-width, 44px tall. Per DESIGN.md §4.1.
 *
 *   [ traffic light reserved │  ─── title (centered) ───  │ ⌘K  ... ]
 *
 * Layout — three flex sections; the title sits centered in the
 * remaining space between the traffic-light reserve (left) and the
 * action cluster (right). This is the standard macOS pattern (Safari,
 * Notion, Mail.app, Pages, Finder): the document title floats centered
 * in the chrome, not glued to the traffic-light cluster.
 *
 * Why not just left-align with extra padding: with paddingLeft = 70px
 * the title sat 2px from the traffic light's right edge — visually it
 * read as a single cramped cluster. Adding more padding helps the
 * spacing but the asymmetry (title left, actions right) still feels
 * off. Centering produces the symmetric chrome the OS conditions us to
 * expect.
 *
 * Sidebar toggle lives inside Sidebar.tsx header (next to the logo).
 * Co-locating an affordance with its target avoids visual collision
 * with the traffic-light cluster (16-68px) and matches Notion / Linear
 * / Arc / Cursor convention.
 *
 * Window dragging:
 *   - Tauri v2 only honours `data-tauri-drag-region` when the
 *     `core:window:allow-start-dragging` permission is granted —
 *     `core:default` does NOT include it. We add it explicitly in
 *     capabilities/default.json.
 *   - The attribute is non-bubbling (the element receiving mousedown
 *     must carry it). We mark the root, the title slot, and the title
 *     span / placeholder. Buttons are auto-excluded by Tauri.
 *
 * V0.1 #2: title is read-only display; inline edit lands in #3 when
 * conversation state has a place to live. The editing <input> will
 * need to opt out of drag region (otherwise mousedown gets captured by
 * the OS for window drag instead of focusing the input).
 */
export function TopBar({
  sessionTitle,
  onOpenCommandPalette,
  trafficLightPadding = 70,
}: TopBarProps) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-stretch border-b border-line bg-app pr-3 text-[13px]"
    >
      {/* Left: traffic-light reserve. Pure spacer, draggable. */}
      <div
        data-tauri-drag-region
        className="shrink-0"
        style={{ width: trafficLightPadding }}
      />

      {/* Center: title centered in remaining space. flex-1 so it
          consumes whatever the action cluster doesn't. */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center justify-center px-3"
      >
        {sessionTitle ? (
          <span
            data-tauri-drag-region
            className="truncate font-medium text-ink"
          >
            {sessionTitle}
          </span>
        ) : (
          <span
            data-tauri-drag-region
            className="truncate font-serif italic text-ink-muted"
          >
            新对话
          </span>
        )}
      </div>

      {/* Right: action cluster. Buttons are auto-excluded from drag
          region by Tauri so they remain clickable. */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          title="Search · ⌘K"
          onClick={onOpenCommandPalette}
          ariaLabel="Open command palette"
        >
          <MagnifyingGlass size={16} weight="thin" />
        </IconButton>
        <IconButton title="More" ariaLabel="More options">
          <DotsThreeOutline size={16} weight="thin" />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  ariaLabel,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}
