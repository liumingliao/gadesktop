# Galley

> 多 session AI agent 的本地桌面工作台。
> 为重度用户提供 IM 与 Agent 框架自带前端做不到的三件事：
> **多 session 并行、高风险动作审批、历史会话快捷查看与恢复**。

> *Galley started as a workbench for [GenericAgent](https://github.com/lsdefine/GenericAgent). The first two letters of our name are a quiet bow to where we came from.*

## 为什么存在？

[GenericAgent](https://github.com/lsdefine/GenericAgent)（lsdefine/GenericAgent，MIT，~10K star）是一个能力强、社区活跃的开源 Agent framework。它的 Agent runtime 很好用，但官方前端（Streamlit）和 IM 集成（飞书 / 微信 / Telegram）在三个核心需求上是缺位的：

1. **多 session 并行**：所有 IM 都做不到
2. **高风险动作审批**：IM 没有结构化审批 UI
3. **历史会话快捷查看与恢复**：IM 是聊天历史而不是任务列表；GA 自带的 `/resume` 是让 LLM 自助扫文件，不是真正的 session checkpoint

Galley **不重写 GA、不改造 GA**，而是为 GA 提供一个外挂式的桌面工作台。

## Non-invasive 承诺

> Galley 的存在不能影响 GenericAgent 的独立运行。

**绝对不**：

- 修改 GA 源码
- 修改 GA memory 文件、配置文件
- 接管 GA 运行环境（不动 venv、不改 PATH）
- 自动升级 GA

**用户随时可以删除 Galley，GA 独立运行不受任何影响。**

详见 [docs/PRD.md §4](./docs/PRD.md) 与 [CLAUDE.md](./CLAUDE.md)。

## 架构

```
┌─────────────────────────┐
│  Galley Main Process    │
│  (Tauri + React)        │
│  - SQLite               │
│  - Session Manager      │
│  - IPC Broker           │
└────┬────┬────┬──────────┘
     │    │    │  stdio JSON Lines IPC
     ▼    ▼    ▼
   GA-1  GA-2  GA-3
   (each is a Python bridge subprocess
    that imports GenericAgent)
```

每个 session = 一个 GA 子进程 = 独立 working dir / history / handler 实例。Galley 通过 JSON Lines 协议跟子进程通信，子进程通过 GA 的官方扩展点 `agent._turn_end_hooks` + 子类化 `BaseHandler` 集成。

详见 [docs/ipc-protocol.md](./docs/ipc-protocol.md) 和 [PRD §9 / 附录 A](./docs/PRD.md)。

## Quick Start

**前置条件**：

- macOS（Linux/Windows 暂未测试）
- Python 3.10+
- 本地有 [GenericAgent](https://github.com/lsdefine/GenericAgent) 安装并配置好 `mykey.py`（任意 LLM provider，e2e 测试已在智谱 GLM 5.1 / NativeClaudeSession 协议下验证）

**关于 GA 版本**：Galley 跑你本地 GenericAgent 仓库的当前 HEAD，**升级节奏由你掌握**。Settings → Runtime 显示当前 commit 和我们测试过的 baseline。我们对 baseline 之后的 upstream commits 做过接口兼容审计，但 GA 不提供 API 稳定性保证——你 `git pull` 后如果出现兼容问题，bridge 启动体检会报错。

**Bridge 测试**：

```bash
git clone https://github.com/<YOUR>/galley
cd galley

# 创建 venv 并安装 dev 依赖
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

# 跑 unit tests（默认排除 e2e）
.venv/bin/python -m pytest

# 跑 e2e（需要 GA 安装 + 真 LLM API key，会消耗少量 API quota）
GA_PATH=/path/to/your/GenericAgent \
BRIDGE_PYTHON=/path/to/python/with/ga/deps \
.venv/bin/python -m pytest -m e2e
```

**桌面端**：

```bash
cd desktop
pnpm install
pnpm tauri dev    # macOS 桌面开发模式
pnpm tauri build  # 打包 .app / .dmg
```

## 项目文档

- [PRD](./docs/PRD.md) — 产品定义
- [DESIGN.md](./docs/DESIGN.md) — 设计系统
- [IPC Protocol](./docs/ipc-protocol.md) — Bridge ↔ Desktop 通信协议
- [Devlog](./docs/devlog/) — 开发日志：决策叙事与历史
- [CLAUDE.md](./CLAUDE.md) — 项目宪法（AI agent 协作规范）

## 致谢

- [lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent) — 核心 Agent framework，Galley 的所有能力都建立在其之上

## License

[MIT](./LICENSE)。跟上游 GenericAgent 一致。
