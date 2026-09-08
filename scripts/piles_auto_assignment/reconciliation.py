"""Evidence-driven reconciliation for uncertain assignment attempts."""

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .domain import AttemptStatus
from .evidence import AttemptDecision, AttemptEvidence


@dataclass(frozen=True)
class Observation:
    assignable: bool
    assignee: str
    source: str = "original_context"


def _label(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def reconcile_attempt(
    observations: Iterable[Observation],
    expected_assignee: str,
    *,
    attempt_id: str = "",
    tracking_key: str = "",
) -> AttemptDecision:
    items = tuple(observations)
    expected = _label(expected_assignee)
    nonblank = {_label(item.assignee) for item in items if _label(item.assignee)}
    unexpected = sorted(value for value in nonblank if value != expected)
    if unexpected:
        return AttemptDecision(
            attempt_id,
            tracking_key,
            AttemptStatus.CONFLICT,
            AttemptEvidence("reconciled_unexpected_assignee", {"observed_assignees": unexpected}),
        )
    if expected and expected in nonblank:
        return AttemptDecision(
            attempt_id,
            tracking_key,
            AttemptStatus.CONFIRMED_RECONCILED,
            AttemptEvidence("reconciled_expected_assignee", {}),
        )
    if any(item.assignable and not _label(item.assignee) for item in items):
        return AttemptDecision(
            attempt_id,
            tracking_key,
            AttemptStatus.STILL_UNASSIGNED,
            AttemptEvidence("positively_observed_unassigned", {}),
        )
    return AttemptDecision(
        attempt_id,
        tracking_key,
        AttemptStatus.RECONCILIATION_PENDING,
        AttemptEvidence("no_positive_assignment_evidence", {}),
    )


def reconcile_pending_for_insurer(
    portal: Any,
    ledger: Any,
    pending_attempts: Iterable[Mapping[str, Any]],
) -> tuple[AttemptDecision, ...]:
    decisions = []
    for attempt in pending_attempts:
        attempt_id = str(attempt.get("id") or "")
        tracking_key = str(attempt.get("tracking_key") or "")
        current = AttemptStatus(str(attempt.get("status") or "reconciliation_pending"))
        if current in {AttemptStatus.SELECTED, AttemptStatus.SUBMITTED}:
            ledger.transition_attempt(
                attempt_id,
                AttemptStatus.RECONCILIATION_PENDING,
                expected={current},
                evidence=AttemptEvidence("reconciliation_started", {}),
            )
            current = AttemptStatus.RECONCILIATION_PENDING
        observations = portal.observe_attempt(attempt)
        decision = reconcile_attempt(
            observations,
            str(attempt.get("intended_portal_assignee") or ""),
            attempt_id=attempt_id,
            tracking_key=tracking_key,
        )
        if decision.status != AttemptStatus.RECONCILIATION_PENDING:
            ledger.transition_attempt(
                attempt_id,
                decision.status,
                expected={current},
                evidence=decision.evidence,
            )
        decisions.append(decision)
    return tuple(decisions)
