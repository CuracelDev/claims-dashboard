import unittest

from scripts.piles_auto_assignment.domain import ContextStatus, InsurerRunStatus
from scripts.piles_auto_assignment.orchestrator import (
    IncompleteWorkflow,
    classify_runner_error,
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
            InsurerRunStatus.FAILED,
        )

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
