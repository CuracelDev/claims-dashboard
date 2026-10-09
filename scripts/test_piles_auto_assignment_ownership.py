import unittest


try:
    from scripts.piles_auto_assignment.domain import AssignmentOwnership, AttemptStatus
    from scripts.piles_auto_assignment.ownership import (
        OwnershipEvidence,
        classify_assignment_ownership,
    )
except ImportError:
    AssignmentOwnership = None
    AttemptStatus = None
    OwnershipEvidence = None
    classify_assignment_ownership = None


def attempt(
    status,
    assignee="CVEBOT1",
    *,
    attempt_id="attempt-1",
    insurer_run_id="run-1",
    tracking_key="pile-1",
):
    return {
        "id": attempt_id,
        "insurer_run_id": insurer_run_id,
        "tracking_key": tracking_key,
        "last_pile_key": f"{tracking_key}|volatile",
        "status": status,
        "intended_portal_assignee": assignee,
        "intended_owner_name": "Sophie",
    }


class AssignmentOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(
            classify_assignment_ownership,
            "assignment ownership classifier has not been implemented",
        )

    def classify(self, **overrides):
        values = {
            "observed_assignee": "CVEBOT1",
            "configured_owner": "Sophie",
            "tracked_matches": (),
            "attempt_matches": (),
            "external_audit": None,
        }
        values.update(overrides)
        return classify_assignment_ownership(**values)

    def test_confirmed_visible_attempt_is_runner_confirmed_without_tracked_mirror(self):
        evidence = self.classify(
            attempt_matches=[attempt(AttemptStatus.CONFIRMED_VISIBLE.value)],
        )

        self.assertIsInstance(evidence, OwnershipEvidence)
        self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_CONFIRMED)
        self.assertEqual(evidence.reason_code, "confirmed_attempt_matches_assignee")
        self.assertEqual(evidence.attempt_id, "attempt-1")
        self.assertEqual(evidence.insurer_run_id, "run-1")
        self.assertEqual(evidence.configured_owner, "Sophie")
        self.assertEqual(evidence.observed_assignee, "CVEBOT1")

    def test_confirmed_reconciled_attempt_is_runner_confirmed(self):
        evidence = self.classify(
            attempt_matches=[attempt(AttemptStatus.CONFIRMED_RECONCILED.value)],
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_CONFIRMED)

    def test_submitted_and_pending_attempts_are_runner_pending(self):
        for status in (
            AttemptStatus.SELECTED.value,
            AttemptStatus.SUBMITTED.value,
            AttemptStatus.RECONCILIATION_PENDING.value,
        ):
            with self.subTest(status=status):
                evidence = self.classify(attempt_matches=[attempt(status)])
                self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_PENDING)
                self.assertEqual(evidence.reason_code, "pending_attempt_matches_assignee")

    def test_tracked_compatibility_row_is_runner_confirmed(self):
        evidence = self.classify(
            tracked_matches=[{
                "id": "tracked-1",
                "current_assigned": "CVEBOT1",
                "tracking_key": "pile-1",
            }],
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_CONFIRMED)
        self.assertEqual(evidence.tracked_pile_id, "tracked-1")
        self.assertEqual(evidence.reason_code, "tracked_assignment_matches_assignee")

    def test_runner_evidence_for_a_different_assignee_is_conflict(self):
        evidence = self.classify(
            attempt_matches=[attempt(AttemptStatus.CONFIRMED_VISIBLE.value, "CVEBOT2")],
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.CONFLICT)
        self.assertEqual(evidence.reason_code, "runner_evidence_assignee_conflict")

    def test_multiple_distinct_matching_attempts_are_ambiguous_conflict(self):
        evidence = self.classify(
            attempt_matches=[
                attempt(AttemptStatus.CONFIRMED_VISIBLE.value, attempt_id="attempt-1"),
                attempt(AttemptStatus.CONFIRMED_VISIBLE.value, attempt_id="attempt-2"),
            ],
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.CONFLICT)
        self.assertEqual(evidence.reason_code, "ambiguous_runner_evidence")
        self.assertTrue(evidence.ambiguous)

    def test_exact_tracked_match_outweighs_stale_duplicate_attempts(self):
        evidence = self.classify(
            tracked_matches=[{
                "id": "tracked-1", "current_assigned": "CVEBOT1",
            }],
            attempt_matches=[
                attempt(AttemptStatus.CONFIRMED_VISIBLE.value, attempt_id="attempt-1"),
                attempt(AttemptStatus.CONFIRMED_VISIBLE.value, attempt_id="attempt-2"),
            ],
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_CONFIRMED)
        self.assertEqual(evidence.evidence_source, "tracked_pile")

    def test_single_confirmed_attempt_outweighs_a_pending_attempt(self):
        evidence = self.classify(attempt_matches=[
            attempt(AttemptStatus.CONFIRMED_VISIBLE.value, attempt_id="confirmed"),
            attempt(AttemptStatus.RECONCILIATION_PENDING.value, attempt_id="pending"),
        ])

        self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_CONFIRMED)
        self.assertEqual(evidence.attempt_id, "confirmed")

    def test_no_runner_or_actor_evidence_is_unlinked_not_external(self):
        evidence = self.classify()

        self.assertEqual(evidence.ownership, AssignmentOwnership.UNLINKED)
        self.assertEqual(evidence.reason_code, "no_runner_or_actor_evidence")

    def test_unverified_external_audit_cannot_claim_external_ownership(self):
        evidence = self.classify(
            external_audit={"verified": False, "actor_type": "human", "source": "portal_audit"},
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.UNLINKED)

    def test_positive_non_runner_portal_audit_is_verified_external(self):
        evidence = self.classify(
            external_audit={
                "verified": True,
                "actor_type": "human",
                "source": "portal_audit",
                "actor_id": "audited-user-1",
            },
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.VERIFIED_EXTERNAL)
        self.assertEqual(evidence.reason_code, "positive_external_actor_evidence")

    def test_bot_owner_mapping_is_metadata_not_actor_evidence(self):
        evidence = self.classify(configured_owner="Sophie")

        self.assertEqual(evidence.ownership, AssignmentOwnership.UNLINKED)
        self.assertEqual(evidence.configured_owner, "Sophie")
        self.assertEqual(evidence.actor_id, "")

    def test_defmis_production_regression_is_runner_confirmed(self):
        evidence = self.classify(
            attempt_matches=[{
                **attempt(
                    AttemptStatus.CONFIRMED_VISIBLE.value,
                    attempt_id="defmis-attempt",
                    insurer_run_id="ef69cbda-98e5-4a94-88c5-1d4525e5a7f0",
                    tracking_key="BRISTOL PARK HEALTHCARE CENTRE|3|23460|June 2025|08/10/2026",
                ),
                "submitted_at": "2026-10-08T08:23:25.393Z",
                "confirmed_at": "2026-10-08T08:26:08.901Z",
            }],
            configured_owner="Sophie",
        )

        self.assertEqual(evidence.ownership, AssignmentOwnership.RUNNER_CONFIRMED)
        self.assertEqual(evidence.observed_assignee, "CVEBOT1")
        self.assertEqual(evidence.configured_owner, "Sophie")
        self.assertEqual(evidence.actor_id, "")


if __name__ == "__main__":
    unittest.main()
