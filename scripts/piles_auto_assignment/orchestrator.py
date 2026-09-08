"""Insurer-scoped workflow outcomes and stable operational error classes."""

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Sequence

from .domain import ContextStatus, InsurerRunStatus
from .scanning import IncompleteScan


class IncompleteWorkflow(RuntimeError):
    """Raised when a no-work outcome cannot be proven from all scan contexts."""


@dataclass(frozen=True)
class InsurerOutcome:
    insurer_name: str
    status: InsurerRunStatus
    value: Any = None
    error_code: str = ""
    error_message: str = ""


@dataclass(frozen=True)
class WorkflowResult:
    status: InsurerRunStatus
    outcomes: tuple[InsurerOutcome, ...]


def classify_runner_error(error: BaseException) -> str:
    """Map unstable exception text to a bounded operator-facing code."""
    if isinstance(error, IncompleteScan):
        return "scan_incomplete"
    if isinstance(error, TimeoutError) or "timeout" in type(error).__name__.lower():
        return "portal_timeout"
    message = str(error).lower()
    if "filter" in message and any(word in message for word in ("response", "settle", "control")):
        return "filter_not_confirmed"
    if "login" in message or "credential" in message:
        return "authentication_failed"
    if "assignee" in message and ("conflict" in message or "matched multiple" in message):
        return "assignment_conflict"
    if "configuration" in message or "configured" in message:
        return "invalid_configuration"
    return "unexpected_error"


def derive_overall_run_status(statuses: Iterable[InsurerRunStatus]) -> InsurerRunStatus:
    values = tuple(InsurerRunStatus(value) for value in statuses)
    successful = sum(value in {
        InsurerRunStatus.COMPLETED,
        InsurerRunStatus.MANUAL_ACTION_REQUIRED,
    } for value in values)
    failed = sum(value == InsurerRunStatus.FAILED for value in values)
    if failed and successful:
        return InsurerRunStatus.PARTIAL
    if failed:
        return InsurerRunStatus.FAILED
    if any(value == InsurerRunStatus.MANUAL_ACTION_REQUIRED for value in values):
        return InsurerRunStatus.MANUAL_ACTION_REQUIRED
    return InsurerRunStatus.COMPLETED


def finalize_no_work(context_statuses: Sequence[ContextStatus]) -> InsurerRunStatus:
    values = tuple(ContextStatus(value) for value in context_statuses)
    if not values or any(value not in {ContextStatus.COMPLETE, ContextStatus.EMPTY} for value in values):
        raise IncompleteWorkflow("Every expected scan context must be complete or explicitly empty.")
    return InsurerRunStatus.COMPLETED


def run_insurer_workflows(
    insurer_names: Iterable[str],
    workflow: Callable[[str], Any],
) -> WorkflowResult:
    outcomes = []
    for insurer_name in insurer_names:
        try:
            value = workflow(insurer_name)
            outcomes.append(InsurerOutcome(insurer_name, InsurerRunStatus.COMPLETED, value=value))
        except Exception as error:
            outcomes.append(InsurerOutcome(
                insurer_name,
                InsurerRunStatus.FAILED,
                error_code=classify_runner_error(error),
                error_message=str(error)[:500],
            ))
    return WorkflowResult(
        derive_overall_run_status(outcome.status for outcome in outcomes),
        tuple(outcomes),
    )


def is_harmless_shutdown_warning(message: str) -> bool:
    """Recognize only Playwright's teardown-only close warning."""
    normalized = " ".join(str(message).lower().split())
    action_words = ("click", "assign", "scan", "filter", "login", "navigate")
    return (
        "target page, context or browser has been closed" in normalized
        and not any(word in normalized for word in action_words)
    )
