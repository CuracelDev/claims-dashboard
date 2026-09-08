import unittest

from scripts.piles_auto_assignment.domain import ContextStatus
from scripts.piles_auto_assignment.scanning import (
    IncompleteScan,
    ScanAccumulator,
    TrackingKeyCollision,
)


def row(key, *, provider="Provider", claims=5, assigned=""):
    return {
        "tracking_key": key,
        "provider": provider,
        "claims": claims,
        "submitted_date": "2026-09-08",
        "status_bucket": "Vetting Pending",
        "assigned": assigned,
    }


class ScanAccumulatorTests(unittest.TestCase):
    def test_explicit_empty_is_complete_but_unreadable_table_is_failed(self):
        self.assertEqual(
            ScanAccumulator().finish(explicit_empty=True).status,
            ContextStatus.EMPTY,
        )
        with self.assertRaises(IncompleteScan):
            ScanAccumulator().finish(explicit_empty=False)

    def test_tracking_key_collision_is_not_silently_deduplicated(self):
        scan = ScanAccumulator()
        scan.observe_page(1, [row("same", provider="Provider A")])
        scan.observe_page(2, [row("same", provider="Provider B")])
        with self.assertRaises(TrackingKeyCollision):
            scan.finish()

    def test_repeated_page_is_detected_without_duplicating_rows(self):
        scan = ScanAccumulator()
        page = [row("pile-1"), row("pile-2", assigned="Daniel")]
        self.assertFalse(scan.observe_page(1, page))
        self.assertTrue(scan.observe_page(2, page))
        result = scan.finish()
        self.assertEqual(result.page_count, 1)
        self.assertEqual(result.distinct_pile_count, 2)
        self.assertEqual(result.unassigned_pile_count, 1)
        self.assertEqual(result.claim_count, 10)

    def test_same_tracking_key_with_same_identity_is_deduplicated(self):
        scan = ScanAccumulator()
        scan.observe_page(1, [row("pile-1")])
        scan.observe_page(2, [row("pile-1")])
        result = scan.finish()
        self.assertEqual(result.distinct_pile_count, 1)


if __name__ == "__main__":
    unittest.main()
