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


if __name__ == "__main__":
    unittest.main()
