# Galley

> **Note for human readers**: this file is the project constitution for AI coding agents working in this repository (Claude Code, Cursor, etc). It captures non-negotiable rules and the mental model assistants should adopt when contributing. Human contributors should also read [README.md](./README.md) and [docs/PRD.md](./docs/PRD.md).

> *Galley started as a workbench for GenericAgent. The first two letters of our name are a quiet bow to where we came from.*

**Brand wordmark rules**:
- **Body text / docs / sentences**: `Galley` (sentence case). Use everywhere the name appears inside prose, including README / CLAUDE.md / PRD / commit messages / comments.
- **Small wordmark display (≤ 20px)**: `GALLEY` (Newsreader serif, semibold, uppercase, tracking-[0.04em]). Currently used: Sidebar header (16px), Settings → About h2 (20px). Reads as a refined logotype mark with workbench weight.
- **Large hero display (≥ 30px)**: `Galley` (Newsreader medium, sentence case). Currently used: Onboarding StepWelcome h1 (36px). Uppercase at this scale reads as marketing banner; sentence case stays gentle and product-appropriate.
- Use **GenericAgent** / **GA** when referring to the upstream engine, never to mean Galley.

多 session AI agent 的本地桌面工作台。让重度用户能多 session 并行、审批高风险动作、快捷查看与恢复历史会话。

- 产品定义（PRD v0.2）：[docs/PRD.md](./docs/PRD.md)
- 设计系统（DESIGN.md，draft）：[docs/DESIGN.md](./docs/DESIGN.md)
- IPC 契约：[docs/ipc-protocol.md](./docs/ipc-protocol.md)
- 决策叙事 / 历史：[docs/devlog/](./docs/devlog/)

## 项目宪法（Non-invasive）

不能影响 GA 的独立运行。**违反任一条等于破坏项目核心承诺**：

- **不修改** `~/Documents/GenericAgent` 下任何文件（包括 `mykey.py`、`memory/`、`assets/`、源代码）
- **不覆盖** GA 的 venv / PATH / 环境变量
- **不 monkey-patch** `agent_runner_loop` 或 `do_*` 工具实现

**关于读取（read-only）**：

- **优先**走 GA 公开 API（`agent.list_llms()` / `agent.llmclient.backend.history` / `agent._turn_end_hooks` 扩展点）—— GA 自己保证 API 稳定，升级风险最低
- **直接读** GA 内部文件（`mykey.py` / `assets/` 下静态资源等）**只读**前提下允许，但需：
  - 在代码注释标注 coupling 点
  - 在 GA baseline 升级时审计该路径 / 格式是否仍有效
  - **任何"读取后基于读取结果回写 GA 文件"按"修改"对待，禁止**

宪法历史：2026-05-13 audit 时发现原条文"不读写 GA 的 mykey.py / memory/ / assets/" 字面禁止读取，跟实际行为（通过 `agent.list_llms()` 间接读 mykey.py 配置）不一致。重写为"禁修改 + 读取分级"，更准确反映 non-invasive 的真正含义：**保护 GA 独立运行 = 不改 GA 状态**，而读取本身从不破坏独立性。

允许的接入方式（详见 PRD 附录 A.2）：

- 启动 GA 子进程（每个 session 独立）
- 注册 `agent._turn_end_hooks`（GA 官方扩展点，主链路）
- 子类化 `GenericAgentHandler` 重写 `dispatch`（仅审批拦截，前置加门，不复刻原逻辑）
- 读 / 注入 `llmclient.backend.history`（用于历史恢复）

GA 升级时，Galley 只依赖 `BaseHandler` / `ToolClient` 这一层公开 API。

## Tauri Identifier 不可随意改

Tauri 配置里 `identifier`（如 `app.galley`）**绑定了 macOS / Linux / Windows 上的应用数据目录路径**：

- macOS: `~/Library/Application Support/{identifier}/`
- Linux: `$XDG_DATA_HOME/{identifier}/` 或 `~/.local/share/{identifier}/`
- Windows: `%APPDATA%/{identifier}/`

SQLite 数据库（sessions / projects / tool_events / prefs）都存在这个目录下。**改 identifier 等于把 app 指向一个新空目录**——用户的所有数据看起来"消失了"（其实只是被遗忘在旧目录）。

历史教训：2026-05-13 改名 `app.gaworkbench` → `app.galley`，dogfood 中第一次启动新版本时所有 session 不见——是 identifier 改动造成的副作用，不是数据丢失。

**改 identifier 之前必须做的**（写代码顺序）：

1. 在 Rust 端（`src-tauri/src/main.rs` 或类似）加自动迁移逻辑：app 启动早期检测旧 identifier 目录是否存在 + 新目录是否为空 → 自动 `fs::rename` 把数据搬过来
2. 保留 fallback：bridge spawn / SQLite 打开时，如果新目录的 DB 缺失但旧目录有，先 copy 过来再用
3. dogfood 验证：在自己机器上**先手动放一份旧目录数据**，再换 identifier 启动，确认数据自动跑过来
4. release notes 显式说明这是次性的迁移行为

dogfood 阶段单用户改 identifier，手动 `mv ~/Library/Application\ Support/{old} ~/Library/Application\ Support/{new}` 解决；公开 release 后**不能再依赖手动操作**。

## GA Baseline

锁定 commit: `6bb31046cc29981f3fd0ce0b22a6af8c9741e850`（upstream/main HEAD，2026-05-13）

- 来源：`lsdefine/GenericAgent` upstream main 分支
- **5 个 commits** 升级自旧 baseline `cf65515`（2026-05-12），其中 1 处接口表面变化在桥接层做了**版本兼容适配**（详见 [baseline 升级 devlog](docs/devlog/2026-05-13-ga-baseline-upgrade-cf65515-to-6bb3104.md) + [regression 修复 devlog](docs/devlog/2026-05-13-baseline-regression-and-feature-detection.md)）：
  - `BaseHandler.dispatch` 签名新增 `tool_num=1` 参数（commit 3205f4a）—— **breaking**
    - 适配：`bridge/handlers.py` 用 `inspect.signature` 在模块加载时探测当前 GA 的 `BaseHandler.dispatch` 是否支持 `tool_num`，运行时按结果选择 4 参或 5 参调用 super。**对 baseline 6bb3104 + 旧版（cf65515 之前）都正确**，桥接层不强制用户跟着升级 GA
    - 用途：upstream 用 `_tool_num = len(tool_calls)` 让 do_* 工具实现按并行调用数等比缩减输出长度，避免 context blow up
  - `_turn_end_hooks` 字典扩展点 + `hook(locals())` 调用约定保持
  - `agentmain.GenericAgentHandler` 导入路径保持
  - `llmclient.backend.history` 列表读写语义保持
- ga.py 工具实现层有改动（`do_code_run` / `do_web_scan` / `do_web_execute_js` / `do_file_read` 用动态 maxlen），属预期改进，不影响接入语义
- 其余 4 个 commits 都是 frontend tui / docs / 静态资源，跟桥接层无关

CI smoke test（`bridge/tests/test_e2e.py` + `test_handlers.py`）验证：

- `BaseHandler.tool_before_callback / tool_after_callback / turn_end_callback` 签名
- `agent._turn_end_hooks` 字典扩展点存在
- `llmclient.backend.history` 可读写

## Baseline Upgrade Workflow

GA baseline 锁死一个 commit，但需要定期升级 —— 否则用户 `git pull` 后跑在 upstream 上，「已验证版本」永远停滞，Settings 里「你已自行升级」badge 失去信号意义；同时 GA 新功能 / bug fix 无法惠及 Galley 用户。

### 触发时机（事件驱动，非日历驱动）

- **Galley 准备发版**：每次 Galley minor 或 patch release 前，baseline 默认升一次。这是常规节奏。
- **用户报「GA 新功能 / 行为 Galley 跑不起来」**：立即触发审计，无需等发版。
- **Upstream GA 有 critical fix**：安全 / 重要稳定性 bug，立即跟进。

不触发：日历到点了；upstream 出了一堆普通 commit（除非积累到下次发版前的常规节奏）。

### 升级 procedure（每次按这个清单走）

```
1. cd ~/Documents/GenericAgent && git fetch upstream
   git log <current_baseline>..upstream/main --oneline
   ↳ 看 diff 范围：N 个 commits

2. 审计这 N 个 commits 对四个接口表面的影响：
   - agent_loop.py 的 BaseHandler 三回调（tool_before_callback /
     tool_after_callback / turn_end_callback）签名 + dispatch 生成器协议
   - ga.py 的 _turn_end_hooks 字典扩展点 + hook(locals()) 调用约定
   - agentmain.GenericAgentHandler 导入路径
   - llmclient.backend.history 列表读写语义
   ↳ 任一项变化 = breaking change，需评估桥接层 / handlers.py 适配成本

3. 接口适配：**优先用 inspect.signature 做 feature detection**，不要硬绑某一版本签名
   ↳ 用户的本地 GA 可能落后于 baseline（CLAUDE.md 项目宪法：不政策化 GA 升级节奏）
   ↳ 桥接适配既要兼容 new baseline，也要兼容 old GA。两端都跑测试
   ↳ 例（cf65515 → 6bb3104 升级）：
     _BASE_DISPATCH_SUPPORTS_TOOL_NUM = "tool_num" in inspect.signature(
         BaseHandler.dispatch
     ).parameters
     # 然后 if _BASE_DISPATCH_SUPPORTS_TOOL_NUM: super().dispatch(..., tool_num)
     # 否则:                                       super().dispatch(...)
   ↳ 强制硬绑会导致 regression：用户没升 GA，桥接层就 crash（见 baseline-regression devlog）

4. 跑测试矩阵 —— 必须**两个 GA 版本都过**:
   a. cd ~/Documents/GenericAgent && git checkout upstream/main
      cd ~/Documents/genericagent-webui && .venv/bin/python -m pytest bridge/tests/
      ↳ 验证新 baseline 兼容（forward compat）
   b. cd ~/Documents/GenericAgent && git checkout main
      cd ~/Documents/genericagent-webui && .venv/bin/python -m pytest bridge/tests/
      ↳ 验证用户当前 GA 兼容（backward compat）—— 这一步**容易漏**
   ↳ 只跑 a. 是 cf65515 → 6bb3104 升级踩的坑

5. dev mode 起 Galley，跑一个 5+ 步骤的多步任务，
   确认行为没退化（thinking placeholder / streaming / approval / tool dispatch）

6. 更新 baseline 引用：
   - 本文件「GA Baseline」section 改 commit hash + 日期 + N commits since previous baseline
   - 如有 bridge 代码里 hardcode 的 baseline 常量也一并更新

7. 写 devlog: docs/devlog/YYYY-MM-DD-ga-baseline-upgrade-{old_short}-to-{new_short}.md
   - N 个 commits 的分类（feat/fix/refactor）
   - 接口表面审计结论（"零 breaking change" 或 "调整了 X、桥接层做了 Y 适配"）
   - 测试矩阵两端结果

8. Commit message: "Baseline upgrade {old_short} → {new_short}: N commits"
   ↳ baseline 升级独立成一个 commit，不混进其它功能 commit，方便回滚
```

### 跟 Galley 发版的耦合

- Baseline 升级是独立 commit，跟着 Galley 下次 release 一起 ship
- Release notes 点名「GA baseline 升级到 {hash}」并指向 devlog

### 不做的事

- **不主动 UI 提醒用户「GA 有新版本可拉」**：Galley 不政策化 GA 的版本节奏。Settings → Runtime → GA Version 里的「已对齐」/「你已自行升级」状态已经足够让用户自己判断。
- **不自动升级**：每次升级都需要人工 audit 四个接口表面 + dogfood 真跑，自动化只能做到 e2e smoke test 这一层。

### 已知的 audit 工具

- 看 commits：`git log <baseline>..upstream/main --oneline`
- 看接口表面变化：`git diff <baseline>..upstream/main -- agent_loop.py ga.py agentmain.py llmcore.py`
- 跑 e2e：`.venv/bin/python -m pytest bridge/tests/`

## 目录结构

```
galley/
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
| 3. V0.1 七件事 polish | ✅ 代码层完成 | 七件全做齐：#1 端到端真跑 ✅；tool_events 审批审计持久化 ✅；Multi-session N-active（含 per-session LLM / title 派生 / summary 写入 / set_llm 接 IPC）✅；Session Restore（user message 持久化 + ready 触发 replayHistoryToBridge）✅；LRU 5 alive bridges（active 保护 + 自动 suspend）✅；Settings GA Path picker（Python 字段诚实改只读，capability 限制）✅；Onboarding fs.exists 5 项 health check ✅；macOS bundle（bridge/ 作 Tauri resource + prod cwd=resourceDir）✅。Dogfood 7 轮 UX 打磨完成（composer auto-grow / LLM 内联 Popover / 右键 Archive + toast / lazy New Chat + 清「新对话」累积 / 软化 thinking placeholder + strip GA `LLM Running` marker / 「第 N 轮」→「第 N 步」/ Sidebar 三状态 unread / 修复 turn summary 静默丢失） |
| 3.5. Sidebar 重塑 + Projects V0.1 | ✅ 代码层完成 | Sidebar Earlier 桶折叠 + EarlierDialog（月分组 + 多选 bulk archive）✅；SQLite FTS5 全文搜索（migration 004，trigram tokenizer，CommandPalette 内"在对话内容中"分区）✅；Inspector 整面退役（右侧 Details/Approvals/Runtime 三 tab，第一性原理：每 tab 都重复其它地方信息，回收 14-30% 横向）✅；AppShell overflow-hidden 修复 ✅；MessageActions icon-only + Radix Tooltip（100ms 即时反馈）✅；Multi-select bulk in EarlierDialog & ArchivedDialog（Gmail-style Select toggle）✅；GA Baseline 6a3eecc → cf65515 升级（92 commits 零 breaking change，含 Settings → Runtime "GA Version" 卡片）✅；**Projects V0.1 完整实现** ✅（5 phase：数据层 + CreateProjectDialog + Sidebar PROJECTS section 上移到时间桶之上 + 右键 Move to project 子菜单 + filter 模式 banner 显示 rootPath + CWD 绑定到 bridge spawn + EditProjectDialog + ConfirmDeleteProjectDialog + ProjectsDialog 阈值 9 + 右键 Delete destructive + 0-project 引导 + filter 状态下 New Chat label 自适应 + filter 空状态 CTA）。剩 user 跑 `pnpm tauri build` 实测产物 |

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
- [2026-05-13 Sidebar IA 重塑 · FTS5 · Inspector 退役 · Projects V0.1 · GA cf65515](./docs/devlog/2026-05-13-sidebar-overhaul-and-projects.md)
- [2026-05-12 Stage 3 dogfood polish marathon + turn_index 双层语义拆分](./docs/devlog/2026-05-12-dogfood-polish-marathon.md)
- [2026-05-11 Stage 3 V0.1 收尾 + dogfood 7 轮 UX 打磨](./docs/devlog/2026-05-11-stage3-v0.1-completion.md)
- [2026-05-11 Stage 3 multi-session：N-active + useShallow 踩坑 + LRU 5](./docs/devlog/2026-05-11-stage3-multi-session-and-perf.md)
- [2026-05-09 Stage 3 #1 端到端真跑 + UX polish](./docs/devlog/2026-05-09-stage3-end-to-end-and-ux-polish.md)
- [2026-05-07 Stage 1 bridge POC 完成](./docs/devlog/2026-05-07-stage1-bridge-poc-complete.md)
- [2026-05-08 Stage 2 桌面端骨架完成](./docs/devlog/2026-05-08-stage2-desktop-skeleton-complete.md)
