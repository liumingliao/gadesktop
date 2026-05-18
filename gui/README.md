# Galley Desktop

Tauri v2 + React 19 + TypeScript + Tailwind v4. macOS-first.

See `../CLAUDE.md` for project-wide conventions; this README is just the dev quickstart.

## Dev

```bash
pnpm install
pnpm tauri dev      # 启 Tauri 桌面窗口（首次会编译 Rust，慢）
pnpm dev            # 仅 Vite frontend，浏览器调试用
```

## Quality gates

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint flat config，0 warning
pnpm format         # Prettier 写入
pnpm build          # tsc + vite build（不打 Tauri bundle）
pnpm tauri build    # 打 .app / .dmg
```

## 设计 tokens

`src/styles/globals.css` 的 `@theme` block。命名见 `../CLAUDE.md` "TypeScript（desktop/）" 段。

## IPC types

`src/types/ipc.ts` 镜像 `../bridge/ipc.py`。协议改时三处同改：`docs/ipc-protocol.md` → `bridge/ipc.py` → `desktop/src/types/ipc.ts`。
