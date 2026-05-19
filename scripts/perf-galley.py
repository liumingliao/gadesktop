#!/usr/bin/env python3
"""Galley perf measurement — P1 (first-token RTT) + P2 (streaming throughput).

Usage:
    python3 scripts/perf-galley.py p1 <session_id>      # short prompt, first-token RTT
    python3 scripts/perf-galley.py p2 <session_id>      # long prompt, events/sec
    python3 scripts/perf-galley.py both <session_id>    # P1 then P2 back-to-back

Prereqs: Galley GUI running (dev or prod) + session has alive bridge
(check `pgrep -fl workbench_bridge`).

Side effect: each run sends a real user message + consumes LLM tokens.
"""

import json
import select
import subprocess
import sys
import time

GALLEY = "./core/target/debug/galley"
TIMEOUT_S = 90
SUPERVISOR = "jc"

P1_PROMPT = "回答一个字：今天星期几？"
P2_PROMPT = "请写一段 500 字关于咖啡历史的随笔，至少 5 段，每段独立成节。"


def run_measurement(sid: str, prompt: str, label: str) -> dict:
    """Send prompt + watch stream + return timing dict."""
    # Start watch
    watch = subprocess.Popen(
        [GALLEY, "session", "watch", sid],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    # Let watch establish socket
    time.sleep(0.2)
    if watch.poll() is not None:
        out, _ = watch.communicate()
        raise RuntimeError(f"watch died early: {out}")

    # Send
    t_invoke = time.perf_counter()
    send_proc = subprocess.run(
        [GALLEY, "session", "send", sid, prompt,
         f"--supervisor={SUPERVISOR}", f"--reason=perf-{label}"],
        capture_output=True, text=True,
    )
    t_send_done = time.perf_counter()
    if send_proc.returncode != 0:
        watch.terminate()
        raise RuntimeError(f"send failed: {send_proc.stderr}")
    try:
        send_result = json.loads(send_proc.stdout.strip())
    except Exception as e:
        watch.terminate()
        raise RuntimeError(f"send returned non-json: {send_proc.stdout!r} ({e})")
    if send_result.get("dispatch") != "dispatched":
        watch.terminate()
        raise RuntimeError(f"dispatch={send_result.get('dispatch')} (bridge not alive)")

    def read_line_with_timeout(stream, timeout_s):
        """Non-blocking readline. Returns None on timeout."""
        r, _, _ = select.select([stream], [], [], timeout_s)
        if not r:
            return None
        return stream.readline()

    # Consume watch stream — wire format: {"stream":"event","data":{"kind":...}}
    t_llm_running = None           # first turn_progress with "LLM Running" placeholder
    t_turn_start = None            # turn_start event
    t_first_real_delta = None      # first turn_progress with real content (not LLM Running)
    t_turn_end = None
    t_run_complete = None
    n_real_deltas = 0              # count of content deltas (excluding LLM Running)
    n_llm_running_deltas = 0
    n_other = 0
    err = None
    t_deadline = time.perf_counter() + TIMEOUT_S
    while time.perf_counter() < t_deadline:
        line = read_line_with_timeout(watch.stdout, 1.0)
        if line is None:
            if watch.poll() is not None:
                err = "watch ended unexpectedly"
                break
            continue
        if not line:
            # readline returned '' = EOF
            if watch.poll() is not None:
                err = "watch ended (eof)"
                break
            continue
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        # Wire-format unwrap: {"stream":"event","data":{...actual event...}}
        data = evt.get("data") if isinstance(evt.get("data"), dict) else evt
        ev_kind = data.get("kind")
        now = time.perf_counter()
        if ev_kind == "turn_start" and t_turn_start is None:
            t_turn_start = now
        elif ev_kind == "turn_progress":
            delta = data.get("delta") or ""
            if "LLM Running" in delta:
                if t_llm_running is None:
                    t_llm_running = now
                n_llm_running_deltas += 1
            else:
                if t_first_real_delta is None:
                    t_first_real_delta = now
                n_real_deltas += 1
        elif ev_kind == "turn_end":
            if t_turn_end is None:
                t_turn_end = now
        elif ev_kind == "run_complete":
            if t_run_complete is None:
                t_run_complete = now
            # run_complete = agent finished entire run.
            # Drain any trailing turn_progress for 1.5s then exit.
            t_extra_deadline = now + 1.5
            while time.perf_counter() < t_extra_deadline:
                remaining = max(0.05, t_extra_deadline - time.perf_counter())
                line2 = read_line_with_timeout(watch.stdout, remaining)
                if line2 is None:
                    continue
                if not line2:
                    break
                line2 = line2.strip()
                if not line2:
                    continue
                try:
                    evt2 = json.loads(line2)
                except Exception:
                    continue
                data2 = evt2.get("data") if isinstance(evt2.get("data"), dict) else evt2
                ev_kind2 = data2.get("kind")
                if ev_kind2 == "turn_progress":
                    delta2 = data2.get("delta") or ""
                    if "LLM Running" in delta2:
                        n_llm_running_deltas += 1
                    else:
                        if t_first_real_delta is None:
                            t_first_real_delta = time.perf_counter()
                        n_real_deltas += 1
            break
        else:
            n_other += 1

    watch.terminate()
    try:
        watch.wait(timeout=2)
    except subprocess.TimeoutExpired:
        watch.kill()

    if err:
        raise RuntimeError(err)
    if t_turn_start is None and t_first_real_delta is None:
        raise RuntimeError(
            f"no turn_start or real content delta within {TIMEOUT_S}s; "
            f"saw LLM Running={n_llm_running_deltas} other={n_other}"
        )

    def ms(t, base=t_invoke):
        return (t - base) * 1000 if t else None

    # P1 = first user-visible content delta. GA emits turn_start as a metadata
    # commit AT THE END of streaming for long prompts, so first_real_delta is
    # the more faithful "first token user sees" marker. turn_start fallback
    # only for edge cases where no real delta was captured.
    p1_marker = t_first_real_delta if t_first_real_delta else t_turn_start

    # P2: real content deltas / duration from first real delta to last seen event
    last_seen = t_run_complete or t_turn_end or t_first_real_delta
    p2_duration = (
        (last_seen - t_first_real_delta)
        if (t_first_real_delta and last_seen and last_seen > t_first_real_delta)
        else None
    )

    return {
        "label": label,
        "prompt_len": len(prompt),
        "send_rtt_ms": ms(t_send_done),
        "P1_first_token_ms": ms(p1_marker),
        "_markers_ms": {
            "llm_running_placeholder": ms(t_llm_running),
            "turn_start": ms(t_turn_start),
            "first_real_delta": ms(t_first_real_delta),
            "turn_end": ms(t_turn_end),
            "run_complete": ms(t_run_complete),
        },
        "n_real_content_deltas": n_real_deltas,
        "n_llm_running_deltas": n_llm_running_deltas,
        "n_other_events": n_other,
        "P2_streaming_duration_s": p2_duration,
        "P2_throughput_ev_s": (
            n_real_deltas / p2_duration
            if p2_duration and p2_duration > 0 else None
        ),
    }


def main():
    sys.stdout.reconfigure(line_buffering=True)  # don't buffer when piped to file
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    mode, sid = sys.argv[1], sys.argv[2]

    if mode in ("p1", "both"):
        print("[running P1: short prompt]", flush=True)
        r = run_measurement(sid, P1_PROMPT, "p1")
        print(json.dumps(r, indent=2, ensure_ascii=False), flush=True)
    if mode == "both":
        print(flush=True)
        time.sleep(1.0)  # let GA settle between turns
    if mode in ("p2", "both"):
        print("[running P2: long prompt]", flush=True)
        r = run_measurement(sid, P2_PROMPT, "p2")
        print(json.dumps(r, indent=2, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
