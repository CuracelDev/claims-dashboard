import json
import re
import sqlite3
import unittest
from datetime import datetime, timedelta, timezone

from scripts.piles_auto_assignment.domain import AttemptStatus
from scripts.piles_auto_assignment.domain import (
    ParentRunStatus, RequestScope, WorkDisposition, WorkRequest, WorkSource,
)
from scripts.piles_auto_assignment import store
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


NOW = datetime(2026, 9, 10, 9, tzinfo=timezone.utc)


class DispatchConnection(RecordingConnection):
    """Scripted PostgreSQL boundary: each SQL operation consumes one response."""

    def __init__(self, *responses):
        super().__init__()
        self.responses = list(responses)
        self.autocommit = False
        self.closed = False

    def cursor(self):
        connection = self

        class Cursor(RecordingCursor):
            def execute(self, sql, params=()):
                super().execute(sql, params)
                if not connection.responses:
                    raise AssertionError("Unexpected SQL operation: " + sql)
                response = connection.responses.pop(0)
                if isinstance(response, Exception):
                    raise response
                if callable(response):
                    response = response(sql, params)
                self.rows = response
                self.description = [(key,) for key in response[0]] if response else []

            def fetchall(self):
                return [tuple(row.values()) for row in self.rows]

            def fetchone(self):
                rows = self.fetchall()
                return rows[0] if rows else None

        return Cursor(self)

    def close(self):
        self.closed = True


class EnqueueSqlConnection:
    """Execute enqueue's relational SQL, adapting only PostgreSQL dialect APIs.

    This adapter does not model lock/concurrency semantics: those are covered by
    the recording tests and disposable PostgreSQL checks. Coverage predicates,
    inserts, parent references, and unique indexes execute against real tables.
    """

    autocommit = False

    def __init__(self):
        self.database = sqlite3.connect(":memory:")
        self.database.create_function("now", 0, lambda: NOW.isoformat())
        self.database.create_function("btrim", 1, str.strip)
        self.database.create_function("regexp_replace", 4, lambda value, pattern, replacement, flags: re.sub(pattern, replacement, value))
        self.database.create_function("json_contains", 2, lambda covering, requested: int(
            set(json.loads(covering)).issuperset(json.loads(requested))
        ))
        self.database.create_function("hashtextextended", 2, lambda value, seed: value)
        self.database.create_function("pg_advisory_xact_lock", 1, lambda value: 1)
        self.database.executescript("""
            CREATE TABLE piles_auto_assignment_master_accounts(insurer_name TEXT, is_active BOOLEAN);
            CREATE TABLE piles_auto_assignment_runner_runs(
                id TEXT PRIMARY KEY, status TEXT DEFAULT 'started', mode TEXT DEFAULT 'execute',
                run_scope TEXT DEFAULT 'all-active', portal_environment TEXT DEFAULT 'production',
                months TEXT DEFAULT '["All"]', year TEXT DEFAULT 'All',
                details TEXT DEFAULT '{}', updated_at TEXT);
            CREATE TABLE piles_auto_assignment_insurer_runs(
                id TEXT PRIMARY KEY, runner_run_id TEXT, insurer_name TEXT, status TEXT,
                started_at TEXT, finished_at TEXT, created_at TEXT DEFAULT (now()));
            CREATE TABLE piles_auto_assignment_work_items(
                id TEXT PRIMARY KEY, parent_runner_run_id TEXT, insurer_name TEXT,
                canonical_insurer_name TEXT, source TEXT, request_scope TEXT,
                portal_environment TEXT DEFAULT 'production', months TEXT DEFAULT '["All"]', year TEXT DEFAULT 'All',
                disposition TEXT, generation_requested_at TEXT,
                covered_by_insurer_run_id TEXT, requested_at TEXT,
                started_at TEXT, finished_at TEXT, updated_at TEXT);
            CREATE UNIQUE INDEX queued_generation ON piles_auto_assignment_work_items
                (canonical_insurer_name, source, request_scope, portal_environment, months, year)
                WHERE disposition = 'queued';
            CREATE UNIQUE INDEX follow_up ON piles_auto_assignment_work_items
                (canonical_insurer_name, portal_environment, months, year)
                WHERE disposition = 'follow_up_queued';
        """)

    def cursor(self):
        connection = self

        class Cursor:
            def __enter__(self):
                self.raw = connection.database.cursor()
                return self

            def __exit__(self, *_args):
                self.raw.close()
                return False

            def execute(self, sql, params=()):
                sql = sql.replace("%s", "?").replace(" FOR UPDATE", "")
                sql = sql.replace("completed.months @> ?::jsonb", "json_contains(completed.months, ?)")
                sql = sql.replace("::jsonb", "")
                sql = sql.replace(
                    "jsonb_set(coalesce(details, '{}'), '{dispatch_requests}', ?)",
                    "json_set(coalesce(details, '{}'), '$.dispatch_requests', json(?))",
                )
                self.raw.execute(sql, tuple(value.isoformat() if isinstance(value, datetime) else value for value in params))
                self.description = self.raw.description

            def fetchall(self):
                return [tuple(
                    json.loads(value) if column[0] in {"details", "months"} and value is not None else
                    datetime.fromisoformat(value) if column[0].endswith("_at") and value else value
                    for column, value in zip(self.description, row)
                ) for row in self.raw.fetchall()]

            def fetchone(self):
                rows = self.fetchall()
                return rows[0] if rows else None

        return Cursor()

    def commit(self):
        self.database.commit()

    def rollback(self):
        self.database.rollback()

    def close(self):
        self.database.close()


class LegacyCoverageSqlTests(unittest.TestCase):
    def setUp(self):
        self.connection = EnqueueSqlConnection()
        self.addCleanup(self.connection.close)
        self.store = store.DispatchStore(self.connection)
        self.connection.database.execute(
            "INSERT INTO piles_auto_assignment_master_accounts VALUES ('OLD MUTUAL', true)"
        )
        for parent_id in ("legacy", "request-1", "request-2", "request-3"):
            self.connection.database.execute(
                "INSERT INTO piles_auto_assignment_runner_runs(id) VALUES (?)", (parent_id,)
            )
        self.connection.database.execute("""
            INSERT INTO piles_auto_assignment_insurer_runs
                (id, runner_run_id, insurer_name, status, started_at)
            VALUES ('legacy-insurer', 'legacy', 'old  mutual', 'running', ?)
        """, ((NOW - timedelta(minutes=30)).isoformat(),))
        self.connection.commit()

    def enqueue(self, parent_id, source=WorkSource.SCHEDULE):
        return self.store.enqueue_parent_work(parent_id, [WorkRequest("UAPOM", source, NOW)])[0]

    def set_parent_scope(self, parent_id, *, portal="production", months=("All",), year="All"):
        self.connection.database.execute(
            "UPDATE piles_auto_assignment_runner_runs SET portal_environment=?, months=?, year=? WHERE id=?",
            (portal, json.dumps(months), year, parent_id),
        )
        self.connection.commit()

    def test_repeated_execute_overlaps_keep_covering_the_active_legacy_cycle(self):
        for parent_id in ("request-1", "request-2", "request-3"):
            with self.subTest(parent=parent_id):
                decision = self.enqueue(parent_id)
                self.assertEqual(decision.disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
                self.assertEqual(decision.covered_by_insurer_run_id, "legacy-insurer")
        rows = self.connection.database.execute(
            "SELECT disposition FROM piles_auto_assignment_work_items ORDER BY parent_runner_run_id"
        ).fetchall()
        self.assertEqual(rows, [("covered_by_active_cycle",)] * 3)

    def test_dry_run_cycle_does_not_cover_execute_requests(self):
        self.connection.database.execute(
            "UPDATE piles_auto_assignment_runner_runs SET mode = 'dry-run' WHERE id = 'legacy'"
        )
        self.connection.commit()
        decision = self.enqueue("request-1")
        self.assertEqual(decision.disposition, WorkDisposition.QUEUED)
        self.assertEqual(decision.covered_by_insurer_run_id, "")
        row = self.connection.database.execute(
            "SELECT disposition, covered_by_insurer_run_id FROM piles_auto_assignment_work_items"
        ).fetchone()
        self.assertEqual(row, ("queued", None))

    def test_same_parent_acknowledgement_does_not_hide_legacy_execute_run(self):
        self.assertEqual(self.enqueue("legacy").disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
        self.assertEqual(self.enqueue("request-1").disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)

    def test_legacy_active_cycle_only_covers_a_contained_parent_execution_scope(self):
        cases = (
            ("different portal", dict(portal="test"), dict(portal="production"), WorkDisposition.QUEUED),
            ("narrow month", dict(months=("Jul",)), dict(months=("All",)), WorkDisposition.QUEUED),
            ("narrow year", dict(year="2025"), dict(year="All"), WorkDisposition.QUEUED),
            ("broad scope", dict(months=("All",), year="All"), dict(months=("July",), year="2025"), WorkDisposition.COVERED_BY_ACTIVE_CYCLE),
        )
        for index, (label, active_scope, request_scope, expected) in enumerate(cases, 1):
            with self.subTest(label=label):
                self.connection.database.execute("DELETE FROM piles_auto_assignment_work_items")
                request_parent = f"scope-request-{index}"
                self.connection.database.execute("INSERT INTO piles_auto_assignment_runner_runs(id) VALUES (?)", (request_parent,))
                self.set_parent_scope("legacy", **active_scope)
                self.set_parent_scope(request_parent, **request_scope)
                self.assertEqual(self.enqueue(request_parent).disposition, expected)

    def test_queued_generations_dedupe_only_equivalent_normalized_scopes(self):
        self.connection.database.execute("INSERT INTO piles_auto_assignment_runner_runs(id) VALUES ('equivalent'),('different')")
        self.connection.database.execute("UPDATE piles_auto_assignment_insurer_runs SET status='completed'")
        self.set_parent_scope("request-1", portal=" production ", months=("August", "Jul", "July"), year=" 2025 ")
        self.set_parent_scope("equivalent", months=("Jul", "Aug"), year="2025")
        self.set_parent_scope("different", months=("All",), year="2025")

        first = self.enqueue("request-1", WorkSource.MANUAL)
        equivalent = self.enqueue("equivalent", WorkSource.MANUAL)
        different = self.enqueue("different", WorkSource.MANUAL)

        self.assertTrue(first.create_work_item)
        self.assertFalse(equivalent.create_work_item)
        self.assertTrue(different.create_work_item)
        rows = self.connection.database.execute(
            "SELECT portal_environment,months,year FROM piles_auto_assignment_work_items WHERE disposition='queued' ORDER BY months"
        ).fetchall()
        self.assertEqual(rows, [("production", '["All"]', "2025"), ("production", '["Jul", "Aug"]', "2025")])

    def test_terminal_owned_execution_is_not_reintroduced_as_legacy_coverage(self):
        self.connection.database.execute("""
            INSERT INTO piles_auto_assignment_work_items
                (id, parent_runner_run_id, insurer_name, canonical_insurer_name,
                 source, request_scope, disposition, covered_by_insurer_run_id, requested_at)
            VALUES ('finished-work', 'legacy', 'UAPOM', 'OLD MUTUAL',
                    'schedule', 'all_active', 'failed', 'legacy-insurer', now())
        """)
        self.connection.commit()
        self.assertEqual(self.enqueue("request-1").disposition, WorkDisposition.QUEUED)

    def test_readiness_probe_does_not_create_work_alongside_execute_cycle(self):
        with self.assertRaises(ValueError):
            self.enqueue("request-1", WorkSource.READINESS)
        self.assertEqual(self.connection.database.execute(
            "SELECT count(*) FROM piles_auto_assignment_work_items"
        ).fetchone()[0], 0)

    def test_dry_run_does_not_turn_manual_execute_work_into_a_follow_up(self):
        self.connection.database.execute(
            "UPDATE piles_auto_assignment_runner_runs SET mode = 'dry-run' WHERE id = 'legacy'"
        )
        self.connection.commit()
        decision = self.enqueue("request-1", WorkSource.MANUAL)
        self.assertEqual(decision.disposition, WorkDisposition.QUEUED)
        self.assertTrue(decision.create_work_item)

    def test_v2_queued_and_claimed_generations_still_cover_execute_overlap(self):
        self.connection.database.execute(
            "UPDATE piles_auto_assignment_runner_runs SET mode = 'dry-run' WHERE id = 'legacy'"
        )
        self.connection.database.execute("""
            INSERT INTO piles_auto_assignment_work_items
                (id, parent_runner_run_id, insurer_name, canonical_insurer_name,
                 source, request_scope, disposition, requested_at)
            VALUES ('v2-work', 'request-1', 'UAPOM', 'OLD MUTUAL',
                    'schedule', 'all_active', 'queued', now())
        """)
        self.connection.commit()
        self.assertEqual(self.enqueue("request-2").disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
        self.connection.database.execute(
            "UPDATE piles_auto_assignment_work_items SET disposition = 'claimed' WHERE id = 'v2-work'"
        )
        self.connection.commit()
        self.assertEqual(self.enqueue("request-3").disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
        self.assertEqual(self.connection.database.execute(
            "SELECT count(*) FROM piles_auto_assignment_work_items WHERE disposition IN ('queued','claimed')"
        ).fetchone()[0], 1)


def work_row(**changes):
    return {
        "id": "work-1", "parent_runner_run_id": "parent-1",
        "insurer_name": "UAPOM", "canonical_insurer_name": "OLD MUTUAL",
        "source": "schedule", "request_scope": "all_active",
        "disposition": "claimed", "covered_by_insurer_run_id": None,
        "worker_id": "worker-1", "claim_token": "token-1",
        "lease_expires_at": NOW + timedelta(seconds=120), "heartbeat_at": NOW,
        "generation_requested_at": NOW, "attempt_number": 1,
        "requested_at": NOW, "claimed_at": NOW, "started_at": None,
        "finished_at": None, "reason_code": None,
        "created_at": NOW, "updated_at": NOW, **changes,
    }


class LeaseSqlConnection:
    """Execute CAS predicates in SQL; emulate only PostgreSQL dialect/lock catalog."""
    autocommit = False

    def __init__(self):
        self.database = sqlite3.connect(":memory:")
        self.wall_time = 1000
        self.database.create_function("now", 0, lambda: 1000)
        self.database.create_function("clock_timestamp", 0, lambda: self.wall_time)
        self.database.create_function("current_database", 0, lambda: "fixture")
        self.database.create_function("hashtextextended", 2,
                                      lambda key, seed: {"piles-insurer:OLD MUTUAL": 11, "piles-capacity:0": 12}.get(key, 99))
        self.database.executescript("""
            CREATE TABLE piles_auto_assignment_work_items(
                id TEXT PRIMARY KEY, parent_runner_run_id TEXT, canonical_insurer_name TEXT,
                disposition TEXT, claim_token TEXT, lease_expires_at INTEGER, heartbeat_at INTEGER,
                started_at INTEGER, finished_at INTEGER, updated_at INTEGER,
                covered_by_insurer_run_id TEXT, reason_code TEXT);
            INSERT INTO piles_auto_assignment_work_items
                (id,parent_runner_run_id,canonical_insurer_name,disposition,claim_token,lease_expires_at)
                VALUES ('work','parent','OLD MUTUAL','claimed','current',1120);
            CREATE TABLE piles_auto_assignment_insurer_runs(id TEXT, runner_run_id TEXT);
            INSERT INTO piles_auto_assignment_insurer_runs VALUES ('run','parent'),('foreign','other');
            CREATE TABLE pg_database(oid INTEGER, datname TEXT);
            INSERT INTO pg_database VALUES (1,'fixture');
            CREATE TABLE pg_locks(locktype TEXT, pid INTEGER, classid INTEGER, objid INTEGER,
                                  objsubid INTEGER, database INTEGER, mode TEXT, granted BOOLEAN);
            INSERT INTO pg_locks VALUES ('advisory',41,0,11,1,1,'ExclusiveLock',true),
                                        ('advisory',41,0,12,1,1,'ExclusiveLock',true);
        """)

    def cursor(self):
        connection = self
        class Cursor:
            def __enter__(self):
                self.raw = connection.database.cursor()
                return self
            def __exit__(self, *_):
                self.raw.close()
            def execute(self, sql, params=()):
                sql = sql.replace("%s", "?").replace("::bigint", "").replace("::text", "")
                sql = sql.replace("* interval '1 second'", "").replace(" FOR UPDATE", "")
                self.raw.execute(sql, params)
                self.description = self.raw.description
            def fetchone(self):
                return self.raw.fetchone()
        return Cursor()

    def commit(self):
        self.database.commit()
    def rollback(self):
        self.database.rollback()
    def close(self):
        self.database.close()


class DispatchLeaseSqlTests(unittest.TestCase):
    def setUp(self):
        self.connection = LeaseSqlConnection()
        self.addCleanup(self.connection.close)
        self.store = store.DispatchStore(self.connection)

    def heartbeat(self, token="current", run_id=None):
        self.assertTrue(callable(getattr(self.store, "heartbeat_claim", None)), "Owned heartbeat is missing")
        return self.store.heartbeat_claim("work", token, 41, 0, 60, insurer_run_id=run_id)

    def test_owned_heartbeat_renews_and_attaches_only_matching_parent_run(self):
        self.assertTrue(self.heartbeat(run_id="run"))
        self.assertEqual(self.connection.database.execute(
            "SELECT lease_expires_at,started_at,covered_by_insurer_run_id FROM piles_auto_assignment_work_items"
        ).fetchone(), (1060, 1000, "run"))
        self.assertFalse(self.heartbeat(run_id="foreign"))

    def test_heartbeat_uses_fresh_clock_not_transaction_start_to_fence_expiry(self):
        self.connection.wall_time = 1121
        self.assertFalse(self.heartbeat())
        self.assertEqual(self.connection.database.execute(
            "SELECT lease_expires_at,heartbeat_at FROM piles_auto_assignment_work_items"
        ).fetchone(), (1120, None))

    def test_token_expiry_and_actual_session_locks_all_fence_heartbeat(self):
        self.assertFalse(self.heartbeat(token="stale"))
        for mutation in ("UPDATE pg_locks SET pid=42", "DELETE FROM pg_locks WHERE objid=11",
                         "DELETE FROM pg_locks WHERE objid=12", "UPDATE pg_locks SET granted=false",
                         "UPDATE pg_locks SET database=2", "UPDATE pg_locks SET objsubid=2",
                         "UPDATE piles_auto_assignment_work_items SET lease_expires_at=1000"):
            with self.subTest(mutation=mutation):
                self.connection.database.execute("SAVEPOINT fixture")
                self.connection.database.execute(mutation)
                self.assertFalse(self.heartbeat())
                # heartbeat commits its transaction; restore the controlled fixture.
                self.connection.close()
                self.connection = LeaseSqlConnection()
                self.addCleanup(self.connection.close)
                self.store = store.DispatchStore(self.connection)

    def test_contention_release_keeps_recoverable_row_and_stale_token_cannot_release(self):
        self.assertTrue(callable(getattr(self.store, "release_claim", None)), "Claim release is missing")
        self.assertFalse(self.store.release_claim("work", "stale", "worker_capacity_unavailable"))
        self.assertTrue(self.store.release_claim("work", "current", "worker_capacity_unavailable"))
        self.assertEqual(self.connection.database.execute(
            "SELECT disposition,lease_expires_at,finished_at FROM piles_auto_assignment_work_items"
        ).fetchone(), ("claimed", 1000, None))

    def test_started_work_is_not_requeued_after_possible_portal_side_effects(self):
        self.assertTrue(callable(getattr(self.store, "release_claim", None)), "Claim release is missing")
        self.connection.database.execute("UPDATE piles_auto_assignment_work_items SET started_at=950")
        self.connection.commit()
        self.assertFalse(self.store.release_claim("work", "current", "insurer_lock_unavailable"))

    def test_shutdown_release_is_token_fenced_and_never_finalizes_work(self):
        try:
            self.assertFalse(self.store.release_claim("work", "stale", "dispatch_stopped"))
            self.assertTrue(self.store.release_claim("work", "current", "dispatch_stopped"))
        except ValueError:
            self.fail("A never-started shutdown claim must be recoverably releasable")
        self.assertEqual(self.connection.database.execute(
            "SELECT disposition,lease_expires_at,finished_at,reason_code FROM piles_auto_assignment_work_items"
        ).fetchone(), ("claimed", 1000, None, "dispatch_stopped"))

    def test_shutdown_cannot_release_started_work(self):
        self.connection.database.execute("UPDATE piles_auto_assignment_work_items SET started_at=950")
        self.connection.commit()
        try:
            self.assertFalse(self.store.release_claim("work", "current", "dispatch_stopped"))
        except ValueError:
            self.fail("Shutdown release must use the same started-work ownership guard")

    def test_expired_or_replaced_token_cannot_finalize_work(self):
        self.assertFalse(self.store.finish_claim("work", "stale", WorkDisposition.COMPLETED))
        self.connection.database.execute("UPDATE piles_auto_assignment_work_items SET lease_expires_at=1000")
        self.connection.commit()
        self.assertFalse(self.store.finish_claim("work", "current", WorkDisposition.COMPLETED))
        self.assertEqual(self.connection.database.execute(
            "SELECT disposition FROM piles_auto_assignment_work_items"
        ).fetchone(), ("claimed",))

    def test_finish_does_not_accept_a_lease_live_only_at_transaction_start(self):
        self.connection.wall_time = 1121
        self.assertFalse(self.store.finish_claim("work", "current", WorkDisposition.COMPLETED))
        self.assertEqual(self.connection.database.execute(
            "SELECT disposition,finished_at FROM piles_auto_assignment_work_items"
        ).fetchone(), ("claimed", None))

    def test_renew_does_not_resurrect_a_lease_live_only_at_transaction_start(self):
        self.connection.wall_time = 1121
        self.assertFalse(self.store.renew_claim("work", "current"))
        self.assertEqual(self.connection.database.execute(
            "SELECT lease_expires_at,heartbeat_at FROM piles_auto_assignment_work_items"
        ).fetchone(), (1120, None))

    def test_release_does_not_mutate_a_claim_expired_since_transaction_start(self):
        self.connection.wall_time = 1121
        self.assertFalse(self.store.release_claim("work", "current", "dispatch_stopped"))
        self.assertEqual(self.connection.database.execute(
            "SELECT lease_expires_at,reason_code FROM piles_auto_assignment_work_items"
        ).fetchone(), (1120, None))

    def test_summary_exposes_submitted_and_manual_action_before_success_aggregation(self):
        self.connection.database.executescript("""
            CREATE TABLE piles_auto_assignment_attempts(insurer_run_id TEXT, status TEXT);
            INSERT INTO piles_auto_assignment_attempts VALUES
                ('run','submitted'),('run','manual_action_required'),('run','confirmed_visible');
        """)
        summary = ExecutionLedger(self.connection).summarize_insurer_run("run")
        self.assertEqual(summary.get("submitted"), 1)
        self.assertEqual(summary.get("manual_action_required"), 1)

    def test_parent_generation_uses_immutable_created_time(self):
        self.assertTrue(callable(getattr(self.store, "parent_requested_at", None)), "Parent timestamp reader is missing")
        connection = DispatchConnection([{"created_at": NOW}])
        self.assertEqual(store.DispatchStore(connection).parent_requested_at("parent"), NOW)

    def test_setup_failure_cannot_finalize_a_parent_with_prior_owned_or_reused_work(self):
        self.assertTrue(callable(getattr(self.store, "fail_parent_setup", None)), "Setup failure transition is missing")
        self.connection.database.executescript("""
            CREATE TABLE piles_auto_assignment_runner_runs(id TEXT, status TEXT, finished_at INTEGER,
                updated_at INTEGER, details TEXT);
            INSERT INTO piles_auto_assignment_runner_runs VALUES
                ('parent','started',NULL,NULL,'{}'),('empty','started',NULL,NULL,'{}'),
                ('reused','started',NULL,NULL,'{"dispatch_requests":[{"work_item_id":"foreign"}]}');
        """)
        self.assertFalse(self.store.fail_parent_setup("parent"))
        self.assertFalse(self.store.fail_parent_setup("reused"))
        self.assertTrue(self.store.fail_parent_setup("empty"))
        self.assertEqual(self.connection.database.execute(
            "SELECT status,finished_at FROM piles_auto_assignment_runner_runs WHERE id='empty'"
        ).fetchone(), ("failed", 1000))


class DispatchStoreTests(unittest.TestCase):
    def make_store(self, *responses):
        self.connection = DispatchConnection(*responses)
        self.store = store.DispatchStore(self.connection)
        return self.store

    def request(self, source=WorkSource.SCHEDULE, **kwargs):
        return WorkRequest("UAPOM", source, NOW, **kwargs)

    def enqueue_store(self, coverage=(), master=({"is_active": True},), inserted=True):
        responses = [[{"status": "started"}], [], list(master), list(coverage)]
        if inserted:
            responses.append(lambda _sql, params: [{"id": params[0]}])
        responses.append([])  # request visibility on the requesting parent
        return self.make_store(*responses)

    def test_idle_enqueue_persists_canonical_source_scope_and_aware_generation(self):
        decision = self.enqueue_store().enqueue_parent_work("parent-1", [self.request()])[0]
        self.assertEqual(decision.disposition, WorkDisposition.QUEUED)
        self.assertTrue(decision.create_work_item)
        sql, params = self.connection.statements[-2]
        self.assertIn("INSERT INTO piles_auto_assignment_work_items", sql)
        self.assertIn("now()", sql)
        self.assertEqual(params[1:10], ("parent-1", "UAPOM", "OLD MUTUAL", "schedule", "all_active", "production", '["All"]', "All", "queued"))
        self.assertIn(NOW, params)
        self.assertEqual(self.connection.commit_count, 1)
        self.assertEqual(self.connection.rollback_count, 0)
        self.assertIn("pg_advisory_xact_lock", self.connection.statements[1][0])

    def test_queued_all_active_is_covered_and_never_followed_up(self):
        decision = self.enqueue_store([work_row(disposition="queued")]).enqueue_parent_work("parent-2", [self.request()])[0]
        self.assertEqual(decision.disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
        self.assertEqual(self.connection.statements[-2][1][9], "covered_by_active_cycle")
        self.assertIn("canonical_insurer_name = %s", self.connection.statements[3][0])
        self.assertEqual(self.connection.statements[3][1], (
            "OLD MUTUAL", "OLD MUTUAL", NOW, "production", "All", '["All"]', "OLD MUTUAL",
        ))

    def test_manual_request_reuses_queued_generation_without_reparenting(self):
        decision = self.enqueue_store([work_row(disposition="queued", source="manual", request_scope="single_insurer")], inserted=False).enqueue_parent_work("parent-2", [self.request(WorkSource.MANUAL)])[0]
        self.assertEqual(decision.disposition, WorkDisposition.QUEUED)
        self.assertFalse(decision.create_work_item)
        self.assertFalse(any("INSERT INTO piles_auto_assignment_work_items" in sql for sql, _ in self.connection.statements))
        sql, params = self.connection.statements[-1]
        self.assertIn("details", sql)
        references = json.loads(params[0])
        self.assertEqual(references[0]["work_item_id"], "work-1")
        self.assertEqual(params[-1], "parent-2")

    def test_manual_follow_up_is_created_once_and_reused(self):
        active = work_row()
        decision = self.enqueue_store([active]).enqueue_parent_work("parent-2", [self.request(WorkSource.MANUAL)])[0]
        self.assertEqual(decision.disposition, WorkDisposition.FOLLOW_UP_QUEUED)
        follow_up = work_row(id="follow-up", disposition="follow_up_queued")
        decision = self.enqueue_store([active, follow_up], inserted=False).enqueue_parent_work("parent-3", [self.request(WorkSource.MANUAL)])[0]
        self.assertFalse(decision.create_work_item)
        self.assertEqual(json.loads(self.connection.statements[-1][1][0])[0]["work_item_id"], "follow-up")

    def test_explicit_inactive_configuration_is_terminal(self):
        decision = self.enqueue_store(master=[{"is_active": False}]).enqueue_parent_work("parent-1", [self.request()])[0]
        self.assertEqual(decision.disposition, WorkDisposition.INACTIVE)
        self.assertIn("finished_at", self.connection.statements[-2][0])

    def test_readiness_source_cannot_enqueue_execute_work(self):
        self.make_store()
        with self.assertRaises(ValueError):
            self.store.enqueue_parent_work("parent-1", [self.request(WorkSource.READINESS)])
        self.assertEqual(self.connection.statements, [])

    def test_enqueue_rolls_back_whole_parent_on_failure(self):
        self.make_store([{"status": "started"}], [], [{"is_active": True}], [], RuntimeError("insert failed"))
        with self.assertRaisesRegex(RuntimeError, "insert failed"):
            self.store.enqueue_parent_work("parent-1", [self.request()])
        self.assertEqual((self.connection.commit_count, self.connection.rollback_count), (0, 1))

    def claim_store(self, row=None):
        # First serialize canonical scheduling decisions; then one atomic claim.
        return self.make_store([{"canonical_insurer_name": "OLD MUTUAL", "locked": True}], [row] if row else [])

    def test_claim_is_atomic_parent_owned_and_uses_database_time(self):
        claimed = self.claim_store(work_row()).claim_next("parent-1", "worker-1")
        self.assertEqual((claimed.id, claimed.parent_runner_run_id, claimed.claim_token), ("work-1", "parent-1", "token-1"))
        self.assertEqual(claimed.lease_expires_at.tzinfo, timezone.utc)
        sql, params = self.connection.statements[-1]
        self.assertIn("WITH", sql)
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertIn("UPDATE piles_auto_assignment_work_items", sql)
        self.assertIn("parent_runner_run_id = %s", sql)
        self.assertIn("NOT EXISTS", sql)
        self.assertIn("attempt_number + 1", sql)
        self.assertIn("now()", sql)
        self.assertIn("parent-1", params)
        self.assertIn("worker-1", params)
        self.assertIn(120, params)
        self.assertEqual(self.connection.commit_count, 1)

    def test_claim_returns_none_without_available_owned_work(self):
        self.assertIsNone(self.claim_store().claim_next("parent-1", "worker-1"))
        self.assertEqual(self.connection.commit_count, 1)

    def test_claim_rolls_back_on_database_error(self):
        self.make_store([{"canonical_insurer_name": "OLD MUTUAL", "locked": True}], RuntimeError("claim failed"))
        with self.assertRaisesRegex(RuntimeError, "claim failed"):
            self.store.claim_next("parent-1", "worker-1")
        self.assertEqual((self.connection.commit_count, self.connection.rollback_count), (0, 1))

    def test_renew_and_finish_are_token_fenced(self):
        self.make_store(*([[{"id": "work-1"}]] * 4))
        self.assertTrue(self.store.renew_claim("work-1", "token-1", 30))
        self.assertTrue(self.store.finish_claim("work-1", "token-1", WorkDisposition.COMPLETED, "insurer-run-1"))
        for sql, params in self.connection.statements:
            self.assertIn("claim_token = %s", sql)
            self.assertIn("disposition = 'claimed'", sql)
            self.assertIn("token-1", params)
        self.assertIn("lease_expires_at > clock_timestamp()", self.connection.statements[1][0])
        self.assertIn("finished_at = clock_timestamp()", self.connection.statements[3][0])
        self.assertIn("insurer-run-1", self.connection.statements[3][1])
        self.assertIn(None, self.connection.statements[3][1])  # empty reason is SQL NULL
        self.assertEqual(self.connection.commit_count, 2)

    def test_stale_token_cannot_renew_or_finish(self):
        self.make_store([], [])
        self.assertFalse(self.store.renew_claim("work-1", "old-token"))
        self.assertFalse(self.store.finish_claim("work-1", "old-token", WorkDisposition.FAILED))
        self.assertEqual(self.connection.commit_count, 2)

    def test_finish_rejects_nonterminal_or_unsanitized_reason_before_sql(self):
        for disposition, reason in [(WorkDisposition.QUEUED, ""), (WorkDisposition.CLAIMED, ""), (WorkDisposition.COMPLETED, "patient@example.com"), (WorkDisposition.FAILED, "x" * 81)]:
            with self.subTest(disposition=disposition, reason=reason):
                self.make_store()
                with self.assertRaises(ValueError):
                    self.store.finish_claim("work-1", "token-1", disposition, reason_code=reason)
                self.assertEqual(self.connection.statements, [])

    def test_lease_must_be_a_positive_integer(self):
        for seconds in [0, -1, 1.5, True]:
            self.make_store()
            with self.assertRaises(ValueError):
                self.store.renew_claim("work-1", "token-1", seconds)
            self.assertEqual(self.connection.statements, [])

    def test_expired_recovery_requires_free_canonical_insurer_lock(self):
        self.make_store([work_row()], [{"locked": False}])
        self.assertEqual(self.store.recoverable_expired_work(), [])
        self.assertIn("lease_expires_at <= now()", self.connection.statements[0][0])
        self.assertIn("pg_try_advisory_xact_lock", self.connection.statements[1][0])
        self.assertEqual(self.connection.statements[1][1], ("piles-insurer:OLD MUTUAL",))
        self.assertFalse(any("UPDATE" in sql for sql, _ in self.connection.statements))
        self.assertEqual(self.connection.commit_count, 1)

    def test_free_lock_allows_inspection_but_claim_rechecks_it(self):
        self.make_store([work_row()], [{"locked": True}])
        self.assertEqual(self.store.recoverable_expired_work()[0].claim_token, "token-1")
        reclaimed = self.claim_store(work_row(claim_token="token-2", attempt_number=2)).claim_next("parent-1", "worker-2")
        self.assertEqual(reclaimed.claim_token, "token-2")
        sql, _ = self.connection.statements[-1]
        self.assertIn("lease_expires_at <= now()", sql)
        self.assertIn("pg_try_advisory_xact_lock", sql)
        self.assertIn("claim_token IS NOT DISTINCT FROM candidate.claim_token", sql)

    def test_finalize_only_aggregates_owned_work_and_owned_insurer_runs(self):
        self.make_store([{"status": "started"}], [{"disposition": "completed", "insurer_status": "completed"}, {"disposition": "failed", "insurer_status": "failed"}], [{"id": "parent-1"}])
        self.assertEqual(self.store.finalize_parent("parent-1"), ParentRunStatus.COMPLETED_WITH_ISSUES)
        sql, params = self.connection.statements[1]
        self.assertIn("work.parent_runner_run_id = %s", sql)
        self.assertIn("run.runner_run_id = work.parent_runner_run_id", sql)
        self.assertEqual(params, ("parent-1",))
        self.assertIn("completed_with_issues", self.connection.statements[2][1])
        self.assertEqual(self.connection.commit_count, 1)

    def test_finalize_does_not_count_external_covered_run_as_owned_success(self):
        self.make_store([{"status": "started"}], [{"disposition": "covered_by_active_cycle", "insurer_status": None}, {"disposition": "failed", "insurer_status": "failed"}], [{"id": "parent-1"}])
        self.assertEqual(self.store.finalize_parent("parent-1"), ParentRunStatus.FAILED)

    def test_finalize_refuses_every_nonterminal_state_and_rolls_back(self):
        for disposition, insurer_status in [("queued", None), ("claimed", None), ("follow_up_queued", None), ("completed", "running")]:
            self.make_store([{"status": "started"}], [{"disposition": disposition, "insurer_status": insurer_status}])
            with self.assertRaises(ValueError):
                self.store.finalize_parent("parent-1")
            self.assertFalse(any("UPDATE" in sql and "FOR UPDATE" not in sql for sql, _ in self.connection.statements))
            self.assertEqual((self.connection.commit_count, self.connection.rollback_count), (0, 1))

    def test_store_connection_is_separate_from_ledger_and_is_closed(self):
        ledger_connection = RecordingConnection()
        ledger = ExecutionLedger(ledger_connection)
        self.make_store([{"id": "work-1"}], [{"id": "work-1"}])
        self.store.renew_claim("work-1", "token-1")
        self.store.close()
        self.assertTrue(self.connection.closed)
        self.assertEqual(ledger.connection.statements, [])

    def test_readonly_ledger_exposes_no_dispatch_mutations(self):
        ledger = ReadOnlyExecutionLedger()
        for method in ("enqueue_parent_work", "claim_next", "renew_claim", "finish_claim"):
            self.assertFalse(hasattr(ledger, method))
        self.assertEqual(ledger.write_count, 0)

    def test_parent_reference_contains_only_opaque_ids_and_safe_disposition(self):
        self.enqueue_store().enqueue_parent_work("parent-1", [self.request()])
        reference = json.loads(self.connection.statements[-1][1][0])[0]
        self.assertEqual(set(reference), {"request_id", "work_item_id", "disposition"})

    def test_retry_reuses_persisted_request_reference_without_new_work(self):
        first = self.enqueue_store().enqueue_parent_work("parent-1", [self.request()])[0]
        references = json.loads(self.connection.statements[-1][1][0])
        self.make_store([{"status": "started", "details": {"dispatch_requests": references}}], [], [])
        retry = self.store.enqueue_parent_work("parent-1", [self.request()])[0]
        self.assertEqual(retry.disposition, first.disposition)
        self.assertFalse(retry.create_work_item)
        self.assertFalse(any("INSERT" in sql for sql, _ in self.connection.statements))
        self.assertEqual(json.loads(self.connection.statements[-1][1][0]), references)

    def test_enqueue_references_are_bounded_before_writes(self):
        self.make_store()
        with self.assertRaises(ValueError):
            self.store.enqueue_parent_work("parent-1", [self.request()] * 257)
        self.assertEqual(self.connection.statements, [])

    def test_zero_owned_work_parent_waits_for_reused_generation(self):
        references = [{"request_id": "request-1", "work_item_id": "foreign-work", "disposition": "follow_up_queued"}]
        self.make_store([{"status": "started", "details": {"dispatch_requests": references}}], [], [{"id": "foreign-work", "disposition": "follow_up_queued"}])
        with self.assertRaises(ValueError):
            self.store.finalize_parent("parent-2")
        self.assertEqual(self.connection.rollback_count, 1)

    def test_resolved_reused_generation_is_acknowledged_not_owned_success(self):
        references = [{"request_id": "request-1", "work_item_id": "foreign-work", "disposition": "queued"}]
        self.make_store([{"status": "started", "details": {"dispatch_requests": references}}], [], [{"id": "foreign-work", "disposition": "failed"}], [{"id": "parent-2"}])
        self.assertEqual(self.store.finalize_parent("parent-2"), ParentRunStatus.COVERED_BY_ACTIVE_CYCLE)
        # Two parents may reference each other's completed generations. Taking
        # foreign row locks after owned row locks would create a lock cycle.
        self.assertNotIn("FOR UPDATE", self.connection.statements[2][0])

    def test_missing_reused_generation_fails_closed(self):
        references = [{"request_id": "request-1", "work_item_id": "missing-work", "disposition": "queued"}]
        self.make_store([{"status": "started", "details": {"dispatch_requests": references}}], [], [])
        with self.assertRaises(ValueError):
            self.store.finalize_parent("parent-2")
        self.assertEqual(self.connection.rollback_count, 1)

    def test_claim_skips_held_insurer_before_limiting_candidate(self):
        self.claim_store().claim_next("parent-1", "worker-1")
        sql = self.connection.statements[-1][0]
        self.assertLess(sql.index("pg_try_advisory_xact_lock"), sql.index("LIMIT 1"))

    def test_database_timestamp_hydration_rejects_naive_lease(self):
        self.claim_store(work_row(lease_expires_at=NOW.replace(tzinfo=None)))
        with self.assertRaises(ValueError):
            self.store.claim_next("parent-1", "worker-1")
        self.assertEqual(self.connection.rollback_count, 1)

    def test_renew_finish_and_recovery_errors_roll_back(self):
        operations = [lambda: self.store.renew_claim("w", "t"), lambda: self.store.finish_claim("w", "t", WorkDisposition.FAILED), lambda: self.store.recoverable_expired_work()]
        for operation in operations:
            self.make_store(RuntimeError("database failure"))
            with self.assertRaises(RuntimeError):
                operation()
            self.assertEqual((self.connection.commit_count, self.connection.rollback_count), (0, 1))

    def test_active_legacy_run_can_cover_schedule_without_v2_work(self):
        active = work_row(disposition="running", covered_by_insurer_run_id="legacy-run")
        decision = self.enqueue_store([active]).enqueue_parent_work("parent-2", [self.request()])[0]
        self.assertEqual(decision.disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
        self.assertEqual(decision.covered_by_insurer_run_id, "legacy-run")
        sql = self.connection.statements[3][0]
        self.assertIn("piles_auto_assignment_insurer_runs", sql)
        self.assertIn("run_scope", sql)

    def test_terminal_parent_cannot_be_reopened_by_enqueue(self):
        self.make_store([{"status": "completed"}])
        with self.assertRaises(ValueError):
            self.store.enqueue_parent_work("parent-1", [self.request()])
        self.assertEqual(self.connection.rollback_count, 1)

    def test_unknown_configuration_is_not_reported_as_inactive_success(self):
        self.make_store([{"status": "started"}], [], [])
        with self.assertRaises(ValueError):
            self.store.enqueue_parent_work("parent-1", [self.request()])
        self.assertEqual(self.connection.rollback_count, 1)

    def test_partial_retry_preserves_existing_parent_references(self):
        old_reference = {"request_id": "previous-request", "work_item_id": "previous-work", "disposition": "queued"}
        self.make_store([{"status": "started", "details": {"dispatch_requests": [old_reference]}}], [], [{"is_active": True}], [], [{"id": "new-work"}], [])
        self.store.enqueue_parent_work("parent-1", [self.request()])
        references = json.loads(self.connection.statements[-1][1][0])
        self.assertEqual(len(references), 2)
        self.assertEqual(references[0], old_reference)

    def test_persisted_reference_validation_rejects_unbounded_or_unsafe_data(self):
        for reference in [{"request_id": "r", "work_item_id": "patient@example.com", "disposition": "queued"}, {"request_id": "r", "work_item_id": "w", "disposition": "queued", "error": "raw portal text"}]:
            self.make_store([{"status": "started", "details": {"dispatch_requests": [reference]}}])
            with self.assertRaises(ValueError):
                self.store.finalize_parent("parent-1")
            self.assertEqual(self.connection.rollback_count, 1)

    def test_empty_enqueue_keeps_valid_empty_reference_array(self):
        self.make_store([{"status": "started"}], [])
        self.assertEqual(self.store.enqueue_parent_work("parent-1", []), [])
        self.assertEqual(json.loads(self.connection.statements[-1][1][0]), [])

    def test_finalization_retry_preserves_terminal_status_and_finish_time(self):
        self.make_store([{"status": "completed_with_issues", "details": {}}])
        self.assertEqual(self.store.finalize_parent("parent-1"), ParentRunStatus.COMPLETED_WITH_ISSUES)
        self.assertEqual(len(self.connection.statements), 1)
        self.assertEqual(self.connection.commit_count, 1)


class ExecutionLedgerTests(unittest.TestCase):
    def setUp(self):
        self.connection = RecordingConnection()
        self.ledger = ExecutionLedger(self.connection)

    def test_insurer_lock_uses_runner_canonical_alias(self):
        self.assertTrue(self.ledger.try_acquire_insurer_lock("UAPOM"))
        _sql, params = self.connection.statements[-1]
        self.assertEqual(params, ("piles-insurer:OLD MUTUAL",))

    def test_transition_uses_compare_and_set(self):
        self.ledger.transition_attempt(
            "attempt-1",
            AttemptStatus.SUBMITTED,
            expected={AttemptStatus.SELECTED},
        )
        sql, params = self.connection.statements[-2]
        self.assertIn("status = ANY", sql)
        self.assertEqual(params[-1], "attempt-1")
        self.assertIn("confirmed_pile_count", self.connection.statements[-1][0])
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
        batch_params = self.connection.statements[0][1]
        self.assertEqual(batch_params[-2], 1)

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

    def test_pending_attempts_include_crash_window_states(self):
        self.ledger.pending_attempts("Jubilee Uganda")
        sql, params = self.connection.statements[-1]
        self.assertIn("'selected','submitted','reconciliation_pending'", sql)
        self.assertEqual(params, ("Jubilee Uganda",))

    def test_retryable_attempts_are_bounded_by_attempt_number(self):
        self.ledger.retryable_attempts("Jubilee Uganda", max_attempts=2)
        sql, params = self.connection.statements[-1]
        self.assertIn("status = 'still_unassigned'", sql)
        self.assertIn("attempt_number < %s", sql)
        self.assertEqual(params, ("Jubilee Uganda", 2))

    def test_exhausted_and_unsubmitted_attempts_are_queryable_for_safe_cleanup(self):
        self.ledger.exhausted_attempts("Jubilee Uganda", max_attempts=2)
        exhausted_sql, _params = self.connection.statements[-1]
        self.assertIn("attempt_number >= %s", exhausted_sql)
        self.ledger.unsubmitted_plans("Jubilee Uganda")
        planned_sql, _params = self.connection.statements[-1]
        self.assertIn("status = 'planned'", planned_sql)


if __name__ == "__main__":
    unittest.main()
