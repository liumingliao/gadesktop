# GA Workbench

GenericAgent 的本地桌面工作台。让重度用户能多 session 并行、审批高风险动作、快捷查看与恢复历史会话。

PRD: https://www.notion.so/3592aab6e9138117b0c1fa9937302574

## 项目宪法（Non-invasive）

不能影响 GA 的独立运行。**违反任一条等于破坏项目核心承诺**：

- 不修改 `~/Documents/GenericAgent` 下任何文件
- 不读写 GA 的 `mykey.py`、`memory/`、`assets/`
- 不覆盖 GA 的 venv / PATH / 环境变量
- 不 monkey-patch `agent_runner_loop` 或 `do_*` 工具实现

允许的接入方式（PRD 附录 A.2）：

- 启动 GA 子进程（每个 session 独立）
- 注册 `agent._turn_end_hooks`（GA 官方扩展点，主链路）
- 子类化 `BaseHandler` / `GenericAgentHandler`（仅审批拦截 `tool_before_callback`）
- 读 / 注入 `llmclient.backend.history`（用于历史恢复）

GA 升级时，Workbench 只依赖 `BaseHandler` / `ToolClient` 这一层公开 API。

## GA Baseline

锁定 commit: `6a3eecc07eb7dbdde823c0095842c829925e3e64`

- 来源：用户本地 `~/Documents/GenericAgent` 当前 HEAD（2026-04-29）
- 选用户实际在跑的版本，避免 upstream 新 commit 引入未验证的接口变化
- upstream main 后续如有重要修复，用户主动 `git pull` 后再升 baseline 并重跑 smoke test

CI smoke test 验证：

- `BaseHandler.tool_before_callback / tool_after_callback / turn_end_callback` 签名
- `agent._turn_end_hooks` 字典扩展点存在
- `llmclient.backend.history` 可读写

## 目录结构

```
genericagent-webui/
├── CLAUDE.md             # 本文件
├── bridge/               # Python，桥接 GA 子进程
│   ├── workbench_bridge.py   # 入口：import GA、注册 hook、stdin/stdout JSON Lines
│   ├── handlers.py           # WorkbenchHandler 子类（审批拦截）
│   ├── ipc.py                # IPC 事件 / 命令 dataclass
│   └── tests/                # pytest，必须脱离桌面端独立可跑
├── desktop/              # Tauri + React + shadcn（阶段 2 才建）
└── docs/
    └── ipc-protocol.md   # IPC 契约文档（bridge 改先改文档）
```

## 阶段推进

| 阶段 | 状态 | 目标 |
|---|---|---|
| 0. 基础设施 | ✅ 完成 | git init、目录、CLAUDE.md |
| 1. Bridge POC | 🟢 **当前** | 把 IPC 协议从草案变成事实；脱离 UI 跑通 |
| 2. 桌面端骨架 | ⏸ 阶段 1 后 | Tauri + React、SQLite schema、子进程管理 |
| 3. V0.1 六件事 | ⏸ 阶段 2 后 | Attach / 多 session / Tool Timeline / Approval / 历史恢复 / Session Row（Projects 最后） |

## 阶段 1 完成标志

`python -m bridge.tests.test_e2e` 跑通完整流程：

启动 bridge → 发 user message → 收 turn_end 事件 → 触发审批 → 用户决策 → agent 接续 → 收最终回答。

**没有任何 UI**。能脱离 desktop 端 100% 验证 IPC 协议。

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

## 设计文档暂缓

DESIGN.md 暂未确认。所有视觉 / 交互设计决策推到阶段 2。阶段 1 不做任何 UI 假设。

PRD 第 13 / 15 节是方向性约束（calm control center、交互三原则），不是终态。

## 相关链接

- PRD v0.2: https://www.notion.so/3592aab6e9138117b0c1fa9937302574
- GA 飞书体验设计: https://www.notion.so/3502aab6e91381bfba72fe0f3a048558
- GA upstream: https://github.com/lsdefine/GenericAgent
- 本地 GA: `~/Documents/GenericAgent`
