# Scroll-on-completion 自动定位最终答案 · 方案 E 暂存

**Date**: 2026-05-13
**Status**: Deferred — 等 beta / 公测真实用户反馈再决策
**Related**: [MainView.tsx](../../desktop/src/components/screens/MainView.tsx) scroll effects (userSubmitTick / stream-follow / session-switch ResizeObserver)

## Context

Dogfood 中作者反馈：GA 跑长任务（研究/报告，20+ 步骤工具调用）出最终答案后，conversation 自动 scroll 到最底部 = 最终答案的**结尾**。每次都要手动往上滚到答案**开头**才能开始读。

但「直接不要 auto-scroll」也不解决问题：

- 流式过程中不滚 → 视觉停留在「我的问题」位置，长任务跑 5 分钟用户根本看不到工具调用进度
- 任务完成时不滚 → 用户**也分辨不出 GA 完成了没** —— 画面没变化，最终答案在远下方看不见

所以 auto-scroll 本身没错，错的是**时机**：流式期间不该跟着底部，最终答案出来那一刻该一次性定位到答案开头。

## Decisions

**暂不实现，先 ship 现状版本，等 beta / 公测看用户反馈再决策。**

理由：

- 现状不是 bug，是「偶发不爽」级体验细节
- 真实用户的行为模式（长任务占比 / 流式期间会不会主动等 / scroll 容忍度）目前全是作者一人推断，缺数据
- 提前优化可能优化到错的方向

**触发 revisit 的条件**：beta 用户反馈「每次长答案出来都要手动往上滚才能开始读」是高频痛点。

## Rejected alternatives

按讨论时序 5 个方案：

**A. 默认 read mode（提交后强制 `atBottom=false`，禁用 stream-follow）**
缺点：长任务工具调用期间，视觉停留在问题位置，用户既看不见进度，也分辨不出完成没完成。被作者当场否掉。

**B. 流式跟底，完成时回到 user message 顶部**
缺点：跳跃感强；anchor 错位置（应该是答案开头不是问题开头）；短回复时 snap 完全没必要。

**C. 完全删除 stream-follow effect**
等价于 A，缺陷相同。

**D. 智能 heuristic：检测回复长度切换模式**
复杂、易错、流式中途无法可靠判断长度；放弃。

**E. 默认 read mode + `run_complete` 时 smooth scroll 到「最终答案开头」（暂存方案）**

- 提交后：user message snap 到顶部 + 32px padding（保留现有行为）
- 流式期间：**不做 stream-follow**。用户可手动滚到底部 opt-in watch mode，`atBottom` 翻 true 后自动接管
- `run_complete` 触发：smooth scroll 把「最终答案的开头」（`[data-role="final-answer"]` wrapper）滚到 viewport top + 32px

副作用同时解决两个痛点：

1. 自动定位到答案开头，无需手动滚
2. Scroll 动作本身就是「GA 完成了」的视觉信号（即使最终答案是空的或失败，仍有运动反馈）

## Open questions

- **用户主动 scroll 中遇到 `run_complete` 怎么办？** 倾向「总是 snap 到最终答案」—— 用户最终想看的就是答案，snap 是服务他的最终目的，要回去读某个工具步骤再 scroll up 成本低。反方意见：尊重用户当前阅读位置，不打断。实施时再 align。
- **Smooth scroll 时长？** 200-300ms 是直觉值，未实测。
- **`runCompleteTick` vs `agentRunning` true→false 转换检测？** 前者更显式（专门为这个 UX 加的信号），后者复用现有 state（但 `error` / `onClose` 也会触发，需额外判空 `[data-role="final-answer"]`）。倾向前者。
- **Anchor 元素该是 StrongHr 还是 MessageAgent wrapper？** StrongHr 提供「这是结论」的视觉过渡感，但单独一条横线在 viewport top 会显得空；MessageAgent 直接进入文字。倾向 MessageAgent wrapper，StrongHr 留在 +32 padding 区域作为软标记。

## Implementation outline（revisit 时直接照做）

约 5 处小改动：

1. [Conversation.tsx](../../desktop/src/components/conversation/Conversation.tsx) `AgentTurnView`：给 `isFinalTurn && hasAnswerText` 这条路径下的 MessageAgent 套一个 `<div data-role="final-answer">`
2. [useAppStore.ts](../../desktop/src/stores/useAppStore.ts) State：加 `runCompleteTick: number`，初值 0
3. [ipc-handlers.ts](../../desktop/src/lib/ipc-handlers.ts) `run_complete` case：`set({ runCompleteTick: state.runCompleteTick + 1 })`
4. [MainView.tsx](../../desktop/src/components/screens/MainView.tsx)：加 useEffect 监听 `runCompleteTick`，RAF 后查 last `[data-role="final-answer"]`，`container.scrollBy({ top: delta, behavior: "smooth" })`。复用 `userSubmitTick` effect 的位置计算逻辑
5. [MainView.tsx](../../desktop/src/components/screens/MainView.tsx) stream-follow effect：删掉提交后 `atBottom` 自动 true 的隐含行为（具体改法见提交后的 useEffect 链路）

## Next

不做。继续推其它事项。定期回看本条 entry；如 beta / 公测反馈印证痛点，按上述 outline 实施。
