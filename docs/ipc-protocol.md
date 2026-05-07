# IPC Protocol v0.1

GenericAgent Workbench (GA Workbench) bridge 与 desktop 之间的通信契约。本文件是**唯一真相**——bridge 与 desktop 实现必须以本文件为准；改协议先改本文件。

## 1. Overview

- 一个 `bridge` 子进程 = 一个 GA session = 一个独立的 GA 进程
- desktop 主进程通过 stdin 向 bridge 发命令；bridge 通过 stdout 向 desktop 发事件
- 协议版本：`0.1`

## 2. Transport

- **格式**：JSON Lines（每行一个 JSON 对象，UTF-8 编码，以 `\n` 结尾）
- **stdin**：desktop → bridge 的命令
- **stdout**：bridge → desktop 的事件
- **stderr**：仅用于 bridge 自身崩溃日志，desktop 不解析
- **字段命名**：camelCase
- **时间戳**：ISO 8601 带时区（如 `2026-05-07T13:51:00+08:00`）
- **空字符串 vs null**：缺失用 `null` 或省略字段；不要用空字符串当"无"

## 3. Lifecycle

```
desktop                             bridge subprocess
  │                                       │
  │  spawn (GA path, cwd, sessionId)      │
  │ ───────────────────────────────────► │
  │                                       │ import GA, build agent
  │                                       │ register turn_end_hook
  │                                       │ install WorkbenchHandler
  │  ◄──── { kind: "ready", ... }         │
  │                                       │
  │  { kind: "load_history", ... }        │  (可选，仅恢复 session 时)
  │ ───────────────────────────────────► │
  │  ◄──── { kind: "history_loaded" }     │
  │                                       │
  │  { kind: "user_message", ... }        │
  │ ───────────────────────────────────► │
  │  ◄──── { kind: "turn_start", ... }    │
  │  ◄──── { kind: "tool_call_*", ... }   │  (若有审批，bridge 阻塞)
  │  { kind: "approval_response", ... }   │
  │ ───────────────────────────────────► │
  │  ◄──── { kind: "turn_end", ... }      │
  │  ◄──── { kind: "run_complete", ... }  │
  │                                       │
  │  { kind: "shutdown" }                 │
  │ ───────────────────────────────────► │
  │                                       │ exit(0)
```

## 4. Events (bridge → workbench)

每个事件必有 `kind` 字段。所有事件都隐含 `sessionId` 字段（由 desktop 在 spawn 时分配，bridge 启动后 echo 回来）。

### 4.1 `ready`

bridge 启动并完成 GA 初始化后**立刻**发的第一条事件。desktop 收到此事件才能开始发命令。

```json
{
  "kind": "ready",
  "sessionId": "sess_abc123",
  "protocolVersion": "0.1",
  "gaCommit": "6a3eecc07eb7dbdde823c0095842c829925e3e64",
  "gaPath": "/Users/inkstone/Documents/GenericAgent",
  "llmName": "ClaudeSession/claude-sonnet-4-6",
  "cwd": "/Users/inkstone/Documents/GenericAgent/temp",
  "pid": 12345,
  "timestamp": "2026-05-07T13:51:00+08:00"
}
```

desktop 必须验证 `protocolVersion` 与自身一致；不一致应主动 `shutdown`。

### 4.2 `turn_start`

agent 开始一轮 LLM 调用。

```json
{
  "kind": "turn_start",
  "sessionId": "sess_abc123",
  "turnIndex": 1,
  "timestamp": "..."
}
```

### 4.3 `tool_call_pending`

工具需要用户审批时发出，bridge 阻塞直到收到 `approval_response`。

```json
{
  "kind": "tool_call_pending",
  "sessionId": "sess_abc123",
  "approvalId": "appr_xyz789",
  "turnIndex": 1,
  "toolName": "code_run",
  "args": { "type": "python", "code": "print('hi')" },
  "argsPreview": "type=python, code=print('hi')...",
  "riskLevel": "high",
  "reason": "Code execution can modify files / network",
  "timestamp": "..."
}
```

字段说明：
- `args`：完整工具参数 JSON（用于审批 UI 完整展示）
- `argsPreview`：≤200 字符的人类可读摘要
- `riskLevel`：`"low" | "medium" | "high"`
- `reason`：为何需要审批（用于 Approval Card 提示）

### 4.4 `tool_call_start`

工具开始执行（已通过审批 / 不需审批）。

```json
{
  "kind": "tool_call_start",
  "sessionId": "sess_abc123",
  "toolCallId": "tc_001",
  "turnIndex": 1,
  "toolName": "file_read",
  "args": { "path": "agentmain.py" },
  "argsPreview": "path=agentmain.py",
  "timestamp": "..."
}
```

`toolCallId` 由 bridge 生成（uuid 短形式），用于 `tool_call_end` 关联。

### 4.5 `tool_call_end`

工具执行结束。

```json
{
  "kind": "tool_call_end",
  "sessionId": "sess_abc123",
  "toolCallId": "tc_001",
  "status": "success",
  "resultPreview": "[FILE] 268 lines | ...",
  "elapsedMs": 124,
  "timestamp": "..."
}
```

字段说明：
- `status`：`"success" | "failed" | "denied" | "cancelled"`
- `resultPreview`：≤500 字符的结果摘要
- `denied` 仅当用户在 `tool_call_pending` 后回 `decision: "deny"` 时发出

### 4.6 `tool_call_progress`（兜底）

bridge 解析 GA yield 出来的 markdown 字符串得到的非结构化进度，用于 raw view。**不**作为 desktop 渲染主链路的依据。

```json
{
  "kind": "tool_call_progress",
  "sessionId": "sess_abc123",
  "toolCallId": "tc_001",
  "text": "[Action] Running python in temp: print('hi')...",
  "timestamp": "..."
}
```

### 4.7 `turn_end`

来源：`agent._turn_end_hooks`。**这是 Tool Timeline 与 Session Row 状态展示的主数据源**。

```json
{
  "kind": "turn_end",
  "sessionId": "sess_abc123",
  "turnIndex": 1,
  "summary": "已完成文件读取，准备分析内容",
  "toolCalls": [
    { "toolName": "file_read", "args": { "path": "agentmain.py" } }
  ],
  "toolResults": [
    { "toolUseId": "...", "content": "[FILE] 268 lines..." }
  ],
  "exitReason": null,
  "responseContent": "<thinking>...</thinking><summary>已完成文件读取，准备分析内容</summary>",
  "timestamp": "..."
}
```

字段说明：
- `summary`：直接复用 GA 在 `turn_end_callback` 中提取的 `<summary>` 标签内容（GA 已 smart_format 截断到 100 字符）
- `toolCalls / toolResults`：当 turn 中所有工具调用与结果
- `exitReason`：当且仅当 agent_runner_loop 决定退出时非 null（结构与 GA 内部 `exit_reason` 一致：`{"result": "CURRENT_TASK_DONE" | "EXITED" | "MAX_TURNS_EXCEEDED", "data": ...}`）
- `responseContent`：完整 LLM 响应文本（含 thinking / summary 标签），用于 desktop 自行解析展示

### 4.8 `ask_user`

agent 主动调用 `ask_user` 工具时发出。bridge 此时 agent_runner_loop 已 `should_exit=True` 退出，等待 desktop 回 `ask_user_response` 后用 `user_message` 重新发起。

```json
{
  "kind": "ask_user",
  "sessionId": "sess_abc123",
  "question": "你希望删除整个目录还是仅清理 .pyc 文件？",
  "candidates": ["删除整个目录", "仅清理 .pyc"],
  "timestamp": "..."
}
```

`candidates` 可为空数组（开放式问题）。

### 4.9 `run_complete`

一次 user_message 的完整运行结束（agent_runner_loop 返回）。

```json
{
  "kind": "run_complete",
  "sessionId": "sess_abc123",
  "exitReason": { "result": "CURRENT_TASK_DONE", "data": null },
  "finalContent": "（清理后的最终回答 markdown）",
  "totalTurns": 3,
  "timestamp": "..."
}
```

`exitReason.result` 取值：
- `"CURRENT_TASK_DONE"`：正常完成
- `"EXITED"`：agent 主动 should_exit（如 ask_user）
- `"MAX_TURNS_EXCEEDED"`：达到 max_turns 上限
- `"ABORTED"`：用户主动 abort（bridge 自定义状态，非 GA 原生）

### 4.10 `error`

非致命错误（bridge 仍可继续）。

```json
{
  "kind": "error",
  "sessionId": "sess_abc123",
  "message": "Failed to parse tool args: ...",
  "context": "tool_call_pending",
  "traceback": "...",
  "timestamp": "..."
}
```

致命错误：bridge 直接 exit，desktop 通过 stdout EOF + 进程退出码感知。

### 4.11 `history_loaded`

`load_history` 命令完成的响应。

```json
{
  "kind": "history_loaded",
  "sessionId": "sess_abc123",
  "messageCount": 12,
  "timestamp": "..."
}
```

## 5. Commands (workbench → bridge)

每个命令必有 `kind` 字段。

### 5.1 `user_message`

发送用户消息，触发 agent_runner_loop。

```json
{
  "kind": "user_message",
  "text": "帮我读 agentmain.py 看下结构",
  "images": []
}
```

`images` 是本地文件绝对路径数组（V0.1 可空）。

### 5.2 `approval_response`

响应 `tool_call_pending`。

```json
{
  "kind": "approval_response",
  "approvalId": "appr_xyz789",
  "decision": "allow_once"
}
```

`decision` 取值：
- `"allow_once"`：仅本次通过
- `"deny"`：拒绝，bridge 让工具调用 short-circuit 返回 denied 状态
- `"always_allow_project"`：本次通过 + 在当前 Project（含 Unfiled）规则缓存中记录
- `"always_allow_global"`：本次通过 + 在全局规则缓存中记录

**always_allow 规则的存储**：bridge 不持久化任何规则。规则由 desktop 维护并在 `tool_call_pending` 之前通过 `set_approval_rules` 命令同步给 bridge（见 5.6）。这样 bridge 在新 session 启动时即可知道"哪些工具已经永久通过"，避免每次都先 emit pending 再问 desktop。

### 5.3 `ask_user_response`

响应 `ask_user` 事件。bridge 收到后会用此文本作为下一次 `user_message` 的内容触发新的 agent_runner_loop。

```json
{
  "kind": "ask_user_response",
  "text": "仅清理 .pyc"
}
```

### 5.4 `abort`

中止当前运行。bridge 调 `agent.abort()`，agent_runner_loop 退出，发 `run_complete` 含 `exitReason.result = "ABORTED"`。

```json
{ "kind": "abort" }
```

### 5.5 `load_history`

注入历史会话上下文。**只能在 ready 之后、第一个 user_message 之前调用**。注入到 `client.backend.history`。

```json
{
  "kind": "load_history",
  "messages": [
    {
      "role": "user",
      "content": "...",
      "toolCalls": [],
      "toolResults": []
    },
    {
      "role": "assistant",
      "content": "...",
      "toolCalls": [...],
      "toolResults": [...]
    }
  ]
}
```

`messages` 顺序与历史一致；bridge 直接构造对应的 GA history 结构注入。完成后回 `history_loaded`。

### 5.6 `set_approval_rules`

同步 desktop 维护的 always_allow 规则到 bridge。可在任意时刻调用，立即生效。

```json
{
  "kind": "set_approval_rules",
  "alwaysAllowGlobal": ["file_patch"],
  "alwaysAllowProject": ["code_run"]
}
```

bridge 在 `tool_call_pending` 之前先查这两个列表，命中则跳过审批直接放行（仍 emit `tool_call_start` / `tool_call_end`，但**不** emit `tool_call_pending`）。

注意：高敏感工具（V0.1 列表：`start_long_term_update`）不应进入 `alwaysAllowGlobal`；desktop UI 层禁用此选项，bridge 不强制校验。

### 5.7 `shutdown`

请求 bridge 优雅退出。bridge 等当前 turn 完成（如有）后 `exit(0)`。

```json
{ "kind": "shutdown" }
```

## 6. Approval Flow（端到端示例）

agent 决定调用 `code_run`：

```
bridge:   { kind: "turn_start", turnIndex: 2 }
bridge:   { kind: "tool_call_pending", approvalId: "a1", toolName: "code_run", args: {...}, riskLevel: "high" }
          (bridge generator 阻塞)
desktop:  显示 Approval Card
user:     点击 "Allow once"
desktop:  { kind: "approval_response", approvalId: "a1", decision: "allow_once" }
bridge:   (generator 恢复，调用 super().dispatch())
bridge:   { kind: "tool_call_start", toolCallId: "tc1", toolName: "code_run", ... }
bridge:   { kind: "tool_call_progress", text: "[Action] Running python..." }
bridge:   { kind: "tool_call_end", toolCallId: "tc1", status: "success", resultPreview: "..." }
bridge:   { kind: "turn_end", turnIndex: 2, summary: "...", toolCalls: [...], toolResults: [...] }
```

如用户选 `deny`：

```
desktop:  { kind: "approval_response", approvalId: "a1", decision: "deny" }
bridge:   (generator 恢复，short-circuit；不调用真实 tool method)
bridge:   { kind: "tool_call_end", toolCallId: "tc1", status: "denied", resultPreview: "User denied this action" }
bridge:   { kind: "turn_end", ... }   (agent 收到 denied 状态，下一轮决定如何应对)
```

## 7. Session Resume Flow

```
spawn bridge with sessionId="sess_old"
bridge:   { kind: "ready", ... }
desktop:  { kind: "set_approval_rules", ... }
desktop:  { kind: "load_history", messages: [...] }
bridge:   { kind: "history_loaded", messageCount: 12 }
desktop:  { kind: "user_message", text: "继续之前的话题" }
          (agent_runner_loop 启动，client.backend.history 已含 12 条历史)
bridge:   { kind: "turn_start", ... }
          ...
```

## 8. Error Handling

| 场景 | bridge 行为 | desktop 行为 |
|---|---|---|
| 字段缺失 / 类型错误 | emit `error`，丢弃命令 | 显示错误，不重试 |
| 协议版本不匹配 | （ready 后 desktop 检查） | 立即 `shutdown` |
| GA import 失败 | emit `error` 后 exit(1) | 标记 session error |
| LLM 调用失败 | 由 GA agent 内部处理；可能 emit 多个 `error` | 透传给用户 |
| bridge 进程崩溃 | stdout EOF + exit code != 0 | 标记 session error，可选重启 |
| 用户 close session | 发 `shutdown` | 等 stdout EOF + reap |

## 9. Versioning

- 当前版本：`0.1`
- 不兼容变更必须升 minor 版本号（`0.1` → `0.2`）
- desktop 与 bridge 版本不匹配 → desktop 主动 shutdown
- 兼容性变更（仅新增可选字段）可保持版本号

## 10. Open Items（实现阶段确认）

- [x] **`load_history` messages 数据结构** — 已 e2e 验证：`NativeClaudeSession` 的 `backend.history` 是 `[{role, content: [{type:"text", text:str}, ...]}]`（Anthropic native messages 格式）。`bridge/workbench_bridge.py:_load_history` 把 desktop 传来的简单 string content 适配为 native blocks。**未验证**：`NativeOAISession` / `ClaudeSession` / `LLMSession` / `MixinSession` 的 history 形态可能不同，需要对应 adapter。当前 V0.1 只在 `NativeClaudeSession` 下保证恢复语义。
- [ ] `tool_call_progress` 字符串解析规则（GA 当前 yield 的 emoji 前缀格式）需在 bridge 实现时记录到 `bridge/handlers.py` 注释，避免 GA 升级时格式变化无人知晓 — V0.1 暂不实现 progress 事件，turn_end 已含完整 toolCalls/toolResults
- [ ] images 字段的传递路径（user_message → GA put_task）需在 bridge 验证可行 — bridge 已通过 `images=cmd.images` 透传到 `agent.put_task`，但实际多模态调用未 e2e 验证
- [x] **`abort` 路径** — GA 的 `abort()` 设 `stop_sig` 让 worker 跳出循环，但**不**触发 `turn_end_callback`。bridge 在 `dispatch_command` 收到 `AbortCommand` 时主动合成 `RunCompleteEvent` with `exitReason.result = "ABORTED"`。e2e 已验证。
