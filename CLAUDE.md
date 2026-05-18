# Galley

> **Note for human readers**: this file is the project constitution for AI coding agents working in this repository (Claude Code, Cursor, etc). It captures non-negotiable rules and the mental model assistants should adopt when contributing. Human contributors should also read [README.md](./README.md) and [docs/PRD.md](./docs/PRD.md).

> *Galley started as a workbench for GenericAgent. The first two letters of our name are a quiet bow to where we came from.*

**Brand wordmark rules**:
- **Body text / docs / sentences**: `Galley` (sentence case). Use everywhere the name appears inside prose, including README / CLAUDE.md / PRD / commit messages / comments.
- **Small wordmark display (≤ 20px)**: `GALLEY` (Newsreader serif, semibold, uppercase, tracking-[0.04em]). Currently used: Sidebar header (16px), Settings → About h2 (20px). Reads as a refined logotype mark with workbench weight.
- **Large hero display (≥ 30px)**: `Galley` (Newsreader medium, sentence case). Currently used: Onboarding StepWelcome h1 (36px). Uppercase at this scale reads as marketing banner; sentence case stays gentle and product-appropriate.
- Use **GenericAgent** / **GA** when referring to the upstream engine, never to mean Galley.

**Platform terminology** (用于一致区分 OS 和设备):
- **macOS** = the OS. Use for platform name / system requirements / app target. Examples: "Requires macOS 14", "macOS app", release titles like "Galley vX.Y · macOS (RC)"
- **Mac** = the device / hardware family / user. Use for hardware references. Examples: "Apple Silicon Mac", "Intel Mac", "your Mac", "M1+ 用户"
- Convention follows Apple's own usage. Major SaaS (Slack / Notion / Figma) align here on download pages.
- Today's lesson: [2026-05-15 v0.1 ship devlog §D4](docs/devlog/2026-05-15-v0.1-ship-and-ci-fallback.md#d4-macos-vs-mac-用词约定)

本地 agent team 编排器，人和 agent 都是一等公民。Galley GUI 给坐在桌前的 human operator，Galley CLI 给 Supervisor Agent 远程操作整个 session team。

v0.5 之前（v0.1 / v0.2）仍以"GA 的本地桌面工作台 + 多 session 并行"为主要使用形态；v0.5 起 dual-native 架构（Rust 端 Galley Core + 双前端）正式 ship。

- 产品定义（PRD v0.3）：[docs/PRD.md](./docs/PRD.md)
- 设计系统（DESIGN.md，draft）：[docs/DESIGN.md](./docs/DESIGN.md)
- IPC 契约：[docs/ipc-protocol.md](./docs/ipc-protocol.md)
- 发版 SOP（v0.2+）：[docs/release-workflow.md](./docs/release-workflow.md)
- Win 手动 build 指南：[docs/windows-build-checklist.md](./docs/windows-build-checklist.md)
- **Galley Core 重构执行手册** (v0.5 路径)：[docs/refactor/](./docs/refactor/README.md) — 跨多 session 重构的中央调度器；新 session 进入 B 阶段时必读
- 决策叙事 / 历史：[docs/devlog/](./docs/devlog/)

## 项目宪法（Non-invasive）

不能影响 GA 的独立运行。**违反任一条等于破坏项目核心承诺**：

- **不修改** `~/Documents/GenericAgent` 下任何文件（包括 `mykey.py`、`memory/`、`assets/`、源代码）
- **不覆盖** GA 的 venv / PATH / 环境变量
- **不 monkey-patch** `agent_runner_loop` 或 `do_*` 工具实现

**关于读取（read-only）**：

- **优先**走 GA 公开 API（`agent.list_llms()` / `agent.llmclient.backend.history` / `agent._turn_end_hooks` 扩展点）—— GA 自己保证 API 稳定，升级风险最低
- **直接读** GA 内部文件（`mykey.py` / `assets/` 下静态资源等）**只读**前提下允许，但需：
  - 在代码注释标注 coupling 点
  - 在 GA baseline 升级时审计该路径 / 格式是否仍有效
  - **任何"读取后基于读取结果回写 GA 文件"按"修改"对待，禁止**

宪法历史：2026-05-13 audit 时发现原条文"不读写 GA 的 mykey.py / memory/ / assets/" 字面禁止读取，跟实际行为（通过 `agent.list_llms()` 间接读 mykey.py 配置）不一致。重写为"禁修改 + 读取分级"，更准确反映 non-invasive 的真正含义：**保护 GA 独立运行 = 不改 GA 状态**，而读取本身从不破坏独立性。

允许的接入方式（详见 PRD 附录 A.2）：

- 启动 GA 子进程（每个 session 独立）
- 注册 `agent._turn_end_hooks`（GA 官方扩展点，主链路）
- 子类化 `GenericAgentHandler` 重写 `dispatch`（仅审批拦截，前置加门，不复刻原逻辑）
- 读 / 注入 `llmclient.backend.history`（用于历史恢复）

GA 升级时，Galley 只依赖 `BaseHandler` / `ToolClient` 这一层公开 API。

**例外条款：用户主动安装 Supervisor SOP**

v0.5 起 Galley Settings 提供 "Install Supervisor SOP" 按钮，用户点击后 Galley 把 `galley-supervisor-sop.md` 写入用户 GA 的 `~/Documents/GenericAgent/memory/`。这属于**用户显式触发的内容安装**，不属于"Galley 偷改 GA 状态"——宪法明确允许。

法理：宪法防的是"Galley 悄悄改 GA 让 GA 独立运行被污染"。SOP 是用户主动装的内容（类比"装 GA 插件"），不破坏 GA 独立性。删 Galley 后 SOP 文件留在 memory/，GA 仍然独立运行；用户也可以随时手动删该 SOP 文件，不影响 GA 任何功能。

实现要点：
- 装之前检查同名文件，存在时提示用户（不覆盖）
- 装的位置只能是 `memory/` 下且文件名固定为 `galley-supervisor-sop.md`（不允许 Galley 写到其它路径或其它文件名）
- 不接受用户配置"装到哪"——固定行为减少 surface
- 卸载 Galley 时不主动清这个 SOP（用户自己删，宪法非对称）

## Galley 架构原则 (v0.5+)

非侵入条款守 Galley ↔ GA 边界；本节守 Galley 自身的设计边界。**违反任一条等于破坏 v0.5 dual-native 承诺**：

### 1. Localhost only

**Galley Core 永远只 listen on AF_UNIX socket / named pipe，不开 TCP，不持有 token。**

远程访问（手机 IM 派任务给 Galley 这种场景）通过 Supervisor Agent 在外部传输层（GA 的 IM frontend / SSH / 其他）完成，**不是 Galley 的责任**：

```
手机 ─→ IM service ─→ 桌面上的 Supervisor (GA + IM frontend)
                              ↓ localhost (unix socket)
                              Galley Core
```

收益：
- 安全模型 = OS user filesystem permission，无 TLS / token / 证书 / 旋转
- 复用 GA 已经做好的 IM frontend，Galley 不重复造轮子
- "Galley 是本地的、数据不离开你的机器" brand 守住

**任何 PR 提"加 HTTP server / 加 token auth / 加远程访问"以本条款拒绝**。例外需先改宪法。

### 2. CLI surface 是公开契约面

Galley CLI 的 JSON 输出 schema 是 Galley 对 agent 生态的公开承诺。规范见 [docs/agent-api.md](docs/agent-api.md)（v0.5 ship 时 publish）：

- **schema_version 内 additive-only**：v1 schema 内只加字段，不删 / 不改语义
- **Breaking change 强制 bump**：要 break = `schema_version: 2`，旧版 SOP 可用 `?schema=1` 拿老格式
- **Exit code 分类稳定**：0/1/2/3/4/5 五类（详 agent-api.md），不重新分配
- **错误码 enum stable**：error 字段值是 stable identifier，不重新命名

下游 supervisor adapter（GA SOP / Claude Skill / 用户自写 agent）依赖这个契约稳定。**改 schema 比改 GUI 慎重得多**：GUI 改了用户重新学一遍，schema 改了所有 SOP 一起坏。

### 3. 数据不离开 Galley

**Galley 不存 Supervisor ↔ human 的对话内容**。supervisor 通过 CLI 发的命令、命令的 `--reason` 标注存进 Galley（per-session 行动日志），但 supervisor 跟 user 在 IM 里聊的对话不存。

收益：
- Galley 是 orchestrator 不是 chat platform，scope 守住
- 换 supervisor 不存在 "data migration" 问题
- supervisor history 是 supervisor 自己的事（GA history / Claude conversation 等）

例外：用户自己存的不算（如未来某用户 fork 改造 Galley 加 chat 持久化，那是 fork 不是主干）。

### 4. 路径 B 不可逆迁移

v0.5 起，**业务逻辑权威全部在 Rust 端 Galley Core**：
- SQLite 写：Rust
- Bridge subprocess ownership：Rust
- Session 生命周期 / 命令调度：Rust
- 前端（GUI / CLI / 未来扩展）：stateless presenter，订阅 event + invoke 命令

**任何 PR 在前端持有写权威（直接写 DB / 直接 spawn bridge / 持有 authoritative state）以本条款拒绝**。这是路径 B 不可逆。

宪法历史：2026-05-15 [vision pivot devlog](docs/devlog/2026-05-15-vision-pivot-to-orchestrator.md) 决定走 path B（Rust core 权威）而不是 path A（Rust 中继）。理由不是验证后才选 B，而是 B 架构独立于 supervisor 场景也更好（multi-frontend / 可测试性 / 开源贡献门槛 / 长期维护）。

## Tauri Identifier 不可随意改

Tauri 配置里 `identifier`（如 `app.galley`）**绑定了 macOS / Linux / Windows 上的应用数据目录路径**：

- macOS: `~/Library/Application Support/{identifier}/`
- Linux: `$XDG_DATA_HOME/{identifier}/` 或 `~/.local/share/{identifier}/`
- Windows: `%APPDATA%/{identifier}/`

SQLite 数据库（sessions / projects / tool_events / prefs）都存在这个目录下。**改 identifier 等于把 app 指向一个新空目录**——用户的所有数据看起来"消失了"（其实只是被遗忘在旧目录）。

历史教训：2026-05-13 改名 `app.gaworkbench` → `app.galley`，dogfood 中第一次启动新版本时所有 session 不见——是 identifier 改动造成的副作用，不是数据丢失。

**改 identifier 之前必须做的**（写代码顺序）：

1. 在 Rust 端（`core/src/main.rs` 或类似）加自动迁移逻辑：app 启动早期检测旧 identifier 目录是否存在 + 新目录是否为空 → 自动 `fs::rename` 把数据搬过来
2. 保留 fallback：bridge spawn / SQLite 打开时，如果新目录的 DB 缺失但旧目录有，先 copy 过来再用
3. dogfood 验证：在自己机器上**先手动放一份旧目录数据**，再换 identifier 启动，确认数据自动跑过来
4. release notes 显式说明这是次性的迁移行为

dogfood 阶段单用户改 identifier，手动 `mv ~/Library/Application\ Support/{old} ~/Library/Application\ Support/{new}` 解决；公开 release 后**不能再依赖手动操作**。

## 发版签名策略（Pre-v1.0）

Galley 桌面客户端目前**以未签名形式发布**——`.dmg` / `.exe` 都不走 Apple codesign 也不走 notarytool，Windows 不走 EV 证书签名。

定调（2026-05-18，JC 拍板）：「Galley 目前阶段不考虑 dmg 签名，都先以未签名形式发布，作为个人开源项目，问题不大。」

这是**当前阶段策略**，不是永久承诺。重新评估的触发点：进入 v1.0 + 用户基数 / 投诉量超过手动绕 Gatekeeper 的耐受阈值。在那之前，签名工程不在 Galley scope。

具体含义：

- `.github/workflows/release.yml` 不调 `codesign` / `xcrun notarytool` / `signtool.exe` —— 任何 PR 加这些步骤以本策略拒绝（除非同 PR 改 CLAUDE.md 该条款）
- macOS 用户首次启动 `.app`：**右键 → 打开**，Gatekeeper 弹"无法验证开发者"对话框，点"打开"绕过；后续启动正常
- Windows 用户首次启动 `.exe`：SmartScreen 警告"未识别的发布者"，点"更多信息" → "仍要运行"绕过
- **Release notes 必须明文说明**这两个步骤——不是隐含知识

为什么这条策略下还能做内嵌 Python：未签名的 .app 装上后，用户用右键→打开绕 Gatekeeper 一次给整个 .app 授权，**内嵌 binary 跟随 .app 的 quarantine cascade trust**。bundled Python 不需要单独签名也能跑（POC 已在 JC Intel Mac 验证）。

## 内置 Python（v0.1.1+）

Galley 自 v0.1.1 起在每个 release 里**内嵌 CPython 3.11.15 + GA core deps**，用户不再需要自己装 Python 或配 venv 才能跑 Galley。

设计要点：

- **来源**：[`python-build-standalone`](https://github.com/astral-sh/python-build-standalone) `install_only_stripped` 发布（Astral / `uv` 团队维护，跨平台、stripped 版本不带 IDLE/tkinter/test/）
- **打包脚本**：[`scripts/bundle-python.sh`](scripts/bundle-python.sh)。下载 PBS tarball → 解压到 `core/python-bundle/python/` → 删冗余 stdlib（test / tkinter / idlelib / turtledemo / ensurepip / Mac x86 `_tkinter.so` codesign blocker）→ `pip install` 四个 GA core deps 进 bundle 的 `site-packages/`
- **单 arch 输出布局**：`python-bundle/python/`（无 per-arch subdir）。Tauri build 一次只编一个 arch，CI 按 matrix 跑脚本对应 arch，每次覆盖
- **Tauri 集成**：`tauri.conf.json` `bundle.resources` 把 `python-bundle/python/` 映射到 `$RESOURCE/python/`；`capabilities/default.json` 注册两个 alias：`python-bundled`（Mac/Linux，`bin/python3`）+ `python-bundled-win`（Windows，`python.exe`）
- **prefs toggle**：`gaConfig.useExternalPython: boolean`，默认 `false`（用内置）。设 `true` 走老的 user-picker alias 路径，作为 escape hatch 给 GA fork 用户或者活动 venv 用户
- **dev 模式始终用 external**：`pnpm tauri dev` 的 `$RESOURCE` 在 dev 不指向 build resource dir，所以 `bridge.ts` 用 `import.meta.env.PROD && !useExternalPython` 双门控

GA core deps（必须 audit 进 bundle 的）：`requests` / `beautifulsoup4` / `bottle` / `simple-websocket-server`。当前 lock 在 PBS release `20260510` + 这四个 deps 的具体 pin（见 `scripts/bundle-python.sh`）。

**Baseline upgrade workflow 加一步**：每次 GA baseline upgrade 时除审计接口表面外，**也要 audit GA pyproject.toml 的 `[project.dependencies]` 列表是否有新增**——有新增就更新 `bundle-python.sh` 的 `GA_DEPS` 数组，重 build 三 arch bundle 测试。GA 的 `[project.optional-dependencies]`（`ui` / `all-frontends`）**不在内嵌范围**——Galley 自己是 UI 替代品，IM bot frontend 是 GA 的另一种用法不是 Galley 用户场景。

详细背景见 [2026-05-18 v0.1.1 bundled Python devlog](docs/devlog/2026-05-18-v0.1.1-bundled-python.md)。

## GA Baseline

锁定 commit: `b0635186a52d3119a46efbaab42e7acd08dffb59`（upstream/main HEAD，2026-05-18）

- 来源：`lsdefine/GenericAgent` upstream main 分支
- **49 个 commits** 升级自旧 baseline `fc6b5ad`（2026-05-15），**零接口表面 breaking change**（详见 [baseline 升级 devlog](docs/devlog/2026-05-18-ga-baseline-upgrade-fc6b5ad-to-b063518.md)）：
  - `agent_loop.py` —— **+6 / -2 行**。`agent_runner_loop` signature 新增可选 kwarg `yield_info=False`（additive）。Bridge 不传该参数，default 行为不变；BaseHandler 三回调 + dispatch 签名零改动
  - `agentmain.py` —— **+38 / -13 行**（占整次升级最大改动）。`agent.put_task` 的 `display_queue` payload 新加 `turn` / `outputs` 字段（之前只有 `next` / `done` / `source`）。Bridge 的 `_start_progress_drain` 只读 `next`/`done`/`source`，新字段被忽略 → 兼容。GenericAgent class 新增 `show_mode` 内部属性，bridge 不读 → 兼容。GenericAgentHandler 导入路径 0 改动
  - `ga.py` —— **+5 / -2 行**。`GenericAgentHandler` 内部 next_prompt 生成 / summary 长度上限 / plan 模式 turn 阈值（90→120）微调，**BaseHandler 三回调和 `agent._turn_end_hooks` 扩展点 0 改动**
  - `llmcore.py` —— **+9 / -3 行**。`_record_usage` 新增 output tokens 打印（仅 logging）；`MixinSession.model` 从 `__init__` 设的固定 attr 改为 property（动态返回 `_sessions[_cur_idx].model`，issue #394 fix）。**Bridge 的 `_safe_get_model` 读的是 `client.backend.model`（underlying session），跟 MixinSession.model property 无关 → 兼容**
- 其余 commits 是 TUI v2 theme system / hive worker / Markdown 渲染修复 / `/cost` `/review` `/rename` `/continue` 等 TUI 命令 —— 跟桥接层完全无关
- 测试矩阵：`runner/tests/` 106/106 在 b063518（新）+ fc6b5ad（旧）两个 baseline 都通过

CI smoke test（`runner/tests/test_e2e.py` + `test_handlers.py`）验证：

- `BaseHandler.tool_before_callback / tool_after_callback / turn_end_callback` 签名
- `agent._turn_end_hooks` 字典扩展点存在
- `llmclient.backend.history` 可读写

## Baseline Upgrade Workflow

GA baseline 锁死一个 commit，但需要定期升级 —— 否则用户 `git pull` 后跑在 upstream 上，「已验证版本」永远停滞，Settings 里「你已自行升级」badge 失去信号意义；同时 GA 新功能 / bug fix 无法惠及 Galley 用户。

### 触发时机（事件驱动，非日历驱动）

- **Galley 准备发版**：每次 Galley minor 或 patch release 前，baseline 默认升一次。这是常规节奏。
- **用户报「GA 新功能 / 行为 Galley 跑不起来」**：立即触发审计，无需等发版。
- **Upstream GA 有 critical fix**：安全 / 重要稳定性 bug，立即跟进。

不触发：日历到点了；upstream 出了一堆普通 commit（除非积累到下次发版前的常规节奏）。

### 升级 procedure（每次按这个清单走）

```
1. cd ~/Documents/GenericAgent && git fetch upstream
   git log <current_baseline>..upstream/main --oneline
   ↳ 看 diff 范围：N 个 commits

2. 审计这 N 个 commits 对四个接口表面的影响：
   - agent_loop.py 的 BaseHandler 三回调（tool_before_callback /
     tool_after_callback / turn_end_callback）签名 + dispatch 生成器协议
   - ga.py 的 _turn_end_hooks 字典扩展点 + hook(locals()) 调用约定
   - agentmain.GenericAgentHandler 导入路径
   - llmclient.backend.history 列表读写语义
   ↳ 任一项变化 = breaking change，需评估桥接层 / handlers.py 适配成本

3. 接口适配：**优先用 inspect.signature 做 feature detection**，不要硬绑某一版本签名
   ↳ 用户的本地 GA 可能落后于 baseline（CLAUDE.md 项目宪法：不政策化 GA 升级节奏）
   ↳ 桥接适配既要兼容 new baseline，也要兼容 old GA。两端都跑测试
   ↳ 例（cf65515 → 6bb3104 升级）：
     _BASE_DISPATCH_SUPPORTS_TOOL_NUM = "tool_num" in inspect.signature(
         BaseHandler.dispatch
     ).parameters
     # 然后 if _BASE_DISPATCH_SUPPORTS_TOOL_NUM: super().dispatch(..., tool_num)
     # 否则:                                       super().dispatch(...)
   ↳ 强制硬绑会导致 regression：用户没升 GA，桥接层就 crash（见 baseline-regression devlog）

4. 跑测试矩阵 —— 必须**两个 GA 版本都过**:
   a. cd ~/Documents/GenericAgent && git checkout upstream/main
      cd ~/Documents/genericagent-webui && .venv/bin/python -m pytest runner/tests/
      ↳ 验证新 baseline 兼容（forward compat）
   b. cd ~/Documents/GenericAgent && git checkout main
      cd ~/Documents/genericagent-webui && .venv/bin/python -m pytest runner/tests/
      ↳ 验证用户当前 GA 兼容（backward compat）—— 这一步**容易漏**
   ↳ 只跑 a. 是 cf65515 → 6bb3104 升级踩的坑

5. dev mode 起 Galley，跑一个 5+ 步骤的多步任务，
   确认行为没退化（thinking placeholder / streaming / approval / tool dispatch）

6. 更新 baseline 引用：
   - 本文件「GA Baseline」section 改 commit hash + 日期 + N commits since previous baseline
   - 如有 bridge 代码里 hardcode 的 baseline 常量也一并更新

7. 写 devlog: docs/devlog/YYYY-MM-DD-ga-baseline-upgrade-{old_short}-to-{new_short}.md
   - N 个 commits 的分类（feat/fix/refactor）
   - 接口表面审计结论（"零 breaking change" 或 "调整了 X、桥接层做了 Y 适配"）
   - 测试矩阵两端结果

8. Commit message: "Baseline upgrade {old_short} → {new_short}: N commits"
   ↳ baseline 升级独立成一个 commit，不混进其它功能 commit，方便回滚
```

### 跟 Galley 发版的耦合

- Baseline 升级是独立 commit，跟着 Galley 下次 release 一起 ship
- Release notes 点名「GA baseline 升级到 {hash}」并指向 devlog

### 不做的事

- **不主动 UI 提醒用户「GA 有新版本可拉」**：Galley 不政策化 GA 的版本节奏。Settings → Runtime → GA Version 里的「已对齐」/「你已自行升级」状态已经足够让用户自己判断。
- **不自动升级**：每次升级都需要人工 audit 四个接口表面 + dogfood 真跑，自动化只能做到 e2e smoke test 这一层。

### 已知的 audit 工具

- 看 commits：`git log <baseline>..upstream/main --oneline`
- 看接口表面变化：`git diff <baseline>..upstream/main -- agent_loop.py ga.py agentmain.py llmcore.py`
- 跑 e2e：`.venv/bin/python -m pytest runner/tests/`

## 目录结构

```
galley/
├── README.md                # 项目门面
├── LICENSE                  # MIT
├── CLAUDE.md                # 本文件，AI agent 协作规范
├── pyproject.toml
├── runner/                  # Python，桥接 GA 子进程（B1 前叫 bridge/）
│   ├── workbench_bridge.py  # 入口：import GA、注册 hook、stdin/stdout JSON Lines
│   ├── handlers.py          # WorkbenchHandler 子类（审批拦截）
│   ├── ipc.py               # IPC 事件 / 命令 dataclass
│   └── tests/               # pytest，必须脱离 GUI 端独立可跑
├── core/                    # Rust，Galley Core 权威层（B1 前叫 desktop/src-tauri/）
│   ├── Cargo.toml
│   ├── src/                 # Tauri commands + (B1+) GalleyApi trait + DB read
│   ├── migrations/          # SQLite migrations (include_str!-loaded)
│   ├── capabilities/        # Tauri capability allowlist
│   ├── icons/               # app bundle icons
│   └── python-bundle/       # bundled CPython（.gitignored，由 scripts/bundle-python.sh 生成）
├── gui/                     # Tauri 前端 React 19 + Tailwind v4（B1 前叫 desktop/）
│   ├── src/                 # React components + Zustand stores + types
│   ├── package.json
│   └── vite.config.ts
├── cli/                     # Rust，Galley CLI 一等公民前端（B1 M4 起填充）
│   ├── Cargo.toml
│   └── src/main.rs
├── .github/
│   └── workflows/
│       ├── release.yml      # tag-triggered 三平台 build + GitHub Release
│       └── check.yml        # PR 时三平台 typecheck/lint/cargo check
└── docs/
    ├── PRD.md                       # 产品定义（v0.3）
    ├── DESIGN.md                    # 设计系统（v0.2 draft，工作中）
    ├── ipc-protocol.md              # IPC 契约（runner ↔ core）
    ├── release-workflow.md          # 发版 SOP + CI 故障排查
    ├── windows-build-checklist.md   # Win 手动 build / smoke test 清单
    └── devlog/                      # 决策叙事 / 历史
        ├── README.md                # 时间线索引
        └── YYYY-MM-DD-topic.md
```

## 阶段推进

| 阶段 | 状态 | 目标 |
|---|---|---|
| 0. 基础设施 | ✅ 完成 | git init、目录、CLAUDE.md、LICENSE、README |
| 1. Bridge POC | ✅ 完成 | IPC 协议、WorkbenchHandler、主入口、e2e |
| 2. 桌面端骨架 | ✅ 完成 | Tauri v2 + React 19 + Tailwind v4 + Zustand + SQLite + plugin-shell 端到端 IPC（#1-#10b 全部子任务） |
| 3. V0.1 七件事 polish | ✅ 代码层完成 | 七件全做齐：#1 端到端真跑 ✅；tool_events 审批审计持久化 ✅；Multi-session N-active（含 per-session LLM / title 派生 / summary 写入 / set_llm 接 IPC）✅；Session Restore（user message 持久化 + ready 触发 replayHistoryToBridge）✅；LRU 5 alive bridges（active 保护 + 自动 suspend）✅；Settings GA Path picker（Python 字段诚实改只读，capability 限制）✅；Onboarding fs.exists 5 项 health check ✅；macOS bundle（bridge/ 作 Tauri resource + prod cwd=resourceDir）✅。Dogfood 7 轮 UX 打磨完成（composer auto-grow / LLM 内联 Popover / 右键 Archive + toast / lazy New Chat + 清「新对话」累积 / 软化 thinking placeholder + strip GA `LLM Running` marker / 「第 N 轮」→「第 N 步」/ Sidebar 三状态 unread / 修复 turn summary 静默丢失） |
| 3.5. Sidebar 重塑 + Projects V0.1 | ✅ 代码层完成 | Sidebar Earlier 桶折叠 + EarlierDialog（月分组 + 多选 bulk archive）✅；SQLite FTS5 全文搜索（migration 004，trigram tokenizer，CommandPalette 内"在对话内容中"分区）✅；Inspector 整面退役（右侧 Details/Approvals/Runtime 三 tab，第一性原理：每 tab 都重复其它地方信息，回收 14-30% 横向）✅；AppShell overflow-hidden 修复 ✅；MessageActions icon-only + Radix Tooltip（100ms 即时反馈）✅；Multi-select bulk in EarlierDialog & ArchivedDialog（Gmail-style Select toggle）✅；GA Baseline 6a3eecc → cf65515 升级（92 commits 零 breaking change，含 Settings → Runtime "GA Version" 卡片）✅；**Projects V0.1 完整实现** ✅（5 phase：数据层 + CreateProjectDialog + Sidebar PROJECTS section 上移到时间桶之上 + 右键 Move to project 子菜单 + filter 模式 banner ~~显示 rootPath~~ + ~~CWD 绑定到 bridge spawn~~ + EditProjectDialog + ConfirmDeleteProjectDialog + ProjectsDialog 阈值 9 + 右键 Delete destructive + 0-project 引导 + filter 状态下 New Chat label 自适应 + filter 空状态 CTA）。**2026-05-14 update**：rootPath/CWD 绑定 rollback 到纯分组（[devlog](docs/devlog/2026-05-14-project-rootpath-rollback-ga-memory-coupling.md)）——原 cwd 注入会让 GA 在 project session 下读不到 `./memory/...` 静默失效。剩 user 跑 `pnpm tauri build` 实测产物 |
| 3.6. Conversation polish marathon | ✅ 代码层完成 | 18 commits 把对话区主要体验全面打磨（[devlog](docs/devlog/2026-05-14-conversation-streaming-and-btw-marathon.md)）：**流式输出启用** ✅（`agent.verbose = True`，bridge `_FenceFilter` 状态机过滤 fence 内工具 stdout 解决 IPC 流量爆炸 + 98/98 bridge tests）；**User message apricot 锚点** ✅（实色 `bg-brand-soft` callout + 3px `brand-strong` 竖线，长对话回找提问主路径）；**TurnMarker thinking 态** ✅（占位符从大 callout 降到单行 italic serif 12px + 等待 ≥5s 显示 elapsed counter，每步独立计时）；**Phosphor-only 全产品**（收掉 💭 emoji 例外）；**⌥↑/⌥↓ 跨 user-msg 跳转** ✅；**/btw side question** ✅（bridge bypass agent.run() queue via `handle_frontend_command` worker；新 IPC `SystemMessageEvent` + SystemTurn 类型 + SystemMessageBubble 黄色 callout + Composer stopMode 让 `/btw` 通过；V0.1 transient 不持久化）；**Desktop Pet UX** ✅（sidebar Cat badge 显示 pet 附着位置 + menu label 二态化 + 隐式迁移机制）；**Conversation 视觉清扫**：ThinkingSummary 脱离 brand 色系到中性 surface / InlineToolPill 去 CheckCircle / AskUserBubble 规格对齐 user-msg / Follow-bottom 修复（步骤 commit 都触发 snap）/ `🛠️ ` dispatch marker strip / `[Action]` 行 strip 兜底 / GA prompt-induced `当前阶段：` preamble strip / 「归入项目」→「加入项目」文案。**Open**：/rewind 4-commit 计划已设计未实施（推到下次 session） |
| 3.7. Onboarding + Empty state + YOLO + button polish | ✅ 代码层完成；Windows prep 推迟 | 两个 commits 覆盖 8 大件（[devlog](docs/devlog/2026-05-15-onboarding-empty-state-yolo-button-polish.md)）：**Conversation 步骤渲染**：TurnMarker 整行可点击 + 条件 chevron 展开 DetailPanel（thinking + 前言并入）；新 TurnTicker streaming 显示前言最新段（line-clamp-3）；InlineToolPill 双区（icon + 中文名 + arg preview · mono GA name + chevron）；migration 005 加 `messages.preamble` + `extractPreamble` 反向抽取 strip-all-tags。**Onboarding 教程系统**：5 个手写 fix-it 片段 + TutorialModal + HealthCheckCard `actions` 扩到 warning + StepHealth 「重新检查」按钮 + StepAttach 失败 contextual tutorial 按钮 + 「Attach」→「接入」中英文一致化。**Welcome 双卡片**：Mode 1 灰禁「敬请期待」/ Mode 2「Galley 不会修改你的 GenericAgent」value-prop trust 文案搬卡片 body；副标题去句号跟 SettingsAbout 对齐。**Empty State**：删大标题；placeholder 升「今天交代什么？」；4 chip 降为 prose hint（italic serif 12.5px ink-muted）；新 prompt 跨 web/local/multi-source/reasoning。**LLM display name**：bridge `_simplify_llm_name(raw, model)` heuristic 尊重用户 mykey.py 显式 `name`；+8 测试 → 106/106。**YOLO 默认 ON + 阻塞 modal**：v0.1 默认 yoloMode=true；首次 MainView 弹 YoloIntroDialog（ESC/overlay/X 全禁，只能点「改回审批模式」/「知道了」）；`yoloIntroSeen` pref 只对真新用户翻 false 跳过现有 dogfooder。**按钮系统轻量统一**：新 `components/ui/button.tsx` 5 variant × 3 size，primary canonical = `bg-ink`，迁移 4 个最显眼 site；JSDoc 作系统规约。**v0.1 Mac-only 决策**：定 v0.1 Mac-only 释放（`.app` + `.dmg`），v0.2 计划 dual via GitHub Actions CI 出 NSIS `.exe` + `.dmg`。**未启动**：Mac-side prep 6 项（NSIS bundle / Python OS-aware / 教程命令双版本 / 键盘 mod-key 抽象 / joinPath 改 Tauri path API / docs/windows-build-checklist）推到下次 session，必须 Mac-backward-compatible（JC 明确确认） |
| 3.8. Windows 发版 prep · Y 计划自绘 chrome + A 阶段杂项 | ✅ 代码层完成；Win 机 smoke 待 | 10 个 commits 覆盖 Win/Mac dual-release 准备（[devlog](docs/devlog/2026-05-15-win-prep-y-plan-custom-chrome.md)）。**Y 计划自绘 chrome**（JC 为「精致工作台」品牌定位选 fully custom 而非回退原生 Win chrome）：Y1 Rust setup hook 关原生装饰 + `window-shadows-v2` 阴影（target-specific Cargo dep，Mac 二进制零 Win 代码） / Y2 `lib/platform.ts` UA-sniff `isMac` / `isWindows` + TopBar OS-conditional layout（左 spacer 70/12、右 pr-3 仅 Mac） / Y3 `WindowControls.tsx` 三按钮（46×44，bg-hover/bg-danger 同 token 系统）+ Win-scoped capability `platforms: ["windows"]` / Y4 双击 TopBar → toggleMaximize（`isWindowActionTarget` walk-up DOM 排除按钮）/ Y5 `onFocusChanged` 失焦 desaturate。**Snap Layouts 跳过** —— 要写 WM_NCHITTEST Rust 等真痛点反馈。**A 阶段**：A1 NSIS bundle target + currentUser installMode / A2 Python OS-aware default（`python` Win，`python3` Mac/Linux）/ A3 复盘后 no-op（教程命令早已双版本） / A4 `formatShortcut("Mod+K")` helper + 6 site 迁移（Mac 字符串 byte-identical）/ A5 `docs/windows-build-checklist.md`（25 项 smoke checkbox + 已知坑）/ A7 `EXAMPLE_GA_PATH` 常量（Mac `~/Documents/...` 不变，Win `C:\Users\你的名字\...`） / SettingsShortcuts macOS 文案保留 isMac 条件（feedback rule byte-equivalent）。**Mac 安全三层**：每个 Win-only 改动都过三道门 —— render gate (`!isMac`) → effect cleanup cancelled flag → platform-scoped capability。10 commits 全部 typecheck/lint/cargo check 干净 + 独立可回滚。**Open**: Y6 Win 机 smoke（Win 11 圆角自动应用 / resize handle 抓握 / Maximize 8px 溢出 / `onResized` 全路径触发 / Win+Arrow snap 跟我们 toggleMaximize 是否冲突 / CopySimple restore icon 是否可读 / 大字 fence-edge 等）待 JC 借机器跑 |
| 3.9. Release readiness consolidation · CI · menubar · icon · screenshots | ✅ 代码层完成；Win 机 smoke + 真 dry-run 待 | 14 个 commits 把发版能力一次性补齐（[devlog](docs/devlog/2026-05-15-release-ci-menubar-icon-screenshots.md)）：**Release CI**（[release.yml](.github/workflows/release.yml) tag push + workflow_dispatch 双触发 / 三平台 matrix macos-14 + macos-13 + windows-latest / pre-build typecheck+lint+cargo check / ubuntu-latest 收集 artifact + 创建 draft Release；[check.yml](.github/workflows/check.yml) PR + main push 跑同样三平台 gates 不 build artifact；[docs/release-workflow.md](docs/release-workflow.md) 人类 SOP 含 dry-run 路径 / 故障排查 / Intel runner deprecation 三 fallback）；**Mac menubar**（Galley/File/Edit/View/Window/Help 6 submenu，Find + Toggle Sidebar 灰禁占位 V0.2 wiring，About 用 PredefinedMenuItem 弹原生 dialog 利用新 icon）；**App icon 4 轮迭代** 最终 JC 手调 1024 RGBA + squircle 烤进 alpha + 832/1024 Apple safe area；**关键发现**：macOS Big Sur+ 不自动 mask 第三方 icon，必须把 squircle 烤进 alpha；**CI 实测抓 3 个 Win-only bug**（pnpm version 没指定 / `internal-on-*` event permission 是虚构名 / `window-shadows-v2::set_shadows` API 签名错），证实 cfg-gated Win 代码 Mac 本地 cargo check 永远抓不到，CI 是 must-have；**README 6 张 hero screenshots** 通过临时 patch demo.ts + hydrateFromDB 内存覆盖捕获，落 docs/screenshots/，截后 revert，SQLite 没动。**Open**：Y6 Win 机 smoke / release CI dry-run / README 整合 |
| 3.10. Vision pivot · workbench → local agent team orchestrator (dual-native) | ✅ 文档层完成 | 8 轮 brainstorm 产物（[devlog](docs/devlog/2026-05-15-vision-pivot-to-orchestrator.md)）：产品定位从「GA 的本地桌面工作台」reframe 为「本地 agent team orchestrator，dual-native for human and agent」。Galley CLI 一等公民 + Supervisor Agent 概念 + localhost-only 升级架构原则 + agent-api 公开契约 + Galley Core 权威层迁 Rust（路径 B 重构）。术语表（Supervisor / session team / Galley Core / runner/）+ CLI 命令 surface + 发包策略（sidecar + discovery file）+ 6 条 agent-first 输出规则。PRD v0.3 升格替代 v0.2（v0.2 留 git 历史）；CLAUDE.md 加 Galley 架构原则 4 条（localhost only / CLI 公开契约面 / 数据不离开 Galley / 路径 B 不可逆）+ SOP 安装例外条款。Rejected: CEO mode 命名 / MCP 主路径 / approval routing 当核心 / 路径 A 中继 / long-lived branch / 远程 auth / 存 supervisor 对话。**未启动**：[bridge-owner prototype](desktop/src-tauri/experiments/bridge-owner/README.md) 2-3 天 throwaway 验证 + v0.2 Windows release + Galley Core 重构 (B1-B4) |
| 3.11. v0.1 prod-build dogfood fixes | ✅ 代码层完成 | 首次跑 `pnpm tauri build` 出 .dmg 真启动，30 秒内暴露 4 个独立 bug（[devlog](docs/devlog/2026-05-15-v0.1-prod-dogfood-fixes.md)）：**Onboarding 路由从未接通**（fresh 用户 never reaches it，缺 `setScreen("onboarding")` 入口）；**LLM 列表是 demo fixture**（DEMO_LLMS 硬编码）；**发消息无反应**（DEMO_GA_CONFIG.python=`python3` 在 launchd PATH 下解析到 macOS 自带 3.9.6 无 GA deps，bridge import 即崩静默死）；**Re-run Health Check 是 `console.info` 占位符**。修复：(a) hydrateFromDB 检测无 `ga_config` → `setScreen("onboarding")`；(b) 新 `lib/python-probe.ts` 预注册 10 个候选路径（Tauri shell capability `cmd` 不支持 regex validator，只能枚举），运行时 spawn `sys.path.insert(0,gaPath); import agentmain` 逐个验证；(c) bridge stderr 加 per-session 滚动 buffer + abnormal close 弹 toast 显最后 3 行（含 spawn-error 路径）；(d) Onboarding 双层 drag region（外层 `data-tauri-drag-region` + 内层 `="false"` 让文本可选 + 按钮可点）；(e) Settings → Health Check 选 Option A 重构（按钮接 Onboarding StepHealth `mode="revisit"` 跳过 Welcome/Attach + Back→「取消」+ 进入→「返回 Settings」+ 恢复 screen + 重开 Settings dialog）。**Mid-execution 修正**：初版 probe 用 `import anthropic, openai`，实测 JC 机器所有 Python 都 fail；查 GA `llmcore.py:1` 发现 GA 用裸 `requests` 直接调 LLM endpoint **不引入 anthropic/openai SDK**，改 `import agentmain` 校验真实 import chain。**清死代码**：`rerunPythonProbe` action / `RuntimeInfo.healthChecks` 字段 + demo fixture（之前静态表永远 5 项 success，本质撒谎）。**Open**：conda/pyenv/asdf/uv 等非 PATH-style Python 不在预注册名单（V0.2 Rust-side spawn 解决）/ Probe 不自动 TTL（venv 后期坏只能用户手 Re-run）|
| 3.12. v0.1.0-alpha.2 Windows attach hotfix + CI maintenance | ✅ shipped (Latest on GitHub) | v0.1.0-alpha.1 Windows 群同日报两个独立 attach-time bug（[devlog](docs/devlog/2026-05-15-v0.1-alpha.2-windows-attach-fixes.md)）：(a) GA 在 `~/Documents` 下用户 picker 路径合法但 Onboarding 红字「错误路径」，加 `\` 才过——`joinPath` 硬编码 `/` 拼出混合分隔符 `C:\Users\foo\GA/agentmain.py`，Tauri plugin-fs 处理不一致；(b) GA 在 `D:\projects_2026\GenericAgent` 用户 Health Check 第一行就 fail——`tauri-plugin-fs` 的 `fs:scope` 默认只放行 `$HOME/$DOCUMENT/$DESKTOP/$DOWNLOAD`，D 盘根本不在 scope 内。**修法**：(a) `joinPath` async 化走 `@tauri-apps/api/path.join`，`expandHome` 升级为 `resolvePath` 加 Tauri `path.normalize`；(b) src-tauri 加 Rust Tauri command `path_exists(path: String) -> bool` 绕开整个 plugin-fs scope，JS 端 `fsExists` 改 `invoke("path_exists",...)`。**附带 feature**：Settings → Runtime GA Path field 改可手动输入（不只 picker），300ms debounce validateGAPath + Enter/blur commit + Esc revert + picker `onMouseDown.preventDefault()` 防 blur-commit 抢跑。**CI matrix 永久 drop macos-13**：JC Intel Mac 自 build 兜底；alpha.2 起 CI 出 2 artifact（aarch64.dmg + x64-setup.exe），Intel `.dmg` 走本地 build 手动 `gh release upload`。**Ship**: 6 commits + tag v0.1.0-alpha.2，CI 6 min 出包，Mac Intel 本地 build 上传到 same Release，notes 砍到极简（Fixes/New/下载/footer 一行 devlog 链接），publish → `--prerelease=false --latest` 把 alpha.2 顶为 GitHub repo Latest。**Post-release CI 维护**（一并 ship）：6 个 GitHub Actions bump 到 Node 24-ready major（checkout v6 / setup-node v6 / upload-artifact v7 / download-artifact v8 / pnpm/action-setup v6 / softprops/action-gh-release v3）消灭 Node 20 deprecation spam；macos-14 → macos-15 跨过 11 月 macos-14 deprecation 大限；check.yml 同步 drop macos-13 跟 release.yml 对齐。**macos-26 (Tahoe) 试 + revert**：第一次想要最长 runway 选 macos-26 但 `cargo check` PATH 解析到 `rustup-init` shim（macos-26 镜像预装 Rust + rustup 与 `dtolnay/rust-toolchain@stable` PATH 冲突），Win job 同 run 全过证实是 macos-26×dtolnay 隔离问题，revert 到 macos-15。**未启动**：MessageActions writeTextFile 仍走 plugin-fs scope（picker-gated 但 D:\ 静默 fail）/ python-probe 不识别 conda/pyenv/uv/asdf / 无自动测试覆盖 fs:scope 这类 regression / dtolnay 修好后再试 macos-26 / Mac Intel binary 仍要本地 build 手传 |
| 3.13. v0.1.1 内置 Python · 零配置 attach · UX polish 一并 | ✅ shipped (Latest on GitHub, 2026-05-18) | issue #1（lauchiwa Win uv 用户）+ Mac alpha.1 prod build dogfood + GA 群多次反馈"Python 路径配置烦"汇聚到一个结构性结论：v0.1 把 Python 候选路径硬编码到 Tauri shell capability allowlist 注定填不完。**结论**：Galley 自 v0.1.1 起在 release 里内嵌 CPython 3.11.15（PBS install_only_stripped）+ GA core deps（requests/bs4/bottle/simple-websocket-server），用户零 Python 配置可用。**关键发现**：GA core deps wheel 总大小 0.93MB（之前 hedge 的"30s pip install + 网络依赖"完全不必要）。Bundle 每架构 ~80MB 解开 / ~28MB 压缩进 .dmg。**未签名策略 codified** 进 CLAUDE.md 防止再次纠结（JC 拍板「目前阶段不考虑签名，作为个人开源项目问题不大」）。[完整 devlog](docs/devlog/2026-05-18-v0.1.1-bundled-python.md) + [baseline 升级 devlog](docs/devlog/2026-05-18-ga-baseline-upgrade-fc6b5ad-to-b063518.md)。**Phase 0 POC ✅**：JC Intel Mac unsigned .dmg 实测，`pgrep -fl workbench_bridge` 显示 spawn 走 `/Applications/Galley.app/Contents/Resources/python/bin/python3`，GA 正常响应。**Phase 1 ✅**：scripts/bundle-python.sh PBS downloader + Tauri resources mapping + capability 两 alias + bridge.ts PROD&&!useExternalPython 双门控 + gaConfig 加 useExternalPython 字段 + alpha.2→v0.1.1 自动迁移（默认 false 让升级用户享用 bundle）+ 顺手修 alpha.1 起 Settings → About 显示 "v0.1.0" 撒谎 bug。**Phase 3 ✅（UI 简化一并 ship）**：Onboarding StepHealth Python row 改 "Galley 内置 Python · CPython 3.11.15 ✓"（合成 success，不再 spawn 探测）+ Settings → Runtime PythonPanel 重写（Package icon 卡片 + 底部 "使用外部 Python…" 小字 link 进 advanced）+ `python-missing-anthropic` tutorial 降级 fallback-mode-only。**长对话 UX 一并搭车**（v0.1.2 narrative 提前到 v0.1.1）：UserQuestionRail 右侧 dot rail（≥3 条 user msg 才显示，hollow ring + filled active disc + 1px line-subtle spine 串成一组，hover 序号 secondary + preview）+ 长 user-msg 折叠（>6 行 / >500 字触发，fade-out mask + 「展开（共 N 行）」按钮，顺手修 `\n` 被 whitespace:normal 折叠的 latent bug 加 whitespace-pre-wrap）+ hover ↻ resend prefill（Composer forwardRef + useImperativeHandle，不删历史）。**Phase 6 ✅**：CI release.yml 加 Setup Python + actions/cache PBS tarball + bundle-python.sh 三 step（位置 load-bearing，必须在 Cargo check 之前——build.rs 验证 bundle.resources 路径存在）。**安装包命名**：scripts/rename-artifact.sh 插入 OS slug（`Galley_0.1.1-alpha.1_macOS_aarch64.dmg` / `_macOS_x64.dmg` / `_Windows_x64-setup.exe`）。**GA baseline** 一并升 fc6b5ad → b063518（49 commits 零接口表面 breaking）。**Phase 7 ship ✅**：tag push → CI 出 Mac arm64 + Win artifact，JC 本地 Intel build 手传，3 artifact draft → publish 为 Latest。**Mac Intel CI**：v0.1.1-alpha.1 走"本地 build + gh release upload"兜底。Post-ship 当晚（2026-05-18）workflow_dispatch dry-run 验证 cross-compile + Rosetta 2 路径——3 个 matrix job 全 pass（macos-15 arm64 4min / macos-15 x64 cross-compile 7min / windows-latest 6min），下 trial x64 .dmg 实测 `desktop` 和 `python3.11` 都是 Mach-O x86_64 ✓。Trial branch merge 到 main，v0.1.2 起 Mac Intel CI 出，本地 build 仅作兜底（[详细：release-workflow.md → Intel runner deprecation 应对](docs/release-workflow.md#intel-runner-deprecation-应对)）。**Win 实测覆盖有限**：两 unknown 留给群里 Win 用户 dogfood：(a) Tauri `$RESOURCE` 在 NSIS install 后路径解析正确性 (b) Win MAX_PATH 260 限制（用户名长 + 默认安装路径深时可能撞），release notes 明文 flag |
| 4. v0.2 Windows release | ⏳ 未启动 | 继承 3.8 + 3.9 已落地基础。剩 Y6 借 Windows 机 smoke test + NSIS .exe 出包 + release CI dry-run 验证。完成即 v0.2 ship；之后 main 上正式进 B 重构。**Note**：3.13 内置 Python + Mac Intel CI cross-compile 落地后，v0.2 Windows release 自动继承内置 Python 能力，scope 收窄到纯 Windows NSIS 出包 + smoke |
| 5. Bridge-owner prototype | ✅ 完成（2026-05-18 单 session） | **17/17 checklist PASS · GO for B1**（[devlog](docs/devlog/2026-05-18-prototype-go-for-b1.md) · [results.md](desktop/src-tauri/experiments/bridge-owner/results.md)）。Lifecycle (L1-L5) — spawn ready 430ms / 3并发 341ms（比单 spawn 快，Python startup 共享 cache） / external `kill -9` 检测 3.48ms / panic+unwind Drop SIGKILL 干净 / kill_on_drop clean teardown；Stdin command (C1-C3) — set_llm RTT 1.7ms / 5 fire-drain 无死锁；Stdout subscriber (S1-S4) — 双订阅(broadcast + UnixListener)内容一致 / S3 100 events 4548/s / S4 subscriber disconnect 互不影响；Stress (X1-X2) — 10k events sustained 4498/s linear scaling no OOM；Performance (P1-P3) Approach B(Rust 单边量化，TS 严格对比延后 B1 dogfood) — RTT p99 614µs / 4684/s / **300s 3 bridges +0.4 MB · t+111s 后 RSS plateau 3+ 分钟**（zero-leak 最强信号，spec 阈值 50 MB 实测 0.4 MB → 125 倍 cushion）。设计 call: 独立 tokio binary 不嵌 Tauri（spec 自相矛盾，broadcast + lifecycle 是假说本体，Tauri emit 是 commodity）。**4 commits**: scaffold (8d4769c) · L5+C+S+X (c22e6c1) · P+verdict (79e1f0a) · 300s plateau (8fb66ba)。Open: graceful shutdown 慢(~2.5s/bridge) 记进 B2 设计 TODO；strict TS P1/P2 对比可选半天补。**新 invariant I11**: Cargo `panic = "unwind"` 必须保留（L5 PASS 的前提；`panic = "abort"` 会让主线程 panic 时所有 alive bridges orphan）。`BridgeProcess`(experiments/bridge-owner/registry.rs 145 行) 是 B1 runner_manager 模块的 source pattern，pre-subscribed `preload_rx` 是 load-bearing 实现细节不能拿掉 |
| 6. B1: Rust core 骨架 + CLI 只读 · [playbook](./docs/refactor/B1-rust-core.md) | ⏳ 未启动 | 3w · 目录重组（src-tauri → core/、desktop → gui/、bridge → runner/、新建 cli/）+ Rust core 起步 + SQLite 读 + CLI 6 read 命令（list / brief / show / search / status / health）。详细 sub-tasks + cursor 在 playbook |
| 7. B2: Bridge ownership 迁 Rust · [playbook](./docs/refactor/B2-bridge-ownership.md) (stub) | ⏳ 未启动 | 3w · Python runner subprocess spawn/管理迁到 Rust（runner_manager 模块）+ React 改用 Tauri invoke 而不是直接 spawn + CLI 加 send_message（第一个写命令）+ dogfood: bridge 行为不能 regress |
| 8. B3: useAppStore 拆 slice + 改订阅 Rust event · [playbook](./docs/refactor/B3-store-slice.md) (stub) | ⏳ 未启动 | 3-4w · 拆 sessionsStore / messagesStore / runtimeStore / uiStore + 每个 slice 改订阅 Rust event 而不是自己 own 数据 + 每个 capability 迁完跑回归 + dogfood 一天 · 最 risky 阶段，regression 风险最高 |
| 9. B4: CLI feature-complete + background mode + adapter artifact · [playbook](./docs/refactor/B4-cli-bg-artifact.md) (stub) | ⏳ 未启动 | 2-3w · CLI 全部命令（archive / btw / project / llm 等）+ menubar daemon mode（关窗→隐藏）+ Galley Supervisor SOP + galley-supervisor skill + docs/agent-api.md 公开契约 + discovery file 写入 |
| v0.5 milestone | ⏳ | 10月底-11月初 · dual-native orchestrator 正式发布。Galley GUI + Galley CLI 对等前端 + Supervisor adapter 生态启动 |

## 工程规范

### Python（runner/）

- Python 3.10+
- 类型注解 + mypy strict
- 每个 IPC 事件 / 命令必须有 dataclass + JSON schema 测试
- 不引入 GA 之外的第三方包，除非必要（首选标准库）
- pytest 覆盖：schema 验证、hook 行为、子进程隔离

### TypeScript（gui/）

工具链：

- **Tauri v2** + **Vite 7** + **React 19** + **TypeScript 5.8 strict**
- **Tailwind v4**（CSS-first，`@theme` 在 `src/styles/globals.css`）
- **Phosphor Icons** thin weight 全局唯一 icon set
- **Self-hosted 字体**：`@fontsource/newsreader` / `@fontsource/inter` / `@fontsource/jetbrains-mono`（npm 包，无运行时网络依赖）
- **macOS-first**：`bundle.targets = ["app", "dmg"]`；`titleBarStyle: "Overlay"` 自定义 chrome 集成 traffic light
- 包管理器：**pnpm**（必须）

目录结构（gui/，B1 后；Rust 端拆到 sibling `core/`）：

```
gui/
├── src/
│   ├── main.tsx                 # 入口（import globals.css）
│   ├── App.tsx                  # 根组件
│   ├── styles/globals.css       # Tailwind v4 + DESIGN tokens（@theme block）
│   ├── components/
│   │   ├── layout/              # AppShell（三栏） / TopBar
│   │   ├── ui/                  # shadcn copy-paste 组件（按需引入）
│   │   ├── conversation/        # 主对话区（Conversation / Tool callout / Composer）
│   │   ├── approval/            # Approval Dock / Approval Card
│   │   ├── overlay/             # Command Palette / Health Check / Error
│   │   └── settings/            # Settings 独立窗口
│   ├── lib/
│   │   ├── utils.ts             # cn() + 通用 helpers
│   │   └── bridge.ts            # runner 通信封装
│   ├── hooks/                   # custom hooks
│   ├── stores/                  # state 管理（Zustand）
│   └── types/
│       └── ipc.ts               # IPC 协议 TypeScript 镜像（必须跟 runner/ipc.py 同步）
├── public/
├── package.json                 # tauri script → `cd ../core && tauri`
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js              # ESLint flat config
├── .prettierrc.json
└── components.json               # shadcn 配置（首次 add 时创建）
```

token 命名约定（Tailwind v4 友好）：

- 颜色：`--color-app` / `--color-surface` / `--color-elevated` / `--color-brand` / `--color-success` 等 → utility `bg-app` / `text-brand` / `border-brand`
- 文字色用 `--color-ink` / `--color-ink-soft` / `--color-ink-muted`（避开 Tailwind 的 `text-text-*` 双重命名）
- 边框用 `--color-line` / `--color-line-strong` / `--color-line-subtle`（避开 `border-border`）
- 字体：`--font-serif` / `--font-sans` / `--font-mono` → utility `font-serif` 等

shadcn 引入策略：

- **按需 add**，不 init 时一次性装。第一次需要的是 `command` (Command Palette)
- shadcn 组件 copy 到 `src/components/ui/`，可改可控
- **不让 shadcn init 改 `globals.css`**（避免跟我们的 token 冲突）；首次 add 时手写 `components.json`

shadcn vs 自研判断：

- **用 shadcn**：a11y 复杂 / 行为标准（command / dialog / dropdown-menu / popover / tabs / tooltip / sonner / button / input）
- **自研**：prototype 已定型 / 视觉 specific（Sidebar / Composer / Tool callout / Approval Dock / Health Check / Error Card / Onboarding / Empty state）

命令清单：

- `pnpm dev` — Vite dev server (无 Tauri 窗口，浏览器调试用)
- `pnpm tauri dev` — Tauri 桌面 dev（出 macOS 窗口）
- `pnpm build` — TypeScript 编译 + Vite 打包
- `pnpm tauri build` — 出 .app / .dmg
- `pnpm typecheck` — 仅 TS 检查（必须 0 error）
- `pnpm lint` — ESLint flat config（必须 0 warning）
- `pnpm format` — Prettier 写入

### IPC types 同步规则

`gui/src/types/ipc.ts` 必须跟 `runner/ipc.py` 字段一一对应。任何协议变更：

1. 改 `docs/ipc-protocol.md`（先）
2. 改 `runner/ipc.py` 的 dataclass + 测试
3. 改 `gui/src/types/ipc.ts` 同 commit 内同步

### Git 提交

- 英文 commit message，描述变更意图（不用单纯描述 what，写 why）
- 每个 commit 独立可工作（不留半成品）
- 不主动 push，等用户指令

### IPC 协议变更流程

1. 先改 `docs/ipc-protocol.md`
2. 再改 `runner/ipc.py` 的 dataclass
3. 再改实现 + 测试

文档先行；协议是 runner 和 GUI 之间的契约，不能用代码隐式定义。

## Devlog Workflow

`docs/devlog/` 是决策叙事日志，补充于 PRD（产品定义"现在是什么"）、DESIGN.md（设计规则"现在的规则"）、CLAUDE.md（项目宪法）。devlog 记录"我们怎么走到这里的"、考虑过但被否的方案、留待后续的 open question。

### 何时写

主动写 devlog 的三种场合：

1. **每次 work session 结束**（"今天先到这里"）
2. **重大设计/架构决策对齐后**（不一定等 session 结束）
3. **阶段切换**（如 Stage 1 → Stage 2，写一份阶段总结）

### 文件命名

`YYYY-MM-DD-topic-in-kebab-case.md`，一天可多个 entry（按主题分）。

### 6 段格式

每个 entry 包含：

- **Date / Status / Related** — 元信息（含 PRD/DESIGN/commit 引用）
- **Context** — 这次讨论或工作的背景
- **Decisions** — 对齐的具体结论，列表化、可索引
- **Rejected alternatives** — 考虑过但没选的方案 + 理由（最有价值的部分）
- **Open questions** — 留待后续的问题
- **Next** — 这次工作的下一步

### 责任分工

- AI 主写：每次决策对齐后主动提议落 devlog
- 作者 review：可以 inline 调整
- **不重复信息**：devlog 不复述 PRD / DESIGN.md / CLAUDE.md 已有的内容，只记叙事 + decision provenance

写完后更新 `docs/devlog/README.md` 时间线索引。

## 设计文档状态

DESIGN.md v0.2 完整版已定稿（[docs/DESIGN.md](./docs/DESIGN.md)），实现层与设计层对齐过几次：
- §2.1 token 表加 Tailwind v4 utility 列（ink / line 命名空间）+ `--brand-strong` / `--border-subtle`（Stage 2 #2）
- §4.6 file_patch 渲染从 `@pierre/diffs` 改为自研 PatchView（Stage 2 #6 reversal，bundle cost 不可接受）

参考 prototype 在 `docs/GenericAgent Workbench-handoff/`（design agent 出品的 5 张关键界面静态实现），实现各组件时对照视觉。

实现过程的关键决策叙事见 `docs/devlog/`，特别是阶段切换总结：
- [2026-05-18 GA baseline upgrade fc6b5ad → b063518 (49 commits)](./docs/devlog/2026-05-18-ga-baseline-upgrade-fc6b5ad-to-b063518.md)
- [2026-05-18 v0.1.1 内置 Python · zero-config attach · POC + Phase 1 commits](./docs/devlog/2026-05-18-v0.1.1-bundled-python.md)
- [2026-05-15 v0.1.0-alpha.2 Windows attach hotfix + CI maintenance](./docs/devlog/2026-05-15-v0.1-alpha.2-windows-attach-fixes.md)
- [2026-05-15 Release CI · Mac menubar · icon 4 轮迭代 · README screenshots](./docs/devlog/2026-05-15-release-ci-menubar-icon-screenshots.md)
- [2026-05-15 Windows 发版 prep · Y 计划自绘 chrome + A 阶段杂项](./docs/devlog/2026-05-15-win-prep-y-plan-custom-chrome.md)
- [2026-05-15 Onboarding + Empty state + YOLO + button polish · v0.1 Mac-only 决策](./docs/devlog/2026-05-15-onboarding-empty-state-yolo-button-polish.md)
- [2026-05-14 Conversation marathon · streaming · /btw · Pet UX · fence filter](./docs/devlog/2026-05-14-conversation-streaming-and-btw-marathon.md)
- [2026-05-14 Project = 纯分组：回收 rootPath/CWD 绑定（GA memory/ 静默降级修复）](./docs/devlog/2026-05-14-project-rootpath-rollback-ga-memory-coupling.md)
- [2026-05-13 Sidebar IA 重塑 · FTS5 · Inspector 退役 · Projects V0.1 · GA cf65515](./docs/devlog/2026-05-13-sidebar-overhaul-and-projects.md)
- [2026-05-12 Stage 3 dogfood polish marathon + turn_index 双层语义拆分](./docs/devlog/2026-05-12-dogfood-polish-marathon.md)
- [2026-05-11 Stage 3 V0.1 收尾 + dogfood 7 轮 UX 打磨](./docs/devlog/2026-05-11-stage3-v0.1-completion.md)
- [2026-05-11 Stage 3 multi-session：N-active + useShallow 踩坑 + LRU 5](./docs/devlog/2026-05-11-stage3-multi-session-and-perf.md)
- [2026-05-09 Stage 3 #1 端到端真跑 + UX polish](./docs/devlog/2026-05-09-stage3-end-to-end-and-ux-polish.md)
- [2026-05-07 Stage 1 bridge POC 完成](./docs/devlog/2026-05-07-stage1-bridge-poc-complete.md)
- [2026-05-08 Stage 2 桌面端骨架完成](./docs/devlog/2026-05-08-stage2-desktop-skeleton-complete.md)
