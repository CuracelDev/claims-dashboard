"""Explicit disposable-PostgreSQL regression gate (not part of offline discovery).

Run from the repository root with:
  python3 -m scripts.verify_piles_auto_assignment_postgres --bridge /path/to/pg-bridge.cjs

The supplied local Node DB-API bridge must target a disposable database containing
the Piles schema. These tests insert uniquely named fixture rows, use independent
real PostgreSQL sessions, and never connect to a portal or notification service.
"""

import argparse
import json
import subprocess
import threading
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from scripts.test_piles_auto_assignment_dispatch import dispatch
from scripts import test_piles_auto_assignment_runner as runner_tests

runner = runner_tests.runner


class Connection:
    autocommit = False

    def __init__(self, bridge):
        self.process = subprocess.Popen(["node", bridge], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)

    def query(self, sql, params=()):
        self.process.stdin.write(json.dumps({"sql": sql, "params": params}, default=str) + "\n")
        self.process.stdin.flush()
        result = json.loads(self.process.stdout.readline())
        if "error" in result:
            raise RuntimeError(result["error"])
        return result

    def cursor(self):
        connection = self

        class Cursor:
            def __enter__(self):
                connection.query("BEGIN")
                return self

            def __exit__(self, *_):
                return False

            def execute(self, sql, params=()):
                result = connection.query(sql, params)
                self.description = result.get("fields") or []
                self.rows = [tuple(datetime.fromisoformat(row[name]) if oid == 1184 and row[name]
                                   else row[name] for name, oid in self.description)
                             for row in result.get("rows") or []]

            def fetchone(self):
                return self.rows[0] if self.rows else None

            def fetchall(self):
                return self.rows

        return Cursor()

    def commit(self):
        self.query("COMMIT")

    def rollback(self):
        self.query("ROLLBACK")

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()


class FinalAssignmentPostgresTests(unittest.TestCase):
    bridge = ""

    def setUp(self):
        self.connections = [Connection(self.bridge) for _ in range(4)]
        self.admin, self.worker, self.lock_owner, self.blocker = self.connections
        for connection in self.connections:
            self.addCleanup(connection.close)
        suffix = uuid.uuid4().hex
        self.insurer, self.parent = "Fence fixture " + suffix, "fence-parent-" + suffix
        self.admin.query("INSERT INTO piles_auto_assignment_master_accounts(id,insurer_name,login_email) "
                         "VALUES (%s,%s,%s)", [self.insurer, self.insurer, "fixture.invalid"])
        self.admin.query("INSERT INTO piles_auto_assignment_runner_runs(id,status,mode,run_scope) "
                         "VALUES (%s,'started','execute','all-active')", [self.parent])
        self.store = runner.DispatchStore(self.worker)
        self.store.enqueue_parent_work(self.parent, [runner.WorkRequest(self.insurer, "schedule", datetime.now(timezone.utc))])
        self.work = self.store.claim_next(self.parent, "fixture-worker")
        self.lock_key = "piles-insurer:" + self.work.canonical_insurer_name
        for key in (self.lock_key, "piles-capacity:0"):
            self.lock_owner.query("SELECT pg_advisory_lock(hashtextextended(%s,0))", [key])
        self.owner_pid = self.lock_owner.query("SELECT pg_backend_pid() AS pid")["rows"][0]["pid"]
        self.worker_pid = self.worker.query("SELECT pg_backend_pid() AS pid")["rows"][0]["pid"]

    def wait_until(self, predicate):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if predicate():
                return
            threading.Event().wait(0.01)
        self.fail("Disposable PostgreSQL did not reach the expected lock/clock boundary")

    def assert_final_click_fenced(self, *, expire_lease=False):
        owner = dispatch.ClaimOwnership(self.work, self.store, self.owner_pid, 0,
                                        1 if expire_lease else 120)
        browser, clicks = runner_tests.DispatcherRunnerFencingTests().modal(owner.check)
        locked, errors = threading.Event(), []

        def before_submit():
            # The first guard has passed. Hold the work row immediately before
            # the second (final) guard, just as slow evidence persistence can.
            self.blocker.query("BEGIN")
            self.blocker.query("SELECT id FROM piles_auto_assignment_work_items WHERE id=%s FOR UPDATE",
                               [self.work.id])
            locked.set()

        browser._before_assignment_submit = before_submit

        def apply():
            try:
                browser._apply_assignment_modal("Vetting", "Assignee", True)
            except Exception as error:
                errors.append(error)

        with patch.object(runner.time, "sleep", lambda _: None):
            thread = threading.Thread(target=apply)
            thread.start()
            try:
                self.assertTrue(locked.wait(5))
                self.wait_until(lambda: self.admin.query(
                    "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=%s",
                    [self.worker_pid])["rows"][0]["blocked"])
                if expire_lease:
                    # Keep both locks: elapsed wall-clock lease expiry alone
                    # must fence a transaction that started before expiry.
                    self.wait_until(lambda: self.admin.query(
                        "SELECT lease_expires_at <= clock_timestamp() AS expired "
                        "FROM piles_auto_assignment_work_items WHERE id=%s", [self.work.id])["rows"][0]["expired"])
                else:
                    self.lock_owner.query("SELECT pg_advisory_unlock(hashtextextended(%s,0))", [self.lock_key])
            finally:
                self.blocker.commit()
                thread.join(timeout=8)
        self.assertFalse(thread.is_alive())
        self.assertEqual(clicks, [], "A stale final guard must not click any assignment candidate")
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], runner.WorkOwnershipLost)
        self.assertTrue(owner.lost)
        with self.assertRaises(runner.WorkOwnershipLost):
            owner.check()
        self.assertEqual(self.admin.query("SELECT disposition FROM piles_auto_assignment_work_items WHERE id=%s",
                                         [self.work.id])["rows"][0]["disposition"], "claimed")

    def test_lock_loss_during_final_guard_row_wait_prevents_assignment(self):
        self.assert_final_click_fenced()

    def test_lease_expiry_during_final_guard_row_wait_prevents_assignment(self):
        self.assert_final_click_fenced(expire_lease=True)

    def assert_expired_transition_fenced(self, transition):
        self.assertTrue(self.store.heartbeat_claim(self.work.id, self.work.claim_token, self.owner_pid, 0, 1))
        self.blocker.query("BEGIN")
        self.blocker.query("SELECT id FROM piles_auto_assignment_work_items WHERE id=%s FOR UPDATE", [self.work.id])
        results, errors = [], []
        def transition_once():
            try:
                results.append(transition())
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=transition_once)
        thread.start()
        try:
            self.wait_until(lambda: errors or self.admin.query(
                "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=%s",
                [self.worker_pid])["rows"][0]["blocked"])
            self.assertEqual(errors, [])
            self.wait_until(lambda: self.admin.query(
                "SELECT lease_expires_at <= clock_timestamp() AS expired "
                "FROM piles_auto_assignment_work_items WHERE id=%s", [self.work.id])["rows"][0]["expired"])
        finally:
            self.blocker.commit()
            thread.join(timeout=8)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results, [False])
        self.assertEqual(self.admin.query("SELECT disposition FROM piles_auto_assignment_work_items WHERE id=%s",
                                         [self.work.id])["rows"][0]["disposition"], "claimed")

    def test_lease_expiry_during_terminal_row_wait_prevents_false_completion(self):
        self.assert_expired_transition_fenced(lambda: self.store.finish_claim(
            self.work.id, self.work.claim_token, dispatch.WorkDisposition.COMPLETED))

    def test_lease_expiry_during_renew_row_wait_prevents_resurrection(self):
        self.assert_expired_transition_fenced(lambda: self.store.renew_claim(self.work.id, self.work.claim_token))

    def test_lease_expiry_during_release_row_wait_refuses_the_expired_owner(self):
        self.assert_expired_transition_fenced(lambda: self.store.release_claim(
            self.work.id, self.work.claim_token, "dispatch_stopped"))

    def test_reclaim_atomically_closes_attached_child_and_rotates_attempt(self):
        child_id = self.store.start_insurer_run(
            self.work.id, self.work.claim_token, self.owner_pid, 0,
            {"id": self.insurer, "insurer_name": self.insurer}, 120,
        )
        self.assertTrue(child_id)
        self.admin.query(
            "UPDATE piles_auto_assignment_work_items SET lease_expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=%s", [self.work.id],
        )
        for key in (self.lock_key, "piles-capacity:0"):
            self.lock_owner.query("SELECT pg_advisory_unlock(hashtextextended(%s,0))", [key])

        # Hold the child row after the claimant has selected the expired work.
        # A third session must observe either both old values or both new values,
        # never a cleared work attachment with a still-running orphan.
        self.admin.query("BEGIN")
        self.admin.query("SELECT id FROM piles_auto_assignment_insurer_runs WHERE id=%s FOR UPDATE", [child_id])
        reclaim_store = runner.DispatchStore(self.blocker)
        blocker_pid = self.blocker.query("SELECT pg_backend_pid() AS pid")["rows"][0]["pid"]
        result, errors = [], []
        def reclaim():
            try:
                result.append(reclaim_store.claim_next(self.parent, "replacement-worker"))
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=reclaim)
        thread.start()
        try:
            self.wait_until(lambda: errors or self.lock_owner.query(
                "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=%s",
                [blocker_pid])["rows"][0]["blocked"])
            self.assertEqual(errors, [])
            before = self.lock_owner.query(
                "SELECT work.covered_by_insurer_run_id,run.status FROM piles_auto_assignment_work_items work "
                "JOIN piles_auto_assignment_insurer_runs run ON run.id=%s WHERE work.id=%s",
                [child_id, self.work.id],
            )["rows"][0]
            self.assertEqual(before, {"covered_by_insurer_run_id": child_id, "status": "running"})
        finally:
            self.admin.commit()
            thread.join(timeout=8)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(result), 1)
        reclaimed = result[0]
        self.assertEqual(reclaimed.attempt_number, 2)
        self.assertIsNone(reclaimed.covered_by_insurer_run_id)
        self.assertIsNone(reclaimed.started_at)
        after = self.lock_owner.query(
            "SELECT work.covered_by_insurer_run_id,work.attempt_number,run.status,run.error_code,run.finished_at IS NOT NULL AS finished "
            "FROM piles_auto_assignment_work_items work JOIN piles_auto_assignment_insurer_runs run ON run.id=%s "
            "WHERE work.id=%s", [child_id, self.work.id],
        )["rows"][0]
        self.assertEqual(after, {"covered_by_insurer_run_id": None, "attempt_number": 2,
                                 "status": "failed", "error_code": "worker_attempt_reclaimed", "finished": True})
        self.assertFalse(self.store.finish_claim(
            self.work.id, self.work.claim_token, dispatch.WorkDisposition.FAILED))

    def test_atomic_child_start_rolls_back_insert_on_attachment_error(self):
        trigger = "reject_attach_" + uuid.uuid4().hex
        function = trigger + "_fn"
        self.admin.query(f"""
          CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.covered_by_insurer_run_id IS NOT NULL THEN
              RAISE EXCEPTION 'fixture attachment rejection';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER {trigger} BEFORE UPDATE ON piles_auto_assignment_work_items
          FOR EACH ROW EXECUTE FUNCTION {function}()
        """)
        self.addCleanup(lambda: self.admin.query(f"DROP FUNCTION IF EXISTS {function}()"))
        self.addCleanup(lambda: self.admin.query(f"DROP TRIGGER IF EXISTS {trigger} ON piles_auto_assignment_work_items"))
        with self.assertRaisesRegex(RuntimeError, "fixture attachment rejection"):
            self.store.start_insurer_run(
                self.work.id, self.work.claim_token, self.owner_pid, 0,
                {"id": self.insurer, "insurer_name": self.insurer}, 120,
            )
        children = self.admin.query(
            "SELECT count(*)::integer AS count FROM piles_auto_assignment_insurer_runs WHERE runner_run_id=%s",
            [self.parent],
        )["rows"][0]["count"]
        self.assertEqual(children, 0)
        work = self.admin.query(
            "SELECT started_at,covered_by_insurer_run_id FROM piles_auto_assignment_work_items WHERE id=%s",
            [self.work.id],
        )["rows"][0]
        self.assertEqual(work, {"started_at": None, "covered_by_insurer_run_id": None})

    def test_atomic_child_start_rechecks_session_locks_after_work_row_wait(self):
        self.admin.query("BEGIN")
        self.admin.query("SELECT id FROM piles_auto_assignment_work_items WHERE id=%s FOR UPDATE", [self.work.id])
        result, errors = [], []
        def start():
            try:
                result.append(self.store.start_insurer_run(
                    self.work.id, self.work.claim_token, self.owner_pid, 0,
                    {"id": self.insurer, "insurer_name": self.insurer}, 120,
                ))
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=start)
        thread.start()
        try:
            self.wait_until(lambda: errors or self.blocker.query(
                "SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=%s",
                [self.worker_pid])["rows"][0]["blocked"])
            self.assertEqual(errors, [])
            self.lock_owner.query("SELECT pg_advisory_unlock(hashtextextended(%s,0))", [self.lock_key])
        finally:
            self.admin.commit()
            thread.join(timeout=8)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(result, [""])
        self.assertEqual(self.blocker.query(
            "SELECT count(*)::integer AS count FROM piles_auto_assignment_insurer_runs WHERE runner_run_id=%s",
            [self.parent],
        )["rows"][0]["count"], 0)
        self.assertEqual(self.blocker.query(
            "SELECT started_at,covered_by_insurer_run_id FROM piles_auto_assignment_work_items WHERE id=%s",
            [self.work.id],
        )["rows"][0], {"started_at": None, "covered_by_insurer_run_id": None})

    def test_work_scope_schema_applies_to_a_fresh_namespace_and_repeats(self):
        schema_name = "piles_scope_" + uuid.uuid4().hex
        connection = Connection(self.bridge)
        self.addCleanup(connection.close)
        connection.query(f'CREATE SCHEMA "{schema_name}"')
        self.addCleanup(lambda: self.admin.query(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE'))
        connection.query(f'SET search_path TO "{schema_name}"')
        connection.query("CREATE TABLE piles_auto_assignment_runner_runs (id text PRIMARY KEY, portal_environment text, months jsonb, year text)")
        connection.query("CREATE TABLE piles_auto_assignment_insurer_runs (id text PRIMARY KEY)")
        schema = Path(__file__).with_name("piles-auto-assignment-schema.sql").read_text()
        work_schema = schema.split("CREATE TABLE IF NOT EXISTS piles_auto_assignment_work_items", 1)[1]
        work_schema = "CREATE TABLE IF NOT EXISTS piles_auto_assignment_work_items" + work_schema.split(
            "ALTER TABLE IF EXISTS piles_auto_assignment_logs", 1
        )[0]
        connection.query(work_schema)
        connection.query(work_schema)
        indexes = connection.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()")
        self.assertIn("piles_auto_assignment_work_items_queued_generation_idx",
                      {row["indexname"] for row in indexes["rows"]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", required=True, help="Inspected local bridge to a disposable PostgreSQL database")
    FinalAssignmentPostgresTests.bridge = parser.parse_args().bridge
    unittest.main(argv=[__file__], verbosity=2)
