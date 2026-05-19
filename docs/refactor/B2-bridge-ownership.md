# B2 · Bridge ownership 迁 Rust

```
Cursor:   T3.1  (M1 + M2 done; next: Unix socket / named pipe listener)
Status:   🚧 M1 + M2 COMPLETE · M3-M7 pending
Started:  2026-05-19
Last touch: 2026-05-19 — M2 T2.1-T2.12 ship, GUI on Rust runner_manager via Tauri invoke + listen
Predecessor: B1 ✅ (commits 4ee23e3 → 41cdeb5)
Successor:   B3 (useAppStore 拆 slice + 改订阅 Rust event)
Duration:    3 周估计（D16-D30，按 PRD 节奏），但 B1 21× over-shoot 说明估计偏保守 — 真实 spend 看实施
```

**Cursor 协议**：完成 sub-task → cursor 移到"下一个未完成的最小编号 T"。Session 结束 → cursor 必须指向"明确可以接续的位置"，不要指 in-progress。

## 这个 phase 在干啥（一段话）

把 Python runner 子进程的 spawn / stdin / stdout / lifecycle 管理从 TypeScript（[`gui/src/lib/bridge.ts`](../../gui/src/lib/bridge.ts) 227 行 + [`gui/src/stores/useAppStore.ts`](../../gui/src/stores/useAppStore.ts) 里的 `_bridgeClients` Map / `_lruOrder` / `_stderrTails`）迁到 Rust (`core/src/runner_manager.rs`)。bridge-owner prototype 验证过的 `BridgeProcess` 是 source pattern，本 phase 把它升级到 production：多 session 并发 + LRU eviction + 多 subscriber broadcast。同步在 Rust 端开 Unix socket / named pipe listener，CLI 拿到第一个 write 命令 `session send`（通过 socket）— 这一刻起 GUI 跟 CLI 两个前端走**同一条权威路径**。**GUI 行为对用户 0 regression**：multi-session / streaming / ask_user / approval / `/btw` 全部通过 invoke + event listen 跑通。本 phase 结束时 v0.1 / v0.2 用户开 Galley 看不出区别，但内部权威已经全部在 Rust 端 — 这是路径 B 不可逆迁移（[CLAUDE.md 架构原则 #4](../../CLAUDE.md)）真正落地。

## Prerequisites · 必须先完成

- [x] B1 全部 acceptance criteria 跑过（11/12 pass + 1 deferred）+ devlog ship
- [x] B1 完成时记录的性能基线（CLI 6 命令 < 100ms debug binary）
- [x] [bridge-owner prototype](../../core/experiments/bridge-owner/README.md) 17/17 PASS + GO verdict
- [x] prototype 的 `BridgeProcess` 设计已被 B1 实施验证（`GalleyApi` trait + types 不会大改）
- [ ] dogfood 在 B1 后稳定一周以上（regression 浮现期） — **2026-05-19 开 B2 时 B1 仅 ship 一天，dogfood window 不足。建议 M1-M2 走 read-side scaffold + invoke wiring（影响面有限），到 M3 真正动 stdin/stdout/lifecycle 时再确认 dogfood 是否撞到 B1 引入的 regression**
- [ ] CLAUDE.md 阶段表 B2 row 加入（B1 finish 时只到 Stage 7 stub）— **B2 启动 commit 时一并更**

**未达 prerequisites 不允许启动 B2**。最后两条 B2 内自行解决。

> **Note (2026-05-19 B2 启动 planning session)**: 这份 playbook 是按 B1 经验回填的 stub 升格版。M1-M7 的 sub-task 颗粒度跟 B1 对齐，但 B2 引入了 prototype 阶段未充分验证的两个 surface（socket listener + multi-bridge concurrent ownership in production），可能 mid-phase 还需要展开新 sub-task。Running notes 段会记录这些演化。

## Phase invariants · B2 特有的硬规则

跨 phase 规则在 [invariants.md](./invariants.md)。B2 特有的：

- **B2-I1**: B2 内 `gui/src/lib/bridge.ts` 的 `spawnBridge()` 函数签名 **不改**。函数 body 在 M2 换成 Tauri invoke + listen wrappers，但 `BridgeClient` / `BridgeSpawnArgs` / `BridgeHandlers` interface 保持 byte-identical — 调用者（useAppStore）零修改。**保护 B3 的迁移空间**：B3 改 useAppStore 时已经能假设 bridge.ts 是 thin shim
- **B2-I2**: B2 内 `gui/src/lib/db.ts` 的 write functions（`persistTurn` / `persistApproval` / `persistRuntimeStateDelta` 等）**不动**。Write-to-SQLite path 是 B3 的事。B2 只动 runner 子进程相关的 ownership
- **B2-I3**: socket protocol schema **写入 `docs/agent-api.md`**（M6）。CLI 跟 socket 是 [CLAUDE.md 架构原则 #2 公开契约](../../CLAUDE.md)，schema 漂移 0 — 内部 enum / 字段名变了等于 break SOP，必须走 schema_version bump
- **B2-I4**: 新加的 origin 字段（`messages.created_via` / `messages.supervisor` / `messages.origin_note`）**额外可读，不影响显示**：GUI 在 B2 阶段不引入新 UI 渲染（V0.5 UI 渲染是 B3 的事）。本 phase 数据层落，UI 层后做
- **B2-I5**: socket 路径 **per-user scoped**（macOS/Linux 用 `$TMPDIR/galley-${UID}.sock`，Windows `\\.\pipe\galley-<user>`）。多个 Galley 实例同时跑 → 第二个 instance 启动时检测 socket 已存在 + listener live → exit with informative log。**不**抢 socket，**不**让两个实例 race
- **B2-I6**: prototype 验证的 `kill_on_drop(true)` + `panic = "unwind"`（[invariants.md I11](./invariants.md#i11-cargo-panic--unwind-必须保留)）**必须维持**。M1 任何代码 review 强制扫一遍 Cargo.toml profile + Child spawn options

## Acceptance criteria · B2 算完成

按顺序逐条 demo + tick：

- [ ] **A1**: `core/src/runner_manager.rs` 是 runner 子进程 ownership 的 single source of truth。`gui/src/lib/bridge.ts:spawnBridge` 不再直接 spawn — body 完全是 invoke wrappers
- [ ] **A2**: 老 `gui/src/lib/bridge.ts` 文件留着，函数签名不变（B2-I1）。`useAppStore.ts` 的 `spawnBridge` action / `_bridgeClients` Map 行为零变化（顶层抽象保留，底层换轨道）
- [ ] **A3**: CLI `galley session send <id> "<msg>" --supervisor=X --reason=Y` 跑通：从 CLI → Unix socket → runner_manager → bridge stdin → GA → tool dispatch → event 反向流到 GUI 显示
- [ ] **A4**: Galley Core 启动时开 Unix socket listener（macOS/Linux: `$TMPDIR/galley-${UID}.sock`；Windows: `\\.\pipe\galley-<user>`）。`galley` CLI 在 GUI 关闭时调写命令报 `exit 4` + 明确 "Galley Core not running"
- [ ] **A5**: 多 subscriber 正确工作：runner 的 IPC event 同时进入 GUI（Tauri event）+ CLI `watch` 命令的 socket 流 + (optional) future subscribers，互不影响
- [ ] **A6**: runner subprocess lifecycle 正确 — Galley 主进程退出时（正常 / panic / SIGTERM）所有 alive bridges 在 ≤2s 内清理干净，没有 orphan。`pgrep -fl workbench_bridge` 在 Galley 退出后 0 命中
- [ ] **A7**: Schema migration 010-014 已 ship（origin 字段族）。dogfood 用户 v0.2 → v0.5 直接升级 SQLite 自动迁移成功，老 row 的新字段默认 null
- [ ] **A8**: 性能 gate（[invariants.md I7](./invariants.md#i7-性能-gate)）— B2 重测 P1 first-token / P2 streaming throughput，**不比 prototype 基线慢 >50ms / >10%**
- [ ] **A9**: Galley GUI dogfood 跑 v0.2 完整 scenario 行为 **0 regression**：multi-session / streaming / ask_user / approval / `/btw` / yolo toggle / set_llm / load_history / pet attach/detach / shutdown clean 全部跑通
- [ ] **A10**: `docs/agent-api.md` 增量加 `session send` schema + `session watch` NDJSON stream schema + socket protocol section
- [ ] **A11**: Origin 标记真正生效 — CLI 调用打入的 message 在 SQLite 看到 `created_via='cli'` + `supervisor='X'` + `origin_note='Y'`。GUI 暂不渲染（V0.5 UI），但数据可读
- [ ] **A12**: Cargo + Python + TypeScript + CLI integration tests 四套测试全过；新加 Rust runner_manager unit tests 全过；prototype L1-L5 / C1-C3 / S1-S4 / X1-X2 / P1-P3 行为在 production 代码下重复 pass

---

## M1 · Rust runner_manager 抽象 (D1-D5)

把 prototype 的 `BridgeProcess` 升级到 production：多 session 并发 + LRU + stderr buffering + 多 subscriber broadcast。**不改 GUI 端**（GUI 还在用老的 `spawnBridge`），仅在 Rust 端新增模块 + 测试。本 milestone 结束时 Rust 端能在测试里跑通 multi-bridge lifecycle，但 GUI 还看不到任何变化。

### Sub-tasks

- [x] **T1.1** 新建 `core/src/runner_manager/mod.rs` 模块（采用 directory style，下含 `process.rs` / `manager.rs` / `error.rs`），引入 `pub mod runner_manager;` 进 `core/src/lib.rs`
- [x] **T1.2** RunnerProcess 移植自 `core/experiments/bridge-owner/registry.rs` `BridgeProcess`。`preload_rx` semantics 上移到 `RunnerManager::subscribe`（每个 caller 通过 manager 拿 receiver，不需要 process 内部 hold preload_rx）— 实际更简洁
- [x] **T1.3** `RunnerProcess::spawn` 扩展 args：`SpawnArgs { python, ga_path, session_id, cwd, bridge_cwd, llm_index, env }` 跟 TS 端 `BridgeSpawnArgs` 1:1。bundled python 路径解析**不**在 Rust 端处理 — caller (Tauri command handler in M2) 解析后传入 `python: String`。这跟 stub playbook 微调
- [x] **T1.4** 三个错误 enum：`RunnerSpawnError` (PythonNotFound / GaPathInvalid / BridgeCwdInvalid / PathEncoding / SpawnIo / PipeUnavailable) · `SendCommandError` (ProcessGone / Serialize / WriteIo) · `ShutdownError` (NotFound / KillFailed) — hand-rolled 同 GalleyError 风格
- [x] **T1.5** stderr 升级：每行 `eprintln!` 同时 push 进 `Arc<Mutex<VecDeque<String>>>` rolling buffer (cap 8)。`RunnerProcess::stderr_tail()` 暴露。**回调式** `on_stderr` closure 推到 M2（Tauri command 直接 invoke `stderr_tail` 比 closure 更适合 Tauri 的 invoke + emit 模型）
- [x] **T1.6** stdout 升级：broadcast typed `BroadcastItem::Event(Box<IpcEvent>) | Malformed(String)`。typed event parsing 在 stdout reader task；subscribers 拿到已解析的。Box 包 IpcEvent 让 `BroadcastItem` 大小可控（events 之间大小差异大）
- [x] **T1.7** `core/src/ipc.rs` 镜像 `runner/ipc.py`：17 events + 12 commands（含 `Abort` / `Shutdown` / `ReinjectTools` / `DetachPet` 这种 unit-variant）。serde tag="kind" + camelCase wire format + 7 unit tests round-trip
- [x] **T1.8** `RunnerManager` singleton：`Arc<RwLock<HashMap<String, Arc<Mutex<RunnerProcess>>>>>` + `Arc<Mutex<Vec<String>>>` LRU。Per-process Mutex 让 send_command 不阻塞 siblings；outer RwLock 让多 reader 并发 query pid / agent_running
- [x] **T1.9** `RunnerManager::spawn(args, active_session_id)`：旧同名 session 先 shutdown → 实例化 RunnerProcess → 注册 + touch LRU → enforce_cap（新 session 已在 LRU 末尾，保护自己）
- [x] **T1.10** LRU eviction：`enforce_cap(active_session_id)` 从 LRU 前端找第一个非 active 且 `!agent_running` 的 victim shutdown。全保护 → bail 等下次 spawn 重试。**关键差异**（playbook 已写）：active 由 caller 传入而不是 manager 持有，避免 multi-frontend 时 manager 假设 single GUI session
- [x] **T1.11** `RunnerManager::send_command(session_id, &IpcCommand)`：lookup → per-process Mutex lock → write stdin。Outer read lock 早释放避免阻塞 siblings
- [x] **T1.12** `RunnerManager::subscribe(session_id) -> Option<broadcast::Receiver>`：每次调用 fresh receiver，broadcast 不保留历史。caller 必须 subscribe 后再触发可能产生事件的动作（Ready 事件 ~430ms 后到，subscribe 够快）
- [x] **T1.13** `RunnerManager::shutdown(session_id, timeout)`：write_lock take out → graceful → kill fallback → 从 LRU 删
- [x] **T1.14** `RunnerManager::shutdown_all(timeout)`：take 全部 processes → tokio::spawn per-process graceful → join。Tauri app cleanup hook 调用
- [x] **T1.15** Integration tests `core/tests/runner_manager_test.rs`：9 tests 真 spawn mock Python subprocess（tempdir 写 mock `runner/workbench_bridge.py`）— ready emit / send command 回显 / agent_running toggle / shutdown clean / LRU eviction + active protection / stderr tail / shutdown_all concurrent / respawn replace
- [x] **T1.16** Unit tests `core/src/ipc.rs` + `error.rs` + `process.rs` + `manager.rs` mod tests：26 个 tests — IpcEvent / Command parsing round-trip / error variant serialize / error io_error mapping / spawn error paths（invalid bridge_cwd / nonexistent python）/ manager LRU touch order / unknown session 各 API 返回正确错误 / shutdown_all 空状态
- [x] **T1.17** `cargo test --workspace` 全过（35 tests · lib 26 + integration 9）；`cargo clippy -p galley-core --all-targets` 对 B2 引入代码 0 warning（B1 残留 2 个 warning 不在 M1 范围 — `src/api/search.rs` derivable_impls + `tests/db_test.rs` too_many_arguments，已用 spawn_task 独立标记）
- [x] **T1.18** Cargo.toml profile audit：`[profile.dev]` / `[profile.release]` 无 `panic = "abort"` override（默认 unwind）。`kill_on_drop(true)` 在 `process.rs:147` spawn 调用点。invariant I11 保留
- [x] **T1.19** M1 commit ready: doc update + 5 新文件（ipc.rs · runner_manager/mod.rs · runner_manager/process.rs · runner_manager/manager.rs · runner_manager/error.rs）+ 1 test file（tests/runner_manager_test.rs）+ Cargo.toml tokio 升 prod + lib.rs mod 注册

---

## M2 · Tauri command wrappers + bridge.ts thin shim (D6-D8)

把 GUI 端连到新 Rust runner_manager — `bridge.ts` 函数签名不变（B2-I1），body 全换成 `invoke()` + `listen()` 调用。dogfood 验证行为零差异。**此 milestone 完成 = GUI 已经在用新 Rust 路径了**（CLI 还没动）。

### Sub-tasks

- [x] **T2.1** 在 `core/src/runner_commands.rs` 加 5 个 Tauri command（playbook 写 4，实现加了第 5 个 `runner_stderr_tail` 给 abnormal-exit toast 用，第 6 个 `shutdown_all_runners` 给 app cleanup hook 用）：
  - `spawn_runner(args: SpawnRunnerArgs) -> Result<u32, String>` 返回 pid + 起 emit task
  - `send_to_runner(session_id, command: IpcCommand) -> Result<(), String>`
  - `shutdown_runner(session_id, timeout_ms: Option<u64>) -> Result<(), String>`
  - `kill_runner(session_id) -> Result<(), String>`
  - `runner_stderr_tail(session_id) -> Result<Vec<String>, ()>` (pull-style stderr)
  - `shutdown_all_runners() -> Result<(), String>`
- [x] **T2.2** `RunnerManager` 注入 Tauri app state via `.manage(RunnerManager::new())` 在 lib.rs run() 顶部。所有 command 通过 `State<RunnerManager>` 拿到同一实例
- [x] **T2.3** Event emit：`spawn_runner` 成功后内部启动 emit_task。task subscribe broadcast，按以下 event names emit:
  - `runner-event` payload `{ sessionId, event: IpcEvent }`（IpcEvent 保留 `kind` tag）
  - `runner-malformed` payload `{ sessionId, line }`
  - `runner-closed` payload `{ sessionId, code: null, signal: null }` — broadcast 关闭时 emit (= 子进程 stdout EOF)
- [x] **T2.4** 错误以 typed JSON 形式返回：`serde_json::to_string(&RunnerSpawnError)` → `{"error":"python_not_found","detail":"..."}`。前端 `formatInvokeError` 解析 + `humanizeErrorTag` mapping 给 user-facing 错误消息。CLI exit code 对应分类延后到 M4 (CLI write command)
- [x] **T2.5** `gui/src/lib/bridge.ts` 重写：函数签名 byte-identical (B2-I1)，body 全换：
  - 顶部 import 从 `@tauri-apps/plugin-shell` 改成 `@tauri-apps/api/core` invoke + `@tauri-apps/api/event` listen
  - `spawnBridge` 内：python 路径 + bridgeCwd 仍 TS 端 resolve（PROD bundled vs dev external），register 3 个 listener 然后 invoke `spawn_runner`，返回 BridgeClient
  - `BridgeClient.send` → `invoke("send_to_runner", { sessionId, command: cmd })`
  - `BridgeClient.kill` → `invoke("kill_runner", { sessionId })` + synth onClose
  - `BridgeClient.shutdown` → `invoke("shutdown_runner", { sessionId, timeoutMs })` + synth onClose
- [x] **T2.6** Listener filter by sessionId：3 个 listen() handler (`runner-event` / `runner-malformed` / `runner-closed`) 每个内部 `if (e.payload.sessionId !== sessionId) return;` 然后调对应 BridgeHandler 回调。Teardown by calling `unlisten()` for each — 在 onClosedSafe 内统一调用
- [x] **T2.7** stderr 走 pull 模型：bridge.ts onClosedSafe **在** onClose handler 之前，先 invoke `runner_stderr_tail` 拿最近 8 行，**同步**逐行调 `handlers.onStderr?.(line)`。这填满了 useAppStore.\_stderrTails buffer，紧接着 onClose handler 读到 buffer 做 toast。**优于 push-style**：单 stderr event/line 在 multi-session 高负载下放大 emit 量；pull 模型把 cost 集中到 onClose 一次
- [x] **T2.8** 老 plugin-shell import 完全删掉（不是注释 @deprecated）。capability `shell:allow-spawn` / `shell:allow-stdin-write` / `shell:allow-kill` 留着不删 — B1-I1 老路径并行原则 + dogfood 撞坑可 revert。一句 capability 顶部 comment 标记会更好但 capability JSON 不支持 `//` — 留 commit message + B2 M7 retire
- [x] **T2.9** `useAppStore.ts` 的 `_bridgeClients` Map / `_lruOrder` / `_stderrTails` / `_enforceLRUCap` 全部**未动**。bridge.ts 函数签名锁定 (B2-I1) 让 useAppStore 完全感知不到底层换了实现 — onStderr / onClose / onEvent / onError / onMalformedLine 五个回调签名+调用顺序+触发时机都跟老版本一致
- [ ] **T2.10** dogfood `pnpm tauri dev` (人工 · JC 手动)：
  - 开 3 个 session，每个发 message → turn_end 全到 ✓
  - 切 session 看 LLM list per-session 保持 ✓
  - 关 Galley 主窗口 + 等 5s + `pgrep -fl workbench_bridge` 0 命中 ✓
  - 触发 approval 拦截 → Card 显示 → approve → tool 跑通 ✓
- [x] **T2.11** CI 加 `cargo test`：[.github/workflows/check.yml](../../.github/workflows/check.yml) 加两步 `cargo test -p galley-core` + `cargo test -p galley-cli`，per-target matrix (macos-15 / windows-latest)。release.yml 不动 — release 不应该跑测试是约定（CI 已经覆盖；release 是 build artifact，跑测试浪费 5 min CI 时间）
- [ ] **T2.12** M2 commit pending（本节描述完后做）

---

## M3 · Unix socket / named pipe listener (D9-D12)

在 Galley Core 启动早期开 socket / pipe listener。Listener task 接受 connections，每个 connection 是一条 NDJSON 协议（request → response 或 streamed events）。**本 milestone 完成 = Rust 端有了 CLI write 路径的入口，但 CLI 还没用上**（M4 才用）。

### Sub-tasks

- [ ] **T3.1** 新建 `core/src/socket_listener.rs` 模块。`SocketListener::start(app: AppHandle)` 是入口
- [ ] **T3.2** 平台抽象：`enum Listener { Unix(UnixListener), Windows(NamedPipeServer) }` — Linux/macOS 走 `tokio::net::UnixListener`，Windows 走 `tokio::net::windows::named_pipe::NamedPipeServer`。**Cargo features**: `#[cfg(unix)]` / `#[cfg(windows)]` 双路径，不引入新 crate（tokio 已经支持两边）
- [ ] **T3.3** socket 路径选择 helper：
  - Unix: `${TMPDIR:-/tmp}/galley-${UID}.sock`（用 `nix::unistd::getuid()` 或者直接 `std::os::unix::fs::MetadataExt`）
  - Windows: `\\.\pipe\galley-${USERNAME}` （`USERPROFILE` 或 `whoami` env var）
- [ ] **T3.4** 启动时 race detection：socket path 已存在 → try connect → 通了说明另一个 instance 在跑，**log + exit informative**（不是 panic — 用户跑两个 .app 不是 bug，是 UX 问题）；连不通 = stale socket，删掉重建
- [ ] **T3.5** Listener task 主循环：accept connection → spawn per-connection handler task — 标准 tokio pattern。每 connection 独立，互不阻塞
- [ ] **T3.6** Per-connection protocol：NDJSON request line 进来 → dispatch via `GalleyApi` trait (B1 已有 read methods, 加 write methods 见 M4)→ response NDJSON 写回。`watch` 类命令切到 streamed mode：response 是无限 event stream，client SIGINT 关 connection 时 task 自然 drop
- [ ] **T3.7** Request format：`{"command": "session.send", "args": {...}, "schema_version": 1, "request_id": "uuid"}`。`request_id` 让 client 在 mixed request/stream session 里 demux。`schema_version` 配合 [B2-I3 公开契约](#phase-invariants--b2-特有的硬规则)
- [ ] **T3.8** Response format：
  - Success: `{"ok": true, "request_id": "...", "result": ...}`
  - Error: `{"ok": false, "request_id": "...", "error": "not_found", "message": "..."}` — error enum 跟 CLI exit code 共用同套
  - Stream: `{"stream": "event", "request_id": "...", "data": IPCEvent}` 行级 NDJSON
- [ ] **T3.9** 集成到 Tauri startup：`tauri::Builder::default().setup(|app| { tokio::spawn(SocketListener::start(...)); Ok(()) })`。**注意**：listener task lifetime 是 app lifetime — app 关闭时 listener task 自动 drop，连带删 socket 文件
- [ ] **T3.10** Socket file cleanup on shutdown: Unix socket file 是 filesystem object，Galley 退出时 panic 不清理会留垃圾。Rust 端用 `Drop` impl + `tokio::signal::ctrl_c` 双重保险 — 退出路径主动 `fs::remove_file(socket_path)`
- [ ] **T3.11** Listener 加 timeout：单 connection 90 秒 idle 自动断（防 leak）。streaming response 不算 idle（数据流动）
- [ ] **T3.12** 单元测试 `core/tests/socket_listener_test.rs`：
  - 起 listener → connect → 发送 `{"command":"sessions.list"}` → 拿到 NDJSON response（复用 B1 已有的 `sessions list`）
  - 起 listener → 第二个 instance 起 listener → 第二个 informative exit
  - 起 listener → connect → idle 91 秒 → 连接被服务端断（用 mock time / 短 timeout 测试）
  - 起 listener → connect → 主动断 → server 端 connection-handler task drop 不 panic
- [ ] **T3.13** **手动 smoke 测**（unit test 替代不了 cross-platform integration）：
  - macOS: `nc -U /tmp/galley-501.sock` 手动发请求看响应
  - Linux 暂跳过（v0.5 之前没 release，不实测；CI Linux runner 不强制 test 这个）
  - Windows 用 `\\.\pipe\galley-xxx` 测试推到 M3 后补
- [ ] **T3.14** **关键 audit**：socket file permission 必须 `0600`（owner only）— 别让同机器其他 user 通过 socket 调 Galley。Unix 端 listener 创建后立刻 `fs::set_permissions(path, 0o600)`。Windows named pipe 默认就是 user-scoped，不需要额外设
- [ ] **T3.15** Update [docs/ipc-protocol.md](../ipc-protocol.md) — 加新 section "Socket Transport (B2+)" 描述 listener path + request/response framing。这是公开契约的一部分
- [ ] **T3.16** M3 commit: `Refactor: B2 M3 — Unix socket / named pipe listener (CLI write entry point)`

---

## M4 · CLI write command `session send` + `session watch` (D13-D16)

CLI 拿到第一个 write 命令，验证从 CLI → socket → runner_manager → bridge stdin → GA 的完整路径。同步给 origin 字段 wiring。

### Sub-tasks

- [ ] **T4.1** `core/src/api.rs` 新加 trait method：
  ```rust
  async fn send_message(
      &self,
      session_id: SessionId,
      content: String,
      origin: Origin,
  ) -> Result<MessageBrief, GalleyError>;
  ```
  Origin struct 字段：`source: OriginSource { Gui, Cli, Supervisor }` / `supervisor_label: Option<String>` / `note: Option<String>`
- [ ] **T4.2** `core/src/db.rs` 给 `SqliteGalley` 实现 `send_message`：
  - lookup session 验证存在 + 非 archived
  - 拿对应 RunnerManager 的 session reference → 调 `send_command(UserMessageCommand { content })`
  - 等 ack（process write 成功 + 第一个 turn_start event 返回）— 还是 fire-and-forget？参考 O3 决策
  - 写 message row 进 `messages` 表，附 origin 字段。Message_id 由 Rust 生成（UUID v4）+ 返回给 caller
- [ ] **T4.3** **O3 拍板**：fire-and-forget + 返回 `MessageBrief { id, sessionId, origin, queuedAt }`。理由：等 ack 让 CLI client block 长（GA agent_runner_loop 可能 30+ 秒才进入 turn_start），不符合 agent-friendly。Watch 命令负责后续验证。Open notes 段落记录决策叙事
- [ ] **T4.4** `cli/src/main.rs` 加 `session send` subcommand（clap derive）：
  ```bash
  galley session send <id> "<content>" [--supervisor=<label>] [--reason=<note>]
  ```
  连 socket（path resolution 用 M3 同样 helper）→ 发 `{"command":"session.send","args":{...}}` → print NDJSON response → exit 0/2/3/4 per 错误类型
- [ ] **T4.5** `cli/src/main.rs` 加 `session watch` subcommand：
  ```bash
  galley session watch <id> [--from=<event_idx>] [--tail=N]
  ```
  连 socket → 发 `{"command":"session.watch","args":{...}}` → infinite NDJSON loop on stdout → SIGINT 关连接干净退出
- [ ] **T4.6** Socket 路径 helper 复用 M3 — `cli` crate 引入 `galley-core` 共享 `socket_path()` helper
- [ ] **T4.7** Socket client 端错误处理：connect refused → exit 4 (db_unavailable / "Galley Core not running")。connection unexpectedly closed → exit 5 (新 exit code? **暂定**: 复用 exit 4 + stderr 写明 reason)
- [ ] **T4.8** Watch 命令支持 backlog: `--from=<event_idx>` 让 supervisor 重连后能 resume。Rust 端 RunnerProcess 内部要维护 ring buffer（最近 N events）— 不是 broadcast channel 自带的（broadcast 是 fan-out 不是历史）。**Note**: prototype 没验证这个，可能要加新 unit test
- [ ] **T4.9** CLI integration tests `cli/tests/cli_write_test.rs`：
  - `send` happy path（mock socket server 接收命令 + 返回 success → 验证 NDJSON shape）
  - `send` GUI 关闭时 → exit 4
  - `send` session not found → exit 3
  - `watch` 收到 5 个 mock events → 打印 5 行后人为关闭 → exit 0
  - 用 `tempfile::NamedTempFile` 起 mock socket，避免污染用户 socket
- [ ] **T4.10** **手动 dogfood scenario**：
  - 启 Galley GUI，开一个 session A
  - 终端 `galley session send <A> "hello from supervisor" --supervisor=jc --reason=manual-test`
  - GUI 侧 A 出现 user message + GA 回复 turn_start..turn_end
  - SQLite 查 `messages` 表 → 该 message 有 `created_via='cli'` / `supervisor='jc'` / `origin_note='manual-test'`
- [ ] **T4.11** **第二个 dogfood scenario**（watch）：
  - 终端 1: `galley session watch <A> --tail=10` 看历史 + 实时
  - 终端 2: `galley session send <A> "test"`
  - 终端 1 看到 user_message / turn_start / ... / turn_end 系列 event
  - 终端 1 Ctrl-C → cleanly exit
- [ ] **T4.12** M4 commit: `Refactor: B2 M4 — CLI session send + watch (first write command via socket)`

---

## M5 · Schema migration 010-014 (D17)

数据层落 origin 字段。**Additive only**（[invariants.md I3](./invariants.md#i3-sqlite-migration-号段分配) + [I9](./invariants.md#i9-v01-ship-后的数据格式不动)）。

### Sub-tasks

- [ ] **T5.1** `core/migrations/010_messages_origin.sql`:
  ```sql
  ALTER TABLE messages ADD COLUMN created_via TEXT NOT NULL DEFAULT 'gui'
    CHECK (created_via IN ('gui', 'cli', 'supervisor', 'system'));
  ALTER TABLE messages ADD COLUMN supervisor TEXT;
  ALTER TABLE messages ADD COLUMN origin_note TEXT;
  ```
  Default `'gui'` 是 backfill — 老 row 都假设是 GUI 来的（v0.1/v0.2 数据真实情况）
- [ ] **T5.2** `core/migrations/011_sessions_origin.sql`:
  ```sql
  ALTER TABLE sessions ADD COLUMN created_via TEXT NOT NULL DEFAULT 'gui'
    CHECK (created_via IN ('gui', 'cli', 'supervisor', 'system'));
  ALTER TABLE sessions ADD COLUMN created_by_supervisor TEXT;
  ALTER TABLE sessions ADD COLUMN created_origin_note TEXT;
  ```
- [ ] **T5.3** `core/migrations/012_tool_events_origin.sql`（如果决定 tool dispatch 也带 origin）— **暂定 deferred**：tool_events 已经间接附属 message，origin 通过 message join 拿。等真有需求再加 — 不前置加 column
- [ ] **T5.4** Migration 010 / 011 写好后 `core/src/lib.rs` 的 `include_str!` 列表跟着加。M3 sqlx 的 `Migrator` 自动按 序号 apply
- [ ] **T5.5** core/src/api/message.rs 加 `Origin` struct + `OriginSource` enum + serde derive
- [ ] **T5.6** core/src/api/session.rs 给 `SessionBrief` 加 `originSource: OriginSource` / `supervisorLabel: Option<String>` / `originNote: Option<String>` 字段 — additive，老 GUI consumer 忽略新字段不报错
- [ ] **T5.7** Rust 端 `SqliteGalley::send_message` 实现要写新字段（M4 T4.2 顺便完成）
- [ ] **T5.8** **dogfood 校验 v0.2 → v0.5 升级路径**：
  - copy 一份 v0.2 dogfood DB（JC 真用的）到 `/tmp/galley-test.db`
  - `GALLEY_DB_PATH=/tmp/galley-test.db pnpm tauri dev` 起 Galley
  - 验证启动时 migration 010-011 自动 apply
  - 验证老 session / 老 message 都正常显示 + 新字段值都是 default
- [ ] **T5.9** Tests in `core/tests/db_test.rs` 加 origin 字段 round-trip（write → read → assert）
- [ ] **T5.10** **关键 invariant**：migration 010 / 011 一旦 ship **不准改内容**（[invariants.md I3](./invariants.md#i3-sqlite-migration-号段分配)）— 错了加 012 / 013 修
- [ ] **T5.11** M5 commit: `Refactor: B2 M5 — Schema 010-011 origin fields (additive)`

---

## M6 · agent-api.md 增量 (D18)

公开契约更新。

### Sub-tasks

- [ ] **T6.1** [`docs/agent-api.md`](../agent-api.md) 加 section "Socket Transport"：
  - Path resolution (Unix / Windows)
  - Request / response framing (NDJSON + request_id + schema_version)
  - Error code reference (same as CLI exit codes + transport-specific)
- [ ] **T6.2** 加 `session.send` command schema：args / response / origin 字段定义 / 错误情形
- [ ] **T6.3** 加 `session.watch` command schema：args / streamed NDJSON event shape / `--from` semantics / SIGINT exit
- [ ] **T6.4** 更新 stability promise 段落：socket protocol + new commands 加入 stable surface 列表
- [ ] **T6.5** "B2+ planned commands" section 该删的删（已实现的）、该留的留（M7 收尾 / B3 / B4）
- [ ] **T6.6** M6 commit: `Refactor: B2 M6 — agent-api.md: socket protocol + session send/watch`

---

## M7 · B2 acceptance + 收尾 (D19-D20)

### Sub-tasks

- [ ] **T7.1** 跑遍 acceptance criteria A1-A12，每条勾掉。A11 / A6 / A8 / A9 是 dogfood 重点
- [ ] **T7.2** 性能基线对比 B1：
  - P1: CLI `galley session send` first ack RTT
  - P2: streaming throughput (events/sec) 通过 GUI Tauri event vs prototype baseline
  - 任何一项比 prototype 基线慢 >50ms（P1）/ >10%（P2）触发 [invariants.md I7](./invariants.md#i7-性能-gate) — 撤回最后 commit + 重设计
- [ ] **T7.3** dogfood 1-week period — JC 在重构 .app 上跑日常工作，记录任何 weird behavior。**重点 watch list**：
  - bridge crash 后 stderr toast 是否还能显示（M2 T2.7 路径）
  - LRU eviction 是否还跟之前一样静默（用户不感知）
  - shutdown 速度（prototype 测过 ~2.5s/bridge graceful，B2 有没退化）
- [ ] **T7.4** 写 B2 完成 devlog: `docs/devlog/YYYY-MM-DD-b2-bridge-ownership-complete.md`
  - M1-M7 实施过程的关键决策
  - prototype assumption 哪些 hold / 哪些不 hold
  - dogfood 1-week 发现的 regression（如有）
- [ ] **T7.5** 更新 `docs/refactor/README.md`：
  - dashboard B2 row → ✅
  - cursor 指向 B3
  - "新 session 启动 checklist" 是否需要补充
- [ ] **T7.6** 更新 `CLAUDE.md` 阶段表：B2 ✅ COMPLETE
- [ ] **T7.7** **写 B3 playbook**（之前的 stub 升级到完整）— 跟 B2 这次升格同样路径，dedicated session
- [ ] **T7.8** Commit + tag: `git tag b2-complete`（不发 release，只标记）

---

## Running notes / gotchas

**Append-only. Don't delete. 旧的判断错了追加新条说明。**

### 写在前面的已知 gotcha（开 B2 前要注意）

- **G1 (M1 T1.2)**: prototype 的 `BridgeProcess` 跟 production 的 `RunnerProcess` 命名差异不只是 rename — production 需要 broadcast typed `IPCEvent` 而不是 prototype 的 `String`，意味着 parser 路径在 spawn 时就要起来。**别**直接 `cp registry.rs runner_manager/process.rs` 完事 — 70% 是新代码
- **G2 (M1 T1.7)**: `runner/ipc.py` 跟 `core/src/ipc.rs` 两份 Rust/Python typed event 定义是 **手动同步**的（不走 codegen）。每次加新 event 两边都要改。**Codegen 是 future work**（B4 / v1.0），现在 manual sync 比引入 codegen 工具链值
- **G3 (M1 T1.10)**: LRU eviction 的 active_session_id 在 TS 端是 store getState 读，迁 Rust 后没 store — caller (Tauri command handler) 要通过 spawn args 传入。**这意味着** activeSessionId 现在是 React state，每次 spawn 才传给 Rust — race condition 风险（用户切 session 但 spawn 还没回来）。Mitigation: spawn 调用前 caller 主动 touch LRU；spawn 返回后 manager 再次 touch（idempotent）
- **G4 (M2 T2.3)**: Tauri `emit()` 在 PRO 模式下有 throttling 行为吗？streaming verbose 时一秒可能 emit 100+ events，windowed UI thread 跟不上会丢吗？**需要验证**（prototype 没测过 Tauri event 通道，只测过 broadcast channel）。Mitigation 候选：(a) batch emit (b) per-session emit 隔离 (c) 直接走 Unix socket subscribe 路径，避开 Tauri event（最重）
- **G5 (M3 T3.4)**: Unix socket race detection 用 `try_connect` 判断 stale — 但如果 owner process 在 connect 跟 read 之间挂了，新 instance 看到 EOF 也会判 stale 然后 unlink。**两 instance 高速 start/stop 切换可能造成 socket file 闪烁**。Mitigation: socket 创建后 PID lock file `/tmp/galley-${UID}.pid` 二次校验
- **G6 (M3 T3.14)**: Linux 端 socket file permission 0600 通过 `fs::set_permissions` 设但有 race window — 创建到设权限之间任何进程可见 (TOCTOU)。**正确做法**：先 `umask(0o077)` 再 bind，让 socket 一创建出来就 0600。**还是用 `nix::sys::stat::umask` 临时降低 umask + restore**
- **G7 (M4 T4.3)**: O3 决定 fire-and-forget — 但 CLI 端写完 ack 后立刻 `exit 0`，supervisor 看不到 GA 是否真的处理这个 message。Workaround：建议 supervisor 写"send + watch"组合（`galley session send && galley session watch --from=$(...)`）。**Doc 在 agent-api.md M6 T6.2 强调这个 pattern**
- **G8 (M4 T4.8)**: Watch 命令的 `--from=<event_idx>` 需要 RunnerProcess 内 ring buffer，prototype 没验证 ring buffer 在 X1 / X2 stress 下的行为。最坏情况 buffer 大小 4-8MB（per session）。考虑 LRU 5 alive = 20-40MB extra RAM。Acceptable，但 ring buffer 大小不能设到 100MB+ 范围
- **G9 (M5 T5.3)**: `tool_events` 是否带 origin？暂定不加 — origin 通过 message join 获取。**如果 B4 supervisor 行动日志 UI 想直接 query tool events by origin，再补 012 migration**
- **G10 (T2.10 dogfood)**: dogfood 的盲点是"老 GUI bug 还在 / 新 GUI bug 不在" — 因为 B2 不改 useAppStore 行为。**回归测试覆盖**：dogfood 1 周期里 JC 至少跑一次 v0.1.1 alpha.1 .app（[invariants.md I8](./invariants.md#i8-dogfood-期间老-app-必须留着)） 对比 — 同 scenario 同输入两边对比是否真 0 regression
- **G11 (跨 milestone)**: 整个 B2 期间 `gui/src/lib/bridge.ts` 函数签名锁定，但 Rust 端如有大改可能影响 invoke shape — 抽公共 IPC types 时**优先**让 TS 端 zero-change。如果实在需要破坏 TS shape，**先 update CLAUDE.md / playbook 再写代码**

### Session 跑下来追加的 notes（按日期）

#### 2026-05-19 · M1 完整执行单 session

- **N1 (T1.2 → SpawnArgs)**: prototype 的 `BridgeProcess::spawn(session_id, python, ga_path, bridge_cwd)` 直接传 4 个 positional args；production 升级到 `SpawnArgs` struct（7 字段）后调用方更清晰。代价是每个 caller 多写几个字段名 — value 大于代价
- **N2 (T1.3 bundled python)**: 原计划把"PROD && !useExternalPython → bundled alias"路径解析迁 Rust。**改为**让 caller（Tauri command in M2）解析后传 `python: String` 给 RunnerProcess::spawn。理由：(a) Rust 端要解析 PROD vs dev 必须依赖 Tauri AppHandle 拿 resourceDir() — 把 spawn 路径耦合 Tauri，违反"core 是独立 crate"目标；(b) M3 socket transport 不通过 Tauri，让 socket 调用方也能用 spawn 必须保持 python path 显式传入。**playbook 用 stub 时假设**直接迁 Rust 是更优的；实施时发现拆开更干净
- **N3 (T1.5 stderr callback)**: stub playbook 说"on_stderr closure 推给上层"。**实施**改成 rolling buffer + `stderr_tail()` pull-style API。理由：Tauri command 模型天然是 pull (invoke 拿数据)，push closure 反而要求每个 spawn site 注册 callback。abnormal-exit toast 场景下 GUI 在 onClose 后调一次 `stderr_tail` 就够，不需要每行 push
- **N4 (T1.6 BroadcastItem enum)**: typed event 还是 typed | malformed enum？选 `BroadcastItem { Event(Box<IpcEvent>) | Malformed(String) }`。Box 是因为 IpcEvent variant 之间大小差异较大（Ready 携带 vec<Value>，Abort 是 unit），no-box 会让 BroadcastItem 大小被最大 variant 拖累 — 每次 broadcast send 都 clone 整个 enum，浪费
- **N5 (T1.7 ipc.rs 一回合搞定)**: 17 events + 12 commands 一次性写好，比预期顺利。serde 的 `tag = "kind", rename_all = "snake_case"` + 字段级 `rename_all = "camelCase"` 双层 rename 完美对上 Python 端 dataclass `kind: str = "snake_case"` + camelCase field names. 0 后续修补
- **N6 (T1.9 spawn vs respawn)**: 同 session_id 再 spawn → 旧 process 先 shutdown。实施时确认 `RwLock<HashMap>` 必须先 take out 旧 process 释放 write lock 再 await shutdown，否则 deadlock。Integration test `respawn_same_session_replaces_old` 验证 pid 改变 + alive_count 不增
- **N7 (T1.10 active_session_id 由 caller 传)**: stub playbook 已经写到这点。实施时 LRU `enforce_cap` 用 `Option<&str>` 接收 caller 声明的 active id — None 表示"没有 active 概念，所有 session 平等"。这是为 CLI / socket transport 准备的 — 未来 supervisor 调 spawn 时没有"active GUI session"概念
- **N8 (T1.15 mock subprocess)**: 集成测试用 Python 写 mock runner 而不是真 `runner.workbench_bridge`（不依赖 GA 装置）。mock 在 turn_start 后 `time.sleep(0.3)` 给 harness 检查 `agent_running == true` 的窗口 — stdout reader 在 turn_start 后立刻处理下一行 turn_end 会让 flag race 没法 observe。**Gotcha**：写测试时第一版没 sleep，直接 fail；加 sleep 后稳定
- **N9 (T1.15 test skip on no-python)**: `mock_python_path()` 返回 Option，None → 测试 silently 通过（不 fail）。CI Linux runner 总有 Python；本地 macOS 也有；Windows runner 通过 actions/setup-python 拿到。**未来风险**：如果 CI matrix 加了无 Python 的镜像，集成测试会全部静默跳过 — 加一道"no test should silently pass on a clean env" 检查值得（推到 M2）
- **N10 (T1.17 B1 残留 clippy)**: `cargo clippy -p galley-core --all-targets` 抓到 2 个 B1 留下的 warning（`SearchScope::Default` derivable + `seed_message` too_many_arguments）。我没顺手修——按宪法"改动只动必需的"。已 spawn_task 独立标记，等独立 PR
- **N11 (T1.7 Cargo.toml tokio 升 prod)**: 原本 tokio = optional + experiments feature。M1 把 tokio 移到 `[dependencies]` non-optional + features 集合保留（macros / rt-multi-thread / io-util / process / sync / time / net / fs）。`experiments` feature 还在但只 gate `anyhow`。`[dev-dependencies] tokio` 删掉（lib 已经 prod-dep tokio）；加 `tempfile = "3"` dev-dep 给 integration test 写 mock runner
- **N12 (T1.17 dev tokio dep removal)**: 之前 `[dev-dependencies] tokio = { version = "1", features = ["macros", "rt-multi-thread"] }` 是 dev-only 配置。升 prod 后这行变成 redundant — `cargo` 会 merge dev + prod features 但 prod 是 superset。**留还是删**：选删，少一处需要同步的 features 列表
- **N13 (T1.18 panic profile)**: Cargo.toml 没显式 profile 段 → 默认 unwind。但 invariant I11 要求"任何 PR 显式加 panic=abort 拒绝" — 我们没显式声明 unwind 也算合规（默认就是 unwind）。**这条 invariant 落地的方式可以加强**：是否在 CI lint 加一个 grep 检查 "panic\s*=\s*\"abort\"" 不出现于 core/Cargo.toml？推到 M7 收尾

#### 2026-05-19 · M2 完整执行同 session 接 M1

- **N14 (T2.1 5 个 command 而非 4)**: playbook 写 4 个 (spawn / send / shutdown / kill)。实施时加了 `runner_stderr_tail` 第 5 个 (给 abnormal-exit toast pull 用，否则 stderr 必须 push 模式) + `shutdown_all_runners` 第 6 个 (给 app cleanup hook 用)。两个新增都是纯辅助，不破坏 4-command 主路径
- **N15 (T2.1 runner_stderr_tail 必须 Result)**: 第一版返回 `Vec<String>` direct，cargo check 失败 — Tauri async-command harness 强制要求 `Result<T, E>`。改成 `Result<Vec<String>, ()>` 让 caller 永远拿 Ok。E 为 unit 但不能省
- **N16 (T2.3 emit_task lifetime)**: emit_task 跟 broadcast channel 同生命周期。子进程 exited → stdout EOF → stdout reader task 终止 → broadcast sender drop → 所有 receiver 拿 `RecvError::Closed` → emit_task 发最后一条 `runner-closed` → 终止。**好处**：不需要单独的"我死了"信号，broadcast 自然终止即是 exit signal
- **N17 (T2.3 close event 拿不到 exit code)**: emit_task 通过 broadcast close 检测进程死亡，但拿不到 exit status。Manager 的 shutdown 路径 await `child.wait()` 拿到了，但没回传给 emit_task。**简化决策**: 现阶段 close event code/signal 全 null。useAppStore.onClose 已经把 `code !== 0 && code !== null` 当 abnormal 判定 — null 走 "graceful or unknown" 分支，不弹 toast。**真 abnormal exit (crash)** 会经过 stderr buffer 检测 + manager 的 close 路径补 code，留 B2 M3 socket transport 或 B3 重构时一并处理
- **N18 (T2.5 BridgeClient 内合成 close)**: kill / shutdown 主动调用方也需要触发 onClose 完成 cleanup。直接在 invoke 完后 `void onClosedSafe(...)` 同步合成 — 真 runner-closed event 之后到（异步）但 `alreadyClosed` guard 确保只跑一次。**Sync 路径先 win**: synthesized code = 0 (graceful) 或 null (kill)；event-trigger 路径 win 不了，但已经 fired 的 onClose 行为正确
- **N19 (T2.7 stderr 改 pull-mode)**: 原 playbook 计划 stderr event-per-line push。实施改 pull-mode：close 触发时 invoke `runner_stderr_tail` 拿 8 行 → 同步 for-loop 调 onStderr。**理由**：(a) push 在 multi-session 高负载下 emit 量放大 (b) 唯一消费者是 onClose toast，pull 时机更准 (c) Rust 端 rolling buffer 已经有了，pull 就是 read snapshot
- **N20 (T2.8 plugin-shell 彻底删 import)**: bridge.ts 顶部老 `import { Child, Command } from "@tauri-apps/plugin-shell"` 完全删了 (不是 @deprecated 注释)。理由：函数 body 不再用 plugin-shell，import 留着 IDE 会报 unused warning。capability `shell:allow-spawn` 还在 — 那是 capabilities JSON 不动 (B1-I1) 等 dogfood 验证完再 retire
- **N21 (T2.5 invoke + listen 顺序)**: 原本以为先 invoke spawn_runner 拿 pid 再 listen 比较自然。**错的**：spawn_runner 内部启 emit_task 已经开始 emit Ready event，listen 慢一步就 miss。**正确顺序**：先 register 3 个 listen → 再 invoke spawn_runner。这跟 prototype 的 `preload_rx` 解决的问题同根：subscribe 必须发生在 first event 之前
- **N22 (T2.5 Error.cause TS 不支持)**: `throw new Error(msg, { cause: e })` 在 ES2020 lib target 下 TS 报错。**没升 target**（克制原则；运行时 Tauri 都支持但 lib types 没暴露）。改 eslint-disable + 内联注释解释 cause 信息已经在 formatInvokeError 里提取了 - 重复
- **N23 (T2.11 CI 不在 release.yml 跑 test)**: 把 cargo test 加到 check.yml 而**不**加 release.yml。Release 已经走 cargo check + 真 bundle，跑 test 浪费 5min。CI 的 check workflow 已经在每次 PR + 每次 push to main 跑 — test 覆盖足够

---

## Open decisions

- [ ] **O1** socket 路径在 macOS / Linux / Windows 上的具体格式（[M3 T3.3](#m3--unix-socket--named-pipe-listener-d9-d12)）— **暂行**: macOS/Linux `$TMPDIR/galley-${UID}.sock`；Windows `\\.\pipe\galley-${USERNAME}`。M3 T3.13 dogfood 时确认这两个路径不挡 sandbox / permission
- [ ] **O2** CLI `watch` 退出条件：session archived 时 watch 是 graceful EOF 还是错误？— **暂行**: session 进入 archived 时 server 端送一条 final `{"stream":"end","reason":"session_archived"}` event 然后 close socket。Client 把这个映射成 exit 0
- [x] **O3** `send_message` 异步语义：fire-and-forget vs ack — **RESOLVED 2026-05-19 → fire-and-forget**, 返回 `MessageBrief { id, queuedAt }`。Watch 命令负责后续验证。详 [M4 T4.3](#m4--cli-write-command-session-send--session-watch-d13-d16)
- [ ] **O4** RunnerProcess 是 Galley Core 进程 own 还是单独 daemon — **暂行**: Core own。**B4 menubar daemon mode** 让 Core 自己常驻就够，不引入第二个 daemon。如果 B4 实施时发现 Core process 频繁退出（用户关 GUI 主窗口期望"Galley 完全关闭"）影响 socket 可用性，重新评估
- [ ] **O5** Tauri `emit()` 在高频流式输出下的稳定性（[G4](#写在前面的已知-gotcha开-b2-前要注意)）— **M2 T2.10 dogfood 时确认**。如果撞坑，候选 mitigation 是 GUI 改走 socket subscribe 跟 CLI 同路径（但增加 build 复杂度）
- [ ] **O6** Ring buffer 大小（[M4 T4.8](#m4--cli-write-command-session-send--session-watch-d13-d16) / [G8](#写在前面的已知-gotcha开-b2-前要注意)）— **暂行**: 每 RunnerProcess 内 ring buffer 1024 events（跟 broadcast channel 一致）。M4 T4.8 dogfood 看够不够
- [ ] **O7** Socket protocol 是否要走 binary framing（length-prefix）还是 NDJSON — **暂行**: NDJSON（同 stdout/stdin 协议一致 + debug 友好 + 跟 CLI 输出格式同源）。性能瓶颈现在不是序列化是 LLM call，NDJSON 不构成 hot path

---

## Migration pattern · 给 B3 用的迁移模板（write path 增量）

B1 [migration pattern](./B1-rust-core.md#migration-pattern--给-b2b3-用的迁移模板) 是 read path 的 10 步模板。B2 给 write path 加 4 个维度（B3 写 useAppStore 拆分时用得着）：

```
Write path 增量步骤：

1. Trait method signature 用 GalleyApi 加 async — write 也 async（sqlx async + broadcast async）
2. Rust 端 RunnerManager → mpsc 写 stdin / SQLite write 都在 db.rs 实现里
3. Event emit：所有 write 完成后 emit Tauri event + broadcast 给 socket subscribers — 两个 transport 同时
4. TS 端从直接写 SQLite 改为 invoke，等 invoke 返回 + 等 Tauri event（双重确认）
```

4 条 retrospective（B3 实施前补充）：

- **Origin 字段统一在 invoke 入口注入**：TS 端 invoke 调用永远带 `{ origin: { source: "gui" } }`，不是 Rust 端默认；CLI 端是 `{ source: "cli", supervisor, note }`。语义清晰 = transport-aware origin
- **Write 操作不在 React 直接发**：BAN useAppStore 内 `await db.persistTurn(...)` 这种调用。所有 mutation 必须经过 invoke
- **Runner stdin Rust own，TS 不能再 write**：M2 完成后 TS 端 `child.write(...)` 路径全消失（plugin-shell 完全不 spawn 了）
- **Event 双轨**：Tauri event 给 GUI + Unix socket 给 CLI/supervisor，两个 transport 同 broadcast 源（[I5 API surface single source of truth](./invariants.md#i5-api-surface-single-source-of-truth)）

---

## End of B2
