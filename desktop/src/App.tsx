import { useEffect, useMemo } from "react";

import { ToastHost } from "@/components/error-card/ToastHost";
import { Inspector } from "@/components/inspector/Inspector";
import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { CommandPalette } from "@/components/overlay/CommandPalette";
import { EmptyState } from "@/components/screens/EmptyState";
import { MainView } from "@/components/screens/MainView";
import { Onboarding } from "@/components/screens/onboarding/Onboarding";
import { Settings } from "@/components/screens/settings/Settings";
import { cn } from "@/lib/utils";
import {
  buildDemoPending,
  buildDemoTurns,
  demoSelection,
  makeDemoToast,
} from "@/stores/demo";
import { useAppStore, type Screen } from "@/stores/useAppStore";

/**
 * V0.1 Stage 2 #8 — App entry.
 *
 * State lives in the Zustand store at `stores/useAppStore.ts`. App is
 * now mostly wiring: pull screen / approval / runtime out of the
 * store, feed them down to the four screens (Onboarding, Empty State,
 * Main View, plus the modal-y Settings + Command Palette + ToastHost),
 * route component callbacks back to store actions.
 *
 * The DEV-only screen toggle (top-right, only when import.meta.env.DEV)
 * lets us flip between Onboarding / Empty State / Main View; the
 * "+ toast" button cycles through the four hint variants for visual
 * review of the Error Card. Both vanish in production builds.
 */
function App() {
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);

  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const togglePalette = useAppStore((s) => s.togglePalette);

  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const inspectorVisible = useAppStore((s) => s.inspectorVisible);
  const toggleInspector = useAppStore((s) => s.toggleInspector);

  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const llms = useAppStore((s) => s.llms);
  const llmDisplayName = useAppStore((s) => s.llmDisplayName);
  const runtimeInfo = useAppStore((s) => s.runtimeInfo);

  const approvalDecisions = useAppStore((s) => s.approvalDecisions);
  const recordApprovalDecision = useAppStore((s) => s.recordApprovalDecision);
  const approvalConfig = useAppStore((s) => s.approvalConfig);
  const approvalRecords = useAppStore((s) => s.approvalRecords);
  const setApprovalRequiredTools = useAppStore(
    (s) => s.setApprovalRequiredTools,
  );
  const removeAlwaysAllow = useAppStore((s) => s.removeAlwaysAllow);

  const toasts = useAppStore((s) => s.toasts);
  const pushToast = useAppStore((s) => s.pushToast);
  const dismissToast = useAppStore((s) => s.dismissToast);

  const hydrateFromDB = useAppStore((s) => s.hydrateFromDB);

  // Hydrate sessions from SQLite on mount. Falls through to the demo
  // seed already in the store if SQLite isn't ready (Vite-only dev,
  // first launch). #10 will hydrate conversation / approval rules /
  // prefs here too.
  useEffect(() => {
    hydrateFromDB();
  }, [hydrateFromDB]);

  // Global keyboard shortcuts: ⌘K palette, ⌘, settings, ⌘E inspector,
  // ⌘N new chat. Esc handled by Radix Dialog (Settings) and cmdk
  // (CommandPalette) themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        togglePalette();
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        toggleInspector();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setScreen("empty");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, setSettingsOpen, toggleInspector, setScreen]);

  // Demo conversation derivation. Replaced by store-driven turn data
  // once IPC events feed real conversation in #10.
  const turns = useMemo(
    () => buildDemoTurns(approvalDecisions),
    [approvalDecisions],
  );
  const pendingApprovals = useMemo(
    () => buildDemoPending(approvalDecisions),
    [approvalDecisions],
  );
  const isRunning = approvalDecisions["appr_demo1"] === "allow_once";

  // Sidebar full mode requires sessions; in the empty-state hero
  // pre-first-message there's no session to highlight.
  const visibleSessions = screen === "empty" ? [] : sessions;
  const effectiveActiveId =
    screen === "main" ? (activeSessionId ?? "s-today-1") : undefined;
  const activeSession = visibleSessions.find((s) => s.id === effectiveActiveId);

  // Onboarding takeover: no AppShell, no overlays besides the dev
  // toggle.
  if (screen === "onboarding") {
    return (
      <>
        <Onboarding onComplete={() => setScreen("empty")} />
        {import.meta.env.DEV && (
          <DevScreenToggle
            screen={screen}
            setScreen={setScreen}
            onTriggerToast={() => pushToast(makeDemoToast())}
          />
        )}
      </>
    );
  }

  return (
    <>
      <AppShell
        topBar={<TopBar sessionTitle={activeSession?.title} />}
        sidebar={
          <Sidebar
            sessions={visibleSessions}
            activeId={effectiveActiveId}
            onNewChat={() => setScreen("empty")}
            onSelectSession={(id) => {
              setActiveSession(id);
              setScreen("main");
            }}
          />
        }
        main={
          screen === "empty" ? (
            <EmptyState
              llmDisplayName={llmDisplayName}
              onSubmit={(t) => {
                console.info("[empty] submit:", t);
                setActiveSession("s-today-1");
                setScreen("main");
              }}
              onQuickPrompt={(p) => {
                console.info("[empty] quick-prompt:", p);
                setActiveSession("s-today-1");
                setScreen("main");
              }}
            />
          ) : (
            <MainView
              turns={turns}
              llmDisplayName={llmDisplayName}
              pendingApprovals={pendingApprovals}
              approvalDecisions={approvalDecisions}
              onSubmit={(t) => console.info("[main] submit:", t)}
              onApprove={recordApprovalDecision}
              onAdvanceApproval={(next) =>
                console.info("[main] advance to:", next.approvalId)
              }
              onStop={() => console.info("[main] stop")}
              isRunning={isRunning}
            />
          )
        }
        inspector={
          screen === "main" ? (
            <Inspector
              selection={demoSelection(turns)}
              pendingApprovals={pendingApprovals}
              approvalRecords={approvalRecords}
              runtimeInfo={runtimeInfo}
              onJumpToApproval={(id) =>
                console.info("[inspector] jump to:", id)
              }
              onReRunHealthCheck={() =>
                console.info("[inspector] re-run health check")
              }
            />
          ) : null
        }
        inspectorVisible={screen === "main" && inspectorVisible}
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={visibleSessions}
        llms={llms}
        onNewChat={() => setScreen("empty")}
        onOpenSession={(id) => {
          setActiveSession(id);
          setScreen("main");
        }}
        onSwitchLLM={(idx) =>
          console.info("[palette] switch llm to index:", idx)
        }
        onReRunHealthCheck={() => console.info("[palette] re-run health check")}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleInspector={toggleInspector}
        onAttachGAFolder={() =>
          console.info("[palette] attach GA folder — wired in #10")
        }
        onSubmitFreeText={(text) => {
          console.info("[palette] free-text submit:", text);
          setScreen("main");
        }}
      />

      <Settings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        runtimeInfo={runtimeInfo}
        approval={approvalConfig}
        onChangeRequiredTools={setApprovalRequiredTools}
        onRemoveAlwaysAllow={removeAlwaysAllow}
        onChangeGAPath={() =>
          console.info("[settings] pick GA path — wired in #10")
        }
        onChangeBridgePython={() =>
          console.info("[settings] pick Bridge Python — wired in #10")
        }
        onReRunHealthCheck={() =>
          console.info("[settings] re-run health check")
        }
      />

      <ToastHost
        toasts={toasts}
        onDismiss={dismissToast}
        onSwitchLLM={() => console.info("[toast] switch llm action")}
        onOpenMyKey={() => console.info("[toast] open mykey.py")}
        onOpenGADocs={() => console.info("[toast] open GA docs")}
        onRetry={() => console.info("[toast] retry")}
      />

      {import.meta.env.DEV && (
        <DevScreenToggle
          screen={screen}
          setScreen={setScreen}
          onTriggerToast={() => pushToast(makeDemoToast())}
        />
      )}
    </>
  );
}

export default App;

// ---------------- dev-only screen toggle ----------------

const SCREEN_TOGGLE_LABEL: Record<Screen, string> = {
  onboarding: "intro",
  empty: "empty",
  main: "main",
};

function DevScreenToggle({
  screen,
  setScreen,
  onTriggerToast,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  onTriggerToast?: () => void;
}) {
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-[60] flex gap-1.5">
      <DevSegment>
        {(["onboarding", "empty", "main"] as Screen[]).map((s) => (
          <DevButton key={s} active={screen === s} onClick={() => setScreen(s)}>
            {SCREEN_TOGGLE_LABEL[s]}
          </DevButton>
        ))}
      </DevSegment>
      {onTriggerToast && (
        <DevSegment>
          <DevButton onClick={onTriggerToast}>+ toast</DevButton>
        </DevSegment>
      )}
    </div>
  );
}

function DevSegment({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto flex gap-1 rounded-md border border-line bg-elevated px-1.5 py-1 shadow-elevated">
      {children}
    </div>
  );
}

function DevButton({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
        active ? "bg-ink text-elevated" : "text-ink-muted hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}
