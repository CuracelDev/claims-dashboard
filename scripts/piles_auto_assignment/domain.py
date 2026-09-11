"""Persistence-safe states and evidence values for Piles assignment runs."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Iterable, Mapping, Optional


def _require_timezone_aware(name: str, value: datetime) -> None:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise ValueError(f"{name} must be timezone-aware")


class AttemptStatus(str, Enum):
    PLANNED = "planned"
    SELECTED = "selected"
    SUBMITTED = "submitted"
    CONFIRMED_VISIBLE = "confirmed_visible"
    CONFIRMED_RECONCILED = "confirmed_reconciled"
    RECONCILIATION_PENDING = "reconciliation_pending"
    STILL_UNASSIGNED = "still_unassigned"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    CONFLICT = "conflict"
    FAILED = "failed"


class BatchStatus(str, Enum):
    PLANNED = "planned"
    SELECTING = "selecting"
    SELECTED = "selected"
    SUBMITTED = "submitted"
    PARTIALLY_CONFIRMED = "partially_confirmed"
    CONFIRMED = "confirmed"
    RECONCILIATION_PENDING = "reconciliation_pending"
    CONFLICT = "conflict"
    FAILED = "failed"


class ContextStatus(str, Enum):
    PENDING = "pending"
    SCANNING = "scanning"
    COMPLETE = "complete"
    EMPTY = "empty"
    FAILED = "failed"


class InsurerRunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_ISSUES = "completed_with_issues"
    PARTIAL = "partial"
    FAILED = "failed"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    SKIPPED_INACTIVE = "skipped_inactive"
    SKIPPED_OVERLAP = "skipped_overlap"
    COVERED_BY_ACTIVE_CYCLE = "covered_by_active_cycle"
    CANCELLED = "cancelled"


class WorkSource(str, Enum):
    SCHEDULE = "schedule"
    MANUAL = "manual"
    READINESS = "readiness"
    RECOVERY = "recovery"


class RequestScope(str, Enum):
    ALL_ACTIVE = "all_active"
    SINGLE_INSURER = "single_insurer"


class WorkDisposition(str, Enum):
    QUEUED = "queued"
    CLAIMED = "claimed"
    COVERED_BY_ACTIVE_CYCLE = "covered_by_active_cycle"
    FOLLOW_UP_QUEUED = "follow_up_queued"
    INACTIVE = "inactive"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ParentRunStatus(str, Enum):
    QUEUED = "queued"
    STARTED = "started"
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_ISSUES = "completed_with_issues"
    FAILED = "failed"
    COVERED_BY_ACTIVE_CYCLE = "covered_by_active_cycle"
    CANCELLED = "cancelled"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    PARTIAL = "partial"
    SKIPPED_OVERLAP = "skipped_overlap"


@dataclass(frozen=True)
class WorkRequest:
    """An immutable request whose timestamp is an absolute point in time."""

    insurer_name: str
    source: WorkSource
    requested_at: datetime
    request_scope: Optional[RequestScope] = None

    def __post_init__(self) -> None:
        _require_timezone_aware("requested_at", self.requested_at)
        insurer_name = self.insurer_name.strip()
        if not insurer_name:
            raise ValueError("insurer_name must not be empty")
        source = WorkSource(self.source)
        scope = self.request_scope
        if scope is None:
            scope = (
                RequestScope.ALL_ACTIVE
                if source == WorkSource.SCHEDULE
                else RequestScope.SINGLE_INSURER
            )
        object.__setattr__(self, "insurer_name", insurer_name)
        object.__setattr__(self, "source", source)
        object.__setattr__(self, "request_scope", RequestScope(scope))


@dataclass(frozen=True)
class InsurerCoverage:
    """Immutable coverage evidence with timezone-aware lifecycle timestamps."""

    state: str = "idle"
    active_started_at: Optional[datetime] = None
    active_finished_at: Optional[datetime] = None
    active_run_id: str = ""
    active_request_scope: RequestScope = RequestScope.ALL_ACTIVE
    follow_up_queued: bool = False

    def __post_init__(self) -> None:
        for name in ("active_started_at", "active_finished_at"):
            value = getattr(self, name)
            if value is not None:
                _require_timezone_aware(name, value)
        state = str(self.state).strip().lower()
        if state not in {
            "idle",
            "queued",
            "claimed",
            "running",
            "completed",
            "follow_up_queued",
            "inactive",
        }:
            raise ValueError(f"Unsupported insurer coverage state: {self.state!r}")
        object.__setattr__(self, "state", state)
        object.__setattr__(
            self,
            "active_request_scope",
            RequestScope(self.active_request_scope),
        )


@dataclass(frozen=True)
class DispatchDecision:
    insurer_name: str
    source: WorkSource
    request_scope: RequestScope
    disposition: WorkDisposition
    generation_requested_at: datetime
    create_work_item: bool = True
    covered_by_insurer_run_id: str = ""


@dataclass(frozen=True)
class WaitDecision:
    decision: str
    code: str


@dataclass(frozen=True)
class FilterEvidence:
    month_matches: bool
    year_matches: bool
    status_matches: bool
    table_state: str
    network_state: str
    details: Mapping[str, Any] = field(default_factory=dict)

    @property
    def controls_match(self) -> bool:
        return self.month_matches and self.year_matches and self.status_matches


@dataclass(frozen=True)
class AssignmentObservation:
    tracking_key: str
    state: str
    observed_assignee: Optional[str] = None
    details: Mapping[str, Any] = field(default_factory=dict)


ATTEMPT_TRANSITIONS = {
    AttemptStatus.PLANNED: {
        AttemptStatus.SELECTED,
        AttemptStatus.MANUAL_ACTION_REQUIRED,
        AttemptStatus.FAILED,
    },
    AttemptStatus.SELECTED: {
        AttemptStatus.SUBMITTED,
        AttemptStatus.RECONCILIATION_PENDING,
        AttemptStatus.FAILED,
    },
    AttemptStatus.SUBMITTED: {
        AttemptStatus.CONFIRMED_VISIBLE,
        AttemptStatus.RECONCILIATION_PENDING,
        AttemptStatus.CONFLICT,
    },
    AttemptStatus.RECONCILIATION_PENDING: {
        AttemptStatus.CONFIRMED_RECONCILED,
        AttemptStatus.STILL_UNASSIGNED,
        AttemptStatus.MANUAL_ACTION_REQUIRED,
        AttemptStatus.CONFLICT,
        AttemptStatus.FAILED,
    },
    AttemptStatus.STILL_UNASSIGNED: {
        AttemptStatus.PLANNED,
        AttemptStatus.MANUAL_ACTION_REQUIRED,
        AttemptStatus.FAILED,
    },
}


def can_transition_attempt(current: AttemptStatus, target: AttemptStatus) -> bool:
    """Return whether an attempt may make the requested one-way transition."""
    try:
        current_status = AttemptStatus(current)
        target_status = AttemptStatus(target)
    except ValueError:
        return False
    return target_status in ATTEMPT_TRANSITIONS.get(current_status, set())


def derive_batch_status(statuses: Iterable[AttemptStatus]) -> BatchStatus:
    """Derive a conservative aggregate without hiding pending or failed work."""
    values = [AttemptStatus(status) for status in statuses]
    if not values:
        return BatchStatus.PLANNED

    status_set = set(values)
    confirmed = {
        AttemptStatus.CONFIRMED_VISIBLE,
        AttemptStatus.CONFIRMED_RECONCILED,
    }
    if status_set <= confirmed:
        return BatchStatus.CONFIRMED
    if AttemptStatus.CONFLICT in status_set:
        return BatchStatus.FAILED
    if AttemptStatus.FAILED in status_set:
        return BatchStatus.FAILED
    if status_set & confirmed:
        return BatchStatus.PARTIALLY_CONFIRMED
    if AttemptStatus.RECONCILIATION_PENDING in status_set:
        return BatchStatus.RECONCILIATION_PENDING
    if AttemptStatus.SUBMITTED in status_set:
        return BatchStatus.SUBMITTED
    if status_set == {AttemptStatus.SELECTED}:
        return BatchStatus.SELECTED
    return BatchStatus.PLANNED
