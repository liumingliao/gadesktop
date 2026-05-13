# UI 文案 i18n + brand 一致性 sweep + TopBar 标题菜单重构 + repo 重命名

**Date**: 2026-05-13
**Status**: shipped
**Related**: [Galley 重命名 + 多项 V0.1 功能马拉松](./2026-05-13-galley-rename-and-features-marathon.md)（前序 rebrand），CLAUDE.md「Brand wordmark rules」

## Context

V0.1 dogfood polish 阶段，作者指出 TopBar 标题旁边的 `⋯` 按钮「看起来像标题没显示完的省略号」—— 这个小问题打开了一连串更大的一致性话题：

- TopBar 菜单触发器形态怎么改才不歧义？
- 顺手发现 Sidebar 右键菜单 / TopBar / Settings / Onboarding / ApprovalForm 大面积中英混杂
- 前几天 GA Workbench → Galley rebrand commit 之后，UI 里还有 11 处 `Workbench` 漏网
- 既然品牌都改了，GitHub repo 名是不是也该同步？

整个 session 围绕「一旦决定走中文 UI 和 Galley brand，就把半成品一致性收齐」展开。

## Decisions

### 1. TopBar 标题菜单：⋯ → title-as-dropdown trigger

视觉：`[ 会话标题 ▾ ]` 整块作为一个 Radix DropdownMenu trigger，hover / open 时整块 `bg-hover` 填充，caret 用 `data-[state=open]:rotate-180`。

实施 ([TopBar.tsx](../../desktop/src/components/layout/TopBar.tsx))：

- min-w-0 / max-w-full / 内层 truncate + caret shrink-0 → 长标题截断但 caret 不被挤掉
- 拖窗：父 div 仍 `data-tauri-drag-region`（标题左右空白可拖窗），button 被 Tauri 自动豁免
- align 从 `end` → `center`（trigger 居中，菜单跟着居中弹）

根本问题不是图标选错了，是「标题旁边出现的东西都被读成标题的一部分」—— 换图标只治标，title-as-trigger 才消歧。

### 2. Session rename 入口收编到 TopBar 标题菜单

菜单结构（顺序有讲究）：

```
✎ 重命名
────
↻ 重新注入工具
🐱 桌面宠物
```

- 顶部「重命名」是身份/元数据操作；分隔线下是 runtime 工具 —— 用户认同这个分类
- inline edit 镜像 sidebar 既有 `SessionTitleEditor`（autofocus + select-all + Enter/Esc/blur + settledRef 防双触发）
- input 加 `data-tauri-drag-region="false"`（[TopBar.tsx:101](../../desktop/src/components/layout/TopBar.tsx:101) 老注释早就预告过这一步）
- Radix `onCloseAutoFocus` 拦截：菜单关闭 Radix 默认 focus return 到 trigger button，但这时 button 已经被 input 替换，会跟 input 的 autofocus 抢焦点 → ref + preventDefault 拦掉

之前 sidebar 右键改名是唯一入口，现在 TopBar 也有 → 两处发现性同等。

### 3. i18n 一致性 framework — Plan B

「选了中文版的产品里夹零星英文 = 没翻译完，不是国际化」。

规则：

- **section header / brand 锚点 / 装饰性 label** → 保留英文（`PROJECTS` / `GALLEY` 等）
- **body / 菜单项 / hint / placeholder / aria-label** → 全中文
- **代码 identifier**（`sessionId` / `Session` type / `workbenchVersion` 字段名 / `workbench_bridge` Python 模块 / `genericagent-workbench` GitHub URL 直到我们重命名）→ 保留英文
- **Devlog / 评论里的英文动词描述**（"Right-click → Pin / Unpin"）→ 保留（dev 上下文）

参考：Notion CN 就是这么做的 —— sidebar 大写 `Workspace` header + body 用「工作区」。

### 4. Session / Chat 用语统一 → 「对话」

UI 字符串里：「会话」（技术）→ 「对话」（自然语言）。TopBar 占位「新对话」已经在这一档，全员对齐。

代码 identifier `session` / `Session` 完全保留 —— code 跟 UI 解耦。

### 5. Project body text → 「项目」（但 section header `PROJECTS` 不动）

最初作者提议「句子里也保留 Project」（混合语言）。Push back 否决：

- 「移动到 Project」「删除 Project」属于一个句子里切语种，大脑 parsing 成本最高
- section header 已经承担 brand 锚点，菜单/弹窗里 Project 重复出现没边际收益
- Notion CN 一样：`Workspace` header / `工作区` body

落地：菜单「归入项目」「编辑项目」「删除项目」「从项目移除」，弹窗标题「新建项目」「编辑项目」，hint「暂无项目」「还没有项目」。

### 6. ApprovalForm 按钮 + pill 全翻译 + 「白名单」框架对齐

```
按钮（点击前）：
  允许 / 拒绝 / 加入「{projectName}」白名单 / 加入全局白名单

pill（点击后）：
  已通过 · 本次执行
  已拒绝 · 已通知 AI
  已加入此项目白名单
  已加入全局白名单
```

关键：**按钮 verb 和 pill verb 同源**（都是「加入白名单」）。如果按钮说「始终允许」、pill 说「已加入白名单」，用户会有 1 秒认知卡顿。

「白名单」比「始终允许」更具体、有画面感（「加到一个表里」）—— 中文 tech 圈成熟词。

「允许」/「拒绝」单字不加「本次」/「始终」前缀：4 个按钮的对比本身就传达层次，靠按钮 1 vs 3/4 的对比让「本次」隐含成立，比写出来更利落。参考 macOS / Chrome / 微信审批弹窗的「允许」/「始终允许」隐式 convention。

### 7. 「已通知 AI」 — 拒绝信号收件人的措辞

原文 `Denied · agent 将收到拒绝信号`：

- agent 准确但是英文 token
- 作者提议改 `已通知 Galley` —— **push back 否决**：Galley 是 UI 壳/传话筒，AI agent 才是 deny 信号的真正接收方
- 落到 **`已通知 AI`**：短 + 准 + 无英文 token

也把原来「将收到信号」改成「已通知」（将来时 → 完成时）+ 干掉「信号」工程师词。

### 8. Workbench → Galley brand polish（11 处 user-facing）

[Galley rename marathon](./2026-05-13-galley-rename-and-features-marathon.md) 当天漏的 11 处全收：

- useAppStore toast / SettingsRuntime subtitle + hint + version stamp / EditProjectDialog hint / Onboarding StepAttach + StepHealth 两处 + 「进入 Galley」按钮 / ErrorCard 错误标题 / Composer LLM picker hint / demo.ts mock title

**保留**（有意识）：
- About 页 L50「Galley started as a workbench for GenericAgent」—— 小写 common noun + CLAUDE.md 明文规定的品牌起源叙事
- 代码 identifier（`workbenchVersion` / `workbench_bridge` / `ga-workbench-layout-2col-v2`）
- 代码注释里的 Workbench

### 9. GA vs GenericAgent — 长文本展开 / 紧凑 label 缩写

framework：

- **解释性长文 / 首次接触 / section subtitle** → `GenericAgent`
- **紧凑 label / 状态徽章 / 重复出现 / 命令列表** → `GA`

只动 2 处：

- SettingsRuntime subtitle（`GA 的启动参数` → `GenericAgent 的启动参数`）
- SettingsRuntime SubLabel（`GA Version` → `GenericAgent 版本`；顺手翻 Version）
- SettingsApproval reason（`写入 GA global memory` → `写入 GenericAgent 长期记忆`；跟 ApprovalForm 里同概念的「长期记忆」对齐）

其它 ~18 处 GA 保留：Sidebar 状态徽章 / Onboarding step nav / Health check item / Command palette action / ApprovalForm reason / ErrorCard 文档 link / About 版本表 dt。

### 10. GitHub repo 重命名 genericagent-workbench → galley

pre-launch 阶段改成本最低；GitHub auto-redirect 兜底。

连带：

- README clone 命令 + cd 命令
- CLAUDE.md 目录结构示例
- SettingsAbout 3 条 URL（href + 显示文本 + issues link）
- 本地 `git remote set-url origin` 改直，不依赖 redirect

**保留**（temporal authenticity）：
- [2026-05-13-baseline-regression-and-feature-detection.md](./2026-05-13-baseline-regression-and-feature-detection.md) 里指向 commit `92a48fe` 的历史链接 → devlog 是历史叙事，commit URL 要锚定那一刻
- `docs/GenericAgent Workbench-handoff/` 整个目录 → rebrand 前的 design handoff 文物，目录名 + 内部 README 都是「彼时彼刻」的快照

本地目录 `genericagent-webui` 作者决定不改（dev-only，跨设备本来就不一致）。

## Rejected alternatives

### TopBar 标题菜单触发器形态

- **换 icon（DotsThreeVertical / CaretDown）+ 视觉分隔** —— 比保留水平 DotsThree 好，但「标题旁边的东西」歧义没消除，是治标
- **把 `⋯` 挪到右边 action cluster** —— 失去「session-scoped 跟 global 分开」的层次，且右边集群已经够拥挤

### Pin / Unpin 保留英文

作者最初直觉「短 / 都懂」。否决：

- 「Pin」3 字符 ≥ 「置顶」2 中文字符 —— 简洁论不成立
- 「都懂」是滑坡：Pin 都懂 → Archive 都懂 → 那为什么不全英文？翻译边界一旦交给「都懂」做裁判，会越退越多
- WeChat / 飞书 / Linear CN / Notion CN 没有一个保留 Pin

### 句子里保留 "Project"（混合语言）

作者提议方案 A：「移动到 Project」「删除 Project」。否决理由见 Decision #5。

### Rename 菜单项放底部 / 不要分隔线

作者最初问「为什么加分隔线」—— 我承认当时的「主操作 / 工具」分类是事后给自己找的理由，建议拿掉。**作者反过来认同分类、要求保留分隔线**：身份/元数据 vs runtime 工具确实是两个 category。

这是个有意思的反转：默认应该 push back 过度修饰，但当用户给出比我更清晰的分类理由时要让步。

### 「已通知 Galley」/「已通知 agent」

- Galley → 语义错（Galley 是 UI 壳，不是接收方）
- agent → 准确但中英混
- AI → 短 + 准 + 全中文

### 新 repo 名 `galley-workbench` / `galley-app` / `galley-desktop`

- `galley-workbench` → 把 Galley 拖回「Galley Workbench」二元品牌，跟 CLAUDE.md 品牌规则冲突
- `galley-app` / `galley-desktop` → 后缀啰嗦，brand 弱化
- `galley` → 干净，namespace 没冲突（作者实跑确认可用）

### 保留 `genericagent-workbench` 不改 repo

- pre-launch 不改成本会越来越高（外部 link 累积）
- About 页显示文本已经写 Galley 但 URL 露馅，半成品感
- GitHub redirect 兜底，迁移代价极低

## Open questions

1. **ApprovalForm 按钮 icon 跟新 copy 框架对应不上**：FolderSimple / Globe 暗示「in this folder / globally」，但新 copy 是「加入白名单」—— Plus 或 Shield 更贴「加入」语义。这次只动 copy 不动 icon，留下次。
2. **SettingsAbout 还有 SubLabel `Links` / `Also by wangjc683` 是英文**，跟同页「本地优先」中文 SubLabel 不一致 —— 这次未动。
3. **SettingsRuntime `Re-run health check` + Onboarding StepHealth `Back` 按钮**：扫到但未动。
4. **demo.ts mock data**：里面还有「Workbench 桌面端」改成了「Galley 桌面端」—— 但 demo data 是 dev-only 还是 prod 也能触发？需要复核。

## Next

- 推一个 commit（这次 sweep + rebrand cleanup + repo rename connections） + push
- 下次 dogfood 真跑一遍：
  - TopBar 标题菜单 caret 旋转 / 长标题截断不挤 caret / hover 整块填充
  - 重命名 inline edit：autofocus + 长标题输入框宽度 / Enter blur Esc 三键
  - ApprovalForm 4 按钮在窄列下的换行 / 4 个 pill 颜色和新 copy 语气匹配
  - Sidebar 所有右键菜单中文 / Settings 4 个 tab brand 一致性
  - macOS 系统旁白模式（VoiceOver）念出所有 aria-label 中文
