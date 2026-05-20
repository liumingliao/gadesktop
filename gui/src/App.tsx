import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";

import { ToastHost } from "@/components/error-card/ToastHost";
import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { CommandPalette } from "@/components/overlay/CommandPalette";
import { EmptyState } from "@/components/screens/EmptyState";
import { MainView } from "@/components/screens/MainView";
import { Onboarding } from "@/components/screens/onboarding/Onboarding";
import { Settings } from "@/components/screens/settings/Settings";
import { YoloIntroDialog } from "@/components/screens/YoloIntroDialog";
import { ArchivedDialog } from "@/components/screens/archived/ArchivedDialog";
import { EarlierDialog } from "@/components/screens/earlier/EarlierDialog";
import { CreateProjectDialog } from "@/components/screens/project/CreateProjectDialog";
import {
  ConfirmDeleteProjectDialog,
  EditProjectDialog,
} from "@/components/screens/project/EditProjectDialog";
import { ProjectsDialog } from "@/components/screens/project/ProjectsDialog";
import { bucketSession } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import {
  buildDemoPending,
  buildDemoTurns,
  makeDemoToast,
} from "@/stores/demo";
import {
  EMPTY_APPROVALS,
  EMPTY_DECISIONS,
  EMPTY_TURNS,
  useMessagesStore,
} from "@/stores/messages";
import { usePrefsStore } from "@/stores/prefs";
import { useRuntimeStore } from "@/stores/runtime";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore, type Screen } from "@/stores/ui";
import { hydrateApp } from "@/lib/hydrate";

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
  const screen = useUiStore((s) => s.screen);
  const setScreen = useUiStore((s) => s.setScreen);

  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const togglePalette = useUiStore((s) => s.togglePalette);

  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  // Sidebar live-status comes from `sessions` directly: messagesStore's
  // `fireSessionMirror` writes sidebar-visible fields (status,
  // pendingApprovalCount, hasPendingAskUser) onto each session row
  // whenever the conversation changes, but only generates a new
  // `sessions` array when those fields actually change. So a plain
  // selector with default strict-equality stays stable through
  // frequent non-sidebar updates like turn_progress streaming.
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const createSession = useSessionsStore((s) => s.createSession);
  // activateSession is the orchestrator — moved to sessionsStore in
  // B3 M5 so it sits next to active id ownership.
  const activateSession = useSessionsStore((s) => s.activateSession);
  const setActiveSession = useSessionsStore((s) => s.setActiveSession);
  const archiveSession = useSessionsStore((s) => s.archiveSession);
  const unarchiveSession = useSessionsStore((s) => s.unarchiveSession);
  const togglePinSession = useSessionsStore((s) => s.togglePinSession);
  const renameSession = useSessionsStore((s) => s.renameSession);
  const projects = useSessionsStore((s) => s.projects);
  const activeProjectFilter = useSessionsStore((s) => s.activeProjectFilter);
  const createProject = useSessionsStore((s) => s.createProject);
  const setActiveProjectFilter = useSessionsStore(
    (s) => s.setActiveProjectFilter,
  );
  const assignSessionToProject = useSessionsStore(
    (s) => s.assignSessionToProject,
  );
  const updateProject = useSessionsStore((s) => s.updateProject);
  const deleteProject = useSessionsStore((s) => s.deleteProject);
  const archiveSessionsBulk = useSessionsStore((s) => s.archiveSessionsBulk);
  const unarchiveSessionsBulk = useSessionsStore(
    (s) => s.unarchiveSessionsBulk,
  );
  const deleteSessionsPermanentlyBulk = useSessionsStore(
    (s) => s.deleteSessionsPermanentlyBulk,
  );
  const seedMockSessions = useSessionsStore((s) => s.seedMockSessions);
  const deleteSessionPermanently = useSessionsStore(
    (s) => s.deleteSessionPermanently,
  );
  const emptyArchive = useSessionsStore((s) => s.emptyArchive);
  const appendUserTurnExternal = useMessagesStore(
    (s) => s.appendUserTurnExternal,
  );
  const applyExternalSessionCreated = useSessionsStore(
    (s) => s.applyExternalSessionCreated,
  );
  const applyExternalSessionUpdated = useSessionsStore(
    (s) => s.applyExternalSessionUpdated,
  );
  const applyExternalProjectCreated = useSessionsStore(
    (s) => s.applyExternalProjectCreated,
  );
  const applyExternalProjectDeleted = useSessionsStore(
    (s) => s.applyExternalProjectDeleted,
  );
  // LLM / runtimeInfo / pet state now live in runtimeStore (M3a).
  // Subscribe to the active session's per-runtime entry so the
  // Composer pill + dropdown + Inspector tab re-render on changes.
  const activeRuntimeLLMs = useRuntimeStore((s) =>
    activeSessionId ? s.byId[activeSessionId]?.llms : undefined,
  );
  const activeRuntimeDisplayName = useRuntimeStore((s) =>
    activeSessionId ? s.byId[activeSessionId]?.llmDisplayName : undefined,
  );
  const cachedLLMs = useRuntimeStore((s) => s.cachedLLMs);
  const cachedLLMDisplayName = useRuntimeStore((s) => s.cachedLLMDisplayName);
  const llms = activeRuntimeLLMs ?? cachedLLMs;
  const llmDisplayName =
    activeRuntimeDisplayName ?? cachedLLMDisplayName ?? "";
  const selectLLMForNewSession = useRuntimeStore(
    (s) => s.selectLLMForNewSession,
  );
  const runtimeInfo = useRuntimeStore((s) => s.runtimeInfo);

  // Per-session conversation reads — activeSessionId comes from
  // sessionsStore (declared above), used by every selector below to
  // index into messagesStore.byId. EMPTY_* singletons keep React 19
  // strict-mode getSnapshot stable across renders.
  const approvalDecisions = useMessagesStore((s) =>
    activeSessionId
      ? (s.byId[activeSessionId]?.approvalDecisions ?? EMPTY_DECISIONS)
      : EMPTY_DECISIONS,
  );
  const recordApprovalDecision = useMessagesStore(
    (s) => s.recordApprovalDecision,
  );
  const approvalConfig = usePrefsStore((s) => s.approvalConfig);
  const setApprovalRequiredTools = usePrefsStore(
    (s) => s.setApprovalRequiredTools,
  );
  const removeAlwaysAllow = usePrefsStore((s) => s.removeAlwaysAllow);
  const yoloMode = usePrefsStore((s) => s.yoloMode);
  const setYoloMode = usePrefsStore((s) => s.setYoloMode);
  const yoloIntroSeen = usePrefsStore((s) => s.yoloIntroSeen);
  const acknowledgeYoloIntro = usePrefsStore((s) => s.acknowledgeYoloIntro);
  const conversationWidth = usePrefsStore((s) => s.conversationWidth);
  const setConversationWidth = usePrefsStore((s) => s.setConversationWidth);
  const petAttachedSessionId = useRuntimeStore(
    (s) => s.petAttachedSessionId,
  );
  const setPendingPetMigration = useUiStore((s) => s.setPendingPetMigration);

  const toasts = useUiStore((s) => s.toasts);
  const pushToast = useUiStore((s) => s.pushToast);
  const dismissToast = useUiStore((s) => s.dismissToast);

  const bridgeStatus = useRuntimeStore((s) =>
    activeSessionId ? (s.byId[activeSessionId]?.bridgeStatus ?? "idle") : "idle",
  );
  const shutdownAllBridges = useRuntimeStore((s) => s.shutdownAllBridges);
  const sendIPCCommand = useRuntimeStore((s) => s.sendIPCCommand);
  const setGAConfig = usePrefsStore((s) => s.setGAConfig);
  const gaConfig = usePrefsStore((s) => s.gaConfig);
  // Sidebar runtime indicator. Two states for V0.1 — see Sidebar.tsx
  // `RuntimeStatus` type for the rationale. The previous indicator
  // was a stub: defaulted to "healthy" and never wired up to a real
  // signal. Now reflects whether the user has configured GA paths
  // (which onboarding gates on, so post-onboarding this should
  // almost always be "ready").
  const runtimeStatus: "ready" | "unconfigured" =
    gaConfig.gaPath.trim() !== "" && gaConfig.python.trim() !== ""
      ? "ready"
      : "unconfigured";

  const storeTurns = useMessagesStore((s) =>
    activeSessionId ? (s.byId[activeSessionId]?.turns ?? EMPTY_TURNS) : EMPTY_TURNS,
  );
  const storePending = useMessagesStore((s) =>
    activeSessionId
      ? (s.byId[activeSessionId]?.pendingApprovals ?? EMPTY_APPROVALS)
      : EMPTY_APPROVALS,
  );
  const agentRunning = useMessagesStore((s) =>
    activeSessionId ? (s.byId[activeSessionId]?.agentRunning ?? false) : false,
  );
  const currentTurnIndex = useMessagesStore((s) =>
    activeSessionId ? (s.byId[activeSessionId]?.currentTurnIndex ?? null) : null,
  );
  const userSubmitTick = useMessagesStore((s) => s.userSubmitTick);
  const inFlightContent = useMessagesStore((s) =>
    activeSessionId ? (s.byId[activeSessionId]?.inFlightContent ?? "") : "",
  );
  const pendingAskUser = useMessagesStore((s) =>
    activeSessionId ? (s.byId[activeSessionId]?.pendingAskUser ?? null) : null,
  );
  const appendUserTurn = useMessagesStore((s) => s.appendUserTurn);
  const appendSideQuestionUserTurn = useMessagesStore(
    (s) => s.appendSideQuestionUserTurn,
  );
  const removePendingApproval = useMessagesStore(
    (s) => s.removePendingApproval,
  );

  // Drives the slice-store hydrate sequence in order: app version →
  // SQLite housekeeping → sessions hydrate → FTS backfill → prefs
  // hydrate → cached LLM seed → Onboarding routing OR warmup.
  useEffect(() => {
    void hydrateApp();
  }, []);

  // Session creation is **lazy** — we no longer auto-create on
  // landing in the empty screen. Earlier versions did, which
  // accumulated piles of "新对话" rows every time the user opened
  // and closed the app without ever typing. The Composer's
  // onSubmit handles createSession + activate at the moment the
  // user actually has intent. Sidebar's "New Chat" button still
  // creates an explicit session immediately, because that click
  // *is* the intent.

  // Global keyboard shortcuts: ⌘K palette, ⌘, settings, ⌘N new chat.
  // Esc handled by Radix Dialog (Settings) and cmdk (CommandPalette)
  // themselves. ⌘E (Toggle inspector) retired 2026-05-12 with the
  // Inspector panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        togglePalette();
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setScreen("empty");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, setSettingsOpen, setScreen]);

  // macOS menubar bridge: core/src/lib.rs installs a native menu
  // on Mac that emits `menu:<id>` events. We subscribe and route each
  // to the same store action the keyboard shortcut would trigger.
  //
  // On Win/Linux there's no menu installed → these events never fire,
  // the subscription sits idle (cheap, no overhead). Keeping it
  // unconditional avoids importing isMac into this file just for a
  // micro-optimization.
  //
  // No double-fire with the keydown handler above: AppKit consumes
  // menu accelerators (Cmd+, / Cmd+N) before the webview sees them
  // when a menu has them bound, so the keydown listener doesn't run
  // on Mac for accelerator-bound keys. Win has no menu so keydown
  // remains the only path there.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const handlers: Array<[string, () => void]> = [
      ["menu:settings", () => setSettingsOpen(true)],
      ["menu:new_chat", () => setScreen("empty")],
      ["menu:width_compact", () => {
        void setConversationWidth("compact");
      }],
      ["menu:width_wide", () => {
        void setConversationWidth("wide");
      }],
    ];

    void (async () => {
      for (const [event, handler] of handlers) {
        const fn = await listen(event, handler);
        if (cancelled) {
          fn();
        } else {
          unlisteners.push(fn);
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [setSettingsOpen, setScreen, setConversationWidth]);

  // `user-message-persisted` listener: Rust core's socket_listener emits
  // this Tauri event whenever a user message is persisted via the socket
  // transport (CLI `galley session send`, supervisor agents). The GUI's
  // own Composer path skips this — it mutates the store synchronously
  // and emitting here would double-render.
  //
  // Without this listener, CLI-origin messages render the agent reply
  // (because bridge events still flow through `runner-event`) but the
  // user question itself never appears — the row exists in DB but the
  // in-memory `turns` array is the source of truth for rendering.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const fn = await listen<{
        sessionId: string;
        message: { content: string };
      }>("user-message-persisted", (e) => {
        const { sessionId, message } = e.payload;
        appendUserTurnExternal(sessionId, message.content);
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appendUserTurnExternal]);

  // B4 M1 session-write listeners. Socket handlers in
  // core/src/socket_listener.rs emit these whenever a CLI / supervisor
  // command persists a session row; the GUI mirrors the row into its
  // in-memory store so the sidebar updates without polling. The payload
  // shape mirrors Rust's `SessionExternalPayload` — `session` is the
  // freshly-read SessionBrief, `via` is the originating socket command.
  //
  // For `session.new`, the corresponding user message lands via the
  // existing `user-message-persisted` event (emitted in the same
  // handler) — kept as two events so a future supervisor agent can
  // listen for one without the other.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    type ExternalPayload = {
      session: Parameters<typeof applyExternalSessionCreated>[0];
      via: string;
    };
    void (async () => {
      const subscribe = async (
        event: string,
        handler: (p: ExternalPayload) => void,
      ) => {
        const fn = await listen<ExternalPayload>(event, (e) =>
          handler(e.payload),
        );
        if (cancelled) {
          fn();
        } else {
          unlisteners.push(fn);
        }
      };
      await subscribe("session-created-external", (p) =>
        applyExternalSessionCreated(p.session),
      );
      await subscribe("session-archived-external", (p) =>
        applyExternalSessionUpdated(p.session),
      );
      await subscribe("session-unarchived-external", (p) =>
        applyExternalSessionUpdated(p.session),
      );
      await subscribe("session-moved-external", (p) =>
        applyExternalSessionUpdated(p.session),
      );
      // M1.3 llm.set rides this channel so the Composer pill picks up
      // a CLI / supervisor LLM switch without a list_sessions refresh.
      await subscribe("session-updated-external", (p) =>
        applyExternalSessionUpdated(p.session),
      );
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [applyExternalSessionCreated, applyExternalSessionUpdated]);

  // B4 M1.3 project-write listeners. Same pattern as the session ones
  // above but with a different payload shape (`project` not `session`),
  // and `project-deleted-external` carries the FK SET NULL detach
  // metadata so we don't have to re-query the list.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const createdFn = await listen<{
        project: Parameters<typeof applyExternalProjectCreated>[0];
        via: string;
      }>("project-created-external", (e) => {
        applyExternalProjectCreated(e.payload.project);
      });
      if (cancelled) createdFn();
      else unlisteners.push(createdFn);

      const deletedFn = await listen<{
        projectId: string;
        detachedSessions: number;
        detachedSessionIds: string[];
      }>("project-deleted-external", (e) => {
        applyExternalProjectDeleted(e.payload.projectId);
      });
      if (cancelled) deletedFn();
      else unlisteners.push(deletedFn);
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [applyExternalProjectCreated, applyExternalProjectDeleted]);

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
  // turn.
  //
  // We also short-circuit demo whenever an active session exists at
  // all — even with empty turns. Activating a real session (mock
  // fixture, freshly-created untyped session, or one whose bridge
  // history hasn't finished replaying) used to surface the demo
  // conversation because storeTurns was still []. The demo is only
  // meaningful as a layout placeholder when there's literally no
  // session selected (DevScreenToggle visual review of main view).
  const conversationStarted =
    activeSessionId != null || storeTurns.length > 0;
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
  // still live in SQLite — the Archived dialog (sidebar footer)
  // surfaces them for Restore / Delete / Empty all.
  const visibleSessions = useMemo(
    () => sessions.filter((s) => s.status !== "archived"),
    [sessions],
  );
  const archivedCount = sessions.length - visibleSessions.length;
  const effectiveActiveId = screen === "main" ? activeSessionId : undefined;
  const activeSession = visibleSessions.find((s) => s.id === effectiveActiveId);

  // Archived dialog open state — local UI state, no need to live in
  // the global store. Persisting across reloads would be confusing
  // (user expects modals to be closed on app re-open).
  const [archivedOpen, setArchivedOpen] = useState(false);
  // EarlierDialog: opens when the user clicks the collapsed
  // "Earlier (N)" row in the sidebar. Same local-state rationale as
  // archivedOpen.
  const [earlierOpen, setEarlierOpen] = useState(false);
  const earlierSessions = useMemo(
    () =>
      visibleSessions.filter((s) => bucketSession(s) === "earlier"),
    [visibleSessions],
  );
  // CreateProjectDialog open state. Local for the same reason as the
  // other dialogs above — modal visibility shouldn't persist across
  // launches.
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  // ProjectsDialog: opens when the sidebar's "查看全部 (N)" link is
  // clicked at 9+ projects. Sibling to EarlierDialog in role.
  const [projectsBrowserOpen, setProjectsBrowserOpen] = useState(false);
  // EditProjectDialog: stores the full project being edited so the
  // dialog can reset its inputs from the row that triggered it.
  // `null` = closed.
  const [editingProjectId, setEditingProjectId] = useState<string | null>(
    null,
  );
  const editingProject = useMemo(
    () => projects.find((p) => p.id === editingProjectId) ?? null,
    [projects, editingProjectId],
  );
  // ConfirmDeleteProject dialog — opens from inside EditProject when
  // the user clicks "删除 Project". Same null-or-project pattern.
  // Health Check revisit flow (Settings → Re-run Health Check):
  //   - true → Onboarding renders in "revisit" mode (skips Welcome /
  //     Attach, jumps to Health step, swaps button labels)
  //   - previousScreen remembers where the user was before triggering
  //     the revisit, so onComplete / onCancel can return them there +
  //     re-open Settings (the action itself was triggered from inside
  //     the Settings dialog, so "where I was" implicitly includes
  //     "with Settings open").
  const [healthCheckRevisit, setHealthCheckRevisit] = useState(false);
  const [revisitReturnScreen, setRevisitReturnScreen] =
    useState<import("@/stores/ui").Screen>("empty");

  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const deletingProject = useMemo(
    () => projects.find((p) => p.id === deletingProjectId) ?? null,
    [projects, deletingProjectId],
  );

  // Onboarding takeover: no AppShell, no overlays besides the dev
  // toggle.
  if (screen === "onboarding") {
    return (
      <>
        <Onboarding
          mode={healthCheckRevisit ? "revisit" : "fresh"}
          initialPath={healthCheckRevisit ? gaConfig.gaPath : undefined}
          onComplete={(gaPath, pythonAlias) => {
            // Persist the validated path + the probed Python alias so
            // subsequent bridge spawns use the right interpreter, not
            // the demo fallback (system python3 in a packaged build
            // has no GA deps — silent crash).
            const partial: { gaPath: string; python?: string } = { gaPath };
            if (pythonAlias) partial.python = pythonAlias;
            void setGAConfig(partial);
            if (healthCheckRevisit) {
              // Settings → "跑一次 Health Check" round-trip: return the
              // user to the screen they came from + re-open the
              // Settings dialog where they clicked.
              setHealthCheckRevisit(false);
              setScreen(revisitReturnScreen);
              setSettingsOpen(true);
            } else {
              setScreen("empty");
            }
          }}
          onCancel={() => {
            // Revisit-only escape hatch. setGAConfig is intentionally
            // skipped — the user bailed without committing to a new
            // probe result, so we keep whatever was saved before.
            setHealthCheckRevisit(false);
            setScreen(revisitReturnScreen);
            setSettingsOpen(true);
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
            conversationWidth={conversationWidth}
            onToggleConversationWidth={() => {
              void setConversationWidth(
                conversationWidth === "wide" ? "compact" : "wide",
              );
            }}
            onReinjectTools={() => {
              // Reinject targets the currently active session — that's
              // the conversation the user is reading when they notice
              // tool drift. No-op if no active session (button is
              // available but does nothing rather than throwing).
              if (!activeSessionId) return;
              if (bridgeStatus !== "connected") return;
              void sendIPCCommand(activeSessionId, {
                kind: "reinject_tools",
              });
            }}
            onTogglePet={() => {
              // Three cases (see devlog 2026-05-14 pet UX overhaul):
              //   1. Active session HOLDS the pet → detach (close).
              //   2. Pet on another session → implicit migrate:
              //      detach old + stash target; the pet_detached IPC
              //      handler fires the follow-up attach once the
              //      port is released.
              //   3. No pet anywhere → attach to active.
              // The sidebar Cat badge tells the user where the pet
              // currently lives, so the menu's "桌面宠物" always
              // reads as "I want it here" without surprise.
              if (!activeSessionId) return;
              if (petAttachedSessionId === activeSessionId) {
                void sendIPCCommand(activeSessionId, {
                  kind: "detach_pet",
                });
                return;
              }
              if (bridgeStatus !== "connected") return;
              if (petAttachedSessionId) {
                setPendingPetMigration(activeSessionId);
                void sendIPCCommand(petAttachedSessionId, {
                  kind: "detach_pet",
                });
                return;
              }
              void sendIPCCommand(activeSessionId, {
                kind: "attach_pet",
                port: 41983,
              });
            }}
            currentSessionHasPet={
              !!activeSessionId && petAttachedSessionId === activeSessionId
            }
            onRenameSession={(newTitle) => {
              if (!activeSessionId) return;
              renameSession(activeSessionId, newTitle);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        }
        sidebar={
          <Sidebar
            runtimeStatus={runtimeStatus}
            onOpenRuntimeSettings={() => setSettingsOpen(true)}
            sessions={visibleSessions}
            activeId={effectiveActiveId}
            onNewChat={() => {
              // Lazy: New Chat just clears the active selection and
              // shows the empty composer. No session row is created
              // until the user actually submits — otherwise every
              // click on this button piles up another "新对话"
              // placeholder in the sidebar. submitOnEmpty does the
              // createSession + activateSession when the user
              // commits to a first message.
              setActiveSession(undefined);
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
            onRenameSession={(id, newTitle) => renameSession(id, newTitle)}
            onTogglePinSession={(id) => togglePinSession(id)}
            onOpenArchived={() => setArchivedOpen(true)}
            onOpenEarlier={() => setEarlierOpen(true)}
            archivedCount={archivedCount}
            onSearch={() => setPaletteOpen(true)}
            projects={projects}
            activeProjectFilter={activeProjectFilter}
            onNewProject={() => setCreateProjectOpen(true)}
            onSelectProject={(id) => setActiveProjectFilter(id)}
            onClearProjectFilter={() => setActiveProjectFilter(undefined)}
            onAssignSessionToProject={(sessionId, projectId) => {
              void assignSessionToProject(sessionId, projectId);
            }}
            onTogglePinProject={(id) => {
              const p = projects.find((x) => x.id === id);
              if (p) void updateProject(id, { pinned: !p.pinned });
            }}
            onEditProject={(id) => setEditingProjectId(id)}
            onDeleteProject={(id) => setDeletingProjectId(id)}
            onOpenProjectsBrowser={() => setProjectsBrowserOpen(true)}
            petAttachedSessionId={petAttachedSessionId}
          />
        }
        main={
          screen === "empty" ? (
            <EmptyState
              llmDisplayName={llmDisplayName}
              conversationWidth={conversationWidth}
              llms={llms}
              onSelectLLM={(idx) => {
                // EmptyState always configures the *next* new
                // session: stash pendingLLMIndex + flip the
                // top-level llms projection so the Composer pill
                // reflects the pick. activateSession consumes
                // pendingLLMIndex when submitOnEmpty creates and
                // spawns the fresh session.
                selectLLMForNewSession(idx);
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
                  activeProjectFilter,
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
                  activeProjectFilter,
                );
              }}
            />
          ) : (
            <MainView
              turns={turns}
              llmDisplayName={llmDisplayName}
              projectName={
                activeSession?.projectId
                  ? projects.find((p) => p.id === activeSession.projectId)?.name
                  : undefined
              }
              llms={llms}
              onSelectLLM={(idx) => {
                // Send set_llm whenever a bridge subprocess exists
                // (spawning or connected). The pre-seed makes the
                // picker display real models from t=0 (before ready
                // fires), so gating clicks on "connected" only would
                // silently drop clicks during the ~430ms cold-spawn
                // window — popover closes, pill doesn't change, user
                // perceives "click failed". sendIPCCommand internally
                // no-ops if `_bridgeClients` has no entry, so idle /
                // closed / error states still drop safely.
                if (!activeSessionId) return;
                if (
                  bridgeStatus === "connected" ||
                  bridgeStatus === "spawning"
                ) {
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
                  // `/btw` is a side question (interruption-free,
                  // not a main-agent turn). Route to the transient
                  // user-turn path so it doesn't disturb the main
                  // agent's running state — bridge intercepts the
                  // user_message command and runs the btw worker
                  // independently of the task queue.
                  const trimmed = t.trimStart();
                  if (trimmed === "/btw" || trimmed.startsWith("/btw ")) {
                    appendSideQuestionUserTurn(activeSessionId, t);
                    sendIPCCommand(activeSessionId, {
                      kind: "user_message",
                      text: t,
                      images: [],
                    });
                    return;
                  }
                  // Snapshot pendingAskUser **before** appendUserTurn
                  // clears it — we need to know which IPC command to
                  // send. ask_user_response and user_message both
                  // ultimately call agent.put_task on the bridge side
                  // (same agent_runner_loop kickoff), but keeping
                  // them distinct preserves audit-trail clarity:
                  // "this user message was a reply to a specific
                  // question" vs "this was a fresh prompt".
                  const wasAskUser = pendingAskUser !== null;
                  appendUserTurn(activeSessionId, t);
                  if (wasAskUser) {
                    sendIPCCommand(activeSessionId, {
                      kind: "ask_user_response",
                      text: t,
                    });
                  } else {
                    sendIPCCommand(activeSessionId, {
                      kind: "user_message",
                      text: t,
                      images: [],
                    });
                  }
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
              pendingAskUser={pendingAskUser}
              conversationWidth={conversationWidth}
              activeSessionId={activeSessionId}
            />
          )
        }
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={visibleSessions}
        llms={llms}
        onNewChat={() => setScreen("empty")}
        onNewProject={() => setCreateProjectOpen(true)}
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
          // Same relaxed gate as MainView's onSelectLLM — allow during
          // spawning so users don't get silent drops in the cold-start
          // window. sendIPCCommand internally no-ops if no live bridge.
          if (
            bridgeStatus === "connected" ||
            bridgeStatus === "spawning"
          ) {
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
        projectCount={projects.length}
        yoloMode={yoloMode}
        useExternalPython={gaConfig.useExternalPython}
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
        onCommitGAPath={async (path) => {
          // Manual-typed GA path from Settings → Runtime. The
          // SettingsRuntime field has already validated and refuses to
          // call this on `not-found`; we trust it here. setGAConfig
          // shows the same "重启 Galley 才能生效" toast as the picker
          // flow, keeping both entry points symmetric.
          await setGAConfig({ gaPath: path });
        }}
        onToggleExternalPython={(useExternal) => {
          // v0.1.1: persist the bundled-vs-external choice. Like
          // gaPath, takes effect on next bridge spawn (existing live
          // sessions keep their current Python). setGAConfig shows
          // the same "重启 Galley" toast.
          void setGAConfig({ useExternalPython: useExternal });
        }}
        // Bridge Python picker intentionally not wired — V0.1 relies
        // on the python probe to pick the interpreter; advanced users
        // edit prefs / capabilities by hand. Settings just shows the
        // resolved path.
        //
        // "跑一次 Health Check" routes back through Onboarding's
        // StepHealth in revisit mode (skips Welcome / Attach). One
        // canonical health-check UX instead of a divergent inline
        // copy in Settings — see Settings-Health-Check devlog
        // 2026-05-15.
        onReRunHealthCheck={() => {
          setRevisitReturnScreen(screen);
          setSettingsOpen(false);
          setHealthCheckRevisit(true);
          setScreen("onboarding");
        }}
      />

      <ArchivedDialog
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        sessions={sessions}
        onRestore={(id) => unarchiveSession(id)}
        onDeletePermanently={(id) => deleteSessionPermanently(id)}
        onEmptyAll={() => emptyArchive()}
        onRestoreBulk={(ids) => unarchiveSessionsBulk(ids)}
        onDeletePermanentlyBulk={(ids) => deleteSessionsPermanentlyBulk(ids)}
      />

      <EarlierDialog
        open={earlierOpen}
        onOpenChange={setEarlierOpen}
        sessions={earlierSessions}
        onSelectSession={(id) => {
          void activateSession(id);
          setScreen("main");
        }}
        onArchiveSession={(id) => archiveSession(id)}
        onTogglePinSession={(id) => togglePinSession(id)}
        onArchiveSessionsBulk={(ids) => archiveSessionsBulk(ids)}
      />

      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        onCreate={async (input) => {
          // Create + immediately enter filter mode for the new
          // project. Feels right for the "I just made this drawer,
          // now show me it" instinct; the empty-project view is the
          // implicit "drop sessions in here" prompt.
          const created = await createProject(input);
          setActiveProjectFilter(created.id);
        }}
      />

      <EditProjectDialog
        project={editingProject}
        onClose={() => setEditingProjectId(null)}
        onSave={async (id, partial) => {
          await updateProject(id, partial);
        }}
        onRequestDelete={(p) => {
          // Hand off to ConfirmDeleteProjectDialog while keeping
          // the Edit dialog state — when the user cancels the
          // confirm, they're back in Edit naturally. On confirm,
          // both close together.
          setDeletingProjectId(p.id);
        }}
      />

      <ConfirmDeleteProjectDialog
        project={deletingProject}
        onCancel={() => setDeletingProjectId(null)}
        onConfirm={async () => {
          if (!deletingProject) return;
          await deleteProject(deletingProject.id);
          setDeletingProjectId(null);
          setEditingProjectId(null);
        }}
      />

      <ProjectsDialog
        open={projectsBrowserOpen}
        onOpenChange={setProjectsBrowserOpen}
        projects={projects}
        sessions={sessions}
        onSelectProject={(id) => {
          setActiveProjectFilter(id);
        }}
        onTogglePinProject={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p) void updateProject(id, { pinned: !p.pinned });
        }}
        onEditProject={(id) => setEditingProjectId(id)}
        onDeleteProject={(id) => setDeletingProjectId(id)}
        onNewProject={() => setCreateProjectOpen(true)}
      />

      <ToastHost
        toasts={toasts}
        onDismiss={dismissToast}
        onSwitchLLM={() => console.info("[toast] switch llm action")}
        onOpenMyKey={() => console.info("[toast] open mykey.py")}
        onOpenGADocs={() => console.info("[toast] open GA docs")}
        onRetry={() => console.info("[toast] retry")}
      />

      <YoloIntroDialog
        open={!yoloIntroSeen}
        onAcknowledge={(revertToApproval) => {
          void acknowledgeYoloIntro(revertToApproval);
        }}
      />

      {import.meta.env.DEV && (
        <DevScreenToggle
          screen={screen}
          setScreen={setScreen}
          onTriggerToast={() => pushToast(makeDemoToast())}
          onSeedMockSessions={() => {
            void seedMockSessions();
          }}
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
  createSession: (projectId?: string) => string,
  activateSession: (id: string) => Promise<void>,
  appendUserTurn: (sessionId: string, text: string) => void,
  sendIPCCommand: (
    sessionId: string,
    cmd: { kind: "user_message"; text: string; images?: string[] },
  ) => Promise<void>,
  setScreen: (s: import("@/stores/ui").Screen) => void,
  inheritProjectId?: string,
): Promise<void> {
  let id = existingId;
  if (!id) {
    // Inherit project assignment when the EmptyState composer fires
    // while a project filter is active. New chat instantly belongs
    // to the same drawer the user is looking at.
    id = createSession(inheritProjectId);
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
  onSeedMockSessions,
  bridgeStatus,
  onSpawnBridge,
  onShutdownBridge,
}: {
  screen: Screen;
  setScreen: (s: Screen) => void;
  onTriggerToast?: () => void;
  onSeedMockSessions?: () => void;
  bridgeStatus?: import("@/stores/runtime").BridgeStatus;
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
      {onSeedMockSessions && (
        <DevSegment>
          <DevButton onClick={onSeedMockSessions}>+ mock</DevButton>
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
