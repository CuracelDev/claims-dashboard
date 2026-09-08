import unittest

from scripts.piles_auto_assignment.domain import (
    AssignmentObservation,
    AttemptStatus,
    BatchStatus,
    ContextStatus,
    FilterEvidence,
    InsurerRunStatus,
    can_transition_attempt,
    derive_batch_status,
)


class AttemptTransitionTests(unittest.TestCase):
    def test_submitted_attempt_cannot_return_directly_to_planned(self):
        self.assertFalse(
            can_transition_attempt(AttemptStatus.SUBMITTED, AttemptStatus.PLANNED)
        )

    def test_submitted_attempt_can_enter_reconciliation(self):
        self.assertTrue(
            can_transition_attempt(
                AttemptStatus.SUBMITTED,
                AttemptStatus.RECONCILIATION_PENDING,
            )
        )

    def test_selected_attempt_can_enter_reconciliation_after_worker_crash(self):
        self.assertTrue(
            can_transition_attempt(
                AttemptStatus.SELECTED,
                AttemptStatus.RECONCILIATION_PENDING,
            )
        )

    def test_retry_is_allowed_only_after_positive_still_unassigned_evidence(self):
        self.assertTrue(
            can_transition_attempt(
                AttemptStatus.STILL_UNASSIGNED,
                AttemptStatus.PLANNED,
            )
        )
        self.assertFalse(
            can_transition_attempt(
                AttemptStatus.RECONCILIATION_PENDING,
                AttemptStatus.PLANNED,
            )
        )

    def test_terminal_attempts_cannot_transition(self):
        terminal_statuses = (
            AttemptStatus.CONFIRMED_VISIBLE,
            AttemptStatus.CONFIRMED_RECONCILED,
            AttemptStatus.MANUAL_ACTION_REQUIRED,
            AttemptStatus.CONFLICT,
            AttemptStatus.FAILED,
        )
        for status in terminal_statuses:
            with self.subTest(status=status):
                self.assertFalse(
                    can_transition_attempt(status, AttemptStatus.PLANNED)
                )


class BatchStatusTests(unittest.TestCase):
    def test_batch_with_confirmed_and_pending_items_is_partially_confirmed(self):
        self.assertEqual(
            derive_batch_status(
                [
                    AttemptStatus.CONFIRMED_VISIBLE,
                    AttemptStatus.RECONCILIATION_PENDING,
                ]
            ),
            BatchStatus.PARTIALLY_CONFIRMED,
        )

    def test_batch_with_only_confirmed_items_is_confirmed(self):
        self.assertEqual(
            derive_batch_status(
                [
                    AttemptStatus.CONFIRMED_VISIBLE,
                    AttemptStatus.CONFIRMED_RECONCILED,
                ]
            ),
            BatchStatus.CONFIRMED,
        )

    def test_empty_batch_is_planned(self):
        self.assertEqual(derive_batch_status([]), BatchStatus.PLANNED)

    def test_failed_or_conflicted_item_marks_batch_failed(self):
        for status in (AttemptStatus.FAILED, AttemptStatus.CONFLICT):
            with self.subTest(status=status):
                self.assertEqual(
                    derive_batch_status([AttemptStatus.CONFIRMED_VISIBLE, status]),
                    BatchStatus.FAILED,
                )


class DomainValueTests(unittest.TestCase):
    def test_persisted_values_are_stable_strings(self):
        self.assertEqual(AttemptStatus.PLANNED.value, "planned")
        self.assertEqual(BatchStatus.PARTIALLY_CONFIRMED.value, "partially_confirmed")
        self.assertEqual(ContextStatus.COMPLETE.value, "complete")
        self.assertEqual(InsurerRunStatus.MANUAL_ACTION_REQUIRED.value,
                         "manual_action_required")
        evidence = FilterEvidence(
            month_matches=True,
            year_matches=True,
            status_matches=True,
            table_state="stable",
            network_state="not_observed",
        )
        self.assertTrue(evidence.controls_match)
        observation = AssignmentObservation(
            tracking_key="pile-1",
            state="visible_assigned",
            observed_assignee="Daniel",
        )
        self.assertEqual(observation.state, "visible_assigned")


if __name__ == "__main__":
    unittest.main()
