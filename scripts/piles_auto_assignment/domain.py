"""Persistence-safe states and evidence values for Piles assignment runs."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Optional


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
    PARTIAL = "partial"
    FAILED = "failed"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    SKIPPED_INACTIVE = "skipped_inactive"
    SKIPPED_OVERLAP = "skipped_overlap"


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
