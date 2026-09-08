"""Pure decisions for deciding whether portal filters have settled safely."""

from dataclasses import dataclass

from .domain import FilterEvidence


@dataclass(frozen=True)
class EvidenceDecision:
    accepted: bool
    code: str


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
