"""GA Workbench IPC Protocol v0.1 implementation.

Source of truth for the wire format is `docs/ipc-protocol.md`. Keep them in sync;
change the doc first, then the dataclasses here.

Field names are camelCase to match the JSON wire format directly. This makes
serialization a trivial `dataclasses.asdict` call without any name remapping.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import datetime, timezone
from typing import Any, cast

PROTOCOL_VERSION = "0.1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------- Events (bridge -> workbench) ----------------


@dataclass
class ReadyEvent:
    sessionId: str
    protocolVersion: str
    gaCommit: str
    gaPath: str
    llmName: str
    cwd: str
    pid: int
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "ready"


@dataclass
class TurnStartEvent:
    sessionId: str
    turnIndex: int
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "turn_start"


@dataclass
class ToolCallPendingEvent:
    sessionId: str
    approvalId: str
    turnIndex: int
    toolName: str
    args: dict[str, Any]
    argsPreview: str
    riskLevel: str  # "low" | "medium" | "high"
    reason: str
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "tool_call_pending"


@dataclass
class ToolCallStartEvent:
    sessionId: str
    toolCallId: str
    turnIndex: int
    toolName: str
    args: dict[str, Any]
    argsPreview: str
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "tool_call_start"


@dataclass
class ToolCallEndEvent:
    sessionId: str
    toolCallId: str
    status: str  # "success" | "failed" | "denied" | "cancelled"
    resultPreview: str
    elapsedMs: int
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "tool_call_end"


@dataclass
class ToolCallProgressEvent:
    sessionId: str
    toolCallId: str
    text: str
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "tool_call_progress"


@dataclass
class TurnEndEvent:
    sessionId: str
    turnIndex: int
    summary: str
    toolCalls: list[dict[str, Any]]
    toolResults: list[dict[str, Any]]
    responseContent: str
    exitReason: dict[str, Any] | None = None
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "turn_end"


@dataclass
class AskUserEvent:
    sessionId: str
    question: str
    candidates: list[str]
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "ask_user"


@dataclass
class RunCompleteEvent:
    sessionId: str
    exitReason: dict[str, Any]
    finalContent: str
    totalTurns: int
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "run_complete"


@dataclass
class ErrorEvent:
    sessionId: str
    message: str
    context: str | None = None
    traceback: str | None = None
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "error"


@dataclass
class HistoryLoadedEvent:
    sessionId: str
    messageCount: int
    timestamp: str = field(default_factory=_now_iso)
    kind: str = "history_loaded"


Event = (
    ReadyEvent
    | TurnStartEvent
    | ToolCallPendingEvent
    | ToolCallStartEvent
    | ToolCallEndEvent
    | ToolCallProgressEvent
    | TurnEndEvent
    | AskUserEvent
    | RunCompleteEvent
    | ErrorEvent
    | HistoryLoadedEvent
)


# ---------------- Commands (workbench -> bridge) ----------------


@dataclass
class UserMessageCommand:
    text: str
    images: list[str] = field(default_factory=list)
    kind: str = "user_message"


@dataclass
class ApprovalResponseCommand:
    approvalId: str
    decision: str  # "allow_once" | "deny" | "always_allow_project" | "always_allow_global"
    kind: str = "approval_response"


@dataclass
class AskUserResponseCommand:
    text: str
    kind: str = "ask_user_response"


@dataclass
class AbortCommand:
    kind: str = "abort"


@dataclass
class LoadHistoryCommand:
    messages: list[dict[str, Any]]
    kind: str = "load_history"


@dataclass
class SetApprovalRulesCommand:
    alwaysAllowGlobal: list[str] = field(default_factory=list)
    alwaysAllowProject: list[str] = field(default_factory=list)
    kind: str = "set_approval_rules"


@dataclass
class ShutdownCommand:
    kind: str = "shutdown"


Command = (
    UserMessageCommand
    | ApprovalResponseCommand
    | AskUserResponseCommand
    | AbortCommand
    | LoadHistoryCommand
    | SetApprovalRulesCommand
    | ShutdownCommand
)


# ---------------- Serialization ----------------


EVENT_KINDS: dict[str, type] = {
    "ready": ReadyEvent,
    "turn_start": TurnStartEvent,
    "tool_call_pending": ToolCallPendingEvent,
    "tool_call_start": ToolCallStartEvent,
    "tool_call_end": ToolCallEndEvent,
    "tool_call_progress": ToolCallProgressEvent,
    "turn_end": TurnEndEvent,
    "ask_user": AskUserEvent,
    "run_complete": RunCompleteEvent,
    "error": ErrorEvent,
    "history_loaded": HistoryLoadedEvent,
}

COMMAND_KINDS: dict[str, type] = {
    "user_message": UserMessageCommand,
    "approval_response": ApprovalResponseCommand,
    "ask_user_response": AskUserResponseCommand,
    "abort": AbortCommand,
    "load_history": LoadHistoryCommand,
    "set_approval_rules": SetApprovalRulesCommand,
    "shutdown": ShutdownCommand,
}


class IPCProtocolError(Exception):
    """Raised when an IPC message fails to parse or validate."""


def encode(msg: Any) -> str:
    """Serialize a dataclass event/command to a single JSON line (no trailing newline)."""
    if not is_dataclass(msg) or isinstance(msg, type):
        raise IPCProtocolError(f"Not a dataclass instance: {type(msg).__name__}")
    return json.dumps(asdict(msg), ensure_ascii=False, separators=(",", ":"))


def decode_event(line: str) -> Event:
    """Parse a single JSON Lines string as an Event."""
    return cast(Event, _decode(line, EVENT_KINDS, "event"))


def decode_command(line: str) -> Command:
    """Parse a single JSON Lines string as a Command."""
    return cast(Command, _decode(line, COMMAND_KINDS, "command"))


def _decode(line: str, registry: dict[str, type], label: str) -> Any:
    line = line.strip()
    if not line:
        raise IPCProtocolError(f"Empty {label} line")
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as e:
        raise IPCProtocolError(f"Invalid JSON in {label}: {e.msg}") from e
    if not isinstance(payload, dict):
        raise IPCProtocolError(
            f"{label.capitalize()} must be a JSON object, got {type(payload).__name__}"
        )
    kind = payload.get("kind")
    if not isinstance(kind, str):
        raise IPCProtocolError(f"{label.capitalize()} missing 'kind' field")
    cls = registry.get(kind)
    if cls is None:
        raise IPCProtocolError(f"Unknown {label} kind: {kind!r}")
    try:
        return cls(**payload)
    except TypeError as e:
        # missing required field or unexpected field -> dataclass __init__ raises TypeError
        raise IPCProtocolError(f"Invalid {label} {kind!r}: {e}") from e
