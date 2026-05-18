// Throwaway prototype: Rust-owned Python bridge subprocess.
// See ../README.md for the validation hypothesis and checklist.
//
// Design note: pre-subscribed receiver is held inside BridgeProcess so the
// first event ("ready") isn't lost to a race between the reader task and
// the first subscribe() call. First subscribe() takes that receiver;
// subsequent calls subscribe() fresh on the broadcast channel.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::broadcast;

pub struct BridgeProcess {
    session_id: String,
    child: Child,
    stdin: ChildStdin,
    stdout_tx: broadcast::Sender<String>,
    preload_rx: Option<broadcast::Receiver<String>>,
}

impl BridgeProcess {
    pub async fn spawn(
        session_id: String,
        python: &str,
        ga_path: &Path,
        bridge_cwd: &Path,
    ) -> anyhow::Result<Self> {
        let ga_arg = ga_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("ga_path not utf-8"))?;

        let mut child = Command::new(python)
            .args([
                "-m",
                "bridge.workbench_bridge",
                "--ga-path",
                ga_arg,
                "--session-id",
                &session_id,
            ])
            .current_dir(bridge_cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let (tx, preload_rx) = broadcast::channel::<String>(1024);

        // stdout reader: line-buffered, broadcasts each line as-is.
        let tx_stdout = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        // Best-effort send. send() errors only when there are
                        // no live receivers; we don't care — caller decides
                        // whether to subscribe.
                        let _ = tx_stdout.send(line);
                    }
                    Ok(None) => break,
                    Err(e) => {
                        eprintln!("[bridge stdout read error] {e}");
                        break;
                    }
                }
            }
        });

        // stderr reader: surfaces tracebacks / crash logs to our stderr.
        let sid_for_stderr = session_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                eprintln!("[bridge stderr {sid_for_stderr}] {line}");
            }
        });

        Ok(Self {
            session_id,
            child,
            stdin,
            stdout_tx: tx,
            preload_rx: Some(preload_rx),
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    #[allow(dead_code)]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// First call returns the pre-subscribed receiver (sees every event from
    /// spawn time forward, up to 1024 buffered). Subsequent calls subscribe
    /// fresh — those won't see events before their subscribe point.
    pub fn subscribe(&mut self) -> broadcast::Receiver<String> {
        if let Some(rx) = self.preload_rx.take() {
            return rx;
        }
        self.stdout_tx.subscribe()
    }

    #[allow(dead_code)]
    pub async fn send_command(&mut self, cmd: &str) -> anyhow::Result<()> {
        self.stdin.write_all(cmd.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Await child exit and return its `ExitStatus`. Idempotent — tokio's
    /// `Child::wait()` caches the result so this can be called repeatedly.
    pub async fn wait_exit(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    /// Send `{kind:"shutdown"}` and wait up to 3s for graceful exit.
    /// Drop falls back to kill_on_drop if this returns first.
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        let _ = self.send_command(r#"{"kind":"shutdown"}"#).await;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        Ok(())
    }
}
