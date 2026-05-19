//! Tauri-command surface that wraps [`crate::runner_manager::RunnerManager`].
//!
//! Five `#[tauri::command]`s are registered:
//!
//! 1. [`spawn_runner`] — spawn a new Python runner subprocess + start an
//!    emit task that fans broadcast events to the GUI
//! 2. [`send_to_runner`] — write a typed [`IpcCommand`] to the subprocess
//! 3. [`shutdown_runner`] — graceful shutdown (send `{kind:"shutdown"}` +
//!    wait), with a kill fallback on timeout
//! 4. [`kill_runner`] — immediate SIGKILL (no graceful negotiation)
//! 5. [`runner_stderr_tail`] — pull the last 8 stderr lines for the
//!    abnormal-exit toast
//!
//! ## Event channel contract
//!
//! After [`spawn_runner`] succeeds, a per-session task subscribes to the
//! [`RunnerManager`]'s broadcast and re-emits as Tauri events:
//!
//! | Event name       | Payload                                          |
//! |------------------|--------------------------------------------------|
//! | `runner-event`   | `{ sessionId: string, event: IpcEvent }`        |
//! | `runner-malformed` | `{ sessionId, line }`                          |
//! | `runner-closed`  | `{ sessionId, code: number\|null, signal: null }` |
//!
//! `runner-closed` fires when the broadcast sender drops (= subprocess
//! stdout reached EOF = subprocess exited). `code` is captured if the
//! manager initiated the shutdown / kill (which knows the exit status);
//! otherwise null. `signal` is reserved for future use — Tokio's
//! `ExitStatus` doesn't surface signal numbers portably.
//!
//! Stderr is NOT pushed event-by-event. The TS side pulls the tail buffer
//! via [`runner_stderr_tail`] when it needs to surface a toast — this is
//! the pull-style API decided in [B2 M1 running note N3].
//!
//! ## Error shape
//!
//! Errors return `String` rather than the typed Rust error enum because
//! Tauri commands serialize `Result<T, E>` with `serde_json::to_string` on
//! the error half. The string is the JSON form of the typed error (e.g.
//! `{"error":"python_not_found","detail":"..."}`) so the TS side can
//! parse and pattern-match on the `error` discriminant — same convention
//! as B1's [`list_sessions`].

use crate::ipc::IpcCommand;
use crate::runner_manager::{
    BroadcastItem, RunnerManager, RunnerSpawnError, SendCommandError, ShutdownError, SpawnArgs,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast::error::RecvError;

/// JSON-friendly mirror of [`SpawnArgs`]. The TS side sends camelCase keys
/// (per the broader serde convention used by all our Tauri commands).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRunnerArgs {
    pub python: String,
    pub ga_path: String,
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub bridge_cwd: String,
    #[serde(default)]
    pub llm_index: Option<i64>,
    /// Extra environment variables as a flat list of [key, value] pairs.
    /// (Object form would mean JS could pass a plain Record<string,string>,
    /// which serde would happily parse — but pair-form is unambiguous and
    /// preserves insertion order if that ever matters.)
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// Optional: if Some, the manager treats this id as the
    /// eviction-protected active session for the LRU walk.
    #[serde(default)]
    pub active_session_id: Option<String>,
}

impl From<SpawnRunnerArgs> for SpawnArgs {
    fn from(args: SpawnRunnerArgs) -> Self {
        Self {
            python: args.python,
            ga_path: PathBuf::from(args.ga_path),
            session_id: args.session_id,
            cwd: args.cwd.map(PathBuf::from),
            bridge_cwd: PathBuf::from(args.bridge_cwd),
            llm_index: args.llm_index,
            env: args.env,
        }
    }
}

/// Payload of the `runner-closed` event. Matches the shape the TS-side
/// `BridgeHandlers.onClose` callback expects (`code: number | null,
/// signal: number | null`) for parity with the legacy `plugin-shell`
/// close event.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunnerClosedPayload {
    pub session_id: String,
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// Payload of the `runner-event` envelope.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunnerEventEnvelope {
    pub session_id: String,
    /// Parsed event. Serialized with its `kind` discriminator preserved
    /// (the [`IpcEvent`] enum is tagged via `#[serde(tag = "kind")]`).
    pub event: IpcEvent,
}

/// Payload of the `runner-malformed` event — for stdout lines that didn't
/// parse as JSON (Python tracebacks that escaped the runner's stdout
/// discipline, partial flushes on crash, etc).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunnerMalformedPayload {
    pub session_id: String,
    pub line: String,
}

/// Helper: convert a typed error to its JSON-string form for the Tauri
/// transport. `serde_json::to_string` always succeeds for our typed errors
/// (they have flat shapes); the unwrap-or-fallback is defense in depth.
fn err_to_json<T: Serialize + std::fmt::Display>(e: T) -> String {
    serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
}

#[tauri::command]
pub async fn spawn_runner(
    args: SpawnRunnerArgs,
    manager: State<'_, RunnerManager>,
    app: AppHandle,
) -> Result<u32, String> {
    let active = args.active_session_id.clone();
    let session_id = args.session_id.clone();
    let spawn_args: SpawnArgs = args.into();

    let pid = manager
        .spawn(spawn_args, active.as_deref())
        .await
        .map_err(err_to_json::<RunnerSpawnError>)?;

    // Subscribe BEFORE returning so the receiver is registered against the
    // broadcast channel — guarantees we don't miss the `Ready` event that
    // the subprocess emits ~430ms after spawn. The manager handed us a
    // fresh receiver against the just-installed RunnerProcess; we move it
    // into the long-lived emit task below.
    let rx = manager
        .subscribe(&session_id)
        .await
        .ok_or_else(|| "subscribe failed after spawn (race?)".to_string())?;

    spawn_emit_task(app, session_id.clone(), rx);

    Ok(pid)
}

#[tauri::command]
pub async fn send_to_runner(
    session_id: String,
    command: IpcCommand,
    manager: State<'_, RunnerManager>,
) -> Result<(), String> {
    manager
        .send_command(&session_id, &command)
        .await
        .map_err(err_to_json::<SendCommandError>)
}

#[tauri::command]
pub async fn shutdown_runner(
    session_id: String,
    timeout_ms: Option<u64>,
    manager: State<'_, RunnerManager>,
) -> Result<(), String> {
    let timeout = timeout_ms.map(Duration::from_millis);
    match manager.shutdown(&session_id, timeout).await {
        Ok(()) => Ok(()),
        // NotFound is idempotent-success: the GUI may try to shutdown a
        // session whose runner already crashed; surfacing that as an error
        // would force every caller to ignore one specific variant. Treat
        // as success at the transport boundary instead.
        Err(ShutdownError::NotFound { .. }) => Ok(()),
        Err(e) => Err(err_to_json::<ShutdownError>(e)),
    }
}

#[tauri::command]
pub async fn kill_runner(
    session_id: String,
    manager: State<'_, RunnerManager>,
) -> Result<(), String> {
    // Kill is just shutdown with a near-zero timeout — the manager's
    // shutdown path already falls back to forced kill after the timeout.
    match manager
        .shutdown(&session_id, Some(Duration::from_millis(10)))
        .await
    {
        Ok(()) => Ok(()),
        Err(ShutdownError::NotFound { .. }) => Ok(()),
        Err(e) => Err(err_to_json::<ShutdownError>(e)),
    }
}

/// Tauri's async-command harness requires the return type to be `Result`
/// (so an `Err` short-circuits the JSON envelope). Stderr-tail can't
/// really fail — it just returns an empty Vec for unknown session ids —
/// so the `Err` half is `()` and callers never see it.
#[tauri::command]
pub async fn runner_stderr_tail(
    session_id: String,
    manager: State<'_, RunnerManager>,
) -> Result<Vec<String>, ()> {
    Ok(manager.stderr_tail(&session_id).await.unwrap_or_default())
}

#[tauri::command]
pub async fn shutdown_all_runners(manager: State<'_, RunnerManager>) -> Result<(), String> {
    manager.shutdown_all(Duration::from_secs(5)).await;
    Ok(())
}

/// Background task that subscribes to a session's broadcast and re-emits
/// as Tauri events to the GUI. Lives for the lifetime of the subprocess —
/// when the broadcast channel closes (subprocess exited, all senders
/// dropped) the task emits a final `runner-closed` event and terminates.
fn spawn_emit_task(
    app: AppHandle,
    session_id: String,
    mut rx: tokio::sync::broadcast::Receiver<BroadcastItem>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(BroadcastItem::Event(boxed)) => {
                    let payload = RunnerEventEnvelope {
                        session_id: session_id.clone(),
                        event: *boxed,
                    };
                    let _ = app.emit("runner-event", payload);
                }
                Ok(BroadcastItem::Malformed(line)) => {
                    let payload = RunnerMalformedPayload {
                        session_id: session_id.clone(),
                        line,
                    };
                    let _ = app.emit("runner-malformed", payload);
                }
                Err(RecvError::Lagged(skipped)) => {
                    // Subscriber lagged past the broadcast capacity (1024
                    // events). Surface this as a structured warning event
                    // — the broadcast channel auto-skips, but the GUI
                    // should know it lost data. Re-loop; recv() will
                    // resume from the next live event.
                    eprintln!(
                        "[runner emit {session_id}] subscriber lagged, skipped {skipped} events"
                    );
                    continue;
                }
                Err(RecvError::Closed) => {
                    // Sender dropped — subprocess stdout reached EOF =
                    // the subprocess exited. Emit a final close event.
                    // We don't know the exit code from this side; the
                    // manager's shutdown path captures it but doesn't
                    // (yet) plumb it through to the emit task. Code = None
                    // matches the legacy plugin-shell behavior for
                    // signal-induced kills.
                    let payload = RunnerClosedPayload {
                        session_id: session_id.clone(),
                        code: None,
                        signal: None,
                    };
                    let _ = app.emit("runner-closed", payload);
                    break;
                }
            }
        }
    });
}

// Re-export IpcEvent locally so the envelope type can name it.
use crate::ipc::IpcEvent;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_args_from_json_camelcase() {
        let line = r#"{
            "python": "/usr/bin/python3",
            "gaPath": "/home/u/GA",
            "sessionId": "s1",
            "cwd": null,
            "bridgeCwd": "/repo/runner",
            "llmIndex": 0,
            "env": [["FOO", "bar"]]
        }"#;
        let parsed: SpawnRunnerArgs = serde_json::from_str(line).expect("parse");
        assert_eq!(parsed.session_id, "s1");
        assert_eq!(parsed.bridge_cwd, "/repo/runner");
        assert_eq!(parsed.env, vec![("FOO".to_string(), "bar".to_string())]);
    }

    #[test]
    fn spawn_args_optional_fields_default_correctly() {
        let line = r#"{
            "python": "python3",
            "gaPath": "/ga",
            "sessionId": "s1",
            "bridgeCwd": "/cwd"
        }"#;
        let parsed: SpawnRunnerArgs = serde_json::from_str(line).expect("parse");
        assert!(parsed.cwd.is_none());
        assert!(parsed.llm_index.is_none());
        assert!(parsed.env.is_empty());
        assert!(parsed.active_session_id.is_none());
    }

    #[test]
    fn runner_closed_payload_serializes_camelcase() {
        let p = RunnerClosedPayload {
            session_id: "s1".into(),
            code: Some(0),
            signal: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"sessionId\":\"s1\""));
        assert!(s.contains("\"code\":0"));
        assert!(s.contains("\"signal\":null"));
    }

    #[test]
    fn runner_event_envelope_carries_kind_tag() {
        // The envelope wraps the IpcEvent in `event:` — the inner event
        // must retain its `kind` discriminator (serde tag).
        use crate::ipc::{ReadyEvent, IpcEvent as E};
        let envelope = RunnerEventEnvelope {
            session_id: "s1".into(),
            event: E::Ready(ReadyEvent {
                session_id: "s1".into(),
                protocol_version: "0.1".into(),
                ga_commit: "abc".into(),
                ga_commit_date: "x".into(),
                ga_path: "/".into(),
                llm_name: "l".into(),
                cwd: "/".into(),
                pid: 1,
                available_llms: vec![],
                timestamp: "t".into(),
            }),
        };
        let s = serde_json::to_string(&envelope).unwrap();
        assert!(s.contains("\"sessionId\":\"s1\""));
        assert!(s.contains("\"event\":"));
        assert!(s.contains("\"kind\":\"ready\""));
        assert!(s.contains("\"protocolVersion\":\"0.1\""));
    }
}
