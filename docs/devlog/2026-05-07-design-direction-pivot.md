# 设计方向转向 Notion + Claude 文档对话工作台

> Date: 2026-05-07
> Status: aligned (基础层 9 块；Onboarding / Settings / Card 类待续)
> Related: PRD §13-15 · [docs/DESIGN.md](../DESIGN.md) draft · 原 v0.1 DESIGN.md 在 Notion (`3552aab6e913815f91a1c2b8b0a15672`)

## Context

PRD v0.2 落定后开始进 DESIGN.md 讨论。v0.1 DESIGN.md（dark graphite + cyan-emerald + Linear/Raycast 紧凑驾驶舱）已经写完，但作者表态：

> "我现在希望 GA Workbench 的气质有点像 Notion 和 Claude 的结合"

这是**根本方向调整**，不是 patch。讨论从抽象气质开始（"什么是 Notion + Claude 结合"），逐步具体到色板、字体、组件 spec。基础层 9 块对齐用了一个完整 work session。

## Decisions

### 整体方向

- **Light-first**（替换 v0.1 的 dark-first；dark mode 推到 V0.2+）
- 气质：「文档化的对话工作台」，不是「驾驶舱盯着野兽工作」
- 三大设计源头：
  - **Notion** 给文档心智、舒展留白、emoji 锚点、Sidebar 树
  - **Claude** 给暖色调、文学性可读性、对话感、克制
  - 二者结合 = "在文档工作区里跟一个温和但严肃的助手协作"

### 色板（Light-first）

- **App background**: `#FAF7F2` 暖米白（不是纯白）
- **品牌色**: `#D9A78A` 杏沙——产品体温色，**不做主 CTA 填充**（轻盈色在白底对比度不够 WCAG AA）
- **主 CTA**: `#1F1B17` charcoal-warm（暖近黑）
- **互动状态**: hover 用中性灰 `#F2EDE3`（不抢戏）/ selected 用杏沙 tint `#F8EDDA`（品牌时刻）
- **状态色**: warning `#BF7A1F` 深琥珀，跟杏沙拉开 13° 色相避免冲突
- 完整 token 见 [docs/DESIGN.md](../DESIGN.md)

### 字体方案 C

- **内容衬线**: Newsreader（英）+ 思源宋体（中）—— 用户消息、agent 回复、turn summary
- **UI 无衬线**: Inter（英）+ 苹方/思源黑体（中）—— 按钮、菜单、metadata、session row
- **命令等宽**: JetBrains Mono —— shell 命令、路径、JSON、tool 名
- **判断规则**：被读 → 衬线，被点 → 无衬线，技术 ID → 等宽
- 字号舒展：body 16px / line-height 1.65–1.7

### Sidebar：「Linear 骨架 + Notion 视觉」

- 时间分组主体：**TODAY / THIS WEEK / EARLIER**（三档够用）
- **去掉 ACTIVE / WAITING FOR YOU 区块**：状态由 row 颜色对比 + Approval Dock 兜底
- **去掉 "UNFILED" 命名**：通用 Agent 工作台 80%+ 对话本就是 free-floating，不需要给主体起暗示"没归类"的名字
- **PINNED section**：Quick Actions 下、TODAY 上，仅在有 pin session 时显示
- **PROJECTS section**：折叠列表 + 默认 emoji（无 cwd → Folder / 有 cwd → FolderOpen）+ 双重显示（project 内 session 也在时间流出现）
- **Trash**：底部隐蔽，整行清空需输入 `delete` 三字符确认；单条永久删用 modal 但不要求字符
- **Phosphor Thin** icon set，状态用 line icon 不用 emoji
- ⌘\ 折叠 sidebar / ⌘K 全局 Command Palette / 右键 + hover `...` 双入口

### Tool Event callout

- **像 Notion callout，不像 stdout log**：每个 tool call 是独立 block
- 视觉三件套：左侧 3px 状态色竖条 + 1px 浅边框 + 12px 圆角，**不用 background tint**（在暖米白底上太花）
- 6 状态映射：running / success-current / **success-historical（融入背景，左竖条几乎不可见）** / waiting_approval（强制展开） / failed（强制展开）/ denied
- **Approval Card = waiting_approval 状态的 inline form**，不是独立组件
- Tool name 用 mono（保持 register 区分），代码 preview 轻度语法高亮

### Conversation 主区

- **User vs Agent 三重区分**：字体（Inter 500 vs Newsreader 400）+ 字重 + 锚点（user 左侧 2px 灰竖条 / agent 无）—— 不要 chat 气泡、不要 right-align
- **Thinking summary**：放在 callout 序列**最前**，emoji 💭 锚点（破例不用 line icon——文档区，emoji 是 Notion-style 的合法 register）
- **双 hr 系统**：turn 间是极淡 1px（60% 宽居中），行动→结论是稍深 1px（全宽）—— 兑现 PRD §13.2 "结果优先" 原则
- **最终答案不放 callout**，"漂浮"在文档里

### Composer

- 杏沙 focus ring（杏沙作为品牌时刻）
- **Submit 按钮用杏沙作为 CTA 填充例外**（其他主 CTA 是 charcoal）—— 理由：Submit 是用户最高频元素，杏沙带来"亲和体温"
- Enter 发送 / Shift+Enter 换行
- Stop 按钮 = running 状态下替换 Submit 按钮位置（深琥珀填充）
- + icon 占位（V0.2 接 attach）
- 不显示 Context Window / 价格 / token estimate

### Approval Dock

- 输入区**正上方**（粘 main 区底部），仅在 pending 时存在（不是 hide，是不渲染）
- amber-tint 浅橙背景 + 3px 深琥珀左竖条
- 多 approval 时显示总数 + next tool name + advance（处理一个跳下一个）
- **不可 dismiss**（必处理状态必须 surface）
- hover 显示 tooltip 预览；决策仍必须在 callout 内做（dock 是 navigator，callout 是 decider）

### Top Bar

- **macOS traffic light 集成**（自定义 titlebar，比 native + Top Bar 双层更整洁）
- 高度 44px / 左：traffic light + Sidebar toggle / 中-左：Session title（inline edit）/ 右：⌘K + `...`
- Windows / Linux 暂用 native titlebar 兜底
- **不**显示 runtime（已在 Sidebar 顶部）/ Stop（已在 Composer Submit 位置）/ Context Window / 价格

### Inspector

- **默认展开**（"可观察"是 PRD 强调的能力，藏起来等于自废武功）
- **3 tabs**：Details / Approvals / Runtime —— **Logs 移到 Settings → Developer**
- Details Tab 自适应当前 main 区 selection
- "Jump to in conversation" link 滚到对应 callout 并杏沙背景闪烁 1.5s

## Rejected alternatives

整套设计讨论中考虑过但被否的方案：

- **Dark-first + cyan/emerald 信号**（v0.1 方向）：作者明确要 Notion + Claude 心智，dark + cyan 是 Linear / Raycast 心智，不匹配
- **品牌色 #CC785C 直接用 Claude 原色**：作者要"更深一档"再到"更轻盈一档"——最终选 `#D9A78A` 杏沙，跟 Claude 区分开有自己的脸
- **品牌色厚重方向**（赤陶 / 烧赭石 / 老红木 #B86A4F、#A05A40、#8C4A33）：作者后期改主意要轻盈，光线感而不是泥土感
- **品牌色做主 CTA 填充**：轻盈杏沙在白底对比度 1.8，不够 WCAG AA。转为"品牌色作为体温，主 CTA 用 charcoal"
- **Spaces 分类（Personal / Research / Project）**：v0.1 PRD 设计，v0.2 PRD 已砍。DESIGN 这次讨论确认时间分组才是主体
- **「UNFILED」命名**：暗示"没整理好"，但通用 Agent 工作台对话本就是 free-floating，命名预设错误偏见
- **ACTIVE / WAITING FOR YOU 状态分组区块**：状态 icon 颜色对比足够 + Approval Dock 兜底，分组反而稀释 row 状态本身视觉权重
- **Status 用 emoji（🤔 ⏳ ⏸ ✅ ❌ 💤）**：太重 + 跨平台渲染不一致，转 Phosphor Thin line icon
- **User message 用气泡 / right-align**：通过字体+字重+锚点三重区分代替，更"文档感"
- **Thinking summary 放 callout 序列后面**：summary 是 LLM 这一轮"打算做什么"的总结，应该在前面（章节标题位置）
- **Tool name 用 sans 跟 callout 一致**：保留 mono register（technical ID 标准做法）
- **Top Bar 显示 runtime / Stop / Context Window**：runtime 在 Sidebar 顶部、Stop 在 Composer、Context Window V0.1 拿不到——Top Bar 只剩 session title chrome
- **Inspector 4 tabs 含 Logs**：Logs 移到 Settings → Developer，让出 tab 空间给最常用的 3 个
- **Inspector 默认 hide**：违反"可观察"承诺
- **直接落 DESIGN.md v0.2 中间稿到 Notion**：作者选择继续 incremental 讨论，写文档等讨论完
- **PIN 不做（V0.1）**：作者说 PIN 实用，要做（独立 section + 双重显示）
- **Sidebar 折叠不做 / 用 ⌘[ 等其他键位**：⌘\ 是 VS Code / Notion 标准

## Open questions

- 完整 v0.2 DESIGN.md 还需要：**Onboarding / Empty state / Health Check Card / Error Card / Command Palette UI / Settings** —— 下次 session 继续聊
- Dark mode：作者明确推到 V0.2+，但 light-first 色板要不要预留 dark token 名（`surface-dark` 系列）—— V0.2 再决定
- Composer Slash commands（`/restore` `/new` 等）：V0.2 做
- 12-13" 笔记本在最小三栏 1120px 下的紧凑度——V0.1 不做窄屏特殊处理
- Session 移到 Project 的 UI（拖拽？右键 → Move to？）：V0.1 暂用右键 + `...` 双入口，不做拖拽
- 作者备注 PRD 要"开源"——开源准备清单已记入今天 session（LICENSE / README / 移除 Notion 私链 / 等）；DESIGN.md 完成后是否需要再做一次 README / docs 的"开源就绪"扫描

## Next

- 下次 session 继续聊：**Onboarding / Empty state / Health Check Card**（产品门面，连续设计）
- 之后剩下：Error Card / Command Palette UI / Settings
- 全部对齐后一次性合并到 [docs/DESIGN.md](../DESIGN.md) 作为 v0.2 完整版
- Stage 2 桌面端骨架启动前，DESIGN.md v0.2 必须完成
