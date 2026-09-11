import importlib
import json
import unittest
from unittest.mock import patch


class PhaseTimerTests(unittest.TestCase):
    def timer_type(self):
        try:
            return importlib.import_module('scripts.piles_auto_assignment.timing').PhaseTimer
        except ModuleNotFoundError:
            self.fail('PhaseTimer aggregate instrumentation is missing')

    def test_monotonic_measurements_aggregate_without_samples(self):
        timer = self.timer_type()()
        with patch('time.monotonic_ns', side_effect=[10_000_000, 14_000_000, 20_000_000, 19_000_000]):
            with timer.measure('scan', 'filter'):
                pass
            with self.assertRaises(ValueError):
                with timer.measure('scan', 'filter'):
                    raise ValueError('secret patient URL')
        self.assertEqual(timer.serialize(), [{
            'phase': 'scan', 'operation': 'filter', 'count': 2,
            'total_ms': 4.0, 'min_ms': 0.0, 'max_ms': 4.0,
            'outcomes': {'success': 1, 'failed': 1},
        }])

    def test_names_are_allowlisted_and_no_details_or_nonfinite_values_escape(self):
        timer = self.timer_type()()
        secret = 'patient-123 https://portal.test token=<html>'
        for index in range(1000):
            timer.record(secret, secret + str(index), 2, secret)
        timer.record('scan', 'filter', float('nan'), 'success')
        timer.record('scan', 'filter', float('inf'), 'success')
        with self.assertRaises(TypeError):
            timer.record('scan', 'filter', 1, 'success', details=secret)
        output = timer.serialize()
        self.assertLessEqual(len(output), 2)
        self.assertNotIn('patient', json.dumps(output, allow_nan=False))
        self.assertNotIn('portal.test', json.dumps(output))
        self.assertEqual(output[0]['phase'], 'other')
        self.assertEqual(output[0]['operation'], 'other')
        self.assertEqual(output[0]['outcomes'], {'other': 1000})
        output[0]['outcomes']['other'] = 0
        self.assertEqual(timer.serialize()[0]['outcomes']['other'], 1000)

    def test_store_persists_only_sanitized_aggregates_and_read_only_does_not_write(self):
        from scripts.piles_auto_assignment.store import ExecutionLedger, ReadOnlyExecutionLedger
        from scripts.test_piles_auto_assignment_store import RecordingConnection
        import inspect
        self.assertIn('performance', inspect.signature(ExecutionLedger.finalize_insurer_run).parameters)
        secret = 'patient@example.test secret-token <html>'
        rows = [{'phase': 'scan', 'operation': 'filter', 'count': 2, 'total_ms': 5,
                 'min_ms': 2, 'max_ms': 3, 'outcomes': {'accept': 2, secret: 10},
                 'details': secret, 'tracking_key': secret},
                {'phase': secret, 'operation': secret, 'count': 10, 'total_ms': float('inf')}] * 500
        connection = RecordingConnection()
        ExecutionLedger(connection).finalize_insurer_run('fixture-run', status='completed', performance=rows)
        payloads = [json.loads(value) for _, params in connection.statements for value in params
                    if isinstance(value, str) and value.startswith('[')]
        self.assertEqual(len(payloads), 1)
        self.assertLessEqual(len(payloads[0]), 100)
        self.assertNotIn(secret, json.dumps(payloads, allow_nan=False))
        self.assertEqual(set(payloads[0][0]), {'phase', 'operation', 'count', 'total_ms', 'min_ms', 'max_ms', 'outcomes'})
        self.assertIn('accept', payloads[0][0]['outcomes'])
        ReadOnlyExecutionLedger().finalize_insurer_run('fixture-run', status='completed', performance=rows)

    def test_phase_changes_measure_elapsed_time_without_double_counting_heartbeats(self):
        timer = self.timer_type()()
        self.assertTrue(hasattr(timer, 'enter_phase'), 'phase lifetime timing missing')
        with patch('time.monotonic_ns', side_effect=[0, 2_000_000, 4_000_000, 7_000_000]):
            timer.enter_phase('scan')
            timer.enter_phase('scan')
            timer.enter_phase('plan')
            timer.finish('failed')
        output = {(row['phase'], row['operation']): row for row in timer.serialize()}
        self.assertEqual(output['scan', 'phase']['total_ms'], 4)
        self.assertEqual(output['scan', 'phase']['count'], 1)
        self.assertEqual(output['plan', 'phase']['total_ms'], 3)
        self.assertEqual(output['plan', 'phase']['outcomes'], {'failed': 1})

    def test_pathological_numeric_inputs_cannot_break_serialization(self):
        timer = self.timer_type()()
        timer.record('scan', 'filter', 10**1000, 'accept')
        self.assertLessEqual(timer.serialize()[0]['total_ms'], 1e15)
        json.dumps(timer.serialize(), allow_nan=False)


if __name__ == '__main__':
    unittest.main()
