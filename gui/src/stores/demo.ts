/**
 * Demo data for V0.1 (#3-#8). All hand-rolled fixtures used by the
 * Zustand store's initial state plus a couple of derivation helpers
 * that translate approval decisions into a turn list / pending list
 * for the in-memory demo flow.
 *
 * #9 starts replacing this file: SQLite persistence + bridge IPC
 * events feed real state, and these helpers go away.
 */

import type { ApprovalConfig } from "@/components/screens/settings/Settings";
import { isWindows } from "@/lib/platform";
import { type AppError, makeAppError } from "@/types/app-error";
import type {
  AgentTurn,
  ConversationToolEvent,
  PendingApproval,
  Turn,
} from "@/types/conversation";
import type { RuntimeInfo } from "@/types/inspector";
import type { ApprovalDecision } from "@/types/ipc";
import type { Session } from "@/types/session";

// ---------------- Static fixtures ----------------

/**
 * Hard-coded path + python + bridge cwd used by the multi-session
 * spawn flow. sessionId is supplied per-spawn from the session row
 * the user is activating (so each session's bridge has its own
 * process keyed by its own id).
 *
 * V0.2 (Settings path picker — Stage 3 #4) will replace these with
 * a prefs lookup so users can point Workbench at their own GA
 * install without editing source.
 */
export const DEMO_GA_CONFIG = {
  // Windows ships `python.exe` (no version suffix); macOS / Linux
  // commonly expose `python3` while bare `python` may still point at
  // a stale Python 2 on older systems. Use the right alias per OS.
  // Only consulted when useExternalPython is true — v0.1.1+ defaults
  // to the Galley-bundled interpreter, so this field is just the
  // escape-hatch target.
  python: isWindows ? "python" : "python3",
  gaPath: "/Users/inkstone/Documents/GenericAgent",
  bridgeCwd: "/Users/inkstone/Documents/genericagent-webui",
  // v0.1.1+: prefer the Galley-bundled Python at $RESOURCE/python/.
  // Flip to true (Settings → Runtime advanced toggle) to spawn from
  // the `python` field above instead — useful when the user's GA
  // fork adds deps the bundle doesn't carry, or when iterating on
  // GA in a custom venv.
  useExternalPython: false,
};

export const DEMO_LLM_DISPLAY_NAME = "Claude Sonnet 4.5";

export const DEMO_LLMS = [
  { index: 0, displayName: "GLM 5.1", isCurrent: false },
  { index: 1, displayName: "Claude Sonnet 4.5", isCurrent: true },
  { index: 2, displayName: "GPT 4o", isCurrent: false },
  { index: 3, displayName: "Gemini 2.5 Pro", isCurrent: false },
];

export const DEMO_APPROVAL_CONFIG: ApprovalConfig = {
  requiredTools: [
    "code_run",
    "file_write",
    "file_patch",
    "start_long_term_update",
  ],
  alwaysAllowProject: ["file_read", "web_scan"],
  alwaysAllowGlobal: [],
};

export const DEMO_RUNTIME_INFO: RuntimeInfo = {
  gaPath: "~/Documents/GenericAgent",
  pythonVersion: "3.11.9 (system)",
  llmDisplayName: DEMO_LLM_DISPLAY_NAME,
  bridgePid: 48213,
  gaCommit: "cf6551516fcc836f21dcdad592b07c703d09e1d8",
  // Matches cf65515's actual `git log -1 --format=%cI` so the demo
  // fixture doesn't lie before bridge connects. Bump alongside the
  // baseline pin in CLAUDE.md whenever the baseline moves.
  gaCommitDate: "2026-05-12T12:59:30+08:00",
  gaBaseline: "cf6551516fcc836f21dcdad592b07c703d09e1d8",
  workbenchVersion: "0.1.0",
};

const NOW_ISO = new Date().toISOString();

export const DEMO_SESSIONS: Session[] = [
  {
    id: "s-today-1",
    title: "Galley 桌面端 SQLite schema",
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

// ---------------- Conversation derivation ----------------

const DEMO_USER_PROMPT =
  "帮我把 sessions 表的 SQL schema 写到 desktop/src/db/migrations/001_init.sql。" +
  "需要支持 PRD §8.1 里的所有字段（id, projectId, title, status, currentTool, " +
  "pendingApprovalCount, errorCount, lastActivityAt, createdAt, updatedAt, pid, " +
  "cwd），并加上必要的索引。";

const DEMO_FINAL_ANSWER_ALLOWED =
  "已为你生成 desktop/src/db/migrations/001_init.sql，包含 projects / sessions 两张表的初始 schema。下一步建议跑 pnpm db:migrate 验证 schema 可用。";

const DEMO_FINAL_ANSWER_DENIED =
  "收到 denied 信号。已切换方案 — 把 schema 输出为 markdown 放在回复里，由你手动落盘。";

const DEMO_PATCH_NEW_CONTENT = `-- 001_init.sql · Galley v0.1
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

/**
 * Build a demo Turn[] from the current approval decision map. Used
 * until #10 wires real conversation state from the bridge.
 */
export function buildDemoTurns(
  decisions: Record<string, ApprovalDecision>,
): Turn[] {
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

/** Compute pending approvals for the demo turn. */
export function buildDemoPending(
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

// ---------------- Toast variants ----------------

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

export function makeDemoToast(): AppError {
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
