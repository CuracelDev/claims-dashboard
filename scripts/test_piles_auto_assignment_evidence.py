import unittest

from scripts.piles_auto_assignment.domain import FilterEvidence
from scripts.piles_auto_assignment.domain import AttemptStatus
from scripts.piles_auto_assignment.evidence import (
    classify_assignment_observations,
    evaluate_filter_evidence,
)


class FilterEvidenceTests(unittest.TestCase):
    def test_noop_selection_with_matching_controls_and_stable_table_passes(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(
                month_matches=True,
                year_matches=True,
                status_matches=True,
                table_state="stable",
                network_state="not_observed",
            )
        )
        self.assertTrue(decision.accepted)
        self.assertEqual(decision.code, "confirmed_without_network")

    def test_explicit_empty_table_is_valid_evidence(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(True, True, True, "empty", "succeeded")
        )
        self.assertTrue(decision.accepted)

    def test_failed_response_rejects_even_if_controls_match(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(True, True, True, "stable", "failed")
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "filter_response_failed")

    def test_unsettled_table_rejects_even_after_successful_response(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(True, True, True, "unreadable", "succeeded")
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "table_not_settled")

    def test_wrong_control_value_is_rejected(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(True, False, True, "stable", "succeeded")
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "controls_not_confirmed")


class AssignmentEvidenceTests(unittest.TestCase):
    def test_missing_rows_are_pending_not_failed_or_confirmed(self):
        decisions = classify_assignment_observations(
            {
                "pile-1": {"attempt_id": "attempt-1", "expected_assignee": "CVEBOT3"},
                "pile-2": {"attempt_id": "attempt-2", "expected_assignee": "CVEBOT3"},
            },
            observed={},
        )
        self.assertTrue(all(
            item.status == AttemptStatus.RECONCILIATION_PENDING
            for item in decisions
        ))

    def test_visible_wrong_assignee_is_conflict(self):
        decision = classify_assignment_observations(
            {"pile-1": {"attempt_id": "attempt-1", "expected_assignee": "CVEBOT3"}},
            {"pile-1": "Other Bot"},
        )[0]
        self.assertEqual(decision.status, AttemptStatus.CONFLICT)

    def test_visible_blank_assignee_remains_pending_during_initial_verification(self):
        decision = classify_assignment_observations(
            {"pile-1": {"attempt_id": "attempt-1", "expected_assignee": "CVEBOT3"}},
            {"pile-1": ""},
        )[0]
        self.assertEqual(decision.status, AttemptStatus.RECONCILIATION_PENDING)

    def test_visible_expected_assignee_is_confirmed(self):
        decision = classify_assignment_observations(
            {"pile-1": {"attempt_id": "attempt-1", "expected_assignee": "CVEBOT3"}},
            {"pile-1": "CVEBOT3"},
        )[0]
        self.assertEqual(decision.status, AttemptStatus.CONFIRMED_VISIBLE)


if __name__ == "__main__":
    unittest.main()
