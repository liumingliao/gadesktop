# 2026-05-15 · Release CI · Mac menubar · icon 4 轮迭代 · README screenshots

**Date**: 2026-05-15（接 [上午的 Y plan + A items devlog](./2026-05-15-win-prep-y-plan-custom-chrome.md) 之后的下午-晚间）
**Status**: 代码层全部完成。Win 机 smoke (Y6) + 真 release dry-run + README 整合留下次 session。
**Related**:
- [docs/release-workflow.md](../release-workflow.md)（新建）
- [.github/workflows/release.yml](../../.github/workflows/release.yml) + [check.yml](../../.github/workflows/check.yml)（新建）
- [docs/screenshots/](../screenshots/)（6 张 README hero）
- 14 个 commit：`efadfbf` → `1a40555` → `54a79e5` → `28cc7e3` → `9b927d0` → `19ffe8d` → `b1423f2` → `951f36d` → `a18d145` → `be7c723` → `ffe6d83`

## Context

上午 Y plan + A items 落地后，Stage 3.8 prep work 看似齐了，但**发版能力**还没真正 ready：没有 CI 工作流、没有 Mac menubar 让 app 像 Mac 原生应用、icon 还是 Tauri 默认占位。整个下午-晚间把这些一次性补齐，外加为 README 拍 6 张 hero screenshots。

期间因为 cfg-gated Win-only 代码 Mac 本地 cargo check 抓不到，被 CI **抓到 3 个 Win-only bug**——一次性把 CI 投入的价值实证清楚。

## Decisions

### 1 · 发版工作流走 tag push + workflow_dispatch 双触发

- **tag-driven**（`on: push: tags: ['v*']`）：用户打正式 / 预发版 tag 走完整流程
- **workflow_dispatch**：手动 Actions UI 触发，**跳过 GitHub Release 创建**（`if: startsWith(github.ref, 'refs/tags/v')` 守门 release job）。dry-run 用，不污染 git tags / Releases 页
- **3 平台 matrix**：macos-14 (Apple Silicon) / macos-13 (Intel) / windows-latest（JC 选 split Mac 而非 universal binary）
- **Pre-build gates**：每个 platform job 在 bundle 前跑 `pnpm typecheck` + `pnpm lint` + `cargo check`，任何一项挂掉直接 fail
- **PR-time `check.yml`**：每个 PR + main push 跑同样三平台 typecheck/lint/cargo check（不 build artifact），catch OS-conditional 回归

### 2 · 版本号策略 semver pre-1.0

| pattern | 含义 |
|---|---|
| `v0.x.0` | minor / feature release |
| `v0.x.y` | patch / bugfix |
| `v0.x.0-rc.N` | 预发版（CI 自动 mark prerelease via `contains -`） |
| `v1.0.0` | 第一个稳定版（用户量起来再说） |

### 3 · Mac menubar 全套，灰禁占位 V0.2 wiring 项

```
Galley   About (native dialog w/ icon+version+links) / Settings ⌘, /
         Hide / Hide Others / Show All / Quit
File     New Chat ⌘N / Close Window
Edit     Undo/Redo/Cut/Copy/Paste/SelectAll / Find ⌘F (disabled)
View     Toggle Sidebar ⌘\ (disabled) / Conversation Width > Compact|Wide
Window   Minimize / Zoom / Bring All to Front
Help     Galley on GitHub / Report a Bug
```

- About 用 Tauri `PredefinedMenuItem::about` 弹原生 dialog（不是 in-app Settings → About）—— 利用我们的新 icon + version metadata，跟 macOS 惯例对齐
- Find + Toggle Sidebar 灰禁但显示 accelerator——给「V0.2 会有」的可发现信号
- 外部链接（GitHub / Issues）服务器侧通过 `tauri-plugin-opener` 直接打开，**不走 JS round-trip**
- 没有 double-fire：AppKit 在 webview 之前 consume accelerator，JS keydown 不会重复触发

### 4 · App icon 4 轮迭代 → 最终 JC 手调

| 版本 | 内容 | 结果 |
|---|---|---|
| v1 (AI 生成) | 木质活字盘 + 黑色字块 + 杏色绳子 + 黄铜角 | 杏色太暗、内格栅栏复杂、小尺寸糊 |
| v2 (AI 生成 + 优化 prompt) | 木盘清空 + 大杏色 G on cream 字块 + 黄铜简化 | 视觉好，但 Dock 里显得比其他 app 大 + 没 squircle 外形 |
| v3 (Python squircle mask + safe area) | v2 基础上做 alpha mask + 80% canvas + 10% 透明 padding | 仍不满意，木盘硬角跟 squircle 外形冲突 |
| v4 (JC 自己手调) | 1024×1024 RGBA，squircle 外形 + 832/1024 安全区，烤进 alpha | ✅ ship |

**关键发现 · macOS Big Sur+ 不自动 mask 第三方 icon**：得设计者自己把 squircle 形状烤进 alpha 通道。这个跟我直觉相反的规则被 Dock 实测打脸两次后才确认。

### 5 · CI 实测抓到 3 个 Win-only bug

CI 本身的回报：

| Bug | 表现 | 修法 |
|---|---|---|
| pnpm version 不指定 | macos-14 + windows 都挂在 "No pnpm version specified" | `pnpm/action-setup@v4` 加 `with: version: 10`（默认从 `packageManager` 字段找 `./package.json` 找不到我们的 `desktop/package.json`） |
| `core:window:allow-internal-on-resized` 不是真权限名 | Win cargo check fail，但 Mac 因为 `platforms: ["windows"]` 不验证看不到 | 删掉两个虚构权限，event listening 走 `core:event:default`（已在 `core:default` 里） |
| `window_shadows_v2::set_shadow` 函数名错 | Win cargo: "no `set_shadow` in the root, similar name exists: `set_shadows`" | Typo fix |
| `set_shadows(&window, true).expect(...)` 类型错 | Win cargo: 函数签名是 `set_shadows(&mut App, bool) -> ()` 不是 `(&Window, bool) -> Result` | 改为 `set_shadows(_app, true);`，drop `.expect()` |

**通用教训**：`#[cfg(target_os = "windows")]` 包起来的代码 Mac 本地 `cargo check` 永远剔除，写 Win-only 代码必须靠 CI 才能 catch。开发流程上：每次改 Win 代码 push 前心理预算 1-2 轮 CI bounce。

### 6 · Screenshot 临时 mock 用代码 patch，不污染 SQLite

JC 真实 SQLite 已有大量 session 历史，初始 `DEMO_SESSIONS` 在 `hydrateFromDB` 后立刻被覆盖。两个改动：

- `desktop/src/stores/demo.ts` 重写 `DEMO_SESSIONS` / `buildDemoTurns` / `buildDemoPending` 为 README showcase 故事（6 session sidebar + 4 step transcript + 杏色 G 终页 final answer）
- `desktop/src/stores/useAppStore.ts` 的 `hydrateFromDB` 把 `set({ sessions })` 改为 `set({ sessions: DEMO_SESSIONS })` —— 内存覆盖，不 touch SQLite

JC 截完 6 张图后 `git checkout HEAD -- desktop/src/stores/demo.ts desktop/src/stores/useAppStore.ts` 一键 revert。screenshots 落 `docs/screenshots/screenshot_0[1-6].png`。

### 7 · SSH remote 替代 OAuth PAT workflow scope

push 包含 `.github/workflows/` 文件时，Claude Code 默认 HTTPS + OAuth token 缺 `workflow` scope，被 GitHub 拒。改 remote 到 `git@github.com:wangjc683/galley.git`，配 `~/.ssh/config` + `id_rsa.pem`，所有后续 push 走 SSH，没有 scope 限制。

JC 的 zsh 里有个 `_kaku_wrapped_ssh` 函数劫持 `ssh` 命令——影响 interactive shell 直接 ssh，但**不影响 git**（git 走 non-interactive subshell）。这个 zsh 问题暂未修，标记 future cleanup。

## Rejected alternatives

- **Universal Mac binary**：JC 偏好 split arm64 + x64 两份 dmg，理由是用户视角更清晰 + 单架构 dmg 更小
- **Mac 跨编译 Win .exe**：Tauri 社区明确不支持稳定，xwin/mingw 路径 fragile，CI 用 windows-latest runner 才是 supported 路径
- **测试用 `v0.1.99-test` tag**：会污染 git 历史 + Releases 页堆 draft；`workflow_dispatch` 干净得多
- **`ImageMagick` 切 icon 多尺寸**：Tauri CLI 自带 `pnpm tauri icon` 一键产 .icns / .ico / 多尺寸 PNG / iOS / Android，不用 ImageMagick
- **icon v3 / v4 再用 AI 重生**：JC 手动 fine-tune 比再跑 AI 快、可控
- **改 `~/Library/Application Support/app.galley/workbench.db` 让截图模式生效**：高风险（万一回不来 = 丢全部 dogfood 数据）；改内存 hydrate 钩子才是干净路径
- **代码签名 (Mac $99 / Win $200-400 年费)**：v0.1 不投入；用户首次启动 Gatekeeper / SmartScreen 警告 dogfood 阶段够用
- **自动更新 (`tauri-plugin-updater`)**：v0.3 scope，需要签名才能验签

## Open questions

- **macos-13 Intel runner 排队**：CI 实测有时 6+ 分钟还在 queue。GitHub 在 deprecate Intel runner，长期需要 fallback：(a) drop Intel 支持 (b) JC 自己 Intel Mac 本地 build (c) macos-14 + `rustup target add x86_64-apple-darwin` 跨编译。docs/release-workflow.md 有 §Intel runner deprecation 三方案
- **Win 11 圆角 / resize handle / Maximize 8px 溢出 / Snap Layouts 缺失** ——全部留给 Y6 Win 机 smoke
- **6 张 screenshots 怎么用进 README**：JC 下次 session 整合，可能从 6 张里挑 4 张 / 全 6 张都用 / 不同布局
- **`_kaku_wrapped_ssh` zsh wrapper 错位**：影响 JC interactive ssh 不影响 git；建议下次有空查 zsh plugin / config 修

## Next

立即可做：
- 任何时候按 [docs/release-workflow.md §Dry-run](../release-workflow.md) 跑一次 manual workflow_dispatch 验证 release.yml 全流程
- 下次 session 整合 README screenshots

依赖外部条件：
- Y6 Win 机 smoke ——等 JC 借到 Windows 机器
- v0.1.0 真发版 ——版本号 bump + RC + tag + publish

中期：
- v0.2 加 GitHub Actions release CI 包含真签名（如果 Apple Developer + Win cert 投入了）
- v0.3 加 auto-updater（`tauri-plugin-updater`）

---

**Session totals**：上午 Y plan + A items 11 commits（前一份 devlog），下午-晚间 release CI / menubar / icon / screenshots **14 commits**，全 day session **25 commits**。CLAUDE.md Stage 3.8 + 3.9 两阶段都齐了。
