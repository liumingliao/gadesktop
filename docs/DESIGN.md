# GenericAgent Workbench DESIGN.md

> Status: **Draft v0.2 — work in progress**
> Last updated: 2026-05-07
> v0.1（dark-first / Linear 风）已被 v0.2 整体方向替换。

## v0.2 设计方向

PRD v0.2 落定后，UI 设计方向从 v0.1 的"dark graphite + cyan-emerald + Linear/Raycast 紧凑驾驶舱"重构为：

- **气质**：Notion + Claude 结合 —— 文档化的对话工作台
- **模式**：Light-first（暖米白基底；dark mode 暂缓到 V0.2+）
- **品牌色**：杏沙 `#D9A78A`（产品体温色，不做主 CTA 填充）
- **字体**：Newsreader 衬线（内容）+ Inter（UI）+ JetBrains Mono（命令）三 register
- **Icon set**：Phosphor Thin

完整 token、组件 spec、交互规则的对齐过程，见 [devlog 的设计相关 entry](./devlog/)。当所有组件设计讨论结束后，本文件会更新为完整 v0.2 spec。

## 当前进度

设计基础已对齐：

- [x] 整体气质方向（Notion + Claude 结合）
- [x] Light-first 完整色板（surface / 文字三档 / 互动状态 / 状态色）
- [x] 字体方案 C（内容衬线 / UI 无衬线 / 命令等宽）
- [x] Sidebar Spec（含 PIN / Projects / Trash / Command Palette / 折叠）
- [x] Tool Event callout（6 状态映射 / 折叠展开 / inline approval）
- [x] Conversation 主区（user vs agent 三重区分 / thinking summary / turn 结构 / 双 hr / scroll）
- [x] Composer（杏沙 focus ring + 杏沙 Submit 例外 / Enter 发送）
- [x] Approval Dock（amber sticky 单行 / 不可 dismiss / hover preview）
- [x] Top Bar（macOS traffic light 集成 / session title inline edit）
- [x] Inspector（默认展开 / 3 tabs / Logs 移到 Settings → Developer）

设计还在讨论中：

- [ ] Onboarding / Empty state / Health Check Card
- [ ] Error Card
- [ ] Command Palette UI
- [ ] Settings

讨论完成后，所有对齐内容会一次性合并到本文件作为 v0.2 完整版。

## 与上游设计稿的关系

- v0.1 完整版仍在 Notion 保留为历史对照
- v0.2 working draft 在本仓库 + devlog
- v0.2 完整版定稿后，会同步到 Notion 保持镜像
