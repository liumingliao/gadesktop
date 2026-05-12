# GenericAgent Workbench

> **Note for human readers**: this file is the project constitution for AI coding agents working in this repository (Claude Code, Cursor, etc). It captures non-negotiable rules and the mental model assistants should adopt when contributing. Human contributors should also read [README.md](./README.md) and [docs/PRD.md](./docs/PRD.md).

GenericAgent 的本地桌面工作台（简称 **GA Workbench**）。让重度用户能多 session 并行、审批高风险动作、快捷查看与恢复历史会话。

- 产品定义（PRD v0.2）：[docs/PRD.md](./docs/PRD.md)
- 设计系统（DESIGN.md，draft）：[docs/DESIGN.md](./docs/DESIGN.md)
- IPC 契约：[docs/ipc-protocol.md](./docs/ipc-protocol.md)
- 决策叙事 / 历史：[docs/devlog/](./docs/devlog/)

## 项目宪法（Non-invasive）

不能影响 GA 的独立运行。**违反任一条等于破坏项目核心承诺**：

- 不修改 `~/Documents/GenericAgent` 下任何文件
- 不读写 GA 的 `mykey.py`、`memory/`、`assets/`
- 不覆盖 GA 的 venv / PATH / 环境变量
- 不 monkey-patch `agent_runner_loop` 或 `do_*` 工具实现

允许的接入方式（详见 PRD 附录 A.2）：

- 启动 GA 子进程（每个 session 独立）
- 注册 `agent._turn_end_hooks`（GA 官方扩展点，主链路）
- 子类化 `GenericAgentHandler` 重写 `dispatch`（仅审批拦截，前置加门，不复刻原逻辑）
- 读 / 注入 `llmclient.backend.history`（用于历史恢复）

GA 升级时，Workbench 只依赖 `BaseHandler` / `ToolClient` 这一层公开 API。

## GA Baseline

锁定 commit: `6a3eecc07eb7dbdde823c0095842c829925e3e64`

- 来源：用户本地 `~/Documents/GenericAgent` 当前 HEAD（2026-04-29）
- 选用户实际在跑的版本，避免 upstream 新 commit 引入未验证的接口变化
- upstream main 后续如有重要修复，由用户主动 `git pull` 后再升 baseline 并重跑 smoke test

CI smoke test 验证：

- `BaseHandler.tool_before_callback / tool_after_callback / turn_end_callback` 签名
- `agent._turn_end_hooks` 字典扩展点存在
- `llmclient.backend.history` 可读写

## 目录结构

```
genericagent-workbench/
├── README.md                # 项目门面
├── LICENSE                  # MIT
├── CLAUDE.md                # 本文件，AI agent 协作规范
├── pyproject.toml
├── bridge/                  # Python，桥接 GA 子进程
│   ├── workbench_bridge.py  # 入口：import GA、注册 hook、stdin/stdout JSON Lines
│   ├── handlers.py          # WorkbenchHandler 子类（审批拦截）
│   ├── ipc.py               # IPC 事件 / 命令 dataclass
│   └── tests/               # pytest，必须脱离桌面端独立可跑
├── desktop/                 # Tauri + React + shadcn（阶段 2 才建）
└── docs/
    ├── PRD.md               # 产品定义（v0.2）
    ├── DESIGN.md            # 设计系统（v0.2 draft，工作中）
    ├── ipc-protocol.md      # IPC 契约（bridge ↔ desktop）
    └── devlog/              # 决策叙事 / 历史
        ├── README.md        # 时间线索引
        └── YYYY-MM-DD-topic.md
```

## 阶段推进

| 阶段 | 状态 | 目标 |
|---|---|---|
| 0. 基础设施 | ✅ 完成 | git init、目录、CLAUDE.md、LICENSE、README |
| 1. Bridge POC | ✅ 完成 | IPC 协议、WorkbenchHandler、主入口、e2e |
| 2. 桌面端骨架 | ✅ 完成 | Tauri v2 + React 19 + Tailwind v4 + Zustand + SQLite + plugin-shell 端到端 IPC（#1-#10b 全部子任务） |
| 3. V0.1 七件事 polish | ✅ 代码层完成 | 七件全做齐：#1 端到端真跑 ✅；tool_events 审批审计持久化 ✅；Multi-session N-active（含 per-session LLM / title 派生 / summary 写入 / set_llm 接 IPC）✅；Session Restore（user message 持久化 + ready 触发 replayHistoryToBridge）✅；LRU 5 alive bridges（active 保护 + 自动 suspend）✅；Settings GA Path picker（Python 字段诚实改只读，capability 限制）✅；Onboarding fs.exists 5 项 health check ✅；macOS bundle（bridge/ 作 Tauri resource + prod cwd=resourceDir）✅。Dogfood 7 轮 UX 打磨完成（composer auto-grow / LLM 内联 Popover / 右键 Archive + toast / lazy New Chat + 清「新对话」累积 / 软化 thinking placeholder + strip GA `LLM Running` marker / 「第 N 轮」→「第 N 步」/ Sidebar 三状态 unread / 修复 turn summary 静默丢失）。剩 user 跑 `pnpm tauri build` 实测产物 |

## 工程规范

### Python（bridge/）

- Python 3.10+
- 类型注解 + mypy strict
- 每个 IPC 事件 / 命令必须有 dataclass + JSON schema 测试
- 不引入 GA 之外的第三方包，除非必要（首选标准库）
- pytest 覆盖：schema 验证、hook 行为、子进程隔离

### TypeScript（desktop/）

工具链：

- **Tauri v2** + **Vite 7** + **React 19** + **TypeScript 5.8 strict**
- **Tailwind v4**（CSS-first，`@theme` 在 `src/styles/globals.css`）
- **Phosphor Icons** thin weight 全局唯一 icon set
- **Self-hosted 字体**：`@fontsource/newsreader` / `@fontsource/inter` / `@fontsource/jetbrains-mono`（npm 包，无运行时网络依赖）
- **macOS-first**：`bundle.targets = ["app", "dmg"]`；`titleBarStyle: "Overlay"` 自定义 chrome 集成 traffic light
- 包管理器：**pnpm**（必须）

目录结构：

```
desktop/
├── src/
│   ├── main.tsx                 # 入口（import globals.css）
│   ├── App.tsx                  # 根组件
│   ├── styles/globals.css       # Tailwind v4 + DESIGN tokens（@theme block）
│   ├── components/
│   │   ├── layout/              # AppShell（三栏） / TopBar
│   │   ├── ui/                  # shadcn copy-paste 组件（按需引入）
│   │   ├── conversation/        # 主对话区（Conversation / Tool callout / Composer）
│   │   ├── approval/            # Approval Dock / Approval Card
│   │   ├── overlay/             # Command Palette / Health Check / Error
│   │   └── settings/            # Settings 独立窗口
│   ├── lib/
│   │   ├── utils.ts             # cn() + 通用 helpers
│   │   └── ipc.ts               # bridge 通信封装（Stage 2 #10 加）
│   ├── hooks/                   # custom hooks
│   ├── stores/                  # state 管理（Zustand，Stage 2 #9 加）
│   └── types/
│       └── ipc.ts               # IPC 协议 TypeScript 镜像（必须跟 bridge/ipc.py 同步）
├── src-tauri/                    # Rust 端
│   ├── tauri.conf.json
│   └── src/main.rs
├── public/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js              # ESLint flat config
├── .prettierrc.json
└── components.json               # shadcn 配置（首次 add 时创建）
```

token 命名约定（Tailwind v4 友好）：

- 颜色：`--color-app` / `--color-surface` / `--color-elevated` / `--color-brand` / `--color-success` 等 → utility `bg-app` / `text-brand` / `border-brand`
- 文字色用 `--color-ink` / `--color-ink-soft` / `--color-ink-muted`（避开 Tailwind 的 `text-text-*` 双重命名）
- 边框用 `--color-line` / `--color-line-strong` / `--color-line-subtle`（避开 `border-border`）
- 字体：`--font-serif` / `--font-sans` / `--font-mono` → utility `font-serif` 等

shadcn 引入策略：

- **按需 add**，不 init 时一次性装。第一次需要的是 `command` (Command Palette)
- shadcn 组件 copy 到 `src/components/ui/`，可改可控
- **不让 shadcn init 改 `globals.css`**（避免跟我们的 token 冲突）；首次 add 时手写 `components.json`

shadcn vs 自研判断：

- **用 shadcn**：a11y 复杂 / 行为标准（command / dialog / dropdown-menu / popover / tabs / tooltip / sonner / button / input）
- **自研**：prototype 已定型 / 视觉 specific（Sidebar / Composer / Tool callout / Approval Dock / Health Check / Error Card / Onboarding / Empty state）

命令清单：

- `pnpm dev` — Vite dev server (无 Tauri 窗口，浏览器调试用)
- `pnpm tauri dev` — Tauri 桌面 dev（出 macOS 窗口）
- `pnpm build` — TypeScript 编译 + Vite 打包
- `pnpm tauri build` — 出 .app / .dmg
- `pnpm typecheck` — 仅 TS 检查（必须 0 error）
- `pnpm lint` — ESLint flat config（必须 0 warning）
- `pnpm format` — Prettier 写入

### IPC types 同步规则

`desktop/src/types/ipc.ts` 必须跟 `bridge/ipc.py` 字段一一对应。任何协议变更：

1. 改 `docs/ipc-protocol.md`（先）
2. 改 `bridge/ipc.py` 的 dataclass + 测试
3. 改 `desktop/src/types/ipc.ts` 同 commit 内同步

### Git 提交

- 英文 commit message，描述变更意图（不用单纯描述 what，写 why）
- 每个 commit 独立可工作（不留半成品）
- 不主动 push，等用户指令

### IPC 协议变更流程

1. 先改 `docs/ipc-protocol.md`
2. 再改 `bridge/ipc.py` 的 dataclass
3. 再改实现 + 测试

文档先行；协议是 bridge 和 desktop 之间的契约，不能用代码隐式定义。

## Devlog Workflow

`docs/devlog/` 是决策叙事日志，补充于 PRD（产品定义"现在是什么"）、DESIGN.md（设计规则"现在的规则"）、CLAUDE.md（项目宪法）。devlog 记录"我们怎么走到这里的"、考虑过但被否的方案、留待后续的 open question。

### 何时写

主动写 devlog 的三种场合：

1. **每次 work session 结束**（"今天先到这里"）
2. **重大设计/架构决策对齐后**（不一定等 session 结束）
3. **阶段切换**（如 Stage 1 → Stage 2，写一份阶段总结）

### 文件命名

`YYYY-MM-DD-topic-in-kebab-case.md`，一天可多个 entry（按主题分）。

### 6 段格式

每个 entry 包含：

- **Date / Status / Related** — 元信息（含 PRD/DESIGN/commit 引用）
- **Context** — 这次讨论或工作的背景
- **Decisions** — 对齐的具体结论，列表化、可索引
- **Rejected alternatives** — 考虑过但没选的方案 + 理由（最有价值的部分）
- **Open questions** — 留待后续的问题
- **Next** — 这次工作的下一步

### 责任分工

- AI 主写：每次决策对齐后主动提议落 devlog
- 作者 review：可以 inline 调整
- **不重复信息**：devlog 不复述 PRD / DESIGN.md / CLAUDE.md 已有的内容，只记叙事 + decision provenance

写完后更新 `docs/devlog/README.md` 时间线索引。

## 设计文档状态

DESIGN.md v0.2 完整版已定稿（[docs/DESIGN.md](./docs/DESIGN.md)），实现层与设计层对齐过几次：
- §2.1 token 表加 Tailwind v4 utility 列（ink / line 命名空间）+ `--brand-strong` / `--border-subtle`（Stage 2 #2）
- §4.6 file_patch 渲染从 `@pierre/diffs` 改为自研 PatchView（Stage 2 #6 reversal，bundle cost 不可接受）

参考 prototype 在 `docs/GenericAgent Workbench-handoff/`（design agent 出品的 5 张关键界面静态实现），实现各组件时对照视觉。

实现过程的关键决策叙事见 `docs/devlog/`，特别是阶段切换总结：
- [2026-05-12 Stage 3 dogfood polish marathon + turn_index 双层语义拆分](./docs/devlog/2026-05-12-dogfood-polish-marathon.md)
- [2026-05-11 Stage 3 V0.1 收尾 + dogfood 7 轮 UX 打磨](./docs/devlog/2026-05-11-stage3-v0.1-completion.md)
- [2026-05-11 Stage 3 multi-session：N-active + useShallow 踩坑 + LRU 5](./docs/devlog/2026-05-11-stage3-multi-session-and-perf.md)
- [2026-05-09 Stage 3 #1 端到端真跑 + UX polish](./docs/devlog/2026-05-09-stage3-end-to-end-and-ux-polish.md)
- [2026-05-07 Stage 1 bridge POC 完成](./docs/devlog/2026-05-07-stage1-bridge-poc-complete.md)
- [2026-05-08 Stage 2 桌面端骨架完成](./docs/devlog/2026-05-08-stage2-desktop-skeleton-complete.md)
