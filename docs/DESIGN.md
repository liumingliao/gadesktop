# Galley DESIGN.md

> Status: **v0.2 — complete**
> Last updated: 2026-05-08
> v0.1（dark-first / Linear 风）已被 v0.2 整体方向替换，Notion 历史稿仅作对照。
> 决策叙事与 rejected alternatives 见 [docs/devlog/](./devlog/) 中 2026-05-07 / 2026-05-08 的设计相关 entry。

---

## 1. 设计哲学

Galley 的视觉与交互气质 = **Notion + Claude**。

- **Notion 给**：文档心智、舒展留白、emoji 锚点（克制使用）、Sidebar 树
- **Claude 给**：暖色调、文学性可读性、对话感、克制
- **二者结合 = 在文档工作区里跟一个温和但严肃的助手协作**

不是「驾驶舱盯着野兽工作」，不是 IDE，不是 chat 气泡 IM，不是 dashboard。

### 1.1 三个统摄性约束（PRD §15.4 重申，DESIGN 落地）

1. **单容器更新** —— 一个 session 的所有进展在同一视图内持续刷新，不开新窗口 / 不 toast / 不弹层抢焦点
2. **渐进式披露** —— 默认只展示摘要，细节按需展开。Tool event / raw JSON / 历史 turn 都默认折叠
3. **结果优先** —— 最终答案与过程必须视觉分离，用户第一眼看到结论再展开过程

### 1.2 设计源头分级

| 源头 | 借用 | 不借用 |
|---|---|---|
| **Notion** | sidebar 树、文档留白、callout 块、emoji 锚点 | 数据库视图复杂度、cover image |
| **Claude.ai** | 暖底色、衬线正文、hero composer、对话节奏 | message 气泡、artifact 侧边栏（V0.1） |
| **Linear** | 键盘优先、Command Palette、密度 | dark-first、cyan/emerald 信号、紧凑驾驶舱感 |
| **Raycast** | overlay Command Palette 形态 | 顶部贴边、酷炫渐变 |

---

## 2. 设计 Tokens

### 2.1 色板（Light-first）

> 命名约定：CSS variable 写 `--color-*`（Tailwind v4 `@theme` 友好），utility class 写 `bg-*` / `text-*` / `border-*`。文字色用 `ink` 命名空间（避开 `text-text-*` 双重命名），边框色用 `line` 命名空间（避开 `border-border-*`）。设计稿与文档讨论时可用语义名（"主文本色 / 卡片边"），代码层用工程名。

#### 基底层

| CSS variable | Utility | 值 | 用途 |
|---|---|---|---|
| `--color-app` | `bg-app` | `#FAF7F2` | App background，暖米白（不是纯白） |
| `--color-surface` | `bg-surface` | `#FDFAF5` | 普通卡片底 |
| `--color-elevated` | `bg-elevated` | `#FFFFFF` | 浮起卡片（Health Check / Error / Command Palette） |
| `--color-overlay` | `bg-overlay` | `rgba(31,27,23,0.4)` | Command Palette / modal 遮罩 |

#### 边框 / 分隔（line 命名空间）

| CSS variable | Utility | 值 | 用途 |
|---|---|---|---|
| `--color-line` | `border-line` | `#EDE6D8` | 卡片边、divider 默认 |
| `--color-line-strong` | `border-line-strong` | `#D9CFB8` | hover 边、focus 边（非杏沙时） |
| `--color-line-subtle` | `border-line-subtle` | `rgba(31,27,23,0.06)` | 更弱的内分隔（如 inspector row 之间） |

#### 文字三档（ink 命名空间）

| CSS variable | Utility | 值 | 用途 |
|---|---|---|---|
| `--color-ink` | `text-ink` / `bg-ink` | `#1F1B17` | charcoal-warm，标题、主文本、主 CTA 填充 |
| `--color-ink-soft` | `text-ink-soft` | `#5C544A` | 次要文本、metadata |
| `--color-ink-muted` | `text-ink-muted` | `#8E867A` | hint、placeholder、timestamp |

#### 互动状态

| CSS variable | Utility | 值 | 用途 |
|---|---|---|---|
| `--color-hover` | `bg-hover` | `#F2EDE3` | 中性灰 hover（不抢戏） |
| `--color-selected` | `bg-selected` | `#F8EDDA` | 杏沙 tint（品牌时刻） |

> Focus ring 用 `--color-brand`（`ring-brand`），不单独 token。

#### 品牌 / 状态

| CSS variable | Utility | 值 | 用途 |
|---|---|---|---|
| `--color-brand` | `bg-brand` / `text-brand` / `ring-brand` | `#D9A78A` | 杏沙，体温色 + Composer Submit CTA 例外 |
| `--color-brand-soft` | `bg-brand-soft` | `#F8EDDA` | 杏沙最浅 tint |
| `--color-brand-strong` | `bg-brand-strong` / `text-brand-strong` | `#C68762` | 杏沙 hover/active；当前 step 状态 icon、Submit hover |
| `--color-success` | `text-success` / `bg-success` | `#5A8C5A` | 成功状态 line icon |
| `--color-warning` | `text-warning` / `bg-warning` | `#BF7A1F` | 深琥珀 warning（与杏沙拉开 13° 色相） |
| `--color-error` | `text-error` / `bg-error` | `#B14545` | 深红 |
| `--color-info` | `text-info` / `bg-info` | `#7A7A8E` | muted 灰蓝（info severity） |

### 2.2 字体（方案 C：三 register）

| Register | 字体（英 / 中） | 用途 |
|---|---|---|
| **Serif（被读）** | Newsreader / 思源宋体 | 用户消息、agent 回复、turn summary |
| **Sans（被点）** | Inter / 苹方 / 思源黑体 | 按钮、菜单、metadata、session row |
| **Mono（技术 ID）** | JetBrains Mono | shell 命令、路径、JSON、tool 名 |

字号 / 行高：

- Body: 16px / line-height 1.65–1.7
- Subtle: 13px / line-height 1.5
- Hint: 11px uppercase tracked
- Heading（Newsreader medium）: 20–24px

### 2.3 Icon set

**Phosphor Thin** 全局唯一 icon set。

- 默认 16px stroke 1.25px
- 状态色随上下文（参考 §2.1 状态色）
- **不用 emoji 做状态指示**（跨平台渲染不一致 + 视觉太重）
- **唯一 emoji 例外**：Conversation thinking summary 锚点 💭（Notion-style 文档区合法 register）

### 2.4 圆角 / 阴影 / 间距

| Token | 值 | 用途 |
|---|---|---|
| `radius-sm` | 6px | inline element |
| `radius-md` | 12px | card |
| `radius-lg` | 14px | overlay (Command Palette) |
| `shadow-card` | `0 1px 2px rgba(31,27,23,0.04)` | 普通卡片 |
| `shadow-elevated` | `0 8px 24px rgba(31,27,23,0.12)` | 浮起卡片、Command Palette |
| `space-unit` | 4px | 间距基础单位 |

---

## 3. 整体布局

```
┌─────────────────────────────────────────────────────────────┐
│ Top Bar（44px）— traffic light · Sidebar toggle · Title · ⌘K │
├──────────────┬─────────────────────────┬────────────────────┤
│              │                         │                    │
│  Sidebar     │   Conversation          │   Inspector        │
│  (240px)     │   + Tool Timeline       │   (320px)          │
│              │                         │   default expanded │
│              │   ┌───────────────┐     │                    │
│              │   │ Approval Dock │     │   3 tabs:          │
│              │   │ (sticky)      │     │   Details          │
│              │   ├───────────────┤     │   Approvals        │
│              │   │ Composer      │     │   Runtime          │
│              │   └───────────────┘     │                    │
└──────────────┴─────────────────────────┴────────────────────┘
```

- 三栏宽度 240 / flex / 320，min total 1120px（V0.1 不做窄屏特殊处理）
- ⌘\\ 折叠 Sidebar
- Inspector 默认展开（Empty state 时收起）

---

## 4. 组件 Spec

### 4.1 Top Bar

- **44px 高**，自定义 titlebar（macOS traffic light 集成）
- 三段 flex 布局：traffic light reserve（70px）｜ **session title 居中**（flex-1）｜ 右侧 actions
  - title 居中是 macOS chrome 标准（Safari / Notion / Mail / Pages / Finder），跟 traffic light 之间不靠近避免视觉拥挤
  - 长 title truncate 居中
- **Session title inline edit**（点击进入编辑态，Enter 提交，Esc 取消）
- 右：YOLO indicator（条件渲染）+ ⌘K Command Palette 入口（Phosphor `MagnifyingGlass`）+ Settings 入口（Phosphor `Gear` thin，tooltip "Settings · ⌘,"）。**不放 `...` 更多按钮**——V0.1 没有真正的二级菜单条目，dead 按钮反而占视觉
- Sidebar toggle 不在这里（移到 Sidebar header logo 旁，避免跟 traffic light 视觉撞一起）
- 整个 TopBar 加 `data-tauri-drag-region`，作为窗口拖动 handle（Tauri v2 需要 `core:window:allow-start-dragging` 权限，buttons 由 Tauri 自动豁免）
- **不显示**：runtime（在 Sidebar 顶部）/ Stop（在 Composer Submit 位置）/ Context Window（V0.1 拿不到）/ 价格
- Windows / Linux 暂用 native titlebar 兜底

#### YOLO Indicator（条件渲染，PRD §11.5）

YOLO mode 开启时在 ⌘K 按钮**左侧**渲染 persistent badge：

```
[ ⚡ YOLO ]
```

- 视觉：6px padding-x / 4px padding-y / 圆角 6px / `bg-warning/10` 浅琥珀背景 / `text-warning` 深琥珀文字 / `border border-warning/30` 1px 同色边框
- 内容：14px Phosphor `Lightning` thin + "YOLO" 12px Inter medium 大写
- 不闪烁、不脉动——视觉警示靠颜色对比，动效会让用户疲劳后忽略
- 永远可见（不 hover 显示），这是核心承诺
- **点击行为**：弹 popover（Radix Popover，宽 280px，14px padding）
  - 标题 13px Inter medium："YOLO 模式已开启"
  - 一行 12px muted："所有 tool 调用跳过审批直接执行"
  - 一个深琥珀 button：`Lightning` 16px + "立即关闭"——点击直接关 + 关闭 popover + indicator 消失
  - secondary link "在 Settings 中查看 →"（打开 Settings → Approval tab）
- **未开启时不渲染**——这个位置完全空（不留占位），TopBar 视觉跟现在一致

设计判断：indicator 视觉上比"普通的右侧按钮"重，不是因为追求漂亮，而是要让用户**每次扫 TopBar 都注意到**这个状态。深琥珀 (`--color-warning` #C68762) 在 light theme 主背景上反差足够，不至于过度恐吓用 error 红色（用户开了 YOLO 不是出了问题，只是在做"我知道风险"的事）。

### 4.2 Sidebar

#### 结构（自上而下）

```
┌──────────────────────────────────┐
│ [Galley logo]              │  16px Newsreader medium
│ Runtime: ● healthy               │  13px Inter, 点击弹 Health Check Card popover
├──────────────────────────────────┤
│ + New Chat                 ⌘N    │  Quick action
│ Search                     ⌘K    │  打开 Command Palette
├──────────────────────────────────┤
│ PINNED                           │  仅有 pin session 时显示
│   ◐ Session A                    │
├──────────────────────────────────┤
│ TODAY                            │
│   ◐ Session 1            📂      │  session 属于某 project 时行尾带 emoji tag
│   ◐ Session 2                    │
│ THIS WEEK                        │
│ EARLIER                          │
├──────────────────────────────────┤
│ PROJECTS                  [+]    │  section header `+` = New project
│   📁 Galley   12 · 2h ago  │  collapsed default
│   📂 Marketing Site  5 · now ●   │  active project 自动展开 + 圆点指示当前 session
│     ◐ landing redesign    Turn 3 │
│     ⏸ pricing copy        Turn 1 │
│     ✓ SEO meta audit             │
│     View all 5 sessions →        │  > 5 时出现，跳到 Project view
│   📁 写作笔记         3 · 3d ago │
├──────────────────────────────────┤
│ Trash                  (隐蔽)    │  底部
└──────────────────────────────────┘
```

#### 关键决策

- **去掉 ACTIVE / WAITING FOR YOU 区块**：状态由 row icon 颜色对比 + Approval Dock 兜底
- **去掉 "UNFILED" 命名**：通用 Agent 工作台 80%+ 对话本就 free-floating，时间分组就是主体
- **PINNED section** 仅在有 pin session 时显示，空时不占位
- **PROJECTS** 是 V0.1 纯归类容器（PRD §7.3）；session 双重显示（project 内 + 时间流），timeline 内的归属 session 行尾带 project emoji tag
- **Trash** 整行清空需输入 `delete` 三字符确认；单条永久删用 modal 但不要求字符
- ⌘\\ 折叠 sidebar / ⌘K 全局 Command Palette / 右键 + hover `...` 双入口

#### Session Row（参考 PRD §7.5）

每行显示：

- 16px Phosphor thin **状态 icon**（颜色随状态）
  - idle: `Circle` muted / connecting: `CircleNotch` 旋转 / running: `CircleNotch` 杏沙旋转 / waiting_approval: `Pause` 深琥珀 / error: `X` 深红 / completed: `CheckCircle` 杏沙 / archived: `ArchiveBox` muted
- **Title**（13px Inter medium，1 行 truncate）
- **下一行**：`Turn N · {summary}`（11px Inter muted，1 行 truncate）
- **角标**：pending approval count（深琥珀点 + 数字）/ error count（深红点）
- **Project tag**（仅在 timeline section 内）：行尾 12px project emoji（无 cwd → 📁，有 cwd → 📂），hover tooltip 显示 project name；project section 内的 session row 不带此 tag

#### Project Section Spec

PROJECTS 是 sidebar 的次要 section（保持在 timeline 之下），但 coding agent 用户的真实使用频率把它推到比 v0.2 初稿设想更核心。本节细化 row、展开行为、入口、操作菜单。

**A. Project Row 折叠行为**

- 每个 project 默认 collapsed，只显示一行：emoji + name + session count + last activity time
  - count = 该 project 下非 archived session 数量；为 0 时省略数字
  - last activity = `max(sessions.lastActivityAt)`，friendly format（`now` / `2h ago` / `3d ago` / `2026-05-01`）
- **当前 active session 所属的 project 自动展开**（同 OS file tree 行为：你在哪我打开哪）
- 用户手动点击其他 project header 可临时展开/收起，**不持久化**——切换 active 后状态自动复位（active 永远展开，其他永远默认收起）
- 收起态视觉：emoji 16px + name 13px Inter medium + count·time 11px Inter muted（行尾右对齐）
- 展开态视觉：collapsed row 不变 + 下方 indent 16px 渲染 session list，无连接线（保持留白克制）

**B. 展开后显示规则**

- 展开后最多渲染 **5 条 session**（按 lastActivityAt desc 排序）
- 超过 5 条时底部出现 `View all N sessions →`（11px Inter muted，杏沙 hover）
  - 点击进入 **Project View**：sidebar 不变，主区切换为该 project 的完整 sessions list + project meta header（项目名 / cwd / created / 总 session 数）
  - Project View 是 V0.1 唯一的"sidebar 不变、主区切到次级页面"模式；ESC 或 sidebar 任意 session row 点击退出
- 不超过 5 条时不显示 `View all`

**C. Project Row Hover Affordance**

- Hover Project row 时行尾出现两个 16px Phosphor thin icon：
  - **`Plus`**：在该 project 下新建 session（spawn bridge with `cwd = project.rootPath`，新 session 自动 `projectId` 归属）
  - **`DotsThree`**：弹出菜单
    - Rename project
    - Change cwd…（`@tauri-apps/plugin-dialog` folder picker）
    - Pin to top / Unpin
    - Delete project（confirm modal："Delete project? Its N sessions will be moved back to timeline."）
- 非 hover 态隐藏，避免视觉噪声
- collapsed 与 expanded 两态行为一致

**D. Session 双重显示与 Project Tag**

- 同一 session 同时出现在 timeline section（按 created 时间分组）+ project section（如归属）
- **Timeline 内**：session row 行尾添加 project tag（12px emoji），hover tooltip 显示 project name；点击 tag 不跳转（避免误触），点击 row 主体进入 session
- **Project 内**：session row 不带 tag（上下文已知，避免冗余）
- **Active session 高亮策略（默认 X）**：active session 在 timeline 与 project section **两处都 highlighted**（杏沙背景 4% + 左侧 2px brand 竖条）
  - Rationale：Claude 网页版即此模式；用户从任一 view 都能立刻定位"我在哪"
  - 反对意见已知：sidebar 两处同时亮起视觉噪声偏大
  - **此为内测前默认假设**，等真实使用收集到"两处同亮"的具体抱怨再切换至 Y（仅 project 高亮）或 Z（仅 timeline 高亮）

**E. 移动 Session 到 Project**

- V0.1 仅支持右键菜单：session row right-click → `加入项目 ▸` submenu → 列出全部 project + `(no project)` 选项
- 已属某 project 的 session 在 submenu 中该 project 名前打勾
- **不做拖拽**（V0.2 候选，sidebar drag/drop 工程坑较深）
- 移动后：UI 立即重渲染（timeline 内 session tag 更新 + 原/新 project 内 session list 更新）；DB 异步双写

**F. Project 排序**

- 默认排序：`pinned desc, lastActivityAt desc`（pin 永远置顶，pin 内部和非 pin 内部都按最近活动倒序）
- 不做用户手动拖拽排序（V0.1）
- pin 切换通过 `[...]` 菜单
- pin/unpin 后立即重排，不做动画过渡（避免视觉跳动）

**G. New Project 流程**

- PROJECTS section header 行尾 `Plus` icon（16px Phosphor thin），hover 显示 "New project"
- 点击弹 Radix Dialog（同 Settings modal frame，~480x320）：
  - **Name**（required，autofocus）
  - **Working directory**（optional，folder picker via `@tauri-apps/plugin-dialog`，留空 = 无 cwd）
  - **Emoji**（默认 `📁`，有 cwd 时默认 `📂`；用户可改任意 emoji）
- Submit 后：`INSERT INTO projects`，sidebar 立即出现该 project（自动展开，session count = 0），dialog 关闭
- Empty project 显示："No sessions yet · [+ New session here]"（杏沙 ghost button）

**Project View（次级页面）spec**

进入路径：Project row 展开后底部 `View all` 链接，或 collapsed row 双击。

```
┌── 主区 ───────────────────────────────────────┐
│  📂 Marketing Site                            │
│  ~/code/marketing  ·  Created 2026-04-12      │
│  12 sessions                                  │
│                                                │
│  [+ New session in this project]              │
│  ─────────────────────────────────────────    │
│  ◐ landing redesign         Turn 3 · 写文案    │
│  ⏸ pricing copy             Turn 1 · 等审批    │
│  ✓ SEO meta audit           completed         │
│  ...                                          │
└────────────────────────────────────────────────┘
```

- Sidebar **不变**（PROJECTS section 该 project 仍展开 + active 高亮在 project 名上）
- 主区 header：emoji + name（点击 inline rename）+ cwd 路径（点击 change）+ meta 行
- Session list 全量、按 lastActivityAt desc，row 跟 sidebar session row 同样视觉但稍宽
- ESC / 点击 sidebar 任意 session / `+ New Chat` 退出 Project View 回到 conversation 模式
- Project View 不是模态，导航栈深度 = 1（不嵌套）

### 4.3 Conversation 主区

#### Turn 结构

```
Turn 1                                           ← 11px mono uppercase soft（来自 GA turnIndex）
[💭 Thinking summary callout]                    ← 序列最前，emoji 锚点
[Tool callout 1]                                 ← 行动序列
[Tool callout 2]
─────────────────                                ← 稍深 1px 全宽 hr（行动 → 结论）
[Final answer，浮在文档里]                       ← 不放 callout
Turn 2                                           ← 自带 mt-7 (28px) 的 chapter-mark，承担 turn 间分隔
[💭 Thinking summary callout]
...
```

**没有 turn 之间的 SoftHr** —— TurnMarker 自带视觉重量 + 上方间距，承担 turn-to-turn 的章节分隔。不再有水平横线。

#### User vs Agent 三重区分（不用气泡）

| 维度 | User | Agent |
|---|---|---|
| 字体 | Inter 500 | Newsreader 400 |
| 字重 | medium | regular |
| 锚点 | 左侧 3px 杏沙竖条 + 杏沙底 `bg-brand-soft` + 右侧 6px 圆角 | 无 |
| 对齐 | 左对齐 | 左对齐 |

不要 right-align 不要气泡 —— 这是文档区，不是聊天 IM。**用户消息是 callout 块，不是 bubble**：全宽对齐、左强边线、轻底色——参照 Markdown blockquote / Notion callout 的文档语法，而非 IM 单侧浮起。

长对话里这是用户**回找自己提问**的主视觉锚——杏沙底 + 品牌竖线让每个 user turn 成为滚动停靠点。AI 回复保持纯散文无底色，"提问（高亮锚）→ AI 回复（要读的内容）" 的层次随之建立。

#### Thinking Summary

- 每 turn 第一个 callout，💭 emoji 锚点（破例 emoji 合法）
- 内容 = LLM 这一轮"打算做什么"的总结
- Newsreader italic muted，13px

#### Markdown 渲染

Final answer 跟 Thinking summary 都通过 `react-markdown` + `remark-gfm` + Shiki 渲染。LLM 输出的 markdown（标题 / 列表 / 表格 / 代码块 / 引用 / 链接 / 删除线）全部解析成对应 DOM，没解析的纯文本走默认段落。

**typography 映射**（每个元素 pull 现有 token，不引入新字号）：

| markdown | 渲染 |
|---|---|
| `p` | Newsreader 16.5px (`agent`) / Newsreader italic 14px muted (`thinking`) |
| `h1` | Newsreader medium 22px |
| `h2` | Newsreader medium 19px |
| `h3` | Newsreader medium 17px（故意接近正文，避免视觉跳跃） |
| `h4` | Newsreader medium 15.5px |
| `ul` / `ol` | 标准缩进，`::marker` text-ink-muted |
| `li` | 紧 paragraph 形态（list 内 `<p>` margin 0） |
| 行内 `code` | mono 0.86em + bg-hover 浅底（pill） |
| 块代码 ` ```python ` | 详见下方 Shiki 段 |
| `blockquote` | 左 3px brand 竖线 + italic + ink-soft |
| `a` | text-brand-strong + 1px 下划线 + 安全 _blank |
| `table` (GFM) | border-collapse + th `bg-surface` + 单元格 padding 12px×8px |
| `hr` | 1px line + my-5 |
| `strong` | font-medium（不到 bolder，跟 Newsreader 协调） |
| `em` | italic |
| `~~del~~` (GFM) | line-through ink-muted |

**视觉哲学**：每个 markdown 元素 reuse 现有 Newsreader / Inter / JetBrains-Mono token，不为 markdown 单独引入字号 ramp。整段对话读起来是一个 document，不是 stylesheet 拼贴。

#### 代码块语法高亮（Shiki）

- 引擎：[Shiki](https://shiki.style) v1+，TextMate grammar，跟 VS Code / Claude.ai web 同款
- 主题：`github-light`，跟 Galley light 主题对齐
- 注册语言（hand-picked）：`bash` / `css` / `diff` / `html` / `javascript` / `json` / `markdown` / `python` / `rust` / `shell` / `sql` / `tsx` / `typescript` / `yaml` —— 14 种 coding agent 用户高频
- 别名：`js → javascript` / `ts → typescript` / `py → python` / `rs → rust` / `sh → bash` / `yml → yaml`
- 未注册的语言：fallback 到无色 mono code block（同样的 chrome，仅没 token color），不报错
- async render：第一次 highlighter 加载时显示 plain mono fallback，加载完替换；同 highlighter 实例 cache，跨 code block 共享
- 视觉容器：1px line border + bg-surface + 圆角 6px + 顶部一行 mono uppercase 11px 显示语言名
- 横向 overflow scrollable（不 wrap）

V0.1 代码块顶部 header 右侧加 **hover-revealed Copy 按钮**（11px Phosphor `Copy` thin + uppercase "Copy" 标签，hover 时 fade-in，复制后变 ✓ + "Copied" 1.5s 反馈）。复制内容是**纯代码**——不带 ` ``` ` fence、不带 markdown chrome。Claude.ai / ChatGPT / Cursor 的肌肉记忆位置。

V0.1 不做：代码块行号 / Edit 在行内（V0.2 候选）。

#### Message Actions（reply 级行动条）

每段 agent final answer 下方常驻一行 muted 行动条（DESIGN.md §4.3 dogfood 反馈：用户经常想保留 reply 内容）：

| 按钮 | 行为 |
|---|---|
| `Copy` | 复制原始 markdown source（带 `**bold**` `## headers`），不是渲染后纯文本——用户粘贴目的地（Notion / Obsidian / Slack / 邮件）多数能 re-render markdown |
| `Save` | Tauri save dialog → `.md` 文件。默认文件名 `ga-{YYYYMMDD-HHmmss}.md`，用户可改 |

视觉：

- 位置：reply markdown 渲染**正下方**，gap 8px (`mt-2`)
- 字号 12px Inter + 13px Phosphor thin icon
- **常驻可见**（不 hover-only），text-ink-muted；hover 升 ink-soft + bg-hover
- 点击后 0.5s 内 icon 变 Check + 文字变 "Copied" / "Saved"，1.5s 后回 idle
- success 反馈用 `text-success`（绿色 token）

工程：
- Copy 走 `navigator.clipboard.writeText` web API（Tauri webview 支持）
- Save 走 `@tauri-apps/plugin-dialog` `save()` + `@tauri-apps/plugin-fs` `writeTextFile`
- Capabilities 加 `dialog:default` / `fs:allow-write-text-file` + `fs:scope` 限制到 `$HOME` / `$DOCUMENT` / `$DESKTOP` / `$DOWNLOAD`（保留用户常去的目录）

V0.1 **不做**：

- **Regenerate 按钮**：需要 GA history 回滚 + 跨 turn 状态管理，工程量大；推后到 V0.2 跟 multi-session / session 恢复一并设计
- **Continue 按钮**：用户自己输入"继续"即可，不需要专用按钮
- **Pin / 收藏**：需要数据模型扩展，V0.1 单 session 不值
- **Branch（从这里分叉新 session）**：跟 multi-session 深度耦合，V0.1 没法做
- **TTS / 翻译 / Share**：依赖外部服务，跟产品定位不符

ReactNode children（非 markdown string）的 reply 不渲染 actions——demo fixture 没 markdown source 可复制。

#### Scroll behaviour（stick to user message top）

Conversation 主区是 `overflow-y-auto` 的列。用户提交新消息时**不**滚到底部（reply 还没生成，跳到一片空地）；**也不**被动什么都不做（user message 出现在视口外，看不到反馈）。**正确做法**：把刚 submit 的 user message 顶端贴到 viewport 顶部下方 32px 处。

跟 Claude.ai / ChatGPT 收敛的同一模式。理由：

- 用户提交完立刻能看到自己的提问
- 长 reply 不会推走问题——问题永远在视口顶端附近
- 短 reply 用户也不必往下找答案——它就在问题正下方
- 阅读 reply 期间**不被打扰**（不跟随）

实现细节：

- store 加 `userSubmitTick` 计数器，`appendUserTurn` 时 +1
- MainView `useEffect` 监听 `userSubmitTick` 变化（不监听 `turns.length`——避免 `turn_end` 也触发滚）
- RAF 推迟到 `<MessageUser data-role="user-msg">` 真实 mount 后
- 找最后一个 `[data-role="user-msg"]`，算 offset (`top - container.top - 32`)，`container.scrollBy({ top: delta, behavior: "smooth" })`
- 不用 `scrollIntoView({block: "start"})`：它没法控 padding

边界：

| 场景 | 行为 |
|---|---|
| 第一次提交（EmptyState → MainView 切换） | 同样滚一次（保险，user message 已经在顶部时 delta 接近 0，相当于 noop） |
| Turn_end 来 / 流式 token 流入 | 不触发（store 状态变了但 tick 没变） |
| 用户主动向上翻历史 | 不打断（仅 submit 触发） |
| 切换历史 session（multi-session 后） | 默认滚到底（看到最后 turn）；不属于此 spec 范畴 |

#### Streaming generation（流式 partial 渲染）

Bridge 订阅 GA 的 `display_queue`（`agentmain.put_task` 返回），把每个 partial chunk 通过 IPC `turn_progress` event 推给 desktop。Desktop 累积成 `inFlightContent`，跑 `cleanPartialContent` strip 掉 GA 内部 tag 后用 `MarkdownView` 实时渲染。

| 时机 | 显示 |
|---|---|
| User 提交 → bridge spawn → LLM TTFT | `💭 思考中…` placeholder |
| 第一批 token 到 | placeholder 消失，partial markdown 开始流出 |
| 流式过程中 | partial 持续增长，Markdown re-render（行内 / 列表 / 代码块都跟着出现） |
| `turn_end` 到 | partial 被 finalized AgentTurn **替换**（store `appendAgentTurn` clear inFlightContent） |
| Tool call 触发 | partial 暂停，Approval Card 出现 |
| 用户决策后 → bridge 继续 → 下一 turn | 新 turn 的 partial 重新开始流（store `turn_start` clear inFlightContent） |

**关键 robustness**：partial 输入是 GA-raw（`<thinking>` / `<summary>` / `<tool_use>` / `<file_content>` / `[FILE:...]`），且**可能 mid-tag**（比如刚收到 `<thi` 没 close）。`cleanPartialContent` 的 4 步算法：

1. Strip 完整的 `<tag>...</tag>` block
2. 找 leftmost unclosed open tag → 截断
3. 找 trailing partial open-tag start（"<thi" / "</sum"）→ 截断
4. Strip `[FILE:...]` refs + 折叠空行

效果：用户在任何 sampling instant 都看不到 GA 内部 scaffolding 闪过。

#### Sticky-bottom + Scroll-to-bottom 浮动按钮

- 流式过程中**默认跟随**：`atBottom` flag 通过 scroll listener 维护（24px tolerance），在底部时 `useLayoutEffect` 监听 `inFlightContent` 变化把 `scrollTop = scrollHeight`
- **用户向上滚 → 不跟随**：`atBottom = false`，stream 继续但视图不动
- **浮动按钮**：`atBottom = false` 时 conversation 列右下角（Composer 上方 140px）出现一个 36px 圆形 ghost 按钮，⬇ ArrowDown thin icon
- 点按钮 → `scrollTo({ top: scrollHeight, behavior: "smooth" })` + `atBottom = true`（重新启用跟随）
- ESC / 任何手动 wheel 不影响按钮可见性（仅 scroll position 决定）

#### Thinking Placeholder（in-flight 占位）

用户提交消息后到 `turn_end` 到达之间存在显著延迟（LLM TTFT 可达几秒到十几秒）。如果不显示状态指示，用户会觉得 UI 卡住。

- 用户提交瞬间 store 设 `agentRunning = true`（不等 `turn_start` IPC，避免一次往返延迟）
- conversation 末尾立即渲染一个 ThinkingSummary 风格的占位：内容 "思考中…" Newsreader italic
- 触发条件：`agentRunning && pendingApprovals.length === 0`（pending 状态时已经有 Approval Card 兜底）
- `turn_end` / `error` / `run_complete` 到达时 `agentRunning = false`，占位消失，真 thinking summary + tools + final answer 一次性渲染替换
- 视觉跟正式 ThinkingSummary 同款（💭 + 杏沙竖条 + 6% tint），保持视觉连续性

Composer 状态同步：`agentRunning = true` 时 Submit 按钮切到 Stop 模式，LLM dropdown disable。

#### Turn 编号 + 间距

**不是**用户↔agent 对话轮次，**是 GA 内部 agent loop 的 turn 计数**——每次 LLM call + dispatch = 1 turn。一个 user message 可以触发 GA 跑 N 个 turn（agent 不断 reflect + 调 tool 直到出 final answer）。这跟 PRD §7.5 sidebar session row 显示的 "Turn N · summary" 同一个 N。

- 数据来源：每个 IPC `turn_start` / `turn_end` event 都带 `turnIndex` 字段
- AgentTurn type 持有 `turnIndex`（一个 user message 在 conversation 里可能产生多个 AgentTurn）
- 渲染：每个 AgentTurn 的 thinking summary 之上一行，`Turn N` 11px Inter mono uppercase soft（`text-ink-soft`，比 muted 重一档），`tracking-[0.12em]` 大字距增强 chapter-mark 仪式感，`mt-7`（28px）上方间距承担 turn 间章节分隔
- in-flight 状态：`currentTurnIndex` 从 `turn_start` 读取；thinking placeholder 顶部也显示 `Turn N` 标记让用户感知 agent 当前跑到第几迭代
- `run_complete` / `error` 时清空 currentTurnIndex
- **没有 turn 之间的 SoftHr**——TurnMarker 自带 chapter-break 视觉重量，水平横线已删除

#### 间距演化历史

`turn 间分隔`经过四次调整：

1. v0.1 初版：SoftHr `my-9`（72px）—— dogfood 反馈"每个 turn 浪费 1/3 屏"
2. SoftHr `my-6`（48px）—— 仍反馈"还是大"
3. SoftHr `my-5`（40px）—— 仍反馈"还是大"
4. **现行**：删除 SoftHr，TurnMarker `mt-7`（28px）+ tracking 加大承担分隔

教训：当用户反复反馈"间距大"时，缩 hr 到极小已经不是答案；该思考"分隔信号"是不是必须靠 hr 承担。结果：TurnMarker 的章节标识 + 间距 + 字号已经足够。

### 4.4 Composer

#### 视觉

- **杏沙 focus ring**（`brand` token）
- 圆角 12px / `surface` 背景 / 默认 1px `border-default`
- 上方留 1.5em，下方贴 viewport bottom（in-session）或居中（empty state hero）
- + icon 占位（V0.2 接 attach）/ Submit 按钮

#### Submit 按钮（杏沙 CTA 例外）

- **Submit 是全局唯一用杏沙作为 CTA 填充的元素** —— 用户最高频元素，杏沙带来"亲和体温"
- Phosphor `ArrowUp` thin / 32px circle / 杏沙填充 / charcoal icon
- Enter 触发，Shift+Enter 换行
- agent running 时**位置替换为 Stop 按钮**（深琥珀填充 / Phosphor `Stop` thin），点击触发 abort

#### LLM 切换器（V0.1）

位置：**Composer 内部左下角**，跟 + button 并列。

- 形态：Phosphor `Cube` thin icon + LLM displayName + `CaretDown` thin
- Ghost button / hover `hover-tint` / 13px Inter / 28px 高
- 点击展开 popover：
  - `surface-elevated` 背景 + `shadow-elevated`
  - 圆角 12px / 内边距 8px / 每行 32px
  - current 项右侧杏沙 ✓
  - 切换中 `Check` 替换为 `CircleNotch` 旋转
- agent running / waiting approval 时 disabled，hover 显示 tooltip "Wait for the current run to finish"
- LLM list > 8 时加 scroll
- displayName 由 bridge 端 `_simplify_llm_name` 生成（详见 IPC 协议）

#### 不显示

Context Window / 价格 / token estimate（V0.1 拿不到 + 信息噪音）

### 4.5 Tool Event Callout

#### 视觉（像 Notion callout，不像 stdout log）

每个 tool call 是独立 block：

- **左侧 3px 状态色竖条** + **1px `border-default`** + **12px 圆角**
- **不用 background tint**（暖米白底上太花）
- 16px Phosphor thin icon + tool name（mono）+ status pill + `CaretDown`
- 内边距 16px / 上下 margin 12px

#### 6 状态映射

| 状态 | 左竖条色 | icon | 默认折叠 |
|---|---|---|---|
| running | 杏沙 `brand` | `CircleNotch` 旋转 | 当前 step 默认展开 |
| success-current | 杏沙 | `CheckCircle` | 当前 step 默认展开 |
| **success-historical** | **几乎不可见**（融入背景） | `CheckCircle` muted | **默认折叠** |
| waiting_approval | 深琥珀 | `Pause` | **强制展开**（不可折叠） |
| failed | 深红 | `X` | **强制展开** |
| denied | muted | `Prohibit` | 折叠（结果已知，不重要） |

#### 展开内容

- **args preview**：mono 等宽，syntax highlight
- **stdout / progress**：mono 等宽，scroll 区域 max 200px
- **result preview**：折叠 raw JSON 链接

### 4.6 Approval Dock + Approval Card

#### Approval Dock（Composer 上方 sticky）

- **仅在有 pending approval 时存在**（不是 hide，是不渲染）
- amber-tint `#F8EDDA` 背景 + 3px 深琥珀左竖条
- 单行：`{count} pending approval · Next: {tool_name}` + Advance button
- **不可 dismiss**（必处理状态必须 surface）
- hover 显示 tooltip 预览
- 决策仍必须在对应的 callout 内做（dock 是 navigator，callout 是 decider）

#### Approval Card（waiting_approval 状态的 inline form）

**不是独立组件**，是 Tool callout 的 waiting_approval 形态。展开后内嵌：

- **风险等级 pill**：high（深红）/ medium（深琥珀）/ low（muted）
- **动作说明**：1 行人话 ("Run shell command" / "Patch file at /path")
- **目标对象 / 工具特定渲染**（见下）
- **为什么需要审批**：1 行 muted 文案
- **四个按钮**（Phosphor icon + label）：
  - Allow once（charcoal primary）
  - Deny（深红 ghost）
  - Always allow in this Project（杏沙 ghost）
  - Always allow globally（杏沙 ghost，high risk 工具如 `start_long_term_update` disabled）

#### 工具特定渲染

##### `file_patch` — split diff 视图（V0.1 必做）

- **V0.1 实现**：自研 PatchView（`diff` npm 包计算 line-level changes + Tailwind 渲染 split layout），无语法高亮
- 数据来源：`args.path` / `args.old_content` / `args.new_content`（GA `file_patch(path, old_content, new_content)` 签名）
- 视觉：
  - Header：path（mono）+ 文件 size delta（`+12 / -3 lines`，13px muted）
  - Split layout（左旧右新）/ 行号显示
  - +/- 行用 success/error 8% tint 背景；空 placeholder 行用 hover-tint 斜纹
  - max-height 480px，超出 scroll
  - 折叠时只显示 header + `View diff`
- 为什么 V0.1 必做：file_patch 是审批高频工具，没 diff 视图等于"审批黑盒"，违反"不要让用户思考"原则
- 为什么不用 `@pierre/diffs`：试过，其 Shiki backend 拉所有语言包进 bundle（+400 KB gzip）。V0.1 审批界面不需要工业级语法高亮，line-level +/- 已足够。`@pierre/diffs` 留 V0.2 候选 —— 真需要 hover/highlight + scoped 语言时再切换

##### `file_write` — 仅 path + mode

- 显示 `path`（mono）+ `mode pill`（overwrite/append/prepend）
- 下方 muted 一行："内容由 LLM 当前回复决定，将写入此文件"
- **不做内容预览**：GA 架构限制（`do_file_write` 跑时才从 `response.content` 提取，dispatch 拦截时还没跑），提前预览需要复刻 GA 逻辑，违反 non-invasive

##### `code_run` — 命令展示

- mono 等宽 + 语言高亮（bash / python / powershell）
- 多行命令完整展示（不截断）
- 顶部 language pill

##### `start_long_term_update` — memory 写入

- 显示 memory key + 内容预览
- high risk 标记，**Always allow globally 选项 disabled**

### 4.7 Inspector

#### 默认状态

- **默认展开**（"可观察"是 PRD 强调的能力，藏起来等于自废武功）
- **Empty state（无 session）时收起**（更干净）
- 用户偏好持久化（V0.2 决定，V0.1 简单 toggle）

#### 3 Tabs

| Tab | 内容 |
|---|---|
| **Details** | 自适应当前 main 区 selection；选中 tool callout 显示完整 raw JSON / 选中 message 显示 metadata |
| **Approvals** | 当前 session 所有 approval 历史 / pending 列表 / "Jump to in conversation" link（滚到对应 callout 并杏沙背景闪烁 1.5s） |
| **Runtime** | Health Check Card 嵌入版 / GA path / Bridge Python / 子进程 PID / 当前 LLM displayName |

**Logs 不在这里**（移到 Settings → Developer，V0.2）

---

## 5. 流程：Onboarding（4 步多页 wizard）

形态：多页 wizard 而非单页 scroll —— 每步只关注一件事。气质 Linear / Raycast 的极简首次启动，不教学、不讲故事。

### Step 0 — 欢迎页

- 大标题 `Galley`（Newsreader medium 36px）
- 衬线副标题（italic muted 18px）："GA 的本地桌面工作台"
- 三件事简列（13px Inter，charcoal）：
  - 多 session 并行
  - 高风险动作审批
  - 历史会话恢复
- 主 CTA `开始`（charcoal 填充）
- Footer muted 一行："不会修改你的 GA，删除 Galley 后 GA 独立可用"

### Step 1 — Attach GA

- 路径输入框（mono / 预填 `~/Documents/GenericAgent` / 可改）
- 文件夹选择器按钮（Phosphor `FolderOpen`）
- **实时反馈**（路径变化时立刻校验）：
  - 路径不存在 → 深红 X icon + "路径不存在"
  - 路径存在但找不到 `agentmain.py` → 深琥珀 Warning + "未在此路径找到 agentmain.py，确认这是 GA 安装目录？"
  - 路径合法 → 杏沙 Check + "找到 GA 安装"
- 主 CTA `继续`（路径合法时启用）
- 弱链接 muted 文案："还没装 GenericAgent？→ 在这里安装"（外链 GA GitHub）

### Step 2 — Health Check

跑 5 项检查，**全过才能继续**：

1. 路径存在
2. Python 可用（默认 system Python，可在 Settings 改 BRIDGE_PYTHON）
3. `agentmain.py` 可 import
4. `mykey.py` 存在
5. 至少一个 LLM 配置可解析

**故意决策**：跳过 LLM session dry-run（dry-run 真发 API 请求会消耗 quota）。第一次发 message 时如有问题再报错（详见 §7 Error Card 的首次失败引导）。

UI：嵌入 Health Check Card（详见 §6.1），失败项必须 fix 才能继续，**不允许"以只读模式进入"**（Galley 没 LLM 什么都做不了）。

### Step 3 — 进入主界面

本质是"Onboarding 消失"。用户被带到主界面，看到 Empty state hero composer。

---

## 6. 卡片家族（Health Check / Error）

两个 card 共享同一个视觉骨架：

- `surface-elevated` 背景 + 1px `border-default` + `shadow-card`
- 圆角 12px / 内边距 16px
- 左侧 16px Phosphor thin icon + severity 色

### 6.1 Health Check Card

#### 5 个出场场合

1. Onboarding Step 2
2. Inspector → Runtime tab
3. Top Bar runtime row 点击弹 popover
4. Settings → Runtime "Re-run health check"
5. 系统检测 GA 异常时主动弹

#### 视觉

- 标题："Health Check" + 总状态 pill（All passed / N failed）
- 5 项目列表，每项一行：
  - 16px Phosphor thin icon + 状态色：
    - pending: muted dot
    - running: `CircleNotch` 杏沙旋转
    - success: `Check` muted 灰
    - failed: `X` 深红
    - warning: `Warning` 深琥珀
    - blocked: `Pause` muted
  - 13px Inter / 项目名
  - 失败项 expand 显示错误简要 + inline action button："打开 GA 安装指南" / "选择其他路径" / "View details"
- 底部："All checks passed" 或 "Fix N issue(s) to continue"

#### 行为差异

- onboarding：失败必须 fix（阻断）
- 其他场合：允许查看 unhealthy，但 Top Bar runtime indicator 显示 unhealthy

### 6.2 Error Card

#### 三种 severity

| Severity | icon | 色 | token |
|---|---|---|---|
| error | `X` | 深红 `#B14545` | `error` |
| warning | `Warning` | 深琥珀 `#BF7A1F` | `warning` |
| info | `Info` | muted 灰蓝 `#7A7A8E` | `info` |

#### 三种出场场合

| Category | 场合 | 形态 |
|---|---|---|
| `runtime` | Tool 执行失败 / LLM 调用失败 / agent 报错 | **Conversation 流内 inline message bubble**（紧跟出错 tool 之后，Tool callout 行保持失败状态） |
| `bridge` | bridge crash / IPC 协议 mismatch | **Top-level toast**（5s auto-dismiss 或手动叉） |
| `business` | Attach 路径非法 / 历史恢复失败 / SQLite 损坏 | **Top-level toast** |

Inline 类**不可 dismiss**（属于对话历史）；toast 类可手动 dismiss。

#### 标准展示

- 标题（14px Inter medium）+ 一行简要（13px muted）
- 主 action button（杏沙轮廓 ghost / 28px / Phosphor icon + label）
- 可折叠 details panel（点 `CaretDown` 展开）：
  - stack trace / 完整 error message / source 字段
  - 等宽 12px JetBrains Mono
  - 给 power user 看的，普通用户不需要看

#### 重试语义

- bridge **不主动 retry**
- desktop 根据 IPC 字段 `retryable=true` 显示 Retry button
- 点击 Retry = 触发新的 send_message（参数复用上次），不是隐藏副作用

#### 首次 message 失败的友好引导（hint 系统）

bridge 端检测错误类型，emit 时附 `hint` 字段，desktop 渲染专用引导卡片：

| hint | 触发条件 | 卡片内容 |
|---|---|---|
| `check_llm_config` | 401/403/`api_key`/`unauthorized` keyword | 标题 "LLM 配置可能有问题" / 一行 "首次发送失败，通常是 API key 或配置问题" / Actions: "检查 mykey.py" / "查看 GA 文档" / "View raw error" |
| `network` | 网络超时 / DNS 失败 | 标题 "网络无法连接" / Actions: "Retry" / "View raw error" |
| `quota_exceeded` | 429 / quota keyword | 标题 "API 配额耗尽" / 一行 "可切换其他 LLM 继续" / Actions: "Switch LLM" (打开 Composer LLM dropdown) / "View raw error" |
| （无 hint） | 其他错误 | 标准 Error Card |

**为什么不直接显示 "401 Unauthorized"**：普通用户看到原始错误不知道下一步。"哪里出错 → 怎么解决"的翻译是 Galley 比裸跑 GA 增值的关键点。

---

## 7. Empty State（无 session 时主区）

主界面没 session 时**不放大段欢迎文案**，**Composer 浮在视口中部**（不在底部正常位置）。提交第一条后滑到底部。

参考 Claude.ai / ChatGPT / Cursor 标准模式，跟"对话工作台"心智一致。

### 视觉

```
                      你想做什么？             ← Newsreader italic muted
            ┌─────────────────────────────┐
            │ Composer (居中，560px max)   │
            │ [Cube] LLM dropdown │ [+]   │
            │                       [↑]   │
            └─────────────────────────────┘

           ▢ 翻译     ▢ 整理会议笔记
           ▢ 论文查询  ▢ 写脚本               ← 4 quick prompts，不偏 coding
```

- 上方：衬线 italic muted "你想做什么？"
- Composer 居中（含 LLM 切换器，跟 in-session 对称）
- 下方 4 条 quick prompts（13px Inter ghost button）：翻译 / 整理会议笔记 / 论文查询 / 写脚本 —— **故意不偏 coding**，体现"通用 Agent"心智
- Sidebar 极简版（只 New Chat + Search 显示，时间分组 section header 不显示）
- **Inspector 默认 hide**（empty state 收起更干净，进入 session 后展开）
- **不放快捷键 hint 行**（曾尝试在底部加 `⌘K · ⌘N · ⌘\` 一行 muted 提示，但稀释了"你想做什么？"的聚焦感；first impression 应该极简。完整快捷键列表移到 Settings → Shortcuts tab）

---

## 8. Command Palette（⌘K Overlay）

### 触发与形态

- `⌘K` 开 / `Esc` 或点遮罩关
- **居中 overlay**（不贴顶；居中更聚焦，不遮 Top Bar 状态）
- 宽度 **560px**（不顶天立地）
- 高度自适应，max 420px（约 8 行结果），超出 scroll
- 背景 `surface-elevated` + `shadow-elevated` + 圆角 14px
- 触发后页面其余加 `surface-overlay` 遮罩，**无模糊**（模糊太花）

### 不加 ⌘P 别名

只 `⌘K`，少而精（VS Code/macOS `⌘P` 习惯不引入）。

### 内容范围（V0.1 收敛）

#### Session 类（主轴）

- 最近 8 个 session（按 `lastActiveAt` 倒序）
- 搜索：按 title 模糊匹配（V0.2 加 message 内容全文搜索）
- "New chat" 永远固定在第一项

#### Action 类（少而精）

- Switch LLM → 嵌套二级（展开当前 availableLLMs 列表）
- Re-run health check
- Open settings
- Toggle inspector
- Attach GA folder（仅 onboarding 已完成、想换路径时）

#### 故意排除（V0.1 不做）

- 跨 session 全文搜索
- Theme switcher（V0.1 light-only）
- Quick prompt insertion（empty state 已经有）
- 任何 destructive action（删除 session 之类，Palette 不该让破坏太轻松）

### 视觉细节

- **Input row**：48px 高 / 17px Inter / placeholder italic muted "搜索 session 或输入命令…" / 左侧 16px Phosphor `MagnifyingGlass` thin / 右侧 `Esc` shortcut hint（13px muted）
- **Divider**：1px `border-default`
- **Result row**：36px 高 / 13px Inter / 左侧 16px Phosphor icon / 中间 label / 右侧 keyboard shortcut（如 `⌘N`）灰色 hint
- **Section header**（仅多组结果时）：11px Inter uppercase tracked `RECENT` / `ACTIONS` / `LLMS` —— 大多数情况下不显示 header（结果少时 header 是噪音）
- **Hover / 键盘选中态**：背景 `hover-tint`，左侧 2px charcoal 竖条
- **Empty state**：输入有内容但无匹配 → 中央一行 muted "没找到。Enter 直接发问？" + Enter shortcut（**做** —— 输入框里写的字 Enter 直接 new chat + 把它当第一句 prompt，是对"文档对话工作台"心智的延伸）

### 关键交互

- ↑↓ 选 / Enter 执行 / Tab 进二级（如 Switch LLM 子菜单）
- 输入"#"前缀强制只搜 session（V0.2 留）；输入">"前缀只搜 action（V0.2 留）
- **没有最近搜索历史持久化**（V0.1 简化）

### 排序规则

- Session 类按 lastActiveAt
- Action 类按内置优先级：New chat > Switch LLM > Re-run health check > Open settings > Toggle inspector
- Switch LLM 嵌套二级而不是平铺（避免 LLM 多时淹没 session）

---

## 9. Settings（独立窗口）

### 形态决策

**独立窗口**（不是 modal，不是主视图替换）。理由：

- 用户经常需要"边设置边看主界面有没有变化"
- modal 遮挡主视图、独立路径替换会丢 session 上下文
- macOS 原生应用（System Settings / 1Password / Linear）都是独立 settings window

### 窗口规格

- **720 × 560px / resizable / 跟主窗口同款 traffic light**
- 左侧 180px Tab list（垂直），右侧主内容区
- 不能多开（再次触发就 focus 已有的）
- 触发：菜单栏 / 主窗口 ⌘, / Command Palette "Open settings"

### V0.1 三个 Tab

#### Runtime

- **GA path**：当前路径显示（mono）+ 重选按钮（触发文件夹选择器）
  - 改动后弹 confirm dialog："路径改动需要重启 Galley 才能生效。立即重启？/ 稍后"（不悄悄 kill 所有 session）
- **Bridge Python**：当前 interpreter 路径显示 + 重选 + muted hint "用于运行 bridge，影响 GA 子进程"
- **Re-run health check**：button → 弹 Health Check Card 重跑
- 底部 muted 一行：`GA baseline: 6a3eecc...` + `Galley v0.1.0`

#### Approval

- **YOLO mode toggle**（PRD §11.5）—— Tab 顶部第一项，跟下方常规设置之间留 32px gap + 一条 `border-line` 分隔线，视觉上独立成块（不被埋没在普通 toggle 列表里）
  - Toggle 行：左 18px Phosphor `Lightning` thin（深琥珀 `--color-warning`）+ "YOLO 模式" Newsreader medium 14px + 右侧 Switch
  - Toggle 下方一行 muted 12px："跳过所有 tool 调用的审批，直接执行——适合完全信任 agent + 沙盒环境"
  - 当前已开启状态：Switch 杏沙激活 + 行底部一段 13px 文案"⚡ YOLO 已启用 · TopBar 显示状态" + secondary button "立即关闭"
  - 关闭 → 开启触发 confirm modal（见下）；开启 → 关闭直接生效，无 confirm
- **Approval-required tools**：复选列表（默认 `code_run` / `file_write` / `file_patch` / `start_long_term_update`），用户可勾选；YOLO 开启时整个 section 显示 `opacity-50` + tooltip "YOLO 已开启，per-tool 审批不生效"，但**不禁用**——用户关 YOLO 后仍生效
- **Always-allow rules**：分两组显示
  - **Per-project**（当前 attached GA 目录下的）—— 列出 tool name + 添加日期 + remove 按钮
  - **Global** —— 同上
  - YOLO 开启时同样 dimmed
- 改动后弹 toast "已应用到所有 session"（避免"太隐式"）
- 底部 muted hint："Always-allow 在审批弹窗里勾'always allow'后会出现在这里"

##### YOLO 启用 confirm modal

Radix Dialog，~480 × 360。文案（中文）：

```
⚡ 打开 YOLO 模式？

YOLO = "You Only Live Once"。
所有 tool 调用将不经审批直接执行——包括：

  · file_patch（修改文件）
  · file_write（写入文件）
  · code_run（执行命令）
  · 其他高风险操作

适合：完全信任 agent + 在沙盒环境工作（个人 repo / 临时虚拟机）
不适合：生产代码 / 共享系统 / 不熟悉的 agent / 敏感数据

打开后 TopBar 会显示 ⚡ YOLO 标识，随时可一键关闭。

  [取消]  [是的，我知道在做什么]
```

视觉细节：

- 标题 ⚡ + "打开 YOLO 模式？" Newsreader medium 18px
- 主体 13px Inter，bullet 列表用 mono `·` 锚点
- "是的，我知道在做什么" 按钮：深琥珀 `bg-warning` 背景 + 白色文字（不是品牌杏沙——视觉上要显眼但不像"OK"那种条件反射按钮）
- "取消"：ghost button 默认 focus，回车默认是取消（避免误触确认）
- ESC 关闭 = 取消

#### About

- App icon + `Galley` 标题（Newsreader medium 18px）
- 版本号 / GA baseline commit / build date
- Links（Phosphor `ArrowSquareOut`）：GitHub / Documentation / Report issue（外链浏览器）
- License：MIT
- 一行 `Made by JCONE · Open source`

### 视觉

- **Tab list**：每项 32px 高 / 13px Inter / 左侧 16px Phosphor icon
  - Runtime: `Cpu`
  - Approval: `ShieldCheck`
  - About: `Info`
- 选中态：`hover-tint` 背景 + 左侧 2px charcoal 竖条
- **主内容区**：内边距 32px / 标题 18px Newsreader medium / 描述 13px Inter muted / 控件之间 24px 垂直间距
- **Form 控件**：路径 input + 文件夹选择器按钮（Phosphor `FolderOpen`）/ 复选框跟 Approval Dock 同款 / Button 体系跟主界面一致
- **没有 sticky save button**：所有改动**即时生效 + 自动持久化**（违反"不要让用户思考"），破坏性改动单独 confirm dialog

### 推到 V0.2 的 Tab

- **General** （theme / language / telemetry）—— V0.1 light-only 中文
- **LLM**（custom displayName / default index）—— per-app preference 已够，custom name V0.2
- **Data**（SQLite 位置 / export / clear history）—— V0.1 不做高危数据 UI
- **Developer**（Logs / IPC trace）—— V0.1 用 stderr 调试

注：原本"Shortcuts（自定义快捷键）"推到 V0.2，但 V0.1 dogfood 时发现快捷键列表无处展示（删了 Empty state 底部的 hint 行后），所以 V0.1 加了 **read-only 的 Shortcuts tab**——只展示当前快捷键列表 + 简短说明，rebind 仍 V0.2。

#### Shortcuts（V0.1 read-only）

- 三个 group：Navigation / Composer / Overlays
- 每行：左侧 kbd 风格 chip（`bg-surface` + `border-line` + 圆角 sm + mono）+ 右侧 action 文字 + 可选 italic muted note（如 "wiring 待补"）
- 列表内容跟 §10 全局快捷键表保持同步
- 顶部一行 12.5px muted 提示："V0.1 不支持自定义，V0.2 加重绑入口"

---

## 10. 全局快捷键

| 键位 | 动作 |
|---|---|
| `⌘K` | Command Palette |
| `⌘N` | New chat |
| `⌘\\` | 折叠 Sidebar |
| `⌘,` | 打开 Settings |
| `⌘E` | Toggle Inspector |
| `Esc` | 关 overlay / 退 inline edit |
| `Enter` | Composer 发送 / Palette 执行 |
| `Shift+Enter` | Composer 换行 |
| `↑ / ↓` | Palette 选项 |
| `Tab` | Palette 进二级 |
| `⌥↑ / ⌥↓` | 跳到对话中上 / 下一条用户提问（焦点在 Composer 时不生效） |

---

## 11. 已知未决与扩展方向

### V0.1 范围内 open

- **Inspector default 展开 vs Empty state 隐藏的状态切换**：用户首次完成 onboarding → 第一次进入主界面（empty state，Inspector 隐藏）→ 发了第一条消息后（Inspector 应展开还是仍隐藏？用户偏好持久化？）
- **LLM displayName 标准化字典覆盖范围**（当前 13 个 brand keyword）：实际跑 e2e 验证用户 mykey.py 里所有 LLM 都能 prettify 后再扩
- **Composer LLM dropdown 在 long LLM list 下的 UX**：V0.1 不做特殊处理，超过 8 个加 scroll
- **Onboarding 走完后下次启动是否每次跑 Health Check**：建议**后台**重新跑（不阻塞 UI），失败时弹 toast；V0.2 desktop 阶段验证

### 推到 V0.2+ 的设计扩展

- **Dark mode**：light-first token 已预留命名空间（`surface-dark` 系列待补）
- **`file_write` 内容预览**：依赖 GA 上游把 `extract_robust_content` 前置到 dispatch，可以是给 GA 的 PR
- **Slash commands** in Composer（`/restore` `/new` 等）
- **Cross-session 全文搜索**（Command Palette `#` prefix）
- **Custom LLM displayName**（Settings → LLM tab）
- **拖拽 session 到 Project**（V0.1 用右键 + `...`）
- **Trees / file explorer**（如果 V0.2+ 加 file inspector，候选 [trees.software](https://trees.software) + [@pierre/diffs](https://diffs.com) 配套）

---

## 12. 与 Notion 历史稿的关系

- v0.1 完整版（dark-first / Linear 风）保留在 Notion 作为历史对照（page id `3552aab6e913815f91a1c2b8b0a15672`）
- v0.2 working draft 在本仓库 + devlog
- v0.2 完整版（本文件）定稿后，会同步到 Notion 保持镜像

完整决策叙事见 `docs/devlog/`：

- `2026-05-07-design-direction-pivot.md` — Notion + Claude 转向，9 块基础对齐
- `2026-05-08-onboarding-and-llm-switching.md` — Onboarding / Empty / Health Check / LLM 切换
- `2026-05-08-design-trio-finale.md` — Error Card / Command Palette / Settings + file_patch diff
