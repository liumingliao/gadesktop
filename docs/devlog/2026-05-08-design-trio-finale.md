# 设计三连收尾 + file_patch diff 视图 + Error Card hint 系统

> Date: 2026-05-08（一天第二个 entry）
> Status: aligned + shipped（IPC + bridge + 测试）
> Related: PRD §11.4 / §17.4 · [docs/DESIGN.md](../DESIGN.md) v0.2 完整版 · [docs/ipc-protocol.md](../ipc-protocol.md) §4.10 修订 · 上一篇 [2026-05-08 onboarding + LLM switching](./2026-05-08-onboarding-and-llm-switching.md)

## Context

接续上午的 onboarding/empty/health/LLM 三连，下午把 DESIGN.md v0.2 的最后三块空缺补齐：**Error Card / Command Palette / Settings**。三个组件设计完，即可一次性合并 v0.2 完整版，开始 Stage 2 桌面端骨架。

中途作者抛了三个外部链接（Pierre Computer Co. 的 [diffs.com](https://diffs.com) / [trees.software](https://trees.software) + 不相关的 [code.storage](https://code.storage)）让评估对 Workbench 是否有用。Diff 渲染库 `@pierre/diffs` 当场被识别为 V0.1 应该用的工具 —— 直接影响了 Approval Card 的范围决策（file_patch 是否在 V0.1 给 diff 视图），结论是**做**。

## Decisions

### Error Card 三层模型

PRD/DESIGN 之前没有错误统一表达。本次定下三轴分类：

- **Category** = 决定显示位置：
  - `runtime`（GA / LLM / tool 错误）→ Conversation 流内 inline message bubble，紧跟出错 tool callout 之后
  - `bridge`（bridge 自身故障 / IPC mismatch / handler crash）→ top-level toast
  - `business`（用户操作引发的可恢复错误：路径非法、SQLite 损坏、历史恢复失败）→ top-level toast
- **Severity** = 决定颜色与 icon：`error` / `warning` / `info`
- **Retryable** = bridge 层的 hint，让 desktop 显示 Retry button；点击 = 触发新的 `user_message`，**bridge 不主动 retry**（避免隐藏副作用）

为什么 bridge 端给结构化字段而不是 desktop 字符串模式匹配：bridge 离异常源最近，分类最准；desktop 推断会复刻一套对错误来源的理解，新增类型时容易漏判。一致原则：bridge 是 truth，desktop 是 view。

### Hint 系统（错误翻译）

bridge 端 `_classify_error` 检测错误关键字，emit ErrorEvent 时附 `hint` 字段，desktop 渲染专用引导卡片：

- `check_llm_config`（401/403/`api_key`/`unauthorized`）→ "LLM 配置可能有问题" + Actions: 检查 mykey.py / 查看 GA 文档 / View raw error
- `network`（timeout/DNS/connection refused）→ "网络无法连接" + Retry / View raw error
- `quota_exceeded`（429/quota/rate_limit）→ "API 配额耗尽，可切换其他 LLM 继续" + Switch LLM / View raw error
- 未命中 → 标准 Error Card

**为什么这是关键产品价值**：普通用户看到 "401 Unauthorized" 不知道下一步。"哪里出错 → 怎么解决"的翻译是 Workbench 比裸跑 GA 增值的关键点。

实现：`bridge/workbench_bridge.py` 加 `_ERROR_HINT_PATTERNS` 元组（按优先级排序的 keyword 集合）+ `_classify_error(message, category) -> (hint, retryable)` 纯函数。仅 runtime 类错误进入 hint 推断，bridge / business 错误一律无 hint（场景与可操作建议都不同）。

### Health Check 跳过 dry-run 的决定保留

之前定过的：onboarding 不发真实 LLM 请求验证（避免烧 quota）。结合 hint 系统重新评估：保留决定。逻辑链是"首次 message 失败 → bridge 检测 LLM 错误 → 附 `check_llm_config` hint → desktop 显示引导卡片"，比"每次启动都烧 quota"更对。引导卡只在真出问题时打扰用户。

### Command Palette：少而精

形态：⌘K 居中 overlay（不贴顶；居中更聚焦不挡 Top Bar）/ 560px 宽（不顶天立地）/ `surface-elevated` + `shadow-elevated` + 14px 圆角。

V0.1 范围收敛到 Session 类（最近 8 个 + title 模糊搜索 + "New chat" 永远首位）+ 5 个 Action（Switch LLM 嵌套 / Re-run health check / Open settings / Toggle inspector / Attach GA folder）。**故意排除**：跨 session 全文搜索、Theme switcher、Quick prompt insertion、destructive actions。

#### Empty state "Enter 直接发问"

输入有内容但无匹配时，给"Enter 直接发问？"出口（输入内容直接当 new chat 的第一条 prompt）。这是对"文档对话工作台"心智的延伸 —— 不让用户走死路。

#### 只 ⌘K 不加 ⌘P 别名

VS Code 习惯不引入。Workbench 不是 IDE，键位约定遵循 Notion / Linear（⌘K 单口径）。

### Settings：独立窗口 / 即时生效

独立窗口（不是 modal / 不是 route 替换）：用户经常需要"边设置边看主界面有没有变化"，而且 macOS 原生应用范例（System Settings / 1Password / Linear）都是这个形态。720×560 / resizable / 不能多开。

V0.1 三个 tab：**Runtime**（GA path / Bridge Python / Re-run health check）/ **Approval**（审批工具列表 + always-allow 规则查看与撤销）/ **About**（版本 / GA baseline / 链接 / MIT）。General / LLM / Data / Shortcuts / Developer 推到 V0.2+。

**没有 sticky save button**：所有改动即时生效 + 自动持久化。"不要让用户思考"原则的硬约束；破坏性改动单独 confirm dialog。

#### GA path 改动 → prompt 重启

不悄悄 kill 所有 session（太隐式），不立刻重启（破坏当前工作）—— 弹 confirm dialog "路径改动需要重启 Workbench 才能生效。立即重启？/ 稍后"。比"自动猝死"更安全。

#### Approval rules 改动 → toast 提示已应用

bridge 用 shared mutable 引用，规则改了立刻生效到所有 session。这"太隐式"对用户，所以 desktop 改动后弹 toast "已应用到所有 session" 让用户确认副作用。

### file_patch diff 视图进 V0.1（推翻"V0.2 候选"判断）

最初我（Claude）建议把 file_patch diff 视图推到 V0.2，作者反驳"反正用现成开源方案，V0.1 就要加"。复审后承认作者对：

- file_patch 是 V0.1 审批高频工具（4 个默认审批工具之一）
- 没有 diff 视图 = 用户在"审批黑盒"（工具名 + 一团 raw args，靠想象决定 allow/deny）
- 这违反 Workbench 的根本承诺："让用户在重要决策前看到完整上下文"
- "推到 V0.2" 是工程懒惰的伪装，不是产品判断
- `@pierre/diffs` 是开源 React 组件 + Shiki 栈，跟 Tauri + React + shadcn 完全兼容；不需要自研 diff 算法

工程层：调研 GA baseline 的 `file_patch(path, old_content, new_content)` 签名，**args 字典在 dispatch 拦截时已含完整三元组**。bridge 不需要任何额外处理，desktop 拿到 ToolCalled 事件就能用 `@pierre/diffs` 直接渲染 split diff。零 IPC 风险，零 bridge 改动。

### file_write 内容预览不能做（GA 架构限制，不强行突破）

`do_file_write` 在 dispatch **之后**才从 `response.content` 通过 `extract_robust_content` 提取实际内容。审批拦截时 args 里只有 path + mode。

要做内容预览得复刻 GA 的 extract 逻辑提前预览，**违反非侵入宪法第 4 条**（不复刻 do_* 工具实现）。所以：

- V0.1：file_write 审批 Card 显示 path + mode + muted 一行 "内容由 LLM 当前回复决定，将写入此文件"
- 用户靠 path 和 mode 判断（"在 ~/Documents 下 overwrite 未知文件 → 拒"）
- V0.2+：可以给 GA 上游提 PR，让 `extract_robust_content` 前置到 args 准备阶段；这是 Workbench 反向贡献给 GA 的潜在价值点

### Pierre Computer Co. 工具评估

| 工具 | 用途 | 对 Workbench |
|---|---|---|
| `@pierre/diffs` | Diff 渲染（Shiki + React） | **V0.1 用**：file_patch 审批 Card 的 split diff 视图 |
| `trees.software` | Tree component（React/vanilla/SSR） | **不相关**：sidebar 是平铺时间分组，不是 tree；Project 二层 group 不需要 tree 库 |
| `code.storage` | API-first Git 托管平台 | **不相关**：Workbench 是单机桌面，跟远程 Git 基础设施正交 |

**记一笔**：Pierre 这家公司值得记 —— 如果未来 V0.2+ 加 file explorer / repo browser，trees + diffs 是配套的 dev tooling。

### IPC `ErrorEvent` 字段扩展（v0.1 协议内追加，可向后兼容）

```python
@dataclass
class ErrorEvent:
    sessionId: str
    message: str
    category: str = "bridge"     # 新增
    severity: str = "error"      # 新增
    retryable: bool = False      # 新增
    hint: str | None = None      # 新增
    context: str | None = None
    traceback: str | None = None
    timestamp: str = ...
    kind: str = "error"
```

四个新字段都有默认值 —— 现有 `_emit_error(message, tb)` 调用点保持工作（默认 bridge 类）。新调用点用 keyword args 指定 category / context（已修 set_llm / load_history / approval timeout / approval_response 错误等场景）。

### DESIGN.md v0.2 完整版定稿

之前 DESIGN.md 是 placeholder 指向 devlog。本次合并所有对齐内容写出完整 spec（约 600 行）：

- §1 设计哲学（Notion + Claude，三个统摄性约束）
- §2 完整 token 系统（色板 / 字体 / icon / 阴影 / 间距）
- §3 整体布局
- §4 七大组件 spec（Top Bar / Sidebar / Conversation / Composer / Tool callout / Approval Dock + Card / Inspector）—— 含 Approval Card 的工具特定渲染（file_patch diff / file_write 限制 / code_run / start_long_term_update）
- §5 Onboarding 4 步 wizard
- §6 卡片家族（Health Check / Error）—— 含 hint 系统对应的引导卡片表
- §7 Empty state hero composer
- §8 Command Palette
- §9 Settings
- §10 全局快捷键
- §11 已知未决与扩展方向
- §12 与 Notion 历史稿关系

## Rejected alternatives

- **Error Card 让 desktop 字符串模式匹配错误来源**：bridge 离异常源最近，结构化字段更对（类比"业务规则放后端，不放前端"）
- **Error Card 不分 category 一刀切**：toast 类（bridge 故障）跟 inline 类（runtime 错误）渲染位置和情绪都不同，必须分
- **bridge 主动 retry LLM 调用**：隐藏副作用、不可观测；改为 `retryable` hint 让 desktop 给 Retry button，用户主动触发新 send_message
- **Health Check 加 dry-run（应对 LLM 配置错误）**：保留跳过决定 + hint 系统首次失败友好引导，比每次启动烧 quota 划算
- **Command Palette 加 ⌘P 别名**：VS Code 习惯，引入会让键位约定混乱；少而精
- **Command Palette 贴顶（Linear 风）**：贴顶遮 Top Bar 状态信息；居中聚焦感更强
- **Command Palette 顶宽满版**：Workbench 整体偏文档气质，560px 居中更轻盈
- **Command Palette 加最近搜索历史持久化**：V0.1 简化，每次开干净
- **Command Palette 加跨 session 全文搜索 / quick prompt insertion / destructive actions**：分别属于"专门入口"（Composer search）/"已经有"（Empty state quick prompts）/"不该轻易触发"（删除 session）
- **Command Palette 平铺所有 LLM 到主列表**：LLM 多时（10+）淹没 session；嵌套二级
- **Settings 用 modal**：遮挡主视图；用户需要边设置边看效果
- **Settings 用 route 替换主视图**：丢失当前 session 上下文
- **Settings 加 sticky save button**：违反"不要让用户思考"；改即时生效
- **Settings GA path 改动后悄悄重启所有 session**：太破坏；prompt 用户决策更安全
- **Settings Approval rules 改动悄悄生效**：太隐式；toast 提示已应用
- **V0.1 加 General/LLM/Data/Shortcuts/Developer tab**：light-only 中文 + per-app preference 已够 + 不做高危数据 UI + 内置快捷键够用 + stderr 调试够用
- **file_patch diff 视图推到 V0.2**（最初判断）：是工程懒惰的伪装，不是产品判断。审批黑盒违反根本承诺；@pierre/diffs 现成可用，零 IPC 风险
- **file_write 内容预览复刻 GA 的 extract 逻辑提前预览**：违反非侵入宪法第 4 条（不复刻 do_*）；接受 V0.1 限制 + 给 GA 上游提 PR 是正路
- **trees.software 用作 sidebar component**：sidebar 是平铺时间分组不是 tree；引入是过度工程
- **code.storage 接入做远程历史**：违反"本地优先 + SQLite"简洁性；用户已有 GitHub
- **DESIGN.md 留 placeholder 等 Stage 2 落实再写**：Stage 2 桌面端骨架启动前 DESIGN.md v0.2 必须完成（CLAUDE.md "DESIGN 讨论中" 状态被解除）
- **不写第二个 devlog entry，今天合并到第一个**：CLAUDE.md 允许"一天可多 entry，按主题分"；上午 onboarding 跟下午三连组件是两个不同主题，分开更清晰

## Open questions

- **Approval Card diff 视图在 desktop 实现的 max-height / 折叠规则**：DESIGN.md 暂定 480px max + scroll，超长 patch 实际跑起来体验如何待 Stage 2 验证
- **Error Card hint 关键字字典覆盖范围**：当前三类（auth / quota / network）覆盖最常见 LLM 失败模式，实际跑用户的 mykey.py 配置时可能遇到 OpenAI / Anthropic / GLM 各家特有的错误格式（中文错误？）；需要 V0.1 内测时收集真实错误样本扩词典
- **`file_write` GA 上游 PR**：是否值得给 GA 提 PR 让 `extract_robust_content` 前置；要等到 Workbench V0.1 跑稳之后再决定（V0.2 议题）
- **Command Palette long LLM list (10+) 的 UX**：当前 V0.1 简单 scroll；实际配置量大的用户可能需要二级菜单内搜索，留观察
- **Settings GA path 改动的 confirm dialog 文案 / 重启实现细节**：Tauri 的 app restart API 行为待 Stage 2 验证；可能需要 graceful shutdown 所有 bridge 子进程后再重启
- **Pierre Computer 工具的版本管理**：`@pierre/diffs` 当前是早期开源（commit 频繁），引入时需要锁版本；package.json 范围在 Stage 2 桌面端骨架启动时定

## Next

- DESIGN.md v0.2 完整版定稿 ✅（本次完成）
- IPC 协议 ErrorEvent 扩展 ✅（本次完成）
- bridge `_classify_error` 落地 + 测试 ✅（本次完成，71 unit + 6 e2e deselected by default）
- PRD §11.4 / §17.4 修订 ✅（本次完成）
- **Stage 2 桌面端骨架启动**：所有 DESIGN.md / PRD / IPC 前置条件已满足
  - Tauri v2 + React 18 + TypeScript + Vite + Tailwind + shadcn/Radix 项目骨架
  - SQLite schema（Session / Project / ToolEvent / ConversationMessage 持久化）
  - Session Manager（子进程生命周期管理）
  - 7 大组件落地（Sidebar / Top Bar / Conversation / Composer / Tool callout / Approval Dock / Inspector）
  - 6 个 overlay/window（Onboarding wizard / Empty state / Health Check Card / Error Card / Command Palette / Settings 独立窗口）
  - `@pierre/diffs` + Shiki 集成（file_patch Approval Card）
- LLM 切换器 UI（Composer 内 dropdown + popover）—— Stage 2 配套
- Per-session / per-app LLM 持久化（SQLite）—— Stage 2 配套
