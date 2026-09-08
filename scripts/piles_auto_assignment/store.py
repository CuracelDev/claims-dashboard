"""Transactional persistence for durable Piles execution state."""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, is_dataclass
from typing import Any, Iterable, Mapping, Optional

from .domain import AttemptStatus, can_transition_attempt


class ConcurrentStateChange(RuntimeError):
    """Raised when another worker changed an attempt before our CAS update."""


def _value(record: Any, name: str, default: Any = None) -> Any:
    if isinstance(record, Mapping):
        return record.get(name, default)
    return getattr(record, name, default)


def _json(value: Any) -> str:
    if is_dataclass(value):
        value = asdict(value)
    return json.dumps(value or {}, default=str, sort_keys=True)


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
                (f"piles-insurer:{str(insurer_name).strip().lower()}",),
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
                    updated_at = now()
                WHERE id = %s
                """,
                (status, error_code, error_message, insurer_run_id),
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
                    count(*) FILTER (WHERE status = 'failed') AS failed
                FROM piles_auto_assignment_attempts
                WHERE insurer_run_id = %s
                """,
                (insurer_run_id,),
            )
            row = cursor.fetchone() or (0, 0, 0, 0)
        return {
            "confirmed": int(row[0] or 0),
            "reconciliation_pending": int(row[1] or 0),
            "conflict": int(row[2] or 0),
            "failed": int(row[3] or 0),
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

    def finalize_insurer_run(self, _insurer_run_id: str, *, status: str, error_code: Optional[str] = None, error_message: Optional[str] = None) -> None:
        del status, error_code, error_message

    def summarize_insurer_run(self, _insurer_run_id: str) -> dict[str, int]:
        return {"confirmed": 0, "reconciliation_pending": 0, "conflict": 0, "failed": 0}

    def close(self) -> None:
        return None
