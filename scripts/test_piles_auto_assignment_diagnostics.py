import json
import unittest

from scripts.piles_auto_assignment.diagnostics import failure_diagnostic, sanitize_failure
from scripts.piles_auto_assignment.store import ExecutionLedger
from scripts.test_piles_auto_assignment_store import RecordingConnection


class FailureDiagnosticsTests(unittest.TestCase):
    def test_exception_message_and_locals_are_never_serialized(self):
        try:
            raise TypeError("secret patient token")
        except TypeError as error:
            diagnostic = failure_diagnostic(error, "reconcile")
        self.assertEqual(diagnostic, {"phase": "reconcile", "module": "other", "error_type": "TypeError", "line": 0})
        self.assertNotIn("secret", json.dumps(diagnostic))

    def test_untrusted_values_are_rejected_and_database_persistence_is_sanitized(self):
        bad = {"phase": [], "module": "patient", "error_type": {}, "line": True, "locals": "secret"}
        safe = {"phase": "other", "module": "other", "error_type": "other", "line": 0}
        self.assertEqual(sanitize_failure(bad), safe)
        connection = RecordingConnection()
        ExecutionLedger(connection).finalize_insurer_run("run-1", status="failed", failure=bad)
        params = connection.statements[-1][1]
        self.assertEqual(json.loads(params[-2]), {"failure": safe})

    def test_known_runner_location_is_retained_without_source_or_local_values(self):
        namespace = {}
        exec(compile("def fail():\n    raise ValueError('private')\n", "piles_auto_assignment_runner.py", "exec"), namespace)
        try:
            namespace["fail"]()
        except ValueError as error:
            diagnostic = failure_diagnostic(error, "plan")
        self.assertEqual(diagnostic, {"phase": "plan", "module": "piles_auto_assignment_runner", "error_type": "ValueError", "line": 2})
