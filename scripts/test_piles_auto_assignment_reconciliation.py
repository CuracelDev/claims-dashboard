import unittest

from scripts.piles_auto_assignment.domain import AttemptStatus
from scripts.piles_auto_assignment.reconciliation import (
    Observation,
    reconcile_attempt,
    reconcile_pending_for_insurer,
)


class ReconciliationDecisionTests(unittest.TestCase):
    def test_disappearance_without_positive_evidence_stays_pending(self):
        self.assertEqual(
            reconcile_attempt([], "CVEBOT3").status,
            AttemptStatus.RECONCILIATION_PENDING,
        )

    def test_only_positive_unassigned_observation_enables_retry(self):
        decision = reconcile_attempt(
            [Observation(assignable=True, assignee="")],
            "CVEBOT3",
        )
        self.assertEqual(decision.status, AttemptStatus.STILL_UNASSIGNED)

    def test_positive_expected_assignment_confirms(self):
        decision = reconcile_attempt(
            [Observation(assignable=False, assignee="CVEBOT3")],
            "CVEBOT3",
        )
        self.assertEqual(decision.status, AttemptStatus.CONFIRMED_RECONCILED)

    def test_wrong_nonblank_assignee_is_conflict(self):
        decision = reconcile_attempt(
            [Observation(assignable=False, assignee="Other Bot")],
            "CVEBOT3",
        )
        self.assertEqual(decision.status, AttemptStatus.CONFLICT)


class ReconciliationWorkflowTests(unittest.TestCase):
    def test_submitted_attempt_enters_reconciliation_before_terminal_decision(self):
        events = []

        class Portal:
            def observe_attempt(self, _attempt):
                return [Observation(assignable=False, assignee="CVEBOT3")]

        class Ledger:
            def transition_attempt(self, attempt_id, status, **_kwargs):
                events.append((attempt_id, status))

        reconcile_pending_for_insurer(
            Portal(),
            Ledger(),
            [{
                "id": "attempt-1",
                "status": "submitted",
                "intended_portal_assignee": "CVEBOT3",
            }],
        )

        self.assertEqual(events, [
            ("attempt-1", AttemptStatus.RECONCILIATION_PENDING),
            ("attempt-1", AttemptStatus.CONFIRMED_RECONCILED),
        ])


if __name__ == "__main__":
    unittest.main()
