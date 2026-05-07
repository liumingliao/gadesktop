# Stage 1: Bridge POC 完成

> Date: 2026-05-07
> Status: aligned, shipped
> Related: PRD §9 / 附录 A · [docs/ipc-protocol.md](../ipc-protocol.md) · commits `6c00d45` / `1826c67` / `e0034d7` / `7362034`

## Context

PRD v0.2 锁定后，最大的不确定性是 PRD §9.4 的 IPC 协议假设是否在真实 GA + LLM 环境下站得住。Stage 1 的目标不是"建很多功能"，而是把 IPC 协议从草案变成事实——通过最小 bridge 跑通完整链路，验证：

- `_turn_end_hooks` 主链路够用（拿得到 summary / toolCalls / toolResults）
- 子类化 dispatch 做审批门，generator 阻塞等审批，零 GA 修改
- `client.backend.history` 注入能恢复上下文
- `agent.abort()` 行为符合预期

5 项 e2e 测试（用智谱 GLM 5.1 真 LLM）全过，PRD §9 假设全部被现实验证。

## Decisions

工程层面的关键决策：

- **IPC Protocol v0.1**：11 events + 7 commands + lifecycle + error handling，详见 [docs/ipc-protocol.md](../ipc-protocol.md)
- **WorkbenchHandler 双轨制**：
  - 轨道 A：注册 `agent._turn_end_hooks`（GA 官方扩展点），承担 90% Tool Timeline / Session 状态数据来源
  - 轨道 B：子类化 `GenericAgentHandler.dispatch`，仅做审批前置门，不复刻原 dispatch 逻辑
- **Always-allow 规则共享 set 引用**：`agentmain.run()` 每次 put_task 重建 handler，规则集合需跨 handler 实例持久。bridge 主入口持有 `SessionState` 的 set 字段，handler 持引用、不拷贝；`update_approval_rules` 用 in-place mutation
- **Stdout 隔离**：bridge 启动时 `os.dup(1)` 拿到原始 stdout，重定向 `sys.stdout` 到 `/dev/null`。GA 内部 `print()` 调用不污染 JSON Lines 流
- **`_to_json_safe` 兜底**：GA 在 `exit_reason.data` 中嵌入 LLM response 对象（非 JSON-serializable）。bridge 在 emit 前递归 sanitize，非 JSON 友好的 leaves 转 `str`
- **Abort 路径需 bridge 主动合成 RunCompleteEvent**：GA 的 `agent.abort()` 设 `stop_sig` 让 worker 跳出 for 循环，但**不**触发 `turn_end_callback`。bridge 在收到 `AbortCommand` 时主动 emit `RunCompleteEvent` with `exitReason.result = "ABORTED"`
- **`load_history` 适配 NativeClaudeSession**：实测 `backend.history` 是 `[{role, content: [{type: "text", text: str}]}]`（Anthropic native messages 格式）。desktop 用简单 string content；bridge 在 `_load_history` 把 string 包装为 native blocks
- **GA Baseline 锁定为用户本地 commit `6a3eecc`**（不是 upstream main HEAD）。理由：用户本地版本是已验证可跑通的；upstream 的新 commit 还没在用户机器上跑过
- **mypy strict + ruff + pytest 全绿**：含 `N815`（camelCase 字段匹配 wire format）per-file ignore；GA 模块 `ignore_missing_imports`
- **bridge 单元测试 vs e2e 测试分离**：默认 `pytest` 跑 42 unit（不消耗 LLM quota）；显式 `pytest -m e2e` 跑 5 e2e（用真 LLM）

## Rejected alternatives

- **直接 monkey patch `agent_runner_loop`**：太 invasive，违反"GA 升级时只依赖公开 API"原则
- **复刻 dispatch 内部逻辑（不是子类前置加门）**：GA 升级 dispatch 时同步成本高
- **Mock LLM 跑 e2e**：作者决定用真 LLM，相信链路完整性更重要。事实证明这是对的——`_to_json_safe` 兜底和 `load_history` 格式适配都是真 LLM 跑出来才发现的，mock 反而会掩盖
- **emit `tool_call_start` / `tool_call_end` 作为 Tool Timeline 主链路**：v0.1 选择 `turn_end` 已含完整 toolCalls/toolResults 重建 timeline；start/end 留给 V0.1.1 streaming 体验。也意味着审批 deny 路径不 emit tool_call_end（generator short-circuit 在 `super().dispatch` 之前）
- **bridge 自己持久化 always-allow 规则**：选择规则在 desktop 单一来源，bridge 启动时通过 `set_approval_rules` 命令推送过去。这避免了"bridge 也要管规则文件"的复杂度
- **复杂的 venv 隔离 / 单 monorepo Python 包格式**：超过 POC 需要

## Open questions

- `tool_call_progress` 字符串解析（GA emoji 前缀如 `🛠️ Tool: ...`）—— V0.1 不实现，可能永远不实现（GA 改 emoji 前缀就坏）
- images 多模态路径未 e2e 验证（透传代码已写：`agent.put_task(text, images=cmd.images)`）
- 其他 LLM session class（NativeOAISession / ClaudeSession / LLMSession / MixinSession）的 history 格式可能跟 NativeClaudeSession 不同。当前 V0.1 仅在 NativeClaudeSession 验证恢复
- desktop 端 spawn 多 bridge 子进程的资源管理（用户已自测 3 个 OK，但 desktop 实施时要看实际使用模式）
- bridge 子进程的 Python 解释器选择：用户本地 GA 跑在系统 Python 3.14，bridge subprocess 通过 `BRIDGE_PYTHON` env var 指定；e2e 默认 fallback 到 `sys.executable`（POC 阶段够，desktop 端要 user-friendly 的解析机制）

## Next

- **Stage 2 desktop 骨架的前置**：先完成 DESIGN.md v0.2（已开始讨论，9 块基础已对齐）
- 完成 DESIGN.md 后：Tauri + React + shadcn 项目初始化、SQLite schema 设计、Session Manager 子进程生命周期管理
- Stage 2 期间应回到 PRD 同步 baseline 实情和最新决策（PRD v0.2 写作时部分内容已被 stage 1 实践覆盖；目前 docs/PRD.md 已加 cross-reference 指向 DESIGN.md 最新结论）
