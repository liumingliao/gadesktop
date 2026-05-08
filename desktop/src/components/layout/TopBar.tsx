import {
  DotsThreeOutline,
  MagnifyingGlass,
  SidebarSimple,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

export interface TopBarProps {
  /**
   * Current session title to display in the center-left.
   * Empty / undefined = no session active (Empty State); we render an
   * italic muted "新对话" placeholder so the bar always has a title slot.
   */
  sessionTitle?: string;
  onToggleSidebar?: () => void;
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
 *   [ traffic light reserved | toggle | title (inline edit later) | ⌘K | ... ]
 *
 * V0.1 #2: title is read-only display; inline edit lands in #3 when
 * conversation state has a place to live.
 */
export function TopBar({
  sessionTitle,
  onToggleSidebar,
  onOpenCommandPalette,
  trafficLightPadding = 70,
}: TopBarProps) {
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-app pr-3 text-[13px]"
      style={{ paddingLeft: trafficLightPadding }}
    >
      <IconButton
        title="Toggle sidebar · ⌘\\"
        onClick={onToggleSidebar}
        ariaLabel="Toggle sidebar"
      >
        <SidebarSimple size={16} weight="thin" />
      </IconButton>

      <div className="min-w-0 flex-1 truncate">
        {sessionTitle ? (
          <span className="font-medium text-ink">{sessionTitle}</span>
        ) : (
          <span className="font-serif italic text-ink-muted">新对话</span>
        )}
      </div>

      <div className="flex items-center gap-1">
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
