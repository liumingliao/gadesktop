"""WorkbenchHandler: extends GenericAgentHandler with approval interception.

The approval gate sits in front of `super().dispatch()`. We don't rewrite
dispatch's body; we add a check before delegating to GA's original logic.
GA upgrades that change dispatch internals won't break this subclass as
long as the dispatch signature stays stable.

This module imports GA modules (`agent_loop`, `ga`). The caller must put
the GA installation path on sys.path before importing this module.
"""
from __future__ import annotations

from collections.abc import Callable, Generator
from typing import Any

# These imports require GA on sys.path. The bridge entrypoint and the
# pytest conftest both arrange for that before this module loads.
from agent_loop import StepOutcome
from ga import GenericAgentHandler

# Tools that require user approval by default. See PRD §11.2.
DEFAULT_APPROVAL_TOOLS: frozenset[str] = frozenset(
    {
        "code_run",
        "file_write",
        "file_patch",
        "start_long_term_update",
    }
)


# Risk classification surfaced via tool_call_pending events for the Approval Card.
RISK_LEVELS: dict[str, str] = {
    "code_run": "high",
    "file_write": "medium",
    "file_patch": "medium",
    "start_long_term_update": "high",
}


# Why each tool is gated. Shown in the Approval Card to give the user context.
APPROVAL_REASONS: dict[str, str] = {
    "code_run": "Executes arbitrary code; can modify files, processes, and network.",
    "file_write": "Writes to disk; can overwrite existing files.",
    "file_patch": "Modifies file content in place.",
    "start_long_term_update": "Updates GA's long-term memory files.",
}


# Approval callable signature. Bridge entrypoint constructs this and injects it.
# It must block until the desktop responds. Decision strings:
#   "allow_once" | "deny" | "always_allow_project" | "always_allow_global"
ApprovalRequester = Callable[[str, dict[str, Any]], str]


class WorkbenchHandler(GenericAgentHandler):  # type: ignore[misc]  # GA has no stubs
    """GA handler that gates high-risk tool calls behind user approval."""

    def __init__(
        self,
        parent: Any,
        last_history: list[str] | None = None,
        cwd: str = "./temp",
        *,
        request_approval: ApprovalRequester,
        approval_tools: frozenset[str] = DEFAULT_APPROVAL_TOOLS,
        always_allow_global: set[str] | None = None,
        always_allow_project: set[str] | None = None,
    ) -> None:
        super().__init__(parent, last_history, cwd)
        self._request_approval = request_approval
        self._approval_tools = approval_tools
        # Shared references on purpose: agentmain.run() rebuilds the handler
        # on every put_task, so always-allow rules must outlive any single
        # handler. The bridge entrypoint owns these sets at session scope and
        # passes the same references in each time. dispatch's `.add()` and
        # update_approval_rules's mutations all operate in place.
        self._always_allow_global: set[str] = (
            always_allow_global if always_allow_global is not None else set()
        )
        self._always_allow_project: set[str] = (
            always_allow_project if always_allow_project is not None else set()
        )

    def update_approval_rules(
        self,
        always_allow_global: set[str] | None = None,
        always_allow_project: set[str] | None = None,
    ) -> None:
        """Sync always-allow lists from the desktop (SetApprovalRulesCommand).

        Mutates the underlying sets in place so external holders of the
        same references see the updated state.
        """
        if always_allow_global is not None:
            self._always_allow_global.clear()
            self._always_allow_global.update(always_allow_global)
        if always_allow_project is not None:
            self._always_allow_project.clear()
            self._always_allow_project.update(always_allow_project)

    def needs_approval(self, tool_name: str) -> bool:
        """Return True iff this tool requires user approval right now."""
        if tool_name not in self._approval_tools:
            return False
        if tool_name in self._always_allow_global:
            return False
        if tool_name in self._always_allow_project:
            return False
        return True

    def dispatch(
        self,
        tool_name: str,
        args: dict[str, Any],
        response: Any,
        index: int = 0,
    ) -> Generator[Any, None, Any]:
        if self.needs_approval(tool_name):
            # Defensive copy: super().dispatch mutates args (adds _index).
            # Approval Cards in the desktop UI must show the user-facing args,
            # not GA's internal bookkeeping state.
            decision = self._request_approval(tool_name, dict(args))
            if decision == "deny":
                yield f"[Approval] User denied: {tool_name}\n"
                return StepOutcome(
                    {"status": "denied", "msg": "User denied this tool call"},
                    next_prompt="\n",
                )
            if decision == "always_allow_global":
                self._always_allow_global.add(tool_name)
            elif decision == "always_allow_project":
                self._always_allow_project.add(tool_name)
            elif decision != "allow_once":
                # Fail-safe: unknown decision strings are treated as deny so a
                # buggy desktop or stale protocol can't accidentally authorize.
                yield f"[Approval] Unknown decision {decision!r}, treating as deny.\n"
                return StepOutcome(
                    {"status": "denied", "msg": f"Unknown approval decision: {decision}"},
                    next_prompt="\n",
                )
        return (yield from super().dispatch(tool_name, args, response, index))
