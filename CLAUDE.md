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
| 2. 桌面端骨架 | ⏸ DESIGN 讨论中 | Tauri + React + shadcn、SQLite schema、Session Manager |
| 3. V0.1 六件事 | ⏸ 阶段 2 后 | Attach / 多 session / Tool Timeline / Approval / 历史恢复 / Session Row 状态 |

## 工程规范

### Python（bridge/）

- Python 3.10+
- 类型注解 + mypy strict
- 每个 IPC 事件 / 命令必须有 dataclass + JSON schema 测试
- 不引入 GA 之外的第三方包，除非必要（首选标准库）
- pytest 覆盖：schema 验证、hook 行为、子进程隔离

### TypeScript（desktop/，阶段 2+）

阶段 2 落地时补。

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

DESIGN.md v0.2 正在迭代中（基础已对齐：Light-first 色板 / 字体 / Sidebar / Tool callout / Conversation / Composer / Approval Dock / Top Bar / Inspector）。剩下的（Onboarding / Settings / Card 类）讨论完后一次性写到 [docs/DESIGN.md](./docs/DESIGN.md) 作为 v0.2 完整版。

阶段 2 桌面端骨架启动前，DESIGN.md v0.2 必须完成。
