from dataclasses import FrozenInstanceError
from datetime import datetime, timezone
import unittest

from scripts.piles_auto_assignment.domain import (
    InsurerCoverage,
    RequestScope,
    WorkDisposition,
    WorkRequest,
    WorkSource,
)
from scripts.piles_auto_assignment.scheduling import decide_dispatch, configured_max_concurrency


T1 = datetime(2026, 9, 10, 9, 0, tzinfo=timezone.utc)
T2 = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)


class DispatchCoverageTests(unittest.TestCase):
    def test_idle_scheduled_insurer_queues_current_generation(self):
        decision = decide_dispatch(
            WorkRequest("Jubilee Uganda", WorkSource.SCHEDULE, requested_at=T2),
            InsurerCoverage(state="idle"),
        )

        self.assertEqual(decision.disposition, WorkDisposition.QUEUED)
        self.assertEqual(decision.generation_requested_at, T2)
        self.assertTrue(decision.create_work_item)

    def test_queued_scheduled_insurer_is_covered_without_follow_up(self):
        decision = decide_dispatch(
            WorkRequest("Jubilee Uganda", WorkSource.SCHEDULE, requested_at=T2),
            InsurerCoverage(state="queued", active_started_at=T1),
        )

        self.assertEqual(
            decision.disposition,
            WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
        )
        self.assertNotEqual(decision.disposition, WorkDisposition.FOLLOW_UP_QUEUED)
        self.assertTrue(decision.create_work_item)

    def test_running_scheduled_insurer_is_covered_without_follow_up(self):
        decision = decide_dispatch(
            WorkRequest("Jubilee Uganda", WorkSource.SCHEDULE, requested_at=T2),
            InsurerCoverage(
                state="running",
                active_started_at=T1,
                active_run_id="insurer-run-1",
            ),
        )

        self.assertEqual(
            decision.disposition,
            WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
        )
        self.assertEqual(decision.covered_by_insurer_run_id, "insurer-run-1")

    def test_completed_before_trigger_queues_a_new_generation(self):
        decision = decide_dispatch(
            WorkRequest("Jubilee Uganda", WorkSource.SCHEDULE, requested_at=T2),
            InsurerCoverage(
                state="completed",
                active_started_at=T1,
                active_finished_at=datetime(
                    2026, 9, 10, 9, 45, tzinfo=timezone.utc
                ),
            ),
        )

        self.assertEqual(decision.disposition, WorkDisposition.QUEUED)
        self.assertEqual(decision.generation_requested_at, T2)
        self.assertTrue(decision.create_work_item)

    def test_cycle_completed_after_trigger_still_covers_scheduled_request(self):
        decision = decide_dispatch(
            WorkRequest("Jubilee Uganda", WorkSource.SCHEDULE, requested_at=T2),
            InsurerCoverage(
                state="completed",
                active_started_at=T1,
                active_finished_at=datetime(
                    2026, 9, 10, 10, 15, tzinfo=timezone.utc
                ),
                active_run_id="insurer-run-1",
            ),
        )

        self.assertEqual(
            decision.disposition,
            WorkDisposition.COVERED_BY_ACTIVE_CYCLE,
        )
        self.assertEqual(decision.covered_by_insurer_run_id, "insurer-run-1")

    def test_active_manual_single_insurer_request_queues_one_follow_up(self):
        decision = decide_dispatch(
            WorkRequest(
                "DEFMIS",
                WorkSource.MANUAL,
                requested_at=T2,
                request_scope=RequestScope.SINGLE_INSURER,
            ),
            InsurerCoverage(state="running", active_started_at=T1),
        )

        self.assertEqual(decision.disposition, WorkDisposition.FOLLOW_UP_QUEUED)
        self.assertTrue(decision.create_work_item)

    def test_repeated_manual_request_reuses_existing_follow_up(self):
        decision = decide_dispatch(
            WorkRequest(
                "DEFMIS",
                WorkSource.MANUAL,
                requested_at=T2,
                request_scope=RequestScope.SINGLE_INSURER,
            ),
            InsurerCoverage(
                state="running",
                active_started_at=T1,
                follow_up_queued=True,
            ),
        )

        self.assertEqual(decision.disposition, WorkDisposition.FOLLOW_UP_QUEUED)
        self.assertFalse(decision.create_work_item)

    def test_inactive_insurer_has_explicit_terminal_disposition(self):
        decision = decide_dispatch(
            WorkRequest("APA", WorkSource.SCHEDULE, requested_at=T2),
            InsurerCoverage(state="inactive"),
        )

        self.assertEqual(decision.disposition, WorkDisposition.INACTIVE)
        self.assertTrue(decision.create_work_item)

    def test_decision_preserves_every_request_source(self):
        for source in WorkSource:
            with self.subTest(source=source):
                decision = decide_dispatch(
                    WorkRequest("APA", source, requested_at=T2),
                    InsurerCoverage(state="idle"),
                )
                self.assertEqual(decision.source, source)

    def test_request_and_decision_are_immutable(self):
        request = WorkRequest("APA", WorkSource.SCHEDULE, requested_at=T2)
        decision = decide_dispatch(request, InsurerCoverage(state="idle"))

        with self.assertRaises(FrozenInstanceError):
            request.insurer_name = "DEFMIS"
        with self.assertRaises(FrozenInstanceError):
            decision.disposition = WorkDisposition.FAILED


class SchedulingConfigurationTests(unittest.TestCase):
    def test_concurrency_accepts_only_one_or_two(self):
        self.assertEqual(configured_max_concurrency({}), 1)
        self.assertEqual(configured_max_concurrency({"PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY": "2"}), 2)
        with self.assertRaises(ValueError):
            configured_max_concurrency({"PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY": "4"})


if __name__ == "__main__":
    unittest.main()
