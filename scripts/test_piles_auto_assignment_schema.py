import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "scripts" / "piles-auto-assignment-schema.sql"
MIGRATION = ROOT / "scripts" / "fresh-migrate-prod-via-adminer.mjs"
AUDIT = ROOT / "scripts" / "db-schema-audit.mjs"

LEDGER_TABLES = (
    "piles_auto_assignment_insurer_runs",
    "piles_auto_assignment_scan_contexts",
    "piles_auto_assignment_batches",
    "piles_auto_assignment_attempts",
    "piles_auto_assignment_bot_account_history",
    "piles_auto_assignment_work_items",
)


class ExecutionLedgerSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = SCHEMA.read_text()
        cls.migration = MIGRATION.read_text()
        cls.audit = AUDIT.read_text()

    def test_all_execution_ledger_tables_are_additive(self):
        for table in LEDGER_TABLES:
            with self.subTest(table=table):
                self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", self.sql)

    def test_attempts_have_idempotency_and_state_constraints(self):
        self.assertIn("UNIQUE (batch_id, tracking_key)", self.sql)
        self.assertRegex(
            self.sql,
            re.compile(
                r"CREATE UNIQUE INDEX IF NOT EXISTS "
                r"piles_auto_assignment_attempts_active_key_idx.*?"
                r"WHERE status IN",
                re.DOTALL,
            ),
        )
        for status in (
            "planned",
            "submitted",
            "reconciliation_pending",
            "still_unassigned",
            "manual_action_required",
            "conflict",
        ):
            self.assertIn(f"'{status}'", self.sql)

    def test_legacy_logs_can_reference_ledger_rows(self):
        self.assertIn("ADD COLUMN IF NOT EXISTS insurer_run_id text", self.sql)
        self.assertIn("ADD COLUMN IF NOT EXISTS batch_id text", self.sql)

    def test_new_tables_never_store_credentials_or_raw_html(self):
        lower_sql = self.sql.lower()
        for table in LEDGER_TABLES:
            definition = re.search(
                rf"create table if not exists {table}\s*\((.*?)\n\);",
                lower_sql,
                re.DOTALL,
            ).group(1)
            with self.subTest(table=table):
                self.assertNotIn("login_password", definition)
                self.assertNotIn("bot_password", definition)
                self.assertNotIn("raw_html", definition)

    def test_bot_history_function_is_atomic_and_does_not_store_secret_values(self):
        self.assertIn("CREATE OR REPLACE FUNCTION piles_update_bot_account_with_history", self.sql)
        self.assertIn("previous_values", self.sql)
        self.assertIn("new_values", self.sql)
        history_insert = self.sql.split("INSERT INTO piles_auto_assignment_bot_account_history", 1)[1]
        self.assertNotIn("'bot_password',", history_insert)
        self.assertNotIn("'bot_email',", history_insert)
        self.assertIn("'password_configured'", history_insert)

    def test_fresh_migration_knows_every_ledger_table(self):
        for table in LEDGER_TABLES:
            with self.subTest(table=table):
                self.assertGreaterEqual(self.migration.count(table), 2)

    def test_schema_audit_requires_every_ledger_table(self):
        for table in LEDGER_TABLES:
            with self.subTest(table=table):
                self.assertIn(f"'{table}'", self.audit)

    def test_dispatch_work_items_are_additive_and_lease_guarded(self):
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS piles_auto_assignment_work_items",
            self.sql,
        )
        definition = re.search(
            r"CREATE TABLE IF NOT EXISTS piles_auto_assignment_work_items\s*\((.*?)\n\);",
            self.sql,
            re.DOTALL,
        ).group(1)
        for column in (
            "parent_runner_run_id",
            "canonical_insurer_name",
            "source",
            "request_scope",
            "disposition",
            "covered_by_insurer_run_id",
            "worker_id",
            "claim_token",
            "lease_expires_at",
            "heartbeat_at",
            "generation_requested_at",
            "attempt_number",
            "requested_at",
            "claimed_at",
            "started_at",
            "finished_at",
            "reason_code",
            "created_at",
            "updated_at",
        ):
            with self.subTest(column=column):
                self.assertRegex(definition, rf"\b{column}\b")
        self.assertGreaterEqual(definition.count("ON DELETE SET NULL"), 2)
        for source in ("schedule", "manual", "readiness", "recovery"):
            self.assertIn(f"'{source}'", definition)
        for disposition in (
            "queued",
            "claimed",
            "covered_by_active_cycle",
            "follow_up_queued",
            "inactive",
            "completed",
            "failed",
            "cancelled",
        ):
            self.assertIn(f"'{disposition}'", definition)
        self.assertIn("attempt_number >= 0", definition)
        self.assertIn("reason_code", definition)
        self.assertIn("~ '^[a-z0-9._-]+$'", definition)

    def test_dispatch_indexes_deduplicate_and_order_work(self):
        self.assertRegex(
            self.sql,
            re.compile(
                r"CREATE UNIQUE INDEX IF NOT EXISTS "
                r"piles_auto_assignment_work_items_queued_generation_idx.*?"
                r"canonical_insurer_name.*?source.*?request_scope.*?"
                r"WHERE disposition = 'queued'",
                re.DOTALL,
            ),
        )
        self.assertRegex(
            self.sql,
            re.compile(
                r"CREATE UNIQUE INDEX IF NOT EXISTS "
                r"piles_auto_assignment_work_items_follow_up_idx.*?"
                r"canonical_insurer_name.*?WHERE disposition = 'follow_up_queued'",
                re.DOTALL,
            ),
        )
        self.assertIn("piles_auto_assignment_work_items_claim_order_idx", self.sql)
        self.assertIn("piles_auto_assignment_work_items_expired_lease_idx", self.sql)

    def test_dispatch_parent_and_legacy_statuses_are_backward_compatible(self):
        for status in (
            "completed_with_issues",
            "partial",
            "skipped_overlap",
        ):
            self.assertIn(f"'{status}'", self.sql)
        self.assertRegex(
            self.sql,
            re.compile(
                r"piles_auto_assignment_schedule_requests_status_check.*?"
                r"cancelled_legacy",
                re.DOTALL,
            ),
        )

    def test_fresh_bootstrap_defines_dispatch_table_and_indexes(self):
        for token in (
            "piles_auto_assignment_work_items",
            "piles_auto_assignment_work_items_queued_generation_idx",
            "piles_auto_assignment_work_items_follow_up_idx",
            "piles_auto_assignment_work_items_claim_order_idx",
            "piles_auto_assignment_work_items_expired_lease_idx",
        ):
            with self.subTest(token=token):
                self.assertIn(token, self.migration)


if __name__ == "__main__":
    unittest.main()
