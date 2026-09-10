"""Worker boundary tests: real threads/output, no database or portal calls."""

import io
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch

from scripts.piles_auto_assignment import dispatch
from scripts.piles_auto_assignment.domain import InsurerRunStatus
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
