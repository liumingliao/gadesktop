//! Galley Core's local socket transport (Unix domain socket on macOS/Linux,
//! Windows named pipe on Windows).
//!
//! ## Purpose
//!
//! The transport that lets CLI clients talk to a running Galley Core process.
//! From B2 M4 onward, `galley session send <id> "..."` opens this socket and
//! sends a typed command; Rust dispatches via [`crate::api::GalleyApi`]
//! (same trait Tauri commands use, per [invariants.md §I5]).
//!
//! For B2 M3 only the read commands (B1 surface) are wired through — write
//! commands land in M4 together with the CLI binary side.
//!
//! ## Localhost only
//!
//! Per [CLAUDE.md Galley 架构原则 #1](../../CLAUDE.md), Galley Core never
//! binds TCP. Filesystem permissions on the socket file (0600 on Unix,
//! user-scoped pipe namespace on Windows) are the only access control —
//! no tokens, no TLS, no auth layer. Remote access (e.g. supervisor agents
//! on the same machine) goes through this localhost socket; cross-machine
//! access goes through GA's IM frontends + Galley CLI on the host machine.
//!
//! ## Protocol
//!
//! Newline-delimited JSON (NDJSON). One request line = one response line
//! for unary commands; subscription commands (`session.watch` in M4) keep
//! the connection open and push event lines until SIGINT.
//!
//! Request shape:
//!   `{"command":"sessions.list","args":{...},"schemaVersion":1,"requestId":"uuid"}`
//!
//! Response shape (success):
//!   `{"ok":true,"requestId":"...","result":<command-specific>}`
//!
//! Response shape (error):
//!   `{"ok":false,"requestId":"...","error":"<tag>","message":"..."}`
//!
//! Stream events (subscription mode, M4+):
//!   `{"stream":"event","requestId":"...","data":<payload>}`
//!
//! ## Race detection at startup
//!
//! Two cases:
//!   - **another Galley instance running**: try-connect succeeds → log a
//!     diagnostic + return without binding. The other instance owns the
//!     socket; we don't fight it.
//!   - **stale socket file** (previous process crashed before cleanup):
//!     try-connect fails (ECONNREFUSED) → unlink stale file → bind fresh.
//!
//! See [B2 playbook M3 G5](../../docs/refactor/B2-bridge-ownership.md) for
//! the residual narrow race window between try-connect and the next
//! process's bind (~ms; OS-level atomic bind would close this fully).

use crate::api::message::MessageBrief;
use crate::api::{GalleyApi, Origin, OriginVia, SessionFilter, SessionId};
use crate::db::SqliteGalley;
use crate::ipc::{IpcCommand, UserMessageCommand};
use crate::runner_manager::{BroadcastItem, RunnerManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

/// Wire-level schema version. Stable across additive changes; bumped on
/// breaking schema changes (and old-version clients use `?schema=1` to opt
/// into legacy framing — same convention as [docs/agent-api.md]).
pub const SCHEMA_VERSION: u32 = 1;

/// Per-connection idle timeout. 90s gives interactive shell scripts enough
/// breathing room; long-running watch subscriptions don't count as idle
/// because they push data continuously.
pub const CONNECTION_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketRequest {
    /// Dotted command name. Examples: `"sessions.list"`, `"session.brief"`.
    pub command: String,
    /// Command-specific args. Each command's handler parses this further.
    #[serde(default)]
    pub args: Value,
    /// Client-chosen id for demuxing in mixed request/stream sessions.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Schema version the client expects. Server checks for compatibility.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
}

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SocketResponse {
    fn ok(request_id: Option<String>, result: Value) -> Self {
        Self {
            ok: true,
            request_id,
            result: Some(result),
            error: None,
            message: None,
        }
    }

    fn err(request_id: Option<String>, error: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            request_id,
            result: None,
            error: Some(error.into()),
            message: Some(message.into()),
        }
    }
}

// ---------------- shared dispatch helpers (B4 M1) ----------------

/// Build an [`Origin`] from the supervisor + reason flags that every
/// write socket command accepts. `via` flips to `Supervisor` when a
/// supervisor label is present; otherwise `Cli`. Used by all B4 M1
/// write handlers (`session.new` / `session.btw` / `session.stop` /
/// `session.archive` / `session.restore` / `session.move` /
/// `project.create` / `project.delete`) so the rule lives in one place.
fn origin_from_args(supervisor: Option<String>, reason: Option<String>) -> Origin {
    Origin {
        via: if supervisor.is_some() {
            OriginVia::Supervisor
        } else {
            OriginVia::Cli
        },
        supervisor,
        reason,
    }
}

/// Map a [`GalleyError`] onto the wire `SocketResponse` envelope.
/// Each variant gets its own stable `error` discriminant string so
/// `cli/src/main.rs::map_error_tag` can round-trip back to a typed
/// error (and `exit_code_for` lands on the right exit category).
fn map_galley_err(
    request_id: Option<String>,
    err: crate::error::GalleyError,
) -> SocketResponse {
    use crate::error::GalleyError;
    match err {
        GalleyError::NotFound { message } => SocketResponse::err(request_id, "not_found", message),
        GalleyError::InvalidArgs { message } => {
            SocketResponse::err(request_id, "invalid_args", message)
        }
        GalleyError::DbUnavailable { message } => {
            SocketResponse::err(request_id, "db_unavailable", message)
        }
        GalleyError::RunnerError { message } => {
            SocketResponse::err(request_id, "runner_error", message)
        }
        GalleyError::Internal { message } => SocketResponse::err(request_id, "internal", message),
    }
}

/// Resolve the per-user socket path.
///
/// - macOS/Linux: `${TMPDIR:-/tmp}/galley-${UID}.sock`
/// - Windows: `\\.\pipe\galley-${USERNAME}`
pub fn socket_path() -> PathBuf {
    #[cfg(unix)]
    {
        let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
        // SAFETY: getuid is always safe — POSIX guarantees it can't fail.
        let uid = unsafe { libc_getuid() };
        PathBuf::from(format!("{}/galley-{}.sock", tmp.trim_end_matches('/'), uid))
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "unknown".to_string());
        // Sanitize: Windows named-pipe names can't contain '\\' or '/'.
        let safe = user.replace(['\\', '/'], "_");
        PathBuf::from(format!(r"\\.\pipe\galley-{}", safe))
    }
}

// Minimal `getuid()` shim. We don't pull in the `libc` or `nix` crates
// just for this one call — the syscall is stable POSIX and the bind to
// `geteuid` would be one extra dep for ~6 chars of code. (`extern` blocks
// can't carry doc comments, so this is `//` not `///`.)
#[cfg(unix)]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

/// Start the listener. Spawns a tokio task that owns the listener for the
/// app's lifetime. Idempotent at startup boundary — if another Galley
/// instance is already bound, logs + returns without crashing.
///
/// `manager`: shared reference to the RunnerManager. Cloned into the
/// per-connection dispatch tasks so write commands (`session.send`,
/// `session.watch`) can talk to subprocesses.
///
/// Returns a guard that unlinks the socket file when dropped (Unix only —
/// Windows pipes auto-clean). Hold this in app state to keep the socket
/// alive until process exit.
pub async fn start(
    app: AppHandle,
    manager: Arc<RunnerManager>,
) -> Result<SocketGuard, std::io::Error> {
    let path = socket_path();

    // Race detection: try connecting to see if another instance owns it.
    #[cfg(unix)]
    {
        if path.exists() {
            // Probe with a 200ms timeout — owners should accept fast on
            // localhost; if it hangs longer than this we treat it as
            // stale and reclaim.
            match timeout(Duration::from_millis(200), UnixStream::connect(&path)).await {
                Ok(Ok(_)) => {
                    eprintln!(
                        "[socket] another Galley instance is bound to {} — \
                         not starting a second listener",
                        path.display()
                    );
                    return Ok(SocketGuard::dormant());
                }
                _ => {
                    // ECONNREFUSED or timeout → stale socket file. Unlink
                    // before bind() — bind() doesn't replace existing
                    // files on Unix.
                    if let Err(e) = std::fs::remove_file(&path) {
                        eprintln!(
                            "[socket] failed to remove stale socket {}: {} — \
                             listener won't start",
                            path.display(),
                            e
                        );
                        return Ok(SocketGuard::dormant());
                    }
                }
            }
        }
    }

    let listener_result = bind_listener(&path).await;
    match listener_result {
        Ok(listener) => {
            // Apply 0600 permission on Unix. Windows named pipes are
            // user-scoped by default (their namespace + DACL).
            #[cfg(unix)]
            apply_socket_permissions(&path);

            let task_path = path.clone();
            let task_manager = manager.clone();
            let task_app = app.clone();
            tokio::spawn(async move {
                eprintln!("[socket] listening on {}", task_path.display());
                accept_loop(task_app, listener, task_manager).await;
            });
            Ok(SocketGuard::active(path))
        }
        Err(e) => {
            eprintln!(
                "[socket] bind failed at {}: {} — CLI will report exit 4",
                path.display(),
                e
            );
            // We don't error here — bind failure shouldn't kill Galley
            // Core. The CLI will just see a connection refusal and
            // report exit 4 (db_unavailable / "Galley Core not running").
            Ok(SocketGuard::dormant())
        }
    }
}

#[cfg(unix)]
async fn bind_listener(path: &PathBuf) -> Result<UnixListener, std::io::Error> {
    UnixListener::bind(path)
}

#[cfg(windows)]
async fn bind_listener(path: &PathBuf) -> Result<NamedPipeServer, std::io::Error> {
    let path_str = path
        .to_str()
        .ok_or_else(|| std::io::Error::other("named pipe path not UTF-8"))?;
    ServerOptions::new()
        .first_pipe_instance(true)
        .create(path_str)
}

#[cfg(unix)]
fn apply_socket_permissions(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!(
            "[socket] failed to set 0600 permissions on {}: {} — \
             other local users could read",
            path.display(),
            e
        );
    }
}

#[cfg(unix)]
async fn accept_loop(app: AppHandle, listener: UnixListener, manager: Arc<RunnerManager>) {
    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let m = manager.clone();
                let app_c = app.clone();
                tokio::spawn(async move {
                    let (read_half, write_half) = stream.into_split();
                    handle_stream(app_c, read_half, write_half, m).await;
                });
            }
            Err(e) => {
                eprintln!("[socket] accept error: {e}");
                // Brief backoff to avoid tight loop on persistent errors.
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

#[cfg(windows)]
async fn accept_loop(app: AppHandle, mut listener: NamedPipeServer, manager: Arc<RunnerManager>) {
    loop {
        // `connect()` blocks until a client connects to this pipe.
        if let Err(e) = listener.connect().await {
            eprintln!("[socket] connect error: {e}");
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        // Need a new server instance for the next client; `connect` on
        // the same server only handles one client.
        let path = socket_path();
        let path_str = match path.to_str() {
            Some(s) => s,
            None => {
                eprintln!("[socket] named pipe path not UTF-8");
                return;
            }
        };
        let new_listener = match ServerOptions::new().create(path_str) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[socket] create next pipe instance failed: {e}");
                return;
            }
        };
        let connected = std::mem::replace(&mut listener, new_listener);
        let m = manager.clone();
        let app_c = app.clone();
        tokio::spawn(async move {
            let (read_half, write_half) = tokio::io::split(connected);
            handle_stream(app_c, read_half, write_half, m).await;
        });
    }
}

async fn handle_stream<R, W>(
    app: AppHandle,
    read_half: R,
    mut write_half: W,
    manager: Arc<RunnerManager>,
) where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(read_half).lines();
    loop {
        let next_line = timeout(CONNECTION_IDLE_TIMEOUT, lines.next_line()).await;
        let line = match next_line {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => return, // client closed
            Ok(Err(_e)) => return,
            Err(_) => {
                // Idle timeout → polite close
                let _ = write_resp(
                    &mut write_half,
                    &SocketResponse::err(None, "idle_timeout", "connection idle > 90s"),
                )
                .await;
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match dispatch_line(&line, Some(&app), &manager).await {
            DispatchResult::Unary(resp) => {
                if write_resp(&mut write_half, &resp).await.is_err() {
                    return;
                }
            }
            DispatchResult::Stream { request_id, mut rx } => {
                // Long-running subscription: forward each broadcast item
                // as a stream line until the receiver closes (subprocess
                // exited) or the client disconnects.
                use tokio::sync::broadcast::error::RecvError;
                loop {
                    match rx.recv().await {
                        Ok(BroadcastItem::Event(boxed)) => {
                            let payload = StreamEnvelope::event(request_id.clone(), serde_json::to_value(&*boxed).unwrap_or(Value::Null));
                            if write_stream_line(&mut write_half, &payload).await.is_err() {
                                return;
                            }
                        }
                        Ok(BroadcastItem::Malformed(line)) => {
                            let payload = StreamEnvelope::event(
                                request_id.clone(),
                                serde_json::json!({ "kind": "malformed", "line": line }),
                            );
                            if write_stream_line(&mut write_half, &payload).await.is_err() {
                                return;
                            }
                        }
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => {
                            let payload = StreamEnvelope::end(request_id.clone(), "subprocess_exited");
                            let _ = write_stream_line(&mut write_half, &payload).await;
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEnvelope {
    stream: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl StreamEnvelope {
    fn event(request_id: Option<String>, data: Value) -> Self {
        Self {
            stream: "event",
            request_id,
            data: Some(data),
            reason: None,
        }
    }
    fn end(request_id: Option<String>, reason: &str) -> Self {
        Self {
            stream: "end",
            request_id,
            data: None,
            reason: Some(reason.to_string()),
        }
    }
}

async fn write_stream_line<W: tokio::io::AsyncWrite + Unpin>(
    w: &mut W,
    env: &StreamEnvelope,
) -> std::io::Result<()> {
    let line = serde_json::to_string(env).unwrap_or_default();
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await?;
    Ok(())
}

/// Output of [`dispatch_line`]. Most commands return a single response
/// (Unary); `session.watch` returns a Stream of broadcast events.
enum DispatchResult {
    Unary(SocketResponse),
    Stream {
        request_id: Option<String>,
        rx: broadcast::Receiver<BroadcastItem>,
    },
}

async fn write_resp<W: tokio::io::AsyncWrite + Unpin>(
    w: &mut W,
    resp: &SocketResponse,
) -> std::io::Result<()> {
    let line = serde_json::to_string(resp).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"internal","message":"response serialize failed"}"#.to_string()
    });
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await?;
    Ok(())
}

/// Parse a request line and dispatch to a command handler. Returns either
/// a single [`SocketResponse`] or a streaming broadcast receiver for
/// subscription commands like `session.watch`.
async fn dispatch_line(
    line: &str,
    app: Option<&AppHandle>,
    manager: &RunnerManager,
) -> DispatchResult {
    let req: SocketRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            return DispatchResult::Unary(SocketResponse::err(
                None,
                "invalid_args",
                format!("malformed request JSON: {e}"),
            ));
        }
    };
    if req.schema_version != SCHEMA_VERSION {
        return DispatchResult::Unary(SocketResponse::err(
            req.request_id,
            "schema_mismatch",
            format!(
                "client schema_version {} != server {}",
                req.schema_version, SCHEMA_VERSION
            ),
        ));
    }

    let request_id = req.request_id.clone();
    match req.command.as_str() {
        // ---- B1 read commands ----
        "sessions.list" => DispatchResult::Unary(dispatch_sessions_list(request_id, req.args).await),
        "ping" => DispatchResult::Unary(SocketResponse::ok(
            request_id,
            serde_json::json!({ "pong": true }),
        )),
        "version" => DispatchResult::Unary(SocketResponse::ok(
            request_id,
            serde_json::json!({ "schemaVersion": SCHEMA_VERSION }),
        )),
        // ---- B2 M4 write commands ----
        "session.send" => DispatchResult::Unary(
            dispatch_session_send(request_id, req.args, app, manager).await,
        ),
        "session.watch" => dispatch_session_watch(request_id, req.args, manager).await,
        other => DispatchResult::Unary(SocketResponse::err(
            request_id,
            "unknown_command",
            format!("no handler for '{other}'"),
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSendArgs {
    session_id: String,
    content: String,
    #[serde(default)]
    supervisor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWatchArgs {
    session_id: String,
}

/// Tauri event payload broadcast to the GUI whenever a user message is
/// persisted via the socket path (CLI `galley session send` / supervisor
/// agents). GUI's listener calls `appendUserTurnExternal` to mirror the
/// row into the in-memory store so the conversation view renders the
/// message even though it wasn't typed in the Composer.
///
/// The GUI's own Composer path skips this — it persists locally via
/// `persistUserMessage` and mutates the store synchronously, so emitting
/// here would double-render.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UserMessagePersistedPayload {
    session_id: String,
    message: MessageBrief,
}

async fn dispatch_session_send(
    request_id: Option<String>,
    args: Value,
    app: Option<&AppHandle>,
    manager: &RunnerManager,
) -> SocketResponse {
    let parsed: SessionSendArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.send args: {e}"),
            );
        }
    };
    // 1. Open DB + write message row with origin = cli/supervisor
    let galley = match SqliteGalley::open().await {
        Ok(g) => g,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "db_unavailable",
                format!("open: {e}"),
            );
        }
    };
    let origin = origin_from_args(parsed.supervisor.clone(), parsed.reason.clone());
    let session_id = SessionId(parsed.session_id.clone());
    let brief = match galley
        .send_message(session_id, parsed.content.clone(), origin)
        .await
    {
        Ok(b) => b,
        Err(e) => return map_galley_err(request_id, e),
    };

    // 2. Best-effort dispatch to runner. If the session's runner isn't
    // alive (LRU evicted, never spawned, crashed), the message is still
    // persisted in the DB — caller can `galley session watch` and wait
    // for a future spawn / replay path. We surface the runner result in
    // the response so callers know whether the message reached the
    // subprocess this turn.
    let dispatch_status = match manager
        .send_command(
            &parsed.session_id,
            &IpcCommand::UserMessage(UserMessageCommand {
                text: parsed.content,
                images: vec![],
            }),
        )
        .await
    {
        Ok(()) => "dispatched",
        Err(_) => "persisted_only",
    };

    // Notify GUI so the conversation view picks up the new user row.
    // Emit covers both `dispatched` and `persisted_only` — the user
    // message exists in the DB either way, and the GUI must mirror it.
    // Best-effort: emit failure (no listeners registered yet, or app
    // handle gone) does not roll back the persist + dispatch above.
    if let Some(app) = app {
        let payload = UserMessagePersistedPayload {
            session_id: brief.session_id.0.clone(),
            message: brief.clone(),
        };
        let _ = app.emit("user-message-persisted", payload);
    }

    let result = serde_json::json!({
        "message": brief,
        "dispatch": dispatch_status,
    });
    SocketResponse::ok(request_id, result)
}

async fn dispatch_session_watch(
    request_id: Option<String>,
    args: Value,
    manager: &RunnerManager,
) -> DispatchResult {
    let parsed: SessionWatchArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return DispatchResult::Unary(SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.watch args: {e}"),
            ));
        }
    };
    match manager.subscribe(&parsed.session_id).await {
        Some(rx) => DispatchResult::Stream { request_id, rx },
        None => DispatchResult::Unary(SocketResponse::err(
            request_id,
            "not_found",
            format!("no live runner for session {}", parsed.session_id),
        )),
    }
}

async fn dispatch_sessions_list(request_id: Option<String>, args: Value) -> SocketResponse {
    let filter: SessionFilter = match serde_json::from_value(args) {
        Ok(f) => f,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("sessions.list args: {e}"),
            );
        }
    };
    let galley = match SqliteGalley::open().await {
        Ok(g) => g,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "db_unavailable",
                format!("open: {e}"),
            );
        }
    };
    match galley.list_sessions(filter).await {
        Ok(sessions) => {
            let value = serde_json::to_value(&sessions).unwrap_or(Value::Null);
            SocketResponse::ok(request_id, value)
        }
        Err(e) => SocketResponse::err(
            request_id,
            "internal",
            format!("list_sessions: {e}"),
        ),
    }
}

/// Lifetime guard for the socket file. Held in app state; when the app
/// drops it (or panics with unwind), Drop unlinks the socket file on Unix.
/// On Windows the named pipe namespace auto-cleans when all handles drop.
///
/// A "dormant" guard is returned when bind failed or another instance
/// owned the socket — Drop is a no-op in that case (we don't want to
/// unlink the OTHER instance's socket).
pub struct SocketGuard {
    path: Option<PathBuf>,
}

impl SocketGuard {
    fn dormant() -> Self {
        Self { path: None }
    }
    fn active(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// True iff this guard owns a real listener (vs being the "another
    /// instance owned it" no-op variant). Test helper.
    pub fn is_active(&self) -> bool {
        self.path.is_some()
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(path) = &self.path {
            if let Err(e) = std::fs::remove_file(path) {
                eprintln!(
                    "[socket] failed to unlink {} on drop: {}",
                    path.display(),
                    e
                );
            }
        }
        // Windows: nothing to do — named pipe namespace cleans on handle drop.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_unix_uses_tmpdir() {
        #[cfg(unix)]
        {
            // Force a known TMPDIR to make the assertion deterministic.
            let old = std::env::var("TMPDIR").ok();
            // SAFETY: tests are single-threaded for env-var manipulation
            // because we restore at the end. cargo test default is parallel
            // but env mutation here only touches this one test.
            unsafe {
                std::env::set_var("TMPDIR", "/tmp/test-socket-path");
            }
            let path = socket_path();
            let s = path.to_string_lossy();
            assert!(s.starts_with("/tmp/test-socket-path/galley-"));
            assert!(s.ends_with(".sock"));
            // Restore
            unsafe {
                match old {
                    Some(v) => std::env::set_var("TMPDIR", v),
                    None => std::env::remove_var("TMPDIR"),
                }
            }
        }
    }

    #[test]
    fn socket_path_windows_uses_username() {
        #[cfg(windows)]
        {
            let path = socket_path();
            let s = path.to_string_lossy();
            assert!(s.starts_with(r"\\.\pipe\galley-"));
        }
    }

    #[test]
    fn parse_socket_request_minimal() {
        let line = r#"{"command":"ping"}"#;
        let req: SocketRequest = serde_json::from_str(line).unwrap();
        assert_eq!(req.command, "ping");
        assert!(req.request_id.is_none());
        assert_eq!(req.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn parse_socket_request_full() {
        let line = r#"{
            "command":"sessions.list",
            "args":{"archived":false},
            "requestId":"abc-123",
            "schemaVersion":1
        }"#;
        let req: SocketRequest = serde_json::from_str(line).unwrap();
        assert_eq!(req.command, "sessions.list");
        assert_eq!(req.request_id, Some("abc-123".into()));
    }

    #[test]
    fn response_serializes_compactly() {
        let resp = SocketResponse::ok(Some("r1".into()), serde_json::json!({"x":1}));
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"requestId\":\"r1\""));
        assert!(s.contains("\"result\":{\"x\":1}"));
        // null fields suppressed by skip_serializing_if
        assert!(!s.contains("\"error\":"));
        assert!(!s.contains("\"message\":"));
    }

    #[test]
    fn response_error_shape() {
        let resp = SocketResponse::err(None, "not_found", "session does not exist");
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"ok\":false"));
        assert!(s.contains("\"error\":\"not_found\""));
        assert!(s.contains("\"message\":\"session does not exist\""));
    }

    /// Helper: unwrap the Unary variant for tests that only exercise
    /// non-stream commands. Streaming command tests live in the
    /// `core/tests/socket_listener_test.rs` integration suite where
    /// a real RunnerManager + spawned subprocess exists.
    fn expect_unary(r: DispatchResult) -> SocketResponse {
        match r {
            DispatchResult::Unary(resp) => resp,
            DispatchResult::Stream { .. } => panic!("expected Unary, got Stream"),
        }
    }

    #[tokio::test]
    async fn dispatch_unknown_command_yields_error() {
        let mgr = RunnerManager::new();
        let resp = expect_unary(
            dispatch_line(r#"{"command":"nope.does_not_exist"}"#, None, &mgr).await,
        );
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("unknown_command"));
    }

    #[tokio::test]
    async fn dispatch_ping_succeeds() {
        let mgr = RunnerManager::new();
        let resp = expect_unary(
            dispatch_line(r#"{"command":"ping","requestId":"r1"}"#, None, &mgr).await,
        );
        assert!(resp.ok);
        assert_eq!(resp.request_id.as_deref(), Some("r1"));
    }

    #[tokio::test]
    async fn dispatch_invalid_json() {
        let mgr = RunnerManager::new();
        let resp = expect_unary(dispatch_line("not-json", None, &mgr).await);
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("invalid_args"));
    }

    #[tokio::test]
    async fn dispatch_schema_mismatch() {
        let mgr = RunnerManager::new();
        let resp = expect_unary(
            dispatch_line(r#"{"command":"ping","schemaVersion":42}"#, None, &mgr).await,
        );
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("schema_mismatch"));
    }

    #[tokio::test]
    async fn dispatch_session_watch_unknown_session_returns_not_found() {
        let mgr = RunnerManager::new();
        let line = r#"{"command":"session.watch","args":{"sessionId":"nope"}}"#;
        let resp = expect_unary(dispatch_line(line, None, &mgr).await);
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("not_found"));
    }

    #[test]
    fn socket_guard_dormant_does_nothing_on_drop() {
        let guard = SocketGuard::dormant();
        assert!(!guard.is_active());
        drop(guard); // no panic, no side effect
    }
}
