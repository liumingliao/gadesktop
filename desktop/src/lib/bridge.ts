import { Child, Command } from "@tauri-apps/plugin-shell";

import { isWindows } from "@/lib/platform";
import type { IPCCommand, IPCEvent } from "@/types/ipc";

/**
 * Bridge subprocess client.
 *
 * Wraps tauri-plugin-shell to spawn a Python bridge subprocess and
 * handle JSON Lines IPC. Per-line stdout chunks are parsed as IPC
 * events; stdin gets one JSON object per line per the protocol.
 *
 * V0.1 #10a ships single-session usage. Multi-session keyed by
 * sessionId (as the protocol allows) lands when SessionManager in
 * the store needs it (#10b).
 *
 * Stderr is preserved verbatim — bridge writes Python tracebacks /
 * crash logs there per stdout discipline (workbench_bridge.py docs).
 * We surface stderr to the registered onStderr callback so the host
 * can route it to logs / debug toast.
 */

export interface BridgeSpawnArgs {
  /**
   * Python interpreter path. Defaults to "python3" on macOS / Linux
   * and "python" on Windows (must be on PATH). Override when the user
   * configured a custom Python in Settings.
   */
  python?: string;
  /** Path to GA repo (forwarded to bridge as --ga-path). */
  gaPath: string;
  /** Stable session id (forwarded to bridge as --session-id). */
  sessionId: string;
  /** Working directory for the GA subprocess (--cwd). */
  cwd?: string;
  /**
   * Working directory for the bridge process itself. Should be the
   * Workbench repo root so `python -m bridge.workbench_bridge`
   * resolves the package.
   */
  bridgeCwd?: string;
  /** Initial LLM index (--llm-no). */
  llmIndex?: number;
  /** Extra environment variables passed to the Python child. */
  env?: Record<string, string>;
}

export interface BridgeClient {
  /** Subprocess pid. Resolved after spawn(). */
  pid: number;
  /** Send an IPCCommand to bridge stdin. */
  send(cmd: IPCCommand): Promise<void>;
  /** SIGKILL the bridge. Use shutdown() for graceful exit when possible. */
  kill(): Promise<void>;
  /** Send {kind: "shutdown"} and wait for close. Falls back to kill if hung. */
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface BridgeHandlers {
  onEvent: (event: IPCEvent) => void;
  /** Stderr line (already trimmed). bridge writes Python tracebacks
   * here so it's worth surfacing as a toast / log. */
  onStderr?: (line: string) => void;
  /** Process exited (graceful or not). `code` is null when killed by signal. */
  onClose?: (code: number | null, signal: number | null) => void;
  /** Spawn / IO error. */
  onError?: (message: string) => void;
  /** Called when stdout emits a line that doesn't parse as JSON. Bridge's
   * stdout discipline (capture fd 1 + redirect sys.stdout to /dev/null)
   * should make this rare. */
  onMalformedLine?: (line: string) => void;
}

export async function spawnBridge(
  args: BridgeSpawnArgs,
  handlers: BridgeHandlers,
): Promise<BridgeClient> {
  const program = args.python ?? (isWindows ? "python" : "python3");
  const argv = [
    "-m",
    "bridge.workbench_bridge",
    "--ga-path",
    args.gaPath,
    "--session-id",
    args.sessionId,
  ];
  if (args.cwd) argv.push("--cwd", args.cwd);
  if (args.llmIndex !== undefined) argv.push("--llm-no", String(args.llmIndex));

  // bridgeCwd resolution:
  //   - production (packaged .app): we bundle the `bridge/` package
  //     into Resources/ via tauri.conf.json's bundle.resources
  //     mapping. Python's `-m bridge.workbench_bridge` needs that
  //     Resources/ dir as cwd to discover the package. resourceDir()
  //     points at .app/Contents/Resources/.
  //   - dev (`pnpm tauri dev`): args.bridgeCwd is the workbench repo
  //     root (set by demo / store gaConfig), which contains the
  //     real `bridge/` source.
  const bridgeCwd = import.meta.env.PROD
    ? await resolveProductionBridgeCwd(args.bridgeCwd)
    : args.bridgeCwd;

  const command = Command.create(program, argv, {
    cwd: bridgeCwd,
    env: args.env,
  });

  command.stdout.on("data", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as IPCEvent;
      handlers.onEvent(parsed);
    } catch {
      handlers.onMalformedLine?.(trimmed);
    }
  });

  command.stderr.on("data", (line) => {
    const trimmed = line.trim();
    if (trimmed) handlers.onStderr?.(trimmed);
  });

  command.on("close", (payload) => {
    handlers.onClose?.(payload.code, payload.signal);
  });

  command.on("error", (err) => {
    handlers.onError?.(err);
  });

  let child: Child;
  try {
    child = await command.spawn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    handlers.onError?.(msg);
    throw e;
  }

  return {
    pid: child.pid,
    send: (cmd) => child.write(JSON.stringify(cmd) + "\n"),
    kill: () => child.kill(),
    shutdown: async (timeoutMs = 3000) => {
      let closed = false;
      const closePromise = new Promise<void>((resolve) => {
        const wrap =
          (orig?: BridgeHandlers["onClose"]): BridgeHandlers["onClose"] =>
          (code, signal) => {
            closed = true;
            orig?.(code, signal);
            resolve();
          };
        handlers.onClose = wrap(handlers.onClose);
      });

      try {
        await child.write(JSON.stringify({ kind: "shutdown" }) + "\n");
      } catch {
        // Bridge may have already exited; fall through to kill.
      }

      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);

      if (!closed) {
        try {
          await child.kill();
        } catch {
          // Already dead.
        }
      }
    },
  };
}

/**
 * Resolve the cwd for the Python bridge process in a packaged build.
 * Tauri's `bundle.resources` maps `../../bridge` → `bridge` under
 * `<.app>/Contents/Resources/`; we point cwd at the Resources dir so
 * `python -m bridge.workbench_bridge` finds the package.
 *
 * Falls back to the passed `dev` value if `resourceDir()` somehow
 * fails (very unlikely in a real Tauri runtime — we still want a
 * sensible behavior rather than throw).
 */
async function resolveProductionBridgeCwd(
  dev: string | undefined,
): Promise<string | undefined> {
  try {
    const { resourceDir } = await import("@tauri-apps/api/path");
    return await resourceDir();
  } catch (e) {
    console.warn(
      "[bridge] resolveProductionBridgeCwd failed; falling back to dev path.",
      e,
    );
    return dev;
  }
}
