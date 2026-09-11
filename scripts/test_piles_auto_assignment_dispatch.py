"""Worker boundary tests: real threads/output, no database or portal calls."""

import io
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from unittest.mock import patch

try:
    from piles_auto_assignment import dispatch
    from piles_auto_assignment.domain import InsurerRunStatus, ParentRunStatus, WorkDisposition
    from piles_auto_assignment.orchestrator import derive_parent_status
    from piles_auto_assignment.store import ClaimedWork
except ModuleNotFoundError:
    from scripts.piles_auto_assignment import dispatch
    from scripts.piles_auto_assignment.domain import InsurerRunStatus, ParentRunStatus, WorkDisposition
    from scripts.piles_auto_assignment.orchestrator import derive_parent_status
    from scripts.piles_auto_assignment.store import ClaimedWork


def claimed(insurer="Jubilee Kenya"):
    now = datetime(2026, 9, 10, tzinfo=timezone.utc)
    return ClaimedWork(
        id=insurer, parent_runner_run_id="parent", insurer_name=insurer,
        canonical_insurer_name=insurer.lower(), source="schedule",
        request_scope="all_active", disposition="claimed", claim_token="opaque",
        worker_id=insurer, attempt_number=1, generation_requested_at=now,
        requested_at=now, lease_expires_at=now, heartbeat_at=now, claimed_at=now,
    )


class Resource:
    def __init__(self, *, slot=0, acquired=True, failure=None):
        self.connection = object()
        self.slot = slot
        self.acquired = acquired
        self.failure = failure
        self.events = []

    def try_acquire_runner_slot(self, limit):
        self.events.append(("slot", limit))
        return self.slot

    def try_acquire_insurer_lock(self, name):
        self.events.append(("lock", name))
        if self.failure == "acquire":
            raise RuntimeError("credential=private")
        return self.acquired

    def release_insurer_lock(self, name):
        self.events.append(("unlock", name))
        if self.failure == "unlock":
            raise RuntimeError("<html>private</html>")

    def release_runner_slot(self, slot):
        self.events.append(("release", slot))

    def close(self):
        self.events.append("close")


class DispatchState:
    """Atomic queue/lock boundary; the real dispatcher controls every execution."""

    def __init__(self, names=("Kenya", "Uganda")):
        self.mutex = threading.RLock()
        self.rows = {str(i): replace(claimed(name), id=str(i), disposition="queued")
                     for i, name in enumerate(names)}
        self.insurer_locks, self.slots = {}, {}
        self.events, self.contexts = [], []
        self.claim_attempts = 0
        self.contention = 0
        self.references = []
        self.insurer_statuses = {}

    def store(self):
        state = self
        class Store:
            def claim_next(self, parent_id, worker_id, lease_seconds=120):
                with state.mutex:
                    for key, row in state.rows.items():
                        if row.parent_runner_run_id != parent_id or row.disposition != WorkDisposition.QUEUED:
                            continue
                        if any(other.disposition == WorkDisposition.CLAIMED and other.canonical_insurer_name == row.canonical_insurer_name for other in state.rows.values()):
                            continue
                        state.claim_attempts += 1
                        row = replace(row, disposition="claimed", worker_id=worker_id,
                                      claim_token=f"token-{state.claim_attempts}")
                        state.rows[key] = row
                        state.events.append(("claim", row.id, threading.get_ident()))
                        return row
                return None

            def heartbeat_claim(self, work_id, token, owner_pid, slot, lease_seconds=120, insurer_run_id=None):
                with state.mutex:
                    row = state.rows[work_id]
                    valid = (row.claim_token == token and row.disposition == WorkDisposition.CLAIMED
                             and state.insurer_locks.get(row.canonical_insurer_name) == owner_pid
                             and state.slots.get(slot) == owner_pid)
                    state.events.append(("heartbeat", work_id, valid))
                    if valid and insurer_run_id:
                        state.rows[work_id] = replace(row, covered_by_insurer_run_id=insurer_run_id)
                    return valid

            def finish_claim(self, work_id, token, disposition, insurer_run_id=None, reason_code=""):
                with state.mutex:
                    row = state.rows[work_id]
                    if row.claim_token != token or row.disposition != WorkDisposition.CLAIMED:
                        return False
                    state.rows[work_id] = replace(row, disposition=disposition,
                        covered_by_insurer_run_id=insurer_run_id or "", reason_code=reason_code)
                    state.events.append(("finish", work_id, str(disposition)))
                    return True

            def release_claim(self, work_id, token, reason_code):
                with state.mutex:
                    row = state.rows[work_id]
                    if row.claim_token != token or row.disposition != WorkDisposition.CLAIMED:
                        return False
                    state.rows[work_id] = replace(row, disposition="queued")
                    state.events.append(("release_claim", work_id, reason_code))
                    return True

            def finalize_parent(self, parent_id):
                with state.mutex:
                    owned = [row.disposition for row in state.rows.values() if row.parent_runner_run_id == parent_id]
                    if any(value in {"queued", "claimed", "follow_up_queued"} for value in owned + state.references):
                        raise dispatch.ParentWorkPending("Owned or referenced work is nonterminal")
                    insurer_statuses = [state.insurer_statuses[row.covered_by_insurer_run_id]
                        for row in state.rows.values() if row.parent_runner_run_id == parent_id
                        and row.covered_by_insurer_run_id in state.insurer_statuses]
                    status = derive_parent_status(owned or (["covered_by_active_cycle"] if state.references else []), insurer_statuses)
                    state.events.append(("parent", status, threading.get_ident()))
                    return status

            def notification_collection_complete(self, parent_id, work_ids, _fingerprints=()):
                with state.mutex:
                    expected = {row.id for row in state.rows.values()
                                if row.parent_runner_run_id == parent_id
                                and row.disposition not in {WorkDisposition.INACTIVE, WorkDisposition.COVERED_BY_ACTIVE_CYCLE}}
                    return len(work_ids) == len(set(work_ids)) and set(work_ids) == expected
        return Store()

    @contextmanager
    def context(self, work):
        state = self
        owner = object()
        class Locks(Resource):
            conn = type("Connection", (), {"get_backend_pid": lambda _self: owner})()
            def try_acquire_runner_slot(self, limit):
                with state.mutex:
                    if state.contention:
                        state.contention -= 1
                        return -1
                    for slot in range(limit):
                        if slot not in state.slots:
                            state.slots[slot] = owner
                            return slot
                return -1
            def try_acquire_insurer_lock(self, name):
                with state.mutex:
                    key = work.canonical_insurer_name
                    if key in state.insurer_locks:
                        return False
                    state.insurer_locks[key] = owner
                    return True
            def release_insurer_lock(self, name):
                with state.mutex:
                    if state.insurer_locks.get(work.canonical_insurer_name) == owner:
                        del state.insurer_locks[work.canonical_insurer_name]
            def release_runner_slot(self, slot):
                with state.mutex:
                    if state.slots.get(slot) == owner:
                        del state.slots[slot]
        self.assert_router = isinstance(sys.stdout, dispatch.ContextOutputRouter)
        with sys.stdout.bind(work.insurer_name) as output:
            context = dispatch.WorkerContext(Locks(), Resource(), output, work.worker_id,
                                             max_concurrency=2, dispatch_store=self.store())
            self.contexts.append(context)
            try:
                yield context
            finally:
                context.store.close()
                context.ledger.close()
                output.close()


class BoundedDispatcherTests(unittest.TestCase):
    def run_dispatch(self, state, run_one, *, maximum=2, stop_event=None):
        self.assertTrue(callable(getattr(dispatch, "dispatch_parent", None)), "dispatch_parent is missing")
        return dispatch.dispatch_parent("parent", tuple(state.rows.values()), maximum, state.context,
                                        run_one, store=state.store(), poll_interval=0.001,
                                        stop_event=stop_event)

    def test_two_distinct_insurers_overlap_and_results_keep_configured_order(self):
        state = DispatchState()
        barrier = threading.Barrier(2)
        second_finished = threading.Event()
        calls = []
        def run_one(work, context):
            calls.append(work.id)
            barrier.wait(timeout=3)
            if work.insurer_name == "Kenya":
                self.assertTrue(second_finished.wait(3))
            else:
                second_finished.set()
            print(work.insurer_name)
            return {"notification_items": [work.insurer_name]}
        result = self.run_dispatch(state, run_one)
        self.assertEqual(sorted(calls), ["0", "1"])
        self.assertEqual([outcome.insurer_name for outcome in result.outcomes], ["Kenya", "Uganda"])
        self.assertEqual(result.notification_items, ("Kenya", "Uganda"))
        self.assertEqual(result.status, ParentRunStatus.COMPLETED)
        self.assertTrue(state.assert_router)
        self.assertEqual(state.events[-1][0], "parent")
        self.assertEqual(state.events[-1][2], threading.get_ident())
        for field in ("store", "ledger", "dispatch_store", "output"):
            self.assertIsNot(getattr(state.contexts[0], field), getattr(state.contexts[1], field))

    def test_one_worker_serializes_and_never_repeats_an_assignment(self):
        state, active, calls = DispatchState(), [], []
        def run_one(work, context):
            self.assertEqual(active, [])
            active.append(work.id)
            calls.append(work.id)
            context.ownership.check()
            active.remove(work.id)
            return {}
        result = self.run_dispatch(state, run_one, maximum=1)
        self.assertEqual(calls, ["0", "1"])
        self.assertEqual(result.status, ParentRunStatus.COMPLETED)

    def test_same_canonical_insurer_never_overlaps(self):
        state = DispatchState(("UAPOM", "OLD MUTUAL", "Kenya"))
        state.rows["0"] = replace(state.rows["0"], canonical_insurer_name="OLD MUTUAL")
        state.rows["1"] = replace(state.rows["1"], canonical_insurer_name="OLD MUTUAL")
        active, calls = set(), []
        different_insurer_overlap = threading.Barrier(2)
        def run_one(work, _context):
            with state.mutex:
                self.assertNotIn(work.canonical_insurer_name, active)
                active.add(work.canonical_insurer_name)
                calls.append(work.id)
            if work.id in {"0", "2"}:
                different_insurer_overlap.wait(timeout=3)
            with state.mutex:
                active.remove(work.canonical_insurer_name)
            return {}
        self.run_dispatch(state, run_one)
        self.assertCountEqual(calls, ["0", "1", "2"])

    def test_insurer_lock_contention_reclaims_without_double_portal_entry(self):
        state, calls = DispatchState(("Kenya",)), []
        state.insurer_locks["kenya"] = "foreign"
        coordinator = state.store()
        release = coordinator.release_claim
        def unlock_after_contention(*args):
            released = release(*args)
            with state.mutex:
                state.insurer_locks.clear()
            return released
        coordinator.release_claim = unlock_after_contention
        self.assertTrue(callable(getattr(dispatch, "dispatch_parent", None)))
        result = dispatch.dispatch_parent("parent", tuple(state.rows.values()), 1, state.context,
            lambda work, context: calls.append(work.id) or {}, store=coordinator, poll_interval=0.001)
        self.assertEqual(calls, ["0"])
        self.assertEqual(state.claim_attempts, 2)
        self.assertEqual(result.status, ParentRunStatus.COMPLETED)

    def test_reused_foreign_generation_waits_then_acknowledges_without_owning_result(self):
        state = DispatchState(())
        state.references = ["claimed"]
        coordinator = state.store()
        finalize = coordinator.finalize_parent
        waits = []
        def resolve_after_first_check(parent):
            try:
                return finalize(parent)
            except dispatch.ParentWorkPending:
                waits.append("pending")
                state.references = ["failed"]
                raise
        coordinator.finalize_parent = resolve_after_first_check
        result = dispatch.dispatch_parent("parent", (), 1, state.context, lambda *_: self.fail("foreign work ran"),
                                          store=coordinator, poll_interval=0.001)
        self.assertEqual(waits, ["pending"])
        self.assertEqual(result.status, ParentRunStatus.COVERED_BY_ACTIVE_CYCLE)
        self.assertEqual(result.outcomes, ())

    def test_overlapping_requests_use_real_enqueue_coverage_and_execute_only_once(self):
        from scripts.test_piles_auto_assignment_store import EnqueueSqlConnection, NOW
        from scripts.piles_auto_assignment.store import DispatchStore
        from scripts.piles_auto_assignment.domain import WorkRequest
        connection = EnqueueSqlConnection()
        self.addCleanup(connection.close)
        connection.database.execute("INSERT INTO piles_auto_assignment_master_accounts VALUES ('OLD MUTUAL',true)")
        for parent in ("parent", "overlap-1", "overlap-2"):
            connection.database.execute("INSERT INTO piles_auto_assignment_runner_runs(id) VALUES (?)", (parent,))
        connection.commit()
        store = DispatchStore(connection)
        requests = [WorkRequest("UAPOM", "schedule", NOW)]
        decisions = [store.enqueue_parent_work(parent, requests)[0] for parent in ("parent", "overlap-1", "overlap-2")]
        self.assertEqual([decision.disposition.value for decision in decisions],
                         ["queued", "covered_by_active_cycle", "covered_by_active_cycle"])
        rows = connection.database.execute("SELECT id,parent_runner_run_id,disposition FROM piles_auto_assignment_work_items").fetchall()
        state, calls = DispatchState(()), []
        state.rows = {key: replace(claimed("UAPOM"), id=key, parent_runner_run_id=parent,
                                  canonical_insurer_name="OLD MUTUAL", disposition=disposition)
                      for key, parent, disposition in rows}
        for parent, decision in zip(("parent", "overlap-1", "overlap-2"), decisions):
            result = dispatch.dispatch_parent(parent, [decision], 2, state.context,
                lambda work, context: calls.append(work.id) or {}, store=state.store(), poll_interval=0.001)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result.status, ParentRunStatus.COVERED_BY_ACTIVE_CYCLE)

    def test_stop_after_current_worker_keeps_unclaimed_peer_recoverable(self):
        state, stopped, calls = DispatchState(), threading.Event(), []
        def run_one(work, context):
            calls.append(work.id)
            stopped.set()
            return {}
        result = self.run_dispatch(state, run_one, maximum=1, stop_event=stopped)
        self.assertEqual(calls, ["0"])
        self.assertEqual(state.rows["0"].disposition, WorkDisposition.COMPLETED)
        self.assertEqual(state.rows["1"].disposition, WorkDisposition.QUEUED)
        self.assertEqual(result.status, ParentRunStatus.RUNNING)

    def test_stop_after_last_worker_still_finalizes_terminal_parent(self):
        state, stopped = DispatchState(("Kenya",)), threading.Event()
        def run_one(work, context):
            stopped.set()
            return {}
        result = self.run_dispatch(state, run_one, maximum=1, stop_event=stopped)
        self.assertEqual(result.status, ParentRunStatus.COMPLETED)

    def test_capacity_contention_retries_claim_without_retrying_portal(self):
        state, calls = DispatchState(("Kenya",)), []
        state.contention = 1
        result = self.run_dispatch(state, lambda work, context: calls.append(work.id) or {})
        self.assertEqual(calls, ["0"])
        self.assertEqual(state.claim_attempts, 2)
        self.assertEqual(result.status, ParentRunStatus.COMPLETED)
        self.assertEqual([event for event in state.events if event[0] == "release_claim"],
                         [("release_claim", "0", "worker_capacity_unavailable")])

    def test_failed_future_does_not_cancel_peer_or_reexecute_it(self):
        state, calls = DispatchState(), []
        real_execute = dispatch.execute_claimed_insurer
        def execute(work, *args, **kwargs):
            if work.id == "0":
                raise TimeoutError("private external error")
            return real_execute(work, *args, **kwargs)
        with patch.object(dispatch, "execute_claimed_insurer", execute):
            result = self.run_dispatch(state, lambda work, context: calls.append(work.id) or {})
        self.assertEqual(calls, ["1"])
        self.assertEqual(result.status, ParentRunStatus.COMPLETED_WITH_ISSUES)
        self.assertEqual([o.status for o in result.outcomes], [InsurerRunStatus.FAILED, InsurerRunStatus.COMPLETED])
        self.assertNotIn("private", repr(result))

    def test_lost_token_or_lock_stops_next_assignment_and_cannot_finish(self):
        for lost in ("token", "insurer", "capacity"):
            with self.subTest(lost=lost):
                state, calls = DispatchState(("Kenya",)), []
                def run_one(work, context):
                    context.ownership.check()
                    calls.append("first")
                    with state.mutex:
                        if lost == "token":
                            state.rows[work.id] = replace(state.rows[work.id], claim_token="replacement")
                        elif lost == "insurer":
                            state.insurer_locks.clear()
                        else:
                            state.slots.clear()
                    context.ownership.check()
                    calls.append("second")
                result = self.run_dispatch(state, run_one)
                self.assertEqual(calls, ["first"])
                self.assertEqual(result.status, ParentRunStatus.RUNNING)
                self.assertFalse(any(e[0] in {"finish", "parent"} for e in state.events))

    def test_shutdown_does_not_claim_or_finalize_queued_work(self):
        state = DispatchState()
        stopped = threading.Event()
        stopped.set()
        result = self.run_dispatch(state, lambda *_: self.fail("portal must not run"), stop_event=stopped)
        self.assertEqual(result.status, ParentRunStatus.RUNNING)
        self.assertEqual(state.events, [])

    def test_stop_during_claim_releases_never_started_work_without_portal_entry(self):
        state, calls, stopped = DispatchState(("Kenya",)), [], threading.Event()
        coordinator = state.store()
        claim_next = coordinator.claim_next
        def interrupted_claim(*args):
            work = claim_next(*args)
            stopped.set()
            return work
        coordinator.claim_next = interrupted_claim
        result = dispatch.dispatch_parent("parent", tuple(state.rows.values()), 1, state.context,
            lambda work, context: calls.append(work.id), store=coordinator, stop_event=stopped, poll_interval=0.001)
        self.assertEqual(calls, [])
        self.assertEqual(state.contexts, [])
        self.assertEqual(result.outcomes, ())
        self.assertEqual(result.status, ParentRunStatus.RUNNING)
        self.assertEqual(state.rows["0"].disposition, WorkDisposition.QUEUED)
        self.assertIn(("release_claim", "0", "dispatch_stopped"), state.events)
        self.assertFalse(any(event[0] in {"finish", "parent"} for event in state.events))

        recovered = self.run_dispatch(state, lambda work, context: calls.append(work.id) or {})
        self.assertEqual(calls, ["0"])
        self.assertEqual(state.claim_attempts, 2)
        self.assertEqual(recovered.status, ParentRunStatus.COMPLETED)

    def test_stop_after_pool_submission_still_fences_portal_entry(self):
        state, calls, stopped = DispatchState(("Kenya",)), [], threading.Event()
        class StoppingPool(ThreadPoolExecutor):
            def submit(self, *args, **kwargs):
                stopped.set()
                return super().submit(*args, **kwargs)
        with patch.object(dispatch, "ThreadPoolExecutor", StoppingPool):
            result = self.run_dispatch(state, lambda work, context: calls.append(work.id), stop_event=stopped)
        self.assertEqual(calls, [])
        self.assertEqual(result.status, ParentRunStatus.RUNNING)
        self.assertEqual(result.outcomes, ())
        self.assertEqual(state.rows["0"].disposition, WorkDisposition.QUEUED)
        self.assertIn(("release_claim", "0", "dispatch_stopped"), state.events)

    def test_stop_during_worker_setup_prevents_portal_entry_and_preserves_claim(self):
        state, calls, stopped = DispatchState(("Kenya",)), [], threading.Event()
        @contextmanager
        def context(work):
            with state.context(work) as resources:
                stopped.set()
                yield resources
        result = dispatch.dispatch_parent("parent", tuple(state.rows.values()), 1, context,
            lambda work, context: calls.append(work.id), store=state.store(), stop_event=stopped, poll_interval=0.001)
        self.assertEqual(calls, [])
        self.assertEqual(result.status, ParentRunStatus.RUNNING)
        self.assertEqual(result.outcomes, ())
        self.assertEqual(state.rows["0"].disposition, WorkDisposition.QUEUED)

    def test_foreign_work_is_never_submitted(self):
        state, calls = DispatchState(), []
        state.rows["0"] = replace(state.rows["0"], parent_runner_run_id="foreign")
        result = self.run_dispatch(state, lambda work, context: calls.append(work.id) or {})
        self.assertEqual(calls, ["1"])
        self.assertEqual(state.rows["0"].disposition, WorkDisposition.QUEUED)
        self.assertEqual(result.status, ParentRunStatus.COMPLETED)

    def test_invalid_concurrency_fails_before_claim_or_context_creation(self):
        for maximum in (0, 3, True, "2"):
            state = DispatchState()
            with self.assertRaises(ValueError):
                self.run_dispatch(state, lambda *_: None, maximum=maximum)
            self.assertEqual(state.events, [])


class DispatchTests(unittest.TestCase):
    dispatch = dispatch

    def test_concurrent_output_is_bound_and_unbound_output_falls_back(self):
        original = io.StringIO()
        barrier = threading.Barrier(2)
        with patch.object(sys, "stdout", original):
            with self.dispatch.ContextOutputRouter.installed() as router:
                proxy = sys.stdout
                with self.dispatch.ContextOutputRouter.installed() as nested:
                    self.assertIs(router, nested)
                    self.assertIs(sys.stdout, proxy)
                def write(name):
                    with router.bind(name) as output:
                        for index in range(30):
                            barrier.wait(timeout=3)
                            print(f"{name}:{index}")
                        self.assertIs(sys.stdout, proxy)
                        return output.getvalue()
                with ThreadPoolExecutor(max_workers=2) as pool:
                    a, b = list(pool.map(write, ["Kenya", "Uganda"]))
                print("parent")
            self.assertIs(sys.stdout, original)
        self.assertEqual(a, "".join(f"Kenya:{i}\n" for i in range(30)))
        self.assertEqual(b, "".join(f"Uganda:{i}\n" for i in range(30)))
        self.assertEqual(original.getvalue(), "parent\n")

    def test_nested_exception_binding_restores_outer_then_original(self):
        original = io.StringIO()
        router = self.dispatch.ContextOutputRouter(original)
        with router.bind("outer") as outer:
            router.write("before")
            with self.assertRaises(ValueError):
                with router.bind("inner") as inner:
                    router.write("inner")
                    raise ValueError("expected")
            router.write("after")
        router.write("unbound")
        router.flush()
        self.assertEqual(outer.getvalue(), "beforeafter")
        self.assertEqual(inner.getvalue(), "inner")
        self.assertEqual(original.getvalue(), "unbound")

    def test_install_from_worker_is_rejected_without_replacing_stdout(self):
        before = sys.stdout
        def install():
            with self.dispatch.ContextOutputRouter.installed():
                pass
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.assertRaises(RuntimeError):
                pool.submit(install).result(timeout=3)
        self.assertIs(sys.stdout, before)

    def factory(self, router, resources, **options):
        @contextmanager
        def create(work):
            store, ledger = Resource(**options), Resource()
            with router.bind(work.insurer_name) as output:
                context = self.dispatch.WorkerContext(store, ledger, output, work.worker_id, max_concurrency=2)
                resources.append(context)
                try:
                    yield context
                finally:
                    try:
                        ledger.close()
                    finally:
                        store.close()
        return create

    def test_workers_run_once_and_failure_does_not_stop_other_worker(self):
        barrier = threading.Barrier(2)
        contexts, calls = [], []
        original = io.StringIO()
        def run_one(work, context):
            calls.append(work.id)
            barrier.wait(timeout=3)
            print(f"<html>private-{work.id}</html>")
            if work.insurer_name == "Kenya":
                raise TimeoutError("password=private-email@example.org")
            return {"notification_items": ["worker-owned"]}
        with patch.object(sys, "stdout", original):
            with self.dispatch.ContextOutputRouter.installed() as router:
                factory = self.factory(router, contexts)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    outcomes = list(pool.map(lambda w: self.dispatch.execute_claimed_insurer(w, factory, run_one), [claimed("Kenya"), claimed("Uganda")]))
        self.assertCountEqual(calls, ["Kenya", "Uganda"])
        self.assertEqual([x.status for x in outcomes], [InsurerRunStatus.FAILED, InsurerRunStatus.COMPLETED])
        self.assertEqual(outcomes[0].error_code, "portal_timeout")
        self.assertEqual(outcomes[1].value.result["notification_items"], ["worker-owned"])
        self.assertNotIn("private", repr(outcomes))
        self.assertNotIn("<html>", repr(outcomes))
        self.assertEqual(original.getvalue(), "")
        for field in ("store", "ledger", "output"):
            self.assertIsNot(getattr(contexts[0], field), getattr(contexts[1], field))
        self.assertIsNot(contexts[0].store.connection, contexts[1].store.connection)
        for context in contexts:
            self.assertEqual(context.store.events[-3:], [("unlock", context.worker_id), ("release", 0), "close"])
            self.assertEqual(context.ledger.events, ["close"])

    def test_denied_or_failed_locks_never_run_portal_or_coalesce(self):
        for options, expected in [
            ({"slot": -1}, ["close"]),
            ({"acquired": False}, [("release", 0), "close"]),
            ({"failure": "acquire"}, [("release", 0), "close"]),
            ({"failure": "unlock"}, [("release", 0), "close"]),
        ]:
            with self.subTest(options=options):
                contexts, calls = [], []
                router = self.dispatch.ContextOutputRouter(io.StringIO())
                result = self.dispatch.execute_claimed_insurer(
                    claimed(), self.factory(router, contexts, **options),
                    lambda *_: calls.append("run"),
                )
                self.assertEqual(result.status, InsurerRunStatus.FAILED)
                self.assertEqual(calls, ["run"] if options.get("failure") == "unlock" else [])
                self.assertEqual(contexts[0].store.events[-len(expected):], expected)
                self.assertEqual(contexts[0].ledger.events, ["close"])
                self.assertNotIn("private", repr(result))

    def test_factory_failure_becomes_safe_outcome(self):
        @contextmanager
        def broken(_work):
            raise RuntimeError('password="SECRET" <html>patient</html>')
            yield
        result = self.dispatch.execute_claimed_insurer(claimed(), broken, lambda *_: self.fail("must not run"))
        self.assertEqual(result.status, InsurerRunStatus.FAILED)
        self.assertNotIn("SECRET", repr(result))
        self.assertNotIn("patient", repr(result))


if __name__ == "__main__":
    unittest.main()
