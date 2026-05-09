# Stage 3 #1 端到端真跑 + 一波 dogfood UX polish

> Date: 2026-05-09（本日第三个 entry，stage 切换总结）
> Status: shipped — 16 个 commits 把 Stage 3 #1（端到端真跑验证）打通 + 借机做了 V0.1 release 必须的 UX polish + 提前做了 3 个原 V0.2 范围的功能
> Related: [PRD §6.1 七件事](../PRD.md) · [DESIGN.md §4](../DESIGN.md) · [docs/ipc-protocol.md](../ipc-protocol.md) · 上一篇 [2026-05-09 Project model](./2026-05-09-project-model-coding-agent.md) · 上一篇 [2026-05-09 YOLO mode](./2026-05-09-yolo-mode.md)

## Context

Stage 3 计划开局是 [Stage 2 收尾 devlog](./2026-05-08-stage2-desktop-skeleton-complete.md) "Next" 段的第一项：**端到端真跑 `pnpm tauri dev` + spawn bridge → user message → turn_end 全链路验证**。Stage 2 #10a/b 把 IPC 骨架接通了，但**从来没在真 Tauri runtime 跑过**——typecheck 过、unit test 过、stage 1 e2e 过 bridge 单进程，但 Tauri shell.spawn → bridge subprocess → IPC stdin/stdout → desktop store 这条路径没走过完整的一遍。

跑通的过程中发现：骨架代码大致对，但每一层都有 bug 或缺失行为。dogfood 也暴露了大量 UX 问题。一边修一边推，最终把 Stage 3 #1 + 一些原本 V0.2 的功能都做了。

## Decisions

### 端到端真跑遇到的 bug + 修复

按踩到的顺序：

**1. Bridge spawn 拒绝："program not allowed on the configured shell scope: python3"**

- Tauri v2 plugin-shell 的 `Command.create(program, args)` 第一个参数对应 capability `name` 字段，**不是** `cmd` 字段
- `capabilities/default.json` 配的 `name: "python-bridge-py3"` / `cmd: "python3"`，desktop 传 `"python3"` 当 program → scope 查不到
- 修：把 capability `name` 改成跟 `cmd` 一致（`python3` / `python`），同 `allow-spawn` / `allow-stdin-write` / `allow-kill` 三处
- 这个 bug 从 Stage 2 #10a 就潜伏，never tested in Tauri

**2. 窗口完全拖不动**

- `data-tauri-drag-region` HTML 属性加了，但 Tauri v2 还需要 `core:window:allow-start-dragging` permission
- `core:default` 默认 28 个 window permissions 里**没有** `allow-start-dragging`（不像 `allow-resize` / `allow-close`）
- 表现：webview 调用 start-dragging 静默被拒，没 console error
- 修：capabilities 显式加这条 permission

**3. TopBar 「新对话」placeholder 太挤 traffic light**

- paddingLeft=70 之后立刻是 placeholder（traffic light 16-68px + 2px 间隙）
- 而且布局不对称（title 左对齐 + actions 右对齐）— 单纯加 padding 改善间距但不解决不对称感
- 修：改为 macOS 标准三段 flex（traffic light reserve / 居中 title flex-1 / 右 actions），跟 Safari / Notion / Mail / Pages / Finder 一致
- Sidebar toggle 顺势移到 Sidebar header（logo 右侧），跟 Notion / Linear / Arc / Cursor 一致

**4. Resizable panels v4 数字 = 像素**

- `react-resizable-panels` v4 的 `defaultSize={20}` 是 **20 像素**而非 20%；`bt(value)` 内部 `case "number": return [value, "px"]`
- Sidebar 当 20px 显示，被 minSize=14（也 px）压成 ~14px，加 padding 后视觉 ~30-40px，且拖不动（minSize=14px 几乎触底）
- 修：所有 size 改 string `"18%"` / `"14%"` / `"30%"`；layout id 升 `*-v2` 让 localStorage 旧 cache 失效（schema 变更标准做法）

**5. Approval Card 不渲染（waiting_approval 占位文案 only）**

- `tool_call_pending` 加进 `pendingApprovals[]`，但 `Conversation` 只渲染 `turns[].tools[]` 里的 ToolCallout
- in-flight turn 还没 turn_end，没在 `turns[]` 里 → 没 Card 渲染
- 修最小成本：MainView 在 turns 末尾直接渲染 pendingApprovals 为完整 ToolCallout（PendingApproval 加 args 字段）
- 真正架构：V0.2 用"in-flight turn"模型（turn_start 开 pendingTurn，turn_end finalize），但工程量大且当前最小修复够用

**6. 流式占位 / Composer Stop 模式卡住（agentRunning 不清）**

- 表现：用户发"你好"→ agent 回完了，"思考中…"还在 + Composer 还是 Stop 按钮
- 真根因（在第 7 项里）：demo fallback 串台
- 加 diagnostics（console.info 所有 turn_end / dev-only `window.__store` 暴露 store）方便后续排查

**7. Phantom Approval Card 在 chit-chat turn**

- 用户发"你好"也弹 medium-risk file_patch 审批 Card："Patch file at —"
- demo fallback 逻辑：`storePending.length > 0 ? storePending : demoPending`，`demoPending` 默认返回 1 个 file_patch
- "你好" 没触发 tool dispatch → storePending 空 → fallback 到 demo
- 修：用单一 `conversationStarted = storeTurns.length > 0` 信号同时驱动 turns 和 pendingApprovals 的 fallback；用户发过任何消息 demo 完全退场

### Markdown 渲染 + Shiki 代码块（提前做的 V0.2 → V0.1）

之前 PRD/DESIGN.md 都把 markdown 渲染推到 V0.2（"#3+ concern"）。dogfood 第一次发"用 markdown 列表给我列三个 Python 优势"立刻显出问题——LLM 输出的 `**bold**` `## headers` `1.` 列表全是 raw 字符，体验崩溃。

**栈选择**：`react-markdown` + `remark-gfm` + Shiki

- 三个都是 React 生态标准（Cursor / Claude.ai / ChatGPT web 都用类似栈）
- GFM 扩展自带 table / 任务清单 / autolink，coding agent 用户高频
- Shiki 用 `shiki/core` + 子路径 `shiki/langs/<name>.mjs` / `shiki/themes/<name>.mjs` **fine-grained imports**，避开默认 entry 把所有 BundledLanguage 都 split chunk 的坑（emacs-lisp / wolfram / cpp 各 50-200 KB 死重）
- 注册 14 种语言（bash / css / diff / html / js / json / markdown / python / rust / shell / sql / tsx / ts / yaml）+ alias（js→javascript 等）
- 不支持的语言 → 无色 mono fallback，不报错

**视觉规划**：每个 markdown 元素 reuse 现有 Newsreader / Inter / JetBrains-Mono token，不为 markdown 单独引入字号 ramp。h3 故意接近正文字号避免视觉跳跃。

**bundle 增量**：~200-300 KB gzip（Shiki + WASM oniguruma 引擎 + 14 lang chunks lazy-loaded），可接受。

### Message actions（Reply Copy / Save / Code Copy）

dogfood 的另一个反馈：用户拿到长 reply 想存或者拷代码，但只能选中 → Cmd+C → 粘贴进编辑器（多步走，多数人就放弃）。

**做的**（V0.1）：
- **Reply 级 Copy**：复制 markdown source（不是渲染后纯文本）—— 粘贴目的地（Notion / Obsidian / Slack / 邮件）多数 re-render markdown
- **Reply 级 Save**：Tauri save dialog → `.md` 文件，默认名 `ga-{YYYYMMDD-HHmmss}.md`
- **Code block 级 Copy**：每个代码块 header 右侧 hover-revealed Copy 按钮，复制纯代码（无 fence、无 markdown）

**没做**（推 V0.2 / 后）：
- **Regenerate** — 需要 GA history 回滚 + 跨 turn 状态管理，工程量大（跟 multi-session / session 恢复一并设计）
- **Continue** — 用户输入"继续"即可，不需专用按钮
- **Pin / Branch / TTS / 翻译 / Share** — V0.1 不值或跟产品定位不符

**视觉**：Reply 级常驻 muted（hover-only 找不到）；Code 级 hover-revealed（resting 代码块不杂乱）。状态机 idle → ✓ Copied/Saved → idle (1.5s)。

### 滚动行为：stick-to-top + 流式 + sticky-bottom + 浮动按钮

dogfood 暴露：用户提交后看不到自己的提问（出现在视口外），需要手滑。但简单"滑到底"也不对——长 reply 会推走 user message。

**Phase 1 — Stick-to-user-message-top**（Claude.ai / ChatGPT 收敛模式）：
- store 加 `userSubmitTick` 计数器，appendUserTurn 时 +1
- MainView useEffect 监听 tick 变化（不监听 turns.length，避免 turn_end 也触发）
- RAF 推迟到 user message 真实 mount，算 offset = `top - container.top - 32`，`scrollBy({ behavior: "smooth" })`
- MessageUser 加 `data-role="user-msg"` anchor

**Phase 2 — 流式生成**（提前 V0.2 → V0.1）：

我之前把流式放 V0.2 是基于错误估计，以为 GA 没暴露 streaming hook。实际 grep GA 源码发现：**`agentmain.put_task` 返回 `display_queue`**，里面是 `{'next': delta, 'source': src}` partial chunks（fsapp.py 也用这个）。bridge 之前完全 ignore 这个返回值。

实施：
- `agent.inc_out = True`（incremental delta 而非 full snapshot），减 IPC 流量
- `_start_progress_drain(display_queue)`：每 user task 一个 daemon thread，poll queue，转 IPC `TurnProgressEvent`
- `{'done': full_text}` **不**转 IPC（turn_end_callback 已 emit canonical finalized turn，duplicate 给 desktop 没意义）
- store `inFlightContent` append delta，clear 在 appendUserTurn / appendAgentTurn / turn_start / run_complete / error
- MainView 在 `visiblePartial` 非空时渲染 MarkdownView（hide 思考中 placeholder，partial 渲染本身是 live signal）

**关键 robustness — partial tag stripping**：

GA 的 partial output 含 `<thinking>` / `<summary>` / `<tool_use>` / `<file_content>` 内部 tag，且**可能 mid-tag**（"刚收到 `<thi` 还没 `>`"）。如果不处理 user 会看到 GA scaffolding 闪过。

`cleanPartialContent` 4 步算法：

1. Strip 完整 `<tag>...</tag>` block
2. 找 leftmost unclosed open tag → 截断
3. 找 trailing partial open-tag start（"<thi" / "</sum"）→ 截断
4. Strip `[FILE:...]` refs + 折叠空行

效果：用户在任何 sampling instant 都看不到 GA 内部 scaffolding flash 过。

**Sticky-bottom + scroll-to-bottom button**：
- `atBottom` flag（24px tolerance）通过 scroll listener 维护
- atBottom 时 `useLayoutEffect` 监听 inFlightContent 变化把 `scrollTop = scrollHeight`（synchronous，避免一帧的 drift）
- atBottom = false 时右下角浮动 ⬇ 按钮（36px 圆形 ghost）出现
- 点 ⬇ → smooth 滚到底 + atBottom = true

**stick-to-top 跟 sticky-bottom 不冲突**：前者只在 user submit 触发，后者只在流式跟 atBottom 时触发。

### Conversation polish（一系列小动作）

- **Thinking placeholder**：user 提交后立刻显示 "💭 思考中…"，turn_end 替换；store 加 `agentRunning: boolean` + `setAgentRunning`，submit 时 set true 不等 turn_start IPC（masking LLM TTFT）
- **Turn marker**：`Turn N` 11px Inter mono uppercase soft 在每个 AgentTurn 头部，N 来自 GA-side `turnIndex`（一个 user message 可触发多 GA turn）—— 之前误以为是 user↔agent 对话轮次错了
- **SoftHr 演化** my-9 → my-6 → my-5 → 删除：4 轮调整后认识到 hr 本身就是问题（不是 margin），干脆让 TurnMarker 自带 `mt-7` + `tracking-[0.12em]` 承担 turn 间章节分隔
- **TopBar Settings gear**：替换之前 dead 的 `...` More 按钮，⌘, 之外加可见入口
- **Empty state 极简**：删底部 "⌘K · ⌘N · ⌘\" hint 行，避免稀释 "你想做什么？" 聚焦感；快捷键搬到新增的 **Settings → Shortcuts tab**（V0.1 read-only，rebind 留 V0.2）
- **Settings → About cleanup**：作者署名改 wangjc683 / Links 收成单条 GitHub URL / 加大 Links section 上方间距让排版不挤
- **Composer Stop 真接通**：之前 `isRunning` 是 demo 启发式，现在接 `agentRunning` 真值

### V0.1 七件事进度（截至本 commit）

| # | 七件事 | 状态 |
|---|---|---|
| 1 | Attach 已安装 GA + Health Check | 🟡 走通但 step 1 / step 2 是 mock |
| 2 | **多 session 并行** | ❌ 单 session（store `_bridgeClient` 单例） |
| 3 | Tool Timeline 结构化事件流 | ✅ |
| 4 | 审批 / 拒绝高风险工具 | ✅（含 YOLO 出口） |
| 5 | **历史 session 列表 + 回看 + 继续聊** | ❌ Sidebar 显但点了不能继续 |
| 6 | Sidebar session row 状态展示 | ✅（含 turn marker / summary） |
| 7 | Composer LLM 切换不丢上下文 | ✅ |

剩 **#2 + #5**——两块紧耦合（共享 store schema 改造），合起来是 Stage 3 最大的工程块。剩下 #1 mock validation / Settings path picker / tool_events 持久化 / macOS bundling 都是收尾。

## Rejected alternatives

整个 stage 中考虑过但被否的：

- **`@pierre/diffs` 用于 file_patch diff**：JC 中途又记起这事，再次确认 reversal 仍正确——Shiki bundle 414 KB 暴涨的硬约束没变，自研 PatchView 仍是 V0.1 选择
- **Multi-session V0.1 这次做**：JC 明确推后；先把 polish 做扎实，#2 + #3 留下个大单元
- **Regenerate 按钮**：跨 turn 状态回滚（如果已经 file_patch 了怎么办？真撤销还是只回滚 conversation？）工程量大，推 V0.2 跟 multi-session 一并设计
- **Continue 按钮**：用户输入"继续"即可，不需专用按钮
- **Pseudo-streaming（typewriter 效果）**：不行——用户先等真完成（5-15s）再看 typewriter 反而更慢；GA 已经暴露 display_queue 真流式
- **Shiki 默认 entry**：bundle 暴涨 ~600 KB（emacs-lisp / wolfram / cpp 都被 split chunk），换 fine-grained 子路径 imports 缩到 ~200-300 KB
- **流式期间代码块实时高亮**：partial 时代码块没 close ` ``` `，markdown parser 不认作 code block；turn_end 一次替换为高亮版本是 V0.1 trade-off
- **`scrollIntoView({block: "start"})` 实现 stick-to-top**：没法控制 padding，手动算 offset + `scrollBy({ behavior: "smooth" })` 才行
- **Sidebar 折叠 toggle V0.1 接通**：toggle UI 物理位置已挪到 Sidebar header（视觉修复 done），但 onClick 接通 + ⌘\ 快捷键 + width 持久化推到 V0.1 polish 后续（10 行的事，但跟 multi-session 一起做更经济）
- **TopBar More `...` 按钮保留**：dead button 占视觉，删，Gear 取代
- **EmptyState 底部快捷键 hint 行保留**：稀释"你想做什么？"焦点，删，搬 Settings → Shortcuts tab
- **per-session YOLO mode 中间层 V0.1 一起做**：三层 toggle（call / per-tool / global YOLO）已够，再加一层 per-session 用户搞不清在哪个开关上
- **TopBar YOLO indicator 用 error 红色 / 加动效**：开 YOLO 不是出错是用户主动选；动效用户会 tune out。warning 深琥珀静态对比刚好

## Open questions

- **Multi-session bridge 生命周期**：选项 A 每个 session 常驻 bridge（启动慢 / 内存重）/ B 仅 active 跑（切换 1-2s 延迟 + 跟 session 恢复天然 reuse）/ C lazy LRU。倾向 B
- **流式期间用户切 LLM**：bridge 已校验 idle 时才切，agent 跑时 dropdown 应 disable——当前 disable 接通了 isRunning 但需要真测
- **Markdown 流式期间代码块的语法高亮闪烁**：partial 中 code block 没闭合 → 不认作 code → flow 普通文本；闭合后 → markdown parser 认作 code → Shiki async load → 高亮显示。期间用户能看到一段普通 mono 跳到高亮 block。可接受但可观察
- **Code copy 按钮 hover-only 在触屏 / 笔记本触摸板**：触屏没 hover 概念。V0.1 桌面 only，留意 V0.2 触屏支持时改 always-visible
- **Save 文件名时区**：当前用 ISO `toISOString()` UTC 时间戳。用户可能预期本地时间。等抱怨再切
- **Project section UI 实装**：spec 全在 DESIGN.md §4.2，但 sidebar 实际还是简单嵌套展示。实装跟 multi-session 一起做（store 改造时一并考虑 project 维度 state slicing）
- **Tool callout 流式过程中的状态**：当前 partial 里 `<tool_use>` tag 被 strip，用户看不到 tool 调用进行中。是否要 partial 期间展示 "正在调用 tool xxx" 提示？V0.2 流式 deeper integration 时考虑
- **`window.__store` 调试入口**：V0.1 dev-only 加上去了，production 自动消失。release 前留意

## Next

**Stage 3 #2 Multi-session + #3 Session 恢复**（一起做，共享 store schema 改造）：

预估 4-6 小时工程量，涉及大块 store 改造 + sidebar 切换驱动 + history load IPC + per-session bridge 生命周期。详见 [今天讨论中我列的范围](#) 或下次 session 启动时重新对齐。

之后 Stage 3 收尾活：

- #1 真 validation（Onboarding step 1 path / step 2 health check）
- Settings → Runtime path picker
- tool_events 表写入（Inspector Approvals 真 history）
- macOS app icon / signing / dmg

最后是 V0.1 release。

---

## 今天 commits 总览（16 个，时间倒序）

| commit | 主题 |
|---|---|
| `53ec4d5` | Streaming generation + sticky-bottom + scroll-to-bottom floater |
| `8264b7b` | Stick-to-user-message-top scroll on submit |
| `18626d7` | Message actions: Copy / Save on replies, hover Copy on code blocks |
| `675c53c` | Markdown rendering for agent output, with Shiki code highlighting |
| `975d400` | Fix phantom Approval Card on no-tool turns |
| `8892980` | Drop SoftHr; TurnMarker carries turn-to-turn separation |
| `3eb1f84` | SoftHr my-6 → my-5 |
| `13b326d` | Diagnostics: log turn_end + expose store on window in dev |
| `aba5eef` | About tab: simplify Links + spacing + byline |
| `bfc3c78` | Turn marker = GA turn count; Empty state minimal; Settings Shortcuts tab |
| `2fcc555` | Conversation polish: thinking placeholder, turn markers, spacing, Settings entry |
| `4c7c4ec` | Render in-flight Approval Card for pending tool calls |
| `88120b1` | Fix bridge spawn: capability name must match Command.create program |
| `030dca9` | YOLO mode: global approval bypass for trusting users |
| `0735cbd` | Fix window dragging + center TopBar title |
| `b3d9186` | Fix sidebar collapse to ~30px: pass percent sizes as strings |
| `ef61fd1` | Resizable sidebar / main / inspector via react-resizable-panels |
| `ac32f10` | Project model + sidebar UX: pure container for coding agent users |

（前两条独立 devlog：[Project model](./2026-05-09-project-model-coding-agent.md) / [YOLO mode](./2026-05-09-yolo-mode.md)）
