"""Pure assignment-provenance decisions.

Configured bot owners are routing metadata. They are never treated as the
actor who performed a portal assignment.
"""

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from .domain import AssignmentOwnership, AttemptStatus


_CONFIRMED_STATUSES = {
    AttemptStatus.CONFIRMED_VISIBLE.value,
    AttemptStatus.CONFIRMED_RECONCILED.value,
}
_PENDING_STATUSES = {
    AttemptStatus.SELECTED.value,
    AttemptStatus.SUBMITTED.value,
    AttemptStatus.RECONCILIATION_PENDING.value,
}


def _value(item: Mapping[str, Any], key: str) -> str:
    return str(item.get(key) or "").strip()


def _label(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


@dataclass(frozen=True)
class OwnershipEvidence:
    ownership: AssignmentOwnership
    reason_code: str
    observed_assignee: str
    configured_owner: str = ""
    attempt_id: str = ""
    insurer_run_id: str = ""
    tracked_pile_id: str = ""
    actor_id: str = ""
    evidence_source: str = ""
    ambiguous: bool = False


def classify_assignment_ownership(
    *,
    observed_assignee: str,
    configured_owner: str = "",
    tracked_matches: Iterable[Mapping[str, Any]] = (),
    attempt_matches: Iterable[Mapping[str, Any]] = (),
    external_audit: Mapping[str, Any] | None = None,
) -> OwnershipEvidence:
    """Classify an assigned row without inferring an actor from missing data."""
    observed = str(observed_assignee or "").strip()
    owner = str(configured_owner or "").strip()
    tracked = tuple(tracked_matches)
    attempts = tuple(attempt_matches)

    distinct_tracked = {_value(item, "id") for item in tracked if _value(item, "id")}
    if len(distinct_tracked) > 1:
        return OwnershipEvidence(
            AssignmentOwnership.CONFLICT,
            "ambiguous_runner_evidence",
            observed,
            configured_owner=owner,
            ambiguous=True,
        )

    if tracked:
        matched = tracked[0]
        expected = _label(_value(matched, "current_assigned"))
        if expected and _label(observed) != expected:
            return OwnershipEvidence(
                AssignmentOwnership.CONFLICT,
                "runner_evidence_assignee_conflict",
                observed,
                configured_owner=owner,
            )
        return OwnershipEvidence(
            AssignmentOwnership.RUNNER_CONFIRMED,
            "tracked_assignment_matches_assignee",
            observed,
            configured_owner=owner,
            tracked_pile_id=_value(matched, "id"),
            evidence_source="tracked_pile",
        )

    confirmed = [item for item in attempts if _value(item, "status") in _CONFIRMED_STATUSES]
    distinct_confirmed = {_value(item, "id") for item in confirmed if _value(item, "id")}
    if len(distinct_confirmed) > 1:
        return OwnershipEvidence(
            AssignmentOwnership.CONFLICT,
            "ambiguous_runner_evidence",
            observed,
            configured_owner=owner,
            ambiguous=True,
        )
    if confirmed:
        matched = confirmed[0]
        expected = _label(_value(matched, "intended_portal_assignee"))
        if expected and _label(observed) != expected:
            return OwnershipEvidence(
                AssignmentOwnership.CONFLICT,
                "runner_evidence_assignee_conflict",
                observed,
                configured_owner=owner,
            )
        return OwnershipEvidence(
            AssignmentOwnership.RUNNER_CONFIRMED,
            "confirmed_attempt_matches_assignee",
            observed,
            configured_owner=owner,
            attempt_id=_value(matched, "id"),
            insurer_run_id=_value(matched, "insurer_run_id"),
            tracked_pile_id=_value(matched, "tracked_pile_id"),
            evidence_source="assignment_attempt",
        )

    pending = [item for item in attempts if _value(item, "status") in _PENDING_STATUSES]
    distinct_pending = {_value(item, "id") for item in pending if _value(item, "id")}
    if len(distinct_pending) > 1:
        return OwnershipEvidence(
            AssignmentOwnership.CONFLICT,
            "ambiguous_runner_evidence",
            observed,
            configured_owner=owner,
            ambiguous=True,
        )
    if pending:
        matched = pending[0]
        expected = _label(_value(matched, "intended_portal_assignee"))
        if expected and _label(observed) != expected:
            return OwnershipEvidence(
                AssignmentOwnership.CONFLICT,
                "runner_evidence_assignee_conflict",
                observed,
                configured_owner=owner,
            )
        return OwnershipEvidence(
            AssignmentOwnership.RUNNER_PENDING,
            "pending_attempt_matches_assignee",
            observed,
            configured_owner=owner,
            attempt_id=_value(matched, "id"),
            insurer_run_id=_value(matched, "insurer_run_id"),
            tracked_pile_id=_value(matched, "tracked_pile_id"),
            evidence_source="assignment_attempt",
        )

    audit = external_audit or {}
    verified = audit.get("verified") is True
    actor_type = _label(audit.get("actor_type"))
    source = _value(audit, "source")
    if verified and source and actor_type and actor_type not in {"runner", "automation"}:
        return OwnershipEvidence(
            AssignmentOwnership.VERIFIED_EXTERNAL,
            "positive_external_actor_evidence",
            observed,
            configured_owner=owner,
            actor_id=_value(audit, "actor_id"),
            evidence_source=source,
        )

    return OwnershipEvidence(
        AssignmentOwnership.UNLINKED,
        "no_runner_or_actor_evidence",
        observed,
        configured_owner=owner,
    )
