"""Pure decisions for deciding whether portal filters have settled safely."""

from dataclasses import dataclass
import re
from typing import Any, Iterable, Mapping

from .domain import AttemptStatus, FilterEvidence, WaitDecision


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


@dataclass(frozen=True)
class IdentityMatch:
    indexes: tuple[int, ...]
    method: str = ""
    ambiguous: bool = False


def select_identity_match_indexes(
    candidates: Iterable[Mapping[str, Any]],
    *,
    expected_portal_identity_hash: str = "",
    expected_aliases: Iterable[str] = (),
    expected_natural_identity_hash: str = "",
) -> IdentityMatch:
    """Select one exact identity by descending evidence strength."""
    rows = tuple(candidates)

    def result(
        indexes: list[int], method: str, *, require_unique: bool,
    ) -> IdentityMatch:
        return IdentityMatch(
            tuple(indexes), method,
            ambiguous=require_unique and len(indexes) > 1,
        )

    portal_hash = str(expected_portal_identity_hash or "").strip().lower()
    if portal_hash:
        matched = [
            index for index, candidate in enumerate(rows)
            if str(candidate.get("portal_identity_hash") or "").strip().lower() == portal_hash
        ]
        if matched:
            return result(matched, "portal_identity_hash", require_unique=True)

    aliases = {str(value or "").strip() for value in expected_aliases if str(value or "").strip()}
    if aliases:
        matched = [
            index for index, candidate in enumerate(rows)
            if aliases & {
                str(value or "").strip()
                for value in candidate.get("aliases", ())
                if str(value or "").strip()
            }
        ]
        if matched:
            return result(matched, "canonical_alias", require_unique=False)

    natural_hash = str(expected_natural_identity_hash or "").strip().lower()
    if natural_hash:
        matched = [
            index for index, candidate in enumerate(rows)
            if str(candidate.get("natural_identity_hash") or "").strip().lower() == natural_hash
        ]
        if matched:
            return result(matched, "unique_natural_identity", require_unique=True)

    return IdentityMatch(())


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


def decide_filter_wait(evidence: FilterEvidence, elapsed_ms: float,
                       response_grace_ms: float = 1500) -> WaitDecision:
    """Positive evidence may settle early; unknown evidence never means empty."""
    decision = evaluate_filter_evidence(evidence)
    network = evidence.details.get('network', {})
    authoritative = isinstance(network, Mapping) and network.get('authoritative') is True
    if evidence.network_state == 'failed':
        return WaitDecision('fail', 'filter_response_failed')
    if evidence.network_state == 'succeeded' and authoritative:
        if evidence.table_state == 'empty' and network.get('authoritative_empty') is not True:
            return WaitDecision('fail', 'empty_ui_conflicts_with_response')
        if evidence.details.get('dom_matches_response') is False:
            return WaitDecision('fail', 'filter_dom_response_mismatch')
    positive = (evidence.details.get('positive_dom') is True
                and evidence.details.get('generation_fresh') is True)
    coherent = (evidence.network_state == 'succeeded' and authoritative
                and evidence.details.get('dom_matches_response') is True)
    if decision.accepted and (coherent or (evidence.network_state == 'not_observed' and positive)):
        if elapsed_ms >= response_grace_ms:
            return WaitDecision('accept', decision.code)
    if elapsed_ms >= 30000:
        return WaitDecision('retry', 'filter_settlement_timeout')
    return WaitDecision('continue', 'filter_settlement_pending')


def evaluate_filter_evidence(evidence: FilterEvidence) -> EvidenceDecision:
    if evidence.network_state == "failed":
        return EvidenceDecision(False, "filter_response_failed")
    if not evidence.controls_match:
        return EvidenceDecision(False, "controls_not_confirmed")
    if evidence.details.get('request_pending') is True:
        return EvidenceDecision(False, 'filter_request_pending')
    selection_changed = evidence.details.get("selection_changed") is True
    network_details = evidence.details.get("network", {})
    authoritative_empty = (
        isinstance(network_details, Mapping)
        and network_details.get("authoritative_empty") is True
    )
    if (evidence.network_state == 'not_observed'
            and evidence.details.get('positive_dom') is True
            and evidence.details.get('generation_fresh') is True
            and evidence.table_state in {'stable', 'empty'}):
        return EvidenceDecision(True, 'confirmed_positive_dom')
    if selection_changed and evidence.network_state != "succeeded":
        return EvidenceDecision(False, "filter_response_not_confirmed")
    if (
        selection_changed
        and (
            not isinstance(network_details, Mapping)
            or network_details.get("authoritative") is not True
        )
    ):
        return EvidenceDecision(False, "filter_response_payload_unreadable")
    if evidence.table_state == "empty" and selection_changed and not authoritative_empty:
        return EvidenceDecision(False, "empty_ui_conflicts_with_response")
    if selection_changed and evidence.details.get("dom_matches_response") is not True:
        return EvidenceDecision(False, "filter_dom_response_mismatch")
    if evidence.table_state == "structurally_empty":
        if evidence.network_state == "succeeded" and authoritative_empty:
            return EvidenceDecision(True, "confirmed_structural_empty")
        return EvidenceDecision(False, "structural_empty_without_authoritative_response")
    if evidence.table_state not in {"stable", "empty"}:
        return EvidenceDecision(False, "table_not_settled")
    if evidence.network_state == "succeeded":
        return EvidenceDecision(True, "confirmed")
    return EvidenceDecision(True, "confirmed_without_network")
