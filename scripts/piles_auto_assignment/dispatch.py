"""One claimed execution with worker-local resources and safe diagnostics.

This module does not claim work, renew leases, or finalize parents. Those are
coordinator responsibilities; a lease alone never replaces the insurer lock.
"""

from __future__ import annotations

import sys
import threading
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from io import StringIO
from typing import Any, Callable, ContextManager, Iterator

from .domain import InsurerRunStatus
from .orchestrator import InsurerOutcome, classify_runner_error
from .store import ClaimedWork


class ContextOutputRouter:
    """One stdout proxy installed by the coordinator before starting threads.

    Bound output is private in-memory data, never a diagnostic payload. Unbound
    writes retain the original stdout behavior. Context tokens support nested
    bindings and exceptions without redirect_stdout's process-global races.
    """

    _installation_lock = threading.RLock()

    def __init__(self, original: Any) -> None:
        self.original = original
        self._buffer: ContextVar[StringIO | None] = ContextVar("piles_output", default=None)
        self._write_lock = threading.RLock()

    @classmethod
    @contextmanager
    def installed(cls) -> Iterator[ContextOutputRouter]:
        if threading.current_thread() is not threading.main_thread():
            raise RuntimeError("Install worker output routing before starting threads.")
        with cls._installation_lock:
            original = sys.stdout
            owner = not isinstance(original, cls)
            router = cls(original) if owner else original
            if owner:
                sys.stdout = router
        try:
            yield router
        finally:
            with cls._installation_lock:
                if owner and sys.stdout is router:
                    sys.stdout = original

    @contextmanager
    def bind(self, insurer_name: str) -> Iterator[StringIO]:
        # Do not embed the insurer label or arbitrary portal values in logs.
        output = StringIO()
        token = self._buffer.set(output)
        try:
            yield output
        finally:
            self._buffer.reset(token)

    def write(self, data: str) -> int:
        with self._write_lock:
            target = self._buffer.get()
            return (target if target is not None else self.original).write(data)

    def flush(self) -> None:
        with self._write_lock:
            target = self._buffer.get()
            (target if target is not None else self.original).flush()

    def isatty(self) -> bool:
        return self._buffer.get() is None and bool(getattr(self.original, "isatty", lambda: False)())


@dataclass(frozen=True)
class WorkerContext:
    """Resources owned and finally-closed by context_factory on this thread."""

    store: Any = field(repr=False)
    ledger: Any = field(repr=False)
    output: StringIO = field(repr=False)
    worker_id: str
    max_concurrency: int = 1


@dataclass(frozen=True)
class WorkerResult:
    # Existing portal result is internal input to parent notification aggregation;
    # never serialize it as an operational diagnostic or history payload.
    result: Any = field(repr=False)
    output: str = ""


class WorkerUnavailable(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def safe_worker_error(error: Exception) -> tuple[str, str]:
    code = error.code if isinstance(error, WorkerUnavailable) else classify_runner_error(error)
    return code, "Insurer execution could not complete; inspect the normalized error code."


def execute_claimed_insurer(
    work: ClaimedWork,
    context_factory: Callable[[ClaimedWork], ContextManager[WorkerContext]],
    run_one: Callable[[ClaimedWork, WorkerContext], Any],
) -> InsurerOutcome:
    """Execute exactly once after lock acquisition, never consume legacy work.

    Lock contention is a failed *execution attempt*, not coverage evidence. The
    coordinator must preserve/requeue legitimate work according to its policy.
    ExitStack attempts every release even if another cleanup operation fails.
    """
    try:
        with context_factory(work) as context:
            with ExitStack() as locks:
                slot = context.store.try_acquire_runner_slot(context.max_concurrency)
                if slot < 0:
                    raise WorkerUnavailable("worker_capacity_unavailable")
                locks.callback(context.store.release_runner_slot, slot)
                if not context.store.try_acquire_insurer_lock(work.insurer_name):
                    raise WorkerUnavailable("insurer_lock_unavailable")
                locks.callback(context.store.release_insurer_lock, work.insurer_name)
                result = run_one(work, context)
                # Free-form logs cannot be reliably scrubbed. Return only a safe
                # acknowledgement; the bound raw buffer stays worker-local.
                output = "Worker output withheld.\n" if context.output.getvalue() else ""
                value = WorkerResult(result, output)
        return InsurerOutcome(work.insurer_name, InsurerRunStatus.COMPLETED, value=value)
    except Exception as error:
        code, message = safe_worker_error(error)
        return InsurerOutcome(work.insurer_name, InsurerRunStatus.FAILED,
                              error_code=code, error_message=message)
