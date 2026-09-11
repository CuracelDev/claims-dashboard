"""Bounded, parent-owned execution with isolated resources and token fencing."""

from __future__ import annotations

import sys
import threading
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from io import StringIO
from typing import Any, Callable, ContextManager, Iterator

from .domain import InsurerRunStatus, ParentRunStatus, WorkDisposition
from .orchestrator import InsurerOutcome, classify_runner_error
from .store import ClaimedWork, ParentWorkPending, notification_fingerprint


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
    dispatch_store: Any = field(default=None, repr=False)
    ownership: Any = field(default=None, repr=False)
    output_path: str = field(default="", repr=False)


@dataclass(frozen=True)
class WorkerResult:
    # Existing portal result is internal input to parent notification aggregation;
    # never serialize it as an operational diagnostic or history payload.
    result: Any = field(repr=False)
    output: str = ""
    insurer_run_id: str = ""


class WorkerUnavailable(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class WorkOwnershipLost(WorkerUnavailable):
    def __init__(self) -> None:
        super().__init__("work_ownership_lost")


class AssignmentSubmissionUncertain(WorkerUnavailable):
    def __init__(self) -> None:
        super().__init__("assignment_submission_uncertain")


class ClaimOwnership:
    """Worker-local fail-closed lease/lock guard; never shared across threads."""

    def __init__(self, work, store, owner_pid, slot, lease_seconds):
        self.work, self.store = work, store
        self.owner_pid, self.slot, self.lease_seconds = owner_pid, slot, lease_seconds
        self.insurer_run_id = ""
        self.status = InsurerRunStatus.COMPLETED
        self.error_code = ""
        self.lost = False

    def check(self, phase: str = "", *, insurer_run_id=None) -> None:
        if self.lost:
            raise WorkOwnershipLost()
        try:
            valid = self.store.heartbeat_claim(
                self.work.id, self.work.claim_token, self.owner_pid, self.slot,
                self.lease_seconds, insurer_run_id=insurer_run_id,
            )
        except Exception:
            valid = False
        if not valid:
            self.lost = True
            raise WorkOwnershipLost()

    def started(self, insurer_run_id: str) -> None:
        self.insurer_run_id = insurer_run_id
        self.check(insurer_run_id=insurer_run_id)


def safe_worker_error(error: Exception) -> tuple[str, str]:
    code = error.code if isinstance(error, WorkerUnavailable) else classify_runner_error(error)
    return code, "Insurer execution could not complete; inspect the normalized error code."


def execute_claimed_insurer(
    work: ClaimedWork,
    context_factory: Callable[[ClaimedWork], ContextManager[WorkerContext]],
    run_one: Callable[[ClaimedWork, WorkerContext], Any],
    *, lease_seconds: int = 120, stop_event=None,
) -> InsurerOutcome:
    """Execute exactly once after lock acquisition, never consume legacy work.

    Lock contention is a failed *execution attempt*, not coverage evidence. The
    coordinator must preserve/requeue legitimate work according to its policy.
    ExitStack attempts every release even if another cleanup operation fails.
    """
    ownership = None
    try:
        if stop_event is not None and stop_event.is_set():
            raise WorkerUnavailable("dispatch_stopped")
        with context_factory(work) as context:
            with ExitStack() as locks:
                slot = context.store.try_acquire_runner_slot(context.max_concurrency)
                if slot < 0:
                    raise WorkerUnavailable("worker_capacity_unavailable")
                locks.callback(context.store.release_runner_slot, slot)
                if not context.store.try_acquire_insurer_lock(work.insurer_name):
                    raise WorkerUnavailable("insurer_lock_unavailable")
                locks.callback(context.store.release_insurer_lock, work.insurer_name)
                if context.dispatch_store is not None:
                    ownership = ClaimOwnership(work, context.dispatch_store,
                                               context.store.conn.get_backend_pid(), slot, lease_seconds)
                    context = replace(context, ownership=ownership)
                    ownership.check()
                if stop_event is not None and stop_event.is_set():
                    raise WorkerUnavailable("dispatch_stopped")
                try:
                    result = run_one(work, context)
                except Exception:
                    if ownership:
                        ownership.check()
                    raise
                if ownership:
                    ownership.check()
                # Free-form logs cannot be reliably scrubbed. Return only a safe
                # acknowledgement; the bound raw buffer stays worker-local.
                output = "Worker output withheld.\n" if context.output.getvalue() else ""
                value = WorkerResult(result, output, ownership.insurer_run_id if ownership else "")
        return InsurerOutcome(work.insurer_name, ownership.status if ownership else InsurerRunStatus.COMPLETED,
                              value=value, error_code=ownership.error_code if ownership else "")
    except Exception as error:
        code, message = safe_worker_error(error)
        return InsurerOutcome(work.insurer_name, InsurerRunStatus.FAILED,
                              error_code=code, error_message=message,
                              value=WorkerResult(None, insurer_run_id=ownership.insurer_run_id) if ownership else None)


@dataclass(frozen=True)
class DispatchResult:
    status: ParentRunStatus
    outcomes: tuple[InsurerOutcome, ...]
    notification_items: tuple[Any, ...] = field(default=(), repr=False)
    external_notification_items: tuple[Any, ...] = field(default=(), repr=False)
    finalized_work_ids: tuple[str, ...] = field(default=(), repr=False)
    notification_fingerprints: tuple[str, ...] = field(default=(), repr=False)


@dataclass(frozen=True)
class ProbeWork:
    """Read-only invocation identity, never a durable execute claim."""
    insurer_name: str
    canonical_insurer_name: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    worker_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    parent_runner_run_id: None = None
    claim_token: str = ""


def dispatch_parent(parent_id, work_items, max_workers, context_factory, run_one,
                    *, store, lease_seconds=120, poll_interval=1.0, stop_event=None) -> DispatchResult:
    """Claim only this parent's work, keep at most 1|2 futures, aggregate on parent.

    No queue deadline: contention and foreign request references remain waiting
    work. Shutdown/ownership loss stops new claims and leaves durable work for
    guarded recovery. A completed/failed portal attempt is never retried here.
    """
    if type(max_workers) is not int or max_workers not in (1, 2):
        raise ValueError("Dispatcher concurrency must be exactly 1 or 2")
    if type(lease_seconds) is not int or lease_seconds <= 0 or not 0 < poll_interval <= 60:
        raise ValueError("A positive lease and polling interval at most 60 seconds are required")
    work_items = tuple(work_items)
    order = {item.insurer_name: index for index, item in reversed(list(enumerate(work_items)))}
    stopped = stop_event if stop_event is not None else threading.Event()
    outcomes = []
    finalized_work_ids = []
    work_by_outcome = {}
    for item in work_items:
        disposition = getattr(item, "disposition", None)
        status = {WorkDisposition.INACTIVE: InsurerRunStatus.SKIPPED_INACTIVE,
                  WorkDisposition.COVERED_BY_ACTIVE_CYCLE: InsurerRunStatus.COVERED_BY_ACTIVE_CYCLE}.get(disposition)
        if status:
            outcomes.append(InsurerOutcome(item.insurer_name, status))

    @contextmanager
    def owned_context(work):
        with context_factory(work) as context:
            if context.dispatch_store is None:
                raise RuntimeError("Durable worker claim store is required")
            yield replace(context, max_concurrency=max_workers)

    status = ParentRunStatus.RUNNING
    lost_ownership = False
    with ContextOutputRouter.installed():
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="piles-insurer") as pool:
            pending = {}
            while True:
                while len(pending) < max_workers and not stopped.is_set() and not lost_ownership:
                    work = store.claim_next(parent_id, str(uuid.uuid4()), lease_seconds)
                    if work is None:
                        break
                    if work.parent_runner_run_id != parent_id or work.disposition != WorkDisposition.CLAIMED:
                        raise ValueError("Dispatcher received work not claimed for this parent")
                    if stopped.is_set():
                        if not store.release_claim(work.id, work.claim_token, "dispatch_stopped"):
                            lost_ownership = True
                        break
                    pending[pool.submit(execute_claimed_insurer, work, owned_context, run_one,
                                        lease_seconds=lease_seconds, stop_event=stopped)] = work
                if not pending:
                    try:
                        status = store.finalize_parent(parent_id)
                        break
                    except ParentWorkPending:
                        if stopped.is_set() or lost_ownership:
                            break
                        stopped.wait(poll_interval)
                        continue
                finished, _ = wait(pending, timeout=poll_interval, return_when=FIRST_COMPLETED)
                contended = False
                for future in finished:
                    work = pending.pop(future)
                    try:
                        outcome = future.result()
                    except Exception as error:
                        code, message = safe_worker_error(error)
                        outcome = InsurerOutcome(work.insurer_name, InsurerRunStatus.FAILED,
                                                 error_code=code, error_message=message)
                    if outcome.error_code in {"worker_capacity_unavailable", "insurer_lock_unavailable", "dispatch_stopped"}:
                        if not store.release_claim(work.id, work.claim_token, outcome.error_code):
                            lost_ownership = True
                        contended = True
                        continue
                    if outcome.error_code == "work_ownership_lost":
                        lost_ownership = True
                    else:
                        disposition = WorkDisposition.FAILED if outcome.status == InsurerRunStatus.FAILED else WorkDisposition.COMPLETED
                        run_id = outcome.value.insurer_run_id if isinstance(outcome.value, WorkerResult) else ""
                        if not store.finish_claim(work.id, work.claim_token, disposition,
                                                  run_id or None, outcome.error_code):
                            lost_ownership = True
                        else:
                            finalized_work_ids.append(work.id)
                    outcomes.append(outcome)
                    work_by_outcome[id(outcome)] = work.id
                if contended:
                    stopped.wait(poll_interval)
    ordered = tuple(sorted(outcomes, key=lambda outcome: order.get(outcome.insurer_name, len(order))))
    notifications, external, fingerprints = [], [], []
    for outcome in ordered:
        if isinstance(outcome.value, WorkerResult) and isinstance(outcome.value.result, dict):
            items = outcome.value.result.get("notification_items", ())
            notifications.extend(items)
            for item in items:
                if len(fingerprints) > 10000:
                    break
                plan = getattr(item, "plan", None)
                fingerprints.append(notification_fingerprint(
                    work_by_outcome.get(id(outcome), ""), getattr(plan, "insurer_name", None),
                    getattr(plan, "tracking_key", None),
                ))
            external.extend(outcome.value.result.get("external_notification_items", ()))
    return DispatchResult(status, ordered, tuple(notifications), tuple(external),
                          tuple(finalized_work_ids), tuple(fingerprints))
