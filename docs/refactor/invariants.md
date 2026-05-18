# Refactor Invariants · 跨 phase 硬规则

本目录跨多 phase / 多 session 的执行硬规则。任何 PR / sub-task 不能违反这些。**违反 = revert，无需讨论**。

跟 [CLAUDE.md 项目宪法](../../CLAUDE.md) 的区别：
- CLAUDE.md 宪法是 **产品 / 架构层** 的（"不改 GA / localhost only / CLI 是公开契约"）
- 本文件是 **重构执行层** 的（"老路径不删 / 每 task 跑测试 / migration 号段"）

## I1. 老路径并行，不预删

**Each sub-task 引入新路径时，老路径必须保留至少跨一个 sub-task 验证周期。**

具体规则：

- B1-B3 每次迁移一个 capability（如 list_sessions 从 TS 改 Rust）：**新路径写完 → dogfood + 测试验证 → 才允许删老 TS 路径**。两个动作不能在同一个 commit。
- 删老路径时 commit message 必须说明 "verified by: <test name> / <dogfood scenario>"
- 不允许"先删再补"，永远是"先补再删"

**为什么**：B 重构 10-12 周，预期会 regression。老路径作 safety net。dogfood 撞车直接切回老路径，不影响 ship。

**例外**：纯 rename / move 操作（如 T1.1 `git mv src-tauri → core`）不是迁移，是改名，老路径就是新路径。

## I2. 每 sub-task 完成 = typecheck + cargo check + 相关测试全过

**Sub-task 不允许"半完成"提交**。完成 = 以下三件全过：

```bash
# 前端
cd gui && pnpm typecheck && pnpm lint     # 0 error / 0 warning

# Rust
cd core && cargo check && cargo test      # 0 error / tests pass
cd cli && cargo check && cargo test       # 同上（如该 phase 已建 cli/）

# Python（若动到 runner/）
cd runner && python -m pytest             # 全过

# 该 sub-task 涉及的 capability 跑一次手动 dogfood scenario
```

**勾掉 checkbox 前必须全过**。半截状态用"in progress"游标记录，不勾 checkbox。

**为什么**：跨 session 接续时，下一个 session 假设 main 是 green。半绿状态会让新 session 误以为可以继续往下，结果 build 不过摸索半天。

## I3. SQLite migration 号段分配

v0.1 已用 migration 001-005。**v0.5 起从 006 开始递增，绝不跳号、不复用、不修改已 ship 的 migration**。

| 号段 | 用途 |
|---|---|
| 001-005 | v0.1 已 ship · 不动 |
| 006-009 | B1 阶段新增字段（`created_via` / `supervisor` / `origin_note`） |
| 010-019 | B2 阶段（如有） |
| 020-029 | B3 阶段（如有） |
| 030+ | B4 阶段（如有） |

**migration 写好后不准改**——dogfood 用户的 DB 已经跑过那个版本号了，改内容会让两侧 DB schema 漂移。要修 = 加新 migration 覆盖。

**为什么**：[Tauri identifier 不可随意改](../../CLAUDE.md) 的 corollary——同一 identifier 下数据目录连续，migration 历史也连续。

## I4. 目录重组 commit 只做 rename，不做逻辑改动

T1.1 / T1.2 / T1.3（src-tauri → core / desktop → gui / bridge → runner）每个**独立 commit**，commit message 严格 "rename only: src-tauri → core"。

**禁止**：
- 同 commit 内既改名又改代码逻辑
- 同 commit 内 mv 两个目录
- 同 commit 内 mv + 改 import path（import 改 path 是必须的，但 grouped 进同一个 rename commit 是 ok 的——但不要再加任何 logic 改动）

**为什么**：git log 上"rename only"是 git rename detection 能识别的，blame / history 不丢；混杂逻辑改动 git 看成 add+delete，blame 断。

## I5. API surface single source of truth

Rust 端 `GalleyApi` trait 是所有命令的 single source of truth。两个 transport（Tauri command + Unix socket）都 thin-wrap 这个 trait。

**禁止**：
- 只在 Tauri command handler 实现某个命令（CLI 拿不到）
- 只在 socket handler 实现某个命令（GUI 拿不到）
- 同一命令在两个 transport 走不同代码路径
- 在 transport 层做业务逻辑（必须在 trait 实现里）

**为什么**：[CLAUDE.md Galley 架构原则 #2 CLI 是公开契约](../../CLAUDE.md)——schema 必须漂移 0，唯一保证方式就是一处生成。

**例外**：transport 层可以做 transport-specific 转换（如 socket 需要 framing，Tauri event 需要 emit）——这不算业务逻辑，是 protocol adapter。

## I6. 前端永远 stateless presenter（B3+）

**B3 之后**，gui/ 不允许：
- 直接读 / 写 SQLite
- 直接 spawn / 管理 runner subprocess
- 持有"权威 state"（authoritative state — 即 "if React store says X, that's truth"）

gui/ 只允许：
- 通过 Tauri invoke 调 Rust trait（变更）
- 订阅 Tauri event（接收变更）
- 持有"展示 state"（selected session id、composer text、modal open state 等纯 UI 状态）

**判断 authoritative 还是 display**：如果别的 transport（CLI）做了同样动作，React store 还能保持原值，那就是 display；如果会冲突，那就是 authoritative，必须在 Rust 端。

**为什么**：[CLAUDE.md Galley 架构原则 #4 路径 B 不可逆](../../CLAUDE.md)——多 frontend 必须基于同一权威。

## I7. 性能 gate

prototype 验证给出 P1（first-token latency）+ P2（throughput）的基线数。

**B1/B2 完成时必须重测**，不能比 prototype 基线差。具体：

- P1: First-token latency from CLI invoke → first stream token reaches subscriber
  - prototype 实测后填入基线
  - B1 完成时再测，**不能 >50ms 慢于** prototype 基线
  - B2 完成时同上
- P2: Streaming throughput (events/sec for 100+ token response)
  - 同上，**不能 >10% 慢于** prototype 基线

**违反 = 撤回该 phase 的最后一个 commit，重新设计**。

**为什么**：B 重构不只是为了架构干净，也是为了"不变差"。如果迁完反而慢了 / 卡了，dogfood 体验破坏，整个 refactor 价值受损。

## I8. dogfood 期间老 .app 必须留着

JC 在重构期间用 v0.2 的 .app 作 daily driver。**JC 的本地 v0.2 .app 不允许卸载，直到 v0.5 ship 前一周 final dogfood**。

实操：
- v0.2 ship 后，将 .app 单独 copy 到 `~/Applications/Galley-v0.2.app`（重命名避免被覆盖）
- 重构期间 `pnpm tauri dev` 跑的是新代码，**不替换** `/Applications/Galley.app`
- 直到 v0.5 RC 阶段，dogfood 满意了，才装新 .app 替换老的

**为什么**：B 重构期间 main 会经历"撕开 → 半行半瘫 → 再合上"，作 daily driver 不稳。

## I9. v0.1 ship 后的数据格式不动

v0.1 / v0.2 用户的 SQLite schema、prefs 格式、文件位置 ship 之后是 contract。

**不允许**：
- 删除已 ship 的 column（即使 v0.5 用不到了）
- 改已 ship column 的语义（type / nullable / default）
- 把数据搬到新目录（除非走完整 migration 流程）

**允许**：
- 加新 column（additive，default 兼容老）
- 加新表
- 加新 prefs key

**为什么**：用户 dogfood 期间累积的真实数据是宝贵的，丢一次永远失去信任。

## I10. running notes append-only

每个 phase playbook 底部 "Running notes / gotchas" section 是 **append-only**。

- 发现新 gotcha → 追加一行（带日期）
- 旧的判断错了 → **不删旧行，追加新行说明"被 2026-XX-XX update X 推翻"**
- 临时决策 → 追加"暂行决定：X，TODO 后续确认"

**为什么**：跨 session continuity 靠的就是这个 log。删除等于丢失上下文。新 session 读到看似过时的内容会主动追问 / 验证，这是 feature 不是 bug。

## I11. Cargo `panic = "unwind"` 必须保留

**`core/Cargo.toml` 的 dev + release profile 不允许设 `panic = "abort"`**。Cargo 默认是 `panic = "unwind"`——保持默认即可，但任何 PR 显式加 `[profile.*] panic = "abort"` 拒绝。

**为什么**：

Galley 主进程持有 N 个 Python bridge `tokio::process::Child` 句柄，每个以 `kill_on_drop(true)` 创建。主线程任何 panic 触发 Drop 链 → `kill_on_drop` 同步 SIGKILL bridge child → 进程退出时没 orphan。这套**完全依赖 Rust 默认的 unwind 行为**：

- `panic = "unwind"`（默认）：unwind 走 Drop 链，所有局部变量的析构跑完 → bridge children 干净回收
- `panic = "abort"`：进程立刻调 `abort()`，Drop **不跑** → bridge children orphan（reparented to init），用户 ps 里能看到死掉 Galley 之后还活着的 bridges

prototype L5 通过的前提就是 unwind 路径。如果有人为减小 binary size（abort 路径不需要 unwind tables，能省 ~5% binary size）加 `panic = "abort"`，L5 即时 fail，所有 alive bridges 在 panic 后 orphan。

**例外**：测试 binary（如 `[[bin]] required-features = ["experiments"]` 的实验代码）可以单独覆盖；但生产 desktop 主入口 + B1+ 的 core/ crate 必须保持 unwind。

**历史**：2026-05-18 bridge-owner prototype session 1 L5 验证后引入。详 [prototype-go-for-b1 devlog](../devlog/2026-05-18-prototype-go-for-b1.md) §D5。

---

## 如何引用本文件

playbook 的 sub-task 描述里直接引用："验证 invariant I2"、"按 I3 分配 migration 号"。Code review / PR description 同理。

新 session 启动时，至少**扫一遍 invariant 标题**（10 秒事），有歧义再展开看具体规则。
