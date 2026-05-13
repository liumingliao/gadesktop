# Devlog

Galley 开发日志：记录设计与工程决策的"为什么"，以及考虑过但被否的方案。

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
| 2026-05-11 | [Stage 3 multi-session：N-active + useShallow 踩坑 + LRU 5](./2026-05-11-stage3-multi-session-and-perf.md) | tool_events 审批审计持久化（v0.1 scope）+ N-active 多进程并存架构（1-active 被用户一票否决）+ useShallow 反模式踩坑（React 19 strict mode getSnapshot 死循环→app 空白；改 store-side enrichment 修复）+ LRU 5 资源策略拍板（待 Task 3 配套）+ launcher 调研给 Task 3 留 `set_state` 协议参考；撤回沉淀 Skill chip（违反 GA non-invasive 哲学） |
| 2026-05-11 | [Stage 3 V0.1 收尾 + dogfood 7 轮 UX 打磨](./2026-05-11-stage3-v0.1-completion.md) | 14 个 commits 把 V0.1 七件事代码层做齐：Multi-session polish 4 项 / Session Restore（user message turn_index = turnCount+1 + ready 触发 replayHistoryToBridge）/ LRU 5 alive + active 保护 / Settings path picker（Python 字段诚实改只读）/ Onboarding fs.exists 5 项 health check / macOS bundle bridge/ 作 Tauri resource；然后第一次跑 dev 真实体验，7 轮 dogfood 反馈：composer auto-grow / LLM 内联 Popover / 右键 Archive + toast / lazy New Chat + 清「新对话」累积 / 软化 thinking placeholder + strip GA `LLM Running` marker / 「第 N 轮」→「第 N 步」/ Sidebar 三状态 unread / 修复 turn summary 静默丢失 |
| 2026-05-12 | [Stage 3 dogfood polish marathon + turn_index 双层语义拆分](./2026-05-12-dogfood-polish-marathon.md) | 17 个 commits 第二轮 dogfood 收尾。关键 critical fix: GA 每条 user_message 的 `agent_runner_loop` 都从 turn=1 重置 → SQLite ON CONFLICT 静默覆盖老 assistant row → conversation 错乱。修法拆 turn_index 双层语义（DB absolute / UI per-message GA 原生）+ rowsToTurns 反推 base，零 migration。其它 polish: LRU 加 agentRunning 保护 / streaming 三件套（typing dots + cursor + fake typewriter）/ Archive 系统完整化（双层 destructive confirm）/ Tool callout 哲学讨论后统一 inline pill / Sidebar 三态 subline（运行 `正在工作 · 第 N 步` + 完成 `已完成 · summary`）/ AgentTurn.summary v3 migration / LLM list 持久化到 prefs cold-start / LLM picker footer hint「修改 mykey.py 后重启 Workbench 生效」/ Copy/Save 中间冒出三层 null 防御 |
| 2026-05-13 | [Sidebar IA 重塑 · FTS5 全文搜索 · Inspector 退役 · Projects V0.1 · GA baseline cf65515](./2026-05-13-sidebar-overhaul-and-projects.md) | 一 session 跨 8 个主题：Sidebar Earlier 桶折叠 + EarlierDialog（月分组 + 多选 bulk archive）+ SQLite FTS5 全文搜索（migration 004，trigram tokenizer，CommandPalette 内 "在对话内容中" 分区）/ Inspector 整面退役（第一性原理：每 tab 都重复其它地方信息，回收 14-30% 横向空间）/ AppShell overflow-hidden 修复（Composer 被推上去 bug）/ MessageActions icon-only + Radix Tooltip（100ms 即时反馈）/ Multi-select bulk in EarlierDialog & ArchivedDialog（Gmail-style Select toggle）/ GA Baseline 6a3eecc → cf65515 升级（92 commits，逐项审计零 breaking change）/ **Projects V0.1 完整实现**（5 个 phase：数据层 + 创建 dialog + sidebar 渲染 + 分配/filter + CWD 绑定 + edit/delete + 审批入口恢复 + ProjectsDialog + 右键 Delete 红色 destructive + filter banner 显示 rootPath）；多个 IA 大决策：拒绝双侧边栏 / Settings 不装 session 级 cwd / Recent decisions 在 Settings 里抽象层错位整段删除 |
| 2026-05-13 | [Scroll-on-completion 方案 E 暂存](./2026-05-13-scroll-on-completion-deferred.md) | 长任务出最终答案后自动 scroll 到底部 → 用户要手动往上找答案开头。讨论 A-E 共 5 个方案：默认 read mode 被否（长任务期间分辨不出 GA 完成没）→ 落到方案 E（默认 read + `run_complete` smooth scroll 到 `[data-role="final-answer"]` wrapper）。暂不实施，等 beta/公测验证痛点频度。entry 含完整 implementation outline 5 步，revisit 时直接照做。 |
| 2026-05-13 | [Project 绑定文件夹 hint 文案 + cwd live-sync 暂存](./2026-05-13-project-cwd-copy-and-live-sync-deferred.md) | Create/Edit dialog 项目文件夹 hint 漏满架构术语（cwd / GA 子进程 / rootPath / bridge）→ 重写成基于「工作区」概念的中文白话。Create: 「项目里的对话以此文件夹为工作区」；Edit: 「修改后已有对话需重启 Workbench 后生效」。关键 reframing：hint 应解释**反直觉**的部分，不浪费字解释 default behavior。讨论过加「重启此对话」右键菜单 / 自动 respawn / toast 提示，全否（要么术语泄漏要么毁用户工作）。Future path: IPC `set_cwd` + bridge `os.chdir` 实现 live-sync 而非重启 app；约 200-300 行工程，等 beta/公测有真实痛点再启动。 |
| 2026-05-13 | [GA Baseline 升级 cf65515 → 6bb3104](./2026-05-13-ga-baseline-upgrade-cf65515-to-6bb3104.md) | 写完 [Baseline Upgrade Workflow](../../CLAUDE.md) 当天就实跑首次：upstream 5 个 commits（4 个 tui/docs + 1 个 `feat: dynamic tool_result maxlen`），最后那个 commit 3205f4a 把 `BaseHandler.dispatch` 签名加了 `tool_num=1` 参数 = **breaking change**。桥接层 `WorkbenchHandler.dispatch` 加 `tool_num` 透传 super 适配。80/80 tests pass，mypy strict + ruff clean。流程本身没漏没冗余，四个接口表面 checklist 在这次正好命中 dispatch 变化。也暴露一个 TODO：现有 dispatch 测试只用默认参数调，没测显式传 `tool_num` 的 case，应补一条 fail-fast 保护。 |
| 2026-05-13 | [Baseline regression · 改用 feature detection 适配](./2026-05-13-baseline-regression-and-feature-detection.md) | 上一条 baseline 升级 ship 当天就翻车：硬绑新 GA 签名的 `WorkbenchHandler.dispatch` 在用户的旧 GA（d2840ae，breaking change 之前）上炸 `TypeError`，整个 agent loop 死掉，desktop 卡「思考中」永远清不掉。改用 `inspect.signature` 做 feature detection（运行时探测 BaseHandler.dispatch 是否支持 tool_num），新旧 GA 双向兼容。**关键 methodology 沉淀进 CLAUDE.md Baseline Upgrade Workflow**：(a) 接口适配优先用 inspect-based feature detection 而不是硬绑签名；(b) 跑测试矩阵必须新旧 GA 两端都过，单跑一端不算数。 |
| 2026-05-13 | [LLM warmup bridge · 启动时自动刷新模型列表](./2026-05-13-llm-warmup-bridge.md) | Bug：改 mykey.py 加新模型后重启 Workbench，New Chat 看不到新模型；进任意已有 session 才会触发。根因：bridge lazy spawn，冷启动没任何 bridge 跑 → `state.llms` 永远是 prefs 旧缓存。讨论 A-D 共 4 个方案，落到 A（启动后台跑一次性 warmup bridge 拿 list_llms()，shutdown）。`hydrateFromDB` 末尾 + `setGAConfig` 内重置 flag 后双触发；用 `_warmupComplete` 字段 dedupe；race-condition 用 `pendingShutdown` flag 处理；15s timeout 兜底。复用现有 bridge spawn 基础设施不引入新 Python 入口。 |
| 2026-05-13 | [V0.2 增量 · /btw 侧问 · /branch 分支 · /rewind 悔棋](./2026-05-13-v0.2-side-question-branch-rewind.md) | GA upstream tuiapp_v2.py 启发的三个新交互原语，提案进 V0.2。`/btw`：用 worker thread + `backend.raw_ask` 跑独立 sub-agent 不动主 history，新增 IPC `side_question` / `side_question_response`，UI 黄色侧边条气泡 + 不计入 Turn 编号 + replayHistoryToBridge 跳过持久化。`/branch`：零新 IPC，复用 spawn + load_history（接受现有 lossy adapter），sidebar 右键 + 新 session 顶部"分支自 #X" system message。`/rewind <n>`：新增 IPC `rewind` / `rewound`，bridge 端 `history[:] = history[:cut]` truncate，desktop 非破坏性 marker（migration 005 加 `rewound` column）。Rejected：monkey-patch / desktop-only fake rewind / destructive SQL delete / in-process branch / ChoiceList for LLM（我们 LLMPill 更好）。Open：`/btw` 多轮？ChoiceList 是否给 `ask_user` 用（V0.1 漏渲染）？Edit Message 与 /rewind 共享语义？load_history adapter 富化是否前置？ |
| 2026-05-13 | [Galley 重命名 + 多项 V0.1 功能马拉松](./2026-05-13-galley-rename-and-features-marathon.md) | 超长 session 一次性把多件事推完：(1) ask_user UI 实施（AskUserBubble 黄色气泡 + 候选 chips + Sidebar 第四态 "⏸ 等你回复" + 抑制 ask_user tool callout）；(2) Composer 大段粘贴折叠（>10 行触发 `[Pasted text #N +M lines]` 占位符）；(3) 折叠完成 turn / Sidebar 折叠 / TopBar Search 全部 park 或删除（cargo cult 警觉）；(4) Conversation 宽度 toggle（紧凑 760 / 宽松 1200，全局 prefs，TopBar pill 跟 YOLO 同视觉族）；(5) Sidebar header 重塑：GALLEY semibold uppercase + 右对齐 `● GA 就绪` 真信号化（之前 `Runtime · healthy` 是装饰品，重写为 ready/unconfigured 二态，未配置可点跳 Settings → Runtime）；(6) **品牌重命名 GA Workbench → Galley**：14 个文件，origin story "Galley started as a workbench for GenericAgent. The first two letters of our name are a quiet bow to where we came from."；(7) Tauri identifier 改动副作用事故 + 教训写进 CLAUDE.md（公开 release 前要 Rust 自动迁移）；(8) **CLAUDE.md 项目宪法重写**："不读写" → "不修改 + 读取分级"——只读 GA 内部文件允许（标 coupling 点 + baseline 升级审计）；(9) Reinject Tools 实施（IPC + bridge handler + ⋯ 菜单）；(10) Desktop Pet 实施（subprocess spawn + sticky-B + turn_end hook + ⋯ 菜单）；(11) TopBar `⋯` overflow menu 从右 cluster 移到 title 旁边，session-scoped（无 active session 时隐藏）；(12) 手动 session rename（右键 ✏️ + inline edit input + Enter/Esc/blur）；(13) 空闲自主行动 + AI rename C 都设计了但 defer 到 V0.2。 |
| 2026-05-13 | [V0.2 增量 · AI Session Rename (user-triggered)](./2026-05-13-v0.2-ai-session-rename.md) | 手动 rename 之外的 LLM 增援。Option B（auto-trigger）否决 → Option C（user-triggered）保留。设计：⋯ 菜单加 ✨ AI 重命名，调当前 session active LLM 通过 `backend.raw_ask`（复用 /btw 同款 deepcopy + 不写 history 模式）出 8-12 字中文标题。Prompt 显式禁止 meta 措辞 + 强调名词短语。IPC: `rename_via_llm` / `session_renamed`。~110 LOC（比手动 rename 还少，复用基础设施）。Open：prompt 是否预先 dogfood？要不要 5 秒撤销 toast？上下文取多少轮？ |
| 2026-05-13 | [V0.2 增量 · 空闲自主行动 (Idle Autonomy)](./2026-05-13-v0.2-idle-autonomy.md) | GA 官方 "30 分钟无活动自动注入 [AUTO]🤖 prompt" 在 Galley 的适配设计。决策：全局 toggle（不是 per-session）位置在 Sidebar Quick Actions / 自动跟随 active session / **必须 YOLO mode 才允许**（safety gate）/ 单次硬限 30 step / 阈值 15min-4hr 可调 / macOS 系统通知 + Sidebar 🤖 indicator + 自主消息视觉变体。新 IPC: `enable_idle_autonomy` / `disable_idle_autonomy` / `idle_autonomy_fired`。~250 LOC。哲学定位：审批是出口不是围栏的延伸——给"信任 agent 自主跑"的用户一条透明 explicit 可控路径。Open：bridge 端 idle monitor 多 bridge 还是单 global？wall clock vs monotonic 时钟？初次激活要不要 confirm modal？ |
| 2026-05-13 | [UI 文案 i18n + brand 一致性 sweep + TopBar 标题菜单重构 + repo 重命名](./2026-05-13-ui-copy-i18n-and-brand-sweep.md) | 从「标题旁的 ⋯ 看起来像省略号」一个 UX 小坑出发，连出 10 个连贯决策：(1) TopBar 标题块变 dropdown trigger（caret-down）消歧 + 收编 session rename 入口；(2) i18n Plan B 框架（section header / brand 锚点保留英文、body / 菜单 / hint 全中文、代码 identifier 不动）；(3) session → 对话 / project body → 项目；(4) ApprovalForm 4 按钮 + 4 pill 全中文 + 「白名单」框架对齐（按钮 verb 和 pill verb 同源消除认知卡顿）；(5)「已通知 AI」否决「Galley / agent」（Galley 是 UI 壳不是收件方）；(6) Workbench → Galley brand 11 处 user-facing 漏网全收；(7) GA vs GenericAgent 分场景规则（长文展开 / 紧凑缩写）；(8) **GitHub repo 重命名 genericagent-workbench → galley** 连带 README + CLAUDE.md + SettingsAbout 3 URL + local remote。Rejected：换图标治标 / Pin 保留英文（「短 / 都懂」滑坡）/ 句子里保留 Project（混合语言最伤）/ repo 名 galley-workbench 二元品牌。Open：ApprovalForm icon 跟新 copy 框架对应不上 / SettingsAbout 还有 Links / Also by SubLabel 英文 / Re-run health check + Back 按钮还是英文。 |

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
