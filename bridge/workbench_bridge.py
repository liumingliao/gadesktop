"""GA Workbench bridge: connects one GA subprocess to the desktop frontend.

Run as a subprocess. Reads JSON Lines commands on stdin, writes JSON Lines
events on stdout. See docs/ipc-protocol.md for the wire format.

Usage:
    python -m bridge.workbench_bridge \\
        --ga-path /Users/me/Documents/GenericAgent \\
        --session-id sess_abc \\
        [--cwd /path/to/project] \\
        [--llm-no 0]

Stdout discipline: GA's tool implementations call print() in places we don't
control (e.g. ga.code_run streaming subprocess output). To keep our JSON
Lines stream clean, we capture the original stdout fd at startup and route
sys.stdout to /dev/null. All bridge events go through self._emit() which
writes to the captured fd.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
import traceback
import uuid
from pathlib import Path
from typing import IO, Any

from bridge.ipc import (
    PROTOCOL_VERSION,
    AbortCommand,
    ApprovalResponseCommand,
    AskUserEvent,
    AskUserResponseCommand,
    Command,
    ErrorEvent,
    HistoryLoadedEvent,
    IPCProtocolError,
    LLMChangedEvent,
    LoadHistoryCommand,
    ReadyEvent,
    RunCompleteEvent,
    SetApprovalRulesCommand,
    SetLLMCommand,
    SetYoloModeCommand,
    ShutdownCommand,
    ToolCallPendingEvent,
    TurnEndEvent,
    TurnProgressEvent,
    TurnStartEvent,
    UserMessageCommand,
    decode_command,
    encode,
)

# ---------------- Stdout capture ----------------


def _capture_real_stdout() -> IO[str]:
    """Duplicate fd 1 so we can keep a clean output channel even after we
    redirect sys.stdout into /dev/null to silence GA's print() calls."""
    fd = os.dup(1)
    return os.fdopen(fd, "w", encoding="utf-8", buffering=1)  # line-buffered


def _silence_python_stdout() -> None:
    """Redirect sys.stdout to /dev/null. fd 1 stays usable via the captured
    handle from _capture_real_stdout()."""
    sys.stdout = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115


# ---------------- Cleanup helpers (mirror frontends/chatapp_common.py spirit) ----------------


_TAG_PATS = [
    r"<" + t + r">.*?</" + t + r">"
    for t in ("thinking", "summary", "tool_use", "file_content")
]
_FILE_REF_RE = re.compile(r"\[FILE:[^\]]+\]")


def _clean_response_for_display(text: str) -> str:
    if not text:
        return ""
    cleaned = text
    for pat in _TAG_PATS:
        cleaned = re.sub(pat, "", cleaned, flags=re.DOTALL)
    cleaned = _FILE_REF_RE.sub("", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _to_json_safe(obj: Any) -> Any:
    """Recursively coerce a value into JSON-serializable form.

    GA hands us its internal response/StepOutcome objects (e.g. exit_reason.data
    holds the LLM response object after a no_tool turn). Those aren't JSON
    serializable; we stringify the leaves so the wire format stays clean.
    """
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _to_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_to_json_safe(x) for x in obj]
    return str(obj)


def _compact_args(args: dict[str, Any], max_len: int = 200) -> str:
    cleaned = {k: v for k, v in args.items() if not k.startswith("_")}
    s = json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
    if len(s) > max_len:
        s = s[: max_len - 3] + "..."
    return s


# LLM brand name standardization for the Composer's LLM switcher dropdown.
# Maps lowercase brand keys to their canonical display form.
_LLM_BRAND_NAMES: dict[str, str] = {
    "glm": "GLM",
    "gpt": "GPT",
    "oai": "OAI",
    "claude": "Claude",
    "gemini": "Gemini",
    "llama": "Llama",
    "mistral": "Mistral",
    "deepseek": "DeepSeek",
    "qwen": "Qwen",
    "kimi": "Kimi",
    "minimax": "MiniMax",
    "doubao": "Doubao",
    "yi": "Yi",
    "phi": "Phi",
}


def _simplify_llm_name(raw: str) -> str:
    """Prettify GA's 'ClassName/model-name' raw LLM identifier.

    GA's get_llm_name returns f"{type(backend).__name__}/{backend.name}", e.g.
    "NativeClaudeSession/glm-5.1". We strip the class prefix and capitalize
    the brand keyword so the Composer LLM switcher reads naturally.

    Examples:
        NativeClaudeSession/glm-5.1     -> GLM 5.1
        ClaudeSession/claude-3-5-sonnet -> Claude 3-5-sonnet
        NativeOAISession/gpt-4o          -> GPT 4o
        LLMSession/qwen-max              -> Qwen max
        BADCONFIG_MIXIN                  -> BADCONFIG_MIXIN  (unchanged)
    """
    model = raw.split("/", 1)[1] if "/" in raw else raw
    parts = model.split("-", 1)
    brand = _LLM_BRAND_NAMES.get(parts[0].lower(), parts[0])
    return f"{brand} {parts[1]}" if len(parts) > 1 else brand


# Keyword patterns for hint inference. Match in order; first hit wins.
# Patterns are case-insensitive substring matches against the error message.
# See docs/ipc-protocol.md §4.10 for the hint contract; DESIGN.md §6.2 for
# the Error Card variants the desktop renders for each hint.
_ERROR_HINT_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "check_llm_config",
        (
            "api_key",
            "api key",
            "unauthorized",
            "authentication",
            "invalid key",
            "401",
            "403",
        ),
    ),
    (
        "quota_exceeded",
        ("quota", "rate limit", "rate_limit", "429", "too many requests"),
    ),
    (
        "network",
        (
            "connection refused",
            "timeout",
            "timed out",
            "dns",
            "network is unreachable",
            "connection reset",
        ),
    ),
)


def _classify_error(message: str, category: str) -> tuple[str | None, bool]:
    """Classify an error message into (hint, retryable) for ErrorEvent.

    Only runtime errors get hints — those are the user-facing failure modes
    worth translating ("401 Unauthorized" -> "check your mykey.py"). Bridge
    and business errors fall through to the standard Error Card without a
    hint.

    Returns (hint, retryable). retryable defaults to True for runtime
    errors (the user can plausibly try again, possibly with a fix);
    False for bridge / business errors (those are bugs or invalid input
    that retrying wouldn't change).
    """
    if category != "runtime":
        return None, False
    msg_lower = message.lower()
    for hint, keywords in _ERROR_HINT_PATTERNS:
        if any(kw in msg_lower for kw in keywords):
            return hint, True
    return None, True


def _resolve_ga_commit(ga_path: str) -> tuple[str, str]:
    """Return (commit_hash, commit_iso_date) for the GA install at ga_path.

    Both default to ``"unknown"`` when ga_path is not a git checkout (e.g.
    a tarball/zip download). Desktop renders that gracefully — Settings →
    Runtime shows ``GA 版本: unknown`` and skips the baseline-comparison
    row. Surfaces this in a single subprocess call when possible so the
    `ready` event isn't slowed by two separate git invocations.
    """
    import subprocess

    try:
        out = subprocess.check_output(
            ["git", "log", "-1", "--format=%H%n%cI"],
            cwd=ga_path,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        lines = out.strip().splitlines()
        if len(lines) >= 2:
            return lines[0].strip(), lines[1].strip()
        if len(lines) == 1:
            return lines[0].strip(), "unknown"
        return "unknown", "unknown"
    except Exception:
        return "unknown", "unknown"


# ---------------- Pending approval ----------------


class _PendingApproval:
    """Single pending approval slot. Worker thread waits on event, command
    thread sets decision and signals."""

    __slots__ = ("event", "decision")

    def __init__(self) -> None:
        self.event = threading.Event()
        self.decision: str | None = None


class SessionState:
    """Owns rule sets and pending approvals at session scope."""

    def __init__(self) -> None:
        self.always_allow_global: set[str] = set()
        self.always_allow_project: set[str] = set()
        # YOLO mode (PRD §11.5). Default off; desktop syncs the user's
        # persisted preference via SetYoloModeCommand right after `ready`.
        # Read by WorkbenchHandler.needs_approval through the yolo_check
        # closure on every dispatch — toggling here takes effect on the
        # very next tool call.
        self.yolo_mode: bool = False
        self._pending: dict[str, _PendingApproval] = {}
        self._lock = threading.Lock()

    def register_pending(self, approval_id: str) -> _PendingApproval:
        p = _PendingApproval()
        with self._lock:
            self._pending[approval_id] = p
        return p

    def resolve_pending(self, approval_id: str, decision: str) -> bool:
        with self._lock:
            p = self._pending.pop(approval_id, None)
        if p is None:
            return False
        p.decision = decision
        p.event.set()
        return True


# ---------------- Bridge runtime ----------------


class Bridge:
    """One bridge process's runtime state and main loop."""

    APPROVAL_WAIT_SECS = 600  # 10 min default; agent's deny on timeout

    def __init__(
        self,
        ga_path: str,
        session_id: str,
        cwd: str | None,
        llm_no: int,
        stdout: IO[str],
        stdin: IO[str],
    ) -> None:
        self.ga_path = ga_path
        self.session_id = session_id
        self.cwd = cwd
        self.llm_no = llm_no
        self._stdout = stdout
        self._stdin = stdin
        self.state = SessionState()
        self.event_queue: queue.Queue[str] = queue.Queue()
        self.command_queue: queue.Queue[Command] = queue.Queue()
        self.shutdown_event = threading.Event()
        self.run_in_progress = threading.Event()
        self.current_turn: int = 0
        # turn_start dedupe state. Two emitters share this:
        #   1. WorkbenchHandler.tool_before_callback (real-time, fires
        #      when GA enters tool dispatch for the current turn).
        #   2. _on_turn_end's predict-emit (fires turn_start(turn+1)
        #      right after the just-finished turn's TurnEndEvent, so
        #      the sidebar updates immediately instead of waiting
        #      several seconds for the next turn's LLM call to
        #      complete and tool dispatch to begin).
        # Reset to 0 on every put_task (new agent_runner_loop = turn
        # counter restarts at 1) so dedupe doesn't accidentally
        # suppress the first turn_start of a new run.
        self._last_emitted_turn: int = 0
        # Resolved during start():
        self.agent: Any = None
        self.agentmain: Any = None

    # ---------------- Lifecycle ----------------

    def start(self) -> None:
        self._setup_ga()
        self._install_handler_subclass()
        self._register_turn_end_hook()
        threading.Thread(target=self.agent.run, daemon=True).start()
        self._emit_ready()

    def _setup_ga(self) -> None:
        if self.ga_path not in sys.path:
            sys.path.insert(0, self.ga_path)
        if self.cwd:
            os.chdir(self.cwd)
        else:
            # Default to GA's own dir so agentmain finds its assets/.
            os.chdir(self.ga_path)

        import agentmain

        self.agentmain = agentmain
        self.agent = agentmain.GeneraticAgent()
        self.agent.next_llm(self.llm_no)
        self.agent.verbose = False
        # Push only the new substring on each display_queue tick rather
        # than the full accumulated response. Smaller IPC payloads, and
        # desktop accumulates deltas into its own inFlightContent
        # (mirrors what fsapp.py does — agentmain default is False
        # which would re-send the whole response every chunk).
        self.agent.inc_out = True

    def _install_handler_subclass(self) -> None:
        from bridge.handlers import WorkbenchHandler

        bridge_self = self

        class _ConfiguredWorkbenchHandler(WorkbenchHandler):
            def __init__(
                self,
                parent: Any,
                last_history: list[str] | None = None,
                cwd: str = "./temp",
            ) -> None:
                super().__init__(
                    parent,
                    last_history,
                    cwd,
                    request_approval=bridge_self._request_approval,
                    always_allow_global=bridge_self.state.always_allow_global,
                    always_allow_project=bridge_self.state.always_allow_project,
                    # Closure over bridge_self.state so SetYoloModeCommand
                    # can flip the flag at runtime without rebuilding the
                    # handler. needs_approval() calls this on every dispatch.
                    yolo_check=lambda: bridge_self.state.yolo_mode,
                    # turn_start emission: GA's agent_runner_loop has no
                    # turn_start_callback, but it sets handler.current_turn
                    # before each tool dispatch and calls
                    # tool_before_callback. WorkbenchHandler detects the
                    # turn change there and invokes this callback so the
                    # desktop sidebar can show "正在工作 · 第 N 步" live.
                    turn_started_callback=bridge_self._emit_turn_start,
                )

        # agentmain bound the name at import time (`from ga import
        # GenericAgentHandler`), so we patch the agentmain module's binding,
        # not ga's. agentmain.run() looks up the name in agentmain's globals.
        self.agentmain.GenericAgentHandler = _ConfiguredWorkbenchHandler

    def _register_turn_end_hook(self) -> None:
        if not hasattr(self.agent, "_turn_end_hooks"):
            self.agent._turn_end_hooks = {}
        self.agent._turn_end_hooks[f"workbench_{self.session_id}"] = self._on_turn_end

    # ---------------- Event emission ----------------

    def _emit_turn_start(self, turn_index: int) -> None:
        """Fire when GA enters a new agent_runner_loop iteration.

        Two emitters call this (both deduped via _last_emitted_turn):

          1. WorkbenchHandler.tool_before_callback: real-time emission
             when GA actually reaches tool dispatch for the current
             turn. This is the authoritative "we are on step N" signal,
             but it lands several seconds *after* the turn started
             (LLM call has to complete first).
          2. _on_turn_end predict-emit: right after the just-finished
             turn's TurnEndEvent, if GA is going to keep looping
             (exit_reason empty), we pre-announce turn N+1. The sidebar
             updates immediately, matching what the user sees in the
             main view (turn_progress is already streaming N+1's
             content by then).

        Dedupe keeps the two emitters from double-firing turn_start
        for the same N. Reset to 0 on each put_task in dispatch_command
        so a new agent_runner_loop's turn 1 isn't accidentally
        suppressed when the previous run also ended at turn 1.

        turn_index is GA's per-message turn number (1-based, resets at
        every new user_message — matches what the conversation view's
        TurnMarker shows).
        """
        if turn_index == self._last_emitted_turn:
            return
        self._last_emitted_turn = turn_index
        self._emit(
            TurnStartEvent(
                sessionId=self.session_id,
                turnIndex=turn_index,
            )
        )

    def _emit_ready(self) -> None:
        ga_commit, ga_commit_date = _resolve_ga_commit(self.ga_path)
        self._emit(
            ReadyEvent(
                sessionId=self.session_id,
                protocolVersion=PROTOCOL_VERSION,
                gaCommit=ga_commit,
                gaCommitDate=ga_commit_date,
                gaPath=self.ga_path,
                llmName=self.agent.get_llm_name(),
                cwd=os.getcwd(),
                pid=os.getpid(),
                availableLLMs=self._collect_available_llms(),
            )
        )

    def _collect_available_llms(self) -> list[dict[str, Any]]:
        """Snapshot the agent's LLM list for the Composer LLM switcher."""
        out: list[dict[str, Any]] = []
        try:
            for index, name, is_current in self.agent.list_llms():
                out.append(
                    {
                        "index": index,
                        "name": name,
                        "displayName": _simplify_llm_name(name),
                        "isCurrent": bool(is_current),
                    }
                )
        except Exception as e:
            self._emit_error(f"list_llms failed: {e}", traceback.format_exc())
        return out

    def _emit(self, ev: Any) -> None:
        self.event_queue.put(encode(ev))

    def _start_progress_drain(self, display_queue: Any) -> None:
        """Forward GA's display_queue partial chunks as turn_progress
        IPC events so desktop can render the LLM output mid-turn.

        GA's `agentmain.put_task` returns a `queue.Queue` whose items
        are `{'next': delta, 'source': src}` for streaming chunks and
        `{'done': full, 'source': src}` once the task completes. With
        `agent.inc_out = True` (set in `_setup_ga`), `next` is the
        delta since the last push rather than the full snapshot.

        We don't republish `done` — the turn_end_callback hook fires
        per GA turn and produces the canonical TurnEndEvent with full
        tool calls / results / responseContent. `done` arrives at
        whole-task completion (across multiple turns); duplicating it
        as IPC would just give desktop a redundant signal.

        Each user task gets its own daemon thread; the thread exits
        on `done` or on shutdown.
        """

        def drain() -> None:
            try:
                while True:
                    try:
                        item = display_queue.get(timeout=0.5)
                    except queue.Empty:
                        if self.shutdown_event.is_set():
                            return
                        continue
                    if not isinstance(item, dict):
                        continue
                    if "done" in item:
                        return
                    if "next" in item:
                        delta = item["next"]
                        if not isinstance(delta, str) or not delta:
                            continue
                        self._emit(
                            TurnProgressEvent(
                                sessionId=self.session_id,
                                delta=delta,
                                source=str(item.get("source", "")),
                            )
                        )
            except Exception as e:
                # Don't take down the bridge for a drain hiccup.
                self._emit_error(
                    f"progress drain failed: {e}",
                    traceback.format_exc(),
                    category="bridge",
                    severity="warning",
                    context="progress_drain",
                )

        threading.Thread(target=drain, daemon=True).start()

    def _emit_error(
        self,
        message: str,
        tb: str | None,
        *,
        category: str = "bridge",
        severity: str = "error",
        context: str | None = None,
    ) -> None:
        """Emit a structured ErrorEvent.

        category: "bridge" (default) for bridge-internal faults that desktop
        renders as a toast; "runtime" for GA/LLM/tool failures rendered as
        an inline conversation message; "business" for user-action errors
        (invalid input, history corruption) also rendered as a toast.

        hint and retryable are inferred from the message via
        _classify_error — runtime errors with known keyword matches get a
        hint that desktop maps to a tailored Error Card.
        """
        hint, retryable = _classify_error(message, category)
        self._emit(
            ErrorEvent(
                sessionId=self.session_id,
                message=message,
                category=category,
                severity=severity,
                retryable=retryable,
                hint=hint,
                context=context,
                traceback=tb,
            )
        )

    # ---------------- Turn end hook ----------------

    def _on_turn_end(self, ctx: dict[str, Any]) -> None:
        try:
            response = ctx.get("response")
            tool_calls = ctx.get("tool_calls") or []
            tool_results = ctx.get("tool_results") or []
            summary = str(ctx.get("summary") or "")
            turn = int(ctx.get("turn") or 0)
            exit_reason = ctx.get("exit_reason") or None
            response_content = (
                getattr(response, "content", "") if response is not None else ""
            )
            self.current_turn = turn
            # GA may stash its internal response/outcome objects inside
            # exit_reason.data. Coerce to JSON-safe shape before emit.
            safe_exit = _to_json_safe(exit_reason) if exit_reason else None

            self._emit(
                TurnEndEvent(
                    sessionId=self.session_id,
                    turnIndex=turn,
                    summary=summary,
                    toolCalls=[
                        _to_json_safe(self._serialize_tool_call(tc))
                        for tc in tool_calls
                    ],
                    toolResults=[
                        _to_json_safe(self._serialize_tool_result(tr))
                        for tr in tool_results
                    ],
                    responseContent=response_content,
                    exitReason=safe_exit,
                )
            )

            # ask_user is an explicit interaction request: emit AskUserEvent
            # so desktop can prompt the user.
            ask = self._extract_ask_user(tool_calls)
            if ask is not None:
                question, candidates = ask
                self._emit(
                    AskUserEvent(
                        sessionId=self.session_id,
                        question=question,
                        candidates=candidates,
                    )
                )

            if exit_reason:
                self._emit(
                    RunCompleteEvent(
                        sessionId=self.session_id,
                        exitReason=safe_exit or {},
                        finalContent=_clean_response_for_display(response_content),
                        totalTurns=turn,
                    )
                )
                self.run_in_progress.clear()
            else:
                # Predict-emit turn_start(turn+1): GA is going to keep
                # looping, but the actual `tool_before_callback` for the
                # next turn won't fire until that turn's LLM call has
                # fully completed (several seconds later). Without this,
                # the sidebar subline drops to "正在工作…" during the
                # next turn's LLM streaming even though the main view
                # is clearly already showing N+1's content. The dedupe
                # inside `_emit_turn_start` makes the eventual real
                # tool_before_callback a no-op.
                self._emit_turn_start(turn + 1)
        except Exception as e:
            self._emit_error(f"turn_end_hook failed: {e}", traceback.format_exc())

    @staticmethod
    def _serialize_tool_call(tc: dict[str, Any]) -> dict[str, Any]:
        args = {k: v for k, v in (tc.get("args") or {}).items() if not k.startswith("_")}
        return {"toolName": tc.get("tool_name", ""), "args": args}

    @staticmethod
    def _serialize_tool_result(tr: dict[str, Any]) -> dict[str, Any]:
        return {"toolUseId": tr.get("tool_use_id", ""), "content": tr.get("content", "")}

    @staticmethod
    def _extract_ask_user(
        tool_calls: list[dict[str, Any]],
    ) -> tuple[str, list[str]] | None:
        for tc in tool_calls:
            if tc.get("tool_name") == "ask_user":
                args = tc.get("args") or {}
                return (
                    str(args.get("question", "")),
                    [str(c) for c in (args.get("candidates") or [])],
                )
        return None

    # ---------------- Approval request (called from worker thread) ----------------

    def _request_approval(self, tool_name: str, args: dict[str, Any]) -> str:
        from bridge.handlers import APPROVAL_REASONS, RISK_LEVELS

        approval_id = f"appr_{uuid.uuid4().hex[:12]}"
        pending = self.state.register_pending(approval_id)
        self._emit(
            ToolCallPendingEvent(
                sessionId=self.session_id,
                approvalId=approval_id,
                turnIndex=self.current_turn,
                toolName=tool_name,
                args=args,
                argsPreview=_compact_args(args),
                riskLevel=RISK_LEVELS.get(tool_name, "medium"),
                reason=APPROVAL_REASONS.get(tool_name, "Tool requires user approval."),
            )
        )

        if not pending.event.wait(timeout=self.APPROVAL_WAIT_SECS):
            self._emit_error(
                f"Approval timed out for {tool_name} ({self.APPROVAL_WAIT_SECS}s); denying.",
                None,
                category="business",
                severity="warning",
                context="approval_timeout",
            )
            return "deny"
        return pending.decision or "deny"

    # ---------------- Command dispatch ----------------

    def dispatch_command(self, cmd: Command) -> None:
        if isinstance(cmd, UserMessageCommand):
            # New put_task = new agent_runner_loop, turn counter restarts
            # at 1. Reset dedupe so the first turn_start(1) of the new
            # run isn't suppressed when the previous run also ended at
            # turn 1.
            self._last_emitted_turn = 0
            self.run_in_progress.set()
            display_queue = self.agent.put_task(
                cmd.text, source="workbench", images=cmd.images
            )
            self._start_progress_drain(display_queue)
        elif isinstance(cmd, ApprovalResponseCommand):
            ok = self.state.resolve_pending(cmd.approvalId, cmd.decision)
            if not ok:
                self._emit_error(
                    f"Unknown approval id: {cmd.approvalId}",
                    None,
                    context="approval_response",
                )
        elif isinstance(cmd, AskUserResponseCommand):
            # Same as UserMessage above — ask_user response triggers a
            # fresh agent_runner_loop with turn counter restarting at 1.
            self._last_emitted_turn = 0
            self.run_in_progress.set()
            display_queue = self.agent.put_task(cmd.text, source="workbench")
            self._start_progress_drain(display_queue)
        elif isinstance(cmd, AbortCommand):
            # GA's abort() sets stop_sig and breaks out of the run loop
            # without firing turn_end_callback, so we synthesize the
            # run_complete event ourselves with the ABORTED marker.
            self.agent.abort()
            if self.run_in_progress.is_set():
                self._emit(
                    RunCompleteEvent(
                        sessionId=self.session_id,
                        exitReason={"result": "ABORTED", "data": None},
                        finalContent="",
                        totalTurns=self.current_turn,
                    )
                )
                self.run_in_progress.clear()
        elif isinstance(cmd, LoadHistoryCommand):
            try:
                self._load_history(cmd.messages)
                self._emit(
                    HistoryLoadedEvent(
                        sessionId=self.session_id,
                        messageCount=len(cmd.messages),
                    )
                )
            except Exception as e:
                self._emit_error(
                    f"load_history failed: {e}",
                    traceback.format_exc(),
                    category="business",
                    context="load_history",
                )
        elif isinstance(cmd, SetApprovalRulesCommand):
            # In-place mutation so the existing handler instance picks up
            # changes without rebuild.
            self.state.always_allow_global.clear()
            self.state.always_allow_global.update(cmd.alwaysAllowGlobal)
            self.state.always_allow_project.clear()
            self.state.always_allow_project.update(cmd.alwaysAllowProject)
        elif isinstance(cmd, SetYoloModeCommand):
            # YOLO mode (PRD §11.5). Read by WorkbenchHandler through a
            # closure that reaches into self.state, so this single
            # assignment takes effect on the next tool dispatch — no
            # need to rebuild the handler or notify it explicitly.
            self.state.yolo_mode = cmd.enabled
        elif isinstance(cmd, SetLLMCommand):
            self._handle_set_llm(cmd)
        elif isinstance(cmd, ShutdownCommand):
            self.shutdown_event.set()

    def _handle_set_llm(self, cmd: SetLLMCommand) -> None:
        """Switch the agent's active LLM. Should only be called when the
        agent is idle; the desktop UI is responsible for enforcing that
        constraint, but we double-check here.

        GA's next_llm() copies backend.history from the old client to the
        new one, so conversation context is preserved across the switch.
        """
        if self.run_in_progress.is_set():
            self._emit_error(
                "Cannot switch LLM while a run is in progress",
                None,
                category="business",
                context="set_llm",
            )
            return
        try:
            count = len(self.agent.llmclients)
        except Exception as e:
            self._emit_error(
                f"Cannot read LLM list: {e}",
                traceback.format_exc(),
                context="set_llm",
            )
            return
        if not 0 <= cmd.llmIndex < count:
            self._emit_error(
                f"llmIndex {cmd.llmIndex} out of range [0, {count})",
                None,
                category="business",
                context="set_llm",
            )
            return
        try:
            self.agent.next_llm(cmd.llmIndex)
        except Exception as e:
            self._emit_error(
                f"next_llm({cmd.llmIndex}) failed: {e}",
                traceback.format_exc(),
                context="set_llm",
            )
            return
        raw_name = self.agent.get_llm_name()
        self._emit(
            LLMChangedEvent(
                sessionId=self.session_id,
                index=cmd.llmIndex,
                name=raw_name,
                displayName=_simplify_llm_name(raw_name),
            )
        )

    def _load_history(self, messages: list[dict[str, Any]]) -> None:
        """Inject conversation history into the backend.

        Desktop-facing schema (docs/ipc-protocol.md §8.4) uses simple string
        content per message. GA's NativeClaudeSession backend stores history
        as a list of {role, content: [{type, text}, ...]} dicts (Anthropic
        native format). Adapt here so the desktop never has to know GA's
        internal shape.

        E2E-validated for NativeClaudeSession (GLM 5.1 via native_claude
        config). Other session classes (NativeOAISession, ClaudeSession,
        LLMSession, MixinSession) are NOT yet validated; if a session uses
        a different shape we'll need a per-class adapter. Tracked as PRD
        §10 open item.
        """
        adapted = []
        for m in messages:
            role = m.get("role")
            content = m.get("content", "")
            if isinstance(content, str):
                blocks: list[Any] = [{"type": "text", "text": content}]
            elif isinstance(content, list):
                blocks = content  # assume already native shape
            else:
                blocks = [{"type": "text", "text": str(content)}]
            adapted.append({"role": role, "content": blocks})
        self.agent.llmclient.backend.history = adapted

    # ---------------- Main loop ----------------

    def run(self) -> int:
        threading.Thread(target=self._stdout_writer, daemon=True).start()
        threading.Thread(target=self._stdin_reader, daemon=True).start()

        while not self.shutdown_event.is_set():
            try:
                cmd = self.command_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self.dispatch_command(cmd)
            except Exception as e:
                self._emit_error(
                    f"command dispatch failed: {e}", traceback.format_exc()
                )

        # Brief grace period for any in-flight emit to drain.
        self.run_in_progress.wait(timeout=2.0)
        # Drain remaining events (best effort).
        deadline = threading.Event()
        threading.Timer(0.5, deadline.set).start()
        while not self.event_queue.empty() and not deadline.is_set():
            pass
        return 0

    # ---------------- IO threads ----------------

    def _stdout_writer(self) -> None:
        while not self.shutdown_event.is_set() or not self.event_queue.empty():
            try:
                line = self.event_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self._stdout.write(line + "\n")
                self._stdout.flush()
            except Exception:
                self.shutdown_event.set()
                return

    def _stdin_reader(self) -> None:
        while not self.shutdown_event.is_set():
            try:
                line = self._stdin.readline()
            except Exception:
                self.shutdown_event.set()
                return
            if not line:  # EOF
                self.shutdown_event.set()
                return
            try:
                cmd = decode_command(line)
            except IPCProtocolError as e:
                self._emit_error(str(e), None)
                continue
            self.command_queue.put(cmd)


# ---------------- Entrypoint ----------------


def main() -> int:
    parser = argparse.ArgumentParser(prog="bridge.workbench_bridge")
    parser.add_argument("--ga-path", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--llm-no", type=int, default=0)
    args = parser.parse_args()

    ga_path = str(Path(args.ga_path).expanduser().resolve())
    if not Path(ga_path).is_dir():
        print(f"GA path not found: {ga_path}", file=sys.stderr)
        return 2

    real_stdout = _capture_real_stdout()
    real_stdin = sys.stdin
    _silence_python_stdout()

    bridge = Bridge(
        ga_path=ga_path,
        session_id=args.session_id,
        cwd=args.cwd,
        llm_no=args.llm_no,
        stdout=real_stdout,
        stdin=real_stdin,
    )
    try:
        bridge.start()
    except Exception as e:
        print(
            f"Bridge startup failed: {e}\n{traceback.format_exc()}",
            file=sys.stderr,
        )
        return 1
    return bridge.run()


if __name__ == "__main__":
    sys.exit(main())
