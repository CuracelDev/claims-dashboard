"""Failure location metadata without exception text, locals or portal data."""

from pathlib import Path

from .timing import PHASES

MODULES = frozenset({"piles_auto_assignment_runner", "dispatch", "store", "reconciliation",
                     "scanning", "evidence", "planning", "orchestrator", "timing"})
ERROR_TYPES = frozenset({"TypeError", "ValueError", "KeyError", "AttributeError", "RuntimeError",
                         "TimeoutError", "IncompleteScan", "ConcurrentStateChange",
                         "TrackingKeyCollision", "NoEligibleAssignees", "OperationalError",
                         "IntegrityError", "ProgrammingError", "WorkOwnershipLost"})


def sanitize_failure(value):
    value = value if isinstance(value, dict) else {}
    line = value.get("line")
    def name(key, allowed):
        candidate = value.get(key)
        return candidate if isinstance(candidate, str) and candidate in allowed else "other"
    return {"phase": name("phase", PHASES),
            "module": name("module", MODULES),
            "error_type": name("error_type", ERROR_TYPES),
            "line": line if type(line) is int and 0 < line <= 1000000 else 0}


def failure_diagnostic(error, phase="other"):
    result = {"phase": phase, "error_type": type(error).__name__}
    trace = error.__traceback__
    while trace:
        module = Path(trace.tb_frame.f_code.co_filename).stem
        if module in MODULES:
            result.update(module=module, line=trace.tb_lineno)
        trace = trace.tb_next
    return sanitize_failure(result)
