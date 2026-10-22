"""Explicit isolated-PostgreSQL gate; never uses DATABASE_URL or a portal."""
import os
from pathlib import Path
import unittest
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import psycopg2
from psycopg2 import sql
from scripts.piles_auto_assignment.store import ExecutionLedger


class HistoricalConfirmationDatabaseTests(unittest.TestCase):
    def setUp(self):
        url = os.environ.get("PILES_TEST_DATABASE_URL", "")
        if urlparse(url).hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("explicit disposable localhost PILES_TEST_DATABASE_URL required")
        self.schema = "historical_test_" + uuid.uuid4().hex
        self.connection = psycopg2.connect(url)
        self.connection.autocommit = True
        self.addCleanup(self.cleanup)
        with self.connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(self.schema)))
            cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(self.schema)))
            source = Path("scripts/piles-auto-assignment-schema.sql").read_text()
            cursor.execute(source.split("CREATE TABLE IF NOT EXISTS piles_auto_assignment_bot_account_history")[0])
            cursor.execute("""
              INSERT INTO piles_auto_assignment_master_accounts (id,insurer_name,login_email) VALUES ('master','Test','synthetic');
              INSERT INTO piles_auto_assignment_runner_runs (id,status) VALUES ('parent','completed');
              INSERT INTO piles_auto_assignment_insurer_runs (id,runner_run_id,master_account_id,insurer_name,status)
                VALUES ('run','parent','master','Test','completed_with_issues');
              INSERT INTO piles_auto_assignment_batches (id,insurer_run_id,insurer_name,intended_owner_name,intended_portal_assignee,assignment_type,status_bucket)
                VALUES ('batch','run','Test','Owner','CVEBOT1','Vetting','Vetting Ongoing');
              INSERT INTO piles_auto_assignment_attempts (id,batch_id,insurer_run_id,insurer_name,tracking_key,last_pile_key,
                intended_owner_name,intended_portal_assignee,status,claim_count,submitted_at,evidence_code,evidence_details)
                VALUES ('attempt','batch','run','Test','old-key','old-row','Owner','CVEBOT1','manual_action_required',2,
                  now()-interval '1 hour','historical_submission_missing_after_complete_scan',
                  jsonb_build_object('portal_identity_hash',repeat('a',64)));
            """)
            cursor.execute("SELECT * FROM piles_auto_assignment_attempts WHERE id='attempt'")
            self.expected = dict(zip([c.name for c in cursor.description], cursor.fetchone()))
        self.connection.autocommit = False
        self.row = dict(assigned="CVEBOT1", tracking_key="new-key", key="new-row", provider="Synthetic",
                        claims=2, synced_claims=0, remaining_claims=2, month="June 2025", submitted_date="2025-06-01",
                        status="Vetting Ongoing", status_bucket="Vetting Ongoing", filter_month="All",
                        portal_identity_hash="a" * 64)

    def cleanup(self):
        self.connection.rollback()
        self.connection.autocommit = True
        with self.connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(self.schema)))
        self.connection.close()

    def confirm(self):
        return ExecutionLedger(self.connection).confirm_historical_attempt(
            expected_attempt=self.expected, observation=self.row, observed_at=datetime.now(timezone.utc))

    def state(self):
        with self.connection.cursor() as cursor:
            cursor.execute("SELECT status,tracked_pile_id,evidence_details FROM piles_auto_assignment_attempts WHERE id='attempt'")
            return cursor.fetchone()

    def test_confirmation_is_atomic_preserves_prior_evidence_and_refreshes_totals(self):
        self.confirm()
        status, tracked, details = self.state()
        self.assertEqual(status, "confirmed_reconciled")
        self.assertTrue(tracked)
        self.assertEqual(details["historical_review"]["previous_status"], "manual_action_required")
        self.assertEqual(details["historical_review"]["previous_evidence_code"], "historical_submission_missing_after_complete_scan")
        with self.connection.cursor() as cursor:
            cursor.execute("SELECT confirmed_pile_count FROM piles_auto_assignment_batches WHERE id='batch'")
            self.assertEqual(cursor.fetchone()[0], 1)
            cursor.execute("SELECT confirmed_pile_count,status FROM piles_auto_assignment_insurer_runs WHERE id='run'")
            self.assertEqual(cursor.fetchone(), (1, "completed_with_issues"))

    def test_tracking_failure_rolls_back_confirmation_and_original_evidence(self):
        with self.connection.cursor() as cursor:
            cursor.execute("CREATE FUNCTION reject_tracking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$")
            cursor.execute("CREATE TRIGGER reject_tracking BEFORE INSERT ON piles_auto_assignment_tracked_piles FOR EACH ROW EXECUTE FUNCTION reject_tracking()")
        self.connection.commit()
        with self.assertRaises(psycopg2.errors.RaiseException):
            self.confirm()
        self.assertEqual(self.state(), ("manual_action_required", None, {"portal_identity_hash": "a" * 64}))

    def test_changed_attempt_is_not_overwritten(self):
        with self.connection.cursor() as cursor:
            cursor.execute("UPDATE piles_auto_assignment_attempts SET updated_at=clock_timestamp() WHERE id='attempt'")
        self.connection.commit()
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            self.confirm()
        self.assertEqual(self.state()[0], "manual_action_required")

    def test_later_identity_attempt_blocks_old_attribution(self):
        with self.connection.cursor() as cursor:
            cursor.execute("""INSERT INTO piles_auto_assignment_attempts
              (id,batch_id,insurer_run_id,insurer_name,tracking_key,intended_owner_name,intended_portal_assignee,status,evidence_details)
              VALUES ('later','batch','run','Test','different-key','Other','Other','confirmed_visible',
                jsonb_build_object('portal_identity_hash',repeat('a',64)))""")
        self.connection.commit()
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            self.confirm()
        self.assertEqual(self.state()[0], "manual_action_required")

    def test_wrong_owner_and_wrong_identity_are_not_confirmed(self):
        for changes in ({"assigned": "Other"}, {"portal_identity_hash": "b" * 64}):
            original = dict(self.row)
            self.row.update(changes)
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
                self.confirm()
            self.assertEqual(self.state()[0], "manual_action_required")
            self.connection.rollback()
            self.row = original

    def test_older_attempt_confirmed_later_blocks_old_attribution(self):
        with self.connection.cursor() as cursor:
            cursor.execute("""INSERT INTO piles_auto_assignment_attempts
              (id,batch_id,insurer_run_id,insurer_name,tracking_key,intended_owner_name,intended_portal_assignee,status,
                created_at,updated_at,evidence_details)
              VALUES ('older','batch','run','Test','different-key','Other','Other','confirmed_visible',
                now()-interval '2 hours',clock_timestamp(),jsonb_build_object('portal_identity_hash',repeat('a',64)))""")
        self.connection.commit()
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            self.confirm()

    def test_changed_key_tracking_mirror_is_not_duplicated(self):
        with self.connection.cursor() as cursor:
            cursor.execute("""INSERT INTO piles_auto_assignment_tracked_piles
              (id,insurer_name,tracking_key,provider,current_assigned,details)
              VALUES ('existing','Test','new-key','Synthetic','CVEBOT1',
                jsonb_build_object('portal_identity_hash',repeat('a',64)))""")
        self.connection.commit()
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            self.confirm()
        self.assertEqual(self.state()[0], "manual_action_required")
        with self.connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM piles_auto_assignment_tracked_piles")
            self.assertEqual(cursor.fetchone()[0], 1)

    def test_same_key_different_identity_tracking_mirror_is_not_overwritten(self):
        with self.connection.cursor() as cursor:
            cursor.execute("""INSERT INTO piles_auto_assignment_tracked_piles
              (id,insurer_name,tracking_key,provider,current_assigned,details)
              VALUES ('existing','Test','old-key','Different pile','Other',
                jsonb_build_object('portal_identity_hash',repeat('b',64)))""")
        self.connection.commit()
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            self.confirm()
        self.assertEqual(self.state()[0], "manual_action_required")
        with self.connection.cursor() as cursor:
            cursor.execute("SELECT provider,current_assigned FROM piles_auto_assignment_tracked_piles WHERE id='existing'")
            self.assertEqual(cursor.fetchone(), ("Different pile", "Other"))

    def test_foreign_insurer_lock_blocks_confirmation(self):
        other = psycopg2.connect(os.environ["PILES_TEST_DATABASE_URL"])
        try:
            with other.cursor() as cursor:
                cursor.execute("SELECT pg_advisory_lock(hashtextextended('piles-insurer:test',0))")
            other.commit()
            with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
                self.confirm()
            self.assertEqual(self.state()[0], "manual_action_required")
        finally:
            other.close()

    def test_no_submission_or_nonproduction_scope_cannot_be_confirmed(self):
        for statement in (
            "UPDATE piles_auto_assignment_attempts SET submitted_at=NULL WHERE id='attempt'",
            "UPDATE piles_auto_assignment_runner_runs SET portal_environment='test' WHERE id='parent'",
            "UPDATE piles_auto_assignment_attempts SET updated_at=clock_timestamp()+interval '1 hour' WHERE id='attempt'",
        ):
            with self.connection.cursor() as cursor:
                cursor.execute("UPDATE piles_auto_assignment_attempts SET submitted_at=now()-interval '1 hour', updated_at=clock_timestamp() WHERE id='attempt'")
                cursor.execute("UPDATE piles_auto_assignment_runner_runs SET portal_environment='production' WHERE id='parent'")
                cursor.execute(statement)
                cursor.execute("SELECT * FROM piles_auto_assignment_attempts WHERE id='attempt'")
                self.expected = dict(zip([c.name for c in cursor.description], cursor.fetchone()))
            self.connection.commit()
            with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
                self.confirm()
            self.assertEqual(self.state()[0], "manual_action_required")
            self.connection.rollback()

    def confirm_via_cli(self, *, missing=False):
        from types import SimpleNamespace
        from scripts import review_piles_historical_assignments as review
        from scripts.test_piles_auto_assignment_historical_review import row, runner
        connection = self.connection
        class Store:
            conn = connection
            def _fetchall_postgres(self, query, params):
                with connection.cursor() as cursor:
                    cursor.execute(query, params)
                    return [dict(zip([c.name for c in cursor.description], item)) for item in cursor.fetchall()]
        class Browser:
            initial_scan_results = {"context": SimpleNamespace(status=runner.ContextStatus.COMPLETE)}
            _last_scan_result = SimpleNamespace(status=runner.ContextStatus.COMPLETE)
            def scan_selected_statuses(self, contexts, year, *, only_unassigned):
                if contexts != [("All", "All", "Vetting Ongoing")] or only_unassigned:
                    raise AssertionError("target recheck must include assigned rows in the observed context")
                return [] if missing else [row()]
        self.connection.autocommit = True
        store = Store()
        attempts = review.load_attempts(store, "Test", 24, 100)
        api = SimpleNamespace(rows_matching_attempt_identity=runner.rows_matching_attempt_identity, ExecutionLedger=ExecutionLedger)
        args = review.parse_args(["--insurer", "Test", "--confirm-attempt", "attempt",
                                  "--confirmation", "CONFIRM_HISTORICAL_OWNERSHIP"])
        review.confirm_target(args, api, store, Browser(), attempts, [row()], datetime.now(timezone.utc))

    def test_cli_confirmation_rechecks_live_rows_before_atomic_update(self):
        self.confirm_via_cli()
        self.assertEqual(self.state()[0], "confirmed_reconciled")

    def test_pile_disappearing_during_targeted_recheck_is_not_confirmed(self):
        with self.assertRaisesRegex(ValueError, "historical_confirmation_blocked"):
            self.confirm_via_cli(missing=True)
        self.assertEqual(self.state()[0], "manual_action_required")


if __name__ == "__main__":
    unittest.main()
