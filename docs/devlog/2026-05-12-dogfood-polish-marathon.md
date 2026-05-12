# Stage 3 dogfood polish marathon · turn_index 双层语义拆分

> Date: 2026-05-12
> Status: V0.1 polish 第二轮完成；唯一 critical bug（turn_index 撞 key 导致 conversation 错乱）已修；视觉层级 + sidebar 三态语义重新校准
> Related: 17 个 commits（`72a3ab0` → `b4d4190`）· 接上一篇 [2026-05-11 Stage 3 V0.1 收尾](./2026-05-11-stage3-v0.1-completion.md)

## Context

上一篇 V0.1 收尾后跑 dev verify，从「思考中…」placeholder 文案太工程化开始报问题，一路修到 critical 数据 bug（重启后 conversation 错乱），最后是一连串视觉权重和文案语义的 polish。17 个 commits 一路走过，每个 commit 几乎都是 user dogfood → 报问题 → 我修 → 再 dogfood 的小回合。

不像上一篇那种「集中实现 5 个 task」，这次是**密集的 polish 迭代**——很多决策细节藏在 commit message 里，devlog 把决策线索串起来。

## Decisions

### 1. LRU eviction 保护 agentRunning（sharp edge 修复）

LRU 5 commit `b70a5ca` 只保护 active session 不 evict。User 提出 sharp edge：发完一个 5 分钟长任务后切到其它 session 工作，原 session 在 LRU 末尾，新 spawn 会 evict 它中断长任务 —— 违反 N-active 「后台任务保持运行」的核心承诺。

修法：`_enforceLRUCap` 跳过 `agentRunning === true` 的 session；如果全是 active/running 暂时不 evict，等任一跑完下次 spawn 重 enforce。临时超 cap 1-2 是可接受代价。

### 2. Streaming 流式三件套（C-mitigation）

User 报 GA 回复不是流式生成，是「等很久一大块一起出现」。根因在 GA 内核 `agentmain.py:154`：

```python
if len(full_resp) - last_pos > 50 or 'LLM Running' in chunk:
    display_queue.put({'next': ...})
```

GA hardcoded 50 字符阈值才 push 一次 delta。token 级 streaming 被 throttle 成 ~50 字 chunk 节奏。**这是 GA 内核行为，bridge 是下游消费者，拿不到原始 token**。

正确修法（方向 A）是给 GA 提 PR 加 `agent.inc_thresh` 可配置，但需要 user 协调 baseline 升级。当下选 C-mitigation（UI 层缓解感知）：

- **TypingDots**：「思考中」后面三 dot 错峰跳动（CSS keyframes），第一个 chunk 到达前不死寂
- **StreamingCursor**：partial markdown 下闪烁竖线，50 字 chunk 之间的 idle 期保持 liveness 信号
- **useTypewriter hook**：3 字符/帧 × 60fps = 180 字符/秒，把每个 50 字 chunk 在 ~280ms 内逐字 reveal；source monotonic 增长就持续推进，清空就 snap reset

整体节奏：GA push chunk → typewriter 落后几百 ms 慢慢吐字 → 用户看到的是「连续打字」而不是「一坨砸下来」。

### 3. Settings UX 修复

**Session-count toast 计数 bug**：toast 数的是 `sessions.length`（含 archived），user archive 完一堆后还被 nag "已开 48 个 session"。改成只数 non-archived。

**LRU 5 + archived = toast 没必要**：最终发现 LRU 已经 cap 内存占用、archived 不占 bridge，toast 整段移除。Sidebar 长不长是 ⌘K 搜索 / bucket 分组要解决的问题，不该靠催 user archive。

### 4. Archive 系统完整化（A + B + C 一次性做齐）

V0.1 sidebar footer 写「Trash」但实际是 archive 语义（数据保留不删）——命名不匹配。一次性做齐 trio：

- footer `Trash` → `Archived` + Archive icon + 右侧数字 badge
- 新 ArchivedDialog：列 archived sessions，单条 Restore（非破坏，立即执行）/ Delete（单层 AlertDialog confirm）
- 「清空全部」**两层 destructive 确认**：destructive 红色按钮 + AlertDialog 强制勾选「我了解此操作无法撤销」checkbox 才 enable confirm，仿 GitHub delete-repo 模式
- store actions: `deleteSessionPermanently(id)`（FK ON DELETE CASCADE 处理 messages + tool_events）+ `emptyArchive()`

### 5. turn_index 双层语义拆分（critical bug 修复）

**Bug 现象**：User 重开 app 后 session conversation 错乱——3 个 user message + 只剩 1 个 assistant 回复，顺序也乱。

**根因深挖**：GA `agent_runner_loop` 内部 `turn = 0` 局部声明，每次新 `put_task(user_message)` 都从 0 开始。所以每条 user message 的第一个 turn 都 emit `turnIndex=1`。SQLite primary key 是 `msg_${sessionId}_${turnIndex}_assistant`，**两条 user message 的 assistant 都写到同一个 row id → ON CONFLICT UPDATE 静默覆盖老的**。User 看到的就是「丢了一堆回复 + 顺序乱」。

**修法（commit `31bbf6d`）**：`SessionRuntime` 加 `turnIndexOffset`，`appendUserTurn` 时设 offset = 当前 session.turnCount。所有 GA event turnIndex 加 offset 转 absolute 后再写 DB / 用于显示。

**第二个 bug**（同一处的 over-correction）：absolute turn_index 用到了**显示层**——commit `2218d91` 修。User 报「第二条 user message 的 step 没从 1 开始」，期望 GA 原生 per-message 语义（每条 user message 内部从 1 数）。

**最终拆分**：

| 用途 | 数据 |
|---|---|
| SQLite `messages.turn_index`（PK + 排序） | absolute = `event.turnIndex + offset` |
| UI 「第 N 步」显示 | raw GA `event.turnIndex`（per-message reset） |

Restore 时反推：`rowsToTurns` 遍历 (turn_index, sequence) 顺序，记录最近 user row 的 turn_index 作 `currentMessageBase`，assistant row 的 displayStep = `turn_index - base + 1`。零 SQL 改动。

### 6. 「思考中」placeholder 文案 + GA marker strip

两个独立 bug 在 User round-4 / round-5 报：

- **Round 4 (false lead)**：User 觉得 placeholder 太「理工直男」（mono uppercase `TURN N` + 思考中…两行叠）。我**改了我们自己的** TurnMarker / ThinkingSummary 样式（mono → serif italic，合并单行）。
- **Round 5 (real fix)**：User 仍看到「LLM Running (Turn 1) ...」serif Newsreader 字体文字。**根因不是我们的 placeholder**——是 GA `agent_loop.py:49` 每个 turn `print(turnstr)` 到 display queue 的内容，bridge 转发到 desktop 当作 LLM 输出渲染。所有 GA 官方 frontend（dcapp / tgapp / qtapp 等）都有 regex strip 它，desktop 漏了。

修法：加 `LLM_RUNNING_MARKER` regex 到 `cleanFinalAnswer` + `cleanPartialContent`。

### 7. 「第 N 轮」→「第 N 步」rename

User round-6 push back：中文「轮」=「对话回合」（打牌、比赛、对话回合都这么用），跟 user↔agent conversation round 撞，第二条 message 看到「第 1 轮」会困惑。

改全文为「第 N 步」——「步」= 推理子步骤，「第一步先 X，第二步再 Y」是中文自然过程性表达，跟 GA `turn_index`（agent_runner_loop 每次 LLM call + tool dispatch cycle）的语义吻合。

### 8. Sidebar 三状态显示（unread）+ migration v2

User round-7：之前 sidebar 只有 running spinner 转/不转一个维度。提出双维度模型——运行状态 ⊥ 已读状态。

- `002_add_has_unread.sql` migration 加 `sessions.has_unread INTEGER`
- `bumpSessionAfterTurn` 当 `sessionId !== activeSessionId` 时 `hasUnread=true`
- `setActiveSession(id)` 时清 `hasUnread`，持久化 SQLite
- Sidebar UI: hasUnread + !active → brand apricot 8px dot + title bold

### 9. Sidebar running 视觉强化

User round-9：running ↔ idle 只差 spinner 转/不转，扫视看不出。

StatusIcon running 用 `weight="bold"`（其它状态 thin），brand 色 + 粗笔触读起来是真"motion"；subline 切换语言 `正在工作 · 第 N 步`（serif italic）替代 GA summary。

但**「第 N 步」初版用了 absolute count**（`turnCount + 1`）—— 这正是后来 #5 暴露的 absolute vs per-message bug 的另一处。后续 commit `b4d4190` 拆完语义后，sidebar 改用 per-message：`session.currentStepIndex` 字段从 `runtime.currentTurnIndex` 同步而来（applyRuntimeUpdate 增加一项 sync），running 时显示「正在工作 · 第 N 步」与主区 TurnMarker 数字一致。

### 10. 「第 N 轮」→「步」一致性补全

bumpSessionAfterTurn 之前写 `sessions.summary = "第 N 步 · ..."`（含 prefix）。User 注意到完成态 session 显示「第 N 步」读起来像「还在进行」——「第 N 步」隐含「下一步将至」。

改用 **prefix 从存储层搬到渲染层**：
- `sessions.summary` 存纯 GA summary（无前缀）
- Sidebar 渲染时按 status 拼前缀：running → `正在工作 · 第 N 步`；settled → `已完成 · {summary}`
- 老数据兼容：`stripLegacyStepPrefix` regex 在渲染时 peel 老 row 的「第 N 步 · 」前缀，下次 turn_end 自然以新格式覆盖。零 migration。

### 11. New Chat lazy + LLM list cold-start

User 报「点 New Chat 时输入框 LLM 列表显示 demo 模型」。两个连续 bug：

**11a**：`setActiveSession(undefined)` 用 `projectionFrom(emptyRuntime())` 把 store.llms 重置回 DEMO_LLMS。但 LLM 配置是 GA-install-wide 的（mykey.py 一份），不该跟 session 切换重置。修：undefined 分支保留 `state.llms / llmDisplayName`。

**11b**：但即便修了 11a，**cold-start**（重开 app 没 spawn 任何 bridge 之前）仍显示 DEMO_LLMS——store.llms 初始值是 DEMO，要等第一个 `ready` event 才覆盖。

修：`replaceLLMs` 每次都 `setPref("llm_list", llms)`，`hydrateFromDB` 读回。Cold-start hydrate 一完成就有真 LLM 列表，user 点 New Chat 立刻看到自己 mykey.py 配的模型。

### 12. mykey.py 修改告知 — LLM picker footer hint

User 问：mykey.py 改了 LLM 配置怎么告诉用户重启生效？

讨论后选 A（直接重启 app）但需要告知机制。最终采用 **dropdown footer hint**：

```
─────────────────────
修改 mykey.py 后重启 Workbench 生效
```

放在 LLM picker popover 底部，10.5px ink-muted/70 极轻样式。理由：context-of-need 比 discoverability nudging 重要——用户打开 dropdown 时正是「找模型」的时机，hint 在那里出现最自然。Zero memorization required；不需要 user 主动去 Settings 找。

### 13. Tool callout 视觉层级 — 最终统一 inline pill

User 提出「no_tool 太抢戏 + 是否合并到 TurnMarker」开始讨论。

**第一版（commit `1b283c1`）**：按工具 impact 分级：
- no_tool → 不渲染
- 读类 (file_read / web_scan / recall / start_long_term_update) → inline pill
- 改外部世界 (file_patch / file_write / code_run) → 保留 block
- 任何 attention 态 (waiting_approval / failed / running / denied) → block

**User push-back**：一个 turn 调多种 tool 时 inline + block 混合视觉割裂，「不统一也很奇怪」。我重新评估，发现自己之前为「audit value」做的妥协违反更基础的视觉一致性原则——而且 block 默认展开 vs inline 点开看，差别就一次点击。

**最终（commit `aa75525`）**：所有完成态 tool 都 inline pill，仅 attention 状态保留 block。previewArgs 加 file_patch / file_write / code_run 的 path / script 取值。视觉一致 + 全靠 progressive disclosure（点开看完整内容）。

### 14. AgentTurn.summary 持久化 + Copy/Save bleed 修复

**Bug 14a**：sidebar 看得到 turn summary，主区 TurnMarker 看不到。根因 `turnFromTurnEnd` 参数类型没声明 summary 字段，TS 静默丢了。修后再加 v3 migration `messages.summary TEXT` 让 summary 跨 restart 存活。

**Bug 14b**：Copy/Save action 出现在 tool callout 下方（不该是 final answer 之外的地方）。根因 cleanFinalAnswer 对全是 GA 标签的 intermediate turn 返回 `""`，但 `showFinalAnswer = finalAnswer !== null` 检查放过空字符串。修：三层防御——ipc-handlers `turnFromTurnEnd` 把 cleanedEmpty → null；`rowsToTurns` 同样兜底（cover 老 row）；Conversation `showFinalAnswer` 加 `trim() !== ""` 防漏。

## Rejected alternatives

### Streaming

- **直接修 GA 内核（提 PR 加 `agent.inc_thresh`）**：长期正解，但本 session 选 C-mitigation。GA baseline 升级是流程性工作（user 协调 + 重跑 smoke），不在 dogfood 反馈循环内。
- **Bridge monkey-patch GA**：违反项目宪法第一条「不 monkey-patch agent_runner_loop」。
- **Typewriter charsPerFrame 调更快（5 / 10）**：3 字符/帧 = 180 字/秒已经接近"快速 typing"感，再快就丧失 typewriter 视觉。

### turn_index

- **加 `messages.step_index` 列 v4 migration**：本来打算，但 rowsToTurns 反推 base 也能恢复 per-message step，零 SQL 改动更干净。
- **DB 用 GA 原生 turn_index**：直接撞 ON CONFLICT，回到 corruption bug 起点。
- **Sidebar running 直接从 store runtime 读 currentTurnIndex**：违反"sidebar 只读 session 字段"约定。改用 applyRuntimeUpdate sync 到 session 字段的成熟模式。

### Sidebar 文案

- **「第 N 步 · summary」对完成态保持不变**：「第 N 步」隐含「下一步将至」，跟 settled 语义冲突。
- **完成态加「已完成」徽章替换文案**：跟 status icon 重叠信号。User 选「已完成 · summary」prefix 这种过去式陈述。
- **Sidebar running「正在工作…」不带 step**：第一版做了。后来发现信息量太少，背景 session 进度不可见。改回带 step（用同步到 session 字段的方式实现）。

### Archive 命名

- **Trash 语义（可清空 / 30 天自动清）**：当前实现数据保留，「Trash」承诺会过期。命名不符。
- **Empty 不要二次确认**：destructive 批量操作必须 friction；GitHub delete-repo 同款 checkbox confirm。

### Tool callout

- **按 impact 分 inline + block (我第一版)**：视觉不一致问题更基础。最终统一 inline。
- **完全不显示 no_tool**：等价于现在。GA summary 已经覆盖语义。

### LLM picker hint

- **Settings → Runtime tab 加 "Reload LLM Config" 按钮**：放在 Settings 里 user 找不到；按钮要 shutdown 所有 alive bridges 也不优雅。
- **文件 watcher 自动 reload mykey.py**：fs:watch capability + 半保存状态 debounce 复杂度过高，频次不值。
- **Onboarding 时讲一遍**：一次性提示用过后忘。Picker footer 是 context-of-need。

## Open questions

1. **GA 端真 token streaming**：当前 C-mitigation 是前端假装 typewriter。给 GA 提 PR 让 `agent.inc_thresh` 可配置，bridge 设 5-10 字符，才是根治。需要 user 主导（基线升级 + smoke）。
2. **bridge `_load_history` 损失 tool_use 结构**：把 content 包成单 text block。完整 fidelity 是 PRD §10 open item，等 per-backend adapter。
3. **AgentTurn.summary 老 row 缺失**：v3 migration 加列前的 row summary 是 NULL；那些 turn 的 TurnMarker 显示 bare「第 N 步」。可接受——数据本来没存。
4. **`mykey.py` mtime 自动检测**：cold-start 时 detect 文件变化主动 toast 提示「检测到 LLM 配置变化 · 已重新加载」。需要 fs:watch capability，V0.2 polish。
5. **LRU_CAP = 5 是否合适**：拍脑袋数字。实际用一段时间看是不是太紧（"又 suspend 了"）或太松（资源压力）。
6. **Tool callout 展开后的 file_patch 渲染**：现在用 ArgsBlock dump JSON。`@pierre/diffs` 之前被 reversal（bundle cost），但自研 PatchView 应该在 inline pill expand 后渲染 diff 才合理。V0.2。
7. **Sidebar `已完成` prefix 老 row 迁移**：当前 strip regex 兼容显示，下次 turn_end 会以新格式覆盖。但 archived session 不会再 turn_end，永远停留在 stale 老前缀。可加一次性 SQLite migration 把老 row sanitize 掉，但当前 strip 工作正常，不急。
8. **session.currentStepIndex 频繁更新引发 sidebar 重渲染**：每次 turn_start 都更新 → sessions array 新引用 → Sidebar re-render。一个 turn 几次 turn_start 不算频繁，但多 session 同时跑可能性能压力。还没看到症状，提一下作为后续 watch point。

## Next

- User 跑 `pnpm tauri build` 验证 production bundle（仍待办，从上一篇就 pending）
- 跟 GA 上游沟通 `agent.inc_thresh` PR（解锁真 streaming）
- 看 dogfood 后是否还有其它 UX paper cuts；如稳定可以考虑 V0.2 roadmap
- 几个 open questions 的小 fix 可以选择性 batch 做（mykey.py mtime / file_patch PatchView / Sidebar 老 row 迁移）
