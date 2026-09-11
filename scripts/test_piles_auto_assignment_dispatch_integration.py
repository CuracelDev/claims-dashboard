"""Offline acceptance: real CLI/dispatcher/store/ledger/planner/reconciliation.

Only PostgreSQL dialect/session locks, configuration, browser I/O and delivery
are fakes. SQLite executes the production relational predicates and constraints;
transactions are serialized, so this is NOT a PostgreSQL row-wait race test (see
verify_piles_auto_assignment_postgres.py). No database URL or portal is contacted.
"""

import importlib.util
import io
import json
import os
import re
import signal
import socket
import sqlite3
import sys
import threading
import types
import unittest
import zlib
from collections import Counter
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


def forbidden(*_args, **_kwargs):
    raise AssertionError("Acceptance tests cannot contact external services")


def load_runner():
    dependencies = {
        "psycopg2": types.SimpleNamespace(connect=forbidden),
        "requests": types.SimpleNamespace(post=forbidden),
        "dotenv": types.SimpleNamespace(load_dotenv=lambda *_: None),
        "playwright": types.ModuleType("playwright"),
        "playwright.sync_api": types.SimpleNamespace(
            Browser=object, Page=object, TimeoutError=TimeoutError,
            sync_playwright=forbidden),
    }
    spec = importlib.util.spec_from_file_location(
        "piles_dispatch_acceptance_runner", Path(__file__).with_name("piles_auto_assignment_runner.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {**dependencies, spec.name: module}):
        spec.loader.exec_module(module)
    return module


runner = load_runner()
ParentWorkPending = runner.dispatch_parent.__globals__["ParentWorkPending"]
INSURERS = ("DEFMIS", "Jubilee Kenya", "Jubilee Tanzania", "Jubilee Uganda")
NOW = datetime(2026, 9, 10, 9, tzinfo=timezone.utc)


class SqlDatabase:
    """Independent DB-API sessions over local tables and a fake advisory catalog."""

    def __init__(self, directory):
        self.path = str(Path(directory) / "acceptance.sqlite")
        self.now = NOW
        self.mutex = threading.RLock()
        self.locks = {}
        self.sessions = []
        self.admin = self.connect()
        schema = Path(__file__).with_name("piles-auto-assignment-schema.sql").read_text()
        tables = ("runner_runs", "insurer_runs", "scan_contexts", "batches", "attempts", "work_items")
        ddl = "CREATE TABLE piles_auto_assignment_master_accounts(id TEXT PRIMARY KEY, insurer_name TEXT, is_active BOOLEAN);"
        for table in tables:
            # Execute the actual table contracts; only dialect defaults/types are
            # adapted. Foreign tables unused by these fixtures are not populated.
            match = re.search(rf"CREATE TABLE IF NOT EXISTS piles_auto_assignment_{table} \([\s\S]*?\n\);", schema)
            ddl += match.group().replace("DEFAULT md5(random()::text || clock_timestamp()::text)", "")
        for suffix in ("work_items_queued_generation_idx", "work_items_follow_up_idx", "attempts_active_key_idx"):
            ddl += re.search(rf"CREATE UNIQUE INDEX IF NOT EXISTS piles_auto_assignment_{suffix}[\s\S]*?;", schema).group()
        ddl = re.sub(r"::jsonb", "", ddl).replace("DEFAULT now()", "DEFAULT (now())")
        ddl = ddl.replace("reason_code ~", "reason_code REGEXP").replace("year ~", "year REGEXP")
        ddl = ddl.replace(
            "months <@ '[\"All\",\"Jan\",\"Feb\",\"Mar\",\"Apr\",\"May\",\"Jun\",\"Jul\",\"Aug\",\"Sep\",\"Oct\",\"Nov\",\"Dec\"]'",
            "json_contains('[\"All\",\"Jan\",\"Feb\",\"Mar\",\"Apr\",\"May\",\"Jun\",\"Jul\",\"Aug\",\"Sep\",\"Oct\",\"Nov\",\"Dec\"]', months)",
        ).replace("NOT months ? 'All'", "NOT json_array_contains(months, 'All')")
        self.admin.raw.executescript(ddl)
        self.admin.raw.execute("CREATE TABLE pg_database(oid INTEGER, datname TEXT)")
        self.admin.raw.execute("INSERT INTO pg_database VALUES (1,'acceptance')")
        self.admin.raw.executescript("""
          CREATE VIEW pg_locks AS SELECT
            'advisory' locktype, json_extract(value,'$.pid') pid,
            0 classid, json_extract(value,'$.key') objid,
            1 objsubid, 1 granted, 'ExclusiveLock' mode, 1 database
          FROM json_each(advisory_catalog());
        """)
        for name in INSURERS:
            self.admin.raw.execute("INSERT INTO piles_auto_assignment_master_accounts VALUES (?,?,true)", (name, name))
        self.admin.raw.commit()

    def connect(self, dsn="offline-acceptance"):
        if dsn != "offline-acceptance":
            raise AssertionError("Only the offline fixture database may be opened")
        with self.mutex:
            connection = SqlConnection(self, len(self.sessions) + 1)
            self.sessions.append(connection)
            return connection

    def rows(self, sql, params=()):
        with self.mutex:
            return [dict(row) for row in self.admin.raw.execute(sql, params).fetchall()]

    def parent(self, parent):
        return self.rows("SELECT * FROM piles_auto_assignment_runner_runs WHERE id=?", (parent,))[0]

    def work(self, parent):
        return self.rows("SELECT * FROM piles_auto_assignment_work_items WHERE parent_runner_run_id=? ORDER BY requested_at,id", (parent,))

    def close(self):
        for session in reversed(self.sessions):
            session.close()


class SqlConnection:
    autocommit = False

    def __init__(self, database, pid):
        self.database, self.pid = database, pid
        self.raw = sqlite3.connect(database.path, check_same_thread=False)
        self.raw.row_factory = sqlite3.Row
        self.in_transaction = self.closed = False
        self.raw.create_function("now", 0, lambda: database.now.isoformat())
        self.raw.create_function("clock_timestamp", 0, lambda: database.now.isoformat())
        self.raw.create_function("plus_seconds", 2, lambda stamp, seconds: (datetime.fromisoformat(stamp) + timedelta(seconds=seconds)).isoformat())
        self.raw.create_function("duration_ms", 2, lambda end, start: max(0, int((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() * 1000)))
        self.raw.create_function("btrim", 1, lambda value: value.strip() if value else value)
        self.raw.create_function("char_length", 1, len)
        self.raw.create_function("regexp", 2, lambda pattern, value: bool(re.search(pattern, value or "")))
        self.raw.create_function("regexp_replace", 4, lambda value, pattern, replacement, flags: re.sub(pattern, replacement, value))
        self.raw.create_function("json_contains", 2, lambda covering, requested: int(
            set(json.loads(covering)).issuperset(json.loads(requested))
        ))
        self.raw.create_function("jsonb_typeof", 1, lambda value: "array" if isinstance(json.loads(value), list) else "object")
        self.raw.create_function("jsonb_array_length", 1, lambda value: len(json.loads(value)))
        self.raw.create_function("json_array_contains", 2, lambda value, member: int(member in json.loads(value)))
        self.raw.create_function("hashtextextended", 2, lambda value, seed: zlib.crc32(value.encode()))
        self.raw.create_function("current_database", 0, lambda: "acceptance")
        self.raw.create_function("advisory_catalog", 0, lambda: json.dumps([
            {"pid": owner, "key": key} for key, owner in database.locks.items()]))
        self.raw.create_function("pg_advisory_xact_lock", 1, self.transaction_lock)
        self.raw.create_function("pg_try_advisory_xact_lock", 1, self.transaction_lock)

    def get_backend_pid(self):
        return self.pid

    def transaction_lock(self, key):
        # Transaction mutex serializes transient locks, but session locks survive
        # commits and exclude other backends until release/connection crash.
        return key not in self.database.locks or self.database.locks[key] == self.pid

    def acquire(self, namespace):
        with self.database.mutex:
            key = zlib.crc32(namespace.encode())
            if not self.transaction_lock(key):
                return False
            self.database.locks[key] = self.pid
            return True

    def release(self, namespace):
        with self.database.mutex:
            key = zlib.crc32(namespace.encode())
            if self.database.locks.get(key) == self.pid:
                del self.database.locks[key]

    @contextmanager
    def cursor(self):
        if not self.in_transaction:
            self.database.mutex.acquire()
            self.in_transaction = True
        cursor = SqlCursor(self)
        try:
            yield cursor
        finally:
            cursor.raw.close()

    def commit(self):
        self.raw.commit()
        self._release_transaction()

    def rollback(self):
        self.raw.rollback()
        self._release_transaction()

    def _release_transaction(self):
        if self.in_transaction:
            self.in_transaction = False
            self.database.mutex.release()

    def close(self):
        if self.closed:
            return
        self.rollback()
        with self.database.mutex:
            self.database.locks = {key: owner for key, owner in self.database.locks.items() if owner != self.pid}
        self.raw.close()
        self.closed = True


class SqlCursor:
    def __init__(self, connection):
        self.connection = connection
        self.raw = connection.raw.cursor()

    def execute(self, sql, params=()):
        sql = " ".join(sql.split()).replace("%s", "?")
        sql = re.sub(r" FOR UPDATE(?: OF work| SKIP LOCKED)?", "", sql)
        sql = sql.replace("completed.months @> ?::jsonb", "json_contains(completed.months, ?)")
        sql = re.sub(r"jsonb_set\(coalesce\(details, '\{\}'::jsonb\), '\{(\w+)\}', \?::jsonb\)",
                     r"json_set(coalesce(details, '{}'), '$.\1', json(?))", sql)
        sql = re.sub(r"::(?:text|jsonb|integer|bigint)", "", sql)
        sql = re.sub(r"(now\(\)|clock_timestamp\(\)) \+ \? \* interval '1 second'", r"plus_seconds(\1, ?)", sql)
        sql = sql.replace("= ANY(?)", "IN (SELECT value FROM json_each(?))")
        sql = sql.replace("IS NOT DISTINCT FROM", "IS")
        sql = sql.replace("RETURNING work.*", "RETURNING *")
        sql = re.sub(r"UPDATE (piles_auto_assignment_\w+) (work|run|batch) SET", r"UPDATE \1 AS \2 SET", sql)
        sql = sql.replace("least(2147483647, greatest(0, extract(epoch FROM (now() - started_at)) * 1000))", "min(2147483647, duration_ms(now(), started_at))")
        values = tuple(value.isoformat() if isinstance(value, datetime) else json.dumps(value) if isinstance(value, (list, dict)) else value for value in params)
        self.raw.execute(sql, values)
        self.description = self.raw.description

    def convert(self, row):
        if row is None:
            return None
        return tuple(json.loads(value) if value and column[0] in {"details", "filter_context", "months"} else
                     datetime.fromisoformat(value) if value and column[0].endswith("_at") else value
                     for column, value in zip(self.description, row))

    def fetchall(self):
        return [self.convert(row) for row in self.raw.fetchall()]

    def fetchone(self):
        return self.convert(self.raw.fetchone())


class AcceptanceHarness:
    def __init__(self, directory):
        self.db = SqlDatabase(directory)
        self.scans, self.entries, self.clicks, self.deliveries = [], [], [], []
        self.portals, self.results = [], []
        self.restored, self.side_summaries = [], []
        self.dispatch_results = []
        self.initial, self.late, self.verdicts = {}, {}, {}
        self.on_enter = self.on_exit = None
        self.active, self.peak = set(), 0
        self.failures = set()
        self.modal_assignee = None
        self.rule = None

    def pile(self, identity):
        return runner.PileRow(key=identity, tracking_key=identity, legacy_tracking_key="",
            provider="Synthetic acceptance provider", claims=10, synced_claims=0,
            remaining_claims=10, amount_text="1000", month="Jul", submitted_date="2026-07-01",
            assigned="", status="Vetting Pending", status_bucket="Vetting Pending",
            filter_month="Jul", filter_year="2026", page_number=1, assignment_type="Vetting")

    def parent(self, parent, insurer=None, source="schedule", *, portal="test", months=("Jul",), year="2026"):
        self.db.now += timedelta(seconds=1)
        store = self.store_type()()
        try:
            store.create_runner_run(run_id=parent, insurer_name=insurer or "", run_source=source,
                run_scope="single" if insurer else "all-active", portal_environment=portal,
                months=list(months), year=year, details={}, mode="execute")
        finally:
            store.close()
        coordinator = runner.DispatchStore(self.db.connect())
        try:
            return coordinator.enqueue_parent_work(parent, [runner.WorkRequest(
                name, source, coordinator.parent_requested_at(parent),
                runner.RequestScope.SINGLE_INSURER if insurer else runner.RequestScope.ALL_ACTIVE,
                portal, tuple(months), year)
                for name in ([insurer] if insurer else INSURERS)])
        finally:
            coordinator.close()

    def store_type(self):
        harness = self
        class Store:
            mode, database_url = "postgres", "offline-acceptance"
            def __init__(self, **_):
                self.conn = harness.db.connect()
            def close(self):
                self.conn.close()
            def get_active_master_accounts(self):
                return [self.get_master_account(name) for name in INSURERS]
            def get_master_account(self, name):
                return runner.MasterAccount(name, name, "fixture-only", "fixture-only", True)
            def create_runner_run(self, **fields):
                fields.setdefault("portal_environment", "test")
                fields.setdefault("months", ["Jul"])
                fields.setdefault("year", "2026")
                with self.conn.cursor() as cursor:
                    cursor.execute("""INSERT INTO piles_auto_assignment_runner_runs
                        (id,insurer_name,run_scope,portal_environment,run_source,months,year,mode,details)
                        VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                        ON CONFLICT(id) DO NOTHING""", tuple(fields[key] if key != "details" else json.dumps(fields[key])
                            for key in ("run_id", "insurer_name", "run_scope", "portal_environment", "run_source", "months", "year", "mode", "details")))
                self.conn.commit()
                return fields["run_id"]
            def try_acquire_insurer_lock(self, name):
                return self.conn.acquire("piles-insurer:" + runner.canonical_insurer_key(name))
            def release_insurer_lock(self, name):
                self.conn.release("piles-insurer:" + runner.canonical_insurer_key(name))
            def try_acquire_runner_slot(self, maximum):
                return next((slot for slot in range(maximum) if self.conn.acquire(f"piles-capacity:{slot}")), -1)
            def release_runner_slot(self, slot):
                self.conn.release(f"piles-capacity:{slot}")
            def restore_due_weekend_bot_states(self, _):
                restored, harness.restored = harness.restored, []
                return restored
            def get_bot_accounts(self, _): return []
            def get_weekend_roster_policy(self, **_): return None
            def get_bot_metrics(self, _): return {}
            def get_rule(self, _): return harness.rule
            def get_team_slack_map(self): return {}
            def get_all_tracked_tracking_keys(self, _): return set()
            def get_active_external_assignments(self, _): return []
            def sync_external_assignments_for_insurer(self, *_): pass
            def log_runner_event(self, **_): pass
            def log_assignment(self, *_args, **_kwargs): pass
        return Store

    def portal_type(self):
        harness = self
        class Portal(runner.CuracelPilesRunner):
            def __init__(self, **_):
                self.retry_attempt_numbers = {}
                self.assignment_attempt_ids = {}
                self.seen = Counter()
                self.visible_rows = []
                self.tables = {}
                harness.portals.append(self)
            def __enter__(self): return self
            def __exit__(self, *_):
                with harness.db.mutex:
                    harness.active.discard(getattr(self, "insurer_name", ""))
                if harness.on_exit:
                    harness.on_exit(self)
            def login(self, *_):
                row = harness.db.rows("SELECT * FROM piles_auto_assignment_work_items WHERE covered_by_insurer_run_id=?", (self.insurer_run_id,))[0]
                self.work = row
                with harness.db.mutex:
                    if self.insurer_name in harness.active:
                        raise AssertionError("Same insurer entered two portal sessions")
                    harness.active.add(self.insurer_name)
                    harness.peak = max(harness.peak, len(harness.active))
                    harness.entries.append((row["id"], row["insurer_name"], row["attempt_number"]))
                if harness.on_enter:
                    harness.on_enter(self)
                if self.insurer_name in harness.failures:
                    raise ValueError("<html>private-fixture-patient</html> password=private-fixture-secret")
            def select_account(self, *_): pass
            def open_piles(self): pass
            def year_filter_capabilities(self): return False, ["2026"]
            def scan_status(self, month, year, status, *, only_unassigned=False):
                context = (month, year, status)
                self.seen[context] += 1
                final = self.seen[context] > 1
                rows = (harness.late if final else harness.initial).get(self.insurer_name, []) if status == "Vetting Pending" else []
                self.visible_rows = [runner.replace(row) for row in rows]
                self.tables[context] = self.visible_rows
                harness.scans.append((self.work["id"], context, final, len(rows)))
                accumulator = runner.ScanAccumulator()
                accumulator.observe_page(1, rows)
                self._last_scan_result = accumulator.finish(explicit_empty=not rows)
                return [row for row in self.visible_rows if not only_unassigned or not row.assigned]
            def discover_portal_assignees(self, *_):
                return [runner.PortalAssignee("Acceptance owner", "primary", 1, 1)]
            def apply_filters(self, month, year, status):
                self.visible_rows = self.tables.get((month, year, status), [])
            def try_set_page_size(self, *_): pass
            def rows_on_current_page(self, *_): return self.visible_rows
            def goto_next_page(self, *_args, **_kwargs): return False
            def _select_rows(self, keys, _rows):
                self.selected = keys
                return runner.RowSelectionResult(len(keys), keys)
            def _open_assign_modal(self): pass
            def _apply_assignment_modal(self, kind, assignee, execute):
                assert execute
                self._heartbeat("apply")
                self._before_assignment_submit()
                self._heartbeat("apply")
                harness.clicks.extend((self.work["id"], key) for key in self.selected)
                return harness.modal_assignee or assignee
            def verify_assigned_rows(self, month, year, status, keys, assignee, *, tracking_keys, **_):
                expected = {key: {"attempt_id": self.assignment_attempt_ids[key], "expected_assignee": assignee} for key in tracking_keys}
                observed = {key: assignee for key in tracking_keys if harness.verdicts.get(key, "confirmed") == "confirmed"}
                observed.update({key: "Different owner" for key in tracking_keys if harness.verdicts.get(key) == "conflict"})
                decisions = list(runner.classify_assignment_observations(expected, observed))
                confirmed = sum(d.status == runner.AttemptStatus.CONFIRMED_VISIBLE for d in decisions)
                pending = sum(d.status == runner.AttemptStatus.RECONCILIATION_PENDING for d in decisions)
                wrong = [d.evidence.details.get("observed_assignee", "") for d in decisions if d.status == runner.AttemptStatus.CONFLICT]
                return runner.AssignmentVerificationResult(confirmed == len(keys), list(observed.values()), confirmed, pending, wrong, decisions)
        return Portal

    def invoke(self, *, parent="parent", insurer=None, maximum=1, portal="test", month="Jul", year="2026"):
        argv = ["runner", "--execute", "--portal-environment", portal, "--month", month, "--year", year, "--run-id", parent,
                "--run-source", "manual" if insurer else "schedule"]
        argv += ["--insurer", insurer] if insurer else ["--all-active"]
        result = None
        error = None
        real_dispatch = runner.dispatch_parent
        def collect(*args, **kwargs):
            result = real_dispatch(*args, **kwargs)
            self.dispatch_results.append(result)
            return result
        def thread(**fields):
            self.deliveries.append((parent, self.db.parent(parent)["status"], fields))
            assert not self.active, "Notifications must follow worker collection"
            assert threading.current_thread() is threading.main_thread()
            return "acceptance-thread"
        def reply(items, _thread, **_):
            self.results.extend((parent, item.plan.pile_key) for item in items)
            return True
        def side_summary(kind, items, **fields):
            assert not self.active, "Parent summaries must follow worker collection"
            assert threading.current_thread() is threading.main_thread()
            assert self.db.parent(parent)["status"] not in {"pending", "started"}
            assert fields["safe_diagnostics"] is True
            self.side_summaries.append((parent, kind, len(items)))
        with ExitStack() as patches:
            for target, value in (("DataStore", self.store_type()), ("CuracelPilesRunner", self.portal_type()),
                                  ("create_assignment_thread", thread), ("send_assignment_owner_reply", reply),
                                  ("send_external_assignment_alert", lambda items, **fields: side_summary("external", items, **fields)),
                                  ("send_weekend_restore_update", lambda items, **fields: side_summary("restore", items, **fields)),
                                  ("dispatch_parent", collect)):
                patches.enter_context(patch.object(runner, target, value))
            patches.enter_context(patch.object(runner.psycopg2, "connect", self.db.connect))
            patches.enter_context(patch.object(socket, "create_connection", forbidden))
            patches.enter_context(patch.dict(os.environ, {"PILES_AUTO_ASSIGNMENT_DISPATCHER_V2": "true",
                "PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY": str(maximum), "HEADLESS": "true"}))
            patches.enter_context(patch.object(sys, "argv", argv))
            self.output = io.StringIO()
            patches.enter_context(patch.object(sys, "stdout", self.output))
            patches.enter_context(patch.object(sys, "stderr", self.output))
            try:
                result = runner.main()
            except Exception as caught:
                error = caught
        return result, error

    def seed_pending(self, status):
        """Persist historical evidence using real ledger transitions, not a stub."""
        store = self.store_type()()
        ledger = runner.ExecutionLedger(self.db.connect())
        try:
            store.create_runner_run(run_id="historical", insurer_name="DEFMIS", run_scope="single",
                run_source="manual", mode="execute", details={})
            run_id = ledger.create_insurer_run("historical", store.get_master_account("DEFMIS"))
            ledger.create_batch_with_attempts({"id": "historical-batch", "insurer_run_id": run_id,
                "insurer_name": "DEFMIS", "intended_owner_name": "Acceptance owner",
                "intended_portal_assignee": "Acceptance owner", "assignment_type": "Vetting",
                "status_bucket": "Vetting Pending", "planned_claim_count": 10},
                [{"id": "historical-attempt", "tracking_key": "historical-pile", "last_pile_key": "historical-pile",
                  "claim_count": 10, "filter_context": {"month": "Jul", "year": "2026", "status": "Vetting Pending"}}])
            for target, previous in (("selected", "planned"), ("submitted", "selected")):
                ledger.transition_attempt("historical-attempt", target, expected={previous})
            if status == "reconciliation_pending":
                ledger.transition_attempt("historical-attempt", status, expected={"submitted"})
            ledger.finalize_insurer_run(run_id, status="completed_with_issues")
        finally:
            ledger.close()
            store.close()


class DispatcherAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory(prefix="piles-dispatch-acceptance-")
        self.addCleanup(self.directory.cleanup)
        self.harness = AcceptanceHarness(self.directory.name)
        self.addCleanup(self.harness.db.close)

    def test_pending_submission_is_not_announced_as_a_confirmed_assignment(self):
        # Break caught: _run_for_insurer_once includes every AppliedAssignment in
        # notification_items even when actual per-pile verification is pending.
        harness = self.harness
        harness.initial["DEFMIS"] = [harness.pile("confirmed"), harness.pile("pending")]
        harness.verdicts["pending"] = "pending"
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error, str(error))
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED_WITH_ISSUES)
        self.assertEqual(harness.db.rows("SELECT last_pile_key,status FROM piles_auto_assignment_attempts ORDER BY last_pile_key"),
                         [{"last_pile_key": "confirmed", "status": "confirmed_visible"},
                          {"last_pile_key": "pending", "status": "reconciliation_pending"}])
        self.assertEqual([key for _work, key in harness.clicks], ["confirmed", "pending"])
        self.assertEqual(harness.results, [("parent", "confirmed")])
        self.assertEqual([(status, fields["assigned_piles"]) for _parent, status, fields in harness.deliveries],
                         [("completed_with_issues", 1)])

    def test_complete_lifecycle_has_one_generation_per_insurer_and_one_explicit_manual_follow_up(self):
        # Breaks caught: overlapping enqueue becomes executable, manual work is
        # stolen/repeated, futures cancel peers, or aggregation uses finish order.
        for maximum in (1, 2):
            with self.subTest(max_workers=maximum), TemporaryDirectory(prefix="piles-cycle-") as directory:
                harness = AcceptanceHarness(directory)
                try:
                    self.complete_lifecycle(harness, maximum)
                finally:
                    harness.db.close()

    def test_parent_replay_rejects_changed_persisted_execution_scope_before_portal_work(self):
        cases = (
            ("portal", {"portal": "production"}, {}),
            ("months", {"months": ("Jul",)}, {"month": "Aug"}),
            ("year", {"year": "2026"}, {"year": "2025"}),
        )
        for label, persisted, replay in cases:
            with self.subTest(label=label), TemporaryDirectory() as directory:
                harness = AcceptanceHarness(directory)
                self.addCleanup(harness.db.close)
                harness.parent("parent", **persisted)
                result, error = harness.invoke(parent="parent", **replay)
                self.assertIsNone(result)
                self.assertIsNotNone(error)
                self.assertIn("scope", str(error).lower())
                self.assertEqual(harness.portals, [])
                self.assertEqual(harness.clicks, [])

    def complete_lifecycle(self, harness, maximum):
        harness.failures = {"DEFMIS"}
        harness.initial["Jubilee Kenya"] = [harness.pile("kenya-initial")]
        harness.initial["Jubilee Uganda"] = [harness.pile("uganda-initial")]
        harness.late["Jubilee Tanzania"] = [harness.pile("tanzania-late")]
        overlap = []
        manuals = []
        first_pair = threading.Barrier(2) if maximum == 2 else None
        entered = 0
        def arrival(portal):
            nonlocal entered
            with harness.db.mutex:
                entered += 1
                sequence = entered
                if sequence == 1:
                    overlap.extend(harness.parent("overlap"))
                    overlap.extend(harness.parent("overlap-again"))
                if portal.insurer_name == "Jubilee Kenya":
                    manuals.extend(harness.parent("manual", "Jubilee Kenya", "manual"))
                    manuals.extend(harness.parent("manual-repeat", "Jubilee Kenya", "manual"))
                    coordinator = runner.DispatchStore(harness.db.connect())
                    try:
                        self.assertIsNone(coordinator.claim_next("manual", "not-the-owner"))
                        with self.assertRaises(ParentWorkPending):
                            coordinator.finalize_parent("manual-repeat")
                    finally:
                        coordinator.close()
            if first_pair and sequence <= 2:
                first_pair.wait(timeout=5)
        harness.on_enter = arrival
        _result, error = harness.invoke(maximum=maximum)
        self.assertIsNotNone(error)  # The CLI reports the failed owned insurer.
        result = harness.dispatch_results[-1]
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED_WITH_ISSUES)
        self.assertEqual(harness.db.parent("parent")["status"], "completed_with_issues")
        self.assertEqual([outcome.insurer_name for outcome in result.outcomes], list(INSURERS))
        self.assertEqual([outcome.status.value for outcome in result.outcomes], ["failed", "completed", "completed", "completed"])
        self.assertEqual(harness.peak, maximum)
        self.assertEqual([decision.disposition.value for decision in overlap], ["covered_by_active_cycle"] * 8)
        self.assertEqual([decision.disposition.value for decision in manuals], ["follow_up_queued"] * 2)
        self.assertEqual([decision.create_work_item for decision in manuals], [True, False])
        self.assertEqual(len(harness.db.work("manual")), 1)
        self.assertEqual(harness.db.work("manual-repeat"), [])
        self.assertEqual(Counter(name for _work, name, _attempt in harness.entries), Counter(INSURERS))
        self.assertEqual(Counter(key for _work, key in harness.clicks), Counter({"kenya-initial": 1, "tanzania-late": 1, "uganda-initial": 1}))
        self.assertEqual(harness.results, [("parent", "kenya-initial"), ("parent", "tanzania-late"), ("parent", "uganda-initial")])
        self.assertEqual(len(harness.deliveries), 1)
        self.assertEqual(harness.deliveries[0][2]["assigned_piles"], 3)
        self.assertEqual(Counter(row["status"] for row in harness.db.rows("SELECT status FROM piles_auto_assignment_scan_contexts")), Counter({"empty": 13, "complete": 2}))
        self.assertEqual(len(harness.scans), 30)
        self.assertTrue(all(count == 2 for count in Counter((work, context) for work, context, _final, _count in harness.scans).values()))
        self.assertEqual(harness.db.rows("SELECT count(*) n FROM piles_auto_assignment_attempts WHERE last_pile_key='tanzania-late'"), [{"n": 1}])
        self.assertNotIn("private-fixture", repr(result) + harness.output.getvalue() + json.dumps(harness.db.rows("SELECT error_code,error_message,details FROM piles_auto_assignment_insurer_runs")))
        self.assertEqual(harness.db.locks, {})
        self.assertEqual(len({connection.pid for connection in harness.db.sessions}), len(harness.db.sessions))

        harness.on_enter = None
        for parent in ("overlap", "overlap-again"):
            covered, error = harness.invoke(parent=parent, maximum=maximum)
            self.assertIsNone(error)
            self.assertEqual(covered.status, runner.ParentRunStatus.COVERED_BY_ACTIVE_CYCLE)
        self.assertEqual(len(harness.entries), 4)
        self.assertEqual(len(harness.deliveries), 1)
        self.assertNotIn("parent_notification_incomplete", harness.output.getvalue())

        # The separate manual owner executes exactly one fresh generation. A
        # second requesting parent only acknowledges it after that generation ends.
        harness.initial["Jubilee Kenya"] = [harness.pile("manual-new")]
        manual, error = harness.invoke(parent="manual", insurer="Jubilee Kenya", maximum=maximum)
        self.assertIsNone(error)
        self.assertEqual(manual.status, runner.ParentRunStatus.COMPLETED)
        acknowledged, error = harness.invoke(parent="manual-repeat", insurer="Jubilee Kenya", maximum=maximum)
        self.assertIsNone(error)
        self.assertEqual(acknowledged.status, runner.ParentRunStatus.COVERED_BY_ACTIVE_CYCLE)
        self.assertNotIn("parent_notification_incomplete", harness.output.getvalue())
        self.assertEqual(len(harness.entries), 5)
        self.assertEqual(set(Counter(work for work, _name, _attempt in harness.entries).values()), {1})
        self.assertEqual(Counter(name for _work, name, _attempt in harness.entries), Counter({"DEFMIS": 1, "Jubilee Kenya": 2, "Jubilee Tanzania": 1, "Jubilee Uganda": 1}))
        self.assertEqual(len(harness.deliveries), 2)
        self.assertEqual(harness.results[-1], ("manual", "manual-new"))
        before = (list(harness.entries), list(harness.clicks), list(harness.deliveries), list(harness.results))
        replay, error = harness.invoke(parent="manual", insurer="Jubilee Kenya", maximum=maximum)
        self.assertIsNone(error)
        self.assertEqual(replay.outcomes, ())
        self.assertEqual((harness.entries, harness.clicks, harness.deliveries, harness.results), before)

    def test_reappearing_submitted_or_pending_evidence_reconciles_without_an_assignment_click(self):
        # Break caught: final-rescan planning fails to exclude a historical
        # submitted identity after reconciliation, causing a second portal click.
        for prior_status in ("submitted", "reconciliation_pending"):
            for observed, expected in (("Acceptance owner", "confirmed_reconciled"), ("", "still_unassigned"), (None, "reconciliation_pending")):
                with self.subTest(prior=prior_status, observed=observed), TemporaryDirectory(prefix="piles-reconcile-") as directory:
                    harness = AcceptanceHarness(directory)
                    try:
                        harness.seed_pending(prior_status)
                        if observed is not None:
                            harness.late["DEFMIS"] = [runner.replace(harness.pile("historical-pile"), assigned=observed)]
                        result, error = harness.invoke(insurer="DEFMIS")
                        self.assertIsNone(error, str(error))
                        self.assertEqual(result.status.value, "completed" if observed else "completed_with_issues")
                        self.assertEqual(harness.db.rows("SELECT id,status,attempt_number FROM piles_auto_assignment_attempts"),
                                         [{"id": "historical-attempt", "status": expected, "attempt_number": 1}])
                        self.assertEqual(harness.clicks, [])
                        self.assertEqual(harness.deliveries, [])
                        self.assertEqual(harness.results, [])
                        self.assertEqual(len(harness.entries), 1)
                        self.assertEqual(len(harness.scans), 10)
                    finally:
                        harness.db.close()

    def test_crashed_claim_requires_expiry_and_free_lock_then_reclaims_same_generation(self):
        # Breaks caught: lease-only reclaim, duplicate generation insertion,
        # stale-token finalization, or old-worker side effects after replacement.
        harness = self.harness
        harness.parent("parent", "DEFMIS", "manual")
        coordinator = runner.DispatchStore(harness.db.connect())
        self.addCleanup(coordinator.close)
        old_work = coordinator.claim_next("parent", "crashed-worker")
        worker = harness.store_type()()
        self.addCleanup(worker.close)
        self.assertEqual(worker.try_acquire_runner_slot(1), 0)
        self.assertTrue(worker.try_acquire_insurer_lock("DEFMIS"))
        ownership_class = runner.execute_claimed_insurer.__globals__["ClaimOwnership"]
        old_owner = ownership_class(old_work, coordinator, worker.conn.pid, 0, 120)
        old_owner.check()
        self.assertEqual(coordinator.recoverable_expired_work(), [])
        harness.db.now += timedelta(seconds=121)
        self.assertEqual(coordinator.recoverable_expired_work(), [])
        self.assertIsNone(coordinator.claim_next("parent", "premature-recovery"))
        self.assertFalse(coordinator.renew_claim(old_work.id, old_work.claim_token))
        with self.assertRaises(runner.WorkOwnershipLost):
            old_owner.check()
        self.assertEqual(harness.entries, [])
        worker.close()  # Simulated process loss releases both session locks.
        self.assertEqual(harness.db.locks, {})
        self.assertEqual([work.id for work in coordinator.recoverable_expired_work()], [old_work.id])
        harness.initial["DEFMIS"] = [harness.pile("recovered-once")]
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error, str(error))
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        work = harness.db.work("parent")
        self.assertEqual(len(work), 1)
        self.assertEqual((work[0]["id"], work[0]["generation_requested_at"], work[0]["attempt_number"], work[0]["disposition"]),
                         (old_work.id, old_work.generation_requested_at.isoformat(), 2, "completed"))
        self.assertNotEqual(work[0]["claim_token"], old_work.claim_token)
        self.assertFalse(coordinator.finish_claim(old_work.id, old_work.claim_token, "failed"))
        self.assertFalse(coordinator.release_claim(old_work.id, old_work.claim_token, "dispatch_stopped"))
        with self.assertRaises(runner.WorkOwnershipLost):
            old_owner.check()
            harness.clicks.append((old_work.id, "forbidden-stale-click"))
        self.assertEqual(harness.entries, [(old_work.id, "DEFMIS", 2)])
        self.assertEqual(harness.clicks, [(old_work.id, "recovered-once")])
        self.assertEqual(harness.results, [("parent", "recovered-once")])
        self.assertEqual(len(harness.deliveries), 1)

    def test_sigterm_during_claim_leaves_recoverable_work_then_resumes_once(self):
        # Break caught: the real main SIGTERM handler fails to fence a work item
        # returned by claim_next after shutdown, before its portal worker starts.
        harness = self.harness
        harness.initial["DEFMIS"] = [harness.pile("shutdown-recovered")]
        original_handler = signal.getsignal(signal.SIGTERM)
        original_claim = runner.DispatchStore.claim_next
        signalled = False
        def interrupted_claim(store, *args, **kwargs):
            nonlocal signalled
            work = original_claim(store, *args, **kwargs)
            if work is not None and not signalled:
                signalled = True
                signal.raise_signal(signal.SIGTERM)
            return work
        with patch.object(runner.DispatchStore, "claim_next", interrupted_claim):
            _result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNotNone(error)
        self.assertIs(signal.getsignal(signal.SIGTERM), original_handler)
        self.assertEqual(harness.entries, [])
        self.assertEqual(harness.clicks, [])
        self.assertEqual(harness.deliveries, [])
        old = harness.db.work("parent")[0]
        self.assertEqual((old["disposition"], old["reason_code"], old["attempt_number"]), ("claimed", "dispatch_stopped", 1))
        self.assertEqual(harness.db.parent("parent")["status"], "started")
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error, str(error))
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertEqual(harness.entries, [(old["id"], "DEFMIS", 2)])
        self.assertEqual(harness.clicks, [(old["id"], "shutdown-recovered")])
        self.assertEqual(harness.db.work("parent")[0]["generation_requested_at"], old["generation_requested_at"])
        self.assertEqual(len(harness.deliveries), 1)

    def test_interrupted_parent_resume_never_announces_a_premature_or_partial_summary(self):
        # Break caught: main notifies a RUNNING parent's partial in-memory
        # collection, then misrepresents the remaining workers as a full summary.
        harness = self.harness
        for name in INSURERS:
            harness.initial[name] = [harness.pile(name + "-once")]
        harness.on_enter = lambda _: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        _result, error = harness.invoke(maximum=1)
        self.assertIsNotNone(error)
        self.assertEqual(len(harness.entries), 1)
        self.assertEqual(len(harness.clicks), 1)
        self.assertEqual(harness.db.parent("parent")["status"], "started")
        self.assertEqual(Counter(row["disposition"] for row in harness.db.work("parent")),
                         Counter({"completed": 1, "queued": 3}))
        self.assertEqual(harness.deliveries, [])
        self.assertEqual(harness.results, [])
        harness.on_enter = None
        result, error = harness.invoke(maximum=2)
        self.assertIsNone(error, str(error))
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertEqual(harness.db.parent("parent")["status"], "completed")
        self.assertEqual(len(harness.entries), 4)
        self.assertEqual(set(Counter(work for work, _name, _attempt in harness.entries).values()), {1})
        self.assertEqual(Counter(key for _work, key in harness.clicks), Counter({name + "-once": 1 for name in INSURERS}))
        self.assertEqual(harness.db.rows("SELECT status,count(*) n FROM piles_auto_assignment_attempts GROUP BY status"),
                         [{"status": "confirmed_visible", "n": 4}])
        self.assertEqual(harness.deliveries, [])
        self.assertEqual(harness.results, [])
        self.assertIn("parent_notification_incomplete", harness.output.getvalue())
        self.assertNotIn("private-fixture", harness.output.getvalue())

    def test_notification_collection_rejects_malformed_missing_duplicate_and_foreign_generations(self):
        # Breaks caught: set-normalization silently accepts duplicate/untrusted
        # IDs, or generation checks include another parent's coverage/result.
        harness = self.harness
        harness.initial["DEFMIS"] = [harness.pile("one")]
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error)
        collected = result.finalized_work_ids
        self.assertEqual(len(collected), 1)
        self.assertNotIn(collected[0], repr(result))
        coordinator = runner.DispatchStore(harness.db.connect())
        self.addCleanup(coordinator.close)
        before = harness.db.work("parent")
        self.assertTrue(coordinator.notification_collection_complete("parent", collected, result.notification_fingerprints))
        for values in ((), collected * 2, [None], [1], [" " + collected[0]], [collected[0].upper()],
                       ["not-a-work-id"], ["0" * 32], [f"{index:032x}" for index in range(257)]):
            with self.subTest(values=type(values).__name__, count=len(values)):
                self.assertFalse(coordinator.notification_collection_complete("parent", values))
        self.assertFalse(coordinator.notification_collection_complete("foreign", collected))
        fingerprints = result.notification_fingerprints
        self.assertEqual(len(fingerprints), 1)
        self.assertNotIn(fingerprints[0], repr(result) + harness.output.getvalue())
        for values in ((), fingerprints * 2, [None], [1], [" " + fingerprints[0]], [fingerprints[0].upper()],
                       ["0" * 64], [f"{index:064x}" for index in range(10001)]):
            with self.subTest(fingerprint_count=len(values)):
                self.assertFalse(coordinator.notification_collection_complete("parent", collected, values))
        self.assertEqual(harness.db.work("parent"), before)

    def test_notification_collection_database_failure_emits_only_a_fixed_diagnostic(self):
        for query in ("ORDER BY id LIMIT 257", "ORDER BY run.id, attempt.id LIMIT 10001"):
            with self.subTest(query=query), TemporaryDirectory(prefix="piles-notify-db-") as directory:
                harness = AcceptanceHarness(directory)
                try:
                    harness.initial["DEFMIS"] = [harness.pile("confirmed")]
                    execute = SqlCursor.execute
                    def unavailable(cursor, sql, params=()):
                        if query in sql:
                            raise RuntimeError("private-fixture-secret <html>private-fixture-patient</html>")
                        return execute(cursor, sql, params)
                    with patch.object(SqlCursor, "execute", unavailable):
                        result, error = harness.invoke(insurer="DEFMIS")
                    self.assertIsNone(error)
                    self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
                    self.assertEqual(harness.db.parent("parent")["status"], "completed")
                    self.assertEqual(harness.results, [])
                    self.assertEqual(harness.deliveries, [])
                    self.assertIn("parent_notification_incomplete", harness.output.getvalue())
                    self.assertNotIn("private-fixture", harness.output.getvalue())
                finally:
                    harness.db.close()

    def test_parent_gate_covers_external_and_restore_summaries_after_actual_worker_collection(self):
        # External detection/configuration payloads enter at the adapter boundary;
        # generation execution, confirmations, shutdown, resume and collection
        # still use the real runner/store. Roster scheduling updates are separate.
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted), TemporaryDirectory(prefix="piles-parent-summaries-") as directory:
                harness = AcceptanceHarness(directory)
                try:
                    for name in INSURERS:
                        harness.initial[name] = [harness.pile(name + "-confirmed")]
                    harness.restored = [{"insurer_name": "DEFMIS", "bot_name": "Acceptance owner"}]
                    run_one = runner.run_claimed_insurer_once
                    def with_external_evidence(*args, **kwargs):
                        result = run_one(*args, **kwargs)
                        result["external_notification_items"] = [runner.ExternalNotificationItem(
                            args[0].insurer_name, "Synthetic acceptance provider", 1, 1, "Jul",
                            "Vetting Pending", "Acceptance owner", "Acceptance owner", "")]
                        return result
                    if interrupted:
                        harness.on_enter = lambda _: signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                    with patch.object(runner, "run_claimed_insurer_once", with_external_evidence):
                        result, error = harness.invoke(maximum=1)
                        if interrupted:
                            self.assertIsNotNone(error)
                            self.assertEqual(harness.side_summaries, [])
                            self.assertEqual(harness.deliveries, [])
                            harness.on_enter = None
                            # A new legitimate configuration restoration must also
                            # remain silent when the resumed collection is partial.
                            harness.restored = [{"insurer_name": "Jubilee Kenya", "bot_name": "Acceptance owner"}]
                            result, error = harness.invoke(maximum=2)
                    self.assertIsNone(error, str(error))
                    self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
                    self.assertEqual(len(harness.entries), 4)
                    self.assertEqual(len(harness.clicks), 4)
                    self.assertEqual(harness.db.rows("SELECT status,count(*) n FROM piles_auto_assignment_attempts GROUP BY status"),
                                     [{"status": "confirmed_visible", "n": 4}])
                    self.assertEqual(harness.side_summaries, [] if interrupted else [("parent", "external", 4), ("parent", "restore", 1)])
                    self.assertEqual(len(harness.deliveries), 0 if interrupted else 1)
                    self.assertEqual(len(harness.results), 0 if interrupted else 4)
                    self.assertEqual("parent_notification_incomplete" in harness.output.getvalue(), interrupted)
                finally:
                    harness.db.close()

    def test_duplicate_extra_or_same_count_wrong_notification_identity_fails_closed(self):
        for mutation in ("duplicate", "extra", "wrong_key", "wrong_insurer", "missing"):
            with self.subTest(mutation=mutation), TemporaryDirectory(prefix="piles-payload-") as directory:
                harness = AcceptanceHarness(directory)
                try:
                    harness.initial["DEFMIS"] = [harness.pile("confirmed-one"), harness.pile("confirmed-two")]
                    run_one = runner.run_claimed_insurer_once
                    def corrupt_payload(*args, **kwargs):
                        result = run_one(*args, **kwargs)
                        items = result["notification_items"]
                        replacement = runner.replace(items[0], plan=runner.replace(items[0].plan,
                            tracking_key="wrong" if mutation != "wrong_insurer" else items[0].plan.tracking_key,
                            insurer_name="Jubilee Kenya" if mutation == "wrong_insurer" else "DEFMIS"))
                        if mutation == "duplicate": items.append(items[0])
                        elif mutation == "extra": items.append(replacement)
                        elif mutation == "missing": items.pop()
                        else: items[0] = replacement
                        return result
                    with patch.object(runner, "run_claimed_insurer_once", corrupt_payload):
                        result, error = harness.invoke(insurer="DEFMIS")
                    self.assertIsNone(error, str(error))
                    self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
                    self.assertEqual(harness.db.rows("SELECT status,count(*) n FROM piles_auto_assignment_attempts GROUP BY status"),
                                     [{"status": "confirmed_visible", "n": 2}])
                    self.assertEqual(harness.deliveries, [])
                    self.assertEqual(harness.results, [])
                    self.assertIn("parent_notification_incomplete", harness.output.getvalue())
                finally:
                    harness.db.close()

    def test_confirmation_query_overflow_suppresses_partial_identity_evidence(self):
        harness = self.harness
        harness.initial["DEFMIS"] = [harness.pile("first")]
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error)
        attempt = harness.db.rows("SELECT * FROM piles_auto_assignment_attempts")[0]
        harness.db.admin.raw.executemany("""INSERT INTO piles_auto_assignment_attempts
            (id,batch_id,insurer_run_id,insurer_name,tracking_key,intended_owner_name,intended_portal_assignee,status)
            VALUES (?,?,?,'DEFMIS',?,'Acceptance owner','Acceptance owner','confirmed_visible')""",
            [(f"attempt-{index}", attempt["batch_id"], attempt["insurer_run_id"], f"identity-{index}") for index in range(10000)])
        harness.db.admin.raw.commit()
        coordinator = runner.DispatchStore(harness.db.connect())
        self.addCleanup(coordinator.close)
        self.assertFalse(coordinator.notification_collection_complete("parent", result.finalized_work_ids, result.notification_fingerprints))

    def test_conflict_unmatched_and_manual_outcomes_never_become_assignment_notifications(self):
        for outcome in ("conflict", "unmatched", "manual"):
            with self.subTest(outcome=outcome), TemporaryDirectory(prefix="piles-unconfirmed-") as directory:
                harness = AcceptanceHarness(directory)
                try:
                    harness.initial["DEFMIS"] = [harness.pile("not-notifiable")]
                    if outcome == "manual":
                        harness.rule = runner.AssignmentRule("DEFMIS", "manual_override", 25, 60, 50, 60)
                    elif outcome == "unmatched":
                        harness.modal_assignee = "Different selected owner"
                    else:
                        harness.verdicts["not-notifiable"] = "conflict"
                    result, error = harness.invoke(insurer="DEFMIS")
                    self.assertIsNone(error, str(error))
                    self.assertEqual(harness.results, [])
                    self.assertEqual(harness.deliveries, [])
                    self.assertEqual(len(harness.clicks), 0 if outcome == "manual" else 1)
                    if outcome != "unmatched":
                        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED_WITH_ISSUES)
                    if outcome == "conflict":
                        self.assertEqual(harness.db.rows("SELECT status FROM piles_auto_assignment_attempts"), [{"status": "conflict"}])
                    if outcome == "manual":
                        self.assertEqual(harness.db.rows("SELECT status FROM piles_auto_assignment_insurer_runs"), [{"status": "manual_action_required"}])
                finally:
                    harness.db.close()

    def test_notification_collection_excludes_inactive_but_refuses_oversized_owned_work(self):
        harness = self.harness
        harness.db.admin.raw.execute("UPDATE piles_auto_assignment_master_accounts SET is_active=false WHERE insurer_name='DEFMIS'")
        harness.db.admin.raw.commit()
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error)
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertEqual(harness.entries, [])
        self.assertNotIn("parent_notification_incomplete", harness.output.getvalue())
        coordinator = runner.DispatchStore(harness.db.connect())
        self.addCleanup(coordinator.close)
        self.assertTrue(coordinator.notification_collection_complete("parent", ()))
        for index in range(257):
            harness.db.admin.raw.execute("""INSERT INTO piles_auto_assignment_work_items
                (id,parent_runner_run_id,insurer_name,canonical_insurer_name,source,request_scope,disposition)
                VALUES (?,'parent','DEFMIS','defmis','schedule','all_active','completed')""", (f"{index:032x}",))
        harness.db.admin.raw.commit()
        self.assertFalse(coordinator.notification_collection_complete("parent", [f"{index:032x}" for index in range(256)]))

    def test_failure_after_confirmation_suppresses_a_partial_terminal_summary(self):
        harness = self.harness
        harness.initial["DEFMIS"] = [harness.pile("confirmed-before-error")]
        harness.initial["Jubilee Kenya"] = [harness.pile("confirmed-peer")]
        def fail_after_portal(portal):
            if portal.insurer_name == "DEFMIS":
                raise ValueError("private-fixture late failure")
        harness.on_exit = fail_after_portal
        _result, error = harness.invoke(maximum=2)
        self.assertIsNotNone(error)
        self.assertEqual(harness.db.parent("parent")["status"], "completed_with_issues")
        self.assertEqual(harness.db.rows("SELECT status,count(*) n FROM piles_auto_assignment_attempts GROUP BY status"),
                         [{"status": "confirmed_visible", "n": 2}])
        self.assertEqual(harness.deliveries, [])
        self.assertEqual(harness.results, [])
        self.assertIn("parent_notification_incomplete", harness.output.getvalue())

    def test_late_reconciliation_without_matching_payload_never_announces_only_the_early_confirmation(self):
        harness = self.harness
        harness.initial["DEFMIS"] = [harness.pile("early-confirmed"), harness.pile("late-confirmed")]
        harness.verdicts["late-confirmed"] = "pending"
        harness.late["DEFMIS"] = [runner.replace(harness.pile("late-confirmed"), assigned="Acceptance owner")]
        result, error = harness.invoke(insurer="DEFMIS")
        self.assertIsNone(error, str(error))
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertEqual(harness.db.rows("SELECT last_pile_key,status FROM piles_auto_assignment_attempts ORDER BY last_pile_key"),
                         [{"last_pile_key": "early-confirmed", "status": "confirmed_visible"},
                          {"last_pile_key": "late-confirmed", "status": "confirmed_reconciled"}])
        self.assertEqual(Counter(key for _work, key in harness.clicks), Counter({"early-confirmed": 1, "late-confirmed": 1}))
        self.assertEqual(harness.deliveries, [])
        self.assertEqual(harness.results, [])
        self.assertIn("parent_notification_incomplete", harness.output.getvalue())


if __name__ == "__main__":
    unittest.main()
