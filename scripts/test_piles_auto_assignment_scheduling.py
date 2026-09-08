import unittest

from scripts.piles_auto_assignment.scheduling import CoalescingScheduler, configured_max_concurrency


class SchedulingTests(unittest.TestCase):
    def test_second_trigger_coalesces_exactly_once(self):
        scheduler = CoalescingScheduler()
        first = scheduler.request("Jubilee Uganda", "run-1")
        second = scheduler.request("Jubilee Uganda", "run-2")
        third = scheduler.request("Jubilee Uganda", "run-3")
        self.assertEqual(first.status, "running")
        self.assertEqual(second.status, "skipped_overlap")
        self.assertEqual(third.coalesced_request_id, second.coalesced_request_id)

    def test_completion_claims_one_pending_followup(self):
        scheduler = CoalescingScheduler()
        active = scheduler.request("DEFMIS", "run-1")
        scheduler.request("DEFMIS", "run-2")
        followup = scheduler.finish(active)
        self.assertEqual(followup.status, "running")
        self.assertIsNone(scheduler.finish(followup))

    def test_concurrency_accepts_only_one_or_two(self):
        self.assertEqual(configured_max_concurrency({}), 1)
        self.assertEqual(configured_max_concurrency({"PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY": "2"}), 2)
        with self.assertRaises(ValueError):
            configured_max_concurrency({"PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY": "4"})


if __name__ == "__main__":
    unittest.main()
