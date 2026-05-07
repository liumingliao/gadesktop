# GA Workbench

> GenericAgent 的本地桌面工作台。
> 为重度用户提供 IM 与 GA 自带前端做不到的三件事：
> **多 session 并行、高风险动作审批、历史会话快捷查看与恢复**。

> ⚠️ **Status: pre-alpha / POC**
>
> 阶段 1（Bridge POC）已完成；阶段 2（Desktop 骨架）尚未开始。
> 当前**仅有 Python bridge** 可独立验证，桌面 UI 还在设计中，没有可交互的图形界面。

## 为什么存在？

[GenericAgent](https://github.com/lsdefine/GenericAgent)（lsdefine/GenericAgent，MIT，~10K star）是一个能力强、社区活跃的开源 Agent framework。它的 Agent runtime 很好用，但官方前端（Streamlit）和 IM 集成（飞书 / 微信 / Telegram）在三个核心需求上是缺位的：

1. **多 session 并行**：所有 IM 都做不到
2. **高风险动作审批**：IM 没有结构化审批 UI
3. **历史会话快捷查看与恢复**：IM 是聊天历史而不是任务列表；GA 自带的 `/resume` 是让 LLM 自助扫文件，不是真正的 session checkpoint

GA Workbench **不重写 GA、不改造 GA**，而是为 GA 提供一个外挂式的桌面工作台。

## Non-invasive 承诺

> GA Workbench 的存在不能影响 GA 的独立运行。

**绝对不**：

- 修改 GA 源码
- 修改 GA memory 文件、配置文件
- 接管 GA 运行环境（不动 venv、不改 PATH）
- 自动升级 GA

**用户随时可以删除 GA Workbench，GA 独立运行不受任何影响。**

详见 [docs/PRD.md §4](./docs/PRD.md) 与 [CLAUDE.md](./CLAUDE.md)。

## 架构

```
┌─────────────────────────┐
│  Workbench Main Process │
│  (Tauri + React)        │  ← Stage 2，未开始
│  - SQLite               │
│  - Session Manager      │
│  - IPC Broker           │
└────┬────┬────┬──────────┘
     │    │    │  stdio JSON Lines IPC
     ▼    ▼    ▼
   GA-1  GA-2  GA-3       ← Stage 1，已完成
   (each is a Python bridge subprocess
    that imports GenericAgent)
```

每个 session = 一个 GA 子进程 = 独立 working dir / history / handler 实例。Workbench 通过 JSON Lines 协议跟子进程通信，子进程通过 GA 的官方扩展点 `agent._turn_end_hooks` + 子类化 `BaseHandler` 集成。

详见 [docs/ipc-protocol.md](./docs/ipc-protocol.md)（11 events + 7 commands）和 [PRD §9 / 附录 A](./docs/PRD.md)。

## Quick Start（Stage 1 Bridge POC 验证）

当前阶段只能运行 bridge 的 unit + e2e 测试，没有可交互的 UI。

**前置条件**：

- macOS（Linux/Windows 暂未测试）
- Python 3.10+
- 本地有 [GenericAgent](https://github.com/lsdefine/GenericAgent) 安装并配置好 `mykey.py`（任意 LLM provider，e2e 测试已在智谱 GLM 5.1 / NativeClaudeSession 协议下验证）

**安装与测试**：

```bash
git clone https://github.com/<YOUR>/genericagent-workbench
cd genericagent-workbench

# 创建 venv 并安装 dev 依赖
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

# 跑 unit tests（默认排除 e2e，~50ms）
.venv/bin/python -m pytest

# 跑 e2e 测试（需要 GA 安装 + 真 LLM API key，~30s，会消耗少量 API quota）
GA_PATH=/path/to/your/GenericAgent \
BRIDGE_PYTHON=/path/to/python/with/ga/deps \
.venv/bin/python -m pytest -m e2e
```

42 个 unit + 5 个 e2e 测试覆盖：IPC 协议 schema、handler 审批逻辑、bridge 主入口、approval 拦截、history 恢复、abort 路径。

## 路线图

| 阶段 | 状态 | 内容 |
|---|---|---|
| 0. 基础设施 | ✅ | git init、目录结构、CLAUDE.md |
| 1. Bridge POC | ✅ | IPC 协议、WorkbenchHandler、主入口、e2e |
| 2. 桌面端骨架 | ⏸ 设计中 | Tauri + React + shadcn 初始化、SQLite schema、Session Manager |
| 3. V0.1 六件事 | ⏸ | Attach / 多 session / Tool Timeline / Approval / 历史恢复 / Session Row 状态 |

V0.1 的 6 个 Goals 见 [PRD §6.1](./docs/PRD.md)。

## 项目文档

- [PRD](./docs/PRD.md) — 产品定义（v0.2）
- [DESIGN.md](./docs/DESIGN.md) — 设计系统（v0.2 draft，工作中）
- [IPC Protocol](./docs/ipc-protocol.md) — Bridge ↔ Desktop 通信协议
- [Devlog](./docs/devlog/) — 开发日志：决策叙事与历史
- [CLAUDE.md](./CLAUDE.md) — 项目宪法（Claude Code 协作规范）

## 致谢

- [lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent) — 核心 Agent framework，本项目的所有能力都建立在其之上

## License

[MIT](./LICENSE)。跟上游 GenericAgent 一致。
