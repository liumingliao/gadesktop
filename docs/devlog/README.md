# Devlog

GA Workbench 开发日志：记录设计与工程决策的"为什么"，以及考虑过但被否的方案。

补充于 PRD（产品定义）、DESIGN.md（设计规则）、CLAUDE.md（项目宪法）—— devlog 提供历史叙事和 decision provenance。git log 太短只说"是什么"，PRD 太静态只说"现在是什么"，devlog 才记录"我们怎么走到这里的"。

## 时间线

| 日期 | 主题 | 摘要 |
|---|---|---|
| 2026-05-07 | [Stage 1 Bridge POC 完成](./2026-05-07-stage1-bridge-poc-complete.md) | IPC 协议 v0.1 落地 + WorkbenchHandler 双轨制 + 主入口 + 5 项 e2e 全过 |
| 2026-05-07 | [设计方向转向 Notion + Claude](./2026-05-07-design-direction-pivot.md) | 从 dark/Linear 风转向 light/文档对话工作台；9 块设计基础对齐 |
| 2026-05-08 | [首次体验三连 + LLM 切换](./2026-05-08-onboarding-and-llm-switching.md) | Onboarding wizard / Empty state hero composer / Health Check Card 设计；LLM 切换工程层完成（IPC + bridge + 测试） |
| 2026-05-08 | [设计三连收尾 + file_patch diff + Error hint](./2026-05-08-design-trio-finale.md) | Error Card / Command Palette / Settings 设计 + file_patch diff 视图加入 V0.1 + ErrorEvent 四字段扩展（IPC + bridge + 测试）+ DESIGN.md v0.2 完整版定稿 |
| 2026-05-08 | [Stage 2 桌面端骨架完成](./2026-05-08-stage2-desktop-skeleton-complete.md) | Tauri v2 + React 19 + Tailwind v4 + Zustand + SQLite + Python bridge IPC 端到端串通；11 个子任务（#1-#10b）一气呵成；@pierre/diffs reversal；conversation source-of-truth 优先级 |
| 2026-05-09 | [Project 模型 · coding agent 用户的归类容器](./2026-05-09-project-model-coding-agent.md) | Project = 纯归类抽屉（不绑 instructions / 不改变 GA 内核体验）；schema 加 pinned + lastActivityAt；DESIGN.md sidebar Project Section Spec A-G + Project View 二级页面；migration 策略首次明确（V0.1 release 前直改 001） |
| 2026-05-09 | [YOLO Mode · 审批是出口而非围栏](./2026-05-09-yolo-mode.md) | PRD §6.1 #4 重新表述（审批是出口）+ §11.5 加 YOLO Mode；命名 / TopBar persistent indicator / activation modal 文案 / bridge needs_approval 优先级；IPC `set_yolo_mode` 命令；prefs API 通用化；5 个新 bridge test 全过 |
| 2026-05-09 | [Stage 3 #1 端到端真跑 + 一波 dogfood UX polish](./2026-05-09-stage3-end-to-end-and-ux-polish.md) | 16 个 commits 把端到端真跑打通 + dogfood polish + 提前做 V0.2 范围（Markdown + Shiki / Message actions / 流式生成 + sticky-bottom）；spawn capability fix / drag region / 7 个跑通过程暴露的 bug；SoftHr 4 轮迭代后干脆删；V0.1 七件事剩 #2 + #5 |

## 格式约定

每个 entry 6 段：

- **Date / Status / Related** — 元信息（含 PRD/DESIGN/commit 引用）
- **Context** — 这次讨论或工作的背景
- **Decisions** — 对齐的具体结论，列表化、可索引
- **Rejected alternatives** — 考虑过但没选的方案 + 理由（最有价值的部分）
- **Open questions** — 留待后续的问题
- **Next** — 这次工作的下一步

## 触发时机

主动写 devlog 的三种场合：

1. 每次 work session 结束（"今天先到这里"）
2. 重大设计/架构决策对齐后（不一定等 session 结束）
3. 阶段切换（如 Stage 1 → Stage 2，写一份阶段总结）

## 写作责任

- Claude 主写：每次决策对齐后主动提议落 devlog
- 作者 review：可以 inline 调整，Claude 根据反馈改
- 不重复信息：devlog 不复述 PRD / DESIGN.md / CLAUDE.md 已有的内容，只记叙事 + decision provenance

## 文件命名

`YYYY-MM-DD-topic-in-kebab-case.md`，一天可以多个 entry（按主题分）。
