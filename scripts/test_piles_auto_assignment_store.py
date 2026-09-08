import unittest

from scripts.piles_auto_assignment.domain import AttemptStatus
from scripts.piles_auto_assignment.scanning import ScanAccumulator
from scripts.piles_auto_assignment.store import (
    ConcurrentStateChange,
    ExecutionLedger,
    ReadOnlyExecutionLedger,
)


class RecordingCursor:
    def __init__(self, connection):
        self.connection = connection
        self.description = [("status",)]
        self._row = ("submitted",)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.connection.statements.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self._row

    def fetchall(self):
        return [self._row]


class RecordingConnection:
    def __init__(self):
        self.statements = []
        self.commit_count = 0
        self.rollback_count = 0
        self.cursor_instance = RecordingCursor(self)

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commit_count += 1

    def rollback(self):
        self.rollback_count += 1


class ExecutionLedgerTests(unittest.TestCase):
    def setUp(self):
        self.connection = RecordingConnection()
        self.ledger = ExecutionLedger(self.connection)

    def test_transition_uses_compare_and_set(self):
        self.ledger.transition_attempt(
            "attempt-1",
            AttemptStatus.SUBMITTED,
            expected={AttemptStatus.SELECTED},
        )
        sql, params = self.connection.statements[-1]
        self.assertIn("status = ANY", sql)
        self.assertEqual(params[-1], "attempt-1")
        self.assertEqual(self.connection.commit_count, 1)

    def test_transition_rejects_an_illegal_state_edge_before_writing(self):
        with self.assertRaises(ValueError):
            self.ledger.transition_attempt(
                "attempt-1",
                AttemptStatus.PLANNED,
                expected={AttemptStatus.SUBMITTED},
            )
        self.assertEqual(self.connection.statements, [])

    def test_compare_and_set_miss_is_reported(self):
        self.connection.cursor_instance._row = None
        with self.assertRaises(ConcurrentStateChange):
            self.ledger.transition_attempt(
                "attempt-1",
                AttemptStatus.SUBMITTED,
                expected={AttemptStatus.SELECTED},
            )
        self.assertEqual(self.connection.rollback_count, 1)

    def test_batch_and_attempt_creation_is_one_transaction(self):
        batch_id = self.ledger.create_batch_with_attempts(
            {
                "id": "batch-1",
                "insurer_run_id": "insurer-run-1",
                "insurer_name": "Jubilee Uganda",
                "intended_owner_name": "Daniel",
                "intended_portal_assignee": "Daniel",
                "assignment_type": "Vetting",
                "status_bucket": "Vetting Pending",
                "planned_claim_count": 9,
            },
            [
                {
                    "id": "attempt-1",
                    "tracking_key": "pile-1",
                    "claim_count": 9,
                }
            ],
        )
        self.assertEqual(batch_id, "batch-1")
        self.assertEqual(self.connection.commit_count, 1)
        self.assertEqual(len(self.connection.statements), 2)

    def test_read_only_ledger_performs_no_database_writes(self):
        ledger = ReadOnlyExecutionLedger()
        run_id = ledger.create_insurer_run(
            "run-1",
            {"id": "master-1", "insurer_name": "Jubilee Uganda"},
        )
        ledger.transition_attempt(
            "attempt-1",
            AttemptStatus.SUBMITTED,
            expected={AttemptStatus.SELECTED},
        )
        ledger.heartbeat(run_id, phase="scan")
        self.assertTrue(run_id)
        self.assertEqual(ledger.write_count, 0)

    def test_scan_context_lifecycle_persists_completion_counts(self):
        scan = ScanAccumulator()
        scan.observe_page(1, [{
            "tracking_key": "pile-1",
            "provider": "Provider",
            "claims": 7,
            "submitted_date": "2026-09-08",
            "assigned": "",
        }])
        self.ledger.start_scan_context("context-1")
        self.ledger.finish_scan_context("context-1", scan.finish())

        sql, params = self.connection.statements[-1]
        self.assertIn("distinct_pile_count", sql)
        self.assertEqual(params[-1], "context-1")
        self.assertEqual(self.connection.commit_count, 2)

    def test_scan_context_failure_is_recorded_without_raw_exception_details(self):
        self.ledger.fail_scan_context(
            "context-1",
            error_code="table_unreadable",
            error_message="unable to read rows",
        )
        sql, params = self.connection.statements[-1]
        self.assertIn("status = 'failed'", sql)
        self.assertEqual(params[-1], "context-1")


if __name__ == "__main__":
    unittest.main()
