# GenericAgent Workbench PRD v0.2

> 创建时间：2026-05-07 CST
> 状态：Draft v0.2
> 作者：JCONE + Hermes
> 替代：v0.1（保留为历史对照）
>
> **v0.2 主要变化**：
> - Non-invasive 原则字面收紧、工程实现路径明确化（扩展式 attach）
> - 信息架构去 Spaces，改为 Sessions + 可选 Projects
> - V0.1 Scope 从 16 项收紧到 5 项
> - 新增附录 A：与 GA 的集成边界（基于源码事实）
> - Context Window Indicator / Follow-up Queue / Artifacts 一等公民化推到 V0.2 (产品)
>
> **本文件与 design.md 的关系**：本 PRD 第 7 / 13 / 15 节关于信息架构、布局、设计方向的部分，已被 [DESIGN.md v0.2 draft](./DESIGN.md) 中的最新决策覆盖（Light-first / Notion + Claude 气质 / 时间分组 sidebar 等）。本 PRD 的下一次 revision 会同步 DESIGN 的最新结论。

## 1. 一句话定位

GenericAgent Workbench（简称 **GA Workbench**）是 GenericAgent 的本地桌面工作台，为 GA 提供 IM 与官方前端做不到的三件事：**多 session 并行、高风险动作审批、历史会话快捷查看与恢复**。

## 2. 产品摘要

GenericAgent（lsdefine/GenericAgent，MIT，~10K star）是一个能力强、社区活跃的开源 Agent framework，但其官方前端（Streamlit）与 IM 集成（Feishu/微信/Telegram）在三个核心需求上是缺位的：

1. **多 session 并行**：所有 IM 都做不到。
2. **高风险动作审批**：IM 没有结构化审批 UI。
3. **历史会话快捷查看与恢复**：IM 是聊天历史而不是任务列表；GA 自带的 `/resume` 是让 LLM 自助扫文件，不是真正意义的 session checkpoint。

GA Workbench 不重写 GA、不改造 GA，而是为 GA 提供一个**外挂式的桌面工作台**：让重度用户能流畅地多任务、可控地放手、随时回到上一次。

## 3. 产品定位

不是 IDE，不是 ChatGPT 替代品，不是 IM 客户端。它是：

- 通用 Agent 桌面工作台（macOS-first，长期跨平台）
- 多 session 控制中心
- 可观察执行界面 + Human-in-the-loop 审批层
- GA 的 companion app：扩展体验，不替代核心，**删除即恢复**

## 4. Non-invasive 原则（核心约束）

GA Workbench **绝对不**做：

- 修改 GA 源码
- 修改 GA memory 文件（`global_mem.txt`、`global_mem_insight.txt` 等）
- 覆盖 GA 配置文件（`mykey.py` 等）
- 接管 GA 运行环境（不动 venv、不改 PATH）
- 自动升级 GA

GA Workbench **可以**做（即「扩展式 attach」）：

- 子类化 GA 提供的 `BaseHandler` / `GenericAgentHandler`，注入 hook
- 启动 GA 子进程（每个 session 一个独立子进程）
- 通过 IPC（stdio JSON Lines 起步）和子进程通信
- 读取 `llmclient.backend.history` 做持久化
- 通过 IPC 命令注入 history 实现 session 恢复

**保证**：用户随时可以删除 GA Workbench，GA 独立运行不受任何影响；GA 升级时，Workbench 只依赖 BaseHandler / ToolClient 这一层公开 API。

> Non-invasive 是工程层约束。UX 层的三条核心约束（单容器更新 / 渐进式披露 / 结果优先）见 DESIGN.md 中的对应章节。

## 5. 目标用户

V0.1 优先服务现有 GenericAgent 重度用户——能接受本地配置、关心工具执行透明度、有多任务和高风险操作审批需求的人。

不优先服务：完全不懂本地配置的轻度用户、需要团队协作的企业用户、需要托管服务的用户。

## 6. Goals / Non-goals

### 6.1 V0.1 Goals（6 件事）

1. Attach 已安装的本地 GA 并跑通 Health Check
2. 用户可以并行开多个 session（每个 session 一个 GA 子进程）
3. 用户可以查看每个 session 的 Tool Timeline（结构化事件流，不是字符串解析）
4. 用户可以审批或拒绝高风险工具调用
5. 用户可以查看历史 session 列表、回看完整记录、并继续聊
6. 左侧 Session 列表上每个 session 显示当前状态（不点进对话即可知道进展），参考 GA 飞书前端 `_TaskCard` 设计

### 6.2 V0.1 Non-goals

- 自动安装 / 升级 / 修复 GA
- 远程 / 多机器 runtime
- 完整 IDE（文件树、编辑器、git diff）
- Context Window 占用展示（GA 当前未暴露）
- Follow-up Queue（依赖暂停/恢复语义，GA 当前是退出再重入模式）
- Artifacts 一等公民（GA artifact 概念模糊）
- 完整 tracing / 多人审批 / 复杂 policy / RBAC

## 7. 信息架构

> 注：本节是 v0.2 PRD 写作时的初步信息架构。在后续设计讨论中已迭代为时间分组主体（TODAY / THIS WEEK / EARLIER）+ Projects 次要 section + Trash 隐蔽布局。详见 DESIGN.md 中的 Sidebar Spec。

### 7.1 顶层结构

三栏：

```
┌─────────────────────────────────────────┐
│ Top Bar: Runtime · Status · Controls    │
├──────────┬───────────────┬──────────────┤
│ Sidebar  │ Conversation  │ Inspector    │
│ Sessions │ + Tool Timeline│ Details/Logs│
│ Projects │               │ /Approval   │
└──────────┴───────────────┴──────────────┘
```

### 7.2 左侧栏（v0.2 PRD 初版描述；最新见 DESIGN.md）

- Quick Actions：New Chat、Search
- All Sessions：Active Runs / Today / Archive
- Projects（可选归类容器）
- Unfiled（默认桶）

### 7.3 Projects 模型

Project 在 V0.1 是**可选的归类容器**，绑定两样东西：

| 绑定项 | 说明 |
|---|---|
| **A. 归类** | sessions 在侧边栏分组显示 |
| **B. cwd（可选）** | 启动该 Project 下的 session 时，GA 子进程的 working dir 指向此路径 |

明确**不**绑定（V0.1）：

- 额外 system prompt（避免变成 Custom GPT 心智）
- 知识文件（V0.1 不做 attach 文件流）
- 独立 memory（GA memory 是全局的，触碰即违反 non-invasive）

**删除 Project 时，里面的 sessions 自动变成 Unfiled，不删除**。

### 7.4 Run Dock Area（输入区上方）

V0.1 只保留 **Approval Dock**：当前 session 有 pending approval 时高亮提示。

砍掉：Progress Dock、Follow-up Queue Dock、Question Dock、Error Dock。这些都依赖 GA 暴露更细粒度的状态/控制能力，V0.1 不做。

### 7.5 Session Row 状态展示（参考飞书 `_TaskCard`）

不点进 session，仅看左侧栏即可知道进展。每个 session row 必显示：

| 元素 | 说明 |
|---|---|
| **状态指示** | line icon（DESIGN.md 选 Phosphor Thin），颜色区分状态 |
| **标题** | session title（用户重命名或自动生成） |
| **当前进展** | `Turn N · {summary}`（直接复用 GA 在 `turn_end_callback` 中从 `<summary>` 标签提取的内容） |
| **当前工具**（可选） | 当 status=running 且能拿到 currentTool 时显示 |
| **角标** | pending approval count / error count / unread |

状态来源**全部走 `agent._turn_end_hooks`**（GA 已存在的官方扩展点，详见附录 A.2 与第 10.1 节）。每个 turn 结束 GA 自动调用 hook 并传 `summary` 等字段，Workbench 写到 SQLite 的 SessionListProjection，UI 订阅渲染。

参考实现：`fsapp.py` 的 `_TaskCard`（GA 仓库 frontends/fsapp.py 第 467-520 行）——单卡片持续 patch、状态栏 + 折叠 step 面板的模式。

## 8. 数据模型

### 8.1 Session

```typescript
type SessionStatus =
  | "idle" | "connecting" | "running"
  | "waiting_approval" | "error"
  | "completed" | "cancelled"
  | "archived";

type Session = {
  id: string;
  projectId?: string;          // 未归类时为空
  title: string;
  status: SessionStatus;
  currentTool?: string;
  pendingApprovalCount: number;
  errorCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  pid?: number;                // GA 子进程 PID
  cwd?: string;
};
```

### 8.2 Project

```typescript
type Project = {
  id: string;
  name: string;
  rootPath?: string;           // 可选 cwd 绑定
  icon?: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
};
```

### 8.3 Tool Event

```typescript
type ToolEvent = {
  id: string;
  sessionId: string;
  turnIndex: number;
  toolName: string;
  status: "pending" | "running" | "success" | "failed" | "waiting_approval" | "cancelled";
  startedAt: string;
  endedAt?: string;
  argsPreview?: string;
  resultPreview?: string;
  rawJson?: unknown;
  riskLevel?: "low" | "medium" | "high";
  approvalId?: string;
};
```

### 8.4 Conversation Message（用于持久化与恢复）

```typescript
type ConversationMessage = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: any[];
  toolResults?: any[];
  createdAt: string;
};
```

## 9. Runtime Attach Model

### 9.1 V0.1 拓扑

```
┌─────────────────────────┐
│  Workbench Main Process │
│  (Tauri + React)        │
│  - SQLite               │
│  - Session Manager      │
│  - IPC Broker           │
└────┬────┬────┬──────────┘
     │    │    │  (stdio JSON Lines)
     ▼    ▼    ▼
   GA-1  GA-2  GA-3   (each is a Python subprocess)
   (session a) (b) (c)
```

每个 session = 一个 GA 子进程 = 独立 working dir / history / handler 实例。

### 9.2 Attach 流程

1. 用户首次启动 Workbench
2. Workbench 检测 GA 安装路径（默认 `~/Documents/GenericAgent`，可手动指定）
3. Health Check：路径存在、Python 可用、`agentmain.py` 可 import、`mykey.py` 存在
4. dry-run 启动一个 GA 子进程验证 LLM session 可初始化
5. 标记 healthy，进入主界面

### 9.3 Session 启动

启动新 session 时：

1. Workbench 起一个 GA 子进程
2. 通过 `python -m bridge.workbench_bridge --ga-path ... --session-id ...` 注入 Workbench 的 bridge 脚本——bridge 内部 import GA 的 `GeneraticAgent` 和 `GenericAgentHandler`，子类化为 `WorkbenchHandler` 注入 hook
3. bridge 通过 stdin 接收 Workbench 指令、stdout 输出结构化 JSON Lines 事件
4. Workbench 主进程订阅 stdout，解析事件，更新 UI

bridge 脚本是 Workbench 自己的代码，**不属于 GA 仓库**。

### 9.4 IPC 事件协议

详细字段级 schema 见 [docs/ipc-protocol.md](./ipc-protocol.md)。简述：

事件方向：子进程 → Workbench

```typescript
type IPCEvent =
  | { kind: "ready"; sessionId: string; protocolVersion: string; gaCommit: string; ... }
  | { kind: "turn_start"; turnIndex: number }
  | { kind: "tool_call_pending"; approvalId: string; toolName: string; args: any; riskLevel: string; ... }
  | { kind: "tool_call_start"; toolName: string; args: any; ... }
  | { kind: "tool_call_progress"; text: string }
  | { kind: "tool_call_end"; status: "success" | "failed" | "denied" | "cancelled"; resultPreview: string; ... }
  | { kind: "turn_end"; turnIndex: number; summary: string; toolCalls: any[]; toolResults: any[]; exitReason?: any }
  | { kind: "ask_user"; question: string; candidates?: string[] }
  | { kind: "run_complete"; exitReason: any; finalContent: string; totalTurns: number }
  | { kind: "error"; message: string; ... }
  | { kind: "history_loaded"; messageCount: number };
```

指令方向：Workbench → 子进程

```typescript
type IPCCommand =
  | { kind: "user_message"; text: string; images: string[] }
  | { kind: "approval_response"; approvalId: string; decision: "allow_once" | "deny" | "always_allow_project" | "always_allow_global" }
  | { kind: "ask_user_response"; text: string }
  | { kind: "abort" }
  | { kind: "load_history"; messages: ConversationMessage[] }
  | { kind: "set_approval_rules"; alwaysAllowGlobal: string[]; alwaysAllowProject: string[] }
  | { kind: "shutdown" };
```

### 9.5 数据来源标注

| 事件 | 来源 | 备注 |
|---|---|---|
| `ready` | bridge 启动后立刻 emit | desktop 验证 protocolVersion |
| `turn_end` | `agent._turn_end_hooks` | GA 官方扩展点，summary 已由 GA 提取 |
| `tool_call_pending` | `WorkbenchHandler.dispatch` 拦截 | 子类化，generator 阻塞等审批 |
| `tool_call_start` / `tool_call_end` | 同上 | 仅审批工具走此路径 |
| `tool_call_progress` | bridge 解析 stdout（兜底） | 非结构化，仅作 raw view |
| `ask_user` | GA 已有协议 | `should_exit=True` 时检测 |
| `run_complete` / `error` | bridge 主控 | abort 时 bridge 主动合成 ABORTED |

### 9.6 Health Check Card

显示：GA 路径 / Python 版本 / GA 入口可 import？/ `mykey.py` 可读？/ 至少一个 LLM session 可初始化？/ 上次 heartbeat 时间。

## 10. Tool Timeline

### 10.1 实现路径（双轨制）

V0.1 走两条独立链路获取数据，互为兜底：

**轨道 A：`agent._turn_end_hooks`（GA 官方扩展点，零侵入）**

GA 在 `turn_end_callback` 中遍历所有注册到 `agent._turn_end_hooks` 的 hook 并调用，传入 `response / tool_calls / tool_results / turn / summary / next_prompt / exit_reason`。Workbench bridge 注册一个 hook：

- 每 turn 结束 emit `turn_end` 事件（含 GA 已提取好的 summary、tool_calls、tool_results）
- 用于：Session Row 状态展示、Tool Timeline 的 turn-level 视图、最终回答展示

**轨道 B：子类化 `BaseHandler`（hook 不能拦在 tool 执行前时使用）**

`WorkbenchHandler(GenericAgentHandler)` 重写 `dispatch`：

- emit `tool_call_pending`，generator 阻塞等审批
- 收到 `approval_response` 后决定是否调用真实 tool method
- 仅用于审批场景；非审批工具无需经过此路径

**优点**：

- 90% Tool Timeline 数据来自轨道 A（GA 官方支持，升级安全）
- 仅审批拦截需要轨道 B（必要的子类化）
- 飞书前端 `_make_task_hook` 已验证轨道 A 模式可行

### 10.2 Tool Event 字段

每个 Tool Event 必显示：tool name、status、short summary、elapsed、risk level、approval state、result summary。raw JSON 折叠可展开。

### 10.3 展示规则

- 当前 step 默认展开
- 历史成功 step 默认折叠
- error / waiting_approval step 自动展开
- 长任务显示 last activity 时间

## 11. Approval System

### 11.1 实现路径

`WorkbenchHandler.dispatch` 是 Python generator，可以 yield 后**阻塞**等待 IPC 回复。Workbench 收到 `tool_call_pending` 事件，弹 Approval Card；用户决策后通过 IPC 发回 `approval_response`，子进程 generator 恢复，根据决策决定是否调用真实 tool method。

这是个**完美契合**：generator 阻塞 = agent 暂停 = 等审批 = 收到回复后恢复。**不需要修改** `agent_runner_loop`。

### 11.2 默认审批列表

V0.1 默认需要审批：

- `code_run`（python / bash / powershell）
- `file_write`
- `file_patch`
- `start_long_term_update`（会改 memory）

V0.1 默认免审批：

- `file_read`、`web_scan`、`web_execute_js`（read-only 主导）、`update_working_checkpoint`、`ask_user`、`no_tool`

### 11.3 审批操作

V0.1 提供四个选项：

- **Allow once** — 只通过本次
- **Deny** — agent 收到 denied 状态，next_prompt 提示已被拒
- **Always allow in this Project** — Project 级自动通过（Unfiled 是默认桶，规则单独存）
- **Always allow globally** — 全局自动通过（power user 选项，给高信任度用户）

设置中心提供全局 always allow 列表的查看与撤销入口；高敏感工具（如 `start_long_term_update`）默认禁用 globally 选项，必须 Project 级。

V0.1 不做：路径级 allow、正则 policy、多人审批。

### 11.4 Approval Card 必显字段

工具名 / 动作说明 / 风险等级 / 目标对象（path / 命令摘要）/ 为什么需要审批 / 四个按钮。

## 12. Session 持久化与恢复

### 12.1 写入

每条 user message / assistant message / tool call / tool result 都通过 IPC 事件落到 Workbench SQLite，按 `session_id + turn_index` 索引。

### 12.2 恢复

用户在 Sessions 列表点开 3 天前的 session：

1. Workbench 起一个新 GA 子进程
2. 通过 `load_history` IPC 命令把 SQLite 里的 messages 注入 `client.backend.history`
3. 用户继续输入，agent_runner_loop 接续

### 12.3 注意

- GA 的 `working memory`（key_info、related_sop）不持久化——这是任务进行中的临时状态，恢复跨 session 没意义
- GA 的 global memory 是 GA 自己管理的，Workbench 不动；恢复后 agent 看到的是**当前**的 global memory，可能与原 session 时不同

## 13. 主界面布局

> 本节是 v0.2 PRD 写作时的初步描述。最新设计（含 Top Bar 形态、Inspector 默认状态、Approval Dock 视觉等）见 [DESIGN.md](./DESIGN.md)。

### 13.1 Top Bar

显示：当前 session 名 / GA runtime 状态 / Stop / Command Palette 入口。

**不**显示 Context Window（V0.1 拿不到）、**不**显示价格。

### 13.2 中间主区

Conversation + Tool Timeline 一体。Tool event 内联在消息流里，可折叠展开。

**最终答案视觉分离**：每个 turn 的最终回答需用分割线（`<hr>`）与 step 列表分离，醒目展示在下方。参考 fsapp `_TaskCard._build` 的【状态栏 + 折叠面板 + hr + 最终答案】布局——用户第一眼看到结论，好奇过程再展开。

### 13.3 右侧 Inspector

V0.1 tabs（DESIGN.md 已收紧到 3 个）：Details / Approvals / Runtime。Logs 移到 Settings → Developer。

V0.2+ 再加：Files / Memory / Diff。

## 14. Onboarding

首次启动：

1. 欢迎页：「GA Workbench 是 GenericAgent 的本地桌面工作台。它不会修改你的 GA。」
2. Attach Existing GA：默认检测 `~/Documents/GenericAgent`
3. Health Check
4. 进入 New Chat

文案重点：

- 不会修改你的 GA
- 高风险动作会请求审批
- 不需要先创建 Project 才能聊
- 删除 Workbench 后 GA 独立可用

## 15. 设计系统方向

> 本节是 v0.2 PRD 写作时的初版方向（dark-first / Linear 风）。设计讨论后已转向 light-first / Notion + Claude 文档对话工作台气质，详见 [DESIGN.md](./DESIGN.md)。

### 15.1 关键词

Local-first / Workbench / Transparent / Controllable / Calm / Technical / Trustworthy / Non-intrusive

### 15.2 视觉

light-first（v0.2 转向后）。气质：文档工作台但不是 IDE，calm control center 而不是 flashy AI app。

### 15.3 参考

Notion / Claude.ai / Linear / Raycast / opencode Desktop。

### 15.4 交互三原则（提炼自 GA 飞书前端的设计哲学）

除 Section 4 的 Non-invasive 工程原则外，UX 层有三条核心约束：

1. **单容器更新**：一个 session 的所有进展在同一视图内持续刷新，不开新窗口/弹层/toast
2. **渐进式披露**：默认只展示摘要，细节按需展开。Tool event / raw JSON / 历史 turn 都默认折叠。尊重用户注意力
3. **结果优先**：最终答案与过程必须视觉分离。用户第一眼看到结论，好奇过程再展开看

## 16. 技术栈

- **Shell**：Tauri v2
- **Frontend**：React 18 + TypeScript + Vite
- **Styling**：Tailwind CSS + shadcn/Radix
- **Local DB**：SQLite
- **Bridge**：Python 脚本（import GA 公开 API）
- **IPC**：stdio JSON Lines（V0.1 起步），可后续切到本地 socket
- **Platform**：macOS-first

## 17. V0.1 Acceptance Criteria

### 17.1 Attach

- 能识别用户本地 GA 路径
- Health Check 五项全过才进入主界面
- 任意一项失败显示可理解错误

### 17.2 多 Session 并行

- 用户能同时跑 3 个 session 不互相干扰
- 每个 session 独立子进程，独立 cwd / history
- 一个 session 报错不影响其他

### 17.3 Tool Timeline

- 工具调用按顺序结构化显示
- 当前运行工具实时更新
- 失败工具显示错误摘要
- 可展开 raw JSON

### 17.4 Approval

- 默认审批列表中的工具调用前会暂停
- 用户可 Allow once / Deny / Always allow（in Project / globally）
- Deny 后 agent 收到拒绝信号继续工作
- Approval Card 显示风险原因和目标对象

### 17.5 Session 历史

- 历史 sessions 在侧边栏可见
- 点开历史 session 显示完整 conversation + tool timeline
- 用户可继续输入，agent 接续上下文
- 跨进程重启 session 仍可恢复

### 17.6 Projects

- 用户可创建 Project，绑定可选 root path
- session 可归入 Project 或保持未归类
- 删除 Project 后 sessions 自动变未归类
- Project root path 在子进程启动时作为 cwd

### 17.7 Session Row 状态展示

- 每个 session row 显示状态 icon + 标题 + `Turn N · summary`
- 状态实时更新（每个 turn 结束后 ≤2s 反映在 UI）
- pending approval / error 有显著角标
- 不点进 session 就能判断进展、是否需要介入

### 17.8 Non-invasive

- 删除 Workbench 后 GA 独立可用
- 不修改 GA 源码 / memory / 配置
- GA 升级（git pull）后 Workbench 不需要改 GA（在 baseline commit 兼容范围内）

## 18. 风险与权衡

### 18.1 IPC 协议是 V0.1 的咽喉

风险：协议定不好，Tool Timeline、Approval、恢复都做不出来。
缓解：协议定义放在编码前的第一步，先纸上对齐、再实现。Stage 1 已现实验证。

### 18.2 GA 升级破坏 BaseHandler 接口

风险：GA 重写 handler/loop 时打破子类化兼容。
缓解：固定一个测试过的 GA commit 作为 V0.1 baseline；监控 upstream 重大变更；BaseHandler 接口在过去较稳定。

### 18.3 多子进程资源开销

风险：3-5 个 GA 子进程同时跑，内存 / API quota 不够。
缓解：用户已自测 3 个 OK；UI 显示并发数提醒；提供 max_concurrent_sessions 设置。

### 18.4 历史恢复时 history 注入失败

风险：`llmclient.backend.history` 是内部状态，不同 LLM provider（Claude / OAI / Mixin）下表现可能不一致。
缓解：V0.1 只对单一 provider 做完整恢复测试（已在 NativeClaudeSession 验证）；多 provider 兼容是 V0.2。

### 18.5 子类化 hook 副作用

风险：审批等待可能让 GA 内部超时机制失效。
缓解：审批等待有 max_wait（默认 10 分钟）；超时按 deny 处理。

## 19. Open Questions

1. 多 session 并行时的 LLM API quota 共享怎么处理？需要 Workbench 层做 rate limit 还是依赖 LLM provider 自己限流？
2. Session 数量软上限设几？V0.1 建议 5。
3. `web_execute_js` 是否进默认审批列表？它能改远端状态（提交表单、执行操作），但绝大多数使用是 read-only。当前归类为免审批，由 Always Allow 列表反向覆盖。

## 20. 推荐下一步（按顺序）

1. ~~定义 IPC 事件协议 v0~~（[已完成](./ipc-protocol.md)）
2. ~~写 `workbench_bridge.py` POC~~（[已完成](../bridge/workbench_bridge.py)）
3. ~~锁定 baseline GA commit~~（已锁 `6a3eecc07eb7dbdde823c0095842c829925e3e64`）
4. ~~跑通 single session E2E~~（[已完成](../bridge/tests/test_e2e.py)）
5. 完成 DESIGN.md v0.2（设计讨论中）
6. 出 3-5 张关键界面 mockup：Onboarding / New Chat / Tool Timeline / Approval Card / Session 列表
7. 初始化 Tauri + React + shadcn 项目骨架
8. 实现 Session Manager（子进程生命周期管理）
9. 加 Approval 系统 UI
10. 加 Session 持久化与恢复 UI

## 21. 当前默认决策表

| 项 | 决策 |
|---|---|
| 产品形态 | 通用 Agent 桌面工作台 |
| 默认入口 | New Chat |
| 归类容器 | 可选 Projects（绑定归类 + cwd） |
| Spaces | 不做 |
| Runtime | Attach Existing Local GA（多子进程） |
| Approval | V0.1 必做基础版（generator 阻塞模式） |
| Tool Timeline | 结构化事件流（双轨制：`_turn_end_hooks` 主链 + 子类化 handler 仅审批） |
| 历史恢复 | Workbench SQLite + history 注入 |
| Context Window | V0.1 不做（GA 未暴露） |
| Follow-up Queue | V0.2 |
| Artifacts 一等公民 | V0.2 |
| 数据存储 | Workbench SQLite |
| 设计系统 | light-first，Notion + Claude 文档对话工作台气质 |
| 平台 | macOS-first，Tauri 跨平台 |

## 22. 未来方向（V0.2+）

- Context Window Indicator（需要 GA 暴露 context 占用 API，可能联动上游）
- Follow-up Queue
- Artifacts 一等公民
- Memory Diff / Memory Approval
- 远程 Runtime
- 多 LLM provider 并行
- Browser / File Diff Inspector
- Plugin marketplace
- 自定义 system prompt 注入到 Project（Custom GPT 模式，复用 GA 的 `extra_sys_prompt`）
- Onboarding for new GA users（含安装引导）
- Dark mode

---

## 附录 A：与 GenericAgent 的集成边界

本附录基于 GA 当前代码（`ga.py`、`agent_loop.py`、`agentmain.py`、`llmcore.py`）的源码事实归纳。

### A.1 GA 当前架构事实

1. **单进程单 session 模型**：`GeneraticAgent` 实例持有全局 `task_queue`、`history`、`handler`、`is_running`。多 session 必须多进程实现。
2. **流是字符串**：`agent_runner_loop` yield 的是混合 markdown 字符串（含 tool 启动提示、stdout、status 标记），不是结构化事件。
3. **存在 hook 接口**：`BaseHandler.tool_before_callback / tool_after_callback / turn_end_callback` 是公开扩展点，默认空实现。
4. **`extra_sys_prompt`**：`agentmain.get_system_prompt()` 后会拼接 `getattr(self.llmclient.backend, 'extra_sys_prompt', '')`，这给了 Workbench 在不改 GA 源码的前提下注入额外 prompt 的余地（V0.2 用）。
5. **`ask_user` 工具**：通过 `should_exit=True` 让 generator 退出，下次 `put_task` 重入。这是 GA 现有的人机交互模式，Workbench 可直接复用为 IPC `ask_user` 事件。
6. **session 持久化**：`/resume` 是让 LLM 自助扫 `temp/model_responses/`。framework 层无原生 checkpoint。
7. **history 在 `client.backend.history`**：运行时内存，进程退出即丢。NativeClaudeSession 格式是 `[{role, content: [{type, text}]}]`（Anthropic native messages 格式）；其他 LLM session 类未验证。

### A.2 Workbench 接入点（按 V0.1 用途）

| 接入点 | 类型 | 兼容性风险 | V0.1 用途 |
|---|---|---|---|
| `agent._turn_end_hooks` | **GA 官方扩展点（dict）** | **极低**（fsapp 已用） | Tool Timeline / Session 状态 / summary（**主链路**） |
| `BaseHandler.tool_before_callback` | 公开 hook | 低 | 备用（POC 选择子类化 dispatch） |
| `BaseHandler.tool_after_callback` | 公开 hook | 低 | 备用 |
| `BaseHandler.turn_end_callback` | 公开 hook | 低 | 备用（与 `_turn_end_hooks` 重叠） |
| 子类化 `GenericAgentHandler` 重写 `dispatch` | 公开方法但需在前置加门 | 中 | **审批拦截（已实现）** |
| 启动子进程 + 注入 bridge 脚本 | 进程级 | 低 | session 隔离 |
| 读取 / 注入 `llmclient.backend.history` | 内部状态 | 中 | 历史持久化与恢复 |
| `extra_sys_prompt` | 公开属性 | 低 | V0.2（Custom GPT 模式） |
| `ask_user` 工具复用为审批前置 | 已有协议 | 低 | 已有人机交互复用 |

### A.3 V0.1 不接触的部分

- `agent_runner_loop` 函数体（不重写、不 monkey patch）
- `ga.py` 内的所有 `do_*` 工具实现
- `llmcore.py`（不修改 LLM session 类）
- `mykey.py`（不读不写）
- `memory/` 目录（不读不写）
- `assets/` 目录下的 system prompt、tool schema（不修改）

### A.4 Baseline Commit

V0.1 锁定为 `6a3eecc07eb7dbdde823c0095842c829925e3e64`（用户本地 `~/Documents/GenericAgent` 的 HEAD，2026-04-29）。选用户实际跑通的版本，避免 upstream 新 commit 引入未验证的接口变化。upstream main 后续如有重要修复，由用户主动 `git pull` 后再升 baseline 并重跑 smoke test。

CI smoke test 验证（V0.2 工作）：

- `BaseHandler.tool_before_callback / tool_after_callback / turn_end_callback` 签名
- `agent._turn_end_hooks` 字典扩展点存在
- `llmclient.backend.history` 可读写
