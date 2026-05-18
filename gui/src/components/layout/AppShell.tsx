import type { ReactNode } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";

/**
 * Full app shell:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Top Bar (44px, full width, draggable via tauri-drag-region) │
 *   ├──────────┬─┬────────────────────────────────────────────────┤
 *   │ Sidebar  │ │ Main                                           │
 *   │ (~20%)   │↕│ (~80%)                                         │
 *   └──────────┴─┴────────────────────────────────────────────────┘
 *
 * Resizable two-column layout via react-resizable-panels v4 (`Group`
 * + `Panel` + `Separator`). Widths are persisted to localStorage via
 * `useDefaultLayout` so layout survives across runs. Percentages (not
 * pixels) so it scales gracefully across window sizes; the macOS
 * minimum window is 1120px (Tauri config).
 *
 * Constraints:
 *   - Sidebar  14–30%  (≈ 156–444px at 1120w)
 *   - Main     ≥ 40%
 *
 * **Why no right pane**: the previous Inspector (right-side Details /
 * Approvals / Runtime tabs) was retired 2026-05-12. Each of its tabs
 * duplicated information already accessible elsewhere (ToolCallout
 * cards in the conversation, ApprovalDock for pending, Settings →
 * Runtime/Approval for metadata and audit log). Reclaiming the
 * 14–30% horizontal space gave the conversation column proper
 * breathing room; the app reads as a focused chat product rather
 * than an IDE clone. Memory Inspector (V0.2 PRD) — if it lands —
 * gets a fresh design, not a reuse of this slot.
 *
 * macOS traffic light is positioned at {16, 16} via tauri.conf.json
 * `titleBarStyle: "Overlay"`; it floats above the Top Bar. The Top Bar
 * reserves ~70px left padding and the Sidebar starts at y=44px (below
 * the Top Bar's bottom border), so the traffic light never collides
 * with sidebar content.
 *
 * `overflow-hidden` on `<aside>` and `<main>` Panel children locks
 * scrolling to each section's own internal container (Sidebar bucket
 * list, conversation column) — prevents the whole column from
 * scrolling when content overflows, which would otherwise push
 * Composer out of view.
 *
 * Sidebar is intentionally non-collapsible. The dragable separator
 * (ResizeSeparator below) lets users shrink it down to 14% if they
 * want less chrome; full collapse was considered and rejected on
 * 2026-05-13 — sidebar is the physical embodiment of multi-session,
 * which is the product's core differentiator. Hiding it hides the
 * value prop. See devlog for the full reasoning.
 */
export function AppShell({
  topBar,
  sidebar,
  main,
}: {
  topBar: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "ga-workbench-layout-2col-v2",
    panelIds: ["sidebar", "main"],
  });
  return (
    <div className="flex h-screen min-h-[720px] w-screen min-w-[1120px] flex-col bg-app text-ink">
      {topBar}
      <Group
        id="ga-workbench-layout-2col-v2"
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="flex min-h-0 flex-1"
      >
        <Panel id="sidebar" defaultSize="20%" minSize="14%" maxSize="30%">
          <aside className="flex h-full flex-col overflow-hidden border-r border-line bg-app">
            {sidebar}
          </aside>
        </Panel>
        <ResizeSeparator />
        <Panel id="main" defaultSize="80%" minSize="40%">
          <main className="flex h-full min-w-0 flex-col overflow-hidden bg-app">
            {main}
          </main>
        </Panel>
      </Group>
    </div>
  );
}

/**
 * Resize handle: a 1px-wide visible line with a 6px-wide invisible
 * hit zone around it. The hit zone makes the pointer target friendly
 * (1px alone is unhittable) without thickening the divider visually.
 * On hover and during drag (`:active`) the line tints to brand,
 * matching the apricot accent we use for other interactive
 * affordances (DESIGN.md §2.1).
 */
function ResizeSeparator() {
  return (
    <Separator className="group relative w-1.5 shrink-0 cursor-col-resize">
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors group-hover:bg-brand group-active:bg-brand" />
    </Separator>
  );
}
