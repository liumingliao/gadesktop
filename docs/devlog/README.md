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
