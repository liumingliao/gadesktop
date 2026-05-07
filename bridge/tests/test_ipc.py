"""Schema round-trip and validation tests for bridge.ipc."""
from __future__ import annotations

import json

import pytest

from bridge.ipc import (
    PROTOCOL_VERSION,
    AbortCommand,
    ApprovalResponseCommand,
    AskUserResponseCommand,
    IPCProtocolError,
    LoadHistoryCommand,
    ReadyEvent,
    RunCompleteEvent,
    SetApprovalRulesCommand,
    ShutdownCommand,
    ToolCallEndEvent,
    ToolCallPendingEvent,
    ToolCallStartEvent,
    TurnEndEvent,
    TurnStartEvent,
    UserMessageCommand,
    decode_command,
    decode_event,
    encode,
)

# ---------------- Event round-trips ----------------


def test_ready_round_trip() -> None:
    ev = ReadyEvent(
        sessionId="s1",
        protocolVersion=PROTOCOL_VERSION,
        gaCommit="6a3eecc",
        gaPath="/tmp/ga",
        llmName="ClaudeSession/test",
        cwd="/tmp/ga/temp",
        pid=42,
    )
    line = encode(ev)
    payload = json.loads(line)
    assert payload["kind"] == "ready"
    assert payload["sessionId"] == "s1"
    assert payload["protocolVersion"] == "0.1"
    decoded = decode_event(line)
    assert decoded == ev


def test_turn_start_round_trip() -> None:
    ev = TurnStartEvent(sessionId="s1", turnIndex=3)
    decoded = decode_event(encode(ev))
    assert decoded == ev


def test_tool_call_pending_round_trip() -> None:
    ev = ToolCallPendingEvent(
        sessionId="s1",
        approvalId="a1",
        turnIndex=1,
        toolName="code_run",
        args={"type": "python", "code": "print(1)"},
        argsPreview="type=python, code=print(1)",
        riskLevel="high",
        reason="Code execution",
    )
    decoded = decode_event(encode(ev))
    assert decoded == ev


def test_tool_call_start_and_end_round_trip() -> None:
    start = ToolCallStartEvent(
        sessionId="s1",
        toolCallId="tc1",
        turnIndex=1,
        toolName="file_read",
        args={"path": "x"},
        argsPreview="path=x",
    )
    end = ToolCallEndEvent(
        sessionId="s1",
        toolCallId="tc1",
        status="success",
        resultPreview="ok",
        elapsedMs=42,
    )
    assert decode_event(encode(start)) == start
    assert decode_event(encode(end)) == end


def test_turn_end_round_trip_no_exit_reason() -> None:
    ev = TurnEndEvent(
        sessionId="s1",
        turnIndex=2,
        summary="完成读取",
        toolCalls=[{"toolName": "file_read", "args": {"path": "x"}}],
        toolResults=[{"toolUseId": "tc1", "content": "..."}],
        responseContent="<summary>完成读取</summary>",
    )
    decoded = decode_event(encode(ev))
    assert decoded == ev
    assert decoded.exitReason is None


def test_turn_end_round_trip_with_exit_reason() -> None:
    ev = TurnEndEvent(
        sessionId="s1",
        turnIndex=5,
        summary="done",
        toolCalls=[],
        toolResults=[],
        responseContent="...",
        exitReason={"result": "CURRENT_TASK_DONE", "data": None},
    )
    decoded = decode_event(encode(ev))
    assert decoded == ev
    assert decoded.exitReason == {"result": "CURRENT_TASK_DONE", "data": None}


def test_run_complete_round_trip() -> None:
    ev = RunCompleteEvent(
        sessionId="s1",
        exitReason={"result": "CURRENT_TASK_DONE", "data": None},
        finalContent="最终回答",
        totalTurns=3,
    )
    decoded = decode_event(encode(ev))
    assert decoded == ev


def test_unicode_preserved() -> None:
    """Chinese / emoji should survive round trip without escapes."""
    ev = TurnEndEvent(
        sessionId="s1",
        turnIndex=1,
        summary="🎯 完成",
        toolCalls=[],
        toolResults=[],
        responseContent="测试内容",
    )
    line = encode(ev)
    assert "🎯" in line  # ensure_ascii=False keeps unicode literal
    assert "完成" in line
    assert decode_event(line) == ev


# ---------------- Command round-trips ----------------


def test_user_message_round_trip() -> None:
    cmd = UserMessageCommand(text="hello", images=["/tmp/a.png"])
    decoded = decode_command(encode(cmd))
    assert decoded == cmd


def test_user_message_default_images() -> None:
    cmd = UserMessageCommand(text="hello")
    assert cmd.images == []
    decoded = decode_command(encode(cmd))
    assert decoded == cmd


def test_approval_response_round_trip() -> None:
    for decision in ("allow_once", "deny", "always_allow_project", "always_allow_global"):
        cmd = ApprovalResponseCommand(approvalId="a1", decision=decision)
        decoded = decode_command(encode(cmd))
        assert decoded == cmd


def test_ask_user_response_round_trip() -> None:
    cmd = AskUserResponseCommand(text="yes")
    assert decode_command(encode(cmd)) == cmd


def test_abort_round_trip() -> None:
    cmd = AbortCommand()
    decoded = decode_command(encode(cmd))
    assert decoded == cmd


def test_shutdown_round_trip() -> None:
    cmd = ShutdownCommand()
    assert decode_command(encode(cmd)) == cmd


def test_load_history_round_trip() -> None:
    cmd = LoadHistoryCommand(
        messages=[
            {"role": "user", "content": "hi", "toolCalls": [], "toolResults": []},
            {"role": "assistant", "content": "hello", "toolCalls": [], "toolResults": []},
        ]
    )
    decoded = decode_command(encode(cmd))
    assert decoded == cmd


def test_set_approval_rules_round_trip() -> None:
    cmd = SetApprovalRulesCommand(
        alwaysAllowGlobal=["file_patch"],
        alwaysAllowProject=["code_run", "file_write"],
    )
    decoded = decode_command(encode(cmd))
    assert decoded == cmd


# ---------------- Error paths ----------------


def test_decode_unknown_kind() -> None:
    with pytest.raises(IPCProtocolError, match="Unknown event kind"):
        decode_event('{"kind": "not_a_thing", "sessionId": "s"}')


def test_decode_missing_kind() -> None:
    with pytest.raises(IPCProtocolError, match="missing 'kind'"):
        decode_event('{"sessionId": "s"}')


def test_decode_kind_not_string() -> None:
    with pytest.raises(IPCProtocolError, match="missing 'kind'"):
        decode_event('{"kind": 42}')


def test_decode_invalid_json() -> None:
    with pytest.raises(IPCProtocolError, match="Invalid JSON"):
        decode_event("not json")


def test_decode_empty_line() -> None:
    with pytest.raises(IPCProtocolError, match="Empty"):
        decode_event("")
    with pytest.raises(IPCProtocolError, match="Empty"):
        decode_event("   \n")


def test_decode_non_object_payload() -> None:
    with pytest.raises(IPCProtocolError, match="must be a JSON object"):
        decode_event("[1, 2, 3]")


def test_decode_missing_required_field() -> None:
    # ReadyEvent requires many fields; provide only kind + sessionId
    with pytest.raises(IPCProtocolError, match="Invalid event 'ready'"):
        decode_event('{"kind": "ready", "sessionId": "s"}')


def test_decode_unexpected_field() -> None:
    # Adding a field unknown to the dataclass should fail.
    with pytest.raises(IPCProtocolError, match="Invalid command 'abort'"):
        decode_command('{"kind": "abort", "rogue": 1}')


def test_event_decoder_rejects_command() -> None:
    line = encode(UserMessageCommand(text="x"))
    with pytest.raises(IPCProtocolError, match="Unknown event kind: 'user_message'"):
        decode_event(line)


def test_command_decoder_rejects_event() -> None:
    line = encode(TurnStartEvent(sessionId="s", turnIndex=1))
    with pytest.raises(IPCProtocolError, match="Unknown command kind: 'turn_start'"):
        decode_command(line)


def test_encode_rejects_non_dataclass() -> None:
    with pytest.raises(IPCProtocolError, match="Not a dataclass"):
        encode({"kind": "ready"})


# ---------------- Constants ----------------


def test_protocol_version_constant() -> None:
    assert PROTOCOL_VERSION == "0.1"
