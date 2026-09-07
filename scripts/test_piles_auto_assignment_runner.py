import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path


def load_runner_module():
    """Load pure runner logic without requiring browser/database packages."""
    psycopg2 = types.ModuleType("psycopg2")
    requests = types.ModuleType("requests")
    dotenv = types.ModuleType("dotenv")
    dotenv.load_dotenv = lambda *_args, **_kwargs: None
    playwright = types.ModuleType("playwright")
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.Browser = object
    sync_api.Page = object
    sync_api.TimeoutError = TimeoutError
    sync_api.sync_playwright = lambda: None

    sys.modules["psycopg2"] = psycopg2
    sys.modules["requests"] = requests
    sys.modules["dotenv"] = dotenv
    sys.modules["playwright"] = playwright
    sys.modules["playwright.sync_api"] = sync_api

    os.environ["PILES_PRIMARY_MIN_SHARE"] = "0.6"
    os.environ["PILES_PLANNING_SPEED_FLOOR_RATIO"] = "0.5"

    path = Path(__file__).with_name("piles_auto_assignment_runner.py")
    spec = importlib.util.spec_from_file_location("piles_auto_assignment_runner_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runner = load_runner_module()


def make_bot(bot_id, role, *, ratio=1, active=True, available=True, load=0, priority=100):
    return runner.BotAccount(
        id=bot_id,
        insurer_name="OLD MUTUAL",
        owner_name=bot_id,
        bot_name=bot_id,
        bot_email="",
        bot_password="",
        assignment_role=role,
        support_capacity_ratio=ratio,
        availability_status="available",
        availability_note="",
        active_from_time="09:00",
        active_to_time="",
        shift_grace_minutes=120,
        is_active=active,
        is_available=available,
        current_claim_load=load,
        priority_order=priority,
    )


def make_pile(index, claims=100, *, filter_year="2026"):
    key = f"pile-{index}"
    return runner.PileRow(
        key=key,
        tracking_key=key,
        provider=f"Provider {index}",
        claims=claims,
        synced_claims=0,
        remaining_claims=claims,
        amount_text="1000",
        month="Jul",
        submitted_date="2026-07-01",
        status="Vetting Pending",
        assigned="",
        status_bucket="Vetting Pending",
        page_number=1,
        assignment_type="Vetting",
        filter_month="Jul",
        filter_year=filter_year,
    )


class AssignmentPlanningTests(unittest.TestCase):
    def test_all_years_expand_for_single_select_portal(self):
        self.assertEqual(
            runner.year_scan_labels("All", ["2026", "2025", "2024"], supports_multiple=False),
            ["2026", "2025", "2024"],
        )

    def test_all_years_remain_one_filter_for_multiselect_portal(self):
        self.assertEqual(
            runner.year_scan_labels("All", ["2026", "2025"], supports_multiple=True),
            ["All"],
        )

    def test_specific_year_must_be_available(self):
        self.assertEqual(
            runner.year_scan_labels("2025", ["2026", "2025"], supports_multiple=False),
            ["2025"],
        )
        with self.assertRaisesRegex(RuntimeError, "Requested year '2023'.*2026, 2025"):
            runner.year_scan_labels("2023", ["2026", "2025"], supports_multiple=False)

    def test_year_control_mode_ignores_unsupported_multiple_attribute(self):
        self.assertFalse(
            runner.supports_multiple_year_selection(
                control_classes="p-select p-component",
                control_multiple_attribute=True,
                listbox_aria_multiselectable="",
            )
        )
        self.assertTrue(
            runner.supports_multiple_year_selection(
                control_classes="p-multiselect p-component",
                control_multiple_attribute=False,
                listbox_aria_multiselectable="",
            )
        )
        self.assertTrue(
            runner.supports_multiple_year_selection(
                control_classes="custom-year-picker",
                control_multiple_attribute=False,
                listbox_aria_multiselectable="true",
            )
        )

    def test_low_observed_speed_does_not_starve_support_bot(self):
        bots = [
            make_bot("primary", "primary", ratio=1, priority=1),
            make_bot("support", "support", ratio=0.6, priority=2),
        ]
        metrics = {
            "primary": runner.BotMetric("primary", 35, 0),
            "support": runner.BotMetric("support", 0.1, 0),
        }

        plans, summary = runner.build_assignment_plan(
            "OLD MUTUAL",
            [make_pile(index) for index in range(10)],
            bots,
            metrics,
        )

        self.assertEqual(len(plans), 10)
        self.assertGreaterEqual(summary["primary"]["assigned_claims"], 600)
        self.assertEqual(summary["support"]["assigned_claims"], 200)
        self.assertEqual(sum(item["assigned_claims"] for item in summary.values()), 1000)

    def test_inactive_bot_is_excluded(self):
        bots = [
            make_bot("primary", "primary", priority=1),
            make_bot("support", "support", ratio=0.6, active=False, priority=2),
        ]
        plans, summary = runner.build_assignment_plan(
            "OLD MUTUAL",
            [make_pile(index) for index in range(4)],
            bots,
            {},
        )

        self.assertEqual({plan.assignee_id for plan in plans}, {"primary"})
        self.assertNotIn("support", summary)

    def test_existing_load_is_respected_after_primary_floor(self):
        bots = [
            make_bot("primary", "primary", priority=1),
            make_bot("support", "support", ratio=0.6, priority=2),
        ]
        metrics = {
            "primary": runner.BotMetric("primary", 35, 0),
            "support": runner.BotMetric("support", 20, 1000),
        }

        _plans, summary = runner.build_assignment_plan(
            "OLD MUTUAL",
            [make_pile(index) for index in range(10)],
            bots,
            metrics,
        )

        self.assertEqual(summary["primary"]["assigned_claims"], 1000)
        self.assertEqual(summary["support"]["assigned_claims"], 0)

    def test_assignment_plan_preserves_the_scanned_year(self):
        plans, _summary = runner.build_assignment_plan(
            "OLD MUTUAL",
            [make_pile(1, filter_year="2025")],
            [make_bot("primary", "primary", priority=1)],
            {},
        )

        self.assertEqual(plans[0].filter_year, "2025")

    def test_assignment_contexts_keep_plans_in_their_scanned_year(self):
        plans, _summary = runner.build_assignment_plan(
            "OLD MUTUAL",
            [make_pile(1, filter_year="2026"), make_pile(2, filter_year="2025")],
            [make_bot("primary", "primary", priority=1)],
            {},
        )

        self.assertEqual(
            runner.assignment_filter_contexts(["Jul"], "All", plans),
            [("Jul", "2026"), ("Jul", "2025")],
        )

    def test_pile_year_overrides_the_broad_requested_year(self):
        self.assertEqual(runner.effective_filter_year(make_pile(1, filter_year="2025"), "All"), "2025")

    def test_portal_fallback_uses_same_balancing_rules(self):
        assignees = [
            runner.PortalAssignee("Primary", "primary", 1, 1),
            runner.PortalAssignee("Support", "support", 0.6, 2),
        ]

        plans, summary = runner.build_assignment_plan_from_portal_options(
            "OLD MUTUAL",
            [make_pile(index) for index in range(10)],
            assignees,
        )

        self.assertEqual(len(plans), 10)
        self.assertGreater(summary["Support"]["assigned_claims"], 0)
        self.assertGreaterEqual(summary["Primary"]["assigned_claims"], 600)
        self.assertEqual(sum(item["assigned_claims"] for item in summary.values()), 1000)

    def test_weekend_roles_have_exactly_one_primary(self):
        bots = [
            make_bot("one", "support", priority=20),
            make_bot("two", "support", priority=10),
            make_bot("three", "primary", priority=30),
        ]
        normalized = runner.normalize_weekend_primary_roles(bots)

        primary_ids = [bot.id for bot in normalized if bot.assignment_role == "primary"]
        self.assertEqual(primary_ids, ["three"])

    def test_old_mutual_aliases_are_equivalent(self):
        self.assertEqual(runner.canonical_insurer_key("UAPOM"), "OLD MUTUAL")
        self.assertEqual(runner.canonical_insurer_key("OLD MUTUAL"), "OLD MUTUAL")
        self.assertIn("old mutual", runner.insurer_aliases("UAPOM"))

    def test_only_explicit_false_disables_legacy_rows(self):
        self.assertTrue(runner.enabled_by_default(None))
        self.assertTrue(runner.enabled_by_default(True))
        self.assertFalse(runner.enabled_by_default(False))


class WeekendRestoreTests(unittest.TestCase):
    def test_restore_does_not_overwrite_manual_active_state(self):
        store = object.__new__(runner.DataStore)
        store.mode = "postgres"
        store._fetchall_postgres = lambda *_args, **_kwargs: [{
            "id": "snapshot-1",
            "bot_account_id": "bot-1",
            "previous_assignment_role": "primary",
            "previous_availability_status": "available",
            "previous_availability_note": None,
            "previous_is_available": True,
            "previous_is_active": True,
        }]
        executions = []
        store._execute_postgres = lambda sql, params=(): executions.append((sql, params))

        restored = store.restore_due_weekend_bot_states("2026-07-06")

        self.assertEqual(len(restored), 1)
        bot_update_sql, _params = executions[0]
        self.assertNotIn("is_active =", bot_update_sql)


class YearFilterScanningTests(unittest.TestCase):
    def make_runner(self, *, supports_multiple, available_years):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.year_filter_capabilities = lambda: (supports_multiple, available_years)
        portal_runner.calls = []

        def scan_status(month_label, year_label, status_label, **_kwargs):
            portal_runner.calls.append((month_label, year_label, status_label))
            pile = make_pile(len(portal_runner.calls))
            pile.key = f"{year_label}-{status_label}"
            pile.tracking_key = pile.key
            pile.filter_year = ""
            return [pile]

        portal_runner.scan_status = scan_status
        return portal_runner

    def test_all_years_scan_each_year_for_single_select_portal(self):
        portal_runner = self.make_runner(
            supports_multiple=False,
            available_years=["2026", "2025"],
        )

        rows = runner.CuracelPilesRunner.scan_all_rows(portal_runner, ["All"], "All")

        self.assertEqual(len(rows), 10)
        self.assertEqual({row.filter_year for row in rows}, {"2026", "2025"})
        self.assertEqual(
            portal_runner.calls,
            [
                ("All", "2026", "Vetting Pending"),
                ("All", "2026", "Vetting Ongoing"),
                ("All", "2026", "Audit Pending"),
                ("All", "2026", "Audit Ongoing"),
                ("All", "2026", "AI Audit"),
                ("All", "2025", "Vetting Pending"),
                ("All", "2025", "Vetting Ongoing"),
                ("All", "2025", "Audit Pending"),
                ("All", "2025", "Audit Ongoing"),
                ("All", "2025", "AI Audit"),
            ],
        )

    def test_all_years_scan_once_for_legacy_multiselect_portal(self):
        portal_runner = self.make_runner(
            supports_multiple=True,
            available_years=["2026", "2025"],
        )

        runner.CuracelPilesRunner.scan_all_rows(portal_runner, ["All"], "All")

        self.assertEqual(
            portal_runner.calls,
            [
                ("All", "All", "Vetting Pending"),
                ("All", "All", "Vetting Ongoing"),
                ("All", "All", "Audit Pending"),
                ("All", "All", "Audit Ongoing"),
                ("All", "All", "AI Audit"),
            ],
        )

    def test_reset_page_preserves_year_context_on_returned_rows(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.open_piles = lambda: None
        portal_runner.apply_filters = lambda *_args: None
        portal_runner.try_set_page_size = lambda *_args: None
        portal_runner.goto_next_page = lambda: False
        received = []

        def rows_on_current_page(*args):
            received.append(args)
            return []

        portal_runner.rows_on_current_page = rows_on_current_page

        runner.CuracelPilesRunner.reset_to_filtered_page(
            portal_runner,
            "All",
            "2025",
            "Vetting Pending",
            1,
        )

        self.assertEqual(received, [("Vetting Pending", 1, "All", "2025")])

    def test_follow_up_scan_uses_each_context_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.calls = []

        def scan_status(month_label, year_label, status_label, **_kwargs):
            portal_runner.calls.append((month_label, year_label, status_label))
            return []

        portal_runner.scan_status = scan_status

        runner.CuracelPilesRunner.scan_selected_statuses(
            portal_runner,
            [
                ("All", "2026", "Vetting Pending"),
                ("All", "2025", "Vetting Pending"),
            ],
            "All",
            only_unassigned=True,
        )

        self.assertEqual(
            portal_runner.calls,
            [
                ("All", "2026", "Vetting Pending"),
                ("All", "2025", "Vetting Pending"),
            ],
        )

    def test_current_single_select_applies_one_concrete_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        applied = []
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], False)
        portal_runner._set_select_value = lambda selected, value, required=False: applied.append(
            (selected, value, required)
        )
        portal_runner._set_multiselect_values = lambda *_args, **_kwargs: self.fail(
            "The current single-select portal must not use the legacy multiselect path."
        )

        selected_control = runner.CuracelPilesRunner._apply_year_filter(portal_runner, "2025")

        self.assertIs(selected_control, control)
        self.assertEqual(applied, [(control, "2025", True)])

    def test_legacy_multiselect_applies_every_visible_year_for_all(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        applied = []
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], True)
        portal_runner._set_select_value = lambda *_args, **_kwargs: self.fail(
            "The legacy multiselect portal must retain its multiselect path."
        )
        portal_runner._set_multiselect_values = lambda selected, values, required=False: applied.append(
            (selected, values, required)
        )

        selected_control = runner.CuracelPilesRunner._apply_year_filter(portal_runner, "All")

        self.assertIs(selected_control, control)
        self.assertEqual(applied, [(control, ["2026", "2025"], True)])


if __name__ == "__main__":
    unittest.main()
