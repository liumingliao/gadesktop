import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Full app shell:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Top Bar (44px, full width)                                   │
 *   ├──────────┬──────────────────────────────┬───────────────────┤
 *   │ Sidebar  │ Main                         │ Inspector         │
 *   │ (240px)  │ (flex)                       │ (320px, optional) │
 *   └──────────┴──────────────────────────────┴───────────────────┘
 *
 * macOS traffic light is positioned at {16, 16} via tauri.conf.json
 * `titleBarStyle: "Overlay"` and floats over the Top Bar. The Top Bar
 * itself reserves left padding for it; Sidebar content starts at y=44px
 * and never collides with the traffic light.
 *
 * Inspector visibility is per-screen: Empty State hides it, Main View
 * shows it. The 1120px minimum window width guarantees three columns
 * fit when the inspector is visible.
 */
export function AppShell({
  topBar,
  sidebar,
  main,
  inspector,
  inspectorVisible = true,
}: {
  topBar: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
  inspectorVisible?: boolean;
}) {
  return (
    <div className="flex h-screen min-h-[720px] w-screen min-w-[1120px] flex-col bg-app text-ink">
      {topBar}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-app">
          {sidebar}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-app">{main}</main>

        {inspectorVisible && inspector && (
          <aside
            className={cn(
              "flex w-80 shrink-0 flex-col border-l border-line bg-app",
            )}
          >
            {inspector}
          </aside>
        )}
      </div>
    </div>
  );
}
