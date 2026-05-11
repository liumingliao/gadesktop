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

  // Sidebar live-status comes from `sessions` directly: the store's
  // `applyRuntimeUpdate` syncs sidebar-visible fields (status,
  // pendingApprovalCount) onto each session row whenever its
  // runtime changes, but only generates a new `sessions` array when
  // those fields actually change. So a plain selector with default
  // strict-equality stays stable through frequent non-sidebar
  // updates like turn_progress streaming.
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const createSession = useAppStore((s) => s.createSession);
  const activateSession = useAppStore((s) => s.activateSession);
  const archiveSession = useAppStore((s) => s.archiveSession);
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
  const yoloMode = useAppStore((s) => s.yoloMode);
  const setYoloMode = useAppStore((s) => s.setYoloMode);

  const toasts = useAppStore((s) => s.toasts);
  const pushToast = useAppStore((s) => s.pushToast);
  const dismissToast = useAppStore((s) => s.dismissToast);

  const bridgeStatus = useAppStore((s) => s.bridgeStatus);
  const shutdownAllBridges = useAppStore((s) => s.shutdownAllBridges);
  const sendIPCCommand = useAppStore((s) => s.sendIPCCommand);
  const setGAConfig = useAppStore((s) => s.setGAConfig);

  const storeTurns = useAppStore((s) => s.turns);
  const storePending = useAppStore((s) => s.pendingApprovals);
  const agentRunning = useAppStore((s) => s.agentRunning);
  const currentTurnIndex = useAppStore((s) => s.currentTurnIndex);
  const userSubmitTick = useAppStore((s) => s.userSubmitTick);
  const inFlightContent = useAppStore((s) => s.inFlightContent);
  const appendUserTurn = useAppStore((s) => s.appendUserTurn);
  const removePendingApproval = useAppStore((s) => s.removePendingApproval);

  const hydrateFromDB = useAppStore((s) => s.hydrateFromDB);

  // Hydrate sessions from SQLite on mount. Falls through to the demo
  // seed already in the store if SQLite isn't ready (Vite-only dev,
  // first launch). #10 will hydrate conversation / approval rules /
  // prefs here too.
  useEffect(() => {
    hydrateFromDB();
  }, [hydrateFromDB]);

  // Session creation is **lazy** — we no longer auto-create on
  // landing in the empty screen. Earlier versions did, which
  // accumulated piles of "新对话" rows every time the user opened
  // and closed the app without ever typing. The Composer's
  // onSubmit handles createSession + activate at the moment the
  // user actually has intent. Sidebar's "New Chat" button still
  // creates an explicit session immediately, because that click
  // *is* the intent.

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

  // Conversation source-of-truth precedence:
  //   1. store.turns + store.pendingApprovals — populated by IPC
  //      handlers as bridge events arrive
  //   2. demo fallback (buildDemoTurns / buildDemoPending) when the
  //      store hasn't received anything yet — keeps Main View visible
  //      in pre-bridge dev so layouts can be eyeballed
  //
  // Empty store + a connected bridge means "the user hasn't sent a
  // message yet"; demo doesn't kick in then because state.turns is
  // populated as soon as appendUserTurn fires.
  const demoTurns = useMemo(
    () => buildDemoTurns(approvalDecisions),
    [approvalDecisions],
  );
  const demoPending = useMemo(
    () => buildDemoPending(approvalDecisions),
    [approvalDecisions],
  );
  // Single "is the user in a real conversation" signal drives both
  // turns and pendingApprovals. Earlier code keyed each off its own
  // length (`storeTurns.length` / `storePending.length`), which had
  // a sharp edge: as soon as the user sent a real message that
  // didn't trigger any tool dispatch (e.g. plain "你好"), turns
  // came from the store but pendingApprovals fell back to demo
  // because storePending was still []. Result: a fake "Patch file
  // at —" Approval Card appearing out of nowhere on a chit-chat
  // turn. Anchor both decisions on storeTurns.length.
  const conversationStarted = storeTurns.length > 0;
  const turns = conversationStarted ? storeTurns : demoTurns;
  const pendingApprovals = conversationStarted ? storePending : demoPending;
  // Composer Stop-mode is driven by the real `agentRunning` store flag
  // (set when user submits, cleared on turn_end / error / run_complete).
  // Keep the demo heuristic OR'd in so the pre-bridge demo flow still
  // exercises the Stop button visually.
  const isRunning =
    agentRunning || approvalDecisions["appr_demo1"] === "allow_once";

  // Always show history in the sidebar (including on the empty
  // screen) so a user composing in "new chat" can still see and
  // switch back to a prior session. Empty selection is signalled
  // by activeSession being undefined, not by hiding the list.
  //
  // Archived sessions are filtered out here so both Sidebar and
  // CommandPalette pull from the same pre-filtered list. The rows
  // still live in SQLite for a future Settings → Archive view.
  const visibleSessions = useMemo(
    () => sessions.filter((s) => s.status !== "archived"),
    [sessions],
  );
  const effectiveActiveId = screen === "main" ? activeSessionId : undefined;
  const activeSession = visibleSessions.find((s) => s.id === effectiveActiveId);

  // Onboarding takeover: no AppShell, no overlays besides the dev
  // toggle.
  if (screen === "onboarding") {
    return (
      <>
        <Onboarding
          onComplete={(gaPath) => {
            // Persist the validated path so subsequent bridge spawns
            // use the user-chosen GA install, not the demo fallback.
            // Best-effort: setGAConfig pushes a "重启 Workbench"
            // toast on success — fine for onboarding since there's
            // no bridge alive yet.
            void setGAConfig({ gaPath });
            setScreen("empty");
          }}
        />
        {import.meta.env.DEV && (
          <DevScreenToggle
            screen={screen}
            setScreen={setScreen}
            onTriggerToast={() => pushToast(makeDemoToast())}
            bridgeStatus={bridgeStatus}
            onSpawnBridge={() => {
              // Dev "spawn" walks the same path as production
              // "新 chat": create a session row + activate (which
              // spawns its bridge). Keeps the dev tool from
              // diverging into a separate flow.
              const id = createSession();
              void activateSession(id);
            }}
            onShutdownBridge={() => {
              // Dev-only kill switch. Multi-session is N-active, so
              // "kill" maps to "shutdown every alive bridge".
              void shutdownAllBridges();
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <AppShell
        topBar={
          <TopBar
            sessionTitle={activeSession?.title}
            yoloMode={yoloMode}
            onDisableYolo={() => {
              void setYoloMode(false);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        }
        sidebar={
          <Sidebar
            sessions={visibleSessions}
            activeId={effectiveActiveId}
            onNewChat={() => {
              // Create a fresh session row + activate (spawns the
              // bridge) before switching the screen, so by the time
              // the user finishes typing their first message the
              // GA process is closer to ready.
              const id = createSession();
              void activateSession(id);
              setScreen("empty");
            }}
            onSelectSession={(id) => {
              // Activate (re-spawns the bridge if this session has
              // been idle / closed / errored) and switch to main.
              // Other sessions' bridges keep running in background.
              void activateSession(id);
              setScreen("main");
            }}
            onArchiveSession={(id) => archiveSession(id)}
          />
        }
        main={
          screen === "empty" ? (
            <EmptyState
              llmDisplayName={llmDisplayName}
              llms={llms}
              onSelectLLM={(idx) => {
                if (!activeSessionId) return;
                if (bridgeStatus === "connected") {
                  void sendIPCCommand(activeSessionId, {
                    kind: "set_llm",
                    llmIndex: idx,
                  });
                }
              }}
              onOpenLLMSwitcher={() => setPaletteOpen(true)}
              onSubmit={(t) => {
                void submitOnEmpty(
                  t,
                  activeSessionId,
                  createSession,
                  activateSession,
                  appendUserTurn,
                  sendIPCCommand,
                  setScreen,
                );
              }}
              onQuickPrompt={(p) => {
                void submitOnEmpty(
                  p,
                  activeSessionId,
                  createSession,
                  activateSession,
                  appendUserTurn,
                  sendIPCCommand,
                  setScreen,
                );
              }}
            />
          ) : (
            <MainView
              turns={turns}
              llmDisplayName={llmDisplayName}
              llms={llms}
              onSelectLLM={(idx) => {
                if (!activeSessionId) return;
                if (bridgeStatus === "connected") {
                  void sendIPCCommand(activeSessionId, {
                    kind: "set_llm",
                    llmIndex: idx,
                  });
                }
              }}
              onOpenLLMSwitcher={() => setPaletteOpen(true)}
              pendingApprovals={pendingApprovals}
              approvalDecisions={approvalDecisions}
              onSubmit={(t) => {
                // Main screen always has an active session — Sidebar
                // / EmptyState set it before transitioning here.
                if (!activeSessionId) return;
                if (bridgeStatus === "connected") {
                  appendUserTurn(activeSessionId, t);
                  sendIPCCommand(activeSessionId, {
                    kind: "user_message",
                    text: t,
                    images: [],
                  });
                } else {
                  console.info("[main] submit (bridge not ready):", t);
                }
              }}
              onApprove={(approvalId, decision) => {
                if (!activeSessionId) return;
                recordApprovalDecision(activeSessionId, approvalId, decision);
                removePendingApproval(activeSessionId, approvalId);
                if (bridgeStatus === "connected") {
                  sendIPCCommand(activeSessionId, {
                    kind: "approval_response",
                    approvalId,
                    decision,
                  });
                }
              }}
              onAdvanceApproval={(next) =>
                console.info("[main] advance to:", next.approvalId)
              }
              onStop={() => {
                console.info("[main] stop");
                if (!activeSessionId) return;
                if (bridgeStatus === "connected") {
                  sendIPCCommand(activeSessionId, { kind: "abort" });
                }
              }}
              isRunning={isRunning}
              currentTurnIndex={currentTurnIndex}
              userSubmitTick={userSubmitTick}
              inFlightContent={inFlightContent}
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
          void activateSession(id);
          setScreen("main");
        }}
        onSwitchLLM={(idx) => {
          // Route to the active session's bridge. The palette is a
          // global affordance but `set_llm` is per-bridge; the user
          // intuitively expects "the LLM I see in the Composer" to
          // be the one switched, which matches activeSessionId.
          if (!activeSessionId) {
            console.info("[palette] switch llm: no active session, idx=", idx);
            return;
          }
          if (bridgeStatus === "connected") {
            void sendIPCCommand(activeSessionId, {
              kind: "set_llm",
              llmIndex: idx,
            });
          } else {
            console.info(
              "[palette] switch llm: bridge not ready, idx=",
              idx,
              "status=",
              bridgeStatus,
            );
          }
        }}
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
        yoloMode={yoloMode}
        onChangeYoloMode={(enabled) => {
          // Fire-and-forget: setYoloMode persists + notifies bridge,
          // but the UI updates synchronously from the store action.
          void setYoloMode(enabled);
        }}
        onChangeRequiredTools={setApprovalRequiredTools}
        onRemoveAlwaysAllow={removeAlwaysAllow}
        onChangeGAPath={() => {
          void pickGAPath(setGAConfig);
        }}
        // Bridge Python picker intentionally not wired — Tauri's
        // shell:allow-spawn only permits `python3` / `python` aliases.
        // SettingsRuntime renders that field read-only for V0.1.
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

// ---------------- Lazy session creation ----------------

/**
 * Empty-screen submit handler. The session is created lazily — the
 * first user-initiated action (typing a message or clicking a quick
 * prompt) is what bumps us from "no chat yet" to "real chat".
 *
 * Flow:
 *   1. If there's already an active session id, reuse it.
 *   2. Otherwise createSession + activateSession (which awaits the
 *      bridge spawn). Bridge `ready` event arrives shortly after;
 *      sendIPCCommand can write to stdin as soon as the process is
 *      spawned (bridge's command queue buffers until ready).
 *   3. Append the user turn locally and send the IPC message.
 *   4. Transition to main view so the user sees the thinking
 *      placeholder appear under their message.
 *
 * No bridgeStatus gate — the bridge may still be "spawning" when we
 * call sendIPCCommand, but the underlying tauri Command.create has
 * already returned a writable stdin. Bridge processes commands in
 * FIFO order, so user_message lands right after the spawn handshake.
 */
async function submitOnEmpty(
  text: string,
  existingId: string | undefined,
  createSession: () => string,
  activateSession: (id: string) => Promise<void>,
  appendUserTurn: (sessionId: string, text: string) => void,
  sendIPCCommand: (
    sessionId: string,
    cmd: { kind: "user_message"; text: string; images?: string[] },
  ) => Promise<void>,
  setScreen: (s: import("@/stores/useAppStore").Screen) => void,
): Promise<void> {
  let id = existingId;
  if (!id) {
    id = createSession();
    await activateSession(id);
  }
  setScreen("main");
  appendUserTurn(id, text);
  await sendIPCCommand(id, {
    kind: "user_message",
    text,
    images: [],
  });
}

// ---------------- Settings path pickers ----------------
//
// Lazy-import the Tauri dialog plugin so a Vite-only dev build doesn't
// fail to load App.tsx. In Tauri the dialog returns a string (single
// selection), null on cancel, or string[] when multiple=true.

async function pickGAPath(
  setGAConfig: (
    p: Partial<{ python: string; gaPath: string; bridgeCwd: string }>,
  ) => Promise<void>,
): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 GenericAgent 仓库目录",
    });
    if (typeof selected === "string" && selected.length > 0) {
      await setGAConfig({ gaPath: selected });
    }
  } catch (e) {
    console.warn("[settings] pickGAPath failed.", e);
  }
}

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
  bridgeStatus,
  onSpawnBridge,
  onShutdownBridge,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  onTriggerToast?: () => void;
  bridgeStatus?: import("@/stores/useAppStore").BridgeStatus;
  onSpawnBridge?: () => void;
  onShutdownBridge?: () => void;
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
      {bridgeStatus !== undefined && onSpawnBridge && onShutdownBridge && (
        <DevSegment>
          <span
            className={cn(
              "self-center px-1 font-mono text-[10px] uppercase tracking-wider",
              bridgeStatus === "connected" && "text-success",
              bridgeStatus === "spawning" && "text-warning",
              bridgeStatus === "error" && "text-error",
              (bridgeStatus === "idle" || bridgeStatus === "closed") &&
                "text-ink-muted",
            )}
            title={`bridge: ${bridgeStatus}`}
          >
            br: {bridgeStatus}
          </span>
          {bridgeStatus === "connected" || bridgeStatus === "spawning" ? (
            <DevButton onClick={onShutdownBridge}>kill</DevButton>
          ) : (
            <DevButton onClick={onSpawnBridge}>spawn</DevButton>
          )}
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
