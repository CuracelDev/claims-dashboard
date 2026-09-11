"""Transactional persistence for durable Piles execution state."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, fields, is_dataclass, replace
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

from .domain import (
    AttemptStatus, DispatchDecision, InsurerCoverage, ParentRunStatus,
    RequestScope, WorkDisposition, WorkRequest, WorkSource, can_transition_attempt,
    execution_scope_contains,
)
from .orchestrator import derive_parent_status
from .scheduling import decide_dispatch
from .timing import sanitize_performance


class ConcurrentStateChange(RuntimeError):
    """Raised when another worker changed an attempt before our CAS update."""


class ParentWorkPending(ValueError):
    """Owned or referenced work is still live; this is not a parent failure."""


class ParentAlreadyTerminal(ValueError):
    """A replay must return the saved parent outcome without new work."""


def _value(record: Any, name: str, default: Any = None) -> Any:
    if isinstance(record, Mapping):
        return record.get(name, default)
    return getattr(record, name, default)


def _json(value: Any) -> str:
    if is_dataclass(value):
        value = asdict(value)
    return json.dumps(value or {}, default=str, sort_keys=True)


def _insurer_lock_key(value: Any) -> str:
    label = " ".join(str(value or "").strip().lower().split())
    return "OLD MUTUAL" if label in {"uapom", "old mutual"} else label


def notification_fingerprint(work_id: str, insurer_name: str, tracking_key: str) -> str:
    """Ephemeral exact identity evidence, never diagnostic or persisted data."""
    if any(not isinstance(value, str) or not value.strip() or len(value) > 8192
           for value in (work_id, insurer_name, tracking_key)):
        return ""
    return hashlib.sha256(json.dumps(
        [work_id, _insurer_lock_key(insurer_name), tracking_key], separators=(",", ":"),
    ).encode()).hexdigest()


@dataclass(frozen=True)
class ClaimedWork:
    """A lease snapshot, not permission to bypass the insurer advisory lock."""

    id: str
    parent_runner_run_id: Optional[str]
    insurer_name: str
    canonical_insurer_name: str
    source: WorkSource
    request_scope: RequestScope
    disposition: WorkDisposition
    claim_token: str
    worker_id: str
    attempt_number: int
    generation_requested_at: datetime
    requested_at: datetime
    lease_expires_at: datetime
    heartbeat_at: datetime
    claimed_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    covered_by_insurer_run_id: Optional[str] = None
    reason_code: Optional[str] = None

    def __post_init__(self) -> None:
        for name, enum in (("source", WorkSource), ("request_scope", RequestScope), ("disposition", WorkDisposition)):
            object.__setattr__(self, name, enum(getattr(self, name)))
        for name in ("generation_requested_at", "requested_at", "lease_expires_at", "heartbeat_at", "claimed_at", "started_at", "finished_at"):
            value = getattr(self, name)
            if value is None and name in {"started_at", "finished_at"}:
                continue
            if not isinstance(value, datetime) or value.utcoffset() is None:
                raise ValueError(f"{name} must be timezone-aware")


def _rows(cursor: Any) -> list[dict[str, Any]]:
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _claimed(row: Mapping[str, Any]) -> ClaimedWork:
    return ClaimedWork(**{field.name: row[field.name] for field in fields(ClaimedWork)})


class DispatchStore:
    """Own an independent, non-autocommit connection; never share with a ledger.

    The composition root supplies a newly opened PostgreSQL connection per store.
    Canonical dispatch locks serialize enqueue/claim decisions across parents;
    insurer locks remain the authority for browser execution and stale recovery.
    """

    def __init__(self, connection: Any) -> None:
        if connection.autocommit:
            raise ValueError("DispatchStore requires a non-autocommit connection")
        self.connection = connection

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def _transaction(self):
        try:
            with self.connection.cursor() as cursor:
                yield cursor
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    @staticmethod
    def _lease_seconds(value: int) -> int:
        if type(value) is not int or value <= 0:
            raise ValueError("lease_seconds must be a positive integer")
        return value

    @staticmethod
    def _lock_claim(cursor: Any, work_id: str, claim_token: str) -> bool:
        # Acquire the potentially contended row before sampling *any* lease
        # or advisory-lock evidence. An UPDATE can evaluate its predicates
        # before waiting; even pg_locks evidence then outlives lock loss.
        # Every following mutation still rechecks token/state plus fresh time.
        cursor.execute(
            "SELECT id FROM piles_auto_assignment_work_items "
            "WHERE id = %s AND claim_token = %s AND disposition = 'claimed' FOR UPDATE",
            (work_id, claim_token),
        )
        return cursor.fetchone() is not None

    @staticmethod
    def _lock_parent(cursor: Any, parent_id: str) -> dict[str, Any]:
        cursor.execute(
            "SELECT status, details, portal_environment, months, year FROM piles_auto_assignment_runner_runs WHERE id = %s FOR UPDATE",
            (parent_id,),
        )
        rows = _rows(cursor)
        if not rows:
            raise ValueError("Parent run does not exist")
        return rows[0]

    @staticmethod
    def _references(parent: Mapping[str, Any]) -> list[dict[str, str]]:
        references = (parent.get("details") or {}).get("dispatch_requests", [])
        if not isinstance(references, list) or len(references) > 256:
            raise ValueError("Invalid dispatch request references")
        for reference in references:
            if not isinstance(reference, dict) or set(reference) != {"request_id", "work_item_id", "disposition"}:
                raise ValueError("Invalid dispatch request reference")
            for key in ("request_id", "work_item_id"):
                if not isinstance(reference[key], str) or re.fullmatch(r"[A-Za-z0-9._-]{1,200}", reference[key]) is None:
                    raise ValueError("Invalid dispatch reference identifier")
            WorkDisposition(reference["disposition"])
        return list(references)

    def parent_requested_at(self, parent_id: str) -> datetime:
        """Reuse the immutable parent timestamp when a launcher retries its ID."""
        with self._transaction() as cursor:
            cursor.execute("SELECT created_at FROM piles_auto_assignment_runner_runs WHERE id = %s", (parent_id,))
            row = cursor.fetchone()
            if not row or not isinstance(row[0], datetime) or row[0].utcoffset() is None:
                raise ValueError("Parent request timestamp is missing or invalid")
            requested_at = row[0]
        return requested_at

    def fail_parent_setup(self, parent_id: str) -> bool:
        """Only an empty parent can fail setup; never overwrite waiting work."""
        with self._transaction() as cursor:
            cursor.execute(
                """
                UPDATE piles_auto_assignment_runner_runs AS parent
                SET status = 'failed', finished_at = now(), updated_at = now()
                WHERE id = %s AND status IN ('queued','started','running')
                  AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_work_items
                                  WHERE parent_runner_run_id = parent.id)
                  AND coalesce(details ->> 'dispatch_requests', '[]') = '[]'
                RETURNING id
                """, (parent_id,),
            )
            failed = cursor.fetchone() is not None
        return failed

    def enqueue_parent_work(self, parent_id: str, requests: Iterable[WorkRequest]) -> list[DispatchDecision]:
        requests = tuple(requests)
        if len(requests) > 256:
            raise ValueError("At most 256 dispatch requests are allowed per parent")
        if any(request.source == WorkSource.READINESS for request in requests):
            raise ValueError("Read-only probes cannot enqueue execute work")
        decisions = []
        with self._transaction() as cursor:
            parent = self._lock_parent(cursor, parent_id)
            if parent["status"] not in {"queued", "started", "running"}:
                raise ParentAlreadyTerminal("Cannot enqueue work for a terminal parent")
            references = self._references(parent)
            # Take all locks in canonical order before reading coverage, avoiding
            # cross-parent deadlocks and stale statement snapshots after waits.
            for canonical in sorted({_insurer_lock_key(r.insurer_name) for r in requests}):
                cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"piles-dispatch:{canonical}",))
            for request in requests:
                canonical = _insurer_lock_key(request.insurer_name)
                request = replace(
                    request,
                    portal_environment=parent.get("portal_environment") or "production",
                    months=tuple(parent.get("months") or ("All",)),
                    year=parent.get("year") or "All",
                )
                request_id = hashlib.sha256(_json([
                    canonical, request.source.value, request.request_scope.value,
                    request.portal_environment, request.months, request.year,
                    request.requested_at.astimezone(timezone.utc).isoformat(),
                ]).encode()).hexdigest()
                previous = next((ref for ref in references if ref["request_id"] == request_id), None)
                if previous is not None:
                    decisions.append(DispatchDecision(
                        request.insurer_name, request.source, request.request_scope,
                        WorkDisposition(previous["disposition"]), request.requested_at,
                        create_work_item=False,
                    ))
                    continue
                if len(references) >= 256:
                    raise ValueError("At most 256 dispatch references are allowed per parent")
                cursor.execute(
                    """
                    SELECT is_active FROM piles_auto_assignment_master_accounts
                    WHERE CASE
                      WHEN regexp_replace(lower(btrim(insurer_name)), '\\s+', ' ', 'g') IN ('uapom', 'old mutual') THEN 'OLD MUTUAL'
                      ELSE regexp_replace(lower(btrim(insurer_name)), '\\s+', ' ', 'g')
                    END = %s
                    """, (canonical,),
                )
                masters = _rows(cursor)
                if not masters:
                    raise ValueError("Insurer configuration does not exist")
                cursor.execute(
                    """
                    SELECT * FROM (
                      SELECT id, disposition, request_scope, covered_by_insurer_run_id,
                             started_at, finished_at, requested_at,
                             portal_environment, months, year
                      FROM piles_auto_assignment_work_items
                      WHERE canonical_insurer_name = %s
                        AND (disposition IN ('queued','claimed','follow_up_queued')
                          OR id = (
                            SELECT completed.id FROM piles_auto_assignment_work_items completed
                            WHERE completed.canonical_insurer_name = %s
                              AND completed.disposition = 'completed'
                              AND completed.finished_at >= %s
                              AND completed.portal_environment = %s
                              AND (completed.year = 'All' OR completed.year = %s)
                              AND (completed.months = '["All"]'::jsonb OR completed.months @> %s::jsonb)
                            ORDER BY completed.finished_at DESC, completed.id
                            LIMIT 1
                          ))
                      UNION ALL
                      SELECT run.id, 'running',
                             CASE WHEN parent.run_scope = 'all-active' THEN 'all_active' ELSE 'single_insurer' END,
                             run.id, run.started_at, run.finished_at, run.created_at,
                             parent.portal_environment, parent.months, parent.year
                      FROM piles_auto_assignment_insurer_runs run
                      JOIN piles_auto_assignment_runner_runs parent ON parent.id = run.runner_run_id
                      WHERE run.status IN ('queued','running')
                        AND parent.mode = 'execute'
                        AND CASE WHEN regexp_replace(lower(btrim(run.insurer_name)), '\\s+', ' ', 'g') IN ('uapom','old mutual') THEN 'OLD MUTUAL'
                            ELSE regexp_replace(lower(btrim(run.insurer_name)), '\\s+', ' ', 'g') END = %s
                        AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_work_items work
                                        WHERE work.covered_by_insurer_run_id = run.id
                                          AND work.parent_runner_run_id = run.runner_run_id
                                          AND work.disposition IN ('claimed','completed','failed','cancelled'))
                    ) coverage
                    ORDER BY CASE disposition WHEN 'claimed' THEN 0 WHEN 'running' THEN 0 WHEN 'queued' THEN 1
                        WHEN 'follow_up_queued' THEN 2 ELSE 3 END,
                        finished_at DESC NULLS LAST, requested_at, id
                    """, (
                        canonical, canonical, request.requested_at,
                        request.portal_environment, request.year, _json(request.months), canonical,
                    ),
                )
                existing = _rows(cursor)
                compatible = []
                for row in existing:
                    candidate = InsurerCoverage(
                        state=row["disposition"],
                        portal_environment=row.get("portal_environment") or "production",
                        months=tuple(row.get("months") or ("All",)),
                        year=row.get("year") or "All",
                    )
                    if execution_scope_contains(candidate, request):
                        compatible.append(row)
                active = compatible[0] if compatible else {}
                follow_up = next((row for row in compatible if row["disposition"] == "follow_up_queued"), None)
                coverage = InsurerCoverage(
                    state=active.get("disposition", "idle") if any(row["is_active"] for row in masters) else "inactive",
                    active_started_at=active.get("started_at"),
                    active_finished_at=active.get("finished_at"),
                    active_run_id=active.get("covered_by_insurer_run_id") or "",
                    active_request_scope=active.get("request_scope", "all_active"),
                    follow_up_queued=follow_up is not None,
                    portal_environment=active.get("portal_environment") or request.portal_environment,
                    months=tuple(active.get("months") or request.months),
                    year=active.get("year") or request.year,
                )
                decision = decide_dispatch(request, coverage)
                if decision.create_work_item:
                    work_id = str(uuid.uuid4())
                    conflict = ""
                    if decision.disposition == WorkDisposition.QUEUED:
                        conflict = "ON CONFLICT (canonical_insurer_name, source, request_scope, portal_environment, months, year) WHERE disposition = 'queued' DO UPDATE SET updated_at = piles_auto_assignment_work_items.updated_at"
                    elif decision.disposition == WorkDisposition.FOLLOW_UP_QUEUED:
                        conflict = "ON CONFLICT (canonical_insurer_name, portal_environment, months, year) WHERE disposition = 'follow_up_queued' DO UPDATE SET updated_at = piles_auto_assignment_work_items.updated_at"
                    cursor.execute(
                        """
                        INSERT INTO piles_auto_assignment_work_items
                          (id, parent_runner_run_id, insurer_name, canonical_insurer_name,
                           source, request_scope, portal_environment, months, year,
                           disposition, generation_requested_at,
                           covered_by_insurer_run_id, requested_at, finished_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,now(),
                          CASE WHEN %s THEN now() ELSE NULL END)
                        """ + conflict + " RETURNING id",
                        (work_id, parent_id, request.insurer_name, canonical,
                         decision.source.value, decision.request_scope.value,
                         request.portal_environment, _json(request.months), request.year,
                         decision.disposition.value,
                         decision.generation_requested_at, decision.covered_by_insurer_run_id or None,
                         decision.disposition in {WorkDisposition.INACTIVE, WorkDisposition.COVERED_BY_ACTIVE_CYCLE}),
                    )
                    returned_id = str(cursor.fetchone()[0])
                    if returned_id != work_id and conflict:
                        decision = replace(decision, create_work_item=False)
                    work_id = returned_id
                else:
                    reused = follow_up if decision.disposition == WorkDisposition.FOLLOW_UP_QUEUED else active
                    work_id = reused["id"]
                decisions.append(decision)
                references.append({
                    "request_id": request_id,
                    "disposition": decision.disposition.value, "work_item_id": work_id,
                })
            cursor.execute(
                """
                UPDATE piles_auto_assignment_runner_runs
                SET details = jsonb_set(coalesce(details, '{}'::jsonb), '{dispatch_requests}', %s::jsonb),
                    updated_at = now() WHERE id = %s
                """, (json.dumps(references, sort_keys=True), parent_id),
            )
        return decisions

    def claim_next(self, parent_id: str, worker_id: str, lease_seconds: int = 120) -> Optional[ClaimedWork]:
        lease_seconds = self._lease_seconds(lease_seconds)
        if not worker_id:
            raise ValueError("worker_id must not be empty")
        with self._transaction() as cursor:
            cursor.execute(
                """
                SELECT canonical_insurer_name,
                    pg_try_advisory_xact_lock(hashtextextended('piles-dispatch:' || canonical_insurer_name, 0)) AS locked
                FROM (SELECT DISTINCT canonical_insurer_name FROM piles_auto_assignment_work_items
                      WHERE parent_runner_run_id = %s
                        AND disposition IN ('queued','follow_up_queued','claimed')
                      ORDER BY canonical_insurer_name) insurers
                """, (parent_id,),
            )
            canonicals = [row["canonical_insurer_name"] for row in _rows(cursor) if row["locked"]]
            cursor.execute(
                """
                WITH candidate AS MATERIALIZED (
                  SELECT work.id, work.claim_token, work.canonical_insurer_name
                  FROM piles_auto_assignment_work_items work
                  WHERE work.parent_runner_run_id = %s
                    AND work.canonical_insurer_name = ANY(%s)
                    AND work.source <> 'readiness'
                    AND (work.disposition IN ('queued','follow_up_queued')
                         OR (work.disposition = 'claimed' AND work.lease_expires_at <= now()))
                    AND NOT EXISTS (
                      SELECT 1 FROM piles_auto_assignment_work_items other
                      WHERE other.canonical_insurer_name = work.canonical_insurer_name
                        AND other.id <> work.id AND other.disposition = 'claimed')
                    AND pg_try_advisory_xact_lock(hashtextextended('piles-insurer:' || work.canonical_insurer_name, 0))
                  ORDER BY work.generation_requested_at, work.requested_at, work.id
                  LIMIT 1 FOR UPDATE SKIP LOCKED
                )
                UPDATE piles_auto_assignment_work_items work
                SET disposition = 'claimed', worker_id = %s, claim_token = %s,
                    attempt_number = work.attempt_number + 1,
                    lease_expires_at = now() + %s * interval '1 second',
                    heartbeat_at = now(), claimed_at = now(), updated_at = now(),
                    reason_code = CASE WHEN work.disposition = 'claimed' THEN 'expired_lease_reclaimed' ELSE NULL END
                FROM candidate
                WHERE work.id = candidate.id
                  AND work.claim_token IS NOT DISTINCT FROM candidate.claim_token
                  AND pg_try_advisory_xact_lock(hashtextextended('piles-insurer:' || candidate.canonical_insurer_name, 0))
                RETURNING work.*
                """, (parent_id, canonicals, worker_id, str(uuid.uuid4()), lease_seconds),
            )
            rows = _rows(cursor)
            claimed = _claimed(rows[0]) if rows else None
        return claimed

    def renew_claim(self, work_id: str, claim_token: str, lease_seconds: int = 120) -> bool:
        lease_seconds = self._lease_seconds(lease_seconds)
        with self._transaction() as cursor:
            if not self._lock_claim(cursor, work_id, claim_token):
                return False
            cursor.execute(
                """
                UPDATE piles_auto_assignment_work_items
                SET heartbeat_at = clock_timestamp(), lease_expires_at = clock_timestamp() + %s * interval '1 second', updated_at = clock_timestamp()
                WHERE id = %s AND claim_token = %s AND disposition = 'claimed'
                  AND lease_expires_at > clock_timestamp() RETURNING id
                """, (lease_seconds, work_id, claim_token),
            )
            renewed = cursor.fetchone() is not None
        return renewed

    def heartbeat_claim(self, work_id: str, claim_token: str, owner_pid: int,
                        capacity_slot: int, lease_seconds: int = 120,
                        insurer_run_id: Optional[str] = None) -> bool:
        """Renew only while the live token AND both session locks still belong here.

        Inspect pg_locks, never reacquire a lost advisory lock. This connection is
        independent of the worker's lock-owning DataStore and execution ledger.
        A start attachment also verifies that the insurer run belongs to this
        parent. Call immediately before every final portal assignment click.
        """
        lease_seconds = self._lease_seconds(lease_seconds)
        if type(owner_pid) is not int or owner_pid <= 0 or type(capacity_slot) is not int or capacity_slot not in (0, 1):
            raise ValueError("A valid lock-owning backend and capacity slot are required")
        with self._transaction() as cursor:
            if not self._lock_claim(cursor, work_id, claim_token):
                return False
            cursor.execute(
                """
                UPDATE piles_auto_assignment_work_items AS work
                SET heartbeat_at = clock_timestamp(), lease_expires_at = clock_timestamp() + %s * interval '1 second',
                    updated_at = clock_timestamp(),
                    started_at = CASE WHEN %s::text IS NOT NULL THEN coalesce(started_at, clock_timestamp()) ELSE started_at END,
                    covered_by_insurer_run_id = coalesce(%s, covered_by_insurer_run_id)
                WHERE id = %s AND claim_token = %s AND disposition = 'claimed'
                  AND lease_expires_at > clock_timestamp()
                  AND (%s::text IS NULL OR EXISTS (
                    SELECT 1 FROM piles_auto_assignment_insurer_runs run
                    WHERE run.id = %s AND run.runner_run_id = work.parent_runner_run_id))
                  AND (SELECT count(DISTINCT ((classid::bigint << 32) | objid::bigint))
                       FROM pg_locks WHERE locktype = 'advisory' AND pid = %s
                         AND objsubid = 1 AND granted AND mode = 'ExclusiveLock'
                         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                         AND ((classid::bigint << 32) | objid::bigint) IN (
                           hashtextextended('piles-insurer:' || work.canonical_insurer_name, 0),
                           hashtextextended(%s, 0))) = 2
                RETURNING id
                """, (lease_seconds, insurer_run_id, insurer_run_id, work_id, claim_token,
                       insurer_run_id, insurer_run_id, owner_pid, f"piles-capacity:{capacity_slot}"),
            )
            renewed = cursor.fetchone() is not None
        return renewed

    def release_claim(self, work_id: str, claim_token: str, reason_code: str) -> bool:
        """Return a never-started contention/shutdown attempt to claim recovery.

        Keep the same row, owner and generation. Expiring its lease avoids a
        queued/follow-up unique-index collision with a later legitimate request;
        claim_next still checks insurer-lock freedom and rotates the token.
        """
        if reason_code not in {"worker_capacity_unavailable", "insurer_lock_unavailable", "dispatch_stopped"}:
            raise ValueError("Only pre-execution contention or shutdown may release a claim")
        with self._transaction() as cursor:
            if not self._lock_claim(cursor, work_id, claim_token):
                return False
            cursor.execute(
                """
                UPDATE piles_auto_assignment_work_items
                SET lease_expires_at = clock_timestamp(), heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(), reason_code = %s
                WHERE id = %s AND claim_token = %s AND disposition = 'claimed'
                  AND lease_expires_at > clock_timestamp() AND started_at IS NULL
                RETURNING id
                """, (reason_code, work_id, claim_token),
            )
            released = cursor.fetchone() is not None
        return released

    def finish_claim(self, work_id: str, claim_token: str, disposition: WorkDisposition,
                     insurer_run_id: Optional[str] = None, reason_code: str = "") -> bool:
        disposition = WorkDisposition(disposition)
        if disposition not in {WorkDisposition.COMPLETED, WorkDisposition.FAILED, WorkDisposition.CANCELLED}:
            raise ValueError("Claims must finish with a terminal execution disposition")
        if reason_code and (len(reason_code) > 80 or re.fullmatch(r"[a-z0-9._-]+", reason_code) is None):
            raise ValueError("reason_code must be a bounded sanitized code")
        with self._transaction() as cursor:
            if not self._lock_claim(cursor, work_id, claim_token):
                return False
            cursor.execute(
                """
                UPDATE piles_auto_assignment_work_items
                SET disposition = %s, covered_by_insurer_run_id = %s, reason_code = %s,
                    finished_at = clock_timestamp(), heartbeat_at = clock_timestamp(), lease_expires_at = NULL, updated_at = clock_timestamp()
                WHERE id = %s AND claim_token = %s AND disposition = 'claimed'
                  AND lease_expires_at > clock_timestamp()
                RETURNING id
                """, (disposition.value, insurer_run_id, reason_code or None, work_id, claim_token),
            )
            finished = cursor.fetchone() is not None
        return finished

    def recoverable_expired_work(self) -> list[ClaimedWork]:
        """Inspect candidates only; claim_next must recheck expiry and lock freedom."""
        recoverable = []
        with self._transaction() as cursor:
            cursor.execute(
                """
                SELECT * FROM piles_auto_assignment_work_items
                WHERE disposition = 'claimed' AND lease_expires_at <= now()
                ORDER BY canonical_insurer_name, lease_expires_at, id
                """,
            )
            for row in _rows(cursor):
                cursor.execute("SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0))", (f"piles-insurer:{row['canonical_insurer_name']}",))
                if cursor.fetchone()[0]:
                    recoverable.append(_claimed(row))
        return recoverable

    def finalize_parent(self, parent_id: str) -> ParentRunStatus:
        with self._transaction() as cursor:
            parent = self._lock_parent(cursor, parent_id)
            if parent["status"] not in {"queued", "started", "running"}:
                return ParentRunStatus(parent["status"])
            references = self._references(parent)
            cursor.execute(
                """
                SELECT work.disposition, run.status AS insurer_status
                FROM piles_auto_assignment_work_items work
                LEFT JOIN piles_auto_assignment_insurer_runs run
                  ON run.id = work.covered_by_insurer_run_id
                  AND run.runner_run_id = work.parent_runner_run_id
                WHERE work.parent_runner_run_id = %s
                FOR UPDATE OF work
                """, (parent_id,),
            )
            rows = _rows(cursor)
            acknowledgements = []
            if references:
                reference_ids = sorted({ref["work_item_id"] for ref in references})
                cursor.execute(
                    """
                    SELECT id, disposition FROM piles_auto_assignment_work_items
                    WHERE id = ANY(%s)
                    """, (reference_ids,),
                )
                referenced = _rows(cursor)
                if {row["id"] for row in referenced} != set(reference_ids):
                    raise ValueError("A referenced dispatch generation is missing")
                if any(row["disposition"] in {"queued", "claimed", "follow_up_queued"} for row in referenced):
                    raise ParentWorkPending("Referenced dispatch work is nonterminal")
                # This validates completion only. Foreign insurer outcomes never
                # become an owned success/failure of the requesting parent.
                # Terminal work is immutable; a plain read avoids cross-parent
                # lock cycles when parents reference each other's generations.
                derive_parent_status((row["disposition"] for row in referenced), [])
                if not rows:
                    acknowledgements.append(WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
            if any(row["disposition"] in {"queued", "claimed", "follow_up_queued"}
                   or row["insurer_status"] in {"queued", "running"} for row in rows):
                raise ParentWorkPending("Owned dispatch work is nonterminal")
            status = derive_parent_status(
                [row["disposition"] for row in rows] + acknowledgements,
                (row["insurer_status"] for row in rows if row["insurer_status"] is not None),
            )
            cursor.execute(
                """
                UPDATE piles_auto_assignment_runner_runs
                SET status = %s, finished_at = now(), updated_at = now(),
                    duration_ms = least(2147483647, greatest(0, extract(epoch FROM (now() - started_at)) * 1000))::integer
                WHERE id = %s RETURNING id
                """, (status.value, parent_id),
            )
        return status

    def notification_collection_complete(self, parent_id: str, work_ids: Iterable[str],
                                         notification_fingerprints: Iterable[str] = ()) -> bool:
        """Read-only, bounded proof of this invocation's generation collection.

        Resumed parents can contain completed generations whose notification
        payloads existed only in a prior process. Never announce a partial parent
        aggregate. Keys are read only to hash exact confirmed identities in this
        scope; no raw evidence, key or fingerprint is returned, logged or saved.
        """
        def valid_id(value):
            return isinstance(value, str) and re.fullmatch(
                r"(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", value) is not None

        collected = []
        for value in work_ids:
            if len(collected) >= 256 or not valid_id(value) or value in collected:
                return False
            collected.append(value)
        supplied_fingerprints = set()
        for value in notification_fingerprints:
            if (len(supplied_fingerprints) >= 10000 or not isinstance(value, str)
                    or re.fullmatch(r"[0-9a-f]{64}", value) is None or value in supplied_fingerprints):
                return False
            supplied_fingerprints.add(value)
        with self._transaction() as cursor:
            cursor.execute(
                """
                SELECT id, disposition FROM piles_auto_assignment_work_items
                WHERE parent_runner_run_id = %s
                  AND disposition NOT IN ('covered_by_active_cycle', 'inactive')
                ORDER BY id LIMIT 257
                """, (parent_id,),
            )
            rows = _rows(cursor)
            expected = [row["id"] for row in rows]
            if not (len(expected) <= 256 and len(set(expected)) == len(expected)
                    and all(valid_id(value) for value in expected)
                    and all(row["disposition"] in {"completed", "failed", "cancelled"} for row in rows)
                    and set(expected) == set(collected)):
                return False
            cursor.execute(
                """
                SELECT work.id, attempt.insurer_name, attempt.tracking_key
                FROM piles_auto_assignment_insurer_runs run
                JOIN piles_auto_assignment_attempts attempt ON attempt.insurer_run_id = run.id
                LEFT JOIN piles_auto_assignment_work_items work
                  ON work.covered_by_insurer_run_id = run.id
                  AND work.parent_runner_run_id = run.runner_run_id
                  AND work.disposition IN ('completed', 'failed', 'cancelled')
                WHERE run.runner_run_id = %s
                  AND attempt.status IN ('confirmed_visible', 'confirmed_reconciled')
                ORDER BY run.id, attempt.id LIMIT 10001
                """, (parent_id,),
            )
            confirmations = _rows(cursor)
        fingerprints = [notification_fingerprint(row["id"], row["insurer_name"], row["tracking_key"])
                        for row in confirmations]
        return (len(fingerprints) <= 10000 and "" not in fingerprints
                and len(set(fingerprints)) == len(fingerprints)
                and set(fingerprints) == supplied_fingerprints)


class ExecutionLedger:
    """Owns a non-autocommit PostgreSQL connection for ledger transactions."""

    def __init__(self, connection: Any) -> None:
        self.connection = connection

    def close(self) -> None:
        close = getattr(self.connection, "close", None)
        if callable(close):
            close()

    def try_acquire_insurer_lock(self, insurer_name: str) -> bool:
        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))",
                (f"piles-insurer:{_insurer_lock_key(insurer_name)}",),
            )
            row = cursor.fetchone()
        return bool(row and row[0])

    def mark_coalesced_request(self, insurer_name: str, runner_run_id: str) -> str:
        request_id = str(uuid.uuid4())
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO piles_auto_assignment_schedule_requests
                        (id, insurer_name, requested_runner_run_id, status)
                    VALUES (%s, %s, %s, 'pending')
                    ON CONFLICT (lower(insurer_name)) WHERE status = 'pending'
                    DO UPDATE SET updated_at = piles_auto_assignment_schedule_requests.updated_at
                    RETURNING id
                    """,
                    (request_id, insurer_name, runner_run_id or None),
                )
                row = cursor.fetchone()
            self.connection.commit()
            return str(row[0])
        except Exception:
            self.connection.rollback()
            raise

    def claim_coalesced_request(self, insurer_name: str, runner_run_id: str) -> bool:
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    WITH candidate AS (
                      SELECT id FROM piles_auto_assignment_schedule_requests
                      WHERE lower(insurer_name) = lower(%s) AND status = 'pending'
                      ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
                    )
                    UPDATE piles_auto_assignment_schedule_requests request
                    SET status = 'claimed', claimed_by_runner_run_id = %s,
                        claimed_at = now(), updated_at = now()
                    FROM candidate WHERE request.id = candidate.id
                    RETURNING request.id
                    """,
                    (insurer_name, runner_run_id or None),
                )
                row = cursor.fetchone()
            self.connection.commit()
            return bool(row)
        except Exception:
            self.connection.rollback()
            raise

    def create_insurer_run(self, runner_run_id: str, master: Any) -> str:
        insurer_run_id = str(uuid.uuid4())
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO piles_auto_assignment_insurer_runs
                    (id, runner_run_id, master_account_id, insurer_name,
                     status, phase, heartbeat_at, started_at)
                VALUES (%s, %s, %s, %s, 'running', 'configuration', now(), now())
                """,
                (
                    insurer_run_id,
                    runner_run_id or None,
                    _value(master, "id"),
                    _value(master, "insurer_name", ""),
                ),
            )
        self.connection.commit()
        return insurer_run_id

    def create_scan_contexts(
        self,
        insurer_run_id: str,
        contexts: Iterable[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        created = []
        try:
            with self.connection.cursor() as cursor:
                for context in contexts:
                    item = dict(context)
                    item.setdefault("id", str(uuid.uuid4()))
                    item["insurer_run_id"] = insurer_run_id
                    cursor.execute(
                        """
                        INSERT INTO piles_auto_assignment_scan_contexts
                            (id, insurer_run_id, insurer_name, filter_month,
                             requested_year, effective_years, status_bucket)
                        VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                        ON CONFLICT (insurer_run_id, filter_month, requested_year, status_bucket)
                        DO UPDATE SET updated_at = piles_auto_assignment_scan_contexts.updated_at
                        RETURNING id
                        """,
                        (
                            item["id"],
                            insurer_run_id,
                            item["insurer_name"],
                            item["filter_month"],
                            item["requested_year"],
                            _json(item.get("effective_years", [])),
                            item["status_bucket"],
                        ),
                    )
                    existing = cursor.fetchone()
                    if existing:
                        item["id"] = existing[0]
                    created.append(item)
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        return created

    def start_scan_context(self, context_id: str) -> None:
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE piles_auto_assignment_scan_contexts
                    SET status = 'scanning', started_at = now(), updated_at = now()
                    WHERE id = %s AND status = 'pending'
                    """,
                    (context_id,),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def finish_scan_context(self, context_id: str, result: Any, evidence: Any = None) -> None:
        status = _value(result, "status")
        status_value = _value(status, "value", status)
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE piles_auto_assignment_scan_contexts
                    SET status = %s,
                        page_count = %s,
                        distinct_pile_count = %s,
                        unassigned_pile_count = %s,
                        claim_count = %s,
                        ui_evidence = %s::jsonb,
                        network_evidence = %s::jsonb,
                        table_evidence = %s::jsonb,
                        settled_at = now(), finished_at = now(), updated_at = now()
                    WHERE id = %s
                    """,
                    (
                        status_value,
                        int(_value(result, "page_count", 0) or 0),
                        int(_value(result, "distinct_pile_count", 0) or 0),
                        int(_value(result, "unassigned_pile_count", 0) or 0),
                        int(_value(result, "claim_count", 0) or 0),
                        _json({
                            "month_matches": _value(evidence, "month_matches"),
                            "year_matches": _value(evidence, "year_matches"),
                            "status_matches": _value(evidence, "status_matches"),
                        }),
                        _json({
                            "state": _value(evidence, "network_state"),
                            "details": _value(evidence, "details", {}).get("network", {})
                            if isinstance(_value(evidence, "details", {}), Mapping)
                            else {},
                        }),
                        _json({
                            "state": _value(evidence, "table_state"),
                            "page_fingerprints": _value(result, "page_fingerprints", ()),
                        }),
                        context_id,
                    ),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def fail_scan_context(self, context_id: str, *, error_code: str, error_message: str) -> None:
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE piles_auto_assignment_scan_contexts
                    SET status = 'failed', error_code = %s, error_message = %s,
                        finished_at = now(), updated_at = now()
                    WHERE id = %s
                    """,
                    (error_code, str(error_message)[:2000], context_id),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def create_batch_with_attempts(
        self,
        batch: Mapping[str, Any],
        attempts: Iterable[Mapping[str, Any]],
    ) -> str:
        batch_id = str(batch.get("id") or uuid.uuid4())
        attempt_rows = list(attempts)
        insurer_run_id = str(batch["insurer_run_id"])
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO piles_auto_assignment_batches
                        (id, insurer_run_id, scan_context_id, insurer_name,
                         bot_account_id, intended_owner_name,
                         intended_portal_assignee, assignment_type, status_bucket,
                         planned_pile_count, planned_claim_count, attempt_count, details)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        batch_id,
                        insurer_run_id,
                        batch.get("scan_context_id"),
                        batch["insurer_name"],
                        batch.get("bot_account_id"),
                        batch["intended_owner_name"],
                        batch["intended_portal_assignee"],
                        batch["assignment_type"],
                        batch["status_bucket"],
                        len(attempt_rows),
                        int(batch.get("planned_claim_count") or 0),
                        len(attempt_rows),
                        _json(batch.get("details")),
                    ),
                )
                for attempt in attempt_rows:
                    cursor.execute(
                        """
                        INSERT INTO piles_auto_assignment_attempts
                            (id, batch_id, insurer_run_id, tracked_pile_id,
                             insurer_name, tracking_key, last_pile_key,
                             bot_account_id, intended_owner_name,
                             intended_portal_assignee, claim_count,
                             filter_context, attempt_number, evidence_details)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                %s, %s::jsonb, %s, %s::jsonb)
                        """,
                        (
                            attempt.get("id") or str(uuid.uuid4()),
                            batch_id,
                            insurer_run_id,
                            attempt.get("tracked_pile_id"),
                            batch["insurer_name"],
                            attempt["tracking_key"],
                            attempt.get("last_pile_key"),
                            batch.get("bot_account_id"),
                            batch["intended_owner_name"],
                            batch["intended_portal_assignee"],
                            int(attempt.get("claim_count") or 0),
                            _json(attempt.get("filter_context")),
                            int(attempt.get("attempt_number") or 1),
                            _json(attempt.get("evidence_details")),
                        ),
                    )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        return batch_id

    def transition_attempt(
        self,
        attempt_id: str,
        target: AttemptStatus,
        *,
        expected: Iterable[AttemptStatus],
        evidence: Optional[Any] = None,
    ) -> None:
        target_status = AttemptStatus(target)
        expected_statuses = {AttemptStatus(status) for status in expected}
        if not expected_statuses or not all(
            can_transition_attempt(status, target_status) for status in expected_statuses
        ):
            raise ValueError(
                f"Illegal attempt transition to {target_status.value} from "
                f"{sorted(status.value for status in expected_statuses)}"
            )
        evidence_code = _value(evidence, "code")
        evidence_details = _value(evidence, "details", {})
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE piles_auto_assignment_attempts
                    SET status = %s,
                        evidence_code = %s,
                        evidence_details = %s::jsonb,
                        selected_at = CASE WHEN %s = 'selected' THEN now() ELSE selected_at END,
                        submitted_at = CASE WHEN %s = 'submitted' THEN now() ELSE submitted_at END,
                        confirmed_at = CASE WHEN %s IN ('confirmed_visible','confirmed_reconciled') THEN now() ELSE confirmed_at END,
                        updated_at = now()
                    WHERE status = ANY(%s) AND id = %s
                    RETURNING batch_id, status
                    """,
                    (
                        target_status.value,
                        evidence_code,
                        _json(evidence_details),
                        target_status.value,
                        target_status.value,
                        target_status.value,
                        [status.value for status in sorted(expected_statuses, key=lambda item: item.value)],
                        attempt_id,
                    ),
                )
                row = cursor.fetchone()
                if not row:
                    raise ConcurrentStateChange(attempt_id)
                cursor.execute(
                    """
                    UPDATE piles_auto_assignment_batches batch SET
                      selected_pile_count = summary.selected_count,
                      confirmed_pile_count = summary.confirmed_count,
                      pending_pile_count = summary.pending_count,
                      conflict_pile_count = summary.conflict_count,
                      failed_pile_count = summary.failed_count,
                      status = CASE
                        WHEN summary.conflict_count > 0 OR summary.failed_count > 0 THEN 'failed'
                        WHEN summary.confirmed_count = summary.total_count THEN 'confirmed'
                        WHEN summary.confirmed_count > 0 THEN 'partially_confirmed'
                        WHEN summary.pending_count > 0 THEN 'reconciliation_pending'
                        WHEN summary.submitted_count > 0 THEN 'submitted'
                        WHEN summary.selected_count > 0 THEN 'selected'
                        ELSE 'planned'
                      END,
                      submitted_at = CASE WHEN summary.submitted_count > 0 THEN coalesce(batch.submitted_at, now()) ELSE batch.submitted_at END,
                      finished_at = CASE WHEN summary.terminal_count = summary.total_count THEN now() ELSE NULL END,
                      updated_at = now()
                    FROM (
                      SELECT batch_id, count(*) total_count,
                        count(*) FILTER (WHERE status <> 'planned') selected_count,
                        count(*) FILTER (WHERE status IN ('submitted','confirmed_visible','confirmed_reconciled','reconciliation_pending','still_unassigned','manual_action_required','conflict','failed')) submitted_count,
                        count(*) FILTER (WHERE status IN ('confirmed_visible','confirmed_reconciled')) confirmed_count,
                        count(*) FILTER (WHERE status IN ('reconciliation_pending','still_unassigned')) pending_count,
                        count(*) FILTER (WHERE status = 'conflict') conflict_count,
                        count(*) FILTER (WHERE status = 'failed') failed_count,
                        count(*) FILTER (WHERE status IN ('confirmed_visible','confirmed_reconciled','manual_action_required','conflict','failed')) terminal_count
                      FROM piles_auto_assignment_attempts WHERE batch_id = %s GROUP BY batch_id
                    ) summary
                    WHERE batch.id = summary.batch_id
                    """,
                    (row[0],),
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def pending_attempts(self, insurer_name: str) -> list[dict[str, Any]]:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, insurer_run_id, batch_id, tracking_key, last_pile_key,
                       intended_portal_assignee, status, attempt_number, filter_context
                FROM piles_auto_assignment_attempts
                WHERE insurer_name = %s
                  AND status IN ('selected','submitted','reconciliation_pending')
                ORDER BY updated_at, id
                """,
                (insurer_name,),
            )
            columns = [item[0] for item in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def retryable_attempts(self, insurer_name: str, *, max_attempts: int) -> list[dict[str, Any]]:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, insurer_run_id, batch_id, tracking_key, last_pile_key,
                       intended_portal_assignee, status, attempt_number, filter_context
                FROM piles_auto_assignment_attempts
                WHERE insurer_name = %s
                  AND status = 'still_unassigned'
                  AND attempt_number < %s
                ORDER BY updated_at, id
                """,
                (insurer_name, max_attempts),
            )
            columns = [item[0] for item in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def exhausted_attempts(self, insurer_name: str, *, max_attempts: int) -> list[dict[str, Any]]:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, tracking_key, status, attempt_number, filter_context
                FROM piles_auto_assignment_attempts
                WHERE insurer_name = %s
                  AND status = 'still_unassigned'
                  AND attempt_number >= %s
                ORDER BY updated_at, id
                """,
                (insurer_name, max_attempts),
            )
            columns = [item[0] for item in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def unsubmitted_plans(self, insurer_name: str) -> list[dict[str, Any]]:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, tracking_key, status, attempt_number, filter_context
                FROM piles_auto_assignment_attempts
                WHERE insurer_name = %s AND status = 'planned'
                ORDER BY updated_at, id
                """,
                (insurer_name,),
            )
            columns = [item[0] for item in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def heartbeat(self, insurer_run_id: str, *, phase: str) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE piles_auto_assignment_insurer_runs
                SET phase = %s, heartbeat_at = now(), updated_at = now()
                WHERE id = %s AND status = 'running'
                """,
                (phase, insurer_run_id),
            )
        self.connection.commit()

    def finalize_insurer_run(
        self,
        insurer_run_id: str,
        *,
        status: str,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        performance: Optional[list] = None,
    ) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                WITH context_summary AS (
                  SELECT coalesce(sum(distinct_pile_count), 0) discovered_piles,
                         coalesce(sum(claim_count), 0) discovered_claims
                  FROM piles_auto_assignment_scan_contexts WHERE insurer_run_id = %s
                ), attempt_summary AS (
                  SELECT count(*) planned_piles, coalesce(sum(claim_count), 0) planned_claims,
                    count(*) FILTER (WHERE status IN ('submitted','confirmed_visible','confirmed_reconciled','reconciliation_pending','still_unassigned','manual_action_required','conflict','failed')) submitted_piles,
                    coalesce(sum(claim_count) FILTER (WHERE status IN ('submitted','confirmed_visible','confirmed_reconciled','reconciliation_pending','still_unassigned','manual_action_required','conflict','failed')), 0) submitted_claims,
                    count(*) FILTER (WHERE status IN ('confirmed_visible','confirmed_reconciled')) confirmed_piles,
                    coalesce(sum(claim_count) FILTER (WHERE status IN ('confirmed_visible','confirmed_reconciled')), 0) confirmed_claims,
                    count(*) FILTER (WHERE status = 'reconciliation_pending') pending_piles,
                    coalesce(sum(claim_count) FILTER (WHERE status = 'reconciliation_pending'), 0) pending_claims,
                    count(*) FILTER (WHERE status = 'conflict') conflicts,
                    count(*) FILTER (WHERE status = 'failed') failures
                  FROM piles_auto_assignment_attempts WHERE insurer_run_id = %s
                )
                UPDATE piles_auto_assignment_insurer_runs run SET
                  discovered_pile_count = context_summary.discovered_piles,
                  discovered_claim_count = context_summary.discovered_claims,
                  planned_pile_count = attempt_summary.planned_piles,
                  planned_claim_count = attempt_summary.planned_claims,
                  submitted_pile_count = attempt_summary.submitted_piles,
                  submitted_claim_count = attempt_summary.submitted_claims,
                  confirmed_pile_count = attempt_summary.confirmed_piles,
                  confirmed_claim_count = attempt_summary.confirmed_claims,
                  reconciliation_pending_pile_count = attempt_summary.pending_piles,
                  reconciliation_pending_claim_count = attempt_summary.pending_claims,
                  conflict_pile_count = attempt_summary.conflicts,
                  failed_pile_count = attempt_summary.failures
                FROM context_summary, attempt_summary WHERE run.id = %s
                """,
                (insurer_run_id, insurer_run_id, insurer_run_id),
            )
            cursor.execute(
                """
                UPDATE piles_auto_assignment_insurer_runs
                SET status = %s, phase = 'complete', error_code = %s,
                    error_message = %s, heartbeat_at = now(), finished_at = now(),
                    details = jsonb_set(coalesce(details, '{}'::jsonb), '{performance}', %s::jsonb),
                    updated_at = now()
                WHERE id = %s
                """,
                (status, error_code, error_message, json.dumps(sanitize_performance(performance)), insurer_run_id),
            )
        self.connection.commit()

    def summarize_insurer_run(self, insurer_run_id: str) -> dict[str, int]:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    count(*) FILTER (WHERE status IN ('confirmed_visible','confirmed_reconciled')) AS confirmed,
                    count(*) FILTER (WHERE status = 'reconciliation_pending') AS reconciliation_pending,
                    count(*) FILTER (WHERE status = 'conflict') AS conflict,
                    count(*) FILTER (WHERE status = 'failed') AS failed,
                    count(*) FILTER (WHERE status = 'submitted') AS submitted,
                    count(*) FILTER (WHERE status = 'manual_action_required') AS manual_action_required
                FROM piles_auto_assignment_attempts
                WHERE insurer_run_id = %s
                """,
                (insurer_run_id,),
            )
            row = cursor.fetchone() or (0, 0, 0, 0, 0, 0)
        return {
            "confirmed": int(row[0] or 0),
            "reconciliation_pending": int(row[1] or 0),
            "conflict": int(row[2] or 0),
            "failed": int(row[3] or 0),
            "submitted": int(row[4] or 0),
            "manual_action_required": int(row[5] or 0),
        }


class ReadOnlyExecutionLedger:
    """Interface-compatible ledger that intentionally performs no writes."""

    write_count = 0

    def try_acquire_insurer_lock(self, _insurer_name: str) -> bool:
        return True

    def mark_coalesced_request(self, _insurer_name: str, _runner_run_id: str) -> str:
        return ""

    def claim_coalesced_request(self, _insurer_name: str, _runner_run_id: str) -> bool:
        return False

    def create_insurer_run(self, _runner_run_id: str, _master: Any) -> str:
        return str(uuid.uuid4())

    def create_scan_contexts(self, insurer_run_id: str, contexts: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
        return [
            {**dict(context), "id": str(context.get("id") or uuid.uuid4()), "insurer_run_id": insurer_run_id}
            for context in contexts
        ]

    def create_batch_with_attempts(self, batch: Mapping[str, Any], _attempts: Iterable[Mapping[str, Any]]) -> str:
        return str(batch.get("id") or uuid.uuid4())

    def start_scan_context(self, _context_id: str) -> None:
        return None

    def finish_scan_context(self, _context_id: str, _result: Any, _evidence: Any = None) -> None:
        return None

    def fail_scan_context(self, _context_id: str, *, error_code: str, error_message: str) -> None:
        del error_code, error_message

    def transition_attempt(self, _attempt_id: str, _target: AttemptStatus, *, expected: Iterable[AttemptStatus], evidence: Optional[Any] = None) -> None:
        del expected, evidence

    def pending_attempts(self, _insurer_name: str) -> list[dict[str, Any]]:
        return []

    def retryable_attempts(self, _insurer_name: str, *, max_attempts: int) -> list[dict[str, Any]]:
        del max_attempts
        return []

    def exhausted_attempts(self, _insurer_name: str, *, max_attempts: int) -> list[dict[str, Any]]:
        del max_attempts
        return []

    def unsubmitted_plans(self, _insurer_name: str) -> list[dict[str, Any]]:
        return []

    def heartbeat(self, _insurer_run_id: str, *, phase: str) -> None:
        del phase

    def finalize_insurer_run(self, _insurer_run_id: str, *, status: str, error_code: Optional[str] = None, error_message: Optional[str] = None, performance: Optional[list] = None) -> None:
        del status, error_code, error_message, performance

    def summarize_insurer_run(self, _insurer_run_id: str) -> dict[str, int]:
        return {"confirmed": 0, "reconciliation_pending": 0, "conflict": 0, "failed": 0}

    def close(self) -> None:
        return None
