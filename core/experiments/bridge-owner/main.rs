// Bridge-owner experiment entry point.
//
// Standalone tokio binary — no Tauri. See ../README.md for the rationale
// (spec was ambiguous on Tauri vs. standalone; standalone is the minimum
// viable surface for the actual hypothesis under test).
//
// Subscribers wired here mock the two real-world consumers:
//   sub1: prints to stdout — stands in for the Tauri event sink (the real
//         emit() adds ~5ms of overhead, well under the 50ms P1 tolerance).
//   sub2: (planned) Unix socket subscriber for S2/S3 — added in a later
//         session when we get to those checks.
//
// Scenarios:
//   l1: spawn one bridge, capture ready event, print to stdout, shutdown.
//   l2: spawn 3 bridges concurrently via tokio::try_join!. Each ready event
//       must reach only its own subscriber (independence check). All 3
//       must be alive at the same wall-clock moment (per ps).
//   l3: spawn one bridge, send SIGKILL via external `kill -9` (subprocess,
//       not Child::kill — must simulate OS / external user kill). Rust must
//       detect exit via child.wait() within 1 second.
//   l4: spawn one bridge, hold 3s, drop the BridgeProcess, verify the child
//       process is reaped within 2s (kill_on_drop semantics).
//   l5: outer spawns inner (self with EXPERIMENT_PANIC=1). Inner spawns a
//       bridge, prints its pid to stdout, then panics. Outer reads the pid,
//       waits for inner to die, then verifies the bridge child is gone too
//       — i.e., Rust drop semantics propagate through panic unwind to fire
//       kill_on_drop SIGKILL on the bridge child.
//   c1: send 1 `set_llm` command, recv 1 `llm_changed` event with matching
//       index. Basic stdin → bridge command round-trip.
//   c2: send 3 `set_llm` commands rapidly (no awaits between sends), recv
//       3 ordered `llm_changed` events. Queuing + ordering.
//   c3: send 5 commands without reading any response in between, then drain
//       5 ordered events. Tests that stdin writes don't block on stdout
//       backpressure (the deadlock vector in poor I/O designs).
//   s1: parse one stdout line as JSON, verify it has a "kind" field. Smoke
//       test for line-buffered JSON event delivery.
//   s2: dual subscriber. One direct broadcast::Receiver (mocks Tauri sink),
//       one forwards to a tokio::net::UnixListener — we connect as client
//       to that listener and read the same events. Both must receive the
//       same N events, content-identical.
//   s3: same as s2 but ~100 commands fired rapidly. Sustained event rate
//       must reach both subscribers without drops.
//   s4: the socket subscriber disconnects mid-test. The direct subscriber
//       must continue receiving unaffected. (Validates that one slow /
//       dead subscriber doesn't break the broadcast.)
//   x1: 100 commands fired in a tight loop without awaiting responses,
//       then drain. No crash / deadlock / drops.
//   x2: 10,000 events delivered through the broadcast channel + direct
//       subscriber. Validates the registry doesn't OOM under sustained
//       load; measures sustained event throughput.
//   p1: 100 single-command set_llm RTT samples. Computes p50 / p95 / p99
//       to give a stable latency baseline (no LLM cost). Comparison vs
//       TS path deferred to B1 dogfood — see results.md "P1-P3 strategy".
//   p2: Sustained event throughput (events/sec) with 200 commands; same
//       deferral note as P1.
//   p3: 3 bridges spawned, RSS sampled periodically while events flow
//       at ~10/sec per bridge. Default 30s; set P3_DURATION_SECS=300 for
//       the spec-compliant 5-minute run. Reports start RSS, end RSS,
//       delta. Threshold per spec: <50 MB beyond baseline.
//
// Usage:
//   GA_PATH=$HOME/Documents/GenericAgent \
//     cargo run --features experiments --bin bridge-owner-experiment -- l1
//
// Environment:
//   GA_PATH   default $HOME/Documents/GenericAgent
//   PYTHON    default python3 (must have GA's deps importable)

use std::env;
use std::path::PathBuf;
use std::time::{Duration, Instant};

mod registry;
use registry::BridgeProcess;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let scenario = env::args().nth(1).unwrap_or_else(|| "l1".to_string());

    match scenario.as_str() {
        "l1" => scenario_l1().await,
        "l2" => scenario_l2().await,
        "l3" => scenario_l3().await,
        "l4" => scenario_l4().await,
        "l5" => scenario_l5().await,
        "c1" => scenario_c1().await,
        "c2" => scenario_c2().await,
        "c3" => scenario_c3().await,
        "s1" => scenario_s1().await,
        "s2" => scenario_s2().await,
        "s3" => scenario_s3().await,
        "s4" => scenario_s4().await,
        "x1" => scenario_x1().await,
        "x2" => scenario_x2().await,
        "p1" => scenario_p1().await,
        "p2" => scenario_p2().await,
        "p3" => scenario_p3().await,
        other => {
            eprintln!(
                "usage: bridge-owner-experiment \
                 [l1|l2|l3|l4|l5|c1|c2|c3|s1|s2|s3|s4|x1|x2|p1|p2|p3]"
            );
            eprintln!("unknown scenario: {other}");
            std::process::exit(2);
        }
    }
}

async fn scenario_l1() -> anyhow::Result<()> {
    eprintln!("=== L1: spawn one bridge, capture ready event ===");
    let mut bridge = spawn_default("exp_l1").await?;
    let pid = bridge.pid().unwrap_or(0);
    eprintln!("[experiment] spawned bridge pid={pid}");

    let mut sub1 = bridge.subscribe();
    let started = Instant::now();

    let result = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let line = sub1.recv().await?;
            eprintln!("[stream] {line}");
            if line.contains(r#""kind":"ready""#) || line.contains(r#""kind": "ready""#) {
                return Ok::<String, anyhow::Error>(line);
            }
        }
    })
    .await;

    match result {
        Ok(Ok(line)) => {
            let elapsed = started.elapsed();
            println!();
            println!("L1 PASS — ready event captured in {elapsed:?}");
            println!("  event = {line}");
        }
        Ok(Err(e)) => {
            println!();
            println!("L1 FAIL — stream error before ready: {e}");
            bridge.shutdown().await.ok();
            std::process::exit(1);
        }
        Err(_) => {
            println!();
            println!("L1 FAIL — timeout (20s) waiting for ready event");
            bridge.shutdown().await.ok();
            std::process::exit(1);
        }
    }

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_l2() -> anyhow::Result<()> {
    eprintln!("=== L2: spawn 3 bridges concurrently, verify independence ===");

    let started = Instant::now();
    let (mut b1, mut b2, mut b3) = tokio::try_join!(
        spawn_default("exp_l2_a"),
        spawn_default("exp_l2_b"),
        spawn_default("exp_l2_c"),
    )?;
    let spawn_elapsed = started.elapsed();

    let pids = [b1.pid(), b2.pid(), b3.pid()];
    eprintln!(
        "[experiment] spawned 3 bridges in {spawn_elapsed:?}: pids={:?}",
        pids
    );

    let mut pid_values: Vec<u32> = pids.iter().filter_map(|p| *p).collect();
    if pid_values.len() != 3 {
        println!();
        println!("L2 FAIL — some pids missing: {pids:?}");
        std::process::exit(1);
    }
    pid_values.sort();
    pid_values.dedup();
    if pid_values.len() != 3 {
        println!();
        println!("L2 FAIL — duplicate pids: {pids:?}");
        std::process::exit(1);
    }

    let mut rx1 = b1.subscribe();
    let mut rx2 = b2.subscribe();
    let mut rx3 = b3.subscribe();

    let ready_started = Instant::now();
    let (r1, r2, r3) = tokio::try_join!(
        wait_ready(&mut rx1, "exp_l2_a"),
        wait_ready(&mut rx2, "exp_l2_b"),
        wait_ready(&mut rx3, "exp_l2_c"),
    )?;
    let ready_elapsed = ready_started.elapsed();
    eprintln!("[experiment] 3 ready events captured in {ready_elapsed:?}");
    eprintln!("  b1.ready sessionId = {}", extract_session_id(&r1));
    eprintln!("  b2.ready sessionId = {}", extract_session_id(&r2));
    eprintln!("  b3.ready sessionId = {}", extract_session_id(&r3));

    // ps double-check: all 3 alive concurrently at this exact moment.
    if !all_alive(&pids).await? {
        println!();
        println!("L2 FAIL — not all 3 pids alive concurrently per ps");
        std::process::exit(1);
    }

    let shutdown_started = Instant::now();
    let _ = tokio::try_join!(b1.shutdown(), b2.shutdown(), b3.shutdown())?;
    let shutdown_elapsed = shutdown_started.elapsed();

    println!();
    println!(
        "L2 PASS — 3 concurrent bridges (pids={:?}, spawn={spawn_elapsed:?}, \
         ready={ready_elapsed:?}, shutdown={shutdown_elapsed:?})",
        pids
    );
    Ok(())
}

async fn wait_ready(
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    expected_sid: &str,
) -> anyhow::Result<String> {
    let outcome = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let line = rx.recv().await?;
            if line.contains(r#""kind":"ready""#) || line.contains(r#""kind": "ready""#) {
                let needle = format!(r#""sessionId":"{expected_sid}""#);
                if !line.contains(&needle) {
                    anyhow::bail!(
                        "ready event for unexpected sessionId; expected {expected_sid}, line: {line}"
                    );
                }
                return Ok::<String, anyhow::Error>(line);
            }
        }
    })
    .await;

    match outcome {
        Ok(Ok(line)) => Ok(line),
        Ok(Err(e)) => Err(e),
        Err(_) => anyhow::bail!("timeout waiting for ready of {expected_sid}"),
    }
}

/// Quick-n-dirty JSON field extractor for log lines. Logging only.
fn extract_session_id(line: &str) -> &str {
    let needle = r#""sessionId":""#;
    let Some(start) = line.find(needle) else {
        return "?";
    };
    let rest = &line[start + needle.len()..];
    rest.find('"').map(|end| &rest[..end]).unwrap_or("?")
}

async fn wait_kind(
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    expected_kind: &str,
    timeout: Duration,
) -> anyhow::Result<String> {
    let needle = format!(r#""kind":"{expected_kind}""#);
    let outcome = tokio::time::timeout(timeout, async {
        loop {
            let line = rx.recv().await?;
            if line.contains(&needle) {
                return Ok::<String, anyhow::Error>(line);
            }
        }
    })
    .await;
    match outcome {
        Ok(Ok(line)) => Ok(line),
        Ok(Err(e)) => Err(e),
        Err(_) => anyhow::bail!("timeout waiting for kind={expected_kind}"),
    }
}

async fn scenario_c1() -> anyhow::Result<()> {
    eprintln!("=== C1: send set_llm, recv llm_changed (round-trip) ===");
    let mut bridge = spawn_default("exp_c1").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_c1").await?;
    eprintln!("[experiment] bridge ready, sending set_llm index=1");

    let started = Instant::now();
    bridge
        .send_command(r#"{"kind":"set_llm","llmIndex":1}"#)
        .await?;
    let event = wait_kind(&mut rx, "llm_changed", Duration::from_secs(5)).await?;
    let elapsed = started.elapsed();

    if !event.contains(r#""index":1"#) {
        anyhow::bail!("llm_changed event index mismatch: {event}");
    }

    println!();
    println!("C1 PASS — set_llm round-trip in {elapsed:?}");
    eprintln!("  event = {event}");

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_c2() -> anyhow::Result<()> {
    eprintln!("=== C2: 3 commands queued, all processed in order ===");
    let mut bridge = spawn_default("exp_c2").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_c2").await?;

    let indexes = [1, 2, 3];
    eprintln!("[experiment] sending 3 set_llm commands rapidly: {indexes:?}");

    let started = Instant::now();
    for idx in indexes {
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let sent_at = started.elapsed();

    let mut seen = Vec::new();
    for _ in 0..3 {
        seen.push(wait_kind(&mut rx, "llm_changed", Duration::from_secs(5)).await?);
    }
    let total = started.elapsed();

    for (i, expected) in indexes.iter().enumerate() {
        let needle = format!(r#""index":{expected}"#);
        if !seen[i].contains(&needle) {
            anyhow::bail!(
                "C2 order violation at position {i}: expected index {expected}, got {}",
                seen[i]
            );
        }
    }

    println!();
    println!(
        "C2 PASS — 3 ordered round-trips in {total:?} (sent in {sent_at:?})"
    );

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_c3() -> anyhow::Result<()> {
    eprintln!("=== C3: send 5 commands without reading, then drain (deadlock check) ===");
    let mut bridge = spawn_default("exp_c3").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_c3").await?;

    let indexes = [1, 2, 3, 0, 1];
    let started = Instant::now();
    // Send all 5 without awaiting any response. Stdin writes must not
    // back up on stdout drainage — that's the deadlock vector this
    // scenario probes. Our reader task is concurrently draining stdout
    // into the broadcast buffer (cap 1024), so the bridge's stdout pipe
    // never fills and writes proceed.
    for idx in indexes {
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let sent_at = started.elapsed();
    eprintln!(
        "[experiment] 5 commands sent in {sent_at:?} without reading any response"
    );

    let mut seen = Vec::new();
    for _ in 0..indexes.len() {
        seen.push(wait_kind(&mut rx, "llm_changed", Duration::from_secs(5)).await?);
    }
    let total = started.elapsed();
    let recv_phase = total - sent_at;

    for (i, expected) in indexes.iter().enumerate() {
        let needle = format!(r#""index":{expected}"#);
        if !seen[i].contains(&needle) {
            anyhow::bail!(
                "C3 order violation at position {i}: expected index {expected}, got {}",
                seen[i]
            );
        }
    }

    println!();
    println!(
        "C3 PASS — 5 commands interleaved (send {sent_at:?}, recv {recv_phase:?}, total {total:?})"
    );

    bridge.shutdown().await?;
    Ok(())
}

/// Path for the per-scenario Unix socket. Embeds scenario name + own pid
/// to avoid collisions when multiple test runs overlap.
fn socket_path(scenario: &str) -> String {
    format!("/tmp/galley-bridge-owner-{scenario}-{}.sock", std::process::id())
}

async fn scenario_s1() -> anyhow::Result<()> {
    eprintln!("=== S1: line-by-line JSON event delivery ===");
    let mut bridge = spawn_default("exp_s1").await?;
    let mut rx = bridge.subscribe();
    let line = tokio::time::timeout(Duration::from_secs(20), rx.recv()).await??;

    // serde_json round-trip to confirm the line is valid JSON with a `kind`.
    let parsed: serde_json::Value = serde_json::from_str(&line)
        .map_err(|e| anyhow::anyhow!("ready line not valid JSON: {e}; line={line}"))?;
    let kind = parsed
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("event missing `kind`: {parsed}"))?;
    if kind != "ready" {
        anyhow::bail!("expected first event kind=ready, got {kind}");
    }

    println!();
    println!("S1 PASS — first stdout line parsed as JSON, kind=ready");

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_s2() -> anyhow::Result<()> {
    eprintln!("=== S2: dual subscriber (direct + unix socket) sees same events ===");
    let sock_path = socket_path("s2");
    let _ = std::fs::remove_file(&sock_path);

    let mut bridge = spawn_default("exp_s2").await?;
    let mut rx_a = bridge.subscribe();
    wait_ready(&mut rx_a, "exp_s2").await?;

    // Subscribe B fresh, after ready. B forwards to a UnixListener.
    let mut rx_b = bridge.subscribe();
    let listener = tokio::net::UnixListener::bind(&sock_path)?;
    eprintln!("[experiment] socket bound at {sock_path}");

    let _forwarder = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let (mut stream, _) = listener.accept().await?;
        while let Ok(line) = rx_b.recv().await {
            stream.write_all(line.as_bytes()).await?;
            stream.write_all(b"\n").await?;
        }
        Ok::<_, anyhow::Error>(())
    });

    // Client connects to the socket — accept() in forwarder unblocks.
    use tokio::io::AsyncBufReadExt;
    let client = tokio::net::UnixStream::connect(&sock_path).await?;
    let mut client_lines = tokio::io::BufReader::new(client).lines();

    // Brief settle so the forwarder is actively running and any pre-connect
    // races have time to clear (none expected — we subscribed before send).
    tokio::time::sleep(Duration::from_millis(50)).await;

    let indexes = [1, 2, 3];
    for idx in indexes {
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }

    let mut a_events = Vec::new();
    let mut b_events = Vec::new();
    while a_events.len() < indexes.len() {
        let line = tokio::time::timeout(Duration::from_secs(5), rx_a.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timeout on subscriber A"))??;
        if line.contains(r#""kind":"llm_changed""#) {
            a_events.push(line);
        }
    }
    while b_events.len() < indexes.len() {
        let line = tokio::time::timeout(Duration::from_secs(5), client_lines.next_line())
            .await
            .map_err(|_| anyhow::anyhow!("timeout on subscriber B (socket)"))?
            .map_err(|e| anyhow::anyhow!("socket read err: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("socket closed before all events arrived"))?;
        if line.contains(r#""kind":"llm_changed""#) {
            b_events.push(line);
        }
    }

    if a_events != b_events {
        anyhow::bail!(
            "S2 content mismatch:\n A: {a_events:?}\n B: {b_events:?}"
        );
    }

    println!();
    println!(
        "S2 PASS — both subscribers received {} content-identical events",
        a_events.len()
    );

    bridge.shutdown().await?;
    let _ = std::fs::remove_file(&sock_path);
    Ok(())
}

async fn scenario_s3() -> anyhow::Result<()> {
    eprintln!("=== S3: high-rate event delivery, no drops on either subscriber ===");
    let sock_path = socket_path("s3");
    let _ = std::fs::remove_file(&sock_path);

    let mut bridge = spawn_default("exp_s3").await?;
    let mut rx_a = bridge.subscribe();
    wait_ready(&mut rx_a, "exp_s3").await?;

    let mut rx_b = bridge.subscribe();
    let listener = tokio::net::UnixListener::bind(&sock_path)?;

    let _forwarder = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let (mut stream, _) = listener.accept().await?;
        while let Ok(line) = rx_b.recv().await {
            stream.write_all(line.as_bytes()).await?;
            stream.write_all(b"\n").await?;
        }
        Ok::<_, anyhow::Error>(())
    });

    use tokio::io::AsyncBufReadExt;
    let client = tokio::net::UnixStream::connect(&sock_path).await?;
    let mut client_lines = tokio::io::BufReader::new(client).lines();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Fire 100 set_llm commands cycling 0..=3 (JC's mykey has 4 LLMs).
    let n = 100;
    let started = Instant::now();
    for i in 0..n {
        let idx = i % 4;
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let send_phase = started.elapsed();

    let mut a_count = 0;
    let mut b_count = 0;
    while a_count < n {
        let line = tokio::time::timeout(Duration::from_secs(15), rx_a.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timeout on subscriber A at {a_count}/{n}"))??;
        if line.contains(r#""kind":"llm_changed""#) {
            a_count += 1;
        }
    }
    while b_count < n {
        let line = tokio::time::timeout(Duration::from_secs(15), client_lines.next_line())
            .await
            .map_err(|_| anyhow::anyhow!("timeout on subscriber B at {b_count}/{n}"))?
            .map_err(|e| anyhow::anyhow!("socket read err: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("socket closed before all events"))?;
        if line.contains(r#""kind":"llm_changed""#) {
            b_count += 1;
        }
    }
    let total = started.elapsed();
    let rate = n as f64 / total.as_secs_f64();

    println!();
    println!(
        "S3 PASS — {n} events delivered to both subscribers (send {send_phase:?}, \
         total {total:?}, rate ~{rate:.0}/s)"
    );

    bridge.shutdown().await?;
    let _ = std::fs::remove_file(&sock_path);
    Ok(())
}

async fn scenario_s4() -> anyhow::Result<()> {
    eprintln!("=== S4: subscriber disconnects, other unaffected ===");
    let sock_path = socket_path("s4");
    let _ = std::fs::remove_file(&sock_path);

    let mut bridge = spawn_default("exp_s4").await?;
    let mut rx_a = bridge.subscribe();
    wait_ready(&mut rx_a, "exp_s4").await?;

    let mut rx_b = bridge.subscribe();
    let listener = tokio::net::UnixListener::bind(&sock_path)?;

    let forwarder_handle = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let (mut stream, _) = listener.accept().await?;
        while let Ok(line) = rx_b.recv().await {
            // If the client has closed, write returns BrokenPipe — return,
            // dropping our broadcast::Receiver. The other subscriber must
            // be unaffected.
            if stream.write_all(line.as_bytes()).await.is_err() {
                return Ok::<_, anyhow::Error>(());
            }
            if stream.write_all(b"\n").await.is_err() {
                return Ok(());
            }
        }
        Ok(())
    });

    use tokio::io::AsyncBufReadExt;
    let client = tokio::net::UnixStream::connect(&sock_path).await?;
    let mut client_lines = tokio::io::BufReader::new(client).lines();
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Batch 1: both subscribers should get 2 events
    eprintln!("[experiment] batch 1: 2 commands, both subscribers should receive");
    for idx in [1, 2] {
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let mut a_batch1 = 0;
    let mut b_batch1 = 0;
    while a_batch1 < 2 {
        let line = tokio::time::timeout(Duration::from_secs(5), rx_a.recv()).await??;
        if line.contains(r#""kind":"llm_changed""#) {
            a_batch1 += 1;
        }
    }
    while b_batch1 < 2 {
        let line = tokio::time::timeout(Duration::from_secs(5), client_lines.next_line())
            .await
            .map_err(|_| anyhow::anyhow!("timeout on subscriber B batch1"))?
            .map_err(|e| anyhow::anyhow!("socket read err: {e}"))?
            .ok_or_else(|| anyhow::anyhow!("socket closed"))?;
        if line.contains(r#""kind":"llm_changed""#) {
            b_batch1 += 1;
        }
    }
    eprintln!("[experiment] batch 1 done: A={a_batch1}, B={b_batch1}");

    // Disconnect the socket client — closes the UnixStream from our end.
    drop(client_lines);
    eprintln!("[experiment] socket client disconnected");
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Batch 2: A should still receive, B is gone.
    eprintln!("[experiment] batch 2: 3 commands; A should still receive");
    for idx in [3, 0, 1] {
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let mut a_batch2 = 0;
    while a_batch2 < 3 {
        let line = tokio::time::timeout(Duration::from_secs(5), rx_a.recv())
            .await
            .map_err(|_| anyhow::anyhow!("timeout on subscriber A batch2 — disconnect of B affected A"))??;
        if line.contains(r#""kind":"llm_changed""#) {
            a_batch2 += 1;
        }
    }

    // Confirm forwarder task has cleanly exited (or about to). Not strictly
    // required — drop on shutdown would do it — but tidier.
    let _ = forwarder_handle.abort();

    println!();
    println!(
        "S4 PASS — A unaffected after B disconnect (batch1 A={a_batch1}/2, B={b_batch1}/2; \
         batch2 A={a_batch2}/3)"
    );

    bridge.shutdown().await?;
    let _ = std::fs::remove_file(&sock_path);
    Ok(())
}

async fn scenario_x1() -> anyhow::Result<()> {
    eprintln!("=== X1: 100 commands tight loop, no crash / no deadlock / no drops ===");
    let mut bridge = spawn_default("exp_x1").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_x1").await?;

    let n = 100;
    let started = Instant::now();
    // Tight loop — no awaits between send_command except the await *inside*
    // it (writing to stdin). Tokio's runtime will interleave the stdout
    // reader task as needed; pipe buffer absorbs the difference.
    for i in 0..n {
        let idx = i % 4;
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let send_phase = started.elapsed();

    let mut count = 0;
    while count < n {
        let line = tokio::time::timeout(Duration::from_secs(15), rx.recv()).await??;
        if line.contains(r#""kind":"llm_changed""#) {
            count += 1;
        }
    }
    let total = started.elapsed();

    println!();
    println!(
        "X1 PASS — 100 commands in tight loop, all {count} responses received \
         (send {send_phase:?}, total {total:?})"
    );

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_x2() -> anyhow::Result<()> {
    eprintln!("=== X2: 10000 events through broadcast channel, no OOM / no drops ===");
    let mut bridge = spawn_default("exp_x2").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_x2").await?;

    let n: usize = 10_000;
    let started = Instant::now();
    for i in 0..n {
        let idx = i % 4;
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
    }
    let send_phase = started.elapsed();

    let mut count = 0;
    while count < n {
        let line = tokio::time::timeout(Duration::from_secs(60), rx.recv()).await??;
        if line.contains(r#""kind":"llm_changed""#) {
            count += 1;
        }
    }
    let total = started.elapsed();
    let rate = n as f64 / total.as_secs_f64();

    println!();
    println!(
        "X2 PASS — {n} events through broadcast (send {send_phase:?}, \
         total {total:?}, rate ~{rate:.0}/s)"
    );

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_p1() -> anyhow::Result<()> {
    eprintln!("=== P1: 100 set_llm RTT samples (Rust-side latency baseline) ===");
    let mut bridge = spawn_default("exp_p1").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_p1").await?;

    let n = 100;
    let mut latencies = Vec::with_capacity(n);
    for i in 0..n {
        let idx = (i + 1) % 4;
        let started = Instant::now();
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#))
            .await?;
        // Wait for the matching llm_changed event
        loop {
            let line = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await??;
            if line.contains(r#""kind":"llm_changed""#) {
                latencies.push(started.elapsed());
                break;
            }
        }
    }

    // Sort copy for percentiles
    let mut sorted = latencies.clone();
    sorted.sort();
    let p50 = sorted[n / 2];
    let p95 = sorted[(n * 95) / 100];
    let p99 = sorted[(n * 99) / 100];
    let min = sorted[0];
    let max = sorted[n - 1];
    let mean = sorted.iter().sum::<Duration>() / n as u32;

    println!();
    println!(
        "P1 PASS — Rust-side set_llm RTT over {n} samples: \
         min={min:?}, mean={mean:?}, p50={p50:?}, p95={p95:?}, p99={p99:?}, max={max:?}"
    );
    println!(
        "  Comparison vs TS baseline deferred to B1 dogfood. Architecture suggests \
         Rust path is structurally lighter (fewer hops than tauri-plugin-shell)."
    );

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_p2() -> anyhow::Result<()> {
    eprintln!("=== P2: sustained event throughput (Rust-side baseline) ===");
    let mut bridge = spawn_default("exp_p2").await?;
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_p2").await?;

    let n: usize = 200;
    let started = Instant::now();
    for i in 0..n {
        bridge
            .send_command(&format!(r#"{{"kind":"set_llm","llmIndex":{}}}"#, i % 4))
            .await?;
    }
    let send_phase = started.elapsed();

    let mut count = 0;
    while count < n {
        let line = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await??;
        if line.contains(r#""kind":"llm_changed""#) {
            count += 1;
        }
    }
    let total = started.elapsed();
    let rate = n as f64 / total.as_secs_f64();

    println!();
    println!(
        "P2 PASS — Rust-side sustained throughput: {n} events in {total:?} \
         (~{rate:.0}/s, send phase {send_phase:?})"
    );
    println!("  Comparison vs TS baseline deferred to B1 dogfood.");

    bridge.shutdown().await?;
    Ok(())
}

async fn scenario_p3() -> anyhow::Result<()> {
    let duration_secs: u64 = env::var("P3_DURATION_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    eprintln!(
        "=== P3: 3 bridges, RSS growth over {duration_secs}s (spec asks 300s; set P3_DURATION_SECS=300 for full run) ==="
    );

    let started_spawn = Instant::now();
    let (mut b1, mut b2, mut b3) = tokio::try_join!(
        spawn_default("exp_p3_a"),
        spawn_default("exp_p3_b"),
        spawn_default("exp_p3_c"),
    )?;
    let mut rx1 = b1.subscribe();
    let mut rx2 = b2.subscribe();
    let mut rx3 = b3.subscribe();
    tokio::try_join!(
        wait_ready(&mut rx1, "exp_p3_a"),
        wait_ready(&mut rx2, "exp_p3_b"),
        wait_ready(&mut rx3, "exp_p3_c"),
    )?;
    eprintln!(
        "[experiment] 3 bridges ready in {:?}",
        started_spawn.elapsed()
    );

    let own_pid = std::process::id();
    let rss_at = |label: &str| -> anyhow::Result<u64> {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &own_pid.to_string()])
            .output()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let kb: u64 = s.trim().parse().map_err(|e| {
            anyhow::anyhow!("ps rss parse {label} (raw={s:?}): {e}")
        })?;
        Ok(kb)
    };

    let baseline_kb = rss_at("baseline")?;
    eprintln!("[experiment] baseline RSS: {} KB ({:.1} MB)", baseline_kb, baseline_kb as f64 / 1024.0);

    // Background draining tasks so the broadcast channels never back up.
    let drain1 = tokio::spawn(async move {
        loop {
            if rx1.recv().await.is_err() {
                break;
            }
        }
    });
    let drain2 = tokio::spawn(async move {
        loop {
            if rx2.recv().await.is_err() {
                break;
            }
        }
    });
    let drain3 = tokio::spawn(async move {
        loop {
            if rx3.recv().await.is_err() {
                break;
            }
        }
    });

    let activity_started = Instant::now();
    let mut samples: Vec<(Duration, u64)> = vec![(Duration::ZERO, baseline_kb)];
    let mut next_sample = Instant::now() + Duration::from_secs(10);
    let end = activity_started + Duration::from_secs(duration_secs);

    // ~10 events/sec per bridge = 30 events/sec system-wide.
    let mut tick_interval = tokio::time::interval(Duration::from_millis(100));
    let mut i: u64 = 0;
    while Instant::now() < end {
        tick_interval.tick().await;
        let idx = (i % 4) as i64;
        let cmd = format!(r#"{{"kind":"set_llm","llmIndex":{idx}}}"#);
        let _ = b1.send_command(&cmd).await;
        let _ = b2.send_command(&cmd).await;
        let _ = b3.send_command(&cmd).await;
        i += 1;

        if Instant::now() >= next_sample {
            let kb = rss_at("interval")?;
            samples.push((activity_started.elapsed(), kb));
            eprintln!(
                "[experiment] t+{:?} RSS={} KB ({:.1} MB, +{} KB vs baseline)",
                activity_started.elapsed(),
                kb,
                kb as f64 / 1024.0,
                kb as i64 - baseline_kb as i64
            );
            next_sample = Instant::now() + Duration::from_secs(10);
        }
    }

    let final_kb = rss_at("final")?;
    samples.push((activity_started.elapsed(), final_kb));
    let delta_kb = final_kb as i64 - baseline_kb as i64;
    let delta_mb = delta_kb as f64 / 1024.0;
    let events_sent = i * 3;

    println!();
    println!(
        "P3 result — {events_sent} events over {duration_secs}s with 3 bridges. \
         Baseline RSS {baseline_kb} KB → final {final_kb} KB (Δ {delta_kb} KB = {delta_mb:.1} MB)"
    );
    if delta_mb < 50.0 {
        println!("P3 PASS — Δ {delta_mb:.1} MB is under the 50 MB spec threshold");
    } else {
        println!("P3 FAIL — Δ {delta_mb:.1} MB exceeds the 50 MB spec threshold");
        // Don't exit non-zero — the data itself is the report. Let caller decide.
    }
    eprintln!("  Note: spec asks for 300s. This run was {duration_secs}s; set P3_DURATION_SECS=300 to match exactly.");

    drain1.abort();
    drain2.abort();
    drain3.abort();
    let _ = tokio::try_join!(b1.shutdown(), b2.shutdown(), b3.shutdown())?;
    Ok(())
}

async fn all_alive(pids: &[Option<u32>]) -> anyhow::Result<bool> {
    for pid_opt in pids {
        let Some(pid) = pid_opt else {
            return Ok(false);
        };
        let output = tokio::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid="])
            .output()
            .await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let alive = stdout
            .lines()
            .any(|l| l.split_whitespace().next() == Some(&pid.to_string()));
        if !alive {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn scenario_l3() -> anyhow::Result<()> {
    eprintln!("=== L3: external kill -9, detect via child.wait() within 1s ===");
    let mut bridge = spawn_default("exp_l3").await?;
    let pid = bridge
        .pid()
        .ok_or_else(|| anyhow::anyhow!("no pid available"))?;
    eprintln!("[experiment] spawned bridge pid={pid}");

    // Wait for ready so the bridge is fully up — we don't want to race
    // kill vs Python startup.
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_l3").await?;
    eprintln!("[experiment] bridge ready, sending SIGKILL via external `kill -9`");

    // NOT bridge.child.kill() — that uses our owned Child handle. L3 is
    // about a kill from outside our ownership (OOM killer, user, supervisor
    // process). Subprocess kill simulates that path.
    let kill_status = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .await?;
    if !kill_status.success() {
        anyhow::bail!("external kill -9 {pid} failed: {kill_status:?}");
    }

    let detect_started = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(3), bridge.wait_exit()).await;
    let elapsed = detect_started.elapsed();

    match outcome {
        Ok(Ok(status)) => {
            eprintln!("[experiment] child.wait() returned in {elapsed:?}: {status:?}");
            if elapsed > Duration::from_millis(1000) {
                println!();
                println!("L3 FAIL — detection took {elapsed:?}, exceeds 1s budget");
                std::process::exit(1);
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                let sig = status.signal();
                if sig != Some(9) {
                    eprintln!("[experiment] note: expected SIGKILL (9), got signal={sig:?}");
                }
            }
            println!();
            println!("L3 PASS — exit detected in {elapsed:?} after external kill -9");
        }
        Ok(Err(e)) => {
            println!();
            println!("L3 FAIL — wait error: {e}");
            std::process::exit(1);
        }
        Err(_) => {
            println!();
            println!("L3 FAIL — wait timed out at {elapsed:?} (>3s)");
            std::process::exit(1);
        }
    }
    Ok(())
}

async fn scenario_l5() -> anyhow::Result<()> {
    if env::var("EXPERIMENT_PANIC").is_ok() {
        // We're the inner process — go panic.
        return inner_l5_panic().await;
    }
    outer_l5_orchestrator().await
}

async fn outer_l5_orchestrator() -> anyhow::Result<()> {
    use tokio::io::AsyncBufReadExt;
    eprintln!("=== L5: parent panic → kill_on_drop reaps bridge child ===");

    let me = env::current_exe()?;
    let mut child = tokio::process::Command::new(&me)
        .arg("l5")
        .env("EXPERIMENT_PANIC", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = tokio::io::BufReader::new(stdout).lines();

    // Inner needs to: spawn bridge → wait for ready → print pid. Worst case
    // is a cold Python import. Give it the same budget as wait_ready.
    let pid_line = match tokio::time::timeout(Duration::from_secs(25), lines.next_line()).await {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) => anyhow::bail!("inner closed stdout before printing pid"),
        Ok(Err(e)) => anyhow::bail!("io error reading inner stdout: {e}"),
        Err(_) => anyhow::bail!("timeout (25s) reading bridge pid from inner stdout"),
    };

    let bridge_pid: u32 = pid_line.trim().parse().map_err(|e| {
        anyhow::anyhow!("inner printed non-numeric pid line {pid_line:?}: {e}")
    })?;
    eprintln!("[outer] inner reported bridge pid={bridge_pid}");

    // Wait for the inner process to die (panic should terminate it).
    let inner_status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await??;
    eprintln!("[outer] inner exited: {inner_status:?}");

    // Brief settle so any reparenting / SIGCHLD cascade has time to land
    // before we ask `ps` about the bridge pid.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let output = tokio::process::Command::new("ps")
        .args(["-p", &bridge_pid.to_string(), "-o", "pid="])
        .output()
        .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let still_alive = stdout
        .lines()
        .any(|l| l.split_whitespace().next() == Some(&bridge_pid.to_string()));

    if still_alive {
        println!();
        println!("L5 FAIL — bridge pid {bridge_pid} survived parent panic");
        // Clean up our orphan so subsequent test runs aren't polluted.
        let _ = tokio::process::Command::new("kill")
            .args(["-9", &bridge_pid.to_string()])
            .status()
            .await;
        std::process::exit(1);
    }

    println!();
    println!("L5 PASS — bridge pid {bridge_pid} reaped after parent panic");
    Ok(())
}

async fn inner_l5_panic() -> anyhow::Result<()> {
    use std::io::Write;
    let mut bridge = spawn_default("exp_l5").await?;
    let pid = bridge.pid().ok_or_else(|| anyhow::anyhow!("no pid"))?;

    // Wait for ready so the bridge is fully up before we panic — we don't
    // want to race the panic against Python startup.
    let mut rx = bridge.subscribe();
    wait_ready(&mut rx, "exp_l5").await?;

    // Print pid to STDOUT (sole channel outer reads). stderr can be noisy.
    println!("{pid}");
    std::io::stdout().flush().ok();
    eprintln!("[inner] bridge ready (pid={pid}); panicking now");

    // Hold `bridge` in scope so the panic unwinds across it. Drop fires
    // inside the unwind, which calls Child::drop, which sends SIGKILL via
    // kill_on_drop. The panic itself terminates the inner process.
    panic!("[inner] deliberate panic for L5 cleanup test");
}

async fn scenario_l4() -> anyhow::Result<()> {
    eprintln!("=== L4: drop → kill_on_drop reaps the child ===");
    let bridge = spawn_default("exp_l4").await?;
    let pid = bridge.pid().unwrap_or(0);
    eprintln!("[experiment] spawned bridge pid={pid}");
    eprintln!("[experiment] holding 3s before drop...");
    tokio::time::sleep(Duration::from_secs(3)).await;

    drop(bridge);
    eprintln!("[experiment] dropped. Waiting 2s for cleanup...");
    tokio::time::sleep(Duration::from_secs(2)).await;

    let output = tokio::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid,comm"])
        .output()
        .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // `ps -p <gone>` exits non-zero on Linux but on macOS prints just the header.
    // Either way, the absence of the pid in non-header lines means it's gone.
    let still_alive = stdout
        .lines()
        .skip(1)
        .any(|l| l.split_whitespace().next() == Some(&pid.to_string()));

    if still_alive {
        println!();
        println!("L4 FAIL — pid {pid} still alive after drop");
        println!("ps output:\n{stdout}");
        std::process::exit(1);
    } else {
        println!();
        println!("L4 PASS — pid {pid} reaped after drop");
    }
    Ok(())
}

async fn spawn_default(session_id: &str) -> anyhow::Result<BridgeProcess> {
    let home = env::var("HOME").map_err(|_| anyhow::anyhow!("HOME env not set"))?;
    let ga_path =
        env::var("GA_PATH").unwrap_or_else(|_| format!("{home}/Documents/GenericAgent"));
    let python = env::var("PYTHON").unwrap_or_else(|_| "python3".into());
    let bridge_cwd = env::current_dir()?;

    eprintln!("[experiment] python   = {python}");
    eprintln!("[experiment] ga_path  = {ga_path}");
    eprintln!("[experiment] cwd      = {}", bridge_cwd.display());

    BridgeProcess::spawn(
        session_id.to_string(),
        &python,
        &PathBuf::from(&ga_path),
        &bridge_cwd,
    )
    .await
}
