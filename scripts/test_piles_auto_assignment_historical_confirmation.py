"""Guards must reject unsafe historical confirmation before writing anything."""
import unittest
from datetime import datetime, timedelta, timezone
from scripts.piles_auto_assignment.store import ExecutionLedger
from scripts.test_piles_auto_assignment_store import DispatchConnection


class HistoricalConfirmationGuards(unittest.TestCase):
    def test_stale_observation_is_rejected_without_database_writes(self):
        connection = DispatchConnection()
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            ExecutionLedger(connection).confirm_historical_attempt(
                expected_attempt={"id": "a", "insurer_name": "Test"}, observation={},
                observed_at=datetime.now(timezone.utc) - timedelta(minutes=5))
        self.assertEqual(connection.statements, [])

    def test_insurer_lock_conflict_never_changes_attempt(self):
        connection = DispatchConnection([{"acquired": False}])
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            ExecutionLedger(connection).confirm_historical_attempt(
                expected_attempt={"id": "a", "insurer_name": "Test"}, observation={},
                observed_at=datetime.now(timezone.utc))
        self.assertEqual(connection.commit_count, 0)
        self.assertEqual(connection.rollback_count, 1)
        self.assertEqual(len(connection.statements), 1)


if __name__ == "__main__":
    unittest.main()
