"""Pure decisions for deciding whether portal filters have settled safely."""

from dataclasses import dataclass
import re
from typing import Any, Mapping

from .domain import AttemptStatus, FilterEvidence


@dataclass(frozen=True)
class EvidenceDecision:
    accepted: bool
    code: str


@dataclass(frozen=True)
class AttemptEvidence:
    code: str
    details: Mapping[str, Any]


@dataclass(frozen=True)
class AttemptDecision:
    attempt_id: str
    tracking_key: str
    status: AttemptStatus
    evidence: AttemptEvidence


def _label(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def classify_assignment_observations(
    expected: Mapping[str, Any],
    observed: Mapping[str, str],
) -> tuple[AttemptDecision, ...]:
    decisions = []
    for tracking_key, expectation in expected.items():
        if isinstance(expectation, Mapping):
            attempt_id = str(expectation.get("attempt_id") or "")
            expected_assignee = str(expectation.get("expected_assignee") or "")
        else:
            attempt_id = ""
            expected_assignee = str(expectation or "")
        if tracking_key not in observed:
            status = AttemptStatus.RECONCILIATION_PENDING
            evidence = AttemptEvidence("row_not_observed", {})
        else:
            observed_assignee = str(observed.get(tracking_key) or "")
            if not _label(observed_assignee):
                status = AttemptStatus.RECONCILIATION_PENDING
                evidence = AttemptEvidence("visible_unassigned_after_submit", {})
            elif _label(observed_assignee) == _label(expected_assignee) and _label(expected_assignee):
                status = AttemptStatus.CONFIRMED_VISIBLE
                evidence = AttemptEvidence(
                    "visible_expected_assignee",
                    {"observed_assignee": observed_assignee},
                )
            else:
                status = AttemptStatus.CONFLICT
                evidence = AttemptEvidence(
                    "visible_unexpected_assignee",
                    {"observed_assignee": observed_assignee},
                )
        decisions.append(AttemptDecision(attempt_id, tracking_key, status, evidence))
    return tuple(decisions)


def evaluate_filter_evidence(evidence: FilterEvidence) -> EvidenceDecision:
    if evidence.network_state == "failed":
        return EvidenceDecision(False, "filter_response_failed")
    if not evidence.controls_match:
        return EvidenceDecision(False, "controls_not_confirmed")
    if evidence.table_state not in {"stable", "empty"}:
        return EvidenceDecision(False, "table_not_settled")
    if evidence.network_state == "succeeded":
        return EvidenceDecision(True, "confirmed")
    return EvidenceDecision(True, "confirmed_without_network")
