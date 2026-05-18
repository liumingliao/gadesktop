# Release workflow

Galley 发版 SOP。本文档定义 v0.2 起的正式发版流程，配合 `.github/workflows/release.yml` 工作。

> **相关文档**
> - 工作流文件: [`.github/workflows/release.yml`](../.github/workflows/release.yml) (tag 触发发版) / [`.github/workflows/check.yml`](../.github/workflows/check.yml) (PR 时三平台 build 验证)
> - Win 手动 build 指南: [`docs/windows-build-checklist.md`](./windows-build-checklist.md) — 当 CI 不可用、需要本地出一份 .exe 时参考

## 总览

```
开发：本地 pnpm tauri dev (dogfood)
       ↓
版本号 bump (tauri.conf.json + package.json)
       ↓
git commit + git tag v0.2.0 + git push origin main v0.2.0
       ↓
GitHub Actions release.yml 自动触发
       │
       ├─ macos-15 (arm64 runner, native) → Galley_0.2.0_macOS_aarch64.dmg
       ├─ macos-15 (arm64 runner, cross)  → Galley_0.2.0_macOS_x64.dmg   ← v0.1.2 起 CI 出，cross-compile + Rosetta 2
       └─ windows-latest                  → Galley_0.2.0_Windows_x64-setup.exe
       ↓
ubuntu-latest 收集产物 + gh release create --draft
       ↓
手动 review: GitHub Release 页面看 draft、edit 加亮 notes、本地下载 smoke test
       ↓
点 publish → 用户可见 + 可下载
```

构建时间预估：每个 platform job 4-7 min（缓存命中后），三个并行。全流程 push tag 到 draft release ready 大约 **10-12 min**。

**Mac Intel CI 路径**（v0.1.2 起）：macos-15 arm64 runner + cross-compile + Rosetta 2，详细 trial 验证见 [trial run 26016317898](https://github.com/wangjc683/galley/actions/runs/26016317898)。Rosetta 装载 ~3min，cross-compile 跟 native build 相比多约 2-3min。比保 GitHub macos-13 deprecated runner 更长寿（macos-13 在 2026-27 deprecation 路径上）。本地 build 路径仍然是兜底（CI 不可用 / 紧急 hotfix 时走 [Manual fallback](#manual-fallback-ci-stalled-or-skipped) 方案 B）。

## 版本号策略

Semver 0.x.y，pre-1.0 阶段：

| 例子 | 含义 | 触发场景 |
|---|---|---|
| `v0.2.0` | 增功能 release | 新 feature ship (e.g. Win 支持上线) |
| `v0.2.1` | 补丁 release | 单点 bug fix (e.g. Win toggleMaximize 不灵) |
| `v0.2.0-rc.1` | 预发版 candidate | Win 机 smoke test 前的内部验证版 |
| `v1.0.0` | 第一个稳定版 | 用户量起来 + 自动更新就绪 + 关键功能稳定 |

预发版 tag 包含 `-`，CI 自动 mark prerelease，GitHub Release 列表不会把它推作「latest」给普通用户。

## 发版前 Pre-flight 清单

每次正式 release 前过一遍：

### 1. 代码完备

- [ ] `main` 分支 CI 全绿（`check.yml` 三平台通过）
- [ ] 本地 `pnpm typecheck` / `pnpm lint` / `cargo check` 干净
- [ ] 本地 `pnpm tauri dev` smoke 跑通核心流程（新对话 / multi-step / 审批 / 切 LLM）
- [ ] 如果包含 GA baseline 升级：[baseline upgrade workflow](../CLAUDE.md#baseline-upgrade-workflow) 走完、devlog 写好

### 2. 文档完备

- [ ] 本次 release 有对应 devlog（`docs/devlog/YYYY-MM-DD-*.md`），叙事完整 + 6 段
- [ ] CLAUDE.md 阶段表更新到当前
- [ ] PRD / DESIGN.md 如有变化已同步
- [ ] 上一次 release 以来的 commits 简要回顾一遍，对应到 release notes 草稿

### 3. 版本号 bump

把版本号同步改两处：

```bash
# gui/package.json
"version": "0.2.0"

# core/tauri.conf.json
"version": "0.2.0"

# core/Cargo.toml (如果显式声明了 version，目前 = 0.1.0 跟其它解耦)
# v0.2 是否同步 Cargo.toml 看具体情况：Cargo.toml 的 version 是 lib name，
# 不直接影响 bundle 文件名（那个由 tauri.conf.json + package.json 决定）。
# 建议同步以免日后查问题困惑。
```

提交一个独立 commit：`Bump version v0.2.0`。**不要**跟功能 commit 混在一起——回滚版本号方便。

### 4. 跑预发版

正式 tag 之前先打一个 RC：

```bash
git tag v0.2.0-rc.1
git push origin v0.2.0-rc.1
```

CI 跑完产生 3 份预发版产物（GitHub Release 上标 Prerelease）。下载 + 装 + 跑核心流程。RC 没问题再打正式 tag。

> 如果是纯 bugfix（`v0.2.1`）改动很小且回归测试过了，可以跳 RC 直接打正式 tag。

## 正式发版步骤

### Step 1. 打 tag 并推

```bash
git tag v0.2.0
git push origin main v0.2.0
```

> 推 main + tag 一起，避免 tag 引用了未推送的 commit 导致 CI fetch 失败。

### Step 2. 等 CI（~15-20 min）

打开 https://github.com/wangjc683/galley/actions 看进度。三个 build job 并行。`release` job 等三个全过才跑。

CI 完成时：GitHub 顶部红圈通知 + 邮件提醒（默认订阅）。

### Step 3. Review draft release

进 https://github.com/wangjc683/galley/releases 看到一个 draft `Galley v0.2.0`：

- **产物列表**：确认 CI 出 3 个文件
  - `Galley_0.2.0_macOS_aarch64.dmg`
  - `Galley_0.2.0_macOS_x64.dmg`
  - `Galley_0.2.0_Windows_x64-setup.exe`
- **Auto-generated notes**：GitHub 根据 tag 间的 commit 自动列出来。点 **Edit** 按下面模板加工：

```markdown
## What's new
- 高亮 1-3 件用户视角能感知的核心变化（不是 commit 列表）
- 用 user-facing 语言：「Windows 版本上线」而不是「Y plan custom chrome implemented」

## Improvements
- 列出小改进（UX 打磨、性能、bug fix）

## Known issues
- 已知未修的问题 + workaround
- 比如：「Win 11 用户：Snap Layouts hover 选择器暂未支持，请用 Win+Arrow 替代」

## Installation
- **macOS Apple Silicon (M1+)**: 下 `aarch64.dmg`
- **macOS Intel**: 下 `x64.dmg`
- **Windows 10/11**: 下 `x64-setup.exe`，运行安装

首次启动 macOS 会因为没签名提示风险 → 右键 → 打开。Win 类似 → SmartScreen 警告 → 更多信息 → 仍要运行。

## Upstream
GA baseline: `<commit-hash>` (e.g. 6bb3104)

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

底部 GitHub 自动加的 commit list 保留作为详细变更记录。

### Step 4. Smoke test 三份产物

把 CI 出的 2 个文件（+ 可选的本地 build Intel 包）下载到本地，按下表跑核心流程：

| 平台 | 装法 | smoke 路径 |
|---|---|---|
| Mac arm64 | 右键 → 打开 `.dmg` → 拖进 Applications | 跑新对话 / 切 LLM / 触发一次审批 |
| Mac x64 (Intel) | 本地 build（不在 CI matrix）；JC 自用机器，按需 smoke | 同上 |
| Win x64 | 双击 `-setup.exe` 装 | 按 [windows-build-checklist.md §4](./windows-build-checklist.md#4--smoke-test-checklist) 25 项 |

任何 smoke 项失败：**不要 publish**，先 `git tag -d v0.2.0 && git push origin :v0.2.0` 删 tag、修 bug、bump 到 `v0.2.1`（或推 `v0.2.0-rc.2` 重新预发）。

### Step 5. Publish

Release 页面右上角 → **Publish release**。一秒钟从 draft 变公开。

GitHub 自动：
- 发邮件给 watchers
- 在 repo 顶部 banner 显示「New release」
- Release atom feed 更新

**关于 "Latest" 标记**（如果想让 repo 主页右侧 sidebar widget 显示该 release）：

GitHub API 不允许 prerelease 标 Latest（实测 422 Validation Failed "Latest release cannot be draft or prerelease"）。所以发完 prerelease 后 sidebar widget 会显示 "X tags · Create a new release" 看起来像空的。

**两个选择：**

a) **接受 sidebar 空**：所有 release 保留 prerelease flag，主页 sidebar 不 promote。用户必须点 "Releases" 链接看才知道有。dogfood/internal 阶段可接受。

b) **摘 prerelease flag + 标 Latest**：选信心最高的 release：
   ```bash
   gh release edit vX.Y.Z-rc.N --prerelease=false --latest
   ```
   失去 GitHub 灰色 "Pre-release" badge，但 sidebar 现出且能下。title 文字（如 "macOS (Release Candidate)"）+ notes 内部说明仍然传达 tier。
   今天 v0.1 用了 b（详 [2026-05-15 v0.1 ship devlog](./devlog/2026-05-15-v0.1-ship-and-ci-fallback.md#d3-github-不允许-prerelease-标-latestmac-rc-摘掉-prerelease-flag)）。

### Step 6. 后续

- [ ] 用户群 / Twitter / 朋友圈 / 微博发版通告（人工）
- [ ] 监控 [GitHub Issues](https://github.com/wangjc683/galley/issues) 头 24h，回 bug report
- [ ] 如果 24h 内发现 critical bug：走 hotfix 流程（下方）

## Hotfix 流程

发版后头 48h 内发现严重 bug：

1. `git checkout -b hotfix/v0.2.1` 从 `v0.2.0` tag 开（不要从 main，main 可能已有未发版的 commit）
2. 修 bug、加测试
3. bump 到 `v0.2.1`
4. Merge back to main + tag + push
5. 走正常发版流程，但 RC 可跳过（影响小、改动小）

## Dry-run · 不打 tag 验证 CI 健康

如果想验证「release.yml 本身能正确跑完三平台 build」而不想真发版（不留 tag、不创建 draft Release），用 GitHub Actions 的 **manual dispatch**：

1. 打开 https://github.com/wangjc683/galley/actions/workflows/release.yml
2. 右上角点 **Run workflow** → 选 `Branch: main` → 点绿色 **Run workflow** 按钮
3. CI 会触发完整 build matrix（三平台并行 build）
4. **release job 自动跳过**（`if: startsWith(github.ref, 'refs/tags/v')` 守门）—— 不创建 Release、不上传到任何 Release
5. 三个 build job 都绿 = CI 工作流健康
6. Artifacts 在 run 详情页右侧可下载（保留 90 天），想本地装一下 smoke test 也行

适用场景：
- CI 配置改动后想验证还能跑（比如调整 matrix / 升级 actions 版本）
- 怀疑某个平台 break 了但不想等下次真发版才发现
- 给 PR contributor 看「你的改动确实能在三个 OS build」

不会产生：tag 污染 git 历史、draft Release 占 Releases 页。

## 预发版（RC）流程

跟正式发版几乎一样，区别：

- tag 包含 `-`（如 `v0.2.0-rc.1`、`v0.2.0-rc.2`）
- CI 自动 mark prerelease，GitHub Release 不推作 latest
- Release notes 标 **RC** 字样
- 不发用户群通告，只内部 dogfood

## Tiered release strategy

不同平台 / 测试覆盖差距大时，**拆成多个独立 release**，每个标自己的 quality tier。今天 v0.1 用过：

- macOS RC（作者本地 smoke 完整跑过）→ `v0.1.0-rc.1`
- Windows Alpha（作者无 Win 机器，社区 dogfood）→ `v0.1.0-alpha.1`

详 [2026-05-15 v0.1 ship devlog §D1](./devlog/2026-05-15-v0.1-ship-and-ci-fallback.md#d1-tiered-releasemacos-rc--windows-alpha-分两个-release)。

### 为什么不塞同一个 release

把不同 tier 的 artifact 塞一个 release，notes 里说明 tier 差异——用户容易忽略 notes 直接下载，下到 Alpha 质量当 RC 用。**两个 release 视觉上 hard separation 更清楚**：Release 列表上用户看 "macOS RC (Latest)" + "Windows Alpha (Pre-release)" 两条，一眼就懂。

### 何时用 tiered

- 平台 smoke 覆盖差距大（如今天 Mac 测过 + Win 没测过）
- 功能 readiness 差距大（如 Mac 完整 + Win 有 known feature gap）
- 用户群差距大（如已有 Mac 用户 + Win 是新平台）

### Tag 命名

Semver 兼容的 prerelease 后缀，按信心从高到低排：

| 后缀 | 含义 |
|---|---|
| `vX.Y.Z` | final / stable |
| `vX.Y.Z-rc.N` | Release Candidate |
| `vX.Y.Z-beta.N` | Beta |
| `vX.Y.Z-alpha.N` | Alpha |

Tiered release 不同平台用不同后缀，**但版本号 base 应该一致**（都是 `vX.Y.Z`），便于追溯同一代码线。

### Latest 标记 + cross-link

参考 [Step 5 Publish "Latest" 标记](#step-5-publish) 摘 prerelease flag + 标 Latest。Tiered release 之间 release notes 互相 link：

```markdown
跟 [macOS RC v0.1.0-rc.1](https://.../tag/v0.1.0-rc.1) 同代码 → 理论同功能
```

让用户知道还有其它平台的 release。

## Manual fallback：CI stalled or skipped

CI 出 build 不可用时，手动 fallback 路径。

### 触发条件

按优先级：

1. ⏳ macos-13 Intel runner **queue > 30 min** → fallback（详 [CI 故障排查](#symptom-macos-13-runner-排不到)）
2. ❌ 单平台 build 失败但其它平台 OK → fallback（用 success 平台 artifact + 失败平台留待修）
3. 🚫 完全不想跑 CI（已经本地 build + 信心高 + 紧急）→ fallback

### 完整命令序列

```bash
# 1. 取消卡住或不要的 CI run
gh run list --workflow=release.yml --limit 3   # 找 run ID
gh run cancel <run-id>

# 2a. 已 success 的 CI artifact 下载到本地
gh run download <run-id> -n galley-macos-15-aarch64   # 出 Galley_X.Y.Z_macOS_aarch64.dmg
gh run download <run-id> -n galley-windows-latest-x64 # 出 Galley_X.Y.Z_Windows_x64-setup.exe

# 2b. 本地 build 兜 self-arch（Mac x64 / aarch64）— 别忘了重命名
cd gui && pnpm tauri build --target x86_64-apple-darwin
../scripts/rename-artifact.sh x86_64-apple-darwin
# 产物：core/target/x86_64-apple-darwin/release/bundle/dmg/Galley_X.Y.Z_macOS_x64.dmg

# 3. 起草 release notes 到 /tmp/galley-<tag>-notes.md
# 模板见 "Announcement templates" 一节

# 4. 创建 draft release（不直接 publish，留给你 review）
gh release create vX.Y.Z-rc.N \
  --draft --prerelease \
  --title "Galley vX.Y.Z-rc.N · macOS (Release Candidate)" \
  --notes-file /tmp/galley-rc-notes.md \
  Galley_X.Y.Z_macOS_aarch64.dmg \
  Galley_X.Y.Z_macOS_x64.dmg

# 5. 上 GitHub UI 看 draft（Markdown 渲染 / files / metadata）

# 6. publish
gh release edit vX.Y.Z-rc.N --draft=false

# 7. 想标 Latest（必须先去 prerelease flag）
gh release edit vX.Y.Z-rc.N --prerelease=false --latest
```

### 关键注意

- **不要忘 `--prerelease` flag** in step 4 —— 第一次出 RC/Alpha release 应该是 prerelease。Tier 等级靠 title + notes 表达，prerelease flag 是 GitHub 层标记
- **本地 build 产物文件名跟 CI 产物一致**（`Galley_X.Y.Z_<arch>.<ext>`），命名一致用户不困惑
- **手动 fallback 的 CI 跑废没关系**——`release.yml` 的 `release` job 始终因 `needs: build` 等不到失败 / 卡住的 build，不会自动创建 Release，不冲突
- **Tag 已 push 但 release 没出？** Tag 已经在 origin → `gh release create <tag>` 直接用现有 tag，不需要 `--target` flag

## CI 故障排查

### Symptom: macos-13 runner 排不到

GitHub Actions 偶发某些 runner 排队。等 5-10 min 通常自然解决。

**持续超过 30 min**：

1. 去 https://www.githubstatus.com 看 Actions 状态——如果整体故障，等
2. 如果只是 macos-13 排队 → **切到 manual fallback**（详 [Manual fallback section](#manual-fallbackci-stalled-or-skipped)）
   - 取消卡住的 run
   - 用其他平台已 build 的 artifact + 本地 `pnpm tauri build` 兜
   - `gh release create` 手动出 release
3. 本质问题：macos-13 是 deprecated runner（[Intel runner deprecation 应对](#intel-runner-deprecation-应对)），长期不可靠

今天 v0.1 release（2026-05-15）就这么走的——详 [2026-05-15 v0.1 ship devlog](./devlog/2026-05-15-v0.1-ship-and-ci-fallback.md)。

### Symptom: cargo check 在 Win 上挂 linker error

通常是 Rust + MSVC 版本组合问题。check `dtolnay/rust-toolchain@stable` 是不是用了不兼容版本。临时 workaround：pin Rust 版本（如 `dtolnay/rust-toolchain@1.78`）。

### Symptom: pnpm 报 lockfile mismatch

`pnpm install --frozen-lockfile` 严格 lockfile 模式。如果近期改了 dependencies 但忘提交 `pnpm-lock.yaml`，CI 就挂。本地跑一次 `pnpm install` 再提交锁文件。

### Symptom: tauri build 在 Win 报 NSIS 缺资源

`bundle.windows.nsis.installerIcon` 路径错。检查 `core/tauri.conf.json` 的 icon 配置。

### Symptom: 产物 artifact 上传后 `release` job 找不到

`actions/download-artifact@v4` 的 `merge-multiple: true` 把所有 artifact 平铺到 `artifacts/` 下。如果 `softprops/action-gh-release@v2` 的 `files: artifacts/**/*` 没匹配到任何文件，说明 build job 的 `path` glob 不对。看 release job 的 `List artifacts` 步输出。

## Intel runner deprecation 应对

`macos-13` runner GitHub 已经标 deprecated（具体下线日期 GitHub 没公告，估计 2026 年底-2027 年）。**v0.1.0-alpha.2 起 Galley 已经从 CI matrix 撤掉 macos-13**——比 GitHub 强制下线提前走。

历史走过的兜底路径（按时间序）：

- **v0.1.0-alpha.2 / v0.1.1-alpha.1**: 方案 B —— JC 本地 Intel Mac build + `gh release upload` 手挂
- **v0.1.2 起**: 方案 C —— macos-15 arm64 runner cross-compile x86_64 + Rosetta 2 装载，全 CI 自动出。trial 验证 2026-05-18 [run 26016317898](https://github.com/wangjc683/galley/actions/runs/26016317898) 通过，merge 到 main 作为默认 CI 行为

### 方案 C（当前主力，v0.1.2 起）

`release.yml` matrix 第二行：

```yaml
- platform: macos-15
  target: x86_64-apple-darwin
  arch: x64
  bundle_dir: dmg
  bundle_glob: "*.dmg"
```

加 conditional Rosetta install step（`if: matrix.target == 'x86_64-apple-darwin'`）：

```yaml
- name: Install Rosetta 2 (x86_64 cross-compile on arm64 host)
  if: matrix.target == 'x86_64-apple-darwin'
  run: softwareupdate --install-rosetta --agree-to-license
```

`bundle-python.sh mac-x64` 下 x86_64 PBS Python tarball，在 arm64 host 上通过 Rosetta 2 跑 `pip install` 装 GA deps。`pnpm tauri build --target x86_64-apple-darwin` Rust cross-compile 出 Mac Intel binary。`hdiutil` 自动出 x86_64 .dmg。

Trial 实测 binary arch：
```
Galley.app/Contents/MacOS/desktop:                Mach-O x86_64 ✓
Galley.app/Contents/Resources/python/bin/python3.11:  Mach-O x86_64 ✓
```

耗时：~7min vs arm64 native ~4min（Rosetta install +~3min，cross-compile +~0min on cached Rust target）。

### 方案 B（v0.1.2 起仅作兜底）

CI stalled / 紧急 hotfix / Rosetta 装载在某次 runner image update 后失败时，仍可本地 build:

- JC 在 Intel Mac 上 `pnpm tauri build --target x86_64-apple-darwin`
- `scripts/rename-artifact.sh x86_64-apple-darwin` 插 `macOS` slug
- `gh release upload v<X.Y.Z> Galley_<X.Y.Z>_macOS_x64.dmg` 挂到 same Release

### 方案 A（drop Intel Mac 支持）

不再考虑——方案 C 跑通后 Intel CI 维护成本可控；Galley 早期用户里 Intel Mac 占比仍可观。

历史记忆：2026-05-15 alpha.2 起为方案 B，2026-05-18 v0.1.1-alpha.1 ship 后验证 + merge 方案 C 成主力。

## Announcement templates

发版同时通常要发通告。每次内容不同，但结构可复用。**这一节是模板，不是文案本身**——具体每次复制改填，发布完通告写到 `/tmp/galley-announce-{zh,en}.md` 用一次就丢，**不入库**。

### 中文（GA 群 / 微信 / 飞书）

```markdown
🚢 Galley vX.Y 版本上线了

[一两句 product positioning / why care]

[✅ feature 5-7 个，emoji 视觉锚点]

📌 [non-invasive 一句话或核心承诺]

[多 release tier 时分块列出，否则一段]

🍎 macOS (tier 阶段，[guarantor])
👉 [URL]

🪟 Windows (tier 阶段，[guarantor])
👉 [URL]

📦 GitHub：[repo URL]
🐛 反馈：Issues 或本群

⚠️ [安装注意事项 / unsigned 绕过 / SmartScreen 等]

[下一步路线图一句话，链 PRD]
```

### 英文短版（Twitter / X · ≤ 280 chars）

```markdown
🚢 Galley vX.Y just shipped — [one-line product positioning].

[3-5 features in commas, no list]

[brand attributes: e.g., Local-first. Non-invasive.]

[next milestone hook]

→ [repo URL]
```

### 英文长版（Hacker News / Reddit / blog post lead）

```markdown
**Galley vX.Y: [longer positioning]**

[2-3 sentences context — what is it, who is it for]

Today's vX.Y ships:
- Feature 1
- Feature 2
- ...

[Non-invasive / differentiator paragraph]

**Where this is going (next major)**: [roadmap hook]

**[Special characteristic, e.g., Local-first]**: [explanation]

**Today's releases:**
- macOS [tier]: [URL] ([smoke status])
- Windows [tier]: [URL] ([smoke status])

**Built on**: [tech stack]. Code: [repo URL]

[Additional docs links]
```

### 必备字段

每个通告（无论语言 / 长度）必须有：

- 版本号 + tier（RC / Alpha / Final）
- Download URLs（per platform release）
- Repo URL
- 反馈 channel（Issues / 用户群）
- 安装 caveat（unsigned app 处理）

### 不要做的

- ❌ 不要把通告 commit 到仓库——每次内容不同，模板才可复用
- ❌ 不要在通告里承诺没在 PRD 上 publish 的路线图（已 publish 的路线图复述可以）
- ❌ 不要省 "unsigned" 安装绕过说明——用户首次启动碰到 Gatekeeper / SmartScreen 卡死不会自己想到

## 未来工作 (v0.6+)

### 代码签名

为了消除用户首次启动的「未签名警告」：

**Mac (Apple Developer Program $99/年)**:
- 申请 Developer ID Application certificate
- CI 加 secret: `APPLE_CERTIFICATE` (.p12 base64) + `APPLE_CERTIFICATE_PASSWORD` + `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`
- 在 `release.yml` 加 codesign + notarize 步
- 工时 ~2-3 h 一次性 + $99/年

**Windows (代码签名证书 $200-400/年)**:
- 从 SSL.com / Sectigo 买证书
- CI 加 secret: signing cert + password
- 在 `release.yml` 加 signtool 步
- 工时 ~1-2 h 一次性 + 年费

**判断节点**：dogfood 群体之外有真用户量时才投入。

### 自动更新 (`tauri-plugin-updater`)

签名搞定后启用：用户开 app 时自动检查新版本，提示一键升级。需要：

- Tauri signing key pair (`TAURI_SIGNING_PRIVATE_KEY` + 公钥嵌 app)
- `latest.json` 文件托管在 GitHub Pages / S3
- CI 加生成 + 上传 `latest.json` 步

工时 ~4-6 h 一次性。属 v0.6+ scope。

### Linux 构建

`ubuntu-latest` runner + AppImage / deb 打包。低优先级，等真有 Linux 用户问。
