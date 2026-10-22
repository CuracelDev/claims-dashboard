#!/usr/bin/env python3
"""Non-assigning historical ownership review. Never infer success from absence."""
from datetime import datetime, timedelta, timezone
import argparse
from collections import Counter
from contextlib import redirect_stdout, redirect_stderr
import json
import os
import re
import uuid


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--insurer", required=True)
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--confirm-attempt")
    parser.add_argument("--confirmation")
    args = parser.parse_args(argv)
    if not args.insurer.strip() or len(args.insurer) > 120:
        parser.error("insurer is required and must be at most 120 characters")
    if not 1 <= args.hours <= 720 or not 1 <= args.limit <= 500:
        parser.error("hours must be 1..720 and limit must be 1..500")
    if args.confirm_attempt or args.confirmation:
        if (not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", args.confirm_attempt or "")
                or args.confirmation != "CONFIRM_HISTORICAL_OWNERSHIP"):
            parser.error("confirmation requires one exact attempt and CONFIRM_HISTORICAL_OWNERSHIP")
    return args


def validate_candidates(candidates, *, limit):
    if len(candidates) > limit:
        raise ValueError("candidate_limit_exceeded")
    return candidates


def complete_scan(contexts):
    return bool(contexts) and all(str(item.status.value) in {"complete", "empty"} for item in contexts.values())


def load_attempts(store, insurer, hours, limit):
    # Choose latest BEFORE filtering status/time, so superseded failures do not
    # masquerade as current incidents. The portal scope is explicitly production.
    rows = store._fetchall_postgres("""
        WITH scoped AS (
          SELECT a.*
          FROM piles_auto_assignment_attempts a
          JOIN piles_auto_assignment_insurer_runs i ON i.id = a.insurer_run_id
          JOIN piles_auto_assignment_runner_runs r ON r.id = i.runner_run_id
          WHERE a.insurer_name = %s AND r.portal_environment = 'production'
        ), latest AS (
          SELECT DISTINCT ON (a.insurer_name, a.tracking_key) a.* FROM scoped a
          ORDER BY a.insurer_name, a.tracking_key, a.created_at DESC, a.updated_at DESC, a.id DESC
        )
        SELECT id, insurer_name, tracking_key, last_pile_key, intended_portal_assignee,
               status, submitted_at, updated_at, evidence_details, filter_context, claim_count,
               EXISTS (SELECT 1 FROM scoped b WHERE b.id <> a.id
                 AND a.evidence_details ->> 'portal_identity_hash' ~ '^[0-9a-f]{64}$'
                 AND b.evidence_details ->> 'portal_identity_hash' = a.evidence_details ->> 'portal_identity_hash'
                 AND (b.created_at >= a.created_at OR b.updated_at >= a.updated_at)) AS later_identity_attempt
        FROM latest a
        WHERE status IN ('manual_action_required', 'failed', 'conflict', 'still_unassigned')
          AND created_at >= clock_timestamp() - (%s * interval '1 hour')
        ORDER BY created_at, id LIMIT %s
    """, (insurer, hours, limit + 1))
    return validate_candidates(rows, limit=limit)


def owner_key(value):
    return " ".join(str(value or "").casefold().split())


def classify_attempt(attempt, rows, *, match_rows, scan_started_at, observed_at, now, complete):
    result = {"attempt_id": attempt["id"], "status": attempt["status"],
              "outcome": "missing", "identity_method": "none", "can_confirm": False}
    if not complete:
        return {**result, "outcome": "incomplete_scan"}
    times = (scan_started_at, observed_at, now, attempt.get("updated_at"))
    if any(not isinstance(t, datetime) or t.tzinfo is None for t in times):
        return {**result, "outcome": "stale_scan"}
    if not scan_started_at <= observed_at <= now or now - scan_started_at > timedelta(minutes=15):
        return {**result, "outcome": "stale_scan"}
    if attempt["updated_at"] > scan_started_at:
        return {**result, "outcome": "attempt_changed"}
    if attempt.get("later_identity_attempt"):
        return {**result, "outcome": "later_attempt_exists"}
    matched, method = match_rows(rows, attempt)
    result["identity_method"] = method or "none"
    if method.startswith("ambiguous_"):
        return {**result, "outcome": "ambiguous"}
    if not matched:
        return result
    owners = {owner_key(row.assigned) for row in matched}
    if len(owners) != 1:
        return {**result, "outcome": "ambiguous"}
    observed = next(iter(owners))
    if not observed:
        return {**result, "outcome": "positively_unassigned"}
    if not owner_key(attempt.get("intended_portal_assignee")):
        return {**result, "outcome": "ambiguous"}
    if observed != owner_key(attempt["intended_portal_assignee"]):
        return {**result, "outcome": "different_owner"}
    # Weak/display identity and pre-submission observations are audit findings,
    # never grounds to attribute a portal assignment to this runner attempt.
    submitted = attempt.get("submitted_at")
    return {**result, "outcome": "expected_owner", "can_confirm": bool(
        method == "portal_identity_hash" and isinstance(submitted, datetime)
        and submitted.tzinfo is not None and submitted <= scan_started_at
        and attempt["status"] == "manual_action_required"
    )}


def confirm_target(args, api, store, browser, attempts, rows, started, *, committed=None):
    target = next((a for a in attempts if a["id"] == args.confirm_attempt), None)
    if target is None:
        raise ValueError("historical_confirmation_blocked")
    observed = datetime.now(timezone.utc)
    decision = classify_attempt(target, rows, match_rows=api.rows_matching_attempt_identity,
        scan_started_at=started, observed_at=observed, now=observed,
        complete=complete_scan(browser.initial_scan_results))
    if not decision["can_confirm"]:
        raise ValueError("historical_confirmation_blocked")
    matched, _ = api.rows_matching_attempt_identity(rows, target)
    contexts = sorted({(r.filter_month, r.filter_year, r.status_bucket) for r in matched})
    # Never apply a saved report: observe again in the same locked session.
    recheck_started = datetime.now(timezone.utc)
    fresh = browser.scan_selected_statuses(contexts, "All", only_unassigned=False)
    now = datetime.now(timezone.utc)
    fresh_decision = classify_attempt(target, fresh, match_rows=api.rows_matching_attempt_identity,
        scan_started_at=recheck_started, observed_at=now, now=now,
        complete=bool(getattr(browser, "_last_scan_result", None))
                 and browser._last_scan_result.status.value == "complete")
    if not fresh_decision["can_confirm"] or now - recheck_started > timedelta(seconds=60):
        raise ValueError("historical_confirmation_blocked")
    current = next((a for a in load_attempts(store, target["insurer_name"], args.hours, args.limit)
                    if a["id"] == target["id"]), None)
    if current != target:
        raise ValueError("historical_confirmation_blocked")
    matched, _ = api.rows_matching_attempt_identity(fresh, target)
    store.conn.autocommit = False
    try:
        api.ExecutionLedger(store.conn).confirm_historical_attempt(
            expected_attempt=target, observation=matched[0], observed_at=recheck_started)
        if committed is not None:
            committed["attempt_id"] = target["id"]
    finally:
        store.conn.rollback()
        store.conn.autocommit = True


def audit(args, api):
    committed = {}
    try:
        return _audit(args, api, committed)
    except Exception:
        if not committed:
            raise
        # Cleanup/reporting can fail after COMMIT. Do not invite a duplicate
        # repair by misreporting that known committed confirmation as failed.
        return {"mode": "historical_confirmation", "attempts_confirmed": 1,
                "attempt_id": committed["attempt_id"], "assignments_submitted": 0,
                "warning": "confirmation_committed_followup_failed"}


def _audit(args, api, committed):
    api.configure_portal_environment("production")
    store = api.DataStore(read_only=not bool(args.confirm_attempt))
    slot = -1
    locked = False
    try:
        if store.mode != "postgres":
            raise ValueError("postgres_required")
        master = store.get_master_account(args.insurer)
        insurer = master.insurer_name
        if not master.is_active:
            raise ValueError("insurer_inactive")
        locked = store.try_acquire_insurer_lock(insurer)
        if not locked:
            raise ValueError("insurer_busy")
        slot = store.try_acquire_runner_slot(api.configured_max_concurrency())
        if slot < 0:
            raise ValueError("capacity_busy")
        attempts = load_attempts(store, insurer, args.hours, args.limit)
        started = datetime.now(timezone.utc)
        results = []
        contexts = {}
        rows = []
        attempts_confirmed = 0
        if args.confirm_attempt and not attempts:
            raise ValueError("historical_confirmation_blocked")
        if attempts:
            with api.CuracelPilesRunner(visible=False, slow_mo=0) as browser:
                browser.safe_diagnostics = True
                browser.execution_ledger = api.ReadOnlyExecutionLedger()
                browser.insurer_run_id = str(uuid.uuid4())
                browser.insurer_name = insurer
                browser.login(master.login_email, master.login_password)
                browser.select_account(insurer)
                browser.open_piles()
                rows = browser.scan_all_rows(["All"], "All")
                contexts = browser.initial_scan_results
                if args.confirm_attempt:
                    confirm_target(args, api, store, browser, attempts, rows, started, committed=committed)
                    attempts_confirmed = 1
            observed = datetime.now(timezone.utc)
            # Re-read after the browser scan. Even an operator bypassing the
            # insurer lock cannot silently change a reviewed attempt snapshot.
            current = {a["id"]: a for a in load_attempts(store, insurer, args.hours, args.limit)}
            for previous in attempts:
                if attempts_confirmed and previous["id"] == args.confirm_attempt:
                    results.append({"attempt_id": previous["id"], "status": "confirmed_reconciled",
                                    "outcome": "confirmed_reconciled", "identity_method": "portal_identity_hash", "can_confirm": False})
                    continue
                candidate = current.get(previous["id"])
                if candidate is None or candidate != previous:
                    results.append({"attempt_id": previous["id"], "status": previous["status"],
                                    "outcome": "attempt_changed", "identity_method": "none", "can_confirm": False})
                    continue
                results.append(classify_attempt(candidate, rows,
                    match_rows=api.rows_matching_attempt_identity,
                    scan_started_at=started, observed_at=observed,
                    now=datetime.now(timezone.utc), complete=complete_scan(contexts)))
        return {"mode": "historical_confirmation" if args.confirm_attempt else "read_only_historical_review", "insurer": insurer,
                "generated_at": datetime.now(timezone.utc).isoformat(), "window_hours": args.hours,
                "scan_complete": complete_scan(contexts) if attempts else None,
                "candidate_count": len(attempts), "discovered_piles": len(rows),
                "unassigned_piles": sum(not str(row.assigned or "").strip() for row in rows),
                "outcomes": dict(Counter(r["outcome"] for r in results)), "attempts": results,
                "assignments_submitted": 0, "attempts_confirmed": attempts_confirmed}
    finally:
        try:
            if slot >= 0:
                store.release_runner_slot(slot)
        finally:
            try:
                if locked:
                    store.release_insurer_lock(master.insurer_name)
            finally:
                store.close()


def main():
    args = parse_args()
    # Browser diagnostics can contain provider names; only the bounded report
    # escapes this process. No raw exception strings or traceback in shared logs.
    try:
        with open(os.devnull, "w") as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
            try:
                from scripts import piles_auto_assignment_runner as api
            except ModuleNotFoundError:
                import piles_auto_assignment_runner as api
            report = audit(args, api)
    except Exception as error:
        allowed = {"candidate_limit_exceeded", "postgres_required", "insurer_inactive", "insurer_busy", "capacity_busy", "historical_confirmation_blocked"}
        code = str(error) if isinstance(error, ValueError) and str(error) in allowed else "historical_review_failed"
        print(json.dumps({"mode": "historical_confirmation" if args.confirm_attempt else "read_only_historical_review", "error": code}))
        return 1
    print(json.dumps(report, indent=2))
    if report.get("warning"):
        return 1
    return 0 if not report["candidate_count"] or report["scan_complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
