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
    result = {"phase": name("phase", PHASES),
            "module": name("module", MODULES),
            "error_type": name("error_type", ERROR_TYPES),
            "line": line if type(line) is int and 0 < line <= 1000000 else 0}
    scan = value.get("scan")
    if isinstance(scan, dict) and scan.get("code") in ("response_timeout", "response_http_error"):
        result["scan"] = {"code": scan["code"]}
        for key, maximum in (("page_number", 1000000), ("page_size", 10000),
                             ("elapsed_ms", 3600000), ("http_status", 599)):
            number = scan.get(key)
            if type(number) is int and 0 <= number <= maximum:
                result["scan"][key] = number
    return result


def failure_diagnostic(error, phase="other"):
    result = {"phase": phase, "error_type": type(error).__name__}
    current, seen = error, set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(getattr(current, "scan_diagnostic", None), dict):
            result["scan"] = current.scan_diagnostic
            break
        current = current.__cause__ or current.__context__
    trace = error.__traceback__
    while trace:
        module = Path(trace.tb_frame.f_code.co_filename).stem
        if module in MODULES:
            result.update(module=module, line=trace.tb_lineno)
        trace = trace.tb_next
    return sanitize_failure(result)
