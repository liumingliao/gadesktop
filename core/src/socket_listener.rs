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
use crate::api::session::{CreateSessionInput, SessionBrief};
use crate::api::{GalleyApi, Origin, OriginVia, SessionFilter, SessionId};
use crate::db::SqliteGalley;
use crate::ipc::{IpcCommand, UserMessageCommand};
use crate::runner_manager::SendCommandError;
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
        // ---- B4 M1 session write commands ----
        "session.new" => DispatchResult::Unary(
            dispatch_session_new(request_id, req.args, app, manager).await,
        ),
        "session.btw" => DispatchResult::Unary(
            dispatch_session_btw(request_id, req.args, manager).await,
        ),
        "session.stop" => DispatchResult::Unary(
            dispatch_session_stop(request_id, req.args, manager).await,
        ),
        "session.archive" => {
            DispatchResult::Unary(dispatch_session_archive(request_id, req.args, app).await)
        }
        "session.restore" => {
            DispatchResult::Unary(dispatch_session_restore(request_id, req.args, app).await)
        }
        "session.move" => {
            DispatchResult::Unary(dispatch_session_move(request_id, req.args, app).await)
        }
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

// ---------------- B4 M1 · session write handlers ----------------
//
// All six new handlers share the same shape:
//   1. parse args (camelCase JSON from CLI / supervisor)
//   2. open SqliteGalley (db_unavailable on connect fail)
//   3. validate / execute via GalleyApi trait
//   4. on side-effecting state changes, emit a Tauri event so the GUI
//      can mirror the row into its in-memory stores without polling
//
// `session.new` is the only handler that needs the runner_manager AND a
// SQLite transaction (sub-plan O1 atomicity — create + first message
// commit together or roll back together). `session.btw` and `session.stop`
// drive the runner but don't persist anything new. `session.archive`,
// `session.restore`, `session.move` are thin GalleyApi wrappers.

/// Tauri event payload broadcast when a CLI / supervisor creates a new
/// session via `session.new`. GUI's sidebar listener inserts the row
/// without a list_sessions round-trip.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionExternalPayload {
    session: SessionBrief,
    /// Stable discriminant so a single listener can demultiplex multiple
    /// event types if we collapse the four event names into one in the
    /// future. Kept now for symmetry with `user-message-persisted`.
    via: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionNewArgs {
    task: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    llm_name: Option<String>,
    #[serde(default)]
    supervisor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// Atomically create a session + persist its first user message + best-
/// effort dispatch the message to the runner. Per sub-plan O1, the two
/// writes go through a single SQLite transaction so a send failure rolls
/// back the orphan session row.
async fn dispatch_session_new(
    request_id: Option<String>,
    args: Value,
    app: Option<&AppHandle>,
    manager: &RunnerManager,
) -> SocketResponse {
    let parsed: SessionNewArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.new args: {e}"),
            );
        }
    };
    let task = parsed.task.trim().to_string();
    if task.is_empty() {
        return SocketResponse::err(
            request_id,
            "invalid_args",
            "session.new: task is empty",
        );
    }

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

    // Resolve --llm=<name> against the cached llm_list pref. CLI is
    // allowed to omit the flag (selected_llm = None → bridge uses GA's
    // default at spawn time).
    let (llm_index, llm_display_name) = match resolve_llm_name(&galley, parsed.llm_name).await {
        Ok(pair) => pair,
        Err(resp) => return resp.with_request_id(request_id),
    };

    let id = mint_session_id();
    let input = CreateSessionInput {
        id: id.clone(),
        title: DEFAULT_NEW_SESSION_TITLE.to_string(),
        project_id: parsed.project_id,
        selected_llm_index: llm_index,
        selected_llm_display_name: llm_display_name,
    };
    let origin = origin_from_args(parsed.supervisor.clone(), parsed.reason.clone());

    // BEGIN — create + send_message in one transaction (sub-plan O1).
    let mut tx = match galley.begin_tx().await {
        Ok(t) => t,
        Err(e) => return map_galley_err(request_id, e),
    };
    let brief = match galley
        .create_session_in_tx(&mut tx, input, origin.clone())
        .await
    {
        Ok(b) => b,
        Err(e) => return map_galley_err(request_id, e),
    };
    let msg = match galley
        .send_message_in_tx(&mut tx, SessionId(brief.id.0.clone()), task.clone(), origin)
        .await
    {
        Ok(m) => m,
        Err(e) => return map_galley_err(request_id, e),
    };
    if let Err(e) = tx.commit().await {
        return SocketResponse::err(
            request_id,
            "internal",
            format!("session.new commit: {e}"),
        );
    }

    // Best-effort dispatch to runner. We do NOT spawn a bridge here —
    // CLI `session new` against a never-spawned session yields
    // `persisted_only`; the GUI (or `session watch` + subsequent send)
    // can warm up the bridge later. This matches `session.send` policy.
    let dispatch_status = match manager
        .send_command(
            &brief.id.0,
            &IpcCommand::UserMessage(UserMessageCommand {
                text: task,
                images: vec![],
            }),
        )
        .await
    {
        Ok(()) => "dispatched",
        Err(_) => "persisted_only",
    };

    // Notify GUI: sidebar inserts the row, conversation view picks up
    // the user message if the session is then activated.
    if let Some(app) = app {
        let payload = SessionExternalPayload {
            session: brief.clone(),
            via: "session.new",
        };
        let _ = app.emit("session-created-external", payload);
        let _ = app.emit(
            "user-message-persisted",
            UserMessagePersistedPayload {
                session_id: brief.id.0.clone(),
                message: msg.clone(),
            },
        );
    }

    let result = serde_json::json!({
        "session": brief,
        "message": msg,
        "dispatch": dispatch_status,
    });
    SocketResponse::ok(request_id, result)
}

/// CLI sends `supervisor` / `reason` for symmetry with the other write
/// commands, but `session.btw` is transient (no DB persist per sub-plan
/// §1.5) so we don't act on them in M1. M7 will surface them in the
/// supervisor action log — wire them in there.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SessionBtwArgs {
    session_id: String,
    question: String,
    #[serde(default)]
    supervisor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// "By the way" side-question. Bypasses the agent's run queue via the
/// runner's `/btw` prefix detection. Transient by design — not persisted
/// to the `messages` table (v0.1 decision; see [messages.ts:445-455]).
async fn dispatch_session_btw(
    request_id: Option<String>,
    args: Value,
    manager: &RunnerManager,
) -> SocketResponse {
    let parsed: SessionBtwArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.btw args: {e}"),
            );
        }
    };
    let question = parsed.question.trim().to_string();
    if question.is_empty() {
        return SocketResponse::err(
            request_id,
            "invalid_args",
            "session.btw: question is empty",
        );
    }

    // Validate session exists so a typo'd id surfaces as `not_found`
    // rather than silently failing through `send_command -> ProcessGone`.
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
    if let Err(e) = galley
        .session_brief(SessionId(parsed.session_id.clone()))
        .await
    {
        return map_galley_err(request_id, e);
    }

    // Drop the implicit reference to galley so we can drop the
    // borrowed pool before the runner await. (galley is owned, so the
    // explicit drop is cosmetic — but it keeps the boundary obvious.)
    drop(galley);

    let cmd = IpcCommand::UserMessage(UserMessageCommand {
        text: format!("/btw {question}"),
        images: vec![],
    });
    match manager.send_command(&parsed.session_id, &cmd).await {
        Ok(()) => SocketResponse::ok(
            request_id,
            serde_json::json!({ "dispatch": "dispatched" }),
        ),
        Err(SendCommandError::ProcessGone { .. }) => SocketResponse::err(
            request_id,
            "runner_error",
            format!(
                "no live runner for session {}; /btw requires an alive bridge",
                parsed.session_id
            ),
        ),
        Err(e) => SocketResponse::err(request_id, "runner_error", e.to_string()),
    }
}

/// Same as [`SessionBtwArgs`]: supervisor / reason accepted for CLI
/// surface symmetry but parked until M7's audit log lands.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SessionStopArgs {
    session_id: String,
    #[serde(default)]
    supervisor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// Map a user-facing "stop this turn" onto `IpcCommand::Abort` (NOT
/// `Shutdown`). The bridge stays alive so a subsequent `session send`
/// can resume without paying the 5-10s respawn cost. See sub-plan §1.4
/// for the Abort-vs-Shutdown decision. Idempotent: stopping an already-
/// idle session returns `already_stopped` and exit 0.
async fn dispatch_session_stop(
    request_id: Option<String>,
    args: Value,
    manager: &RunnerManager,
) -> SocketResponse {
    let parsed: SessionStopArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.stop args: {e}"),
            );
        }
    };

    // Validate the session row exists so callers get `not_found` for
    // typos rather than `already_stopped` (which would silently swallow
    // the typo). The runner liveness check is separate.
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
    if let Err(e) = galley
        .session_brief(SessionId(parsed.session_id.clone()))
        .await
    {
        return map_galley_err(request_id, e);
    }
    drop(galley);

    if !manager.agent_running(&parsed.session_id).await {
        return SocketResponse::ok(
            request_id,
            serde_json::json!({ "dispatch": "already_stopped" }),
        );
    }
    match manager.send_command(&parsed.session_id, &IpcCommand::Abort).await {
        Ok(()) => SocketResponse::ok(
            request_id,
            serde_json::json!({ "dispatch": "abort_sent" }),
        ),
        // Race: agent_running was true but the process died before
        // we got the command out. Treat as already_stopped — the
        // observable end state is the same.
        Err(SendCommandError::ProcessGone { .. }) => SocketResponse::ok(
            request_id,
            serde_json::json!({ "dispatch": "already_stopped" }),
        ),
        Err(e) => SocketResponse::err(request_id, "runner_error", e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionArchiveArgs {
    session_id: String,
    #[serde(default)]
    supervisor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

async fn dispatch_session_archive(
    request_id: Option<String>,
    args: Value,
    app: Option<&AppHandle>,
) -> SocketResponse {
    let parsed: SessionArchiveArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.archive args: {e}"),
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
    let origin = origin_from_args(parsed.supervisor, parsed.reason);
    match galley
        .archive_session(SessionId(parsed.session_id), origin)
        .await
    {
        Ok(brief) => {
            if let Some(app) = app {
                let _ = app.emit(
                    "session-archived-external",
                    SessionExternalPayload {
                        session: brief.clone(),
                        via: "session.archive",
                    },
                );
            }
            SocketResponse::ok(request_id, serde_json::json!({ "session": brief }))
        }
        Err(e) => map_galley_err(request_id, e),
    }
}

async fn dispatch_session_restore(
    request_id: Option<String>,
    args: Value,
    app: Option<&AppHandle>,
) -> SocketResponse {
    // Restore reuses the archive args shape — same flags, opposite verb.
    let parsed: SessionArchiveArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.restore args: {e}"),
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
    let origin = origin_from_args(parsed.supervisor, parsed.reason);
    match galley
        .unarchive_session(SessionId(parsed.session_id), origin)
        .await
    {
        Ok(brief) => {
            if let Some(app) = app {
                let _ = app.emit(
                    "session-unarchived-external",
                    SessionExternalPayload {
                        session: brief.clone(),
                        via: "session.restore",
                    },
                );
            }
            SocketResponse::ok(request_id, serde_json::json!({ "session": brief }))
        }
        Err(e) => map_galley_err(request_id, e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMoveArgs {
    session_id: String,
    /// `None` = detach from any project (move to ungrouped). Matches the
    /// CLI surface where omitting `--to` means "detach".
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    supervisor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

async fn dispatch_session_move(
    request_id: Option<String>,
    args: Value,
    app: Option<&AppHandle>,
) -> SocketResponse {
    let parsed: SessionMoveArgs = match serde_json::from_value(args) {
        Ok(a) => a,
        Err(e) => {
            return SocketResponse::err(
                request_id,
                "invalid_args",
                format!("session.move args: {e}"),
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
    let origin = origin_from_args(parsed.supervisor, parsed.reason);
    match galley
        .assign_session_to_project(SessionId(parsed.session_id), parsed.to, origin)
        .await
    {
        Ok(brief) => {
            if let Some(app) = app {
                let _ = app.emit(
                    "session-moved-external",
                    SessionExternalPayload {
                        session: brief.clone(),
                        via: "session.move",
                    },
                );
            }
            SocketResponse::ok(request_id, serde_json::json!({ "session": brief }))
        }
        Err(e) => map_galley_err(request_id, e),
    }
}

/// Look up an `--llm=<display-name>` against the cached `llm_list` pref
/// (the same key GUI's hydrate.ts seeds after a bridge warmup). Returns
/// `(index, display_name)` on hit; a `SocketResponse` error otherwise.
///
/// Resolution rules (sub-plan §1.7):
///   - `None` input → `Ok((None, None))` — caller didn't supply a flag,
///     bridge uses GA's default at spawn time.
///   - `Some(name)` + cache empty → `invalid_args` "llm cache empty;
///     open Galley GUI once to warmup".
///   - `Some(name)` + cache populated but name absent → `invalid_args`
///     "unknown llm '<name>'".
///   - `Some(name)` + match (case-insensitive) → `Ok((Some(i), Some(n)))`.
async fn resolve_llm_name(
    galley: &SqliteGalley,
    name: Option<String>,
) -> Result<(Option<u32>, Option<String>), SocketResponseLite> {
    let Some(name) = name else {
        return Ok((None, None));
    };
    let cached = match galley.get_pref_json("llm_list").await {
        Ok(v) => v,
        Err(e) => return Err(SocketResponseLite::from_err(e)),
    };
    let entries: Vec<LlmListEntry> = match cached {
        Some(v) => match serde_json::from_value(v) {
            Ok(es) => es,
            Err(e) => {
                return Err(SocketResponseLite::invalid_args(format!(
                    "llm_list pref shape mismatch: {e}"
                )))
            }
        },
        None => Vec::new(),
    };
    if entries.is_empty() {
        return Err(SocketResponseLite::invalid_args(
            "llm cache empty; open Galley GUI once to warmup",
        ));
    }
    let target = name.to_lowercase();
    if let Some(entry) = entries
        .iter()
        .find(|e| e.name.to_lowercase() == target)
    {
        Ok((Some(entry.index), Some(entry.name.clone())))
    } else {
        Err(SocketResponseLite::invalid_args(format!(
            "unknown llm '{name}'; try `galley llm list` to see available"
        )))
    }
}

#[derive(Debug, Deserialize)]
struct LlmListEntry {
    index: u32,
    name: String,
}

/// Carrier for errors raised before we know the request_id — bound to
/// the outer response by [`SocketResponseLite::with_request_id`]. Avoids
/// threading `request_id` through every helper. The "lite" suffix is
/// because the carrier doesn't include the request_id at construction.
enum SocketResponseLite {
    InvalidArgs(String),
    DbUnavailable(String),
    NotFound(String),
    Internal(String),
    RunnerError(String),
}

impl SocketResponseLite {
    fn invalid_args(msg: impl Into<String>) -> Self {
        SocketResponseLite::InvalidArgs(msg.into())
    }
    fn from_err(e: crate::error::GalleyError) -> Self {
        use crate::error::GalleyError;
        match e {
            GalleyError::NotFound { message } => SocketResponseLite::NotFound(message),
            GalleyError::InvalidArgs { message } => SocketResponseLite::InvalidArgs(message),
            GalleyError::DbUnavailable { message } => SocketResponseLite::DbUnavailable(message),
            GalleyError::RunnerError { message } => SocketResponseLite::RunnerError(message),
            GalleyError::Internal { message } => SocketResponseLite::Internal(message),
        }
    }
    fn with_request_id(self, request_id: Option<String>) -> SocketResponse {
        match self {
            SocketResponseLite::InvalidArgs(m) => SocketResponse::err(request_id, "invalid_args", m),
            SocketResponseLite::DbUnavailable(m) => {
                SocketResponse::err(request_id, "db_unavailable", m)
            }
            SocketResponseLite::NotFound(m) => SocketResponse::err(request_id, "not_found", m),
            SocketResponseLite::Internal(m) => SocketResponse::err(request_id, "internal", m),
            SocketResponseLite::RunnerError(m) => SocketResponse::err(request_id, "runner_error", m),
        }
    }
}

/// Mint a session id matching the GUI's `s-<base36-time>-<base36-rand>`
/// shape. Kept here (rather than in `db::SqliteGalley`) because
/// id-minting is a caller concern — `create_session_in_tx` accepts a
/// caller-supplied id and validates the row insert.
fn mint_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Two cheap entropy sources mixed together. Doesn't need to be
    // cryptographically random — collision space within one millisecond
    // for a single user is effectively zero.
    let rand: u64 = {
        let mut x = ts as u64;
        x ^= x.wrapping_mul(0x9E3779B97F4A7C15);
        x ^= x >> 33;
        x ^= x.wrapping_mul(0xC4CEB9FE1A85EC53);
        x
    };
    format!(
        "s-{}-{}",
        radix36(ts as u64),
        &radix36(rand)[..4.min(radix36(rand).len())]
    )
}

fn radix36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::with_capacity(13);
    while n > 0 {
        out.push(ALPHABET[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("radix36 alphabet is ASCII")
}

/// Default title for `session.new` — matches the GUI's localized seed
/// so a CLI-created row + a GUI-created row look identical in the
/// sidebar. The bridge derives a better title after the first turn ends.
const DEFAULT_NEW_SESSION_TITLE: &str = "新对话";

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
