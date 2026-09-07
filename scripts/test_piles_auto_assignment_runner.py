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

    def test_scan_rejects_rows_rendered_for_a_different_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.apply_filters = lambda *_args: None
        portal_runner.try_set_page_size = lambda *_args: None
        stale_row = make_pile(1, filter_year="2025")
        stale_row.month = "Jul 2026"
        portal_runner.rows_on_current_page = lambda *_args: [stale_row]
        portal_runner.goto_next_page = lambda: False

        with self.assertRaisesRegex(RuntimeError, "expected year '2025'.*Jul 2026"):
            runner.CuracelPilesRunner.scan_status(
                portal_runner,
                "All",
                "2025",
                "Vetting Pending",
            )

    def test_scan_accepts_month_only_rows_after_the_filter_request_is_confirmed(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner.apply_filters = lambda *_args: None
        portal_runner.try_set_page_size = lambda *_args: None
        month_only_row = make_pile(1, filter_year="2025")
        month_only_row.month = "Jul"
        portal_runner.rows_on_current_page = lambda *_args: [month_only_row]
        portal_runner.goto_next_page = lambda: False

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
            "2025",
            timeout_ms=1,
        )

    def test_filter_wait_requires_and_finishes_the_matching_year_response(self):
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
            "2025",
            timeout_ms=1,
        )

        self.assertEqual(response.finished_calls, 1)

    def test_filter_wait_rejects_a_response_for_the_previous_year(self):
        portal_runner = object.__new__(runner.CuracelPilesRunner)
        portal_runner._piles_response_events = [
            (1, 200, "https://api.health.curacel.co/api/piles?year=2026&page=1", object()),
        ]

        with self.assertRaisesRegex(RuntimeError, "No completed Piles data request.*2025"):
            runner.CuracelPilesRunner._wait_for_piles_filter_response(
                portal_runner,
                0,
                "2025",
                timeout_ms=1,
            )


if __name__ == "__main__":
    unittest.main()
