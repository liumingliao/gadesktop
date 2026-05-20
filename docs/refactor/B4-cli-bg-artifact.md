# B4 · CLI feature-complete + background mode + adapter artifact

```
Cursor:   T0 prerequisites  (M1 sub-plan ship 2026-05-20；M1 实施推 fresh session)
Status:   📋 Playbook ready · M1 sub-plan ship · 等 tray spike 跑 + B3 dogfood 稳定期
Started:  2026-05-20 (paperwork)
Last touch: 2026-05-20 — M1 sub-plan ship ([B4-M1-sub-plan.md](./B4-M1-sub-plan.md) 661 行；11 个 subcommand 拆 + 4-commit shape + 12 risk + 8 reject + 6 open decision)
Predecessor: B3 ✅ tag b3-complete
Successor:   v0.5 milestone ship
Duration:    PRD estimate 2-3 周（D51-D65），按 B1/B2/B3 节奏可能压缩到 1-2 周
```

**Cursor 协议**：完成 sub-task → cursor 移到"下一个未完成的最小编号 T"。Session 结束 → cursor 必须指向"明确可以接续的位置"，不要指 in-progress。

> **2026-05-20 升格 note**：本 playbook 从 stub（144 行）升格到详细版本，采用 B3 sub-plan-then-impl 模式。M1-M9 每个 milestone 在实施前**单独写 sub-plan**（mirror M3-M6 pattern），sub-plan 内做 scope re-assessment / commit shape decision / 详细 sub-task 序列 / risk register / verification gates。这是 B1/B2/B3 累积下来 21× 加速估算的核心 pattern——B4 估的 2-3 周大概率是 1-2 周。

## 这个 phase 在干啥（一段话）

3 件并进，把 Galley 从「dual-native 内部架构 ready」推到「dual-native 对外发布」：

1. **CLI feature-complete**：B1+B2 已实现 6 read 命令 + send/watch；B4 补齐 PRD §11.1 所有 write 命令（session new / btw / stop / archive / restore + project + llm）。每个新命令在 Rust `GalleyApi` trait 加 method + Tauri command + CLI subcommand，**单条命令 sub-plan 即可**——M1 比 B3 milestones 更细颗粒。
2. **Background mode (menubar daemon)**：关窗 → 隐藏不退出（**Cmd+Q 才退**）。menubar 图标 + active session badge，下拉菜单 Show/Quit。CLI 才能用——Galley Core 必须 alive 才接 socket 写命令。
3. **Adapter artifacts**：Galley Supervisor SOP for GenericAgent + galley-supervisor skill for Claude + `docs/agent-api.md` v1 publish + discovery file。这些一起 ship 让外部 supervisor（GA bot / Claude / 用户自写 agent）从 day 1 就能用。

B4 ship = v0.5 RC，dogfood 一周后 ship 正式 v0.5（dual-native orchestrator 公开发布）。

## Prerequisites · 必须先完成

- [x] B3 全部 acceptance criteria 跑过 + devlog ship + tag `b3-complete`（2026-05-20）
- [ ] B3 dogfood 1 周稳定期 — 严格 vs event-driven 由 JC 体感决定（B4 是 phase 切换不是 milestone 切换，应该比 milestone 切换更慎；但具体长度 event-driven per [N17](./B3-store-slice.md#running-notes--gotchas)）
- [ ] **Tauri tray plugin v2 spike**（1 day）— B4-R1 大风险，启动前先验证：(a) menubar 图标在 macOS + Windows 都能渲染 (b) hide window + WebView 在 background 仍能跑 JS (c) macOS App Nap 不卡死 IPC 响应。Spike spec [core/experiments/tray-mode/README.md](../../core/experiments/tray-mode/README.md) ship 2026-05-20（20 个 T 项 checklist · 6 验证段 · macOS T17-T19 单独 App Nap 测量段 · GO/NO-GO 决策 + 3 fallback strategy）；scaffold + 实跑留下次 dedicated session 跑（mirror bridge-owner prototype pattern）
- [ ] v0.1 / v0.2 dogfood 数据 migration 路径设计 + 本地测试（参考 [PRD §16](../PRD.md#16-数据迁移v01--v10)）—— 本人 dogfood 数据 6+ 月积累不能丢
- [ ] CLAUDE.md 阶段表 9. B4 row 加入 + B4 启动 commit 时一并更（current state 表的 row 9 是 B4 stub）

**未达 prerequisites 不允许启动 B4 M1**。最后两条 B4 内自行解决；tray spike 严格 gate。

## Phase invariants · B4 特有的硬规则

跨 phase 规则在 [invariants.md](./invariants.md)。B4 特有的：

- **B4-I1**: CLI 命令 surface **frozen at v0.5 ship**。M6 publish 时 schema_version=1 锁定，任何后续 break = bump v2。CLAUDE.md 「CLI surface 是公开契约面」+ PRD §11 「schema 漂移 0」是硬约束——B4 内 sub-plan 阶段 review CLI 命令字段名、enum 值、exit code 分配，发现需要 break 必须**在 v0.5 ship 之前**改完。
- **B4-I2**: **localhost only**（[CLAUDE.md 架构原则 #1](../../CLAUDE.md)）。B4 引入的 socket / discovery file / supervisor SOP 任何一条建议「开 TCP / 加 token / 走远程」都被本条款拒绝。Supervisor 远程接入走 GA IM frontend 或 SSH tunnel，不是 Galley 的事。
- **B4-I3**: **数据不离开 Galley**（[CLAUDE.md 架构原则 #3](../../CLAUDE.md)）。Galley 不存 supervisor ↔ human 的对话内容。Supervisor 通过 CLI 发的 commands + `--reason` 标注存进 Galley（per-session 行动日志），但 supervisor 跟 user 在 IM 里聊的对话**不**存。M7 supervisor 行动日志 GUI 只渲染 Galley-known origin 字段，不接 supervisor 对话回灌。
- **B4-I4**: **B3 不可逆**（[CLAUDE.md 架构原则 #4](../../CLAUDE.md)）— 前端 stateless presenter，所有写权威在 Rust。B4 引入的所有新 CLI 命令必须**对称走 trait method → socket → 同一 Rust 实现**。GUI 也走同样路径，**不**为 GUI 单独 invoke 一条快捷路径。
- **B4-I5**: **SOP 安装路径固定**（[CLAUDE.md SOP 安装例外条款](../../CLAUDE.md)）。Settings → Integration 的 "Install Supervisor SOP" 按钮只能写 `~/Documents/GenericAgent/memory/galley-supervisor-sop.md`，**不**接受用户配置路径，**不**接受配置文件名。检测同名时弹「保留 / 覆盖 / 取消」，不静默覆盖。
- **B4-I6**: **Migration 备份强制**。Schema migration 010-014 在 Galley 内 hard-coded 备份步骤：先 copy `~/Library/Application Support/app.galley/` → `~/Library/Application Support/app.galley.backup.<timestamp>/`，再跑 migration。失败 → 拒启动 + 弹 Finder 到备份目录。dogfood 数据 6+ 月不能丢。
- **B4-I7**: **未签名发布策略不变**（[CLAUDE.md 发版签名策略](../../CLAUDE.md)）。v0.5 仍是未签名 .dmg / .exe。release notes 必须明文说明 macOS 右键→打开 / Windows SmartScreen 绕过步骤——release notes 写法继承 [feedback_release_notes_style](../../) 风格简洁优先。

## Acceptance criteria · B4 算完成（v0.5 RC）

按顺序逐条 demo + tick（沿用 stub acceptance，已 codified）：

- [ ] **A1**: CLI 命令表（PRD §11.1）全部实现：
  - Inventory: list / search / brief / show / status / health / version ← 已 B1
  - Operate: new / send / btw / stop / archive / restore / watch ← send/watch 已 B2，其余 B4 M1
  - Project: create / list / move / archive
  - Config: llm list / llm set
- [ ] **A2**: 每个 CLI 命令在 `docs/agent-api.md` 都有完整 schema 文档
- [ ] **A3**: Background mode 工作：关窗 → 隐藏，Cmd+Q → 真退。Galley Core 持续跑 (menubar 图标存在)
- [ ] **A4**: Menubar 图标：静态 / N active session badge / 点击下拉菜单可 Show Galley / Quit
- [ ] **A5**: Galley Core 完全退出后 CLI 报 exit 4 "Open Galley first"（沿用 B2 exit 分类）
- [ ] **A6**: `~/.config/galley/cli-path`（mac/linux）/ `%APPDATA%\galley\cli-path` (windows) discovery file 在 GUI 首次启动后存在，内容是 CLI binary 绝对路径
- [ ] **A7**: Settings → Integration 有 "Install `galley` to PATH" 按钮，点击触发 sudo + symlink（macOS）或写用户 PATH（Windows），可逆
- [ ] **A8**: Settings → Integration 有 "Install Supervisor SOP into your GA" 按钮（[B4-I5](#phase-invariants--b4-特有的硬规则)），把 `galley-supervisor-sop.md` 写入用户配置的 GA `memory/`
- [ ] **A9**: `docs/integrations/galley-supervisor-sop.md`（GA SOP）写完 + dogfood 验证（让 GA + 飞书 frontend 通过 SOP 控制 Galley 跑通一个完整 supervisor scenario）
- [ ] **A10**: `.claude/skills/galley-supervisor/` Claude Skill 包写完 + 在 Claude Code 里加载试用通过
- [ ] **A11**: v0.x → v0.5 数据 migration (010-014 加 supervisor / origin_note / created_via 字段) 在自己机器上跑过 + 数据完整 + [B4-I6](#phase-invariants--b4-特有的硬规则) 备份步骤生效
- [ ] **A12**: TopBar / GUI per-session 显示 supervisor 行动日志（PRD §6.1 #4）：穿插 human / supervisor 动作 + reason
- [ ] **A13**: 所有 Galley 架构原则（[CLAUDE.md](../../CLAUDE.md)）在 code review 中能逐条 demo：localhost only / CLI 公开契约 / 数据不离开 Galley / 路径 B 不可逆
- [ ] **A14**: dogfood 一周（B4 完成后），零 P0 / P1 bug，准备 v0.5 ship

---

## M1 · CLI 写命令补齐 (D51-D54)

补齐 PRD §11.1 全部 write 命令。每条命令 = 1 trait method + 1 Tauri command（如 GUI 已有 invoke 路径则复用）+ 1 CLI subcommand + 1 socket route。**M1 内 sub-task 颗粒度比 B3 milestone 细**——单条命令是最小 ship 单位，允许多 commit。

> **实施前必读**：[B4 M1 sub-plan](./B4-M1-sub-plan.md) (ship 2026-05-20, 661 行)。Sub-plan 内决定：(a) 11 个 subcommand 拆 (playbook "7 commands" 实际按 subcommand 算 11 个) (b) **4-commit shape** by noun-group + prereq commit (c) **session stop = Abort 不 Shutdown** (d) **btw 不持久化** v0.1 保持 (e) **exit code 5=runner_error** 引入 (f) **llm list 走 SQLite cache** 不走 socket (g) **project move = assign_session_to_project** 语义 (h) **project archive = delete_project** v0.5 简化。12 risk + 8 reject + 6 open decisions JC review 后进 T1.1。

### Sub-tasks

- [x] **T1.0** M1 sub-plan ship (paperwork-only commit) — [B4-M1-sub-plan.md](./B4-M1-sub-plan.md) ship 2026-05-20
- [ ] **T1.1** `galley session new "<task>" [--project=X] [--llm=...] [--supervisor=...] [--reason=...]`
  - Rust: `GalleyApi::create_session_with_first_message` — 复用 M4 `create_session` + B2 `send_message`，组合成 atomic 操作（防 race condition：CLI 创建 session 时 GUI 不该看到「空 session 突然来一条消息」）
  - CLI: `session new` subcommand
  - socket route: `session.new`
  - Test: 2 happy path（with/without project）+ 2 error（empty task / invalid project id）
- [ ] **T1.2** `galley session btw <id> "<q>" [--supervisor=...]`
  - Rust: 已有 send_message + side question 路径（B3 messagesStore appendSideQuestionUserTurn），加 `via='cli'` + `kind='btw'` 区分
  - CLI: `session btw` subcommand
  - Test: 验证主 agent loop 不中断（PRD §6.1 #5）
- [ ] **T1.3** `galley session stop <id>`
  - Rust: `GalleyApi::stop_session` — runner_manager.shutdown_bridge + emit run_complete event
  - CLI + socket route
  - Test: stop running session → bridge SIGKILL 路径 + GUI 状态正确
- [ ] **T1.4** `galley session archive <id>` / `restore <id>`
  - Rust: 复用 M4 `archive_session` / `unarchive_session` trait method（B3 已有）
  - CLI: `session archive` / `session restore` 是 thin wrapper
  - Test: 验证 GUI sidebar 即时更新
- [ ] **T1.5** `galley project create / list / move / archive`
  - Rust: 复用 M4 `create_project` / `list_projects` / `assign_session_to_project` / `delete_project`（B3 已有）
  - CLI: 4 subcommand 是 thin wrapper
  - **archive vs delete 语义**：v0.5 project 没 archived state，CLI 的 `archive` map 到 `delete_project`（sub-plan 内 review 是否补 archived 字段，倾向不补 v0.6+ 再加）
- [ ] **T1.6** `galley llm list` / `galley llm set <session> <llm>`
  - Rust: list 复用 ready event 的 `availableLLMs`（需要 runner alive）；set 复用 B2 `sendIPCCommand({kind: "set_llm", ...})`
  - CLI: 2 subcommand
  - Test: `llm list` 在 bridge 未 alive 时报 `exit 4`（启动 bridge 拿 ready 才有 list）
- [ ] **T1.7** `agent-api.md` 增量写入 — 每个命令 ship 时同 commit 加 schema 段
- [ ] **T1.8** CLI integration tests — 6 个新命令各 1-2 个 happy + error path

### M1 完成标志

- A1 / A2 / A5 全 tick
- Cargo test 全过；新增 ~20-30 integration test
- `docs/agent-api.md` 含全部 14 commands schema

---

## M2 · Tray spike → Background mode (menubar daemon) (D55-D57)

**最高风险 milestone**（[B4-R1 Tauri tray 兼容性](#已知风险) + B4-R2 App Nap）。Spike 在 prereq 阶段单独跑，spike 验证通过后 M2 实施。

> **实施前必读**：B4 M2 sub-plan + tray spike 报告（spike 阶段单独 commit）。Sub-plan 内决定：(a) tray icon resource 路径 + Tauri v2 tray plugin 版本 (b) `app.preventDefault()` 关窗事件处理 (c) Cmd+Q vs 红色按钮 vs Window 菜单 → Quit 差异化 (d) App Nap 解除策略（`NSProcessInfo.beginActivity` 还是 `caffeinate` 子进程）。

### Sub-tasks

- [ ] **T2.0** Tray spike (prereq, 1 day) — [spike spec](../../core/experiments/tray-mode/README.md) (2026-05-20 ship)；scaffold + 实跑 → ship 通过 → spike report devlog
- [ ] **T2.1** M2 sub-plan ship
- [ ] **T2.2** Tauri tray plugin v2 setup — `cargo add tauri-plugin-window-state` / `tauri-plugin-positioner` (per spike findings)；`tauri.conf.json` tray icon resource
- [ ] **T2.3** 关窗事件改 hide：在 Rust `setup` hook 注册 window event listener，`WindowEvent::CloseRequested` → `window.hide()` + `api.prevent_close()`；**Cmd+Q 例外**：menubar Quit menu item 走 `app.exit(0)` 真退
- [ ] **T2.4** macOS App Nap 解除 — `NSProcessInfo.beginActivity` 或 Rust crate；spike 验证 hidden window WebView 可以继续 emit Tauri event（CLI 写命令在 background 仍能 emit `runner-event` 让用户重开窗口时看到完整历史）
- [ ] **T2.5** Menubar 图标 — 静态 icon（per [O1 stub decision](#open-decisions) 倾向）+ 数字 badge active session count（runtimeStore 订阅 `byId` 中 status='running' 的计数）
- [ ] **T2.6** Menubar 下拉菜单 —
  - "Open Galley"（重 show window + focus）
  - 状态行 "N active · M idle"（disabled MenuItem, 仅显示）
  - Separator
  - "Quit Galley"（→ `app.exit(0)`）
- [ ] **T2.7** 首次关窗弹一次 toast/dialog「Galley 还在 menubar 跑」+ "Don't show again" pref
- [ ] **T2.8** Windows tray equivalent — Tauri v2 tray API cross-platform，理论 same code；spike 阶段必须验证 Windows tray icon 渲染 + Cmd+Q 等价物（Alt+F4 不能真退，必须走 tray Quit）
- [ ] **T2.9** Dogfood — JC 用一天，重点验证 (a) menubar 跑 8h+ 不卡 (b) CLI 在 GUI hide 时仍可写入 (c) Cmd+Q 真退 + 桌面 dock icon 消失

### M2 完成标志

- A3 / A4 / A5 全 tick
- Tray 在 macOS + Windows 都过 smoke（dual-platform 测过，Windows 不一定要 JC 自跑 — 可以拿 CI 头一过即可）

---

## M3 · Discovery file + Settings integration (D58)

Settings → Integration tab 是 supervisor 配置入口的 GUI 半边；discovery file 是给 supervisor 读 CLI 路径的契约面。

### Sub-tasks

- [ ] **T3.0** M3 sub-plan ship
- [ ] **T3.1** Discovery file 写入 — App.tsx mount effect / Rust setup hook 写入 `~/.config/galley/cli-path`（macOS/Linux）+ `%APPDATA%\galley\cli-path`（Windows）。内容 = CLI binary 绝对路径（`/Applications/Galley.app/Contents/MacOS/galley`）+ 第二行 schema version。**幂等**：同内容不重写（避免 mtime 抖动）。
- [ ] **T3.2** Settings → Integration tab 新建 — `gui/src/components/screens/settings/SettingsIntegration.tsx`；按 [SettingsApproval / SettingsRuntime 模式](../../gui/src/components/screens/settings/) 创建
- [ ] **T3.3** "Install `galley` to PATH" 按钮 + 状态 indicator —
  - macOS: 弹 `osascript` sudo prompt 创建 `/usr/local/bin/galley` symlink → CLI binary 绝对路径
  - Windows: 写 `HKCU\Environment\PATH`（用户级，不需 admin）
  - 状态 indicator 检查 `which galley` 是否能找到 symlink
  - **uninstall path**: 二次点击按钮提示「移除？」→ `rm /usr/local/bin/galley` / 删 PATH entry
- [ ] **T3.4** "Install Supervisor SOP into your GA" 按钮 — 实现 [B4-I5](#phase-invariants--b4-特有的硬规则)：
  - 读 `prefsStore.gaConfig.gaPath` 拿 GA 路径
  - 检测 `{gaPath}/memory/galley-supervisor-sop.md` 是否存在
  - 存在 → 弹 confirm dialog「保留 / 覆盖 / 取消」
  - 不存在 → 直接写 `docs/integrations/galley-supervisor-sop.md` 内容（embed 进 Rust binary via `include_str!`）
  - 写入成功 → toast「SOP 已安装」+ 后续 install 按钮变 "Update SOP"
- [ ] **T3.5** "Open agent-api.md docs" 按钮 — 跳转 GitHub URL 或 bundle 进 .app

### M3 完成标志

- A6 / A7 / A8 全 tick
- Settings → Integration tab 在 dev mode 跑通 3 个按钮

---

## M4 · Galley Supervisor SOP for GenericAgent (D59-D60)

文档 + dogfood 验证 + iteration。这是 v0.5 dual-native framing 对外的「示例 supervisor」第一案。

### Sub-tasks

- [ ] **T4.0** M4 sub-plan ship
- [ ] **T4.1** 写 `docs/integrations/galley-supervisor-sop.md` —
  - Section 1: Discovery — 怎么读 `~/.config/galley/cli-path`
  - Section 2: 命令速查 — PRD §11.1 全表
  - Section 3: 常用 scenario — 创建 session / 加任务 / 查状态 / archive / 切 LLM
  - Section 4: Destructive 命令 confirm 守则 — `archive` 之类操作前先 brief
  - Section 5: Origin 字段约定 — `--supervisor=` 怎么填 + `--reason=` 何时必填
  - Section 6: Error handling — exit code 含义 + retry/fallback 策略
- [ ] **T4.2** SOP 安装到自己 GA `memory/` (通过 M3 Settings 按钮)
- [ ] **T4.3** Dogfood 1-2 周 — JC 在自己微信 / 飞书 frontend 上跑真 supervisor scenario：「让 GA 帮我开个 session 跑 X 任务」→ GA 读 SOP → 调 CLI → Galley 接收 → GA 反馈结果
- [ ] **T4.4** iterate SOP — dogfood 发现的 SOP 不清晰处 / agent 误用 path 修复 + 单独 commit
- [ ] **T4.5** Open question 解决：
  - SOP 在哪里 publish？仓库 `docs/integrations/` + 外链到 fudankw.cn/sophub（如果 sophub 接受，[stub Open #5](#open-decisions)）
  - SOP 是否要 multi-language？v0.5 中文一版即可，i18n 推 v0.6+

### M4 完成标志

- A9 tick — full supervisor scenario 跑通
- SOP 在 `docs/integrations/galley-supervisor-sop.md` 落地 + dogfood 1 周稳定

---

## M5 · Claude `galley-supervisor` Skill (D61)

Claude Code skill package — 让 Claude 用户 install 完直接能调 Galley CLI。

### Sub-tasks

- [ ] **T5.0** M5 sub-plan ship
- [ ] **T5.1** 写 `.claude/skills/galley-supervisor/SKILL.md` — frontmatter（name / description / trigger 关键词）+ body（如何读 discovery file + 调 CLI + parse JSON）
- [ ] **T5.2** Auxiliary files — `references/` 放 SOP 副本 + `scripts/` 放 quick-call helper（如 `galley-status.sh`）
- [ ] **T5.3** 在 Claude Code 上 install 这个 skill — 验证触发关键词正确 + skill 调用 CLI 路径正确
- [ ] **T5.4** 写一个示例 scenario — "用 Claude 创建 Galley session 跑某 task" + 截图录屏（v0.5 release notes 用）

### M5 完成标志

- A10 tick — skill 在 Claude Code 装上 + 跑通示例

---

## M6 · agent-api.md v1 定稿 (D62)

Schema_version=1 frozen point。M6 ship 后 schema 修改要求 bump v2。

### Sub-tasks

- [ ] **T6.0** M6 sub-plan ship
- [ ] **T6.1** 检查全部 14 命令的 schema 完整性 — M1-M5 过程中 schema 是增量写入，本 step 整体 review
- [ ] **T6.2** Exit code 表确认 — 0/1/2/3/4/5 五类是否覆盖所有失败模式（[B4-I1](#phase-invariants--b4-特有的硬规则)）
- [ ] **T6.3** Stability promise 段写作 — v1 schema_version 内 additive-only + breaking change bump rule + 几个 stable identifier 列表（error code enum / origin via enum / status enum）
- [ ] **T6.4** Schema 修改 vote — JC review 后决定本 schema 是否 freeze；如发现 hairline issue 必须 bump v2，**改完才能 ship v0.5**
- [ ] **T6.5** Publish — 加入 `?schema=1` query parameter pattern（per CLAUDE.md 「公开契约面」），供 supervisor 显式指定 schema 版本

### M6 完成标志

- A2 tick — 全部 14 commands schema 完整文档
- agent-api.md 顶部 banner 标 "Frozen at v1.0 schema_version=1"

---

## M7 · Per-session supervisor 行动日志 GUI (D63)

PRD §6.1 #4 GUI 渲染层 — 让 human user 在 Galley 看到 supervisor 在干啥。

### Sub-tasks

- [ ] **T7.0** M7 sub-plan ship
- [ ] **T7.1** Session timeline 在 messages 之间穿插 supervisor 动作 entry — 复用 messages.ts SystemTurn / 新加 SupervisorTurn type
- [ ] **T7.2** Conversation 渲染层加 SupervisorActionBubble — icon 显示 supervisor identity + reason hover tooltip + 时间戳
- [ ] **T7.3** TopBar 加 "supervisor activity" indicator — 当前 session 是否有 supervisor 正在写命令（active vs idle 差异化）
- [ ] **T7.4** [B4-I3 enforce](#phase-invariants--b4-特有的硬规则) — supervisor 跟 user 的 chat 不渲染（不存）；只渲染 Galley-known origin 三元组 `(via, supervisor, origin_note)`
- [ ] **T7.5** [O4 解决](#open-decisions) — 行动日志渲染密度：每个动作一行；hover 显 reason；相邻 ≤ 5s 同 supervisor 动作折叠成单 entry（避免 spam）

### M7 完成标志

- A12 tick — supervisor 行动日志在 conversation 渲染 + TopBar indicator

---

## M8 · v0.x → v0.5 data migration 真跑 (D64)

最 P0 风险（数据丢失不可恢复）。[B4-I6](#phase-invariants--b4-特有的硬规则) 备份步骤强制。

### Sub-tasks

- [ ] **T8.0** M8 sub-plan ship — 含 migration 010-014 schema diff + 备份策略 + rollback path
- [ ] **T8.1** Schema migration 010 — `messages.created_via` TEXT default 'gui'
- [ ] **T8.2** Migration 011 — `messages.supervisor` TEXT null
- [ ] **T8.3** Migration 012 — `messages.origin_note` TEXT null
- [ ] **T8.4** Migration 013-014 — sessions 表对应 origin 字段（如适用）
- [ ] **T8.5** Rust migration runner 加备份 step — open SQLite 之前 `fs::copy` 整目录 → `app.galley.backup.<timestamp>/`
- [ ] **T8.6** 备份失败 → 拒启动 + Tauri dialog 弹 Finder 到旧数据目录 + clear instruction
- [ ] **T8.7** Dogfood migration — JC 在自己机器上从 v0.1.1-alpha.X dogfood 数据真跑：copy 数据到测试目录 → 装 v0.5 build → 验证全部 session/message 完整 + 新字段 default 正确
- [ ] **T8.8** 验证 rollback — 如果 v0.5 出大 P0 用户能用什么方式回退？（备份目录手动 `mv` 是 escape hatch，但 schema mismatch 让 v0.1.1 重装也用不了——倾向**不**提供 official rollback path，备份目录够了）

### M8 完成标志

- A11 tick — migration 跑过 + 数据完整 + 备份步骤 verified

---

## M9 · B4 acceptance + v0.5 ship 准备 (D65+)

v0.5 RC → v0.5 GA 的 release ceremony。

### Sub-tasks

- [ ] **T9.0** M9 sub-plan ship — release notes draft + tag plan + post-ship comm 策略
- [ ] **T9.1** 跑遍 A1-A14 acceptance — 每条勾掉
- [ ] **T9.2** Dogfood 一周 — JC 自己用 + 邀请 1-2 个外部 supervisor user 试用（GA 群里挑 active user）
- [ ] **T9.3** README 改写 — 现 v0.1.1 framing「本地桌面工作台」改为「dual-native local agent team orchestrator」（[O5 stub decision](#open-decisions)）。DESIGN.md onboarding subtitle 同步
- [ ] **T9.4** Release notes 写作 — 沿用 [feedback_release_notes_style](../../) 简洁优先 pattern
- [ ] **T9.5** Tag v0.5 — `git tag v0.5.0` + CI 出 artifact（aarch64.dmg / x64.dmg / x64.exe-setup）
- [ ] **T9.6** GitHub Release publish — `--prerelease=false --latest` 顶到 Latest
- [ ] **T9.7** PRD / CLAUDE.md / refactor README 标 v0.5 ✅
- [ ] **T9.8** 写 B4 完成 devlog + v0.5 release devlog（分两个 entry，B4 是工程过程 / v0.5 是产品 milestone）
- [ ] **T9.9** [Open #5 stub](#open-decisions) — 投 Galley Supervisor SOP 到 fudankw.cn/sophub（如果 sophub 接受）

### M9 完成标志

- v0.5 ship 到 GitHub Latest
- README + DESIGN.md + PRD 全部 align 到 dual-native framing
- B4 + v0.5 devlog ship

---

## Running notes / gotchas

**Append-only. Don't delete. 旧的判断错了追加新条说明。**

### 写在前面的已知 gotcha（开 B4 前要注意）

- **G1 (M1 sub-plan 时)** — PRD §11.1 命令表的 `archive` / `restore` 语义跟 B3 M4 trait method (`archive_session` / `unarchive_session`) 命名差一字。CLI 用 PRD 命名（archive/restore 更直觉），Rust trait 保持 unarchive。Sub-plan 内 review CLI naming alignment。
- **G2 (M2 spike 必须做)** — Tauri v2 tray API 在 macOS 14+ 跟 Windows 11 行为不一致是已知。Spike report 必须 cover 两个 OS。若 macOS 通过 / Windows fail → 考虑 v0.5 Mac-only ship + v0.6 补 Win（mirror v0.1 Mac-only 决策模式）。
- **G3 (M3 PATH install)** — macOS 的 sudo prompt 走 `osascript with administrator privileges`，但用户拒绝 sudo 怎么办？fallback：toast「请运行：sudo ln -s /Applications/Galley.app/Contents/MacOS/galley /usr/local/bin/galley」给用户手动跑。**不**对 sudo 失败 hard error。
- **G4 (M4 SOP dogfood)** — SOP 写得再清楚 agent 也会误用。第一次 dogfood 重点观察 agent 调 destructive 命令（archive/delete）时是否 confirm。如不 confirm → SOP 加强 + Galley 端 archive 命令是否要 `--confirm-i-mean-it` flag？（倾向**不**加，CLI 走 supervisor 已经是一层隔离）
- **G5 (M5 Claude Skill trigger)** — Skill description / trigger 词如果写不对 Claude 不会主动调。参考 anthropic-skills/ 几个 well-tested skill 的 trigger 写法。dogfood 反复调整。
- **G6 (M6 schema freeze)** — 真到 freeze 时反悔成本高。**M6 sub-plan 时强制 review 全 schema** 一遍，包括字段名 / enum 值 / nullable 语义。如有疑问宁可 v0.5 ship 前 bump v2 重写 SOP，**不**ship 后再发现 schema bug。
- **G7 (M7 supervisor activity GUI)** — 行动日志显示密度 vs 信噪比 trade-off。MVP 实现 "每动作一行" 但留 hover 折叠路径，dogfood 后 iterate。
- **G8 (M8 migration 备份磁盘空间)** — dogfood 数据可能 GB 级（messages_fts + tool_events 累积）。备份 step copy 整目录可能耗时 + 占盘。**Spike 一次实测**：M8 sub-plan 写 disk-space check + 用户提示「备份需 X GB 空间，继续？」。
- **G9 (M9 dogfood 1 周)** — B3 走 event-driven dogfood gate（JC 体感 OK 就推进）。**M9 dogfood 严格走 1 周**——v0.5 是 phase 切换 + 公开发布，比 milestone 内部切换更慎。

### Session 跑下来追加的 notes（按日期）

- **N1 (2026-05-20, B4 playbook 升格)** — Stub (144 行) 升格成详细 playbook (~500 行)。沿用 B3 sub-plan-then-impl 模式：M1-M9 每个 milestone 实施前**单独写 sub-plan**。Acceptance 沿用 stub A1-A14 不动。新增 B4-I1..I7 phase invariants（沿用 CLAUDE.md 4 条架构原则 + B4 特定规则如 schema freeze / SOP 路径固定 / migration 备份强制）。Sub-task 颗粒度跟 B1/B2/B3 对齐（T1.1-TN.X 数字编号 + sub-task 完成标志逐 milestone 列）。Open: [O1-O6 沿用 stub](#open-decisions)；新加 [O7 NEW](#open-decisions-new) tray spike 何时跑（prereq 阶段 vs M2 开头）+ [O8 NEW](#open-decisions-new) M3 PATH install 失败 fallback strategy。

- **N4 (2026-05-20, M1 sub-plan ship · paperwork-only)** — Followed N3 handoff option (c). JC explicit「写 B4 M1 sub-plan」 → ship [B4-M1-sub-plan.md](./B4-M1-sub-plan.md) 661 行 mirror B3-M6 sub-plan structure. **Scope re-assessment** 钉了 8 个跟 playbook stub claim 不一致或需澄清的项：(1) 「7 commands」实际 11 subcommands (playbook 把 noun group 算 1，按 subcommand 拆 = 5 session-write + 4 project + 2 llm = 11)；(2) `create_session_with_first_message` trait method **不加**，socket handler 组合 create_session + send_message 两步 (Reject #2 trade-off：1ms race window 不换 trait + test 复杂度)；(3) `session btw` **不持久化** v0.1 决策保持 + runner 端 `/btw` 前缀已自动旁路；(4) `session stop` **映射到 Abort 不 Shutdown** (bridge 留活下次能 send，跟 GUI 顶栏停止按钮对齐)；(5) `project move` 语义歧义钉「移动 session」CLI surface `project move <sid> [--to=<pid>]`；(6) `project archive` v0.5 = `delete_project` (FK CASCADE SET NULL 保 sessions)，**不**加 archived 字段 scope creep；(7) `llm list` **走 SQLite prefs cache** 不走 socket (秒级响应 vs 5-10s warmup spawn；空 cache = empty NDJSON exit 0 acceptable degradation)；(8) **exit code 5=runner_error 引入** (PRD §11.2 已说，agent-api.md 表漏 row，M1.1 prereq commit 补) + GalleyError::RunnerError variant。**Commit shape decision**: 4-commit = M1.1 prereq (GalleyError + helpers) → M1.2 session-write (5 subcmd + listener) → M1.3 project + llm (6 subcmd + listener) → M1.4 agent-api + tests (200-400 LOC/commit，可独立 cargo check + revert)。**6 open decisions** 留 JC review: (O1) `session new` send_message fail = exit 0 partial vs exit 5？倾向前者；(O2) `project archive` CLI 阻拦 vs SOP 教？倾向 SOP；(O3) `project move` 命名 PRD literal vs subject-correct？倾向保留 PRD；(O4) M4 SOP 演示 archive confirm？倾向显式；(O5) btw origin 通过 Tauri event push 给 M7？倾向 push，M1 不实现；(O6) `session kill` Shutdown surface v0.5 加？倾向不加。**Next pickup options 不变** (per N3): tray spike + B3 dogfood + M1 实施 三轨并行 OK。M1 实施 fresh session 推；preferred 顺序是 M1.1 prereq → M1.2-M1.4 同 session 跑通 + dogfood。

- **N3 (2026-05-20, session-end handoff)** — This session pushed B3 from M5-shipped to B3 ✅ tag `b3-complete`, then B4 paperwork to "playbook ready + tray spike spec ready". Five commits in dependency order: `24f3f04` (M6 sub-plan) → `74b9539` (M6 impl: prefsStore + useAppStore retire) → `640d6f7` (B3 complete devlog + tag b3-complete) → `3efbb4d` (B4 playbook upgrade) → `7971f0f` (B4 tray-mode spike spec). **Next session pickup options**: (a) Tray spike scaffold + run (4-6h, needs JC mac for macOS T1-T2/T5-T6/T9/T11/T13-T14/T17-T19 + Windows machine access for T3-T4/T7-T8/T10/T12/T15-T16) — gate-blocking for B4 M2 start; (b) B3 dogfood continued — JC daily-drives Galley for some more days surfacing latent regressions before B4 starts moving authoritative-state code again; (c) B4 M1 sub-plan (paperwork) — can start in parallel with (a)/(b) since M1 CLI commands don't depend on tray, sub-plan writing is no-risk paperwork. **Recommended pickup**: tray spike scaffold + run as soon as Windows machine is available, since it's the strict gate. If Windows access blocked >1 day → fall back to (c) M1 sub-plan in same session, run Mac-only spike segments, document the gap.

- **N2 (2026-05-20, Tray spike spec ship — paperwork-only)** — JC explicit「在这个 session 继续推进」推到 tray spike spec 写作（不跑 spike 本身，spike 需要真 Tauri 实验 + 跨平台机器访问）。[core/experiments/tray-mode/README.md](../../core/experiments/tray-mode/README.md) 391 行 mirror bridge-owner README 结构：Status/Purpose/Gate-for/Related header + Why we need this + Non-goals + Architecture (under test) + 20-item checklist (T1-T20 across 6 capability sections: tray registration / hide-window / show / quit / WebView keep-alive / App Nap defeat / cross-platform parity) + Implementation outline (Cargo build config + pseudo-code for main.rs / app_nap.rs / index.html / tests.sh) + GO/NO-GO decision with 3 fallback strategies (Mac-only v0.5 if Win T3-T16 fail / NO-GO if T14 WebView pause / investigate if T18 App Nap) + Findings (empty) + Cleanup section + Cursor notes。**关键 design call**: T14 + T16 「WebView keep-alive while hidden」是 spike 的 critical PASS gate —— Tauri 默认是否 pause WebView 没有 documented guarantee，FAIL 触发 B4 M2 re-design（背景模式整段重新设计）。**App Nap defeat 路径选定**: `NSProcessInfo.beginActivity` 通过 `objc2-foundation` crate，比 `cocoa` crate 新 + safer + 已有 macOS-only cfg gate 模式（runtime 代码里已有 `window-shadows-v2` 类似 cfg 模式）。**Spike 跑 estimate**: 1 day (4-6h) optimistic per bridge-owner prototype precedent；risk: Windows 机访问 (JC 借) 可能延 1 day；contingency 是 ship spike report with Mac-only findings + 推 Mac-only v0.5 fallback。Cursor: B4 prereq gate / spike 等运行。

---

## Open decisions（B4 启动前要拍）

- [ ] **O1** menubar 图标：静态图标 + 数字 badge 还是 dynamic state icon？倾向静态 + badge（[stub decision](./B4-cli-bg-artifact.md) 沿用）
- [ ] **O2** CLI 在 Windows 上的 "Install to PATH" 具体写法（用户级 PATH vs admin），M3 sub-plan 时拍
- [ ] **O3** Discovery file 路径在 macOS：`~/.config/galley/`（XDG）vs `~/Library/Application Support/app.galley/`（Apple convention）。**倾向前者**（跨 OS 一致 + supervisor SOP 不用分支）
- [ ] **O4** Supervisor 行动日志 GUI 渲染密度：每动作一行 / 合并相邻 / hover 详情？**倾向 MVP 每动作一行 + hover 折叠 path**（M7 sub-plan 时复核）
- [ ] **O5** v0.5 ship 时 README 改写：现仍是 v0.1 「本地桌面工作台」framing，v0.5 改 dual-native 措辞。M9 实施
- [ ] **O6** Homebrew tap：v0.5 包不包？**倾向不包**（留 v0.6+）。CLI 默认走 bundled binary + manual symlink path
- [ ] **O7 NEW** Tray spike 何时跑：prereq 阶段（推荐，spike fail 早撤退）vs M2 开头（spike 跟 implementation 同 session 容易拖）。**倾向 prereq 阶段**
- [ ] **O8 NEW** M3 "Install to PATH" 失败 fallback：silent fallback 提示用户手动跑 / 严格 hard error？**倾向 toast 提示手动命令**（不让 sudo failure 阻塞 Galley 启动）
- [ ] **O9 NEW** Tauri tray API 在 macOS 26 (Tahoe) 行为：JC mac 是 macOS 14，CI runner macos-15 也不是 macOS 26。**等 v0.5 ship 后**有人在 macOS 26 上跑发现问题再处理

---

## Migration pattern · 给 future phase 用的迁移模板（B4 阶段视角）

B1/B2/B3 各自的 migration pattern 见对应 playbook 段（[B1](./B1-rust-core.md#migration-pattern--给-b2b3-用的迁移模板) / [B2](./B2-bridge-ownership.md#migration-pattern--给-b3-用的迁移模板write-path-增量) / [B3](./B3-store-slice.md#migration-pattern--给-b4-用的迁移模板slice-视角)）。B4 落地的「新 CLI 命令」pattern：

```
新 CLI write command 7 步：

1. Rust 端 GalleyApi trait + 实现（如已有 trait method 复用）
2. CLI binary subcommand + arg parsing + exit code 分类
3. socket route（runner_manager 接收 socket 调度到 trait）
4. Tauri command（GUI 复用同一 trait — B4-I4 enforce）
5. agent-api.md schema 段（M6 freeze 前都允许 inline 写）
6. Integration test（happy + error path）
7. 旧路径删除（若 GUI 用过 direct SQL 或 direct invoke 别的路径）
```

「supervisor 行动日志」pattern：

```
1. CLI 写命令时填 origin 三元组 (via, supervisor, reason)
2. 写命令 trait method 内 SQLite persist 该三元组到 messages.created_via / supervisor / origin_note 字段
3. Rust 端 emit supervisor-action event with origin payload
4. GUI listen → messagesStore.appendSupervisorAction action
5. Conversation 组件渲染 SupervisorActionBubble
6. dogfood 验证显示密度合理
```

---

## v0.5 ship 完成后

- README 改写定稿
- DESIGN.md onboarding subtitle 改新 framing
- 投 Galley Supervisor SOP 到 fudankw.cn/sophub（如果 sophub 接受）
- GitHub Release notes 强调 dual-native 转折 + migration 兼容性
- Twitter / 社区公告（如 JC 想做）
- 收集第一批 v0.5 用户反馈 → 排 v0.6+ 优先级

---

## 已知风险

继承 stub 5 个 + B3 经验补充：

- **风险 1: Tauri v2 tray plugin Mac / Win 兼容性** — Spike 1 day 验证 (prereq G2)
- **风险 2: App Nap (macOS)** — `NSProcessInfo.beginActivity` 或 Rust crate 缓解 (M2 T2.4)
- **风险 3: SOP 安装路径冲突** — 检测同名 → 弹「保留 / 覆盖 / 取消」(B4-I5)
- **风险 4: Migration 数据丢失** — B4-I6 备份强制 (M8 T8.5)
- **风险 5: GA SOP 在 IM frontend 里 dogfood 不顺** — M4 在自己微信 / 飞书上跑 1-2 周 iterate
- **风险 6 (B3 经验补充)**: Schema freeze 反悔成本高 — M6 sub-plan 时强制 full schema review (G6)
- **风险 7 (B3 经验补充)**: dogfood gate event-driven 在 milestone 内有效，但 v0.5 phase ship 必须 hold 1-week 严格 dogfood (G9)

---

## End of B4
