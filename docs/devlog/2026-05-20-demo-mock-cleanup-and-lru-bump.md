# Demo / mock cleanup + alive-bridge cap bump

**Date**: 2026-05-20
**Status**: ✅ Shipped (4 commits on `main`)
**Related**: [4a742b6 / 8fca18e / 4fda12a / 802bfed] · 跟着 [B4 progress](./2026-05-20-b3-store-slice-complete.md) 之后的小清扫

## Context

第三个版本（v0.1.1-alpha.1）shipped 之后第二天，JC 提两个独立议题：

1. **LRU 5 不够用**：multi-session dogfood 触发 eviction 的频率比预期高。用户体感「为什么我聊到第六个 session 第一个就被杀了」=「不友好」。该不该改成 20 / 加 setting？
2. **mock demo 还需要保留吗**：`gui/src/stores/demo.ts` 和 `stores/sessions.ts` 里散落着 V0.1 时代留下的 mock fixture / dev toggle 脚手架，两个版本 ship 过后还有用吗？

讨论后两件事都拍板「直接动手清」。LRU 改成 20 不加 setting。Mock 拆三类逐个判断：load-bearing 的生产默认值留下来但改名，纯 dead code 删干净，dev-only DevScreenToggle 也退役。

## Decisions

### 1. LRU cap 从 5 提到 20（[4a742b6](../../../commit/4a742b6)）

- 不加 setting。每个 alive bridge ~100 MB（bundled Python 进程），20 个 ~2 GB 在最低配 8 GB Intel Mac 上仍有富余；99% 用户日常活跃 session 数 < 10，富余的余量直接消除「为什么这个被杀了」的迷惑。
- 真有人撞到 20 上限再说——那时候才是有效信号，说明产品形态在变。功能不可逆：加上 setting 删不掉，砍上限的余量永远不会变窄。
- 同步 Rust `DEFAULT_LRU_CAP` 跟 TS `LRU_CAP` 两端，保持注释 cross-ref。

### 2. Mock 三类拆分（[8fca18e](../../../commit/8fca18e) / [4fda12a](../../../commit/4fda12a) / [802bfed](../../../commit/802bfed)）

audit 后发现 `DEMO_*` 名字下其实混着三种东西：

**A 类 · 名字叫 DEMO 但其实是生产默认值** —— 留下来改名 + 搬家。
- `DEMO_GA_CONFIG` / `DEMO_APPROVAL_CONFIG` / `DEMO_LLMS` / `DEMO_LLM_DISPLAY_NAME` / `DEMO_RUNTIME_INFO`
- 全部消费在 prefs.ts initial state 跟 runtime.ts bridge-ready 前的兜底。Two shipped releases 都靠这些值在 first-launch / pre-bridge 时不崩。
- 改名 `DEFAULT_*`、搬去新 `stores/defaults.ts`、顺手修 `workbenchVersion: "0.1.0"` 撒谎问题（hydrate.ts 已经会用 `getVersion()` 真值覆盖，但兜底值留 "0.1.0" 既不真又像谎话）→ 改成空字符串 sentinel，hydrate fail 时 Settings → About 渲染 `v` 而不是骗人的旧字面值。

**B 类 · DevScreenToggle 链路** —— 退役。
- `DevScreenToggle` / `DevSegment` / `DevButton` / `SCREEN_TOGGLE_LABEL` + 两处 render site
- `makeDemoToast` + `DEMO_TOAST_VARIANTS` (toast 样式 review)
- `seedMockSessions` action + `buildMockSessions` + `MOCK_TITLES_*` + `MOCK_SUMMARIES` + `MOCK_STATUSES`
- `runtimeStore.shutdownAllBridges`（唯一 caller 是 DevScreenToggle kill 按钮，没有 window-close 路径接，纯 orphan）
- 整个 `stores/demo.ts` 文件删除
- 退役理由：Stage 2/3 visual review 时期搭的脚手架，两个版本后已经在用真数据 dogfood，留着只是负重不挣分。要时再写回来不亏。

**C 类 · 纯 dead code** —— 删。
- `DEMO_SESSIONS` / `DEMO_USER_PROMPT` / `DEMO_FINAL_ANSWER_*` / `DEMO_PATCH_NEW_CONTENT` / `buildDemoTurns` / `buildDemoPending`
- 触发条件是 `activeSessionId == null && storeTurns.length === 0`，但 `MainView` 在 active 为空时已经走 EmptyState 不渲染 `<Conversation>`，这条 fallback 路径不可达。
- 用 `approvalDecisions["appr_demo1"] === "allow_once"` 模拟运行态的 Composer Stop 按钮 OR 检查也一并清。

## Rejected alternatives

- **LRU 加 setting**：surface 税，99% 用户不需要。功能是反向不可逆——加了删不掉。
- **保留 DevScreenToggle 做 visual review**：两个版本 ship 后真用户数据已经够 dogfood 了，脚手架收益边际为零；要时 git revert 拿回。
- **保留 `shutdownAllBridges` action 等 window-close 接入**：aspirational dead code，名字好听但没接入路径。5 行 action，要时重写比维护 orphan 便宜。
- **squash 4 commits 成一个「cleanup」**：4 个 atomic commit 革命范围清晰，revert 粒度细。多花点 stash + redo 的 ceremony 换 git log 可读性。
- **DEFAULT_* 留在 demo.ts 不搬家**：文件名跟内容角色不一致是反复绕的陷阱。一次性搬到 `defaults.ts`，名字跟身份对齐。

## Open questions

无遗留。

## Next

`B4 acceptance` 还差 3 项（M2 menubar daemon / M4 T4.2-T4.5 IM bot calendar / M9 v0.5 release ceremony）。本次清理纯收尾性质，不影响 B4 推进节奏。
