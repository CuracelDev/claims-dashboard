import unittest

from scripts.piles_auto_assignment.domain import FilterEvidence
from scripts.piles_auto_assignment.evidence import evaluate_filter_evidence


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


if __name__ == "__main__":
    unittest.main()
