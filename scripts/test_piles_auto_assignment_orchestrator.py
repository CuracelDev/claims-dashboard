import unittest

from scripts.piles_auto_assignment.domain import (
    ContextStatus,
    InsurerRunStatus,
    ParentRunStatus,
    WorkDisposition,
)
from scripts.piles_auto_assignment.orchestrator import (
    IncompleteWorkflow,
    classify_runner_error,
    derive_parent_status,
    derive_overall_run_status,
    finalize_no_work,
    run_insurer_workflows,
)
from scripts.piles_auto_assignment.scanning import IncompleteScan


class OrchestratorTests(unittest.TestCase):
    def test_one_insurer_failure_does_not_stop_following_insurers(self):
        calls = []

        def workflow(name):
            calls.append(name)
            if name == "failing":
                raise RuntimeError("portal failed")
            return {"ok": True}

        result = run_insurer_workflows(["failing", "succeeding"], workflow)
        self.assertEqual(calls, ["failing", "succeeding"])
        self.assertEqual(result.status, InsurerRunStatus.PARTIAL)
        self.assertEqual(result.outcomes[0].error_code, "unexpected_error")

    def test_all_failures_derive_failed_not_partial(self):
        self.assertEqual(
            derive_overall_run_status([
                InsurerRunStatus.FAILED,
                InsurerRunStatus.SKIPPED_INACTIVE,
            ]),
            ParentRunStatus.FAILED,
        )

    def test_legacy_sequential_aggregator_keeps_skipped_overlap(self):
        self.assertEqual(
            derive_overall_run_status([
                InsurerRunStatus.SKIPPED_OVERLAP,
                InsurerRunStatus.SKIPPED_OVERLAP,
            ]),
            InsurerRunStatus.SKIPPED_OVERLAP,
        )

    def test_completed_and_inactive_work_derives_completed(self):
        self.assertEqual(
            derive_parent_status(
                [WorkDisposition.COMPLETED, WorkDisposition.INACTIVE],
                [InsurerRunStatus.COMPLETED, InsurerRunStatus.SKIPPED_INACTIVE],
            ),
            ParentRunStatus.COMPLETED,
        )

    def test_mixed_success_and_failure_derives_completed_with_issues(self):
        self.assertEqual(
            derive_parent_status(
                [WorkDisposition.COMPLETED, WorkDisposition.FAILED],
                [InsurerRunStatus.COMPLETED, InsurerRunStatus.FAILED],
            ),
            ParentRunStatus.COMPLETED_WITH_ISSUES,
        )

    def test_every_runnable_insurer_failed_derives_failed(self):
        self.assertEqual(
            derive_parent_status(
                [WorkDisposition.FAILED, WorkDisposition.INACTIVE],
                [InsurerRunStatus.FAILED, InsurerRunStatus.SKIPPED_INACTIVE],
            ),
            ParentRunStatus.FAILED,
        )

    def test_covered_acknowledgement_does_not_turn_owned_failure_into_issues(self):
        self.assertEqual(
            derive_parent_status(
                [
                    WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
                    WorkDisposition.FAILED,
                ],
                [InsurerRunStatus.FAILED],
            ),
            ParentRunStatus.FAILED,
        )

    def test_owned_completion_with_covered_and_failed_work_derives_issues(self):
        self.assertEqual(
            derive_parent_status(
                [
                    WorkDisposition.COMPLETED,
                    WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
                    WorkDisposition.FAILED,
                ],
                [InsurerRunStatus.COMPLETED, InsurerRunStatus.FAILED],
            ),
            ParentRunStatus.COMPLETED_WITH_ISSUES,
        )

    def test_all_covered_work_derives_covered_by_active_cycle(self):
        self.assertEqual(
            derive_parent_status(
                [
                    WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
                    WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
                ],
                [],
            ),
            ParentRunStatus.COVERED_BY_ACTIVE_CYCLE,
        )

    def test_all_cancelled_work_derives_cancelled(self):
        self.assertEqual(
            derive_parent_status(
                [WorkDisposition.CANCELLED, WorkDisposition.CANCELLED],
                [],
            ),
            ParentRunStatus.CANCELLED,
        )

    def test_issue_status_is_not_reported_as_completed(self):
        for status in (
            InsurerRunStatus.COMPLETED_WITH_ISSUES,
            InsurerRunStatus.MANUAL_ACTION_REQUIRED,
        ):
            with self.subTest(status=status):
                self.assertEqual(
                    derive_parent_status([WorkDisposition.COMPLETED], [status]),
                    ParentRunStatus.COMPLETED_WITH_ISSUES,
                )

    def test_legacy_partial_is_read_as_completed_with_issues(self):
        self.assertEqual(
            derive_parent_status([], ["partial"]),
            ParentRunStatus.COMPLETED_WITH_ISSUES,
        )

    def test_legacy_skipped_overlap_is_read_as_covered(self):
        self.assertEqual(
            derive_parent_status([], ["skipped_overlap"]),
            ParentRunStatus.COVERED_BY_ACTIVE_CYCLE,
        )

    def test_nonterminal_work_cannot_be_finalized(self):
        for disposition in (
            WorkDisposition.QUEUED,
            WorkDisposition.CLAIMED,
            WorkDisposition.FOLLOW_UP_QUEUED,
        ):
            with self.subTest(disposition=disposition):
                with self.assertRaises(ValueError):
                    derive_parent_status([disposition], [])

    def test_no_work_requires_every_context_complete_or_empty(self):
        with self.assertRaises(IncompleteWorkflow):
            finalize_no_work([ContextStatus.EMPTY, ContextStatus.FAILED])
        self.assertEqual(
            finalize_no_work([ContextStatus.COMPLETE, ContextStatus.EMPTY]),
            InsurerRunStatus.COMPLETED,
        )

    def test_errors_have_stable_sanitized_codes(self):
        self.assertEqual(classify_runner_error(IncompleteScan("private detail")), "scan_incomplete")
        self.assertEqual(classify_runner_error(TimeoutError("slow")), "portal_timeout")

    def test_only_known_shutdown_noise_is_suppressible(self):
        from scripts.piles_auto_assignment.orchestrator import is_harmless_shutdown_warning

        self.assertTrue(is_harmless_shutdown_warning("playwright Target page, context or browser has been closed"))
        self.assertFalse(is_harmless_shutdown_warning("Target closed while clicking Assign Claims"))


if __name__ == "__main__":
    unittest.main()
