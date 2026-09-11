"""Worker-local monotonic timings; only bounded, allowlisted aggregates leave here."""

from contextlib import contextmanager
from copy import deepcopy
import math
import time
from functools import wraps


PHASES = frozenset({'login', 'navigation', 'scan', 'plan', 'apply', 'verify', 'reconcile', 'final_rescan', 'other'})
OPERATIONS = frozenset({'login', 'open_piles', 'filter', 'pagination', 'planning', 'row_selection',
                        'modal', 'verification', 'reconciliation', 'final_rescan', 'phase', 'other'})
OUTCOMES = frozenset({'success', 'failed', 'accept', 'retry', 'fail', 'other'})


def _name(value, allowed):
    return value if isinstance(value, str) and value in allowed else 'other'


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    if isinstance(value, int):
        return float(max(0, min(value, 10**15)))
    return max(0.0, min(value, 1e15)) if math.isfinite(value) else 0.0


class PhaseTimer:
    def __init__(self):
        self._aggregates = {}
        self._phase = None

    def enter_phase(self, phase):
        now = time.monotonic_ns()
        phase = _name(phase, PHASES)
        if self._phase and self._phase[0] == phase:
            return
        if self._phase:
            self.record(self._phase[0], 'phase', (now - self._phase[1]) / 1_000_000, 'success')
        self._phase = (phase, now)

    def finish(self, outcome='success'):
        if self._phase:
            self.record(self._phase[0], 'phase', (time.monotonic_ns() - self._phase[1]) / 1_000_000, outcome)
            self._phase = None

    def record(self, phase, operation, elapsed_ms, outcome):
        phase, operation = _name(phase, PHASES), _name(operation, OPERATIONS)
        outcome = _name(outcome, OUTCOMES)
        elapsed_ms = _number(elapsed_ms)
        aggregate = self._aggregates.setdefault((phase, operation), {
            'phase': phase, 'operation': operation, 'count': 0, 'total_ms': 0.0,
            'min_ms': elapsed_ms, 'max_ms': elapsed_ms, 'outcomes': {},
        })
        aggregate['count'] = min(aggregate['count'] + 1, 10**12)
        aggregate['total_ms'] = min(aggregate['total_ms'] + elapsed_ms, 1e15)
        aggregate['min_ms'] = min(aggregate['min_ms'], elapsed_ms)
        aggregate['max_ms'] = max(aggregate['max_ms'], elapsed_ms)
        aggregate['outcomes'][outcome] = min(aggregate['outcomes'].get(outcome, 0) + 1, 10**12)

    @contextmanager
    def measure(self, phase, operation):
        start = time.monotonic_ns()
        outcome = 'success'
        try:
            yield
        except BaseException:
            outcome = 'failed'
            raise
        finally:
            self.record(phase, operation, (time.monotonic_ns() - start) / 1_000_000, outcome)

    def serialize(self):
        return deepcopy([self._aggregates[key] for key in sorted(self._aggregates)])

    def call(self, phase, operation, function, *args, **kwargs):
        with self.measure(phase, operation):
            return function(*args, **kwargs)


def sanitize_performance(values):
    """Re-project at the durable boundary; never trust caller-supplied details."""
    output, seen = [], set()
    if not isinstance(values, (list, tuple)):
        return output
    for value in values[:100]:
        if not isinstance(value, dict):
            continue
        phase = _name(value.get('phase'), PHASES)
        operation = _name(value.get('operation'), OPERATIONS)
        if (phase, operation) in seen:
            continue
        seen.add((phase, operation))
        outcomes = value.get('outcomes', {})
        output.append({
            'phase': phase, 'operation': operation,
            'count': int(min(_number(value.get('count')), 10**12)),
            'total_ms': _number(value.get('total_ms')),
            'min_ms': _number(value.get('min_ms')),
            'max_ms': _number(value.get('max_ms')),
            'outcomes': {key: int(min(_number(count), 10**12)) for key, count in outcomes.items()
                         if key in OUTCOMES} if isinstance(outcomes, dict) else {},
        })
    return output


def timed_operation(phase, operation):
    """Instrument a portal operation without recording its args, result or errors."""
    def decorate(function):
        @wraps(function)
        def measured(self, *args, **kwargs):
            timer = getattr(self, 'phase_timer', None)
            if timer is None:
                timer = self.phase_timer = PhaseTimer()
            with timer.measure(phase, operation):
                return function(self, *args, **kwargs)
        return measured
    return decorate
