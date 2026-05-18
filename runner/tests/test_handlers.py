"""Unit tests for WorkbenchHandler.

These tests exercise the dispatch gate without running real LLM calls.
A FakeHandler subclass provides minimal `do_<tool>` methods so we can
drive `super().dispatch()` through controlled paths.

Requires GA on sys.path (see conftest.py).
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

# Importing handlers requires GA on sys.path (conftest handles that).
# Import inside fixtures/tests would also work; module-level is fine since
# conftest runs before test collection.
from runner.handlers import (
    DEFAULT_APPROVAL_TOOLS,
    WorkbenchHandler,
)


def _drain(gen: Any) -> tuple[list[Any], Any]:
    """Run a generator to completion. Returns (yielded_values, return_value)."""
    yielded = []
    try:
        while True:
            yielded.append(next(gen))
    except StopIteration as e:
        return yielded, e.value


class _FakeHandler(WorkbenchHandler):
    """Provides fake do_<tool> methods so super().dispatch() has something to call."""

    def do_test_tool(self, args: dict[str, Any], response: Any) -> Any:
        from agent_loop import StepOutcome
        yield "test tool ran\n"
        return StepOutcome({"status": "success", "data": dict(args)}, next_prompt="\n")

    def do_code_run(self, args: dict[str, Any], response: Any) -> Any:
        from agent_loop import StepOutcome
        yield "code_run ran\n"
        return StepOutcome({"status": "success", "data": dict(args)}, next_prompt="\n")

    def do_file_write(self, args: dict[str, Any], response: Any) -> Any:
        from agent_loop import StepOutcome
        yield "file_write ran\n"
        return StepOutcome({"status": "success", "data": dict(args)}, next_prompt="\n")


@pytest.fixture
def fake_parent() -> MagicMock:
    return MagicMock(verbose=False, task_dir=None)


def _make_handler(
    fake_parent: MagicMock,
    request_approval: Any,
    **kwargs: Any,
) -> _FakeHandler:
    return _FakeHandler(
        parent=fake_parent,
        last_history=[],
        cwd="/tmp/ga_test",
        request_approval=request_approval,
        **kwargs,
    )


# ---------------- Pass-through cases ----------------


def test_non_approval_tool_passes_through(fake_parent: MagicMock) -> None:
    approval = MagicMock()
    h = _make_handler(fake_parent, approval)
    yielded, ret = _drain(h.dispatch("test_tool", {"a": 1}, response=MagicMock()))
    approval.assert_not_called()
    assert any("test tool ran" in y for y in yielded)
    assert ret.data["status"] == "success"


def test_approval_tool_calls_request_approval(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="allow_once")
    h = _make_handler(fake_parent, approval)
    yielded, ret = _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval.assert_called_once_with("code_run", {"type": "python"})
    assert ret.data["status"] == "success"
    assert any("code_run ran" in y for y in yielded)


def test_pre_loaded_global_rule_skips_request(fake_parent: MagicMock) -> None:
    approval = MagicMock()
    h = _make_handler(fake_parent, approval, always_allow_global={"code_run"})
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval.assert_not_called()


def test_pre_loaded_project_rule_skips_request(fake_parent: MagicMock) -> None:
    approval = MagicMock()
    h = _make_handler(fake_parent, approval, always_allow_project={"file_write"})
    _drain(h.dispatch("file_write", {"path": "x"}, response=MagicMock()))
    approval.assert_not_called()


# ---------------- Decision handling ----------------


def test_deny_short_circuits(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="deny")
    h = _make_handler(fake_parent, approval)
    yielded, ret = _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    assert any("denied" in y.lower() for y in yielded)
    assert ret.data["status"] == "denied"
    assert ret.next_prompt == "\n"
    # The fake do_code_run should NOT have been reached.
    assert not any("code_run ran" in y for y in yielded)


def test_always_allow_global_caches_and_skips_next_time(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="always_allow_global")
    h = _make_handler(fake_parent, approval)
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    assert "code_run" in h._always_allow_global
    approval.reset_mock()
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval.assert_not_called()


def test_always_allow_project_caches_and_skips_next_time(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="always_allow_project")
    h = _make_handler(fake_parent, approval)
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    assert "code_run" in h._always_allow_project
    approval.reset_mock()
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval.assert_not_called()


def test_unknown_decision_treated_as_deny(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="garbage")
    h = _make_handler(fake_parent, approval)
    yielded, ret = _drain(h.dispatch("code_run", {}, response=MagicMock()))
    assert ret.data["status"] == "denied"
    assert any("Unknown decision" in y for y in yielded)


# ---------------- Runtime rule updates ----------------


def test_update_approval_rules_at_runtime(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="deny")
    h = _make_handler(fake_parent, approval)
    h.update_approval_rules(always_allow_global={"code_run"})
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval.assert_not_called()


def test_update_approval_rules_partial(fake_parent: MagicMock) -> None:
    approval = MagicMock(return_value="deny")
    h = _make_handler(
        fake_parent,
        approval,
        always_allow_global={"code_run"},
        always_allow_project={"file_write"},
    )
    # Update only one of the two; the other must remain.
    h.update_approval_rules(always_allow_global=set())
    assert h._always_allow_global == set()
    assert h._always_allow_project == {"file_write"}


# ---------------- Module-level constants ----------------


def test_default_approval_tools_set() -> None:
    assert DEFAULT_APPROVAL_TOOLS == frozenset(
        {
            "code_run",
            "file_write",
            "file_patch",
            "start_long_term_update",
        }
    )


def test_needs_approval_logic(fake_parent: MagicMock) -> None:
    h = _make_handler(fake_parent, MagicMock())
    assert h.needs_approval("code_run")
    assert not h.needs_approval("file_read")
    h.update_approval_rules(always_allow_global={"code_run"})
    assert not h.needs_approval("code_run")


def test_rules_persist_across_handler_instances(fake_parent: MagicMock) -> None:
    """Always-allow decisions must survive handler reconstruction.

    agentmain.run() rebuilds the handler on every put_task. The bridge
    entrypoint owns session-level rule sets and passes the same references
    into each new handler. Decisions made in handler A must be visible to
    handler B when both share the same set.
    """
    shared_global: set[str] = set()
    shared_project: set[str] = set()

    h1 = _make_handler(
        fake_parent,
        MagicMock(return_value="always_allow_global"),
        always_allow_global=shared_global,
        always_allow_project=shared_project,
    )
    _drain(h1.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    assert "code_run" in shared_global  # h1 mutated the shared set

    # Simulate next put_task: a fresh handler with the same shared sets.
    approval_for_h2 = MagicMock()
    h2 = _make_handler(
        fake_parent,
        approval_for_h2,
        always_allow_global=shared_global,
        always_allow_project=shared_project,
    )
    _drain(h2.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval_for_h2.assert_not_called()  # rule from h1 still in effect


def test_update_approval_rules_mutates_in_place(fake_parent: MagicMock) -> None:
    """External holders of the rule sets must see updates."""
    shared_global: set[str] = {"code_run"}
    h = _make_handler(
        fake_parent,
        MagicMock(),
        always_allow_global=shared_global,
    )
    h.update_approval_rules(always_allow_global={"file_write"})
    # Same set object, content replaced.
    assert shared_global == {"file_write"}


# ---------------- YOLO mode (PRD §11.5) ----------------


def test_yolo_mode_skips_request_for_approval_tools(fake_parent: MagicMock) -> None:
    """When the yolo_check returns True, gated tools run without
    consulting the approval requester. This is the core promise of
    YOLO mode (PRD §11.5)."""
    approval = MagicMock()
    h = _make_handler(fake_parent, approval, yolo_check=lambda: True)
    yielded, ret = _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    approval.assert_not_called()
    assert ret.data["status"] == "success"
    assert any("code_run ran" in y for y in yielded)


def test_yolo_mode_does_not_affect_non_approval_tools(fake_parent: MagicMock) -> None:
    """Non-gated tools were already passing through; YOLO is a no-op
    for them. Mostly a sanity guard against regressions."""
    approval = MagicMock()
    h = _make_handler(fake_parent, approval, yolo_check=lambda: True)
    _drain(h.dispatch("test_tool", {"a": 1}, response=MagicMock()))
    approval.assert_not_called()


def test_yolo_check_evaluated_per_dispatch(fake_parent: MagicMock) -> None:
    """The yolo flag must be read on each dispatch (closure semantics),
    not snapshot at handler construction. The bridge flips
    SessionState.yolo_mode at runtime via SetYoloModeCommand and
    expects the next tool call to honour the new value."""
    flag = {"on": False}
    approval = MagicMock(return_value="allow_once")
    h = _make_handler(fake_parent, approval, yolo_check=lambda: flag["on"])

    # First dispatch: yolo off → approval consulted.
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    assert approval.call_count == 1

    # Flip flag mid-session.
    flag["on"] = True
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    # Approval not called again.
    assert approval.call_count == 1

    # Flip back off.
    flag["on"] = False
    _drain(h.dispatch("code_run", {"type": "python"}, response=MagicMock()))
    assert approval.call_count == 2


def test_yolo_mode_overrides_always_allow_lists(fake_parent: MagicMock) -> None:
    """YOLO is upper priority — it short-circuits before the
    always_allow checks. Behaviorally indistinguishable from the
    always_allow path, but verifies needs_approval order."""
    h = _make_handler(
        fake_parent,
        MagicMock(),
        always_allow_global={"file_write"},
        yolo_check=lambda: True,
    )
    # code_run is in DEFAULT_APPROVAL_TOOLS but not in always_allow_*.
    # Without YOLO this would hit the approval requester. With YOLO it
    # bypasses everything.
    assert not h.needs_approval("code_run")
    assert not h.needs_approval("file_write")  # always_allow path also bypassed
    assert not h.needs_approval("file_read")  # not gated to begin with


def test_yolo_off_by_default(fake_parent: MagicMock) -> None:
    """Handlers built without an explicit yolo_check default to "off"
    (callers using older constructor signatures keep working)."""
    h = _make_handler(fake_parent, MagicMock())
    assert h.needs_approval("code_run")  # gated as before
