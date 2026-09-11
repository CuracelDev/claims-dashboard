import unittest
from dataclasses import replace
from scripts.piles_auto_assignment import evidence as evidence_module

from scripts.piles_auto_assignment.domain import FilterEvidence
from scripts.piles_auto_assignment.domain import AttemptStatus
from scripts.piles_auto_assignment.evidence import (
    classify_assignment_observations,
    evaluate_filter_evidence,
)


class FilterEvidenceTests(unittest.TestCase):
    def wait(self, evidence, elapsed):
        self.assertTrue(hasattr(evidence_module, 'decide_filter_wait'), 'pure wait decision missing')
        return evidence_module.decide_filter_wait(evidence, elapsed).decision

    def test_positive_dom_evidence_requires_grace_and_stability(self):
        for state in ('empty', 'stable'):
            evidence = FilterEvidence(True, True, True, state, 'not_observed',
                                      {'selection_changed': True, 'positive_dom': True, 'generation_fresh': True})
            self.assertEqual(self.wait(evidence, 1499), 'continue')
            self.assertEqual(self.wait(evidence, 1500), 'accept')
            self.assertEqual(self.wait(replace(evidence, year_matches=False), 1500), 'continue')
            self.assertEqual(self.wait(replace(evidence, details={'selection_changed': True}), 1500), 'continue')
            self.assertEqual(self.wait(replace(evidence, details={'selection_changed': True, 'positive_dom': True}), 1500), 'continue')
            self.assertEqual(self.wait(replace(evidence, details={'positive_dom': True}), 1500), 'continue')

    def test_unknown_evidence_waits_until_cap_then_retries(self):
        for state in ('unreadable', 'loading', 'structurally_empty'):
            evidence = FilterEvidence(True, True, True, state, 'not_observed')
            self.assertEqual(self.wait(evidence, 1500), 'continue')
            self.assertEqual(self.wait(evidence, 29999), 'continue')
            self.assertEqual(self.wait(evidence, 30000), 'retry')
        unknown = FilterEvidence(True, True, True, 'empty', 'succeeded',
                                 {'selection_changed': True, 'positive_dom': True,
                                  'network': {'authoritative': False}})
        self.assertEqual(self.wait(unknown, 1500), 'continue')
        self.assertEqual(self.wait(replace(unknown, network_state='unknown'), 1500), 'continue')
        self.assertEqual(self.wait(replace(unknown, network_state='unknown', details={'positive_dom': True}), 1500), 'continue')
        self.assertEqual(self.wait(FilterEvidence(True, True, True, 'stable', 'succeeded'), 1500), 'continue')

    def test_observed_contradictions_fail_without_grace(self):
        for evidence in (
            FilterEvidence(True, True, True, 'empty', 'failed'),
            FilterEvidence(True, True, True, 'empty', 'succeeded', {
                'selection_changed': True, 'positive_dom': True,
                'network': {'authoritative': True, 'authoritative_empty': False},
                'dom_matches_response': False}),
            FilterEvidence(True, True, True, 'stable', 'succeeded', {
                'selection_changed': True, 'network': {'authoritative': True},
                'dom_matches_response': False}),
        ):
            self.assertEqual(self.wait(evidence, 0), 'fail')
            self.assertEqual(self.wait(replace(evidence, year_matches=False), 0), 'fail')

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

    def test_changed_filter_requires_its_exact_network_response(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(
                True,
                True,
                True,
                "stable",
                "not_observed",
                {"selection_changed": True},
            )
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "filter_response_not_confirmed")

    def test_changed_filter_empty_ui_requires_authoritative_empty_payload(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(
                True,
                True,
                True,
                "empty",
                "succeeded",
                {
                    "selection_changed": True,
                    "network": {"authoritative": True, "authoritative_empty": False},
                    "dom_matches_response": False,
                },
            )
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "empty_ui_conflicts_with_response")

    def test_changed_filter_rejects_stable_old_rows_against_empty_payload(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(
                True,
                True,
                True,
                "stable",
                "succeeded",
                {
                    "selection_changed": True,
                    "network": {"authoritative": True, "authoritative_empty": True},
                    "dom_matches_response": False,
                },
            )
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "filter_dom_response_mismatch")

    def test_changed_filter_accepts_only_coherent_authoritative_response(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(
                True,
                True,
                True,
                "stable",
                "succeeded",
                {
                    "selection_changed": True,
                    "network": {"authoritative": True, "item_count": 2},
                    "dom_matches_response": True,
                },
            )
        )
        self.assertTrue(decision.accepted)

    def test_structurally_empty_table_requires_matching_network_success(self):
        accepted = evaluate_filter_evidence(
            FilterEvidence(
                True,
                True,
                True,
                "structurally_empty",
                "succeeded",
                {"network": {"authoritative_empty": True}},
            )
        )
        rejected = evaluate_filter_evidence(
            FilterEvidence(
                True,
                True,
                True,
                "structurally_empty",
                "succeeded",
                {"network": {"authoritative_empty": False}},
            )
        )
        self.assertTrue(accepted.accepted)
        self.assertFalse(rejected.accepted)

    def test_structural_empty_rejects_stale_success_without_empty_payload(self):
        decision = evaluate_filter_evidence(
            FilterEvidence(True, True, True, "structurally_empty", "succeeded")
        )
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.code, "structural_empty_without_authoritative_response")

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
