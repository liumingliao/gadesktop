# B3 · useAppStore 拆 slice + 改订阅 Rust event

```
Cursor:   T3.1  (M3 runtimeStore 抽离 — 待 fresh session 开干, M3 启动门 P1-P4 ✅ / dogfood scenarios 35 项仍待 JC 跑)
Status:   🟢 M2 ✅ (informally dogfood-validated 2026-05-19 after attach_pet fix) · M3 deferred to fresh session per JC scope call · perf baseline P1-P4 ship 2026-05-19
Started:  2026-05-19
Last touch: 2026-05-19 — M2 + B2 attach_pet fix shipped。M3 一次推完风险评估过大（拆 SessionRuntime + 9 action + cross-store onClose + 9 module-level 删除 = 多文件 800+ 行改动），JC 决定下 session fresh state 重开 M3。然后建 perf baseline (P3+P4 ship by AI 自动测) + JC 给真 LLM 后 AI 跑 perf-galley.py 拿 P1=3.15s short / 5.36s long、P2=1.42 ev/s 数 ship 进 perf-baseline.md。详 N5/N6/N7
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
- [x] B2 性能基线 ship 在 [`perf-baseline.md`](./perf-baseline.md)（2026-05-19）— **P1-P4 全部 measured**（P3 CLI RTT / P4 bridge spawn cited prototype / P1 first-token RTT 3.15s short + 5.36s long / P2 throughput 1.42 ev/s for long prompt）

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

- [x] **T1.1** 静态分析 `useAppStore.ts`：grep 起索引（193 lines）+ manual review 收敛到 32 字段 + 57 action = 89 distinct items。输出到 [`docs/refactor/b3-slice-mapping.md`](./b3-slice-mapping.md)（2026-05-19 落地）。**新发现**：9 个 dead-after-B3 module-level symbol（3 Map + 1 数组 + 5 helper/flag）；12 个 active-session projection mirror M3 起逐字段 retire；4 个 cross-slice helper（applyRuntimeUpdate / projectionFrom / emptyRuntime）拆分中消失。`getBridgeClient` export **0 个外部调用方** = 干净删除路径。详 N2
- [x] **T1.2** Slice 边界 ADR — 5 slice 划分（ui / sessions / messages / runtime / prefs）verbatim 字段-级 contract 落地 [`b3-slice-mapping.md`](./b3-slice-mapping.md) § A-E；判断 / rationale 落地 [`b3-slice-adr.md`](./b3-slice-adr.md) AD-01
- [x] **T1.3** `activeProjectFilter` 归属 → **sessionsStore**（[AD-02](./b3-slice-adr.md#ad-02--activeprojectfilter-归-sessionsstore不是-uistore)）；同时显式钉 `yoloIntroSeen` → prefsStore (AD-03)、`conversationWidth` → prefsStore (AD-04)、`agentRunning` → messagesStore (AD-05)、`userSubmitTick` → messagesStore (AD-06)
- [x] **T1.4** 模块级 Map / helper 全删（9 个 symbol，含 `_bridgeClients` / `_lruOrder` / `_stderrTails` / `getBridgeClient` 零外部 callers）— [AD-07](./b3-slice-adr.md#ad-07--module-level-state-全删t14-verbatim) verbatim + [mapping doc § F](./b3-slice-mapping.md#f-跨-slice--内部-only-state) 明细
- [x] **T1.5** 沿用 Zustand — [AD-10 § T1.5](./b3-slice-adr.md#ad-10--已-resolved-字段回顾-t15-t17)
- [x] **T1.6** 16ms batch window for streaming delta — [AD-10 § T1.6](./b3-slice-adr.md#ad-10--已-resolved-字段回顾-t15-t17) + [emit catalogue § in_flight_delta batching](./b3-rust-emit-catalogue.md#2--messages-appended)
- [x] **T1.7** Selector ≤ 2 layers + store-side enrichment — [AD-10 § T1.7](./b3-slice-adr.md#ad-10--已-resolved-字段回顾-t15-t17)
- [x] **T1.8** Slice dependency DAG（5 slice）— [AD-09](./b3-slice-adr.md#ad-09--slice-dependency-dagt18)。无 cycle；唯一 hot edge: prefs → runtime（gaConfig change reset warmup）走 Rust event 中介；其它 read-only cross-slice 允许
- [x] **T1.9** Rust emit event catalogue — 5 新 event（sessions-updated / messages-appended / projects-updated / prefs-updated / runtime-updated）+ 3 沿用 + 跨 channel ordering / batching / initial-state contract 全 spec 在 [`b3-rust-emit-catalogue.md`](./b3-rust-emit-catalogue.md)
- [x] **T1.10** M1 commit 准备就绪：3 个 artifact + [M1 完成 devlog](../devlog/2026-05-19-b3-m1-design-complete.md) + playbook cursor 更新到 T2.1 + dashboard 更新

---

## M2 · uiStore 抽离 (D34-D35)

最安全的 slice — 全部 display state，没有跨进程同步。从这里开始建模式。

### Sub-tasks

- [x] **T2.1** 新建 [`gui/src/stores/ui.ts`](../../gui/src/stores/ui.ts)（73 行，5 字段 + 8 action）。Screen 类型迁过来并 re-export
- [x] **T2.2** 把 screen / paletteOpen / settingsOpen / toggle 系列 actions + setPendingPetMigration（+ pendingPetMigrationTo 字段）迁过来。**直接迁，不留 alias** — 同 commit 内 swap 所有 callers（per B3-I3 "no double-track"，alias 在单 commit migration 下多余）
- [x] **T2.3 SKIP** — conversationWidth 留在 useAppStore 直到 M6 prefsStore 抽出（per [ADR AD-04 sub-note](./b3-slice-adr.md#ad-04--conversationwidth-归-prefsstore不是-uistore)）。**playbook 上一版 T2.3 跟 ADR 矛盾，本 sub-task skip 是 ADR 优先**
- [x] **T2.4** 把 toasts / pushToast / dismissToast 迁过来。useAppStore 内 3 个 internal `get().pushToast(...)` + 2 个 `useAppStore.getState().pushToast(...)` 全 swap 到 `useUiStore.getState().pushToast(...)`。ipc-handlers.ts 同样 swap
- [x] **T2.5** Call site swap：[App.tsx](../../gui/src/App.tsx) 11 个 hook (screen / setScreen / paletteOpen / setPaletteOpen / togglePalette / settingsOpen / setSettingsOpen / setPendingPetMigration / toasts / pushToast / dismissToast) + 2 个 inline `import("...").Screen` type ref 改走 ui.ts。[ipc-handlers.ts](../../gui/src/lib/ipc-handlers.ts) 4 个 `s.pushToast` + 2 个 `s.setPendingPetMigration` + 1 个 `s.pendingPetMigrationTo` 字段读 → 全 `useUiStore.getState()...`
- [x] **T2.6** Dogfood — JC 跑 dev mode 2026-05-19 验证，发现 Desktop Pet 失败 → 根因是 B2 IPC schema drift (AttachPetCommand `variant` field) 而非 M2 regression → 独立 fix commit `5facf1e` 修好后 Pet + 其它 UI 路径暂未发现问题。M2 启动门 override 教训：dogfood-pre-merge 确实会 catch B2 latent bug，但本次 override 风险敞口由 M2 isolated 性质吸收了
- [x] **T2.7** TS typecheck + ESLint 0 warning（cd gui && pnpm typecheck + pnpm lint）
- [ ] **T2.8** M2 commit pending（本 N4 落地后一并 ship）
- [ ] **T2.9** **Dogfood 1 天**（B3-I1）— JC daily driver 跑 24h+（M2 启动门 override = 这条也 implicitly relaxed，但 commit 后仍要 JC dogfood 确认行为不变）

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
- **N2 (2026-05-19, T1.1 done)** — 静态分析跑下来 grep 索引比预期省力：193 line 经 manual review 到 89 distinct items（32 字段 + 57 action），4-6h G1 预算实际花 1.5h（含读 SessionRuntime jsdoc + 跑 callers grep + 写 mapping doc）。**预算太保守**——遗产是 SessionRuntime 已经把所有 per-session 字段集中到一个 interface，grep 跟 interface 互相印证非常省。**新发现**：(a) `getBridgeClient` 0 个外部 callers — T1.4 删 module-level 3 Map 完全干净；(b) **active-session projection 是 B3 最大的 mechanical work** —— 12 个 top-level mirror 字段对应 96 个 useAppStore call site，M3-M5 每个 slice 实施时都要 sweep 一遍组件订阅；(c) `agentRunning` 边界模糊 — 是 messages（conversation 状态）还是 runtime（bridge 状态）？mapping doc 暂分 messages，O7 标注 M3/M5 dogfood 时复核；(d) sessionsStore / messagesStore 估计 550 / 600 行，**接近** B3-I5 600 行硬上限，M5 实施时 G11 子文件拆分预案要执行。**Open**: T1.2 ADR 实施 verbatim 跟 mapping doc 字段表对齐；T1.3 `activeProjectFilter` / yoloIntroSeen / conversationWidth 归属判断需要 explicit 写下来（mapping doc 已给暂行决定但 ADR 是契约）
- **N3 (2026-05-19, M1 COMPLETE)** — T1.2 → T1.10 串推：[`b3-slice-adr.md`](./b3-slice-adr.md) 落 11 个 AD（边界 / dead-state / DAG / RESOLVED 复述）+ [`b3-rust-emit-catalogue.md`](./b3-rust-emit-catalogue.md) 落 5 个新 emit event spec（sessions-updated / messages-appended / projects-updated / prefs-updated / runtime-updated）+ [M1 完成 devlog](../devlog/2026-05-19-b3-m1-design-complete.md) 6 段格式总结。**新发现**：(a) Rust 端 emit 5 个 domain event 而非 raw runner-event 给 GUI —— GUI 不重复解释 IpcEvent，IPC 解释逻辑在 Rust spawn_emit_task 中央化（[ADR AD-09](./b3-slice-adr.md#ad-09--slice-dependency-dagt18) 钉死）。(b) [`runtime-updated` 新 event](./b3-rust-emit-catalogue.md#5--runtime-updated) 是关键设计 call —— 不放在 M3 T3.3 的 stub list 里曾经只写「spawn_emit_task 内 emit」没钉 schema，本次 catalogue 把 payload shape 完整 spec。(c) M1 + prereq relaxation 同 session 跑完 = 单 session 5h 总时长（含 prereq 2h + M1 3h），G1 budget 4-6h 是 M1 alone，超估约 1.5×。**Open**: M2 启动门要求「scenarios JC 真跑过 + perf baseline 测好」——本 session 不动 frontend 代码，M2 启动前 JC 单独跑 dogfood + 测 baseline 即可，本 session 结束
- **N4 (2026-05-19, M2 启动门 override)** — JC explicit 选择「破 M2 启动门」连推 M2 实施，不等 dogfood scenarios 签字 + perf baseline。**记录此决策为 tactical override 而非 rule change** —— 启动门规则本体不变（[Prerequisites § M2 启动门](#prerequisites--必须先完成) 仍 codified），但本 session 当作 single-event override 推过。**风险吸收**：M2 是 5 slice 最简单的（pure display state，no transport，[B3-I4](#phase-invariants--b3-特有的硬规则) 不动 Rust 端），代码改动 net -61 行（useAppStore -79 / ui.ts +73 / App.tsx + ipc-handlers 微调），typecheck + lint 全 clean。若 JC 用 dev mode dogfood 发现 B2 / B3 regression 混在一起难定位 = override 的代价显形，撤回 commit + 重做。如果没发现 = M2 启动门未来对类似 paperwork-adjacent milestones 可以 case-by-case override。**不**推广这条 override 到 M3-M5 — 那几个 milestone 改动 authoritative state + 订阅化，比 M2 风险高一个量级，gate 仍 enforce
- **N7 (2026-05-19, P1+P2 live measurement)** — JC 起 dev mode + 真 LLM，AI 用 `scripts/perf-galley.py` 跑 P1+P2 against fresh chat `s-mpc6h020-iy71`。**关键发现**：(a) 跑 P1 第一次脚本卡 4 分钟 — 不是 LLM 慢，是脚本 bug：`readline()` 在 inner "wait 1.5s for trailing turn_progress" loop 里 block 死，超时检查在 outer 进不去。修法：`select.select()` non-blocking read。(b) **GA bridge wire format**：`{"stream":"event","data":{"kind":"turn_progress","delta":"..."}}`，parser 要查 `data.kind` 不是 top-level；(c) **GA emits real content `turn_progress` BEFORE `turn_start`** for long prompts — turn_start 是 metadata-commit 事件，长 prompt 时 fire at END。**结果**: P1 marker 必须用 `first_real_delta`，不是 `turn_start`，否则长 prompt 会被 over-report 至 15s; (d) **GA bridge chunks LLM streaming** — 长 prompt 500 字只产 14 个 `turn_progress`（~700ms 每 chunk），不是 token-by-token。1.42 ev/s 对 React-side 是低压力（B3 batch 16ms 窗口可能根本不需要）。**结果数**: P1=3150ms short / 5363ms long, P2=1.42 ev/s。**Single-sample，不统计**（per M3 启动门规则）。**B2 latent bug 候选**：JC 报「LLM 回复了"二"但看不到提问」— CLI-origin user message (origin.via=supervisor) 在 GUI 渲染缺失。Pre-M3 implement 前需 audit `gui/src/lib/ipc-handlers.ts` 看是否 listen `runner-event` 时 dispatch user-message-persisted

- **N6 (2026-05-19, perf baseline 框架 ship)** — M3 启动门两条 blocker 在新 session pickup 时仍 0 进度（dogfood scenarios 35 项全空 + perf-baseline.md 不存在）。JC explicit 选「帮你建 perf baseline 框架」分摊 prep work。**已做**：(a) [`perf-baseline.md`](./perf-baseline.md) 落 5 个 metric (P1 first-token RTT / P2 streaming throughput / P3 CLI read RTT / P4 bridge spawn / P5 RSS plateau) 完整 spec 含 gate 规则 + 测量 SOP + 阶段对比表；(b) **P3 已 measured** (debug binary, 4 commands × 20 samples): version mean 13ms / status mean 14.2ms / sessions list mean 14.9ms / health mean 14.9ms — 都是 process startup + sqlx + serde 开销，B3 不动 Rust 端时跨阶段应保持不变 ±5%；(c) **P4 cited prototype baseline** (430.86ms cold / 340.98ms 3-concurrent) — RunnerManager 是 BridgeProcess productionized，subprocess 路径 B2 未改 → prototype baseline = B2 baseline 在 [B3-I4](#phase-invariants--b3-特有的硬规则) 守护下也 = B3 baseline。**待 JC**: P1 + P2 各跑一次 SOP 把数填进 perf-baseline.md（M3 严格启动门）；scenarios 35 项跑一遍。**不打算 fake**: P1/P2 涉及真 LLM API 调用 + 网络抖动，自动测量没有意义。这是 paperwork-then-block paradigm — 框架就位但 gate 仍要 JC 手动过

- **N5 (2026-05-19, M3 deferred to fresh session)** — M2 ship 后 JC dogfood 撞到 Desktop Pet 失败 → 根因 B2 IPC schema drift（Rust AttachPetCommand 推测加 `variant` field，Python 不接受）独立 commit [`5facf1e`](https://github.com/wangjc683/galley/commit/5facf1e) 修复 + 加 regression test。**关键 audit 结果**：B2 manual IPC sync 只有 AttachPet 一个 command drift；其它 commands `rename_all = "camelCase"` 跟 Python 干净对齐。**M2 启动门 override 的真实代价**：本次 override 没有引入 M2 regression，但 B2 latent bug（dogfood-pre-merge 本应 catch）被 M2 ship 后才发现 = override 推迟了 bug 暴露 1-2 commits 而非引入 bug，因此可接受但不应常态化。**M3 scope assessment**：开始写 runtime.ts 时发现 M3 真规模（拆 SessionRuntime 14 字段 → runtime 5 / messages 9、拆 applyRuntimeUpdate、9 actions 迁移含 spawnBridge 的 onClose cross-store 写入、9 module-level symbol 删除 / 移位、dispatchIPCEvent 签名调整、cross-store 动态 import 解 cycle）= 多文件 800+ 行单 commit。本 session 已 10h+，疲劳期推 M3 单 commit 质量风险显著 → JC 决定本 session 结束 fresh session 重开 M3。**下次 session pickup**：(1) 读 [b3-slice-mapping.md](./b3-slice-mapping.md) § D 看 runtimeStore 全字段清单 + [ADR AD-05/AD-07/AD-08](./b3-slice-adr.md) (2) 决定 M3 单 commit vs M3a/M3b 拆 commit (3) 实施前先列详细 sub-plan 含 cross-store write 处理策略 (4) M3 启动门 enforce: dogfood scenarios + perf baseline (gate 仍有效，本 session 不破)

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
