import unittest
from datetime import datetime, timedelta, timezone

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

    def test_old_missing_submission_after_complete_scan_requires_manual_review(self):
        events = []
        now = datetime(2026, 9, 16, 8, tzinfo=timezone.utc)

        class Portal:
            def observe_attempt(self, _attempt):
                return []

        class Ledger:
            def transition_attempt(self, attempt_id, status, **kwargs):
                events.append((attempt_id, status, kwargs["evidence"].code))

        decisions = reconcile_pending_for_insurer(
            Portal(),
            Ledger(),
            [{
                "id": "attempt-1",
                "status": "reconciliation_pending",
                "submitted_at": (now - timedelta(hours=1)).isoformat(),
                "observed_at": now.isoformat(),
                "intended_portal_assignee": "CVEBOT3",
            }],
            minimum_missing_age=timedelta(minutes=30),
            missing_attempt_ids={"attempt-1"},
        )

        self.assertEqual(decisions[0].status, AttemptStatus.MANUAL_ACTION_REQUIRED)
        self.assertEqual(events, [(
            "attempt-1",
            AttemptStatus.MANUAL_ACTION_REQUIRED,
            "historical_submission_missing_after_complete_scan",
        )])

    def test_recent_missing_submission_remains_pending(self):
        now = datetime(2026, 9, 16, 8, tzinfo=timezone.utc)

        class Portal:
            def observe_attempt(self, _attempt):
                return []

        class Ledger:
            def transition_attempt(self, *_args, **_kwargs):
                raise AssertionError("recent uncertainty must remain pending")

        decisions = reconcile_pending_for_insurer(
            Portal(),
            Ledger(),
            [{
                "id": "attempt-1",
                "status": "reconciliation_pending",
                "submitted_at": now - timedelta(minutes=5),
                "observed_at": now,
                "intended_portal_assignee": "CVEBOT3",
            }],
            minimum_missing_age=timedelta(minutes=30),
            missing_attempt_ids={"attempt-1"},
        )

        self.assertEqual(decisions[0].status, AttemptStatus.RECONCILIATION_PENDING)

    def test_old_missing_submission_outside_completed_scope_remains_pending(self):
        now = datetime(2026, 9, 16, 8, tzinfo=timezone.utc)

        class Portal:
            def observe_attempt(self, _attempt):
                return []

        class Ledger:
            def transition_attempt(self, *_args, **_kwargs):
                raise AssertionError("out-of-scope absence is not evidence")

        decisions = reconcile_pending_for_insurer(
            Portal(), Ledger(), [{
                "id": "attempt-outside-scope",
                "status": "reconciliation_pending",
                "submitted_at": now - timedelta(days=1),
                "observed_at": now,
                "intended_portal_assignee": "CVEBOT3",
            }],
            minimum_missing_age=timedelta(minutes=30),
            missing_attempt_ids={"different-attempt"},
        )

        self.assertEqual(decisions[0].status, AttemptStatus.RECONCILIATION_PENDING)

    def test_positive_assignment_evidence_wins_even_when_submission_is_old(self):
        events = []
        now = datetime(2026, 9, 16, 8, tzinfo=timezone.utc)

        class Portal:
            def observe_attempt(self, _attempt):
                return [Observation(assignable=False, assignee="CVEBOT3")]

        class Ledger:
            def transition_attempt(self, attempt_id, status, **_kwargs):
                events.append((attempt_id, status))

        decisions = reconcile_pending_for_insurer(
            Portal(), Ledger(), [{
                "id": "attempt-1",
                "status": "reconciliation_pending",
                "submitted_at": now - timedelta(days=1),
                "observed_at": now,
                "intended_portal_assignee": "CVEBOT3",
            }], minimum_missing_age=timedelta(minutes=30), missing_attempt_ids={"attempt-1"},
        )

        self.assertEqual(decisions[0].status, AttemptStatus.CONFIRMED_RECONCILED)
        self.assertEqual(events, [("attempt-1", AttemptStatus.CONFIRMED_RECONCILED)])


if __name__ == "__main__":
    unittest.main()
