# Windows build checklist

> Status: **draft**. Tracks what's needed to produce a Galley `.exe` installer on Windows manually and the smoke tests to run on Win release artifacts.
>
> Galley v0.1 ships Mac-only (`.app` + `.dmg`). v0.2+ release path is **CI-driven** — see [release-workflow.md](./release-workflow.md). This document is the **fallback / offline build path**: use it when CI is unavailable, when smoke-testing a CI-produced `.exe`, or when validating a local change on a Win machine before pushing.

## 1 · Prerequisites

Install in this order on a clean Windows 10 / 11 machine. Versions reflect what Galley's tooling expects as of 2026-05.

| # | Tool | Min version | Notes |
|---|---|---|---|
| 1 | **Python** | 3.10+ | Bridge subprocess. Use the installer from python.org; tick "Add python.exe to PATH". |
| 2 | **Node.js** | 20.x LTS | Frontend toolchain. Installer from nodejs.org. |
| 3 | **pnpm** | 9.x | `npm install -g pnpm` after Node installs. |
| 4 | **Rust toolchain** | stable 1.78+ | Install via `rustup-init.exe` from rustup.rs. Pick the `x86_64-pc-windows-msvc` host triple (default on Win). |
| 5 | **MSVC Build Tools** | 2022 | Required by Rust for native compilation. Install "Desktop development with C++" workload via Visual Studio Build Tools standalone installer. |
| 6 | **WebView2 Runtime** | Evergreen | Already shipped with Win 11. On Win 10 it's usually present via Edge — verify under Settings → Apps → "Microsoft Edge WebView2 Runtime". The Galley installer also includes a bootstrapper that pulls it if absent (`webviewInstallMode: downloadBootstrapper` in `tauri.conf.json`). |

Verification (PowerShell):

```powershell
python --version           # 3.10+
node --version             # v20+
pnpm --version             # 9+
rustup --version           # any
cargo --version            # any
```

If `cargo` errors with "missing linker", re-run the MSVC Build Tools installer and ensure the C++ workload is checked.

## 2 · Build

```powershell
git clone https://github.com/wangjc683/galley.git
cd galley\gui
pnpm install
pnpm tauri build
```

Artifacts land in `core\target\release\bundle\`:

- `nsis\Galley_0.1.0_x64-setup.exe` — installer (~50-80 MB depending on WebView2 inclusion)
- `msi\Galley_0.1.0_x64_en-US.msi` — only if `"msi"` is added to bundle targets (not default)

## 3 · Install + first run

1. Double-click `Galley_0.1.0_x64-setup.exe`
2. NSIS installer runs in current-user mode (no UAC prompt — see `bundle.windows.nsis.installMode: "currentUser"`)
3. Galley appears in Start Menu under "Galley"
4. First launch: Onboarding flow should appear

## 4 · Smoke test checklist

Items to verify on the Win machine. Hand back to Mac for any failures.

### Window chrome (Y plan)

- [ ] Window opens with **no native title bar** (decorations off worked)
- [ ] Drop shadow visible around window edges (`window-shadows-v2` ran)
- [ ] Win 11: rounded corners (DWM auto-applies; if hard corners, file issue)
- [ ] Top-right shows **three custom buttons**: minimize / maximize / close
- [ ] Each button is 46×44 px and the cluster touches the right edge
- [ ] Hover on min / max → gray fill
- [ ] Hover on close → red fill, icon turns white
- [ ] Click min → window minimizes to taskbar
- [ ] Click max → window maximizes; icon swaps to restore glyph
- [ ] Click again → window restores; icon swaps back
- [ ] Click close → window closes (app may stay in background or fully exit depending on Tauri config)
- [ ] **Double-click TopBar** (anywhere not on a button) → maximize toggle
- [ ] **Drag TopBar** → window moves
- [ ] **Drag TopBar while maximized** → window restores then drags (Win convention)
- [ ] **Resize from any edge** → window resizes (invisible resize handles work)
- [ ] **Click another window** → Galley controls desaturate (focus lost)
- [ ] **Click back on Galley** → controls re-saturate
- [ ] Win + Arrow keys snap window left / right / fullscreen (handled by OS, should just work)

### Keyboard shortcuts

- [ ] **Ctrl+K** opens Command Palette
- [ ] **Ctrl+N** starts a new chat
- [ ] **Ctrl+,** opens Settings
- [ ] Settings → Shortcuts shows `Ctrl+K`-style labels (not `⌘K`)

### Onboarding

- [ ] Welcome screen renders (Newsreader font visible, no fallback to Times New Roman)
- [ ] StepAttach placeholder reads `C:\Users\你的名字\Documents\GenericAgent`
- [ ] "选择" button opens Windows file dialog
- [ ] Path validation runs (red on bad path, green on real GA)
- [ ] StepHealth checks pass (Python found as `python`, not `python3`)
- [ ] "继续" enters main app

### Bridge / chat

- [ ] First user message reaches GA (no spawn errors)
- [ ] LLM streaming visible
- [ ] Tool approval modal works (if YOLO mode is off; default is on)
- [ ] Conversation persists after app restart

### Tutorial modal

- [ ] "memory-info" tutorial shows BOTH Mac/Linux and Windows command examples (already OS-agnostic in tutorial content)

### YOLO intro dialog

- [ ] First main view load shows YoloIntroDialog
- [ ] ESC / overlay / X are all suppressed (blocking modal)
- [ ] "知道了" / "改回审批模式" buttons work

## 5 · Known sharp edges

- **Maximize 8px overflow**: Win has a quirk where maximized borderless windows can overflow the screen edge by ~8px. If you see this, it's a `window-shadows-v2` or DWM interaction — Tauri community usually solves with a `--margin: 8px` CSS workaround on the root element. Tracked but unfixed in v0.2.
- **Resize handles too thin to grab**: invisible resize borders default to ~4px. If users complain, increase via Rust `set_inner_size` calculations or use `window-vibrancy` shadow workaround.
- **Snap Layouts hover picker missing**: intentionally not implemented in v0.2 (requires WM_NCHITTEST in Rust). Win 11 users can still snap via Win+Arrow.
- **CopySimple restore icon ambiguity**: the Phosphor `CopySimple` glyph stands in for the "two-overlapping-squares" restore icon. If Win users find it unclear, swap to inline SVG.

## 6 · Hand-back to Mac

After smoke testing:

1. Take screenshots of any visual oddity (especially window chrome edge cases)
2. List failed checkboxes with brief notes
3. Push any bug fixes that need Win-machine cycles to a feature branch
4. Mac-side work resumes on `main`

## 7 · CI follow-up (v0.2.x)

When manual Win build works end-to-end, set up GitHub Actions:

- `.github/workflows/build.yml` with `matrix: { os: [macos-latest, windows-latest] }`
- Cache `~/.cargo`, `node_modules`, `target/`
- Upload artifacts: `.dmg` / `.exe` per OS
- Release pipeline: tag-triggered, attaches both bundles to GitHub Release

CI removes the "borrow a Win machine" step from future releases.
