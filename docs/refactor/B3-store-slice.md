# B3 · useAppStore 拆 slice + 改订阅 Rust event

```
Cursor:   T1.1  (B3 未启动 · M1 第一个 sub-task — 静态分析 + slice 映射表)
Status:   ⏳ 未启动 · 详细 playbook 已升格 (was 117-line stub, 2026-05-19) · prereq relaxation 双层 gate (2026-05-19)
Started:  -
Last touch: 2026-05-19 — prereq 从「1 周日历仪式」改成事件驱动双层 gate (M1 / M2)，详 N1
Predecessor: B2 完成 (M1-M7 + tag b2-complete) + dogfood 1 周稳定期
Successor:   B4 (CLI feature-complete + background mode + adapter artifact)
Duration:    3-4 周估计（D31-D50+，按 PRD 节奏），但 stub 已警告"3-4 周可能拖到 5-6 周"
```

**Cursor 协议**：完成 sub-task → cursor 移到"下一个未完成的最小编号 T"。Session 结束 → cursor 必须指向"明确可以接续的位置"，不要指 in-progress。

> **B3 是整个重构最 risky 的阶段**。原因：
>
> - `gui/src/stores/useAppStore.ts` 2858 行（B2 完成时；B1 启动时 2727 行），6 个月的 dogfood UX 教训都在里面
> - 拆 slice + 改订阅 = 重新实现 React 端，80% 容易做对，20% 会以 regression 形式被 dogfood 发现
> - 不是一次性切换，是 capability by capability 渐进迁移，期间 store 同时存在新老两套机制
> - 每个 capability 迁完需要 dogfood 一天验证才能算"安全"
>
> **B3 前的心理准备**：3-4 周可能拖到 5-6 周。预算保守。

## 这个 phase 在干啥（一段话）

把 `gui/src/stores/useAppStore.ts`（单文件 2858 行）按 domain 拆成 4-5 个 slice store，每个 < 600 行。**authoritative state**（session list / messages / runtime status / bridge process state）由 Rust core 持有，slice 通过订阅 Tauri event 拿到更新（store 端是 read-only cache，不是 source of truth）。**display state**（modal open / composer text / selected ids / 滚动锚点）继续由 store 持有 — 没有其它 transport 修改它们。本 phase 结束时 [invariants.md §I6 "前端永远 stateless presenter"](./invariants.md#i6-前端永远-stateless-presenterb3) 才真正生效；B4 给 CLI 加更多写命令时 GUI 会**自动响应**（Rust 端 dispatch CLI 命令 → emit event → slice store 自动 update）。

## Prerequisites · 必须先完成

按 [CLAUDE.md「事件驱动，非日历驱动」](../../CLAUDE.md) 原则分两层 gate（2026-05-19 relaxation · [devlog](../devlog/2026-05-19-b3-prereq-relaxation.md)）。

**M1 启动门（T1.1 设计阶段进入）**：

- [x] B2 acceptance + devlog ship + tag `b2-complete`（2026-05-19 ship）
- [x] B1+B2 dogfood scenarios 列表写到 [`docs/refactor/dogfood-scenarios.md`](./dogfood-scenarios.md) — 35 项 A/B/C/D 分类（2026-05-19 落地）

**M2 启动门（开始改 frontend 代码前必须达成）**：

- [ ] scenarios JC 真跑过一遍 GA task 签字「未发现 B2 regression」— 事件驱动而非日历驱动
- [ ] B2 性能基线（first-token RTT / streaming throughput）测出来落到 `docs/refactor/perf-baseline.md` — B3 完成时用 [invariants.md §I7](./invariants.md#i7-性能-gate) 对比

理由：M1 全是 paperwork（slice mapping ADR + emit event catalogue，0 代码改动），跟 B2 dogfood 可并行无 risk。M2 起改 frontend 代码，B2 regression 跟 B3 改动一旦混在一起难定位 — strict gate 卡在 M2 前。前版「1 周日历仪式」单用户项目不可 enforce，事件驱动更诚实。

## Phase invariants · B3 特有的硬规则

跨 phase 规则在 [invariants.md](./invariants.md)。B3 特有的：

- **B3-I1**: 每个 slice 提取完成 = **dogfood 一天**才能下一个。这是硬节奏，不允许"两个 slice 一起提"积累问题
- **B3-I2**: Slice 内的 selector **不允许 React-side derivation**。所有 derived state 必须 store-side enrichment（参考 [2026-05-11 useShallow 踩坑 devlog](../devlog/2026-05-11-stage3-multi-session-and-perf.md)）— strict mode 下 getSnapshot 死循环 = app 空白，dogfood 不可恢复
- **B3-I3**: 老 useAppStore 跟新 slice **同 capability 不并存** — 每次迁移有明确的 "switchover commit"，commit 前 dogfood 跑通，commit 后老 path 立即删除。**不允许长期双轨**（双轨期间状态分裂会 surface 难 debug 的 UI 错乱）
- **B3-I4**: B3 内 **不动 Rust 端**（除了加 emit 事件的 minor patch — 加 emit 不算改语义）。如果发现 trait / Tauri command 需要改 = B3 退回 plan，独立 commit 修 Rust 后再续
- **B3-I5**: 每个 slice 文件 ≤ 600 行硬上限。超过 = 拆分。理由：B3 后 onboarding new contributor 时单文件可读性是 ROI 最高的优化
- **B3-I6**: 切到新 slice 后老 export 不留 `@deprecated` 注释，**直接 delete**。因为 B1/B2 的 @deprecated 留法是为了跨 phase 兼容；B3 是 last hop，留就再也不删
- **B3-I7**: 性能 gate：每个 slice 迁完跑一次"3 session 各 streaming 100+ event"压测，re-render 次数不变多于 B2 baseline

## Acceptance criteria · B3 算完成

按顺序逐条 demo + tick：

- [ ] **A1**: `useAppStore.ts` 拆成 4-5 个 slice 文件，每个 < 600 行（B3-I5）
- [ ] **A2**: authoritative state（session / message / runtime）写入路径 100% 走 Rust event → slice cache 更新；slice 端**没有直接 `set state` 的 mutation action** for authoritative fields
- [ ] **A3**: display state 仍在 slice 端管理，没有"假装通过 Rust 走一圈"的多余 indirection
- [ ] **A4**: 所有 SQLite 写入路径都在 Rust（gui 不再有 `persistSession` / `persistUserMessage` 等直接 SQL 写）
- [ ] **A5**: 所有 bridge / runner spawn 路径都在 Rust（gui 不再有 `spawnBridge` 业务逻辑，只有 invoke wrapper — B2 M2 已经先达成这条，B3 维持）
- [ ] **A6**: dogfood 跑遍 B1+B2 累积的 regression suite，**零 regression**
- [ ] **A7**: store 改造**不影响** v0.1 七件事 acceptance（multi-session / Tool Timeline / Approval / Session 历史 / Session 状态展示 / LLM 切换 / GA Attach）
- [ ] **A8**: dogfood 期间 useShallow 类性能问题不复发（参考 [2026-05-11 useShallow 踩坑 devlog](../devlog/2026-05-11-stage3-multi-session-and-perf.md)）
- [ ] **A9**: TypeScript / Rust 测试全过 + 性能基线不变差（[invariants.md §I7](./invariants.md#i7-性能-gate)）
- [ ] **A10**: 每个 slice 写 README / module doc 简介它 own 哪些字段、订阅哪些 event、依赖哪些其它 slice
- [ ] **A11**: 老 `useAppStore.ts` 文件清到 < 200 行（只剩 store composition / 帮助 reducer），或彻底删除 + slice 完成 composition

---

## M1 · Slice 切分设计 + 静态映射 (D31-D33)

**不**改任何代码，先纸面对齐。Slice 边界一旦定下来，M2-M5 实施基本 mechanical，所以 M1 是真正的设计阶段。

### Sub-tasks

- [ ] **T1.1** 静态分析 `useAppStore.ts`：用脚本 `grep -n "^  [a-z][A-Za-z]*[:?]"` 列出全部 fields + actions，按 domain 归类。输出到 `docs/refactor/b3-slice-mapping.md`（一次性 artifact，B3 后归档）
- [ ] **T1.2** Slice 边界 ADR：
  - **uiStore**：screen / paletteOpen / settingsOpen / toggle\* / activeProjectFilter / conversationWidth / toasts / yoloIntroSeen / pendingPetMigrationTo
  - **sessionsStore**：sessions list / activeSessionId / projects / activeProjectFilter (移 ui 还是这？决策) / 所有 session/project CRUD action（authoritative，通过 invoke → emit event 路径）
  - **messagesStore**：per-session `_runtimes` 的 conversation 字段（turns / pendingApprovals / pendingAskUser / inFlightContent / currentTurnIndex / approvalDecisions / userSubmitTick）+ 所有 conversation 写入 action
  - **runtimeStore**：per-session runtime 字段（llms / llmDisplayName / bridgeStatus / bridgeError / bridgePid / agentRunning / pet attachment）+ runner / LLM 切换 action
  - **prefsStore**（5 个 slice 而非 4）：gaConfig / approvalConfig / yoloMode / yoloIntroSeen / conversationWidth + persistence；理由：prefs 是独立 lifecycle（onboarding 时写一次，其它时刻几乎不动），跟 ui state 混在一起会让 prefs save 频繁触发 ui rerender
- [ ] **T1.3** 决定 `activeProjectFilter` 归属：filter 是纯 UI 状态（仅影响 sidebar 渲染）但跟 sessions 数据深耦合（filter 决定哪些 session 显示）。**暂定 sessionsStore**：filter 是 sessions 视图的一部分，跟 sessions list 同 slice 减少 cross-store subscribe
- [ ] **T1.4** 决定 `_bridgeClients` / `_lruOrder` / `_stderrTails` 模块级 Map 去向：B2 M2 已经让它们行为变成"代理 Rust state"。**B3 内删除全部三个** —— Rust 端 RunnerManager 是 ground truth，TS 端缓存 `bridgePid` 在 runtimeStore 即可。任何调用方原来用 `getBridgeClient(sid)` 的，改 invoke `runner_stderr_tail` 或直接读 runtimeStore
- [ ] **T1.5** 选 store 库 (O1)：**沿用 Zustand**。理由：(a) JC 熟悉 + dogfood 稳定 (b) 小 bundle (c) Redux Toolkit 跟 slice 模式集成更好但要重学 (d) Jotai atom-based 跟当前 selector pattern 距离大。**Strict mode 兼容**通过 store-side enrichment 解决（B3-I2），不靠换库
- [ ] **T1.6** 选 event batching window (O2)：**16ms (单帧)** for streaming `turn_progress` events。理由：低于 16ms 多个 event 在同一帧渲染只会消耗 React，user 看不到差别；高于 16ms (50ms 等) streaming 字符延迟肉眼可见。Rust 端在 [`runner_commands.rs`](../../core/src/runner_commands.rs) `spawn_emit_task` 加 batch 逻辑 — 收 16ms 内的多个 `turn_progress` 合并成一个 event，TS 端把 delta 拼起来
- [ ] **T1.7** Selector 设计 (O3)：每个组件订阅 path 长度 ≤ 2 layers (`useSessionsStore(s => s.activeSession)` not `useStore(s => s.sessions.list[0].turns[3].x)`)。**store-side enrichment** 把 derived value 物化成 cached field
- [ ] **T1.8** Slice 间依赖 graph：画 DAG（5 个 slice 之间允许的 reference 方向）。预想：uiStore 顶部，sessionsStore + runtimeStore + messagesStore + prefsStore 平级。**禁止 cyclic**
- [ ] **T1.9** Rust 端 emit event 清单：B2 M2 已经 emit `runner-event` / `runner-malformed` / `runner-closed`。B3 需要补 emit：
  - `sessions-updated`：session list / status / pinned / has_unread / lastActivityAt 任何变更
  - `messages-appended`：单 session 新 message (turn / approval / inFlight)
  - `projects-updated`：project list 变更
  - `prefs-updated`：prefs 变更 (rare)
  - 每个 event 携带变更类型 + 最小 delta（避免 emit 整个 list）
- [ ] **T1.10** M1 commit：仅 `docs/refactor/b3-slice-mapping.md` + ADR 文件，**0 代码改动**。message：`Docs: B3 M1 — slice boundary design + Rust emit event catalogue`

---

## M2 · uiStore 抽离 (D34-D35)

最安全的 slice — 全部 display state，没有跨进程同步。从这里开始建模式。

### Sub-tasks

- [ ] **T2.1** 新建 `gui/src/stores/ui.ts`（命名风格：`<domain>.ts`，不带 `Store` suffix；hook 是 `useUiStore`）
- [ ] **T2.2** 把 screen / paletteOpen / settingsOpen / toggle 系列 actions 迁过来。**保留 `useAppStore` 老 hook 暂时 alias** 到 useUiStore — 调用方零改动，慢慢迁 import path
- [ ] **T2.3** 把 conversationWidth + setConversationWidth 迁过来（prefs 但只读路径多，留 ui 暂行；M6 prefs slice 时再评估搬不搬）
- [ ] **T2.4** 把 toasts / pushToast / dismissToast 迁过来
- [ ] **T2.5** 调用方 import 切换：grep `useAppStore` 所有用到 ui 字段的 site，改 `useUiStore`。`__legacy/useAppStore.ts` 同步删除已迁字段（B3-I3 不允许双轨）
- [ ] **T2.6** Dogfood：开 Galley 跑常用 UI 路径 — palette open/close / settings open / toast 弹 / sidebar 三栏切宽窄 / Onboarding 流程 — **全部行为不变**
- [ ] **T2.7** TS typecheck + lint 全过
- [ ] **T2.8** M2 commit：`Refactor: B3 M2 — extract uiStore (display state)`
- [ ] **T2.9** **Dogfood 1 天**（B3-I1）— JC daily driver 跑 24h+，无 regression 才进 M3

---

## M3 · runtimeStore 抽离 + 订阅化 (D36-D40)

把 per-session runtime 字段从 `_runtimes` Map 拆到独立 slice。这一步开始动 authoritative state — 严格按 B3-I2 store-side enrichment。

### Sub-tasks

- [ ] **T3.1** 新建 `gui/src/stores/runtime.ts`。runtime per-session map: `Record<sessionId, RuntimeState>`. fields = `llms` / `llmDisplayName` / `bridgeStatus` / `bridgeError` / `bridgePid` / `agentRunning` / `pendingLLMIndex` / `pendingPetMigrationTo`
- [ ] **T3.2** **Active session projection**：跟当前 useAppStore 一样，top-level fields mirror `_runtimes[activeSessionId]` 让现有 `const llms = useAppStore(s => s.llms)` 选择器零改动。Active id 来源订阅 sessionsStore (M4 完成前先 read useAppStore.activeSessionId)
- [ ] **T3.3** Rust 端 emit `runtime-updated` event（M1 T1.9 列了）：每次 RunnerManager 状态变化 emit `{sessionId, bridgeStatus, bridgePid, agentRunning}`。事件源 in `runner_commands::spawn_emit_task` 已有的 broadcast subscriber loop — 检测 IpcEvent::Ready / TurnStart / TurnEnd / RunComplete 触发对应 emit
- [ ] **T3.4** 起 `listen("runtime-updated")` in store init，update Map 字段。**避免 listen 重复注册**：app lifetime 一个 listener，不在 effects 内动态 add/remove
- [ ] **T3.5** 迁 spawnBridge / shutdownBridge / shutdownAllBridges / sendIPCCommand actions。但这些其实是 B2 M2 已经做的 thin wrapper — 在这步主要是把它们 location 从 useAppStore 移到 runtimeStore
- [ ] **T3.6** 迁 replaceLLMs / selectLLMForNewSession / warmupLLMList
- [ ] **T3.7** Pet attached 状态：petAttachedSessionId / setPetAttachedSession / setPendingPetMigration 迁过来（属于 runtime 范畴）
- [ ] **T3.8** 删 useAppStore 中已迁字段 + actions
- [ ] **T3.9** Dogfood scenario list 跑：
  - spawn 3 个 session，verify bridgeStatus / bridgePid 实时显示
  - LLM 切换 per-session
  - bridge crash 模拟（kill -9 workbench_bridge）→ verify onClose toast + state cleanup
- [ ] **T3.10** M3 commit + **Dogfood 1 天**

---

## M4 · sessionsStore 抽离 + 订阅化 (D41-D44)

动用户感知最强的 slice — sidebar 渲染、unread 状态、session CRUD 全靠它。每个 sub-feature 迁完都要小 dogfood。

### Sub-tasks

- [ ] **T4.1** 新建 `gui/src/stores/sessions.ts`。fields = `sessions: Session[]` / `activeSessionId` / `projects: Project[]` / `activeProjectFilter`
- [ ] **T4.2** **Authoritative path**：所有 session CRUD 改 invoke Rust trait method (B2/B3 trait 必须有 `create_session` / `archive_session` / `delete_session` / `rename_session` / `update_session_pinned` / 等 — **B3-I4 警示**：如果 Rust 端 trait 缺这些，停下来加 trait method 独立 commit 然后续 B3)
- [ ] **T4.3** Rust 端 emit `sessions-updated` event with delta payload (`{kind: "added" | "removed" | "patched", sessions: SessionBrief[]}`)
- [ ] **T4.4** 迁 setActiveSession / createSession / activateSession / bumpSessionAfterTurn
- [ ] **T4.5** 迁 archiveSession / unarchiveSession / renameSession / togglePinSession / deleteSessionPermanently + Bulk variants
- [ ] **T4.6** 迁 createProject / updateProject / deleteProject / assignSessionToProject / setActiveProjectFilter
- [ ] **T4.7** 迁 emptyArchive
- [ ] **T4.8** 删 useAppStore 中已迁字段 + actions
- [ ] **T4.9** Dogfood scenarios:
  - sidebar 三态 (active / archived / earlier) 切换
  - bulk archive / unarchive / delete
  - project filter on/off
  - drag to project / move to project
  - search in CommandPalette 返回 session 跳转
  - "新对话" 创建 → activate → 显示
- [ ] **T4.10** M4 commit + **Dogfood 1 天**

---

## M5 · messagesStore 抽离 + 订阅化 (D45-D49)

最复杂的 slice — 流式 token、ask_user 阻塞、approval 暂停 + auto-scroll snap 互动多。

### Sub-tasks

- [ ] **T5.1** 新建 `gui/src/stores/messages.ts`。per-session `Record<sessionId, ConversationState>`: `{turns, pendingApprovals, pendingAskUser, inFlightContent, currentTurnIndex, approvalDecisions, userSubmitTick}`
- [ ] **T5.2** Rust 端 emit `messages-appended` event with payload (`{sessionId, kind: "turn" | "approval" | "askUser" | "inFlightDelta", payload}`)
- [ ] **T5.3** **批处理 streaming `turn_progress`**：M1 T1.6 决定 16ms batch — `spawn_emit_task` 内累积 inFlightDelta 16ms 内 multiple progress events 合成单个 emit。**关键**：避免 React 端 token-by-token re-render
- [ ] **T5.4** 迁 appendUserTurn / appendSideQuestionUserTurn / appendAgentTurn / appendSystemTurn
- [ ] **T5.5** 迁 addPendingApproval / removePendingApproval / recordApprovalDecision
- [ ] **T5.6** 迁 setPendingAskUser
- [ ] **T5.7** 迁 setAgentRunning / setCurrentTurnIndex / appendInFlightDelta / clearInFlightContent
- [ ] **T5.8** 迁 clearConversation / restoreSessionTurns
- [ ] **T5.9** **Auto-scroll snap behavior** 验证：迁完后 Conversation 组件的 follow-bottom 逻辑必须不变 — turn_end commit 触发 snap、user scroll up 解除 follow、新 user message 重新 snap
- [ ] **T5.10** 删 useAppStore 中已迁字段 + actions
- [ ] **T5.11** Dogfood scenarios:
  - 发 message → streaming 流出 → turn_end 完成
  - approval 拦截 → Card 显示 → approve → tool 跑通
  - ask_user 弹出 → 输入回复 → 继续
  - /btw side question → SystemMessageBubble 渲染
  - 长对话 ⌥↑/⌥↓ 跳 user msg / dot rail / 长 msg 折叠
  - history restore（关 Galley 重开，session active 时 replay history）
- [ ] **T5.12** M5 commit + **Dogfood 1 天**

---

## M6 · prefsStore + useAppStore 收尾 (D50)

最后清理：prefs slice 抽出、原 useAppStore 文件清到 composition only。

### Sub-tasks

- [ ] **T6.1** 新建 `gui/src/stores/prefs.ts`。fields = `gaConfig` / `approvalConfig` / `yoloMode` / `yoloIntroSeen` / `runtimeInfo`
- [ ] **T6.2** 迁 setGAConfig / setApprovalRequiredTools / removeAlwaysAllow / setYoloMode / acknowledgeYoloIntro
- [ ] **T6.3** Rust 端 emit `prefs-updated` event (rare — 仅在 setPref invoke 内 emit)
- [ ] **T6.4** 迁 hydrateFromDB → 协调 5 slice 在 init phase 调各自的 fetch action（不是单一 hydrateFromDB action）
- [ ] **T6.5** 迁 seedMockSessions（demo 模式）
- [ ] **T6.6** `useAppStore.ts` 清到 < 200 行（B3-I5）或彻底删除 + AppShell 直接 import 各 slice。**推荐删除**：composed store 是过渡 artifact
- [ ] **T6.7** 全仓 grep `useAppStore` 还剩多少 import — 应该 0 (T2.5 / T3.8 / T4.8 / T5.10 / T6.6 都该清掉)
- [ ] **T6.8** TypeScript / lint / cargo check 全过
- [ ] **T6.9** Dogfood 1 天
- [ ] **T6.10** M6 commit: `Refactor: B3 M6 — extract prefsStore + retire useAppStore composition file`

---

## M7 · B3 acceptance + 收尾 (D50+)

### Sub-tasks

- [ ] **T7.1** 跑遍 acceptance criteria A1-A11，每条勾掉
- [ ] **T7.2** 性能基线对比 B2：streaming throughput / re-render 次数 / first-paint after activate. [invariants.md §I7](./invariants.md#i7-性能-gate) 过线
- [ ] **T7.3** **Dogfood 1 周稳定期** — 长 task / multi-session / /btw / approval reject / abort / shutdown 全部 cover
- [ ] **T7.4** 写 B3 完成 devlog: `docs/devlog/YYYY-MM-DD-b3-store-slice-complete.md`
  - 5 个 slice 文件路径 + 行数
  - 每个 slice 订阅的 event 清单
  - dogfood 1 周发现的 regression (如有) + 修复
  - useShallow 类性能问题预防记录
- [ ] **T7.5** 更新 `docs/refactor/README.md`：dashboard B3 → ✅；cursor 指向 B4
- [ ] **T7.6** 更新 `CLAUDE.md` 阶段表：B3 ✅ COMPLETE
- [ ] **T7.7** **写 B4 playbook**（stub 升格）— 跟 B2/B3 同样路径，dedicated session
- [ ] **T7.8** Commit + tag: `git tag b3-complete`

---

## Running notes / gotchas

**Append-only. Don't delete. 旧的判断错了追加新条说明。**

### 写在前面的已知 gotcha（开 B3 前要注意）

- **G1 (T1.1)**: useAppStore 2858 行 (B2 ship 时实测) — 静态分析脚本要承认现实：grep + manual review 比纯脚本可靠。**预算 4-6h 做 M1**，不要硬塞到一天
- **G2 (T1.6 batch streaming)**: 16ms batch 是单帧。但 Rust 的 `spawn_emit_task` 是 tokio 任务，跟 React 渲染帧无直接对齐 — batch window 跟 React frame 不会对齐。**实测**: streaming token rate 通常 50-100 token/s，16ms 内 1-2 个 progress event，batch 收益主要在 React state update 次数减半，re-render 总次数减半。如果实测发现 batch 收益不明显，考虑 batch 32ms 但不超过 50ms (用户感知阈值)
- **G3 (T1.7 store-side enrichment)**: [2026-05-11 useShallow 踩坑 devlog](../devlog/2026-05-11-stage3-multi-session-and-perf.md) 记录的根因：React 19 strict mode getSnapshot 必须 returns same reference for same input。**任何 selector** `useStore(s => s.x.filter(...).map(...))` 都会触发死循环。**正确路径**：store action 内 derive，存到 store 字段，selector 只 `s => s.cachedDerivedField`
- **G4 (T3.3 / T4.3 / T5.2 emit overhead)**: Rust → Tauri emit 调用本身有序列化开销（serde_json 序列化整个 payload）。**避免 emit 整个 session list**: emit delta only (`{kind: "patched", id, fields}`) 然后 slice 端 reconcile。**避免 emit per-token**: batch streaming events (G2)
- **G5 (T4.2 trait method missing)**: B2 trait 只有 send_message + 6 read methods。B3 sessions slice 需要 trait method (create_session / archive_session / delete_session / rename_session / update_session_pinned / set_active 等)。**B3-I4 警示**：如果 trait 缺 method，**B3 停下来**先在独立 commit 加 trait method (返回 SessionBrief / void)，**不要**在 B3 commit 内夹带 trait 改动
- **G6 (T5.3 streaming batch 跟 inFlightContent reconcile)**: TS 端 `inFlightContent` 是累加字符串。如果 Rust 端 batch 多个 delta，emit 时需要 send concat'd delta or each delta 单独？**暂定**: 每个 delta 独立 event，TS 端在一帧内多个 event 触发 setState — Zustand 内部 batch React update 即可。Batch 优化主要是 Rust 端减少 emit syscall 不是减少 TS event。**Re-measure**: 实测后定方案
- **G7 (T5.9 auto-scroll regression risk)**: Conversation 组件的 follow-bottom 逻辑跟 inFlightContent / turn_end / pendingApprovals 都耦合。slice 拆分后 selector 路径变了，**effect dependency 数组可能漏 update**。Mitigation: 一次性把 Conversation.tsx 的所有 useStore subscribe 改完，跑一次 E2E scroll 测试
- **G8 (T6.6 useAppStore 删除 timing)**: 完全删除时机 — M6 内删？还是 B3 结束后留一个 alias 文件等 B4 真不需要再删？**B3-I6 已定**：直接删，不留 @deprecated。理由：留就再也不删
- **G9 (跨 milestone slice dependency 顺序)**: 严格按 ui → runtime → sessions → messages → prefs 顺序。每个上层 slice 编译时依赖底层 slice。**如果发现循环依赖** = M1 T1.8 设计错了，停下来重新画 DAG
- **G10 (event emit 顺序保证)**: Tauri emit 不保证跨 channel 顺序 (eg. sessions-updated 跟 messages-appended 可能 reorder 到达 React)。**Slice 内部** event 按发送顺序处理；**跨 slice** 操作（如 archiveSession 触发 sessions-updated + 同时 send shutdown → runtime-updated bridgeStatus closed）需要容忍 reorder。Mitigation: slice 之间不直接互相 invoke action，统一通过 Rust 端协调
- **G11 (slice 文件 600 行硬上限)**: B3-I5 是硬规则。Messages slice 是最容易超的 — 单 session conversation 字段多 + 一堆 conversational action。**Mitigation**: 如果 messages slice 超 600 行，拆成 `messages/turns.ts` + `messages/approval.ts` + `messages/streaming.ts` 多文件同 slice
- **G12 (LRU 模块级状态去向)**: B2 已经把 `_bridgeClients` / `_lruOrder` / `_stderrTails` 行为代理给 Rust。B3 内**真删**：Rust 端 RunnerManager.alive_count + per-session bridgeStatus 已经够用，TS 端的 LRU 跟踪是 dead code

### Session 跑下来追加的 notes（按日期）

- **N1 (2026-05-19, pre-T1.1)** — Prereq relaxation: 把 "B2 完成后 dogfood 1 周稳定期" 单层 gate 拆成「M1 启动门」（轻，scenarios 列表先写）+「M2 启动门」（重，scenarios JC 真跑过签字 + perf baseline 测好）。理由 + rejected alternatives 详 [devlog](../devlog/2026-05-19-b3-prereq-relaxation.md)。**触发**：B2 ship 当天 JC 想推 B3，发现单层 gate 跟 B2 完成 devlog 自己的话（"the dogfood period is an empirical confidence-building step, not a gating contract"）+ CLAUDE.md「事件驱动，非日历驱动」原则双重冲突，且 T1.1（pure paperwork）跟 M2（动 frontend 代码）风险差 100×，同 gate 拦不合理

---

## Open decisions

- [x] **O1** Store 库选型 — **RESOLVED 2026-05-19 → 沿用 Zustand**（M1 T1.5 详）。Strict mode 兼容靠 store-side enrichment（B3-I2），不换库
- [x] **O2** Event batch window 时长 — **RESOLVED 2026-05-19 → 16ms (单帧)** for streaming `turn_progress`. 其它 emit 不 batch
- [x] **O3** React 端 selector 设计 — **RESOLVED 2026-05-19 → store-side enrichment + 路径长度 ≤ 2 layers**
- [ ] **O4** 老 store 最终清理时机 — **暂定 B3 内一次性删** (B3-I6)。但 M6 实施时可能发现一些 cross-slice transition action 需要 useAppStore 作 fallback shim。**M6 T6.6 实施时重新评估**
- [ ] **O5** **NEW** `activeProjectFilter` 归属：sessionsStore 还是 uiStore？M1 T1.3 定 sessionsStore，但 dogfood 时如果发现 filter 切换触发 sessions list re-fetch 过度，考虑改 uiStore (filter 是 UI view 不是数据)
- [ ] **O6** **NEW** demo seedMockSessions / DEMO\_\* fixture 去向：B3 内是否一并 retire? demo 模式现在很少用 — JC 默认起真 GA。**暂定**保留：dev / contrib 起步可能要

---

## Migration pattern · 给 B4 用的迁移模板（slice 视角）

[B1 read-path migration pattern](./B1-rust-core.md#migration-pattern--给-b2b3-用的迁移模板) + [B2 write-path 增量](./B2-bridge-ownership.md#migration-pattern--给-b3-用的迁移模板write-path-增量) 是按"capability"维度的迁移模板。B3 落地后 slice-store pattern 是 B4 的稳定基础：

```
Slice-store 迁移步骤（每个新 capability）：

1. Rust 端 trait method + emit event (在已有 emit 队列加新 event kind)
2. TS slice 内 store-side action 调 invoke
3. TS slice 内 listen(event) 注册 → 收到 emit 后 update slice cache
4. 组件 useSlice(s => s.fieldOrDerivedCachedField) 订阅
5. 旧路径删除（B3-I3 不留双轨）
```

4 条 retrospective（B3 实施前先列预想，实施后修正）：

- **TS 端 0 mutation action for authoritative fields**：除 emit listener 内的 reducer 不在任何地方 setState authoritative 字段。Test: grep `set state` in slice file，应该只在 listener 回调内出现
- **Selector 路径 ≤ 2 layers**：`useSlice(s => s.x.y)` 最多。再深就把 derive 移 store-side
- **每 slice file ≤ 600 行**：超就分子文件（B3-I5 / G11）
- **Slice 之间 0 cross-import action call**：跨 slice 操作通过 Rust 端协调，TS 端不互相调

---

## End of B3
