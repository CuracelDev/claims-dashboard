import unittest
from types import SimpleNamespace

from scripts.piles_auto_assignment.execution import execute_persisted_batch


def batch():
    return SimpleNamespace(
        record={"id": "batch-1"},
        attempts=(
            SimpleNamespace(id="attempt-1", tracking_key="pile-1"),
            SimpleNamespace(id="attempt-2", tracking_key="pile-2"),
        ),
    )


class Ledger:
    def __init__(self, events, fail=False):
        self.events = events
        self.fail = fail

    def create_batch_with_attempts(self, record, attempts):
        self.events.append("persist:planned")
        if self.fail:
            raise RuntimeError("database unavailable")
        return record["id"]

    def transition_attempt(self, attempt_id, target, **_kwargs):
        self.events.append(f"persist:{target.value}:{attempt_id}")


class Portal:
    def __init__(self, events):
        self.events = events

    def select_batch(self, _batch):
        self.events.append("portal:select")
        return {"pile-1", "pile-2"}

    def submit_assignment(self, _batch, _selected):
        self.events.append("portal:submit")
        return {"acknowledged": True}


class PersistedExecutionTests(unittest.TestCase):
    def test_attempts_are_persisted_before_portal_selection(self):
        events = []
        execute_persisted_batch(Portal(events), Ledger(events), batch())
        self.assertLess(events.index("persist:planned"), events.index("portal:select"))
        self.assertLess(events.index("portal:submit"), events.index("persist:submitted:attempt-1"))

    def test_persistence_failure_prevents_any_portal_action(self):
        events = []
        with self.assertRaisesRegex(RuntimeError, "database unavailable"):
            execute_persisted_batch(Portal(events), Ledger(events, fail=True), batch())
        self.assertNotIn("portal:select", events)
        self.assertNotIn("portal:submit", events)

    def test_only_selected_attempts_are_marked_and_submitted(self):
        events = []
        portal = Portal(events)
        portal.select_batch = lambda _batch: events.append("portal:select") or {"pile-2"}
        result = execute_persisted_batch(portal, Ledger(events), batch())
        self.assertEqual(result.selected_tracking_keys, ("pile-2",))
        self.assertNotIn("persist:selected:attempt-1", events)
        self.assertIn("persist:submitted:attempt-2", events)


if __name__ == "__main__":
    unittest.main()
