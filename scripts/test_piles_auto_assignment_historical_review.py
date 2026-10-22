"""Historical review must never turn disappearance into assignment success."""
import unittest
from datetime import datetime, timedelta, timezone
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

from scripts.test_piles_auto_assignment_dispatch_integration import runner
from scripts import review_piles_historical_assignments as review


NOW = datetime(2026, 10, 22, 15, tzinfo=timezone.utc)


def attempt(**changes):
    return {"id": "attempt-1", "status": "manual_action_required",
            "insurer_name": "DEFMIS", "tracking_key": "old-key", "last_pile_key": "old-row",
            "intended_portal_assignee": "CVEBOT1", "updated_at": NOW - timedelta(hours=1),
            "submitted_at": NOW - timedelta(hours=1), "claim_count": 2,
            "evidence_details": {"portal_identity_hash": "a" * 64}, **changes}


def row(**changes):
    return replace(runner.PileRow(
        key="new-row", tracking_key="new-key", provider="Synthetic provider", claims=2,
        synced_claims=0, remaining_claims=2, amount_text="", month="June 2025",
        submitted_date="2025-06-01", status="Vetting Ongoing", assigned="CVEBOT1",
        status_bucket="Vetting Ongoing", page_number=1, assignment_type="Vetting",
        filter_month="All", filter_year="All", portal_identity_hash="a" * 64,
    ), **changes)


class HistoricalReviewTests(unittest.TestCase):
    def test_real_scanner_blocks_conflicting_rows_before_classification(self):
        from scripts.piles_auto_assignment.scanning import ScanAccumulator, TrackingKeyCollision
        scan = ScanAccumulator()
        scan.observe_page(1, [row(), row(assigned="Other")])
        with self.assertRaises(TrackingKeyCollision):
            self.classify(scan.finish().rows)

    def test_postcommit_cleanup_error_reports_known_confirmation(self):
        def completed_then_failed(args, api, committed):
            committed["attempt_id"] = "attempt-1"
            raise RuntimeError("private cleanup details")
        with patch.object(review, "_audit", side_effect=completed_then_failed):
            report = review.audit(None, None)
        self.assertEqual(report["attempts_confirmed"], 1)
        self.assertEqual(report["warning"], "confirmation_committed_followup_failed")
        self.assertNotIn("private", str(report))

    def test_precommit_error_is_not_reported_as_confirmation(self):
        with patch.object(review, "_audit", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                review.audit(None, None)

    def classify(self, rows, candidate=None, **changes):
        return review.classify_attempt(candidate or attempt(), rows,
            match_rows=runner.rows_matching_attempt_identity,
            scan_started_at=NOW, observed_at=NOW + timedelta(minutes=1),
            now=changes.pop("now", NOW + timedelta(minutes=1)),
            complete=changes.pop("complete", True), **changes)

    def test_stable_identity_follows_changed_filter_keys(self):
        self.assertEqual(self.classify([row()])["outcome"], "expected_owner")

    def test_missing_is_not_success_or_retry(self):
        self.assertEqual(self.classify([])["outcome"], "missing")

    def test_unassigned_requires_positive_observation(self):
        result = self.classify([row(assigned="")])
        self.assertEqual(result["outcome"], "positively_unassigned")
        self.assertFalse(result["can_confirm"])

    def test_different_owner_is_never_confirmed(self):
        self.assertEqual(self.classify([row(assigned="Other")])["outcome"], "different_owner")

    def test_conflicting_observations_fail_closed(self):
        self.assertEqual(self.classify([row(), row(assigned="Other")])["outcome"], "ambiguous")

    def test_blank_and_assigned_observations_require_recheck(self):
        self.assertEqual(self.classify([row(), row(assigned="")])["outcome"], "ambiguous")

    def test_incomplete_scan_never_confirms(self):
        self.assertEqual(self.classify([row()], complete=False)["outcome"], "incomplete_scan")

    def test_stale_scan_never_confirms(self):
        self.assertEqual(self.classify([row()], now=NOW + timedelta(minutes=30))["outcome"], "stale_scan")

    def test_changed_attempt_requires_new_scan(self):
        self.assertEqual(self.classify([row()], attempt(updated_at=NOW + timedelta(seconds=1)))["outcome"], "attempt_changed")

    def test_pre_submission_failure_cannot_become_runner_confirmation(self):
        result = self.classify([row()], attempt(status="failed", submitted_at=None))
        self.assertEqual(result["outcome"], "expected_owner")
        self.assertFalse(result["can_confirm"])

    def test_later_identity_attempt_prevents_old_confirmation(self):
        result = self.classify([row()], attempt(later_identity_attempt=True))
        self.assertEqual(result["outcome"], "later_attempt_exists")
        self.assertFalse(result["can_confirm"])

    def test_invalid_or_future_submission_never_qualifies_for_confirmation(self):
        for submitted in ("not-a-date", NOW + timedelta(minutes=1), NOW.replace(tzinfo=None)):
            with self.subTest(submitted=submitted):
                self.assertFalse(self.classify([row()], attempt(submitted_at=submitted))["can_confirm"])

    def test_report_does_not_expose_owner_provider_or_identity(self):
        report = self.classify([row()])
        self.assertEqual(set(report), {"attempt_id", "status", "outcome", "identity_method", "can_confirm"})
        self.assertNotIn("CVEBOT", str(report))
        self.assertNotIn("Synthetic", str(report))

    def test_candidate_limit_fails_instead_of_truncating(self):
        with self.assertRaisesRegex(ValueError, "candidate_limit_exceeded"):
            review.validate_candidates([attempt(), attempt(id="attempt-2")], limit=1)

    def test_cli_rejects_bulk_apply_and_unbounded_queries(self):
        for args in (["--insurer", "DEFMIS", "--apply"],
                     ["--insurer", "DEFMIS", "--hours", "0"],
                     ["--insurer", "DEFMIS", "--limit", "100000"]):
            with self.subTest(args=args), self.assertRaises(SystemExit):
                review.parse_args(args)

    def test_confirmation_requires_exact_target_and_explicit_phrase(self):
        for extra in (["--confirm-attempt", "attempt-1"],
                      ["--confirmation", "CONFIRM_HISTORICAL_OWNERSHIP"]):
            with self.assertRaises(SystemExit):
                review.parse_args(["--insurer", "DEFMIS", *extra])
        parsed = review.parse_args(["--insurer", "DEFMIS", "--confirm-attempt", "attempt-1",
                                    "--confirmation", "CONFIRM_HISTORICAL_OWNERSHIP"])
        self.assertEqual(parsed.confirm_attempt, "attempt-1")

    def test_context_coverage_requires_every_context_complete(self):
        from types import SimpleNamespace
        from scripts.piles_auto_assignment.domain import ContextStatus
        self.assertFalse(review.complete_scan({}))
        self.assertFalse(review.complete_scan({"one": SimpleNamespace(status=ContextStatus.PENDING)}))
        self.assertTrue(review.complete_scan({"one": SimpleNamespace(status=ContextStatus.COMPLETE)}))


class AuditBoundaryTests(unittest.TestCase):
    def fixture(self, *, lock=True, slot=0, changed=False, incomplete=False, overflow=False):
        events = []
        candidate = attempt(updated_at=NOW, submitted_at=NOW)
        class Store:
            mode = "postgres"
            calls = 0
            def __init__(self, *, read_only):
                if read_only is not True:
                    raise AssertionError("audit opened writable connection")
            def get_master_account(self, insurer):
                return SimpleNamespace(insurer_name=insurer, is_active=True, login_email="private", login_password="secret")
            def try_acquire_insurer_lock(self, insurer):
                return lock
            def try_acquire_runner_slot(self, maximum):
                return slot
            def release_insurer_lock(self, insurer):
                events.append("insurer_released")
            def release_runner_slot(self, slot):
                events.append("capacity_released")
            def close(self):
                events.append("closed")
            def _fetchall_postgres(self, sql, params):
                self.calls += 1
                if overflow:
                    return [candidate, {**candidate, "id": "attempt-2"}]
                if changed and self.calls == 2:
                    return []
                return [candidate]
        class Browser:
            def __init__(self, **kwargs):
                events.append("browser")
                self.initial_scan_results = {"context": SimpleNamespace(
                    status=runner.ContextStatus.PENDING if incomplete else runner.ContextStatus.COMPLETE)}
            def __enter__(self):
                return self
            def __exit__(self, *_):
                events.append("browser_closed")
            def login(self, email, password):
                pass
            def select_account(self, insurer):
                pass
            def open_piles(self):
                pass
            def scan_all_rows(self, months, year):
                if months != ["All"] or year != "All":
                    raise AssertionError("incomplete requested scope")
                return [row()]
        api = SimpleNamespace(DataStore=Store, CuracelPilesRunner=Browser,
            configure_portal_environment=lambda env: events.append(env),
            configured_max_concurrency=lambda: 2, ReadOnlyExecutionLedger=runner.ReadOnlyExecutionLedger,
            rows_matching_attempt_identity=runner.rows_matching_attempt_identity)
        return api, events

    def test_audit_does_not_write_or_assign_and_releases_locks(self):
        api, events = self.fixture()
        report = review.audit(review.parse_args(["--insurer", "DEFMIS"]), api)
        self.assertEqual(report["outcomes"], {"expected_owner": 1})
        self.assertEqual(report["attempts_confirmed"], 0)
        self.assertEqual(report["assignments_submitted"], 0)
        self.assertEqual(events[-3:], ["capacity_released", "insurer_released", "closed"])

    def test_busy_capacity_never_opens_browser_and_releases_insurer(self):
        api, events = self.fixture(slot=-1)
        with self.assertRaisesRegex(ValueError, "capacity_busy"):
            review.audit(review.parse_args(["--insurer", "DEFMIS"]), api)
        self.assertNotIn("browser", events)
        self.assertEqual(events[-2:], ["insurer_released", "closed"])

    def test_busy_insurer_never_opens_browser_or_unlocks_foreign_lock(self):
        api, events = self.fixture(lock=False)
        with self.assertRaisesRegex(ValueError, "insurer_busy"):
            review.audit(review.parse_args(["--insurer", "DEFMIS"]), api)
        self.assertEqual(events, ["production", "closed"])

    def test_overflow_releases_locks_without_scanning_partial_candidates(self):
        api, events = self.fixture(overflow=True)
        with self.assertRaisesRegex(ValueError, "candidate_limit_exceeded"):
            review.audit(review.parse_args(["--insurer", "DEFMIS", "--limit", "1"]), api)
        self.assertNotIn("browser", events)
        self.assertEqual(events[-3:], ["capacity_released", "insurer_released", "closed"])

    def test_concurrent_attempt_change_cannot_be_confirmed(self):
        api, _ = self.fixture(changed=True)
        result = review.audit(review.parse_args(["--insurer", "DEFMIS"]), api)
        self.assertEqual(result["outcomes"], {"attempt_changed": 1})

    def test_incomplete_browser_scan_never_confirms(self):
        api, _ = self.fixture(incomplete=True)
        result = review.audit(review.parse_args(["--insurer", "DEFMIS"]), api)
        self.assertFalse(result["scan_complete"])
        self.assertEqual(result["outcomes"], {"incomplete_scan": 1})


if __name__ == "__main__":
    unittest.main()
