import importlib.util
import io
import os
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


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
        active_from_time="",
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

    def test_no_eligible_bot_error_explains_safe_exclusion_reasons(self):
        bot = make_bot("primary", "primary", available=False, priority=1)
        bot.owner_name = "Daniel"

        with self.assertRaisesRegex(
            RuntimeError,
            r"No eligible bot accounts.*Daniel \(unavailable\)",
        ):
            runner.build_assignment_plan(
                "OLD MUTUAL", [make_pile(1)], [bot], {},
            )

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
        self.assertIn("uapom", runner.insurer_aliases("OLD MUTUAL"))

    def test_only_explicit_false_disables_legacy_rows(self):
        self.assertTrue(runner.enabled_by_default(None))
        self.assertTrue(runner.enabled_by_default(True))
        self.assertFalse(runner.enabled_by_default(False))


class ReadOnlyProbeTests(unittest.TestCase):
    def test_overlap_is_a_probe_failure_in_read_only_mode(self):
        self.assertEqual(
            runner.overlap_probe_failure(True, "DEFMIS"),
            "Read-only probe skipped DEFMIS because another runner held its lock.",
        )

    def test_overlap_remains_coalesced_for_normal_runs(self):
        self.assertIsNone(runner.overlap_probe_failure(False, "DEFMIS"))

    def test_new_external_assignment_is_simulated_without_a_database_write(self):
        store = runner.DataStore.__new__(runner.DataStore)
        store.read_only = True
        store.mode = "postgres"
        store._fetchall_postgres = lambda *_args, **_kwargs: []
        store._execute_postgres = lambda *_args, **_kwargs: self.fail(
            "read-only external detection must not attempt a database write"
        )
        pile = make_pile(1)
        pile.assigned = "Primary Bot"
        bot = make_bot("primary", "primary", priority=1)
        bot.bot_name = "Primary Bot"

        record, is_new = store.save_external_assignment(
            "master-1", "OLD MUTUAL", pile, matched_bot=bot,
        )

        self.assertTrue(is_new)
        self.assertEqual(record.tracking_key, pile.tracking_key)
        self.assertEqual(record.current_assigned, "Primary Bot")
        self.assertEqual(record.bot_account_id, bot.id)

    def test_transient_scan_response_timeout_is_retryable(self):
        self.assertTrue(runner.is_retryable_scan_error(RuntimeError(
            "No completed Piles data request confirmed 'All / All / Vetting Pending' within 30000ms."
        )))
        self.assertFalse(runner.is_retryable_scan_error(RuntimeError(
            "Configured bot names did not match the portal dropdown."
        )))

    def test_scan_context_reloads_once_after_a_transient_response_timeout(self):
        portal = object.__new__(runner.CuracelPilesRunner)
        attempts = []
        reloads = []

        def scan_status(*_args, **_kwargs):
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError(
                    "No completed Piles data request confirmed 'All / All / Vetting Pending' within 30000ms."
                )
            return [make_pile(1)]

        portal.scan_status = scan_status
        portal.open_piles = lambda: reloads.append(True)

        rows = portal._scan_status_with_transient_retry("All", "All", "Vetting Pending")

        self.assertEqual(len(rows), 1)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(reloads), 1)

    def test_read_only_probe_never_sends_external_assignment_alerts(self):
        items = [object()]
        self.assertFalse(runner.should_send_external_assignment_alert(
            types.SimpleNamespace(read_only=True), items,
        ))
        self.assertTrue(runner.should_send_external_assignment_alert(
            types.SimpleNamespace(read_only=False), items,
        ))
        self.assertFalse(runner.should_send_external_assignment_alert(
            types.SimpleNamespace(read_only=False), [],
        ))


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


class RunnerConcurrencyTests(unittest.TestCase):
    def test_database_lock_result_controls_whether_a_runner_may_start(self):
        locked_store = object.__new__(runner.DataStore)
        locked_store.mode = "postgres"
        locked_store._fetchall_postgres = lambda *_args, **_kwargs: [{"acquired": True}]

        competing_store = object.__new__(runner.DataStore)
        competing_store.mode = "postgres"
        competing_store._fetchall_postgres = lambda *_args, **_kwargs: [{"acquired": False}]

        acquire_locked = getattr(locked_store, "try_acquire_runner_lock", lambda: False)
        acquire_competing = getattr(competing_store, "try_acquire_runner_lock", lambda: True)

        self.assertTrue(acquire_locked())
        self.assertFalse(acquire_competing())

    def test_runner_start_fails_closed_when_another_run_holds_the_lock(self):
        store = type("Store", (), {"try_acquire_runner_lock": lambda _self: False})()
        ensure_lock = getattr(runner, "ensure_runner_lock_available", lambda _store: None)

        with self.assertRaisesRegex(RuntimeError, "already in progress"):
            ensure_lock(store)


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

    def test_scan_all_rows_accounts_for_every_expected_context(self):
        portal_runner = self.make_runner(
            supports_multiple=True,
            available_years=["2026", "2025"],
        )

        class Ledger:
            def __init__(self):
                self.created = []
                self.started = []
                self.finished = []
                self.failed = []

            def create_scan_contexts(self, _run_id, contexts):
                self.created = [{**item, "id": f"context-{index}"}
                                for index, item in enumerate(contexts)]
                return self.created

            def start_scan_context(self, context_id):
                self.started.append(context_id)

            def finish_scan_context(self, context_id, result, evidence=None):
                self.finished.append((context_id, result.status, evidence))

            def fail_scan_context(self, context_id, **details):
                self.failed.append((context_id, details))

            def heartbeat(self, *_args, **_kwargs):
                return None

        ledger = Ledger()
        portal_runner.execution_ledger = ledger
        portal_runner.insurer_run_id = "insurer-run-1"
        portal_runner.insurer_name = "Jubilee Uganda"

        runner.CuracelPilesRunner.scan_all_rows(portal_runner, ["All"], "All")

        self.assertEqual(len(ledger.created), 5)
        self.assertEqual(len(ledger.started), 5)
        self.assertEqual(len(ledger.finished), 5)
        self.assertEqual(ledger.failed, [])

    def test_reset_page_preserves_year_context_on_returned_rows(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.open_piles = lambda: None
        portal_runner.apply_filters = lambda *_args: None
        portal_runner.try_set_page_size = lambda *_args: None
        portal_runner.goto_next_page = lambda *_args, **_kwargs: False
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

    def test_scan_rejects_rows_rendered_for_a_different_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.apply_filters = lambda *_args: runner.FilterEvidence(
            True, True, True, "stable", "succeeded"
        )
        portal_runner.try_set_page_size = lambda *_args: None
        portal_runner.wait_for_table_ready = lambda *_args, **_kwargs: "stable"
        stale_row = make_pile(1, filter_year="2025")
        stale_row.month = "Jul 2026"
        portal_runner.rows_on_current_page = lambda *_args: [stale_row]
        portal_runner.goto_next_page = lambda *_args, **_kwargs: False

        with self.assertRaisesRegex(RuntimeError, "expected year '2025'.*Jul 2026"):
            runner.CuracelPilesRunner.scan_status(
                portal_runner,
                "All",
                "2025",
                "Vetting Pending",
            )

    def test_scan_accepts_month_only_rows_after_the_filter_request_is_confirmed(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.apply_filters = lambda *_args: runner.FilterEvidence(
            True, True, True, "stable", "succeeded"
        )
        portal_runner.try_set_page_size = lambda *_args: None
        portal_runner.wait_for_table_ready = lambda *_args, **_kwargs: "stable"
        month_only_row = make_pile(1, filter_year="2025")
        month_only_row.month = "Jul"
        portal_runner.rows_on_current_page = lambda *_args: [month_only_row]
        portal_runner.goto_next_page = lambda *_args, **_kwargs: False

        rows = runner.CuracelPilesRunner.scan_status(
            portal_runner,
            "All",
            "2025",
            "Vetting Pending",
        )

        self.assertEqual(rows, [month_only_row])

    def test_current_single_select_applies_one_concrete_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        applied = []
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], False)
        portal_runner._read_select_text = lambda _control: "2025"
        portal_runner._set_select_value = lambda selected, value, required=False: applied.append(
            (selected, value, required)
        )
        portal_runner._set_multiselect_values = lambda *_args, **_kwargs: self.fail(
            "The current single-select portal must not use the legacy multiselect path."
        )

        selected_control = runner.CuracelPilesRunner._apply_year_filter(portal_runner, "2025")

        self.assertIs(selected_control, control)
        self.assertEqual(applied, [(control, "2025", True)])

    def test_year_inspection_uses_the_panel_owned_by_the_control(self):
        class Locator:
            def __init__(self, *, attributes=None, children=None, text=""):
                self.attributes = attributes or {}
                self.children = children or {}
                self.text = text

            def get_attribute(self, name):
                return self.attributes.get(name)

            def locator(self, selector):
                return self.children.get(selector, LocatorList([]))

            def count(self):
                return 1

            def nth(self, index):
                if index != 0:
                    raise IndexError(index)
                return self

            def is_visible(self):
                return True

            @property
            def first(self):
                return self

            def inner_text(self):
                return self.text

        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

            def get_attribute(self, _name):
                return None

        year_options = LocatorList([Locator(text="2026"), Locator(text="2025")])
        year_listbox = Locator(attributes={"aria-multiselectable": "false"})
        year_panel = Locator(children={
            ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']": year_options,
            "[role='listbox']": year_listbox,
        })
        wrong_panel = Locator(children={
            ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']": LocatorList([
                Locator(text="Vetting Pending"),
            ]),
            "[role='listbox']": LocatorList([]),
        })
        combobox = Locator(attributes={"aria-controls": "year-options"})
        control = Locator(
            attributes={"class": "p-select p-component", "multiple": ""},
            children={"[role='combobox']": combobox},
        )
        page = Locator(children={'[id="year-options"]': year_panel})
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._open_select = lambda _control: True
        portal_runner._active_dropdown_root = lambda: wrong_panel
        portal_runner._close_dropdown = lambda: None

        available_years, supports_multiple = runner.CuracelPilesRunner._inspect_year_control(
            portal_runner,
            control,
        )

        self.assertEqual(available_years, ["2026", "2025"])
        self.assertFalse(supports_multiple)

    def test_year_inspection_reads_multiselect_aria_from_owned_listbox_root(self):
        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

        class Locator:
            def __init__(self, *, attributes=None, children=None, text=""):
                self.attributes = attributes or {}
                self.children = children or {}
                self.text = text

            def get_attribute(self, name):
                return self.attributes.get(name)

            def locator(self, selector):
                return self.children.get(selector, LocatorList([]))

            def count(self):
                return 1

            def is_visible(self):
                return True

            @property
            def first(self):
                return self

            def inner_text(self):
                return self.text

        option_selector = ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
        year_listbox = Locator(
            attributes={"id": "year-options", "role": "listbox", "aria-multiselectable": "true"},
            children={
                option_selector: LocatorList([Locator(text="2026"), Locator(text="2025")]),
                "[role='listbox']": LocatorList([]),
            },
        )
        control = Locator(attributes={
            "class": "custom-year-picker",
            "aria-controls": "year-options",
        })
        page = Locator(children={'[id="year-options"]': year_listbox})
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._open_select = lambda _control: True
        portal_runner._close_dropdown = lambda: None

        available_years, supports_multiple = runner.CuracelPilesRunner._inspect_year_control(
            portal_runner,
            control,
        )

        self.assertEqual(available_years, ["2026", "2025"])
        self.assertTrue(supports_multiple)

    def test_single_year_selection_uses_the_panel_owned_by_the_control(self):
        class Keyboard:
            def press(self, _key):
                return None

        class Locator:
            def __init__(self, *, attributes=None, children=None, text=""):
                self.attributes = attributes or {}
                self.children = children or {}
                self.text = text
                self.clicked = False

            def get_attribute(self, name):
                return self.attributes.get(name)

            def locator(self, selector):
                return self.children.get(selector, LocatorList([]))

            def count(self):
                return 1

            def is_visible(self):
                return True

            @property
            def first(self):
                return self

            def inner_text(self):
                return self.text

            def click(self, **_kwargs):
                self.clicked = True

        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

        year_2026 = Locator(text="2026")
        year_2025 = Locator(text="2025")
        year_panel = Locator(children={
            "li.p-select-option, .p-select-option, [role='option']": LocatorList([year_2026, year_2025]),
        })
        wrong_panel = Locator(children={
            "li.p-select-option, .p-select-option, [role='option']": LocatorList([
                Locator(text="Vetting Pending"),
            ]),
        })
        control = Locator(attributes={
            "class": "p-select p-component",
            "aria-controls": "year-options",
        })

        def select_2025(**_kwargs):
            year_2025.clicked = True
            control.text = "2025"

        year_2025.click = select_2025
        page = Locator(children={'[id="year-options"]': year_panel})
        page.keyboard = Keyboard()
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._open_select = lambda _control: True
        portal_runner._visible_dropdown_panels = lambda: [wrong_panel]
        portal_runner._active_dropdown_root = lambda: wrong_panel

        selected = runner.CuracelPilesRunner._set_select_value(
            portal_runner,
            control,
            "2025",
            required=False,
        )

        self.assertTrue(selected)
        self.assertTrue(year_2025.clicked)
        self.assertFalse(year_2026.clicked)

    def test_single_select_rejects_an_unconfirmed_option(self):
        class Keyboard:
            def press(self, _key):
                return None

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = type("Page", (), {"keyboard": Keyboard()})()
        portal_runner.select_confirmation_timeout_ms = 1
        portal_runner._open_select = lambda _control: True
        portal_runner._choose_option_from_open_dropdown = lambda *_args: "All"
        portal_runner._read_select_text = lambda _control: "Aug"

        selected = runner.CuracelPilesRunner._set_select_value(
            portal_runner,
            object(),
            "All",
            required=False,
        )

        self.assertFalse(selected)

    def test_sweetalert_survey_is_dismissed_with_cancel(self):
        class Keyboard:
            def press(self, _key):
                return None

        class Button:
            def __init__(self, visible=False):
                self.visible = visible
                self.clicked = False

            def is_visible(self, timeout=0):
                return self.visible

            @property
            def first(self):
                return self

            def click(self):
                self.clicked = True

        cancel = Button(visible=True)
        hidden = Button()

        class Page:
            keyboard = Keyboard()

            def locator(self, selector):
                return cancel if selector == ".swal2-cancel" else hidden

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = Page()

        runner.CuracelPilesRunner._dismiss_popup(portal_runner)

        self.assertTrue(cancel.clicked)

    def test_selected_multiselect_years_are_read_from_the_owned_panel(self):
        class Locator:
            def __init__(self, *, attributes=None, children=None, text=""):
                self.attributes = attributes or {}
                self.children = children or {}
                self.text = text

            def get_attribute(self, name):
                return self.attributes.get(name)

            def locator(self, selector):
                return self.children.get(selector, LocatorList([]))

            def count(self):
                return 1

            def is_visible(self):
                return True

            @property
            def first(self):
                return self

            def inner_text(self):
                return self.text

        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

        option_selector = ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
        year_panel = Locator(children={
            option_selector: LocatorList([
                Locator(text="2026", attributes={"aria-selected": "true"}),
                Locator(text="2025", attributes={"data-p-selected": "true"}),
            ]),
        })
        wrong_panel = Locator(children={
            option_selector: LocatorList([Locator(text="Vetting Pending")]),
        })
        control = Locator(attributes={"aria-controls": "year-options"})
        page = Locator(children={'[id="year-options"]': year_panel})
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._open_select = lambda _control: True
        portal_runner._active_dropdown_root = lambda: wrong_panel
        portal_runner._close_dropdown = lambda: None

        selected_years = runner.CuracelPilesRunner._read_selected_multiselect_years(
            portal_runner,
            control,
        )

        self.assertEqual(selected_years, {"2026", "2025"})

    def test_multiselect_year_changes_are_applied_in_the_owned_panel(self):
        class Locator:
            def __init__(self, *, attributes=None, children=None, text=""):
                self.attributes = attributes or {}
                self.children = children or {}
                self.text = text
                self.clicked = False

            def get_attribute(self, name):
                return self.attributes.get(name)

            def locator(self, selector):
                return self.children.get(selector, LocatorList([]))

            def count(self):
                return 1

            def is_visible(self):
                return True

            @property
            def first(self):
                return self

            def inner_text(self):
                return self.text

            def click(self, **_kwargs):
                self.clicked = True

        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

        option_selector = ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
        year_2026 = Locator(text="2026", attributes={"aria-selected": "false"})
        year_2025 = Locator(text="2025", attributes={"aria-selected": "false"})
        year_panel = Locator(children={
            option_selector: LocatorList([year_2026, year_2025]),
        })
        wrong_panel = Locator(children={
            option_selector: LocatorList([Locator(text="Audit Pending")]),
        })
        control = Locator(attributes={"aria-controls": "year-options"})
        page = Locator(children={'[id="year-options"]': year_panel})
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._open_select = lambda _control: True
        portal_runner._active_dropdown_root = lambda: wrong_panel
        portal_runner._close_dropdown = lambda: None

        selected = runner.CuracelPilesRunner._set_multiselect_values(
            portal_runner,
            control,
            ["2025"],
            required=False,
        )

        self.assertTrue(selected)
        self.assertTrue(year_2025.clicked)
        self.assertFalse(year_2026.clicked)

    def test_multiselect_all_years_uses_native_header_checkbox(self):
        class Locator:
            def __init__(self, *, attributes=None, children=None, text=""):
                self.attributes = attributes or {}
                self.children = children or {}
                self.text = text
                self.clicked = False
                self.dom_clicked = False

            def get_attribute(self, name):
                return self.attributes.get(name)

            def locator(self, selector):
                return self.children.get(selector, LocatorList([]))

            def count(self):
                return 1

            def is_visible(self):
                return True

            def inner_text(self):
                return self.text

            def click(self, **_kwargs):
                self.clicked = True

            def evaluate(self, expression):
                self.dom_clicked = expression == "element => element.click()"

        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

        option_selector = ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
        header_selector = ".p-multiselect-header .p-checkbox-input"
        year_2026 = Locator(text="2026", attributes={"aria-selected": "true"})
        year_2025 = Locator(text="2025", attributes={"aria-selected": "false"})
        header_checkbox = Locator(attributes={"aria-label": "All items unselected"})
        year_panel = Locator(children={
            option_selector: LocatorList([year_2026, year_2025]),
            header_selector: LocatorList([header_checkbox]),
        })
        control = Locator(attributes={"aria-controls": "year-options"})
        page = Locator(children={'[id="year-options"]': year_panel})
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._open_select = lambda _control: True
        portal_runner._active_dropdown_root = lambda: year_panel
        portal_runner._active_multiselect_root = lambda: year_panel
        portal_runner._close_dropdown = lambda: None

        selected = runner.CuracelPilesRunner._set_multiselect_values(
            portal_runner,
            control,
            ["2026", "2025"],
            required=True,
        )

        self.assertTrue(selected)
        self.assertFalse(year_2026.clicked)
        self.assertFalse(year_2025.clicked)
        self.assertFalse(year_2025.dom_clicked)
        self.assertTrue(header_checkbox.dom_clicked)

    def test_year_candidates_include_primevue_combobox_without_legacy_root_class(self):
        class Control:
            def bounding_box(self):
                return {"x": 310, "y": 116, "width": 150, "height": 40}

            def get_attribute(self, name):
                return {"data-pc-name": "multiselect", "role": "combobox"}.get(name)

            def inner_text(self):
                return ""

        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

        control = Control()
        page = type("Page", (), {
            "locator": lambda _self, _selector: LocatorList([control]),
        })()
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = page
        portal_runner._select_following_label_text = lambda _label: None
        portal_runner._select_in_container = lambda _label: None
        portal_runner._visible_multiselects = lambda: []
        portal_runner._visible_selects = lambda: []

        candidates = runner.CuracelPilesRunner._year_control_candidates(portal_runner)

        self.assertEqual(candidates, [control])

    def test_year_discovery_failure_reports_generic_filter_controls(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._year_control_candidates = lambda: [object()]
        portal_runner._inspect_year_control = lambda _control: ([], False)
        portal_runner._describe_visible_selects = lambda: []
        portal_runner._describe_visible_filter_controls = lambda: [{
            "data_pc_name": "multiselect",
            "role": "combobox",
            "aria_controls": "year-options",
        }]

        with self.assertRaisesRegex(RuntimeError, "multiselect.*year-options"):
            runner.CuracelPilesRunner._find_year_filter_control(portal_runner)

    def test_open_select_waits_for_its_owned_panel_not_hidden_global_options(self):
        class LocatorList:
            def __init__(self, items):
                self.items = items

            def count(self):
                return len(self.items)

            def nth(self, index):
                return self.items[index]

            @property
            def first(self):
                return self.items[0] if self.items else self

        class Panel:
            def __init__(self):
                self.visibility_checks = 0

            def count(self):
                return 1

            @property
            def first(self):
                return self

            def is_visible(self):
                self.visibility_checks += 1
                return self.visibility_checks >= 2

            def locator(self, _selector):
                return LocatorList([object()])

        class Control:
            def click(self):
                return None

            def get_attribute(self, name):
                return "year-options" if name == "aria-controls" else None

            def locator(self, _selector):
                return LocatorList([])

        panel = Panel()

        class Page:
            def locator(self, selector):
                if selector == '[id="year-options"]':
                    return panel
                return LocatorList([object()])

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = Page()

        opened = runner.CuracelPilesRunner._open_select(portal_runner, Control())

        self.assertTrue(opened)
        self.assertGreaterEqual(panel.visibility_checks, 2)

    def test_primevue_multiselect_uses_verified_dom_root_click(self):
        class EmptyLocator:
            def count(self):
                return 0

            @property
            def first(self):
                return self

            def is_visible(self):
                return False

        class Control:
            def __init__(self):
                self.opened = False
                self.standard_clicks = 0
                self.dom_clicks = 0

            def get_attribute(self, name):
                return "p-multiselect p-component" if name == "class" else None

            def click(self, **_kwargs):
                self.standard_clicks += 1

            def evaluate(self, _script):
                self.dom_clicks += 1
                self.opened = True

            def locator(self, _selector):
                return EmptyLocator()

        control = Control()
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = object()
        portal_runner._wait_for_dropdown_options = lambda selected, **_kwargs: selected.opened

        opened = runner.CuracelPilesRunner._open_select(portal_runner, control)

        self.assertTrue(opened)
        self.assertEqual(control.dom_clicks, 1)
        self.assertEqual(control.standard_clicks, 0)

    def test_dropdown_wait_uses_visible_panel_when_control_has_no_aria_owner(self):
        class Options:
            def count(self):
                return 1

        class Panel:
            def __init__(self):
                self.option_reads = 0

            def locator(self, _selector):
                self.option_reads += 1
                return Options()

        class EmptyLocator:
            def count(self):
                return 0

        class Control:
            def get_attribute(self, _name):
                return None

            def locator(self, _selector):
                return EmptyLocator()

        panel = Panel()
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = object()
        portal_runner._visible_dropdown_panels = lambda: [panel]

        runner.CuracelPilesRunner._wait_for_dropdown_options(
            portal_runner,
            Control(),
            timeout_ms=1,
        )

        self.assertEqual(panel.option_reads, 1)

    def test_current_single_select_rejects_an_unconfirmed_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], False)
        portal_runner.year_filter_confirmation_timeout_ms = 1
        portal_runner._set_select_value = lambda *_args, **_kwargs: True
        portal_runner._read_select_text = lambda _control: "2026"

        with self.assertRaisesRegex(RuntimeError, "Year filter selection was not confirmed.*2025"):
            runner.CuracelPilesRunner._apply_year_filter(portal_runner, "2025")

    def test_current_single_select_waits_for_a_delayed_year_label(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        observed_labels = iter(["2026", "2025"])
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], False)
        portal_runner._set_select_value = lambda *_args, **_kwargs: True
        portal_runner._read_select_text = lambda _control: next(observed_labels)

        selected_control = runner.CuracelPilesRunner._apply_year_filter(portal_runner, "2025")

        self.assertIs(selected_control, control)

    def test_legacy_multiselect_applies_every_visible_year_for_all(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        applied = []
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], True)
        portal_runner._read_selected_multiselect_years = lambda _control: {"2026", "2025"}
        portal_runner._set_select_value = lambda *_args, **_kwargs: self.fail(
            "The legacy multiselect portal must retain its multiselect path."
        )
        portal_runner._set_multiselect_values = lambda selected, values, required=False: applied.append(
            (selected, values, required)
        )

        selected_control = runner.CuracelPilesRunner._apply_year_filter(portal_runner, "All")

        self.assertIs(selected_control, control)
        self.assertEqual(applied, [(control, ["2026", "2025"], True)])

    def test_legacy_multiselect_rejects_an_incomplete_selection(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        control = object()
        portal_runner._find_year_filter_control = lambda: (control, ["2026", "2025"], True)
        portal_runner.year_filter_confirmation_timeout_ms = 1
        portal_runner._set_multiselect_values = lambda *_args, **_kwargs: True
        portal_runner._read_selected_multiselect_years = lambda _control: {"2026"}

        with self.assertRaisesRegex(RuntimeError, "Year filter selection was not confirmed.*2025"):
            runner.CuracelPilesRunner._apply_year_filter(portal_runner, "All")

    def test_piles_response_must_contain_the_concrete_filter_year(self):
        matches = getattr(runner, "piles_response_matches_filter_year", lambda *_args: False)

        self.assertTrue(matches("https://api.health.curacel.co/api/piles?year%5B%5D=2025&page=1", "2025"))
        self.assertFalse(matches("https://api.health.curacel.co/api/piles?year%5B%5D=2026&page=1", "2025"))
        self.assertFalse(matches("https://api.health.curacel.co/api/piles?year=2026&submitted_from=2025-01-01", "2025"))
        self.assertFalse(matches("https://api.health.curacel.co/api/providers?year=2025", "2025"))

    def test_piles_response_context_matches_all_filter_dimensions(self):
        url = (
            "https://api.health.curacel.co/api/piles?page=1&per_page=100&month=8"
            "&year%5B%5D=2026&status%5Bid%5D=2&status%5Bcode%5D=O"
            "&status%5Bname%5D=Vetting+Ongoing"
        )

        self.assertTrue(runner.piles_response_matches_context(
            url, "Aug", "2026", "Vetting Ongoing", page_number=1, page_size=100
        ))
        self.assertFalse(runner.piles_response_matches_context(
            url, "Aug", "2026", "Audit Pending", page_number=1, page_size=100
        ))
        self.assertFalse(runner.piles_response_matches_context(
            url, "Jul", "2026", "Vetting Ongoing", page_number=1, page_size=100
        ))
        self.assertFalse(runner.piles_response_matches_context(
            url, "Aug", "2026", "Vetting Ongoing", page_number=2, page_size=100
        ))

    def test_piles_response_context_accepts_explicit_all_values(self):
        url = (
            "https://api.health.curacel.co/api/piles?page=1&per_page=10&month=0"
            "&year%5B%5D=2026&year%5B%5D=2025&status%5Bid%5D=0"
            "&status%5Bcode%5D=All&status%5Bname%5D=All"
        )
        self.assertTrue(runner.piles_response_matches_context(
            url, "All", "All", "All", page_number=1, page_size=10
        ))

    def test_piles_response_summary_only_marks_a_paginated_empty_collection(self):
        empty = runner.summarize_piles_response({
            "data": {"data": [], "total": 0, "current_page": 1}
        })
        populated = runner.summarize_piles_response({
            "data": {"data": [{"id": 123}], "total": 1, "current_page": 1}
        })
        unrelated = runner.summarize_piles_response({"success": True})

        self.assertEqual(empty, {"authoritative": True, "item_count": 0, "total": 0})
        self.assertEqual(len(populated.pop("row_id_hashes")), 1)
        self.assertEqual(populated, {
            "authoritative": True,
            "item_count": 1,
            "total": 1,
            "row_fields": ["id"],
        })
        self.assertEqual(unrelated, {"authoritative": False})

    def test_filter_response_marker_survives_history_truncation(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)

        class Request:
            method = "GET"

        class Response:
            request = Request()
            status = 200
            url = "https://api.health.curacel.co/api/piles?year=2025&page=1"

            def finished(self):
                return None

        old_response = Response()
        portal_runner._piles_response_events = [
            (index, 200, f"https://api.health.curacel.co/api/piles?year=2026&page={index}", old_response)
            for index in range(1, 101)
        ]
        portal_runner._piles_response_sequence = 100
        marker = portal_runner._piles_response_sequence

        runner.CuracelPilesRunner._capture_piles_response(portal_runner, Response())
        runner.CuracelPilesRunner._wait_for_piles_filter_response(
            portal_runner,
            marker,
            "All",
            "2025",
            "All",
            timeout_ms=1,
        )

    def test_open_piles_scopes_response_history_to_current_navigation(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = object()
        portal_runner._piles_response_sequence = 7
        portal_runner._filter_state = {}
        portal_runner._table_headers_cache = []

        def navigate(_url):
            portal_runner._piles_response_sequence = 9

        portal_runner._goto_with_soft_readiness = navigate
        portal_runner._wait_for_piles_page_ready = lambda: None
        portal_runner._dismiss_popup = lambda: None

        runner.CuracelPilesRunner.open_piles(portal_runner)

        self.assertEqual(portal_runner._page_open_response_marker, 7)

    def test_open_piles_reloads_when_same_url_navigation_emits_no_piles_response(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._piles_response_sequence = 7
        portal_runner._filter_state = {}
        portal_runner._table_headers_cache = []
        reloads = []

        class Page:
            def reload(self, **_kwargs):
                reloads.append(True)
                portal_runner._piles_response_sequence = 8

        portal_runner.page = Page()
        portal_runner._goto_with_soft_readiness = lambda _url: None
        portal_runner._wait_for_piles_page_ready = lambda: None
        portal_runner._dismiss_popup = lambda: None

        runner.CuracelPilesRunner.open_piles(portal_runner)

        self.assertEqual(reloads, [True])
        self.assertEqual(portal_runner._page_open_response_marker, 7)

    def test_page_open_marker_rejects_a_pre_navigation_matching_response(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._piles_response_events = [
            (4, 200, "https://api.health.curacel.co/api/piles?page=1&month=0&status%5Bcode%5D=All", object()),
        ]

        state, details = runner.CuracelPilesRunner._filter_network_state(
            portal_runner,
            7,
            "All",
            "All",
            "All",
            page_number=1,
        )

        self.assertEqual(state, "not_observed")
        self.assertEqual(details, {})

    def test_filter_wait_accepts_the_matching_year_response_event(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)

        class Response:
            def __init__(self):
                self.finished_calls = 0

            def finished(self):
                self.finished_calls += 1

        response = Response()
        portal_runner._piles_response_events = [
            (1, 200, "https://api.health.curacel.co/api/piles?year=2025&page=1", response),
        ]

        runner.CuracelPilesRunner._wait_for_piles_filter_response(
            portal_runner,
            0,
            "All",
            "2025",
            "All",
            timeout_ms=1,
        )

        self.assertEqual(response.finished_calls, 0)

    def test_filter_wait_rejects_a_response_for_the_previous_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._piles_response_events = [
            (1, 200, "https://api.health.curacel.co/api/piles?year=2026&page=1", object()),
        ]

        with self.assertRaisesRegex(RuntimeError, "No completed Piles data request.*2025"):
            runner.CuracelPilesRunner._wait_for_piles_filter_response(
                portal_runner,
                0,
                "All",
                "2025",
                "All",
                timeout_ms=1,
            )

    def test_matching_controls_and_stable_table_do_not_require_new_network_event(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = object()
        portal_runner._filter_state = {
            "month": "All",
            "year": "2025",
            "status": "Vetting Pending",
            "page_size": None,
        }
        portal_runner._piles_response_sequence = 4
        portal_runner._piles_response_events = []
        portal_runner.wait_for_table_ready = lambda **_kwargs: "stable"

        evidence = runner.CuracelPilesRunner.apply_filters(
            portal_runner,
            "All",
            "2025",
            "Vetting Pending",
        )

        self.assertEqual(evidence.network_state, "not_observed")
        self.assertEqual(evidence.table_state, "stable")

    def test_filter_network_state_reports_explicit_http_failure(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._piles_response_events = [
            (7, 500, "https://api.health.curacel.co/api/piles?year=2025", object()),
        ]

        state, details = runner.CuracelPilesRunner._filter_network_state(
            portal_runner,
            6,
            "All",
            "2025",
            "All",
        )

        self.assertEqual(state, "failed")
        self.assertEqual(details["http_status"], 500)

    def test_scan_status_rejects_conflicting_rows_with_same_tracking_key(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.apply_filters = lambda *_args: runner.FilterEvidence(
            True, True, True, "stable", "not_observed"
        )
        portal_runner.try_set_page_size = lambda *_args: None
        portal_runner.wait_for_table_ready = lambda *_args, **_kwargs: "stable"
        portal_runner.rows_on_current_page = lambda *_args: [
            make_pile(1) if _args[1] == 1 else runner.replace(make_pile(1), provider="Changed Provider")
        ]
        pages = iter([True, False])
        portal_runner.goto_next_page = lambda *_args, **_kwargs: next(pages)

        with self.assertRaisesRegex(RuntimeError, "Conflicting rows shared tracking key"):
            runner.CuracelPilesRunner.scan_status(
                portal_runner,
                "Jul",
                "2026",
                "Vetting Pending",
            )

    def test_scan_status_accepts_stable_empty_body_after_matching_response(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.apply_filters = lambda *_args: runner.FilterEvidence(
            True,
            True,
            True,
            "structurally_empty",
            "succeeded",
            {"network": {"authoritative_empty": True}},
        )
        portal_runner.try_set_page_size = lambda *_args: self.fail(
            "An authoritative empty result must not trigger a second request."
        )
        portal_runner.wait_for_table_ready = lambda *_args, **_kwargs: self.fail(
            "An authoritative empty result must not be reclassified from stale DOM."
        )
        portal_runner.rows_on_current_page = lambda *_args: []
        portal_runner.goto_next_page = lambda *_args, **_kwargs: False

        rows = runner.CuracelPilesRunner.scan_status(
            portal_runner,
            "All",
            "All",
            "Audit Pending",
        )

        self.assertEqual(rows, [])

    def test_table_snapshot_distinguishes_loading_from_structural_empty(self):
        self.assertEqual(
            runner.classify_table_snapshot([], False, True, False),
            "structurally_empty",
        )
        self.assertEqual(
            runner.classify_table_snapshot([], False, True, True),
            "pending",
        )

    def test_pagination_does_not_treat_an_unreadable_next_page_as_finished(self):
        class NextButton:
            first = None

            def __init__(self):
                self.first = self

            def count(self):
                return 1

            def is_visible(self):
                return True

            def get_attribute(self, _name):
                return None

            def click(self):
                return None

        class Page:
            def locator(self, _selector):
                return NextButton()

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = Page()
        portal_runner.wait_for_table_ready = lambda *_args, **_kwargs: "unreadable"

        with self.assertRaisesRegex(RuntimeError, "next Piles page did not settle"):
            runner.CuracelPilesRunner.goto_next_page(portal_runner)

    def test_pagination_waits_for_the_exact_next_page_context(self):
        class NextButton:
            first = None

            def __init__(self):
                self.first = self

            def count(self):
                return 1

            def is_visible(self):
                return True

            def get_attribute(self, _name):
                return None

            def click(self):
                return None

        class Page:
            def locator(self, _selector):
                return NextButton()

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = Page()
        portal_runner._piles_response_sequence = 9
        portal_runner._filter_state = {"page_size": 100}
        portal_runner.wait_for_table_ready = lambda *_args, **_kwargs: "stable"
        fingerprints = iter([("page-one",), ("page-two",)])
        portal_runner._table_preview_fingerprint = lambda: next(fingerprints)
        observed = []
        portal_runner._wait_for_piles_filter_response = lambda *args, **kwargs: observed.append(
            (args, kwargs)
        )
        portal_runner._filter_network_state = lambda *args, **kwargs: (
            "succeeded",
            {"authoritative": True, "item_count": 1},
        )

        moved = runner.CuracelPilesRunner.goto_next_page(
            portal_runner,
            "Aug",
            "2026",
            "Vetting Ongoing",
            next_page=2,
        )

        self.assertTrue(moved)
        self.assertEqual(
            observed,
            [((9, "Aug", "2026", "Vetting Ongoing"), {"page_number": 2, "page_size": 100})],
        )

    def test_pagination_rejects_a_blank_or_unparsed_exact_response(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = type("Page", (), {
            "locator": lambda _self, _selector: type("Button", (), {
                "first": property(lambda self: self),
                "count": lambda _self: 1,
                "is_visible": lambda _self: True,
                "get_attribute": lambda _self, _name: None,
                "click": lambda _self: None,
            })(),
        })()
        portal_runner._piles_response_sequence = 3
        portal_runner._filter_state = {"page_size": 100}
        portal_runner._table_preview_fingerprint = lambda: ("page-one",)
        portal_runner._wait_for_piles_filter_response = lambda *_args, **_kwargs: None
        portal_runner._filter_network_state = lambda *_args, **_kwargs: (
            "succeeded",
            {"authoritative": False},
        )

        with self.assertRaisesRegex(RuntimeError, "payload contained no readable rows"):
            runner.CuracelPilesRunner.goto_next_page(
                portal_runner,
                "Aug",
                "2026",
                "Vetting Ongoing",
                next_page=2,
            )

    def test_filter_dom_coherence_rejects_previous_rows_for_empty_response(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.wait_for_table_ready = lambda **_kwargs: "stable"
        portal_runner._visible_table_row_count = lambda: 2
        portal_runner._table_preview_fingerprint = lambda: ("old rows",)
        portal_runner._table_loading_visible = lambda: False

        state, coherent = runner.CuracelPilesRunner._wait_for_table_response_coherence(
            portal_runner,
            0,
            ("old rows",),
            timeout_ms=1,
        )

        self.assertEqual(state, "stable")
        self.assertFalse(coherent)

    def test_filter_dom_coherence_requires_the_new_visible_rows(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.wait_for_table_ready = lambda **_kwargs: "stable"
        portal_runner._visible_table_row_count = lambda: 2
        portal_runner._table_preview_fingerprint = lambda: ("new rows",)
        portal_runner._table_loading_visible = lambda: False

        state, coherent = runner.CuracelPilesRunner._wait_for_table_response_coherence(
            portal_runner,
            2,
            ("old rows",),
            timeout_ms=10,
        )

        self.assertEqual(state, "stable")
        self.assertTrue(coherent)

    def test_filter_dom_coherence_accepts_two_identical_context_matching_snapshots(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._heartbeat = lambda *_args: None
        portal_runner.wait_for_table_ready = lambda **_kwargs: "unreadable"
        portal_runner._visible_table_row_count = lambda: 2
        portal_runner._table_preview_fingerprint = lambda: ("unchanged preview",)
        portal_runner._table_loading_visible = lambda: False
        samples = []
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [
                ["A", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Ongoing"],
                ["B", "12", "Sep", "KES 2,000.00", "09/09/2026", "Vetting Ongoing"],
            ],
            "loading": False,
        }
        identities = runner.response_identity_candidates([
            {"provider": {"name": "A"}, "submitted_claims_count": 10, "month": "Sep", "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
            {"provider": {"name": "B"}, "submitted_claims_count": 12, "month": "Sep", "amount_requested": 2000, "last_claim_submitted_at": "2026-09-09T11:00:00Z"},
        ])

        def read_snapshot():
            samples.append(True)
            return snapshot

        portal_runner._table_context_snapshot = read_snapshot
        state, coherent = runner.CuracelPilesRunner._wait_for_table_response_coherence(
            portal_runner,
            2,
            ("unchanged preview",),
            timeout_ms=500,
            month_label="All",
            year_label="All",
            status_label="Vetting Ongoing",
            response_identity_candidates=identities,
        )

        self.assertEqual(state, "stable")
        self.assertTrue(coherent)
        self.assertGreaterEqual(len(samples), 2)

    def test_table_context_snapshot_rejects_wrong_status_and_loading_state(self):
        base = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["A", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Pending"]],
            "loading": False,
        }
        identities = runner.response_identity_candidates([
            {"provider": {"name": "A"}, "submitted_claims_count": 10, "month": "Sep", "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
        ])
        self.assertFalse(runner.table_snapshot_matches_filter_context(
            base, 1, "All", "All", "Vetting Ongoing", identities,
        ))
        self.assertFalse(runner.table_snapshot_matches_filter_context(
            {**base, "loading": True}, 1, "All", "All", "Vetting Pending", identities,
        ))

    def test_table_context_snapshot_validates_specific_month_and_year(self):
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["A", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Pending"]],
            "loading": False,
        }
        identities = runner.response_identity_candidates([
            {"provider": {"name": "A"}, "submitted_claims_count": 10, "month": "Sep", "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
        ])
        self.assertTrue(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "Sep", "2026", "Vetting Pending", identities,
        ))
        self.assertFalse(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "Aug", "2026", "Vetting Pending", identities,
        ))
        self.assertFalse(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "Sep", "2025", "Vetting Pending", identities,
        ))

    def test_table_context_snapshot_normalizes_numeric_api_month_to_visible_name(self):
        self.assertEqual(runner._canonical_month("09"), "09")
        self.assertEqual(runner._canonical_month("September"), "09")
        self.assertEqual(runner._canonical_month("Sep"), "09")
        self.assertEqual(runner._canonical_month("9.5"), "")
        self.assertEqual(runner._canonical_month("Infinity"), "")
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["A", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Ongoing"]],
            "loading": False,
        }
        identities = runner.response_identity_candidates([
            {"provider": {"name": "A"}, "submitted_claims_count": 10, "month": 9, "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
        ])

        self.assertTrue(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "September", "All", "Vetting Ongoing", identities,
        ))

    def test_table_context_snapshot_accepts_supported_live_rendering_variants(self):
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["Provider A\nCODE-1", "10", "Sep", "UGX 1,000", "Sep 9, 2026 10:00 AM", "Vetting Ongoing"]],
            "loading": False,
        }
        identities = runner.response_identity_candidates([{
            "provider": {"name": "Provider A"}, "submitted_claims_count": 10, "month": 9,
            "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z",
        }])

        self.assertTrue(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "All", "All", "Vetting Ongoing", identities,
        ))

    def test_response_identity_rejects_cross_mixed_stale_field_tuple(self):
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["Provider A", "7", "Sep", "UGX 500", "Sep 8, 2026", "Vetting Ongoing"]],
            "loading": False,
        }
        identities = runner.response_identity_candidates([{
            "provider": {"name": "Provider A"},
            "submitted_claims_count": 10, "pending_claims_count": 7,
            "month": 9, "amount_requested": 1000, "amount_paid": 500,
            "last_claim_submitted_at": "2026-09-09T10:00:00Z", "updated_at": "2026-09-08T10:00:00Z",
        }])

        self.assertFalse(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "All", "All", "Vetting Ongoing", identities,
        ))

    def test_table_context_uses_stable_response_ids_in_dom_attributes(self):
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["", "", "", "", "", "Vetting Ongoing"]],
            "row_attributes": [["/piles/pile-live-123", "pile-live-123"]],
            "loading": False,
        }
        id_hashes = runner.response_row_id_hashes([{"id": "pile-live-123"}])

        self.assertTrue(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "All", "All", "Vetting Ongoing", [], id_hashes,
        ))
        snapshot["row_attributes"] = [["/piles/pile-stale-456"]]
        self.assertFalse(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "All", "All", "Vetting Ongoing", [], id_hashes,
        ))

    def test_table_context_snapshot_rejects_rows_from_a_different_api_response(self):
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["A", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Pending"]],
            "loading": False,
        }
        other_identities = runner.response_identity_candidates([
            {"provider": {"name": "Different"}, "submitted_claims_count": 10, "month": "Sep", "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
        ])
        self.assertFalse(runner.table_snapshot_matches_filter_context(
            snapshot, 1, "All", "All", "Vetting Pending", other_identities,
        ))

    def test_wrong_context_cannot_fall_through_to_legacy_transition_acceptance(self):
        snapshot = {
            "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
            "rows": [["A", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Pending"]],
            "loading": False,
        }
        identities = runner.response_identity_candidates([
            {"provider": {"name": "A"}, "submitted_claims_count": 10, "month": "Sep", "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
        ])
        for require_transition in (False, True):
            portal_runner = object.__new__(runner.CuracelPilesRunner)
            portal_runner._heartbeat = lambda *_args: None
            portal_runner.wait_for_table_ready = lambda **_kwargs: "stable"
            portal_runner._visible_table_row_count = lambda: 1
            portal_runner._table_preview_fingerprint = lambda: ("new preview",)
            portal_runner._table_loading_visible = lambda: False
            portal_runner._table_context_snapshot = lambda: snapshot

            state, coherent = runner.CuracelPilesRunner._wait_for_table_response_coherence(
                portal_runner,
                1,
                ("old preview",),
                timeout_ms=20,
                require_transition=require_transition,
                month_label="All",
                year_label="All",
                status_label="Vetting Ongoing",
                response_identity_candidates=identities,
            )

            self.assertEqual(state, "stable")
            self.assertFalse(coherent)

    def test_filter_dom_coherence_rejects_churning_context_snapshots(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._heartbeat = lambda *_args: None
        portal_runner.wait_for_table_ready = lambda **_kwargs: "unreadable"
        portal_runner._visible_table_row_count = lambda: 1
        portal_runner._table_preview_fingerprint = lambda: ("unchanged preview",)
        portal_runner._table_loading_visible = lambda: False
        sample_index = 0

        def read_snapshot():
            nonlocal sample_index
            sample_index += 1
            return {
                "headers": ["PROVIDER", "CLAIMS", "MONTH", "PROVIDER BILL", "SUBMITTED DATE", "STATUS"],
                "rows": [[f"Provider {sample_index % 2}", "10", "Sep", "KES 1,000.00", "09/09/2026", "Vetting Pending"]],
                "loading": False,
            }

        portal_runner._table_context_snapshot = read_snapshot
        state, coherent = runner.CuracelPilesRunner._wait_for_table_response_coherence(
            portal_runner,
            1,
            ("unchanged preview",),
            timeout_ms=450,
            month_label="All",
            year_label="All",
            status_label="Vetting Pending",
            response_identity_candidates=runner.response_identity_candidates([
                {"provider": {"name": "Provider 0"}, "submitted_claims_count": 10, "month": "Sep", "amount_requested": 1000, "last_claim_submitted_at": "2026-09-09T10:00:00Z"},
            ]),
        )

        self.assertEqual(state, "unreadable")
        self.assertFalse(coherent)

    def test_filter_dom_coherence_accepts_exact_empty_without_table_markup(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.wait_for_table_ready = lambda **_kwargs: "unreadable"
        portal_runner._visible_table_row_count = lambda: 0
        portal_runner._table_preview_fingerprint = lambda: ()
        portal_runner._table_loading_visible = lambda: False

        state, coherent = runner.CuracelPilesRunner._wait_for_table_response_coherence(
            portal_runner,
            0,
            ("old rows",),
            timeout_ms=10,
        )

        self.assertEqual(state, "structurally_empty")
        self.assertTrue(coherent)

    def test_empty_placeholder_row_is_not_counted_as_a_pile(self):
        class Row:
            def inner_text(self):
                return "No Data Found"

        class Rows:
            def count(self):
                return 1

            def nth(self, _index):
                return Row()

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = type("Page", (), {"locator": lambda _self, _selector: Rows()})()

        self.assertEqual(runner.CuracelPilesRunner._visible_table_row_count(portal_runner), 0)
        self.assertEqual(runner.CuracelPilesRunner._table_preview_fingerprint(portal_runner), ())

    def test_page_size_change_waits_for_exact_response_and_dom_count(self):
        class Target:
            @property
            def last(self):
                return self

            def count(self):
                return 1

            def is_visible(self):
                return True

            def get_attribute(self, _name):
                return None

            def click(self):
                return None

        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.page = type("Page", (), {"locator": lambda _self, _selector: Target()})()
        portal_runner._filter_state = {
            "month": "Aug",
            "year": "2026",
            "status": "Vetting Ongoing",
            "page_size": None,
        }
        portal_runner._piles_response_sequence = 11
        portal_runner._read_select_text = lambda _target: "10"
        portal_runner._choose_option_from_open_dropdown = lambda _value: True
        portal_runner._table_preview_fingerprint = lambda: ("first row",)
        waits = []
        portal_runner._wait_for_piles_filter_response = lambda *args, **kwargs: waits.append(
            (args, kwargs)
        )
        portal_runner._filter_network_state = lambda *args, **kwargs: (
            "succeeded",
            {"authoritative": True, "item_count": 42},
        )
        portal_runner._wait_for_table_response_coherence = lambda *args, **kwargs: (
            "stable",
            True,
        )

        runner.CuracelPilesRunner.try_set_page_size(portal_runner, 100)

        self.assertEqual(portal_runner._filter_state["page_size"], 100)
        self.assertEqual(
            waits,
            [((11, "Aug", "2026", "Vetting Ongoing"), {"page_number": 1, "page_size": 100})],
        )


class ExecutionLedgerIntegrationTests(unittest.TestCase):
    def test_runner_heartbeat_phases_match_database_constraint(self):
        source = Path(runner.__file__).read_text()
        phases = set(__import__("re").findall(r'_heartbeat\("([^\"]+)"', source))

        self.assertTrue(phases)
        self.assertTrue(phases.issubset({
            "configuration", "login", "scan", "plan", "apply", "reconcile", "complete",
        }))

    def test_runner_heartbeat_updates_long_running_phase(self):
        phases = []
        portal = object.__new__(runner.CuracelPilesRunner)
        portal.execution_ledger = types.SimpleNamespace(
            heartbeat=lambda run_id, phase: phases.append((run_id, phase)),
        )
        portal.insurer_run_id = "insurer-run-1"

        portal._heartbeat("apply")

        self.assertEqual(phases, [("insurer-run-1", "apply")])

    def test_runner_heartbeat_is_a_noop_without_a_durable_run(self):
        portal = object.__new__(runner.CuracelPilesRunner)
        portal.execution_ledger = None
        portal.insurer_run_id = ""

        portal._heartbeat("scan")

    def test_runner_heartbeat_failure_never_interrupts_portal_work(self):
        portal = object.__new__(runner.CuracelPilesRunner)
        portal.execution_ledger = types.SimpleNamespace(
            heartbeat=lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("db unavailable")),
        )
        portal.insurer_run_id = "insurer-run-1"

        portal._heartbeat("apply")

    def test_read_only_flag_uses_non_writing_ledger(self):
        args = types.SimpleNamespace(read_only=True)
        store = types.SimpleNamespace(mode="postgres", database_url="postgres://unused")

        ledger = runner.build_execution_ledger(store, args)

        self.assertEqual(type(ledger).__name__, "ReadOnlyExecutionLedger")
        self.assertEqual(ledger.write_count, 0)

    def test_disabled_ledger_does_not_open_another_connection(self):
        args = types.SimpleNamespace(read_only=False)
        store = types.SimpleNamespace(mode="postgres", database_url="postgres://unused")
        previous = os.environ.pop("PILES_EXECUTION_LEDGER_ENABLED", None)
        try:
            self.assertIsNone(runner.build_execution_ledger(store, args))
        finally:
            if previous is not None:
                os.environ["PILES_EXECUTION_LEDGER_ENABLED"] = previous


class RunnerRunAdoptionTests(unittest.TestCase):
    def test_read_only_store_blocks_all_low_level_mutation_adapters(self):
        store = runner.DataStore.__new__(runner.DataStore)
        store.read_only = True
        store.mode = "postgres"
        store.conn = None
        store._execute_postgres("update anything set value = 1")
        store._insert_supabase("anything", {"secret": "value"})
        store._update_supabase("anything", "id", "1", {"secret": "value"})
        store.update_bot_with_history("bot-1", {"is_available": False}, source="test", reason="test")
        self.assertFalse(store.claim_coalesced_request("DEFMIS", "run-1"))

    def test_precreated_run_id_is_updated_instead_of_inserted_again(self):
        store = runner.DataStore.__new__(runner.DataStore)
        store.mode = "supabase"
        updates = []
        inserts = []
        store._fetchall_supabase = lambda *_args, **_kwargs: [{
            "id": "queued-run", "details": {"idempotency_key": "key-1"},
        }]
        store._update_supabase = lambda *args: updates.append(args)
        store._insert_supabase = lambda *args: inserts.append(args)

        result = store.create_runner_run(
            run_id="queued-run", insurer_name="DEFMIS", run_scope="single",
            portal_environment="production", backend="local", run_source="manual",
            months=["All"], year="All", mode="dry-run",
            details={"insurers": ["DEFMIS"]},
        )

        self.assertEqual(result, "queued-run")
        self.assertEqual(inserts, [])
        self.assertEqual(updates[0][3]["details"]["idempotency_key"], "key-1")


class AssignmentRuleLoadingTests(unittest.TestCase):
    def test_inactive_rule_is_not_applied(self):
        store = object.__new__(runner.DataStore)
        store.mode = "postgres"
        store._fetchall_postgres = lambda *_args, **_kwargs: [{
            "insurer_name": "Jubilee Uganda",
            "distribution_mode": "single_owner",
            "minimum_claim_chunk": 25,
            "reassignment_threshold_minutes": 120,
            "stale_claim_threshold": 40,
            "target_completion_gap_minutes": 30,
            "is_active": False,
        }]

        self.assertIsNone(runner.DataStore.get_rule(store, "Jubilee Uganda"))


class PerPileVerificationIntegrationTests(unittest.TestCase):
    def test_uncertain_item_does_not_abort_the_batch(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.execution_ledger = None
        portal_runner._open_assign_modal = lambda: None
        portal_runner._apply_assignment_modal = lambda *_args: "Daniel"
        pending = runner.classify_assignment_observations(
            {"pile-1": {"attempt_id": "", "expected_assignee": "Daniel"}},
            {},
        )[0]
        portal_runner.verify_assigned_rows = lambda *_args, **_kwargs: runner.AssignmentVerificationResult(
            False, ["<missing>"], 0, 1, [], [pending]
        )
        plan = make_pile(1)
        assignment = runner.PlannedAssignment(
            pile_key=plan.key, tracking_key=plan.tracking_key,
            assignee_id="daniel", assignee_name="Daniel", assignment_type="Vetting",
            insurer_name="Jubilee Uganda", provider=plan.provider,
            claim_month=plan.month, submitted_date=plan.submitted_date,
            claims=plan.claims, synced_claims=0, remaining_claims=plan.remaining_claims,
            current_status=plan.status, status_bucket=plan.status_bucket,
            filter_month=plan.filter_month, filter_year=plan.filter_year,
            source_page_number=1,
        )

        _assignee, applied = runner.CuracelPilesRunner._apply_selected_group(
            portal_runner, "All", "2026", "Vetting Pending", "Daniel", "Vetting",
            [assignment], True,
        )

        self.assertEqual(len(applied), 1)
        self.assertFalse(applied[0].verified_on_table)


class WorkerAdapterIntegrationTests(unittest.TestCase):
    def test_worker_scan_failure_persists_only_normalized_diagnostics(self):
        records = []
        class Ledger(runner.ReadOnlyExecutionLedger):
            def fail_scan_context(self, context_id, **fields):
                records.append(fields)
        browser = runner.CuracelPilesRunner()
        browser.safe_diagnostics = True
        browser.execution_ledger = Ledger()
        browser.insurer_run_id = "run"
        browser.year_filter_capabilities = lambda: (False, ["2026"])
        def fail(*_):
            raise RuntimeError('credential="SECRET" <html>patient</html>')
        browser._scan_status_with_transient_retry = fail
        with patch.object(sys, "stdout", io.StringIO()):
            with self.assertRaises(RuntimeError):
                browser.scan_all_rows(["All"], "2026")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["error_code"], "authentication_failed")
        self.assertNotIn("SECRET", repr(records))
        self.assertNotIn("patient", repr(records))

    def test_worker_factory_rejects_unsupported_capacity_before_opening_resources(self):
        from scripts.piles_auto_assignment.dispatch import ContextOutputRouter
        for capacity in (0, 3, True, "2"):
            with self.subTest(capacity=capacity):
                with self.assertRaises(ValueError):
                    runner.worker_context_factory(types.SimpleNamespace(read_only=False), ContextOutputRouter(io.StringIO()), max_concurrency=capacity)

    def test_worker_factory_closes_store_and_buffer_when_ledger_close_fails(self):
        from scripts.test_piles_auto_assignment_dispatch import claimed, Resource
        from scripts.piles_auto_assignment.dispatch import ContextOutputRouter
        store = Resource()
        class Ledger:
            def close(self):
                raise RuntimeError("expected close failure")
        router = ContextOutputRouter(io.StringIO())
        with patch.object(runner, "DataStore", lambda **_: store), patch.object(runner, "build_execution_ledger", lambda *_a, **_kw: Ledger()):
            with self.assertRaisesRegex(RuntimeError, "expected close failure"):
                with runner.worker_context_factory(types.SimpleNamespace(read_only=False), router)(claimed()) as context:
                    pass
        self.assertEqual(store.events, ["close"])
        self.assertTrue(context.output.closed)

    def test_dispatch_flag_is_explicit_opt_in(self):
        self.assertTrue(callable(getattr(runner, "dispatcher_v2_enabled", None)), "Dispatcher opt-in is missing")
        for value, expected in [(None, False), ("", False), ("false", False), ("garbage", False), (" TRUE ", True), ("1", True)]:
            environment = {} if value is None else {"PILES_AUTO_ASSIGNMENT_DISPATCHER_V2": value}
            self.assertIs(runner.dispatcher_v2_enabled(environment), expected)

    def test_worker_factory_owns_independent_connections_and_closes_on_failure(self):
        self.assertTrue(callable(getattr(runner, "worker_context_factory", None)), "Worker factory is missing")
        from scripts.test_piles_auto_assignment_dispatch import claimed
        from scripts.piles_auto_assignment.dispatch import ContextOutputRouter
        connections = []
        class Connection:
            autocommit = True
            closed = False
            def close(self):
                self.closed = True
        def connect(_url):
            connection = Connection()
            connections.append(connection)
            return connection
        args = types.SimpleNamespace(read_only=False)
        barrier = threading.Barrier(2)
        def visit(work):
            with factory(work) as context:
                barrier.wait(timeout=3)
                self.assertIsNot(context.store.conn, context.ledger.connection)
                self.assertTrue(context.store.conn.autocommit)
                self.assertFalse(context.ledger.connection.autocommit)
                return context
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://fixture", "PILES_EXECUTION_LEDGER_ENABLED": "false"}):
            with patch.object(runner.psycopg2, "connect", connect, create=True):
                with ContextOutputRouter.installed() as router:
                    factory = runner.worker_context_factory(args, router, max_concurrency=2)
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        contexts = list(pool.map(visit, [claimed("Kenya"), claimed("Uganda")]))
                    with self.assertRaisesRegex(ValueError, "expected"):
                        with factory(claimed()):
                            raise ValueError("expected")
        self.assertEqual(len(connections), 6)
        self.assertTrue(all(c.closed for c in connections))
        self.assertIsNot(contexts[0].store, contexts[1].store)
        self.assertIsNot(contexts[0].ledger, contexts[1].ledger)
        self.assertIsNot(contexts[0].output, contexts[1].output)
        self.assertTrue(all(c.output.closed for c in contexts))

    def test_worker_factory_closes_store_when_ledger_creation_fails(self):
        self.assertTrue(callable(getattr(runner, "worker_context_factory", None)), "Worker factory is missing")
        from scripts.test_piles_auto_assignment_dispatch import claimed, Resource
        from scripts.piles_auto_assignment.dispatch import ContextOutputRouter
        store = Resource()
        with patch.object(runner, "DataStore", lambda **_: store):
            with patch.object(runner, "build_execution_ledger", side_effect=RuntimeError("expected")):
                with self.assertRaisesRegex(RuntimeError, "expected"):
                    with runner.worker_context_factory(types.SimpleNamespace(read_only=False), ContextOutputRouter(io.StringIO()))(claimed()):
                        self.fail("must not yield")
        self.assertEqual(store.events, ["close"])

    def test_claim_adapter_records_once_owns_browser_and_does_not_share_arguments(self):
        self.assertTrue(callable(getattr(runner, "run_claimed_insurer_once", None)), "Single-claim runner is missing")
        from scripts.test_piles_auto_assignment_dispatch import claimed, Resource
        from scripts.piles_auto_assignment.dispatch import ContextOutputRouter, execute_claimed_insurer
        calls, browsers, contexts = [], [], []
        barrier = threading.Barrier(2)
        args = types.SimpleNamespace(read_only=True, values=[])
        months = ["All"]
        class Store(Resource):
            def __init__(self, **_):
                super().__init__()
            def get_master_account(self, name):
                return {"insurer_name": name}
        class Browser:
            closed = False
            def new_page(self, **_):
                return types.SimpleNamespace(on=lambda *_: None)
            def close(self):
                self.closed = True
        class Playwright:
            stopped = False
            def __init__(self):
                self.browser = Browser()
                self.chromium = types.SimpleNamespace(launch=lambda **_: self.browser)
                browsers.append(self)
            def stop(self):
                self.stopped = True
        def portal(store, local_args, name, local_months, year, visible, ledger, insurer_run_id):
            self.assertTrue(local_args.worker_safe_diagnostics)
            calls.append((name, insurer_run_id))
            with runner.CuracelPilesRunner():
                barrier.wait(timeout=3)
                local_args.values.append(name)
                local_months.append(name)
                if name == "Kenya":
                    raise TimeoutError('password="SECRET" <html>patient</html>')
                return {"notification_items": [name]}
        def execute(work):
            def run_one(work, context):
                contexts.append(context)
                return runner.run_claimed_insurer_once(work, context, args, months, "2026", False)
            return execute_claimed_insurer(work, factory, run_one)
        with patch.object(runner, "DataStore", Store), patch.object(runner, "run_for_insurer", portal):
            with patch.object(runner, "sync_playwright", lambda: types.SimpleNamespace(start=Playwright)):
                with ContextOutputRouter.installed() as router:
                    factory = runner.worker_context_factory(args, router, max_concurrency=2)
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        outcomes = list(pool.map(execute, [claimed("Kenya"), claimed("Uganda")]))
        self.assertEqual([item.status.value for item in outcomes], ["failed", "completed"])
        self.assertCountEqual([name for name, _ in calls], ["Kenya", "Uganda"])
        self.assertEqual(len({run_id for _, run_id in calls}), 2)
        self.assertEqual(len(browsers), 2)
        self.assertTrue(all(p.stopped and p.browser.closed for p in browsers))
        self.assertEqual(args.values, [])
        self.assertEqual(months, ["All"])
        self.assertNotIn("SECRET", repr(outcomes))
        self.assertTrue(all(c.store.events[-1] == "close" for c in contexts))

    def test_v2_recorded_error_is_sanitized_before_ledger_persistence(self):
        self.assertTrue(callable(getattr(runner, "run_claimed_insurer_once", None)), "Single-claim runner is missing")
        from scripts.test_piles_auto_assignment_dispatch import claimed, Resource
        from scripts.piles_auto_assignment.dispatch import WorkerContext
        records = []
        class Ledger(runner.ReadOnlyExecutionLedger):
            def finalize_insurer_run(self, run_id, **fields):
                records.append(fields)
        store = Resource()
        store.get_master_account = lambda name: {"insurer_name": name}
        context = WorkerContext(store, Ledger(), io.StringIO(), "worker")
        with patch.object(runner, "run_for_insurer", side_effect=RuntimeError('credential="SECRET" <html>patient</html>')):
            with self.assertRaises(RuntimeError):
                runner.run_claimed_insurer_once(claimed(), context, types.SimpleNamespace(), ["All"], "2026", False)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["error_code"], "authentication_failed")
        self.assertNotIn("SECRET", repr(records))
        self.assertNotIn("patient", repr(records))


class BrowserLifecycleTests(unittest.TestCase):
    def test_cleanup_failure_does_not_mask_original_portal_or_startup_error(self):
        def close_fail():
            raise RuntimeError("cleanup error")
        for stage in ("startup", "portal"):
            with self.subTest(stage=stage):
                events = []
                def page(**_):
                    if stage == "startup":
                        raise ValueError("original failure")
                    return types.SimpleNamespace(on=lambda *_: None)
                browser = types.SimpleNamespace(new_page=page, close=close_fail)
                playwright = types.SimpleNamespace(chromium=types.SimpleNamespace(launch=lambda **_: browser), stop=lambda: events.append("stopped"))
                with patch.object(runner, "sync_playwright", lambda: types.SimpleNamespace(start=lambda: playwright)):
                    with self.assertRaises(Exception) as caught:
                        with runner.CuracelPilesRunner():
                            raise ValueError("original failure")
                self.assertIsInstance(caught.exception, ValueError)
                self.assertEqual(str(caught.exception), "original failure")
                self.assertEqual(events, ["stopped"])

    def test_failed_browser_startup_closes_acquired_resources(self):
        for stage in ("launch", "new_page", "response"):
            with self.subTest(stage=stage):
                events = []
                def fail():
                    raise RuntimeError("expected startup failure")
                browser = types.SimpleNamespace(
                    new_page=lambda **_: fail() if stage == "new_page" else types.SimpleNamespace(on=lambda *_: fail()),
                    close=lambda: events.append("browser closed"),
                )
                playwright = types.SimpleNamespace(
                    chromium=types.SimpleNamespace(launch=lambda **_: fail() if stage == "launch" else browser),
                    stop=lambda: events.append("playwright stopped"),
                )
                with patch.object(runner, "sync_playwright", lambda: types.SimpleNamespace(start=lambda: playwright)):
                    with self.assertRaisesRegex(RuntimeError, "expected startup failure"):
                        with runner.CuracelPilesRunner():
                            self.fail("must not enter")
                self.assertEqual(events, ["playwright stopped"] if stage == "launch" else ["browser closed", "playwright stopped"])

    def test_browser_close_failure_still_stops_playwright(self):
        events = []
        def fail():
            raise RuntimeError("expected close failure")
        browser = runner.CuracelPilesRunner()
        browser.browser = types.SimpleNamespace(close=fail)
        browser.playwright = types.SimpleNamespace(stop=lambda: events.append("stopped"))
        with self.assertRaisesRegex(RuntimeError, "expected close failure"):
            browser.__exit__(None, None, None)
        self.assertEqual(events, ["stopped"])


if __name__ == "__main__":
    unittest.main()
