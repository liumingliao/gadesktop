import { useEffect, useMemo, useState } from "react";

import { ToastHost } from "@/components/error-card/ToastHost";
import { Inspector } from "@/components/inspector/Inspector";
import { AppShell } from "@/components/layout/AppShell";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { CommandPalette } from "@/components/overlay/CommandPalette";
import { EmptyState } from "@/components/screens/EmptyState";
import { MainView } from "@/components/screens/MainView";
import { Onboarding } from "@/components/screens/onboarding/Onboarding";
import {
  Settings,
  type ApprovalConfig,
} from "@/components/screens/settings/Settings";
import { cn } from "@/lib/utils";
import { type AppError, makeAppError } from "@/types/app-error";
import type {
  AgentTurn,
  ConversationToolEvent,
  PendingApproval,
  Turn,
} from "@/types/conversation";
import type {
  ApprovalRecord,
  InspectorSelection,
  RuntimeInfo,
} from "@/types/inspector";
import type { ApprovalDecision } from "@/types/ipc";
import type { Session } from "@/types/session";

/**
 * V0.1 Stage 2 #3 — App entry.
 *
 * Until the Zustand store + IPC plumbing land (#9 / #10), App owns a
 * minimal demo state so we can exercise the Main View layout, the
 * approval flow, and Sidebar full-mode side by side.
 *
 * A floating dev toggle (top-right, only when import.meta.env.DEV) lets
 * us flip between Empty State and Main View. It disappears in the
 * production bundle.
 */
function App() {
  const [screen, setScreen] = useState<Screen>("empty");
  const [approvalDecisions, setApprovalDecisions] = useState<
    Record<string, ApprovalDecision>
  >({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [toasts, setToasts] = useState<AppError[]>([]);
  const [approvalConfig, setApprovalConfig] =
    useState<ApprovalConfig>(DEMO_APPROVAL_CONFIG);
  const llmDisplayName = "Claude Sonnet 4.5";

  // Global keyboard shortcuts: ⌘K open palette, ⌘, open settings,
  // ⌘E toggle inspector, ⌘N new chat. Esc is handled by Radix Dialog
  // (Settings) and cmdk (CommandPalette) themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        setInspectorVisible((v) => !v);
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setScreen("empty");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dismissToast = (id: string) =>
    setToasts((ts) => ts.filter((t) => t.id !== id));
  const pushToast = (e: AppError) =>
    setToasts((ts) => [e, ...ts.filter((t) => t.id !== e.id)]);

  // Hooks must run unconditionally (Rules of Hooks). Compute derived
  // demo data up front; the onboarding branch below ignores it.
  const turns = useMemo(
    () => buildDemoTurns(approvalDecisions),
    [approvalDecisions],
  );
  const pendingApprovals = useMemo(
    () => buildDemoPending(approvalDecisions),
    [approvalDecisions],
  );
  const isRunning = approvalDecisions["appr_demo1"] === "allow_once";

  const sessions: Session[] = screen === "empty" ? [] : DEMO_SESSIONS;
  const activeSessionId = screen === "main" ? "s-today-1" : undefined;
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // Onboarding is a takeover screen: no AppShell, no Sidebar/Inspector.
  // Renders early because everything below is shell-bound.
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

  const handleApprove = (approvalId: string, decision: ApprovalDecision) => {
    setApprovalDecisions((prev) => ({ ...prev, [approvalId]: decision }));
  };

  return (
    <>
      <AppShell
        topBar={<TopBar sessionTitle={activeSession?.title} />}
        sidebar={
          <Sidebar
            sessions={sessions}
            activeId={activeSessionId}
            onNewChat={() => setScreen("empty")}
          />
        }
        main={
          screen === "empty" ? (
            <EmptyState
              llmDisplayName={llmDisplayName}
              onSubmit={(t) => {
                console.info("[empty] submit:", t);
                setScreen("main");
              }}
              onQuickPrompt={(p) => {
                console.info("[empty] quick-prompt:", p);
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
              onApprove={handleApprove}
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
              approvalRecords={DEMO_APPROVAL_RECORDS}
              runtimeInfo={DEMO_RUNTIME_INFO}
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
        sessions={sessions}
        llms={DEMO_LLMS}
        onNewChat={() => setScreen("empty")}
        onOpenSession={(id) => {
          console.info("[palette] open session:", id);
          setScreen("main");
        }}
        onSwitchLLM={(idx) =>
          console.info("[palette] switch llm to index:", idx)
        }
        onReRunHealthCheck={() => console.info("[palette] re-run health check")}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleInspector={() => setInspectorVisible((v) => !v)}
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
        runtimeInfo={DEMO_RUNTIME_INFO}
        approval={approvalConfig}
        onChangeRequiredTools={(tools) =>
          setApprovalConfig((c) => ({ ...c, requiredTools: tools }))
        }
        onRemoveAlwaysAllow={(scope, tool) => {
          setApprovalConfig((c) =>
            scope === "project"
              ? {
                  ...c,
                  alwaysAllowProject: c.alwaysAllowProject.filter(
                    (t) => t !== tool,
                  ),
                }
              : {
                  ...c,
                  alwaysAllowGlobal: c.alwaysAllowGlobal.filter(
                    (t) => t !== tool,
                  ),
                },
          );
          console.info(`[settings] removed ${scope} rule:`, tool);
        }}
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

type Screen = "onboarding" | "empty" | "main";

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

// ---------------- demo data ----------------
//
// All hardcoded for #3 / #4. Replaced by store-derived data in #9.

/**
 * Pick the most recent tool from the most recent agent turn as the
 * Inspector's selection, so opening the Details tab actually shows
 * something. In real life this comes from a click on a callout.
 */
function demoSelection(turns: Turn[]): InspectorSelection {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "agent" && t.tools.length > 0) {
      return {
        type: "tool",
        tool: t.tools[t.tools.length - 1],
        turnIndex: i,
      };
    }
  }
  return { type: "none" };
}

const DEMO_APPROVAL_RECORDS: ApprovalRecord[] = [
  {
    approvalId: "appr_demo_t1",
    toolName: "file_read",
    target: "desktop/src/db/migrations/",
    decision: "auto_allowed",
    decidedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  },
  {
    approvalId: "appr_demo_t2",
    toolName: "file_read",
    target: "docs/PRD.md",
    decision: "auto_allowed",
    decidedAt: new Date(Date.now() - 90_000).toISOString(),
  },
];

const DEMO_RUNTIME_INFO: RuntimeInfo = {
  gaPath: "~/Documents/GenericAgent",
  pythonVersion: "3.11.9 (system)",
  llmDisplayName: "Claude Sonnet 4.5",
  bridgePid: 48213,
  cwd: "~/Code/ga-workbench",
  gaBaseline: "6a3eecc07eb7dbdde823c0095842c829925e3e64",
  workbenchVersion: "0.1.0",
  healthChecks: [
    {
      name: "GA path",
      detail: "~/Documents/GenericAgent",
      state: "success",
    },
    {
      name: "Python 可用",
      detail: "Python 3.11.9 (system)",
      state: "success",
    },
    {
      name: "agentmain.py 可 import",
      detail: "GA baseline 6a3eecc · OK",
      state: "success",
    },
    {
      name: "mykey.py 存在",
      detail: "5 LLM 配置",
      state: "success",
    },
    {
      name: "至少一个 LLM 配置可解析",
      detail: "Claude / OAI / Gemini · parse OK",
      state: "success",
    },
  ],
};

const DEMO_LLMS = [
  { index: 0, displayName: "GLM 5.1", isCurrent: false },
  { index: 1, displayName: "Claude Sonnet 4.5", isCurrent: true },
  { index: 2, displayName: "GPT 4o", isCurrent: false },
  { index: 3, displayName: "Gemini 2.5 Pro", isCurrent: false },
];

const DEMO_APPROVAL_CONFIG: ApprovalConfig = {
  requiredTools: [
    "code_run",
    "file_write",
    "file_patch",
    "start_long_term_update",
  ],
  alwaysAllowProject: ["file_read", "web_scan"],
  alwaysAllowGlobal: [],
};

// Cycle demo toasts on each "+ toast" click so we can preview each
// hint variant without code-toggling. Order: check_llm_config →
// network → quota_exceeded → plain bridge error.
let demoToastCounter = 0;
const DEMO_TOAST_VARIANTS: Array<
  Pick<AppError, "category" | "severity" | "message" | "hint" | "retryable">
> = [
  {
    category: "business",
    severity: "error",
    message: "Authentication failed: invalid api_key",
    hint: "check_llm_config",
    retryable: true,
  },
  {
    category: "bridge",
    severity: "error",
    message: "Connection refused by api.anthropic.com after 30s",
    hint: "network",
    retryable: true,
  },
  {
    category: "business",
    severity: "warning",
    message: "Rate limit exceeded for current LLM",
    hint: "quota_exceeded",
    retryable: false,
  },
  {
    category: "bridge",
    severity: "error",
    message: "IPC protocol mismatch: bridge expects 0.1, got 0.0.9",
    hint: null,
    retryable: false,
  },
];

function makeDemoToast(): AppError {
  const variant =
    DEMO_TOAST_VARIANTS[demoToastCounter % DEMO_TOAST_VARIANTS.length];
  demoToastCounter += 1;
  return makeAppError({
    ...variant,
    context: "demo",
    traceback:
      "Traceback (most recent call last):\n" +
      '  File "/path/to/bridge/handlers.py", line 142, in dispatch\n' +
      '    raise BridgeError("...")\n',
  });
}

const DEMO_USER_PROMPT =
  "帮我把 sessions 表的 SQL schema 写到 desktop/src/db/migrations/001_init.sql。" +
  "需要支持 PRD §8.1 里的所有字段（id, projectId, title, status, currentTool, " +
  "pendingApprovalCount, errorCount, lastActivityAt, createdAt, updatedAt, pid, " +
  "cwd），并加上必要的索引。";

const DEMO_FINAL_ANSWER_ALLOWED =
  "已为你生成 desktop/src/db/migrations/001_init.sql，包含 projects / sessions 两张表的初始 schema。下一步建议跑 pnpm db:migrate 验证 schema 可用。";

const DEMO_FINAL_ANSWER_DENIED =
  "收到 denied 信号。已切换方案 — 把 schema 输出为 markdown 放在回复里，由你手动落盘。";

// New-file content used by the file_patch demo so the split diff has
// real lines to render. Mirrors the prototype's MOCK_PATCH but as
// raw text (PatchView line-diffs it itself).
const DEMO_PATCH_NEW_CONTENT = `-- 001_init.sql · GA Workbench v0.1
-- Created by GA agent · 2026-05-08

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_path   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
    ('idle','running','waiting_approval','error','completed','archived')),
  last_activity_at  TEXT NOT NULL
);
`;

function buildDemoTurns(decisions: Record<string, ApprovalDecision>): Turn[] {
  const decision = decisions["appr_demo1"];

  const t1: ConversationToolEvent = {
    id: "t1",
    name: "file_read",
    status: "success-historical",
    summary: "读取 desktop/src/db/migrations/",
    elapsed: "120ms",
    args: { path: "desktop/src/db/migrations/" },
  };
  const t2: ConversationToolEvent = {
    id: "t2",
    name: "file_read",
    status: "success-historical",
    summary: "查看 docs/PRD.md §8",
    elapsed: "80ms",
    args: { path: "docs/PRD.md", start_line: 180, end_line: 230 },
  };

  let t3: ConversationToolEvent;
  if (!decision) {
    t3 = {
      id: "t3",
      name: "file_patch",
      status: "waiting_approval",
      summary: "新建 001_init.sql · 创建 sessions / projects 两张表与基础约束",
      elapsed: "pending · 14s",
      riskLevel: "medium",
      approvalId: "appr_demo1",
      args: {
        path: "desktop/src/db/migrations/001_init.sql",
        old_content: "",
        new_content: DEMO_PATCH_NEW_CONTENT,
      },
    };
  } else if (decision === "deny") {
    t3 = {
      id: "t3",
      name: "file_patch",
      status: "denied",
      summary: "已拒绝 · agent 收到 denied 信号",
      elapsed: "—",
      args: {
        path: "desktop/src/db/migrations/001_init.sql",
      },
    };
  } else {
    t3 = {
      id: "t3",
      name: "file_patch",
      status: "success-current",
      summary: "已写入 desktop/src/db/migrations/001_init.sql",
      elapsed: "84ms",
      args: {
        path: "desktop/src/db/migrations/001_init.sql",
      },
      resultPreview: "[OK] 18 lines written.",
    };
  }

  const finalAnswer = !decision
    ? null
    : decision === "deny"
      ? DEMO_FINAL_ANSWER_DENIED
      : DEMO_FINAL_ANSWER_ALLOWED;

  const agent: AgentTurn = {
    role: "agent",
    thinking:
      "先 file_read 看现有 migrations 目录结构，再 file_patch 加新文件。需要审批。",
    tools: [t1, t2, t3],
    finalAnswer,
  };

  return [{ role: "user", content: DEMO_USER_PROMPT }, agent];
}

function buildDemoPending(
  decisions: Record<string, ApprovalDecision>,
): PendingApproval[] {
  if (decisions["appr_demo1"]) return [];
  return [
    {
      approvalId: "appr_demo1",
      toolName: "file_patch",
      target: "001_init.sql",
      riskLevel: "medium",
    },
  ];
}

const NOW_ISO = new Date().toISOString();

const DEMO_SESSIONS: Session[] = [
  {
    id: "s-today-1",
    title: "Workbench 桌面端 SQLite schema",
    status: "waiting_approval",
    summary: "Turn 12 · 等待 file_patch 审批",
    pendingApprovalCount: 1,
    errorCount: 0,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  {
    id: "s-today-2",
    title: "论文摘要：multi-agent retrieval",
    status: "running",
    summary: "Turn 4 · 抓取 arxiv 4 篇相关论文",
    pendingApprovalCount: 0,
    errorCount: 0,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  {
    id: "s-today-3",
    title: "整理周会笔记",
    status: "completed",
    summary: "Turn 3 · 已生成会议要点",
    pendingApprovalCount: 0,
    errorCount: 0,
    lastActivityAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  {
    id: "s-week-1",
    title: "修复 bridge 子进程 zombie",
    status: "error",
    summary: "Turn 5 · subprocess.kill() 抛 ProcessLookupError",
    pendingApprovalCount: 0,
    errorCount: 1,
    lastActivityAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  {
    id: "s-week-2",
    title: "shadcn 组件库选型对比",
    status: "completed",
    summary: "Turn 6 · 推荐 shadcn + Radix",
    pendingApprovalCount: 0,
    errorCount: 0,
    lastActivityAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
  {
    id: "s-earlier-1",
    title: "Tauri vs Electron 调研",
    status: "archived",
    summary: "Turn 11 · 选定 Tauri v2",
    pendingApprovalCount: 0,
    errorCount: 0,
    lastActivityAt: new Date(Date.now() - 14 * 86400_000).toISOString(),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  },
];
