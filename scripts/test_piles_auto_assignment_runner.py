import importlib.util
import io
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
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


class EvidenceTimingTests(unittest.TestCase):
    class Clock:
        ns = 0

        def advance(self, ms):
            self.ns += int(ms * 1_000_000)

    def fixture(self, snapshot=None, network=None):
        clock = self.Clock()
        browser = runner.CuracelPilesRunner()
        browser._piles_request_tracking = True  # Installed page request/response hooks.
        controls = {'month': 'All', 'year': '2026', 'status': 'Vetting Pending'}
        selection_at = None

        class Control(str):
            def element_handle(self, **_): return self
            def dispose(self): pass

        class Locator:
            first = property(lambda self: self)
            def count(self): return 0

        class Page:
            def locator(self, _): return Locator()
            def wait_for_timeout(self, ms): clock.advance(ms)

        browser.page = Page()
        browser._reset_pagination_to_first_page = lambda: None
        browser._table_preview_fingerprint = lambda: ()
        browser._direct_month_control = lambda: Control('month')
        browser._direct_status_control = lambda _: Control('status')
        browser._read_select_text = lambda control: controls.get(control, '')
        browser._read_year_chip_text = lambda: controls['year']
        def select(control, value, **_):
            nonlocal selection_at
            controls[control] = value
            if control == 'status': selection_at = clock.ns
            return True
        browser._set_select_value = select
        browser._apply_year_filter = lambda value: Control('year') if select('year', value) else None
        browser._settled_year_control = Control('year')
        browser._settled_year_display = '2026'
        source_snapshot = snapshot or (lambda: {
            'headers': [], 'rows': [], 'loading': False, 'table_visible': True, 'explicit_empty': True})
        def read_snapshot():
            value = runner.deepcopy(source_snapshot())
            if selection_at is not None and clock.ns - selection_at < 200_000_000:
                value['loading'] = True
            return value
        browser._table_context_snapshot = read_snapshot
        def joint_snapshot(_):
            value = runner.deepcopy(browser._table_context_snapshot())
            value['filter_controls'] = {key: browser._read_select_text(key) for key in controls}
            return value
        browser._filter_context_snapshot = joint_snapshot
        if network:
            browser._filter_network_state = lambda *_, **__: network(clock)
        return browser, clock

    def run_filters(self, browser, clock, statuses, *, scan=False):
        with patch.object(runner.time, 'monotonic_ns', side_effect=lambda: clock.ns), \
             patch.object(runner.time, 'time', side_effect=lambda: clock.ns / 1e9), \
             patch.object(runner.time, 'sleep', side_effect=lambda _: self.fail('unconditional sleep')), \
             patch('sys.stdout', new_callable=io.StringIO):
            action = browser.scan_status if scan else browser.apply_filters
            return [action('All', '2026', status) for status in statuses]

    def test_previous_empty_context_waits_for_delayed_nonempty_generation(self):
        browser, clock = self.fixture()
        empty = browser._table_context_snapshot()
        rows = {
            'headers': ['Provider', 'Claims', 'Month', 'Provider Bill', 'Submitted Date', 'Status'],
            'rows': [['A', '10', 'Sep', '1000', '2026-09-09', 'Vetting Pending']],
            'loading': False, 'table_visible': True, 'explicit_empty': False}
        browser._table_context_snapshot = lambda: empty if clock.ns < 2_000_000_000 else rows
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&month=0&status%5Bcode%5D=VETTING_PENDING'
        request = types.SimpleNamespace(method='GET', url=url)
        class Response:
            status = 200
            def json(self):
                return {'data': [{'provider': {'name': 'A'}, 'submitted_claims_count': 10,
                                 'month': 'Sep', 'amount_requested': 1000,
                                 'last_claim_submitted_at': '2026-09-09T10:00:00Z'}], 'total': 1}
        response = Response()
        response.request, response.url = request, url
        select = browser._set_select_value
        def set_control(control, value, **kwargs):
            if control == 'status':
                getattr(browser, '_capture_piles_request', lambda _: None)(request)
            return select(control, value, **kwargs)
        browser._set_select_value = set_control
        def tick(ms):
            clock.advance(ms)
            if clock.ns == 2_000_000_000:
                browser._capture_piles_response(response)
                getattr(browser, '_finish_piles_request', lambda _: None)(request)
        browser.page.wait_for_timeout = tick
        browser.try_set_page_size = lambda _: None
        browser.wait_for_table_ready = lambda **_: 'stable'
        pile = runner.replace(make_pile(1), month='Sep', submitted_date='2026-09-09', filter_month='All')
        browser.rows_on_current_page = lambda *_: [pile] if clock.ns >= 2_000_000_000 else []
        browser.goto_next_page = lambda *_, **__: False
        result = self.run_filters(browser, clock, ['Vetting Pending'], scan=True)[0]
        self.assertEqual([row.key for row in result], ['pile-1'])
        self.assertGreaterEqual(clock.ns, 2_300_000_000)
        self.assertLess(clock.ns, 3_000_000_000)

    def test_live_target_http_failure_survives_terminal_request_history_churn(self):
        browser, clock = self.fixture()
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING'
        target = types.SimpleNamespace(method='GET', url=url)
        select = browser._set_select_value
        def set_control(control, value, **kwargs):
            if control == 'status':
                browser._capture_piles_request(target)
                for index in range(101):
                    other = types.SimpleNamespace(method='GET', url=url + '&per_page=' + str(index))
                    browser._capture_piles_request(other)
                    browser._finish_piles_request(other)
            return select(control, value, **kwargs)
        browser._set_select_value = set_control
        def tick(ms):
            clock.advance(ms)
            if clock.ns == 1_000_000_000:
                browser._capture_piles_response(types.SimpleNamespace(request=target, url=url, status=500))
                browser._finish_piles_request(target)
        browser.page.wait_for_timeout = tick
        with self.assertRaisesRegex(RuntimeError, 'filter_response_failed'):
            self.run_filters(browser, clock, ['Vetting Pending'], scan=True)
        self.assertEqual(browser._filter_state['status'], '')

    def test_live_request_metadata_is_separate_from_bounded_terminal_history(self):
        browser = runner.CuracelPilesRunner()
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1'
        target = types.SimpleNamespace(method='GET', url=url)
        browser._capture_piles_request(target)
        started = browser._piles_request_sequence
        for _ in range(200):
            other = types.SimpleNamespace(method='GET', url=url)
            browser._capture_piles_request(other)
            browser._finish_piles_request(other)
        browser._capture_piles_response(types.SimpleNamespace(request=target, url=url, status=500))
        self.assertEqual(browser._piles_response_request_starts[browser._piles_response_sequence], started)
        self.assertEqual(len(browser._piles_pending_requests), 1)
        self.assertLessEqual(len(browser._piles_request_starts), 100)
        browser._finish_piles_request(target)
        self.assertEqual(len(browser._piles_pending_requests), 0)
        self.assertLessEqual(len(browser._piles_request_starts), 100)

    def test_active_tracking_overflow_stays_guarded_after_known_requests_drain(self):
        browser = runner.CuracelPilesRunner()
        requests = [types.SimpleNamespace(method='GET', url='https://api.health.curacel.co/api/piles?year=2026')
                    for _ in range(101)]
        for request in requests:
            browser._capture_piles_request(request)
        self.assertEqual(len(browser._piles_pending_requests), 100)
        self.assertEqual(len(browser._piles_request_starts), 0)
        self.assertTrue(browser._piles_request_overflow)
        for request in requests:
            browser._finish_piles_request(request)
        self.assertEqual(len(browser._piles_pending_requests), 0)
        self.assertEqual(len(browser._piles_request_starts), 100)
        self.assertEqual(len(browser._piles_request_events), 100)
        browser._invalidate_filter_state()
        self.assertEqual(browser._filter_request_state(0, 'All', '2026', 'All'), 'pending')

    def test_uncorrelated_response_disables_fresh_empty_shortcut(self):
        browser, clock = self.fixture()
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING'
        request = types.SimpleNamespace(method='GET', url=url)
        def tick(ms):
            clock.advance(ms)
            if clock.ns == 500_000_000:
                browser._capture_piles_response(types.SimpleNamespace(request=request, url=url, status=500))
        browser.page.wait_for_timeout = tick
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'], scan=True)
        self.assertTrue(browser._piles_request_overflow)
        self.assertEqual(clock.ns, 30_000_000_000)

    def test_joint_browser_script_reads_all_controls_and_table_in_one_turn(self):
        browser = runner.CuracelPilesRunner()
        calls = []
        def evaluate(script, controls):
            calls.append(controls)
            # Execute the production browser function, not a reimplementation of
            # its observations. This tiny DOM has an explicit-empty table.
            harness = r"""
const fs = require('node:fs');
const script = fs.readFileSync(0, 'utf8');
const node = (innerText) => ({innerText, isConnected: true,
  getBoundingClientRect: () => ({width: 10, height: 10})});
const cell = node('No Data Found');
const table = {...node(''), querySelector: () => ({}),
  querySelectorAll: (selector) => selector === 'tbody td' ? [cell] : []};
global.window = {getComputedStyle: () => ({display: 'block', visibility: 'visible'})};
global.document = {querySelectorAll: (selector) => selector === 'table' ? [table] : []};
const controls = {month: node('September'), year: node('2026'), status: node('Vetting Pending')};
controls.year.isConnected = false;
process.stdout.write(JSON.stringify(eval('(' + script + ')')(controls)));
"""
            result = subprocess.run(['node', '-e', harness], input=script, text=True,
                                    capture_output=True, check=True)
            return runner.json.loads(result.stdout)
        browser.page = types.SimpleNamespace(evaluate=evaluate)
        snapshot = browser._browser_context_snapshot({'month': 'm', 'year': 'y', 'status': 's'})
        self.assertEqual(len(calls), 1)
        self.assertEqual(snapshot['filter_controls'], {'month': 'September', 'year': None, 'status': 'Vetting Pending'})
        self.assertTrue(snapshot['explicit_empty'])
        self.assertEqual(snapshot['rows'], [])

    def test_scan_rejects_year_mutation_at_actual_table_evaluate_boundary(self):
        browser, clock = self.fixture(network=lambda _: ('succeeded', {
            'authoritative': True, 'authoritative_empty': True, 'item_count': 0}))
        read_control = browser._read_select_text
        year = ['2026']
        tick_reads = {}
        browser._read_select_text = lambda control: year[0] if control == 'year' else read_control(control)
        def evaluate(_script, *args):
            # This callback boundary is the last browser read in the old loop.
            # Its table stays identical while the actual year control changes.
            tick_reads[clock.ns] = tick_reads.get(clock.ns, 0) + 1
            if clock.ns >= 1_500_000_000 and (args or tick_reads[clock.ns] >= 2):
                year[0] = '2025'
            snapshot = {'headers': [], 'rows': [], 'loading': False, 'table_visible': True,
                        'explicit_empty': True}
            if args:
                snapshot['filter_controls'] = {'month': 'All', 'year': year[0], 'status': 'Vetting Pending'}
            return snapshot
        browser.page.evaluate = evaluate
        browser._table_context_snapshot = types.MethodType(runner.CuracelPilesRunner._table_context_snapshot, browser)
        browser._filter_context_snapshot = types.MethodType(runner.CuracelPilesRunner._filter_context_snapshot, browser)
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'], scan=True)
        self.assertEqual(clock.ns, 30_000_000_000)

    def test_atomic_observation_checks_each_control_on_changed_and_noop_filters(self):
        for noop in (False, True):
            for changed, value in [('month', 'September'), ('year', '2025'), ('status', 'Audit Pending')]:
                with self.subTest(noop=noop, control=changed):
                    browser, clock = self.fixture(network=lambda _: ('succeeded', {
                        'authoritative': True, 'authoritative_empty': True, 'item_count': 0}))
                    if noop:
                        browser._filter_state.update(month='All', year='2026', status='Vetting Pending')
                    def evaluate(_script, handles=None):
                        controls = {'month': 'All', 'year': '2026', 'status': 'Vetting Pending'}
                        if clock.ns >= 200_000_000:
                            controls[changed] = value
                        return {'headers': [], 'rows': [], 'loading': False, 'table_visible': True,
                                'explicit_empty': True, 'filter_controls': controls}
                    browser.page.evaluate = evaluate
                    browser._filter_context_snapshot = types.MethodType(runner.CuracelPilesRunner._filter_context_snapshot, browser)
                    with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
                        self.run_filters(browser, clock, ['Vetting Pending'], scan=True)
                    self.assertEqual(clock.ns, (6 if noop else 30) * 1_000_000_000)

    def test_actual_atomic_evaluate_retains_fresh_empty_grace(self):
        browser, clock = self.fixture()
        def evaluate(_script, handles=None):
            return {'headers': [], 'rows': [], 'loading': bool(handles) and clock.ns < 200_000_000,
                    'table_visible': True, 'explicit_empty': True,
                    'filter_controls': {'month': 'All', 'year': '2026', 'status': 'Vetting Pending'}}
        browser.page.evaluate = evaluate
        browser._table_context_snapshot = types.MethodType(runner.CuracelPilesRunner._table_context_snapshot, browser)
        browser._filter_context_snapshot = types.MethodType(runner.CuracelPilesRunner._filter_context_snapshot, browser)
        self.assertEqual(self.run_filters(browser, clock, ['Vetting Pending'], scan=True), [[]])
        self.assertEqual(clock.ns, 1_500_000_000)

    def test_atomic_handle_cleanup_precedes_observation_and_is_bounded(self):
        browser = runner.CuracelPilesRunner()
        events = []
        class Handle:
            def dispose(self): events.append('dispose')
        class Control:
            def element_handle(self, **_):
                events.append('resolve')
                return Handle()
        def evaluate(*_):
            events.append('evaluate')
            return {'rows': []}
        browser.page = types.SimpleNamespace(evaluate=evaluate)
        controls = {name: Control() for name in ('month', 'year', 'status')}
        browser._filter_context_snapshot(controls)
        self.assertEqual(events, ['resolve'] * 3 + ['evaluate'])
        events.clear()
        browser._filter_context_snapshot(controls)
        self.assertEqual(events, ['dispose'] * 3 + ['resolve'] * 3 + ['evaluate'])
        self.assertEqual(len(browser._filter_observation_handles), 3)

    def test_fallback_layout_changed_and_noop_scan_use_semantic_status_control(self):
        clock = self.Clock()
        browser = runner.CuracelPilesRunner()
        opened = [None]
        observations = []
        class Control:
            def __init__(self, name, text, options, x):
                self.name, self.text, self.options, self.x = name, text, options, x
            def inner_text(self): return self.text
            def get_attribute(self, _): return ''  # No semantic labels in this layout.
            def bounding_box(self): return {'x': self.x, 'y': 100}
            def is_visible(self): return True
            def element_handle(self, **_): return self
            def dispose(self): pass
        month = Control('month', 'All', ['All', 'Jan', 'Feb', 'Mar'], 0)
        year = Control('year', '2026', ['2025', '2026'], 100)
        status = Control('status', 'Audit Pending', runner.TARGET_STATUSES, 200)
        visible_controls = [month, year, status]
        class Collection:
            def __init__(self, values): self.values = values
            first = property(lambda self: self.values[0] if self.values else self)
            def count(self): return len(self.values)
            def nth(self, index): return self.values[index]
        class Page:
            def locator(self, selector):
                return Collection(visible_controls if selector == '.p-select.p-component' else [])
            def wait_for_timeout(self, ms): clock.advance(ms)
            def evaluate(self, script, handles=None):
                # Honor the actual locators passed by production. Returning
                # expected control names here would conceal the fallback bug.
                texts = {key: node.inner_text() if node is not None else None
                         for key, node in (handles or {}).items()}
                if handles:
                    observations.append({key: node.name if node is not None else None
                                         for key, node in handles.items()})
                harness = r"""
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const node = (innerText) => ({innerText, isConnected: true,
  getBoundingClientRect: () => ({width: 10, height: 10})});
const cell = node('No Data Found');
const table = {...node(''), querySelector: () => ({}),
  querySelectorAll: (selector) => selector === 'tbody td' ? [cell] : []};
global.window = {getComputedStyle: () => ({display: 'block', visibility: 'visible'})};
global.document = {querySelectorAll: (selector) => selector === 'table' ? [table] : []};
const controls = Object.fromEntries(Object.entries(input.texts).map(([key, text]) =>
  [key, text === null ? null : node(text)]));
process.stdout.write(JSON.stringify(eval('(' + input.script + ')')(controls)));
"""
                result = subprocess.run(['node', '-e', harness],
                                        input=runner.json.dumps({'script': script, 'texts': texts}),
                                        text=True, capture_output=True, check=True)
                return runner.json.loads(result.stdout)
        browser.page = Page()
        browser._reset_pagination_to_first_page = lambda: None
        browser._table_preview_fingerprint = lambda: ()
        browser._open_select = lambda control: opened.__setitem__(0, control) or True
        browser._dropdown_option_texts = lambda control=None: (control or opened[0]).options
        browser._close_dropdown = lambda: None
        def choose(value, control=None):
            if value not in control.options: return None
            control.text = value
            return value
        browser._choose_option_from_open_dropdown = choose
        browser._filter_state.update(year='2026')
        browser._settled_year_control, browser._settled_year_display = year, '2026'
        browser._filter_network_state = lambda *_, **__: ('succeeded', {
            'authoritative': True, 'authoritative_empty': True, 'item_count': 0})

        self.assertEqual(self.run_filters(browser, clock, ['Vetting Pending'], scan=True), [[]])
        self.assertEqual(clock.ns, 1_500_000_000)
        self.assertEqual(self.run_filters(browser, clock, ['Vetting Pending'], scan=True), [[]])
        self.assertEqual(clock.ns, 1_800_000_000)
        browser._settled_status_control = None
        self.assertEqual(self.run_filters(browser, clock, ['Vetting Pending'], scan=True), [[]])
        self.assertEqual(clock.ns, 2_100_000_000)
        # Month must also retain its validated identity for status-only changes,
        # even if a fallback layout now puts the year control first.
        month.x, year.x = 100, 0
        self.assertEqual(self.run_filters(browser, clock, ['Audit Ongoing'], scan=True), [[]])
        self.assertEqual(clock.ns, 3_600_000_000)
        self.assertEqual(self.run_filters(browser, clock, ['Audit Ongoing'], scan=True), [[]])
        self.assertEqual(clock.ns, 3_900_000_000)
        self.assertTrue(observations)
        self.assertTrue(all(observation == {'month': 'month', 'year': 'year', 'status': 'status'}
                            for observation in observations))
        # A reused locator may resolve to the wrong node after a DOM rerender.
        # The joint JS must inspect that actual node, not the cached label.
        status.element_handle = lambda **_: month
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Audit Ongoing'], scan=True)
        self.assertEqual(clock.ns, 9_900_000_000)
        self.assertEqual(observations[-1]['status'], 'month')
        status.options = ['All']
        self.assertIsNone(browser._direct_status_control(month))

    def test_filter_invalidation_discards_all_validated_control_locators(self):
        browser = runner.CuracelPilesRunner()
        browser._settled_month_control = object()
        browser._settled_year_control = object()
        browser._settled_status_control = object()
        browser._settled_year_display = '2026'
        browser._invalidate_filter_state()
        self.assertIsNone(browser._settled_month_control)
        self.assertIsNone(browser._settled_year_control)
        self.assertIsNone(browser._settled_status_control)
        self.assertEqual(browser._settled_year_display, '')

    def test_response_json_callback_cannot_accept_prior_dom_and_prior_response(self):
        browser, clock = self.fixture()
        snapshot = browser._table_context_snapshot()
        browser._table_context_snapshot = lambda: runner.deepcopy(snapshot)
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&month=0&status%5Bcode%5D=VETTING_PENDING'
        request = types.SimpleNamespace(method='GET', url=url)
        failed_request = types.SimpleNamespace(method='GET', url=url)
        failed = types.SimpleNamespace(request=failed_request, url=url, status=500)
        class Response:
            status = 200
            def json(self):
                if clock.ns >= 1_500_000_000 and not snapshot['rows']:
                    snapshot['rows'] = [['new row']]
                    snapshot['explicit_empty'] = False
                    browser._capture_piles_request(failed_request)
                    browser._capture_piles_response(failed)
                    browser._finish_piles_request(failed_request)
                return {'data': [], 'total': 0}
        response = Response()
        response.request, response.url = request, url
        select = browser._set_select_value
        def set_control(control, value, **kwargs):
            if control == 'status':
                browser._capture_piles_request(request)
                browser._capture_piles_response(response)
                browser._finish_piles_request(request)
            return select(control, value, **kwargs)
        browser._set_select_value = set_control
        with self.assertRaisesRegex(RuntimeError, 'filter_response_failed'):
            self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertEqual(browser._filter_state['status'], '')

    def test_unchanged_empty_without_request_or_dom_transition_is_unknown(self):
        browser, clock = self.fixture()
        snapshot = browser._table_context_snapshot()
        browser._table_context_snapshot = lambda: snapshot
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertEqual(clock.ns, 30_000_000_000)

    def test_pending_request_blocks_fresh_dom_until_request_lifecycle_settles(self):
        browser, clock = self.fixture()
        self.assertTrue(hasattr(browser, '_capture_piles_request'), 'request lifecycle capture missing')
        request = types.SimpleNamespace(method='GET', url='https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING')
        select = browser._set_select_value
        def set_control(control, value, **kwargs):
            if control == 'status': browser._capture_piles_request(request)
            return select(control, value, **kwargs)
        browser._set_select_value = set_control
        def tick(ms):
            clock.advance(ms)
            if clock.ns == 2_000_000_000: browser._finish_piles_request(request)
        browser.page.wait_for_timeout = tick
        result = self.run_filters(browser, clock, ['Vetting Pending'])[0]
        self.assertEqual(result.table_state, 'empty')
        self.assertGreaterEqual(clock.ns, 2_000_000_000)
        self.assertLessEqual(clock.ns, 2_400_000_000)

    def test_request_completion_alone_cannot_relabel_unchanged_empty_dom(self):
        browser, clock = self.fixture()
        snapshot = browser._table_context_snapshot()
        browser._table_context_snapshot = lambda: snapshot
        request = types.SimpleNamespace(method='GET', url='https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING')
        select = browser._set_select_value
        def set_control(control, value, **kwargs):
            if control == 'status':
                browser._capture_piles_request(request)
                browser._finish_piles_request(request)
            return select(control, value, **kwargs)
        browser._set_select_value = set_control
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'])

    def test_old_request_response_cannot_replace_current_generation_response(self):
        browser = runner.CuracelPilesRunner()
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING'
        old = types.SimpleNamespace(method='GET', url=url)
        current = types.SimpleNamespace(method='GET', url=url)
        browser._capture_piles_request(old)
        request_marker = browser._piles_request_sequence
        browser._capture_piles_request(current)
        browser._capture_piles_response(types.SimpleNamespace(request=current, url=url, status=200,
            json=lambda: {'data': [{'id': 'new-row'}], 'total': 1}))
        browser._finish_piles_request(current)
        browser._capture_piles_response(types.SimpleNamespace(request=old, url=url, status=200,
            json=lambda: {'data': [], 'total': 0}))
        browser._finish_piles_request(old)
        state, details = browser._filter_network_state(0, 'All', '2026', 'Vetting Pending',
                                                      page_number=1, request_marker=request_marker)
        self.assertEqual(state, 'succeeded')
        self.assertEqual(details['item_count'], 1)

    def test_page_open_fallback_cannot_reintroduce_late_old_generation_response(self):
        browser, clock = self.fixture()
        snapshot = browser._table_context_snapshot()
        browser._table_context_snapshot = lambda: snapshot
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING'
        request = types.SimpleNamespace(method='GET', url=url)
        browser._capture_piles_request(request)
        response = types.SimpleNamespace(request=request, url=url, status=200,
                                         json=lambda: {'data': [], 'total': 0})
        def tick(ms):
            clock.advance(ms)
            if clock.ns == 1_000_000_000:
                browser._capture_piles_response(response)
                browser._finish_piles_request(request)
        browser.page.wait_for_timeout = tick
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'])

    def test_response_json_dom_mutation_without_new_network_event_is_revalidated(self):
        browser, clock = self.fixture()
        snapshot = browser._table_context_snapshot()
        browser._table_context_snapshot = lambda: runner.deepcopy(snapshot)
        def network(*_, **__):
            if clock.ns >= 1_500_000_000:
                snapshot['rows'] = [['unexpected row']]
                snapshot['explicit_empty'] = False
            return 'succeeded', {'authoritative': True, 'authoritative_empty': True, 'item_count': 0}
        browser._filter_network_state = network
        with self.assertRaisesRegex(RuntimeError, 'filter_dom_response_mismatch'):
            self.run_filters(browser, clock, ['Vetting Pending'])

    def test_noop_filter_also_fences_callback_mutated_network_and_dom(self):
        browser, clock = self.fixture()
        browser._filter_state.update(month='All', year='2026', status='Vetting Pending')
        state = ['empty']
        url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING'
        request = types.SimpleNamespace(method='GET', url=url)
        failed = types.SimpleNamespace(request=request, url=url, status=500)
        browser._capture_piles_request(request)
        class Response:
            status = 200
            def json(self):
                state[0] = 'stable'
                browser._capture_piles_response(failed)
                return {'data': [], 'total': 0}
        response = Response()
        response.request, response.url = request, url
        injected = False
        read_snapshot = browser._filter_context_snapshot
        def table_ready(controls):
            nonlocal injected
            if not injected:
                injected = True
                browser._capture_piles_response(response)
            snapshot = read_snapshot(controls)
            if state[0] == 'stable':
                snapshot.update(rows=[['new row']], explicit_empty=False)
            return snapshot
        browser._filter_context_snapshot = table_ready
        with self.assertRaisesRegex(RuntimeError, 'filter_response_failed'):
            self.run_filters(browser, clock, ['Vetting Pending'])

    def test_request_failure_vetoes_fresh_empty_without_exposing_error(self):
        browser, clock = self.fixture()
        request = types.SimpleNamespace(method='GET', url='https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING', failure='secret https://fixture/patient')
        select = browser._set_select_value
        def set_control(control, value, **kwargs):
            if control == 'status':
                browser._capture_piles_request(request)
                browser._fail_piles_request(request)
            return select(control, value, **kwargs)
        browser._set_select_value = set_control
        with self.assertRaisesRegex(RuntimeError, '^Piles filters were not confirmed: filter_response_failed.$'):
            self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertNotIn('secret', runner.json.dumps(browser.phase_timer.serialize()))

    def test_current_generation_authoritative_rows_and_empty_still_settle_at_grace(self):
        for populated in (False, True):
            with self.subTest(populated=populated):
                snapshot = {
                    'headers': ['Provider', 'Claims', 'Month', 'Provider Bill', 'Submitted Date', 'Status'],
                    'rows': [['A', '10', 'Sep', '1000', '2026-09-09', 'Vetting Pending']] if populated else [],
                    'loading': False, 'table_visible': True, 'explicit_empty': not populated}
                browser, clock = self.fixture(snapshot=lambda: snapshot)
                url = 'https://api.health.curacel.co/api/piles?year=2026&page=1&status%5Bcode%5D=VETTING_PENDING'
                request = types.SimpleNamespace(method='GET', url=url)
                payload = {'data': [{'provider': {'name': 'A'}, 'submitted_claims_count': 10,
                                    'month': 'Sep', 'amount_requested': 1000,
                                    'last_claim_submitted_at': '2026-09-09T10:00:00Z'}] if populated else [],
                           'total': 1 if populated else 0}
                response = types.SimpleNamespace(request=request, url=url, status=200, json=lambda: payload)
                select = browser._set_select_value
                def set_control(control, value, **kwargs):
                    if control == 'status': browser._capture_piles_request(request)
                    return select(control, value, **kwargs)
                browser._set_select_value = set_control
                def tick(ms):
                    clock.advance(ms)
                    if clock.ns == 200_000_000:
                        browser._capture_piles_response(response)
                        browser._finish_piles_request(request)
                browser.page.wait_for_timeout = tick
                result = self.run_filters(browser, clock, ['Vetting Pending'])[0]
                self.assertEqual(result.table_state, 'stable' if populated else 'empty')
                self.assertEqual(clock.ns, 1_500_000_000)

    def test_five_explicit_empty_statuses_settle_near_grace_without_sleep(self):
        browser, clock = self.fixture()
        result = self.run_filters(browser, clock, ['Vetting Pending', 'Vetting Ongoing',
                                 'Audit Pending', 'Audit Ongoing', 'AI Audit'])
        self.assertEqual(len(result), 5)
        self.assertTrue(all(item.table_state == 'empty' for item in result))
        self.assertTrue(all(runner.evaluate_filter_evidence(item).accepted for item in result))
        self.assertGreaterEqual(clock.ns, 7_500_000_000)
        self.assertLessEqual(clock.ns, 8_000_000_000)
        self.assertTrue(hasattr(browser, 'phase_timer'), 'runner timing missing')
        filters = [row for row in browser.phase_timer.serialize() if row['operation'] == 'filter']
        self.assertEqual(filters[0]['count'], 5)
        self.assertEqual(filters[0]['total_ms'], 7500)

    def test_response_arriving_during_grace_can_veto_empty_dom(self):
        browser, clock = self.fixture(network=lambda clock: (
            ('succeeded', {'authoritative': True, 'authoritative_empty': False, 'item_count': 2})
            if clock.ns >= 1_000_000_000 else ('not_observed', {})))
        with self.assertRaisesRegex(RuntimeError, 'empty_ui_conflicts_with_response'):
            self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertLess(clock.ns, 1_500_000_000)
        self.assertEqual(browser._filter_state['status'], '')

    def test_unreadable_table_waits_for_full_cap_and_never_accepts(self):
        browser, clock = self.fixture(snapshot=lambda: {'loading': True})
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertEqual(clock.ns, 30_000_000_000)

    def test_unreadable_response_cannot_be_bypassed_by_empty_dom(self):
        browser, clock = self.fixture(network=lambda _: ('succeeded', {'authoritative': False}))
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertEqual(clock.ns, 30_000_000_000)

    def test_rows_require_matching_visible_context_not_just_any_stable_table(self):
        for visible_status, accepted in [('Vetting Pending', True), ('Completed', False)]:
            with self.subTest(visible_status=visible_status):
                browser, clock = self.fixture(snapshot=lambda: {
                    'headers': ['Provider', 'Claims', 'Month', 'Provider Bill', 'Submitted Date', 'Status'],
                    'rows': [['fixture', '2', 'Sep', 'BILL', '2026-09-01', visible_status]],
                    'loading': False, 'table_visible': True, 'explicit_empty': False})
                if accepted:
                    evidence = self.run_filters(browser, clock, ['Vetting Pending'])[0]
                    self.assertEqual(evidence.table_state, 'stable')
                    self.assertEqual(clock.ns, 1_500_000_000)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
                        self.run_filters(browser, clock, ['Vetting Pending'])
                    self.assertEqual(clock.ns, 30_000_000_000)

    def test_transient_empty_then_loading_does_not_pass_at_grace(self):
        browser, clock = self.fixture()
        browser._table_context_snapshot = lambda: {
            'headers': [], 'rows': [], 'table_visible': True, 'explicit_empty': True,
            'loading': 1_000_000_000 <= clock.ns < 2_000_000_000}
        self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertGreaterEqual(clock.ns, 2_300_000_000)

    def test_authoritative_response_waits_while_table_is_loading(self):
        browser, clock = self.fixture(network=lambda _: ('succeeded', {
            'authoritative': True, 'authoritative_empty': True, 'item_count': 0}))
        browser._table_context_snapshot = lambda: {
            'headers': [], 'rows': [], 'table_visible': True, 'explicit_empty': True,
            'loading': clock.ns < 2_000_000_000}
        self.run_filters(browser, clock, ['Vetting Pending'])
        self.assertGreaterEqual(clock.ns, 2_300_000_000)

    def test_authoritative_empty_keeps_legacy_no_table_markup_acceptance(self):
        browser, clock = self.fixture(
            snapshot=lambda: {'headers': [], 'rows': [], 'loading': False, 'table_visible': False},
            network=lambda _: ('succeeded', {'authoritative': True, 'authoritative_empty': True, 'item_count': 0}))
        evidence = self.run_filters(browser, clock, ['Vetting Pending'])[0]
        self.assertEqual(evidence.table_state, 'structurally_empty')
        self.assertEqual(clock.ns, 1_500_000_000)

    def test_year_control_drift_during_grace_cannot_accept_empty_dom(self):
        browser, clock = self.fixture()
        original = browser._read_select_text
        browser._read_select_text = lambda control: (
            '2025' if control == 'year' and clock.ns >= 500_000_000 else original(control))
        with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
            self.run_filters(browser, clock, ['Vetting Pending'])

    def test_filter_settlement_timeout_uses_existing_single_clean_page_retry(self):
        browser = runner.CuracelPilesRunner()
        attempts = []
        browser.open_piles = lambda: attempts.append('reload')
        def scan(*_, **__):
            attempts.append('scan')
            raise RuntimeError('Piles filters were not confirmed: filter_settlement_timeout.')
        browser.scan_status = scan
        with patch('sys.stdout', new_callable=io.StringIO):
            with self.assertRaisesRegex(RuntimeError, 'filter_settlement_timeout'):
                browser._scan_status_with_transient_retry('All', '2026', 'Vetting Pending')
        self.assertEqual(attempts, ['scan', 'reload', 'scan'])

    def test_filter_option_click_relies_on_selection_confirmation_not_sleep(self):
        browser = runner.CuracelPilesRunner()
        selected = []
        class Option:
            def inner_text(self): return 'Vetting Pending'
            def click(self): selected.append('Vetting Pending')
        class Options:
            def count(self): return 1
            def nth(self, _): return Option()
        class Root:
            def locator(self, _): return Options()
        browser.page = object()
        browser._dropdown_root_for_control = lambda _: Root()
        browser._open_select = lambda _: True
        browser._read_select_text = lambda _: selected[-1] if selected else ''
        with patch.object(runner.time, 'sleep', side_effect=lambda _: self.fail('filter click sleep')):
            self.assertTrue(browser._set_select_value(object(), 'Vetting Pending', required=True))
        self.assertEqual(selected, ['Vetting Pending'])

    def test_recorded_run_carries_phase_aggregates_on_success_and_failure(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                connection = __import__('scripts.test_piles_auto_assignment_store', fromlist=['RecordingConnection']).RecordingConnection()
                ledger = runner.ExecutionLedger(connection)
                ledger.create_insurer_run = lambda *_: 'fixture-run'
                store = types.SimpleNamespace(get_master_account=lambda _: {})
                def flow(_store, args, *_):
                    self.assertTrue(hasattr(args, 'phase_timer'), 'recorded run does not own timings')
                    args.phase_timer.record('scan', 'filter', 1500, 'accept')
                    if failed: raise RuntimeError('expected fixture failure')
                    return {}
                with patch.object(runner, 'run_for_insurer', flow):
                    if failed:
                        with self.assertRaisesRegex(RuntimeError, 'expected fixture'):
                            runner.run_insurer_recorded(store, types.SimpleNamespace(), 'fixture', [], 'All', False, ledger, 'parent')
                    else:
                        runner.run_insurer_recorded(store, types.SimpleNamespace(), 'fixture', [], 'All', False, ledger, 'parent')
                payloads = [runner.json.loads(value) for _, params in connection.statements for value in params
                            if isinstance(value, str) and value.startswith('[')]
                self.assertEqual(len(payloads), 1)
                self.assertEqual(payloads[0][0]['operation'], 'filter')

    def test_modal_readiness_has_no_first_attempt_sleep(self):
        browser = runner.CuracelPilesRunner()
        events = []
        class Control:
            def count(self): return 1
            def is_visible(self): return True
            def click(self, **_): events.append('assignment')
            first = property(lambda self: self)
        class Root:
            def locator(self, _): return Control()
            def wait_for(self, **_): events.append('acknowledged')
        browser.page = Root()
        browser._visible_overlay_roots = lambda: [Root()]
        browser._wait_for_assign_user_control = lambda **_: events.append('ready') or Control()
        browser._open_select_control = lambda _: True
        browser._choose_option_from_open_dropdown = lambda _: 'fixture'
        browser._dismiss_popup = lambda: None
        with patch.object(runner.time, 'sleep', side_effect=lambda seconds: events.append(('sleep', seconds))):
            browser._apply_assignment_modal('Vetting', 'fixture', True)
        self.assertEqual(events, ['ready', ('sleep', 0.5), 'assignment', 'acknowledged'])

    def test_assignee_discovery_uses_ready_control_without_modal_open_sleep(self):
        browser = runner.CuracelPilesRunner()
        sample = make_pile(1)
        events = []
        browser.page = types.SimpleNamespace(keyboard=types.SimpleNamespace(press=lambda _: None))
        browser.reset_to_filtered_page = lambda *_: [sample]
        browser._select_rows = lambda *_: types.SimpleNamespace(count=1)
        browser._open_assign_modal = lambda: events.append('open')
        browser._wait_for_assign_user_control = lambda: events.append('ready') or object()
        browser._open_select_control = lambda _: True
        browser._visible_dropdown_option_texts = lambda: ['fixture']
        browser._dismiss_popup = lambda: None
        with patch.object(runner.time, 'sleep', side_effect=lambda seconds: events.append(('sleep', seconds))):
            assignees = browser.discover_portal_assignees('Jul', '2026', sample)
        self.assertEqual([assignee.name for assignee in assignees], ['fixture'])
        self.assertEqual(events, ['open', 'ready', ('sleep', 0.4)])

    def test_login_waits_for_app_after_submit_without_fixed_sleep(self):
        browser = runner.CuracelPilesRunner()
        clock = self.Clock()
        class Control:
            def fill(self, value): pass
            def click(self): pass
        class Page:
            url = 'https://fixture/auth'
            def wait_for_timeout(self, ms):
                clock.advance(ms)
                if clock.ns >= 700_000_000: self.url = 'https://fixture/hmo/piles'
        browser.page = Page()
        browser._dismiss_popup = lambda: None
        browser._goto_with_soft_readiness = lambda _: None
        browser._first_visible_locator = lambda selectors, **_: (
            None if selectors[0] == '.p-select.p-component' else Control())
        with patch.object(runner.time, 'time', side_effect=lambda: clock.ns / 1e9), \
             patch.object(runner.time, 'sleep', side_effect=lambda _: self.fail('fixed login sleep')):
            browser.login('fixture', 'fixture')
        self.assertGreaterEqual(clock.ns, 700_000_000)
        self.assertLess(clock.ns, 2_000_000_000)


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


class LateArrivalWorkflowTests(unittest.TestCase):
    def test_planning_and_reconciliation_are_aggregate_only_operations(self):
        row = runner.replace(make_pile(1), assigned='Daniel')
        state = self.workflow({('Jul', '2026', 'Vetting Pending'): [row, make_pile(2)]}, {}, attempts=[{
            'id': 'prior', 'tracking_key': row.tracking_key, 'last_pile_key': row.key,
            'status': 'submitted', 'intended_portal_assignee': 'Daniel', 'attempt_number': 1,
        }], manual=True)
        self.assertFalse(hasattr(state, 'error'), getattr(state, 'error', None))
        operations = {item['operation']: item for item in state.portal.phase_timer.serialize()}
        self.assertIn('planning', operations)
        self.assertIn('reconciliation', operations)
        self.assertEqual(operations['planning']['count'], 1)
        self.assertNotIn('Provider 1', runner.json.dumps(operations))

    def workflow(self, initial, late, *, attempts=(), v2=True, years=("2026",),
                 supports_multiple=False, guard=None, persist_error=False, statuses=None, manual=False,
                 after_initial=None):
        state = types.SimpleNamespace(scans=[], applied=[], events=[], persisted={}, transitions=[], mapping=[])
        pending = [dict(item) for item in attempts]

        class Ledger(runner.ReadOnlyExecutionLedger):
            def finish_scan_context(self, context_id, result, evidence=None):
                if persist_error:
                    raise RuntimeError("fixture persistence failure")
                state.persisted[context_id] = result

            def pending_attempts(self, _):
                return [dict(item) for item in pending if item["status"] in ("submitted", "reconciliation_pending")]

            def transition_attempt(self, attempt_id, target, *, expected, evidence=None):
                item = next(item for item in pending if item["id"] == attempt_id)
                assert item["status"] in expected
                item["status"] = target.value
                state.transitions.append((attempt_id, target.value))

        class Portal(runner.CuracelPilesRunner):
            def __init__(self, **_):
                self.retry_attempt_numbers = {}
                state.portal = self
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def login(self, *_):
                pass
            def select_account(self, *_):
                pass
            def open_piles(self):
                pass
            def year_filter_capabilities(self):
                return supports_multiple, list(years)
            def scan_all_rows(self, *args):
                rows = super().scan_all_rows(*args)
                if after_initial:
                    after_initial(state)
                return rows
            def scan_status(self, month, year, status, *, only_unassigned=False):
                context = (month, year, status)
                final = context in state.scans
                state.scans.append(context)
                rows = [runner.replace(row) for row in (late if final else initial).get(context, [])]
                accumulator = runner.ScanAccumulator()
                accumulator.observe_page(1, rows)
                self._last_scan_result = accumulator.finish(explicit_empty=not rows)
                if not final and statuses and context in statuses:
                    self._last_scan_result = runner.replace(self._last_scan_result, status=statuses[context])
                return [row for row in rows if not only_unassigned or not row.assigned]
            def discover_portal_assignees(self, *args):
                state.mapping.append(args)
                return [runner.PortalAssignee("Daniel", "primary", 1, 1)]
            def execute_assignment_plan(self, months, year, plans, **_):
                state.applied.append(list(plans))
                return {}, []

        store = types.SimpleNamespace(
            get_master_account=lambda name: runner.MasterAccount("master", name, "fixture", "fixture", True),
            get_bot_accounts=lambda _: [], get_weekend_roster_policy=lambda **_: None,
            get_bot_metrics=lambda _: {}, get_team_slack_map=lambda: {},
            get_all_tracked_tracking_keys=lambda _: set(), get_active_external_assignments=lambda _: [],
            sync_external_assignments_for_insurer=lambda *_: None,
            get_rule=lambda name: runner.AssignmentRule(name, "manual_override", 25, 60, 50, 60) if manual else None,
            log_runner_event=lambda **event: state.events.append(event),
        )
        with TemporaryDirectory(prefix="piles-late-test-") as directory, \
                patch.object(runner, "CuracelPilesRunner", Portal), \
                patch.object(runner, "is_test_portal", lambda _: True), \
                patch.object(sys, "stdout", io.StringIO()):
            args = types.SimpleNamespace(execute=True, all_active=False, slow_mo=0, effective_date="2026-09-10",
                                         out=str(Path(directory) / "plan.json"), worker_safe_diagnostics=v2,
                                         work_heartbeat=guard)
            try:
                state.result = runner._run_for_insurer_once(store, args, "Kenya", ["Jul"], "All", False, Ledger(), "run")
            except Exception as error:
                state.error = error
        return state

    def test_actual_flow_rescans_initially_empty_and_assigned_only_contexts_once(self):
        context = ("Jul", "2026", "Vetting Pending")
        for rows in ([], [runner.replace(make_pile(1), assigned="Daniel")]):
            with self.subTest(initially_assigned=bool(rows)):
                state = self.workflow({context: rows}, {context: [make_pile(2)]})
                self.assertFalse(hasattr(state, "error"), getattr(state, "error", None))
                self.assertEqual(len(state.scans), 10)
                self.assertEqual(state.scans.count(context), 2)
                self.assertEqual([[plan.pile_key for plan in batch] for batch in state.applied], [["pile-2"]])
                self.assertEqual(state.result["late_arrival_detection"]["count"], 1)
                self.assertEqual(state.result["scan_context_summary"], {
                    "total": 5, "complete": 5, "empty": 5 - int(bool(rows)),
                    "failed": 0, "pending": 0,
                })

    def test_actual_flow_preserves_concrete_and_all_year_contexts(self):
        for multiple, expected in ((False, {"2026", "2025"}), (True, {"All"})):
            with self.subTest(multiple=multiple):
                state = self.workflow({}, {}, years=("2026", "2025"), supports_multiple=multiple)
                self.assertFalse(hasattr(state, "error"), getattr(state, "error", None))
                contexts = state.result["late_arrival_detection"]["contexts"]
                self.assertEqual({item["year"] for item in contexts}, expected)
                self.assertEqual(len(contexts), len(expected) * 5)

    def test_initial_assigned_identity_is_excluded_after_key_status_and_synced_count_change(self):
        context = ("Jul", "2026", "Vetting Pending")
        original = runner.replace(make_pile(1), assigned="Daniel", tracking_key="Provider|100|0|1000|Jul|2026-07-01")
        reappeared = runner.replace(original, assigned="", key="changed-key", tracking_key="Provider|100|9|1000|Jul|2026-07-01")
        late = runner.replace(make_pile(2), tracking_key="New|100|0|1000|Jul|2026-07-01")
        duplicate = runner.replace(late, key="duplicate", tracking_key="New|100|4|1000|Jul|2026-07-01")
        state = self.workflow({context: [original]}, {context: [reappeared, late, duplicate]})
        self.assertFalse(hasattr(state, "error"), getattr(state, "error", None))
        self.assertEqual([[plan.pile_key for plan in batch] for batch in state.applied], [["pile-2"]])

    def test_all_initial_scan_observations_are_excluded_even_if_pile_keys_repeat(self):
        first = ("Jul", "2026", "Vetting Pending")
        second = ("Jul", "2026", "Vetting Ongoing")
        row = runner.replace(make_pile(1), assigned="Daniel")
        alias = runner.replace(row, tracking_key="another-stable-identity")
        late = runner.replace(alias, key="changed-key", assigned="")
        state = self.workflow({first: [row], second: [alias]}, {second: [late]})
        self.assertEqual(state.applied, [])
        self.assertEqual(state.result["plans"], [])

    def test_reappearing_submitted_or_pending_attempt_reconciles_with_zero_execute_calls(self):
        context = ("Jul", "2026", "Vetting Pending")
        for status in ("submitted", "reconciliation_pending"):
            for assignee, expected in (("", "still_unassigned"), ("Daniel", "confirmed_reconciled")):
                with self.subTest(status=status, assignee=assignee):
                    row = runner.replace(make_pile(1), assigned=assignee, tracking_key="Provider|100|8|1000|Jul|2026-07-01")
                    attempt = dict(id="attempt", tracking_key="Provider|100|0|1000|Jul|2026-07-01",
                                   status=status, intended_portal_assignee="Daniel", attempt_number=1)
                    state = self.workflow({}, {context: [row]}, attempts=[attempt])
                    self.assertFalse(hasattr(state, "error"), getattr(state, "error", None))
                    self.assertEqual(state.applied, [])  # execute_assignment_plan call count is zero.
                    self.assertIn(("attempt", expected), state.transitions)
                    self.assertEqual(state.result["plans"], [])
                    self.assertEqual(state.mapping, [])
                    self.assertEqual(state.result["workflow_status"],
                                     "completed" if expected == "confirmed_reconciled" else "completed_with_issues")

    def test_persistence_failure_cannot_make_context_eligible(self):
        state = self.workflow({}, {}, persist_error=True)
        self.assertIsInstance(getattr(state, "error", None), RuntimeError)
        self.assertEqual(state.persisted, {})
        self.assertTrue(hasattr(state.portal, "initial_scan_results"))
        self.assertEqual(runner.late_arrival_contexts(state.portal.initial_scan_results.values()), ())
        self.assertEqual(state.applied, [])

    def test_submitted_attempt_matches_last_pile_identity_even_when_tracking_key_changes(self):
        attempt = dict(id="attempt", tracking_key="previous-tracking", last_pile_key="pile-1",
                       status="submitted", intended_portal_assignee="Daniel", attempt_number=1)
        state = self.workflow({}, {("Jul", "2026", "Vetting Pending"): [make_pile(1)]}, attempts=[attempt])
        self.assertFalse(hasattr(state, "error"), getattr(state, "error", None))
        self.assertEqual(state.applied, [])
        self.assertIn(("attempt", "still_unassigned"), state.transitions)

    def test_flag_off_retains_empty_context_legacy_behavior(self):
        state = self.workflow({}, {}, v2=False)
        self.assertEqual(len(state.scans), 5)
        self.assertEqual(state.result["late_arrival_detection"]["contexts"], [])

    def test_failed_and_pending_contexts_are_excluded_and_safely_reported(self):
        failed = ("Jul", "2026", "Vetting Pending")
        pending = ("Jul", "2026", "Vetting Ongoing")
        state = self.workflow({}, {}, statuses={failed: runner.ContextStatus.FAILED, pending: runner.ContextStatus.PENDING})
        self.assertEqual(state.scans.count(failed), 1)
        self.assertEqual(state.scans.count(pending), 1)
        self.assertEqual(len(state.scans), 8)
        self.assertEqual(state.result["workflow_status"], "completed_with_issues")
        self.assertEqual(state.result["late_arrival_detection"]["excluded_contexts"], [
            {"month": "Jul", "year": "2026", "status": "Vetting Pending", "code": "initial_context_failed"},
            {"month": "Jul", "year": "2026", "status": "Vetting Ongoing", "code": "initial_context_pending"},
        ])
        self.assertEqual([event["status"] for event in state.events if event["event_type"] == "late_arrival_contexts_excluded"],
                         ["completed_with_issues"])

    def test_final_scan_with_assigned_alias_never_plans_the_unassigned_alias(self):
        first = ("Jul", "2026", "AI Audit")
        second = ("Jul", "2026", "Vetting Pending")
        row = make_pile(1)
        for key in (row.key, "assigned-alias"):
            with self.subTest(key=key):
                state = self.workflow({}, {first: [row], second: [runner.replace(row, key=key, assigned="Daniel")]})
                self.assertEqual(state.applied, [])
                self.assertEqual(state.result["plans"], [])

    def test_late_only_manual_override_never_discovers_assignees_or_applies(self):
        state = self.workflow({}, {("Jul", "2026", "Vetting Pending"): [make_pile(1)]}, manual=True)
        self.assertFalse(hasattr(state, "error"), getattr(state, "error", None))
        self.assertEqual(state.applied, [])
        self.assertEqual(state.mapping, [])
        self.assertEqual(state.result["workflow_status"], "manual_action_required")
        self.assertEqual(state.result["manual_action_required_count"], 1)

    def test_ownership_loss_stops_each_final_phase_before_further_work(self):
        for phase in ("scan", "reconcile", "plan", "apply"):
            with self.subTest(phase=phase):
                active = []
                def check(current):
                    if active and current == phase:
                        raise runner.WorkOwnershipLost()
                state = self.workflow({}, {("Jul", "2026", "Vetting Pending"): [make_pile(1)]},
                                      guard=check, after_initial=lambda state: active.append(state))
                self.assertIsInstance(getattr(state, "error", None), runner.WorkOwnershipLost)
                self.assertEqual(state.applied, [])
                if phase == "scan":
                    self.assertEqual(len(state.scans), 5)
                if phase in ("scan", "reconcile", "plan"):
                    self.assertEqual(state.mapping, [])


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
        timing = EvidenceTimingTests()
        portal_runner, clock = timing.fixture(snapshot=lambda: {
            'headers': [], 'rows': [['existing row']], 'loading': False, 'table_visible': True})
        portal_runner._filter_state.update(month='All', year='2026', status='Vetting Pending')
        evidence = timing.run_filters(portal_runner, clock, ['Vetting Pending'])[0]

        self.assertEqual(evidence.network_state, "not_observed")
        self.assertEqual(evidence.table_state, "stable")
        self.assertEqual(clock.ns, 300_000_000)

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

    def test_preview_parent_claim_is_exact_and_token_fenced(self):
        store = runner.DataStore.__new__(runner.DataStore)
        store.mode = "postgres"
        calls = []
        responses = iter([[{"id": "preview-parent"}], [{"id": "preview-parent"}], []])
        def fetch(sql, params=()):
            calls.append((" ".join(sql.split()), params))
            return next(responses)
        store._fetchall_postgres = fetch
        token = store.claim_preview_runner_run(
            run_id="preview-parent", insurer_name="DEFMIS", run_scope="single",
            portal_environment="test", backend="local", run_source="manual",
            months=["All"], year="2026", mode="dry-run",
        )
        self.assertRegex(token, r"^[0-9a-f-]{36}$")
        self.assertIn("status = 'queued'", calls[0][0])
        self.assertIn("mode = 'dry-run'", calls[0][0])
        self.assertIn("run_source = 'manual'", calls[0][0])
        self.assertTrue(store.finalize_preview_runner_run(
            "preview-parent", token, status="completed", outcomes=[], error_code=""))
        self.assertFalse(store.finalize_preview_runner_run(
            "preview-parent", "stale-token", status="failed", outcomes=[], error_code="unexpected_error"))
        self.assertIn("details ->> 'preview_claim_token'", calls[1][0])

    def test_preview_parent_scope_mismatch_never_claims_foreign_record(self):
        store = runner.DataStore.__new__(runner.DataStore)
        store.mode = "postgres"
        responses = iter([[], [{
            "id": "preview-parent", "status": "queued", "mode": "dry-run",
            "run_source": "manual", "run_scope": "single", "insurer_name": "DEFMIS",
            "portal_environment": "production", "backend": "local", "months": ["All"],
            "year": "2026",
        }]])
        store._fetchall_postgres = lambda *_args, **_kwargs: next(responses)
        with self.assertRaises(runner.ParentScopeMismatch):
            store.claim_preview_runner_run(
                run_id="preview-parent", insurer_name="DEFMIS", run_scope="single",
                portal_environment="test", backend="local", run_source="manual",
                months=["All"], year="2026", mode="dry-run",
            )

    def test_preview_parent_advisory_lock_uses_a_domain_separated_exact_id(self):
        store = runner.DataStore.__new__(runner.DataStore)
        store.mode = "postgres"
        calls = []
        responses = iter([[{"acquired": True}], [{"released": True}]])
        store._fetchall_postgres = lambda sql, params=(): calls.append((" ".join(sql.split()), params)) or next(responses)
        self.assertTrue(store.try_acquire_preview_parent_lock("preview-parent"))
        store.release_preview_parent_lock("preview-parent")
        self.assertEqual([params for _sql, params in calls], [
            ("piles-preview-parent:preview-parent",),
            ("piles-preview-parent:preview-parent",),
        ])
        self.assertIn("pg_try_advisory_lock", calls[0][0])
        self.assertIn("pg_advisory_unlock", calls[1][0])
        self.assertFalse(store.try_acquire_preview_parent_lock("invalid/id"))


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


class ManualWorkflowOutcomeTests(unittest.TestCase):
    def manual_workflow(self, *, recorded=False, v2=True):
        events, assignment_calls, finals = [], [], []
        class Portal(runner.CuracelPilesRunner):
            def __init__(self, **_):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def login(self, *_):
                pass
            def select_account(self, *_):
                pass
            def open_piles(self):
                pass
            def scan_all_rows(self, *_):
                return [make_pile(1)]
            def scan_selected_statuses(self, *_, **__):
                return []
            def execute_assignment_plan(self, *_, **__):
                assignment_calls.append("assignment")
                raise AssertionError("Manual override must not execute assignments")
        class Ledger(runner.ReadOnlyExecutionLedger):
            def create_batch_with_attempts(self, *_):
                raise AssertionError("Manual override has no assignment attempts")
            def finalize_insurer_run(self, run_id, **fields):
                finals.append(fields)
        store = types.SimpleNamespace(
            get_master_account=lambda name: runner.MasterAccount("master", name, "fixture", "fixture", True),
            get_bot_accounts=lambda _: [], get_weekend_roster_policy=lambda **_: None,
            get_bot_metrics=lambda _: {}, get_team_slack_map=lambda: {},
            get_all_tracked_tracking_keys=lambda _: set(), get_active_external_assignments=lambda _: [],
            sync_external_assignments_for_insurer=lambda *_: None,
            get_rule=lambda name: runner.AssignmentRule(name, "manual_override", 25, 60, 50, 60),
            log_runner_event=lambda **event: events.append(event),
        )
        guard = types.SimpleNamespace(started=lambda _: "run", check=lambda: None)
        with TemporaryDirectory(prefix="piles-manual-test-") as directory, \
                patch.object(runner, "CuracelPilesRunner", Portal), patch.object(sys, "stdout", io.StringIO()):
            args = types.SimpleNamespace(execute=True, all_active=False, slow_mo=0, effective_date="2026-09-10",
                                         out=str(Path(directory) / "plan.json"), worker_safe_diagnostics=v2)
            if recorded:
                result = runner.run_insurer_recorded(store, args, "Kenya", ["Jul"], "2026", False,
                                                    Ledger(), "parent", ownership=guard if v2 else None)
            else:
                result = runner._run_for_insurer_once(store, args, "Kenya", ["Jul"], "2026", False, Ledger(), "run")
        self.assertEqual(assignment_calls, [])
        self.assertEqual([(event["event_type"], event["status"]) for event in events],
                         [("runner_scan", "manual_action_required"), ("runner_complete", "manual_action_required")])
        return result, finals, guard

    def test_actual_manual_override_returns_manual_action_without_attempt_rows(self):
        result, _, _ = self.manual_workflow()
        self.assertEqual(result.get("workflow_status"), "manual_action_required")
        self.assertEqual(result.get("manual_action_required_count"), 1)

    def test_recorded_manual_override_cannot_finalize_as_clean_completion(self):
        _, finals, guard = self.manual_workflow(recorded=True)
        self.assertEqual(finals[-1]["status"], "manual_action_required")
        self.assertEqual(finals[-1].get("error_code"), "manual_action_required")
        self.assertEqual(guard.status, runner.InsurerRunStatus.MANUAL_ACTION_REQUIRED)

    def test_empty_attempt_summary_without_explicit_workflow_success_is_not_clean(self):
        finals = []
        class Ledger(runner.ReadOnlyExecutionLedger):
            def finalize_insurer_run(self, run_id, **fields):
                finals.append(fields)
        guard = types.SimpleNamespace(started=lambda _: "run", check=lambda: None)
        store = types.SimpleNamespace(get_master_account=lambda name: {"insurer_name": name})
        with patch.object(runner, "run_for_insurer", lambda *_: {}):
            runner.run_insurer_recorded(store, types.SimpleNamespace(), "Kenya", ["All"], "2026", False,
                                       Ledger(), "parent", ownership=guard)
        self.assertEqual(finals[-1]["status"], "completed_with_issues")
        self.assertEqual(finals[-1].get("error_code"), "workflow_outcome_unconfirmed")

    def test_legacy_manual_workflow_keeps_original_return_and_finalization_behavior(self):
        result, finals, _ = self.manual_workflow(recorded=True, v2=False)
        self.assertNotIn("workflow_status", result)
        self.assertNotIn("manual_action_required_count", result)
        self.assertEqual([item['status'] for item in finals], ['completed'])
        self.assertEqual(finals[0]['performance'][0]['operation'], 'planning')


class DispatcherRunnerFencingTests(unittest.TestCase):
    def modal(self, guard, *, click_error=False):
        events = []
        class Button:
            @property
            def first(self):
                return self
            def count(self):
                return 1
            def is_visible(self):
                return True
            def click(self, **_):
                events.append("assignment")
                if click_error:
                    raise TimeoutError("browser acknowledgement lost")
        class Root:
            def locator(self, _selector):
                return Button()
            def wait_for(self, **_):
                pass
        browser = runner.CuracelPilesRunner()
        browser.page = Root()
        browser.work_heartbeat = guard
        browser._visible_overlay_roots = lambda: [Root()]
        browser._wait_for_assign_user_control = lambda **_: object()
        browser._open_select_control = lambda _: True
        browser._choose_option_from_open_dropdown = lambda _: "Assignee"
        browser._dismiss_popup = lambda: None
        return browser, events

    def test_final_assignment_boundary_fences_loss_after_dropdown_selection(self):
        WorkOwnershipLost = runner.WorkOwnershipLost
        checked = []
        def lost(phase):
            checked.append(phase)
            raise WorkOwnershipLost()
        browser, events = self.modal(lost)
        with patch.object(runner.time, "sleep", lambda _: None):
            with self.assertRaises(WorkOwnershipLost):
                browser._apply_assignment_modal("Vetting", "Assignee", True)
        self.assertEqual(events, [])
        self.assertEqual(checked, ["apply"])

    def test_ambiguous_assignment_click_is_never_tried_on_a_second_selector(self):
        browser, events = self.modal(lambda phase: None, click_error=True)
        with patch.object(runner.time, "sleep", lambda _: None):
            with self.assertRaises(Exception):
                browser._apply_assignment_modal("Vetting", "Assignee", True)
        self.assertEqual(events, ["assignment"])

    def test_worker_heartbeat_loss_is_not_swallowed_by_ledger_throttling(self):
        WorkOwnershipLost = runner.WorkOwnershipLost
        browser = runner.CuracelPilesRunner()
        def lost(phase):
            raise WorkOwnershipLost()
        browser.work_heartbeat = lost
        with self.assertRaises(WorkOwnershipLost):
            browser._heartbeat("scan")

    def test_submission_evidence_is_written_before_the_only_ambiguous_click(self):
        browser, events = self.modal(lambda phase: None, click_error=True)
        browser._open_assign_modal = lambda: None
        browser._transition_assignment_attempts = lambda group, status, *rest: events.append(status.value)
        with patch.object(runner.time, "sleep", lambda _: None):
            with self.assertRaises(Exception):
                browser._apply_selected_group("All", "2026", "Vetting Pending", "Assignee", "Vetting",
                                              [types.SimpleNamespace(pile_key="fixture")], True)
        self.assertEqual(events, ["submitted", "assignment"])

    def test_fence_loss_after_submission_recording_still_prevents_click(self):
        WorkOwnershipLost = runner.WorkOwnershipLost
        calls = []
        def heartbeat(phase):
            calls.append(phase)
            if len(calls) == 2:
                raise WorkOwnershipLost()
        browser, events = self.modal(heartbeat)
        browser._before_assignment_submit = lambda: events.append("submitted")
        with patch.object(runner.time, "sleep", lambda _: None):
            with self.assertRaises(WorkOwnershipLost):
                browser._apply_assignment_modal("Vetting", "Assignee", True)
        self.assertEqual(events, ["submitted"])

    def test_ambiguous_browser_closed_submission_cannot_restart_insurer_flow(self):
        AssignmentSubmissionUncertain = runner.AssignmentSubmissionUncertain
        calls = []
        def portal(*args):
            calls.append("assignment")
            try:
                raise RuntimeError("Target page, context or browser has been closed")
            except RuntimeError as error:
                raise AssignmentSubmissionUncertain() from error
        with patch.object(runner, "_run_for_insurer_once", portal), patch.object(runner.time, "sleep", lambda _: None):
            with self.assertRaises(AssignmentSubmissionUncertain):
                runner.run_for_insurer(None, types.SimpleNamespace(), "Kenya", ["All"], "2026", False)
        self.assertEqual(calls, ["assignment"])

    def test_lost_owner_cannot_finalize_its_insurer_record(self):
        WorkOwnershipLost = runner.WorkOwnershipLost
        finals = []
        class Guard:
            def started(self, master):
                return "run"
            def check(self, phase=""):
                raise WorkOwnershipLost()
        class Ledger(runner.ReadOnlyExecutionLedger):
            def finalize_insurer_run(self, *args, **kwargs):
                finals.append(kwargs)
        store = types.SimpleNamespace(get_master_account=lambda name: {"insurer_name": name})
        with patch.object(runner, "run_for_insurer", lambda *args: {}):
            with self.assertRaises(WorkOwnershipLost):
                runner.run_insurer_recorded(store, types.SimpleNamespace(), "Kenya", ["All"], "2026", False,
                                           Ledger(), "parent", ownership=Guard())
        self.assertEqual(finals, [])

    def test_ownership_is_rechecked_after_slow_summary_before_insurer_finalization(self):
        finals = []
        class Guard:
            lost = False
            def started(self, master):
                return "run"
            def check(self, phase=""):
                if self.lost:
                    raise runner.WorkOwnershipLost()
        guard = Guard()
        class Ledger(runner.ReadOnlyExecutionLedger):
            def summarize_insurer_run(self, run_id):
                guard.lost = True
                return {"confirmed": 1}
            def finalize_insurer_run(self, *args, **kwargs):
                finals.append(kwargs)
        store = types.SimpleNamespace(get_master_account=lambda name: {"insurer_name": name})
        with patch.object(runner, "run_for_insurer", lambda *args: {}):
            with self.assertRaises(runner.WorkOwnershipLost):
                runner.run_insurer_recorded(store, types.SimpleNamespace(), "Kenya", ["All"], "2026", False,
                                           Ledger(), "parent", ownership=guard)
        self.assertEqual(finals, [])

    def test_adapter_attaches_run_before_portal_and_uses_unique_claim_output(self):
        from scripts.test_piles_auto_assignment_dispatch import claimed, Resource
        from scripts.piles_auto_assignment.dispatch import WorkerContext
        records, outputs = [], []
        class Guard:
            status = runner.InsurerRunStatus.COMPLETED
            def started(self, master):
                records.append("attached")
                return "run-" + master["insurer_name"]
            def check(self, phase=""):
                records.append("renewed")
        class Ledger(runner.ReadOnlyExecutionLedger):
            def finalize_insurer_run(self, run_id, **fields):
                records.append(fields["status"])
            def summarize_insurer_run(self, run_id):
                return {"confirmed": 1, "reconciliation_pending": 1, "conflict": 0, "failed": 0}
        store = Resource()
        store.get_master_account = lambda name: {"insurer_name": name}
        args = types.SimpleNamespace(out="tmp/shared.json")
        guard = Guard()
        context = WorkerContext(store, Ledger(), io.StringIO(), "worker", ownership=guard)
        def portal(store, args, *rest):
            self.assertIn("attached", records)
            self.assertTrue(callable(args.work_heartbeat))
            outputs.append(args.out)
            return {}
        with patch.object(runner, "run_for_insurer", portal):
            runner.run_claimed_insurer_once(claimed("Kenya"), context, args, ["All"], "2026", False)
            runner.run_claimed_insurer_once(claimed("Uganda"), context, args, ["All"], "2026", False)
        self.assertNotEqual(outputs[0], outputs[1])
        self.assertEqual(args.out, "tmp/shared.json")
        self.assertEqual(guard.status, runner.InsurerRunStatus.COMPLETED_WITH_ISSUES)
        self.assertEqual(records.count("completed_with_issues"), 2)

    def test_durable_worker_context_uses_three_distinct_connections(self):
        from scripts.test_piles_auto_assignment_dispatch import claimed
        from scripts.piles_auto_assignment.dispatch import ContextOutputRouter
        connections = []
        class Connection:
            autocommit = True
            closed = False
            def close(self):
                self.closed = True
        def connect(_url):
            result = Connection()
            connections.append(result)
            return result
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://fixture"}):
            with patch.object(runner.psycopg2, "connect", connect, create=True):
                factory = runner.worker_context_factory(types.SimpleNamespace(read_only=False),
                    ContextOutputRouter(io.StringIO()), durable_claims=True)
                with factory(claimed()) as context:
                    self.assertEqual(len({id(context.store.conn), id(context.ledger.connection),
                                          id(context.dispatch_store.connection)}), 3)
                    output_path = Path(context.output_path)
                    output_path.write_text("private test fixture")
        self.assertEqual(len(connections), 3)
        self.assertTrue(all(connection.closed for connection in connections))
        self.assertFalse(output_path.parent.exists())

    def test_v2_parent_retry_preserves_terminal_status_and_prior_dispatch_references(self):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.executescript("""
            CREATE TABLE piles_auto_assignment_runner_runs(
                id TEXT PRIMARY KEY, insurer_name TEXT, run_scope TEXT, portal_environment TEXT,
                backend TEXT, run_source TEXT, months TEXT, year TEXT, mode TEXT,
                status TEXT, started_at TEXT, details TEXT, updated_at TEXT);
            INSERT INTO piles_auto_assignment_runner_runs(id,status,started_at,details)
                VALUES ('parent','completed','original','{"dispatch_requests":["opaque"]}');
        """)
        store = object.__new__(runner.DataStore)
        store.mode = "postgres"
        store._execute_postgres = lambda sql, params: db.execute(sql.replace("::jsonb", "").replace("%s", "?"), params)
        store.create_runner_run(run_id="parent", insurer_name="Kenya", run_scope="single", portal_environment="test",
            backend="local", run_source="manual", months=["All"], year="2026", mode="execute",
            details={}, preserve_existing=True)
        self.assertEqual(db.execute("SELECT status,started_at,details FROM piles_auto_assignment_runner_runs").fetchone(),
                         ("completed", "original", '{"dispatch_requests":["opaque"]}'))


class DispatcherNotificationPrivacyTests(unittest.TestCase):
    hostile = 'password="SECRET-FIXTURE" <html>patient-fixture</html> private@example.invalid https://private.invalid/token'

    def test_actual_parent_notification_helpers_never_print_hostile_service_errors(self):
        plan = types.SimpleNamespace(insurer_name="Kenya", remaining_claims=10, claim_month="Jul",
                                     filter_month="Jul", provider="Fixture", status_bucket="Vetting")
        item = runner.NotificationItem("assignment", plan, "Bot", "Owner", "", "Bot")
        external = runner.ExternalNotificationItem("Kenya", "Fixture", 10, 10, "Jul", "Vetting", "Bot", "Owner", "")
        args = types.SimpleNamespace(execute=True, read_only=False, run_source="schedule", insurer=None)
        for stage in ("external", "thread", "owner"):
            with self.subTest(stage=stage):
                calls, stdout, stderr = [], io.StringIO(), io.StringIO()
                def post(*args, **fields):
                    calls.append(fields["json"])
                    if stage == "owner" and len(calls) == 1:
                        return types.SimpleNamespace(raise_for_status=lambda: None,
                                                     json=lambda: {"ok": True, "ts": "fixture-thread"})
                    raise RuntimeError(self.hostile)
                result = runner.DispatchResult(runner.ParentRunStatus.COMPLETED, (),
                    (item,) if stage != "external" else (), (external,) if stage == "external" else ())
                original_result = repr(vars(result))
                with patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr), \
                        patch.object(runner, "SLACK_PRISM_BOT_TOKEN", "fixture"), \
                        patch.object(runner, "SLACK_ALERTS_CHANNEL_ID", "fixture"), \
                        patch.object(runner.requests, "post", post, create=True):
                    runner.notify_dispatch_result(args, result)
                self.assertEqual(len(calls), 2 if stage == "owner" else 1)
                observable = stdout.getvalue() + stderr.getvalue() + repr(vars(result))
                for forbidden in ("SECRET-FIXTURE", "patient-fixture", "private@example.invalid", "https://private.invalid", "<html>"):
                    self.assertNotIn(forbidden, observable)
                self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
                self.assertEqual(repr(vars(result)), original_result)

    def test_legacy_notification_helpers_keep_their_original_diagnostics(self):
        plan = types.SimpleNamespace(insurer_name="Kenya", remaining_claims=10, claim_month="Jul",
                                     filter_month="Jul", provider="Fixture", status_bucket="Vetting")
        item = runner.NotificationItem("assignment", plan, "Bot", "Owner", "", "Bot")
        external = runner.ExternalNotificationItem("Kenya", "Fixture", 10, 10, "Jul", "Vetting", "Bot", "Owner", "")
        helpers = (
            lambda: runner.send_external_assignment_alert([external], "test", "schedule"),
            lambda: runner.create_assignment_thread("Kenya", "test", 1, 10, 0, 0),
            lambda: runner.send_assignment_owner_reply([item], "fixture-thread"),
            lambda: runner.send_weekend_restore_update([{"insurer_name": "Kenya", "owner_name": "Owner"}]),
        )
        for helper in helpers:
            with self.subTest(helper=helper):
                output = io.StringIO()
                with patch.object(sys, "stdout", output), patch.object(runner, "SLACK_PRISM_BOT_TOKEN", "fixture"), \
                        patch.object(runner, "SLACK_ALERTS_CHANNEL_ID", "fixture"), \
                        patch.object(runner.requests, "post", side_effect=RuntimeError(self.hostile), create=True):
                    helper()
                self.assertIn(self.hostile, output.getvalue())


class DispatcherMainTests(unittest.TestCase):
    def invoke(self, state, run_one, *, execute=True, read_only=None, adopt_preview=False,
               run_source="schedule", flag="true", maximum=2, terminal_replay=False,
               preview_claim_error=None, preview_lock=True, discovery_error=None,
               preview_heartbeat_error_after=None, restored_rows=()):
        now = datetime(2026, 9, 10, tzinfo=timezone.utc)
        self.args = types.SimpleNamespace(read_only=not execute if read_only is None else read_only,
            adopt_preview_run=adopt_preview, execute=execute, portal_environment="test",
            month="All", year="2026", visible=False, all_active=True, insurer=None, run_id="parent",
            invocation_backend="local", run_source=run_source, effective_date="", slow_mo=0,
            out="tmp/unused.json")
        self.events = []
        preview_heartbeat_count = 0
        owner = self
        class ParentStore:
            def __init__(self, **options):
                owner.events.append(("store", options))
            def get_active_master_accounts(self):
                owner.events.append(("accounts",))
                if discovery_error:
                    raise discovery_error
                return [types.SimpleNamespace(insurer_name=row.insurer_name) for row in state.rows.values()]
            def create_runner_run(self, **fields):
                owner.events.append(("created", fields["run_source"]))
                return "parent"
            def claim_preview_runner_run(self, **fields):
                owner.events.append(("preview_claim", fields))
                if preview_claim_error:
                    raise preview_claim_error
                return "preview-token"
            def try_acquire_preview_parent_lock(self, run_id):
                owner.events.append(("preview_lock", run_id))
                return preview_lock
            def release_preview_parent_lock(self, run_id):
                owner.events.append(("preview_unlock", run_id))
            def heartbeat_preview_runner_run(self, run_id, token, phase):
                nonlocal preview_heartbeat_count
                preview_heartbeat_count += 1
                owner.events.append(("preview_heartbeat", run_id, token, phase))
                if (preview_heartbeat_error_after is not None
                        and preview_heartbeat_count > preview_heartbeat_error_after):
                    raise RuntimeError("private preview heartbeat failure")
                return True
            def finalize_preview_runner_run(self, run_id, token, **fields):
                owner.events.append(("preview_finalized", run_id, token, fields))
                return True
            def try_acquire_insurer_lock(self, name):
                return name == "__weekend_state__" and bool(restored_rows)
            def release_insurer_lock(self, name):
                pass
            def restore_due_weekend_bot_states(self, effective_date):
                return list(restored_rows)
            def try_acquire_runner_slot(self, maximum):
                return -1
            def mark_coalesced_request(self, *args):
                if flag == "true":
                    owner.fail("v2 called legacy coalescing")
                owner.events.append(("legacy_coalesced",))
                return "legacy-request"
            def claim_coalesced_request(self, *args):
                owner.fail("v2 entered legacy follow-up")
            def log_runner_event(self, **fields):
                pass
            def finalize_runner_run(self, *args, **fields):
                owner.events.append(("legacy_finalized", fields["status"]))
            def close(self):
                owner.events.append(("closed",))
        coordinator = state.store()
        def enqueue(parent_id, requests):
            if terminal_replay:
                raise runner.ParentAlreadyTerminal("Terminal fixture")
            owner.events.append(("enqueued", tuple(requests)))
            return list(state.rows.values())
        coordinator.enqueue_parent_work = enqueue
        coordinator.parent_requested_at = lambda parent_id: now
        coordinator.close = lambda: None
        coordinator.fail_parent_setup = lambda *args: owner.events.append(("setup_failed",))
        def notify(items, **fields):
            self.assertTrue(all(row.disposition.value in {"completed", "failed", "covered_by_active_cycle"} for row in state.rows.values()))
            self.assertEqual(threading.current_thread(), threading.main_thread())
            self.events.append(("notification", tuple(items)))
        def assignment_thread(**fields):
            notify(())
            self.events.append(("assignment_thread", tuple(fields["insurer_names"])))
            return "thread"
        def owner_reply(items, thread, **fields):
            self.assertEqual(thread, "thread")
            self.events.append(("owner_reply", tuple(item.owner_name for item in items)))
            return True
        with ExitStack() as patches:
            patches.enter_context(patch.dict(os.environ, {"PILES_AUTO_ASSIGNMENT_DISPATCHER_V2": flag,
                "PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY": str(maximum)}))
            self.stdout, self.stderr = io.StringIO(), io.StringIO()
            patches.enter_context(patch.object(sys, "stdout", self.stdout))
            patches.enter_context(patch.object(sys, "stderr", self.stderr))
            patches.enter_context(patch.object(runner, "parse_args", lambda: self.args))
            patches.enter_context(patch.object(runner, "DataStore", ParentStore))
            patches.enter_context(patch.object(runner, "build_dispatch_store", lambda store: coordinator, create=True))
            patches.enter_context(patch.object(runner, "build_execution_ledger", lambda *args, **kwargs: None))
            patches.enter_context(patch.object(runner, "worker_context_factory", lambda *args, **kwargs: state.context))
            patches.enter_context(patch.object(runner, "run_claimed_insurer_once", lambda work, context, *args: run_one(work, context)))
            patches.enter_context(patch.object(runner, "send_external_assignment_alert", notify))
            patches.enter_context(patch.object(runner, "create_assignment_thread", assignment_thread))
            patches.enter_context(patch.object(runner, "send_assignment_owner_reply", owner_reply))
            return runner.main()

    def test_v2_main_dispatches_mixed_outcomes_then_notifies_in_parent(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(), []
        barrier = threading.Barrier(2)
        def portal(work, context):
            calls.append(work.id)
            barrier.wait(timeout=3)
            if work.id == "0":
                raise TimeoutError("private fixture")
            return {"external_notification_items": ["Uganda"]}
        with self.assertRaises(RuntimeError):
            self.invoke(state, portal)
        self.assertCountEqual(calls, ["0", "1"])
        self.assertEqual([event[1] for event in state.events if event[0] == "parent"],
                         [runner.ParentRunStatus.COMPLETED_WITH_ISSUES])
        self.assertIn(("notification", ("Uganda",)), self.events)
        self.assertFalse(any(event[0] == "legacy_finalized" for event in self.events))

    def test_covered_only_main_has_no_portal_call_follow_up_or_notification(self):
        from dataclasses import replace
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState()
        state.rows = {key: replace(row, disposition="covered_by_active_cycle") for key, row in state.rows.items()}
        self.invoke(state, lambda *_: self.fail("covered work cannot run"))
        self.assertEqual([event[1] for event in state.events if event[0] == "parent"],
                         [runner.ParentRunStatus.COVERED_BY_ACTIVE_CYCLE])
        self.assertFalse(any(event[0] in {"notification", "legacy_finalized"} for event in self.events))

    def test_manual_results_flow_through_insurer_work_and_mixed_or_all_manual_parent(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        for manual_names in ({"Kenya"}, {"Kenya", "Uganda"}):
            with self.subTest(manual_names=manual_names):
                state, calls = DispatchState(), []
                class Ledger(runner.ReadOnlyExecutionLedger):
                    def create_insurer_run(self, parent, master):
                        return "run-" + master["insurer_name"]
                    def finalize_insurer_run(self, run_id, **fields):
                        state.insurer_statuses[run_id] = fields["status"]
                def workflow(store, args, name, *rest):
                    calls.append(name)
                    return {"workflow_status": "manual_action_required" if name in manual_names else "completed",
                            "manual_action_required_count": 1 if name in manual_names else 0}
                def recorded(work, context):
                    context.store.get_master_account = lambda name: {"insurer_name": name}
                    return runner.run_insurer_recorded(context.store, types.SimpleNamespace(), work.insurer_name,
                        ["All"], "2026", False, Ledger(), "parent", ownership=context.ownership)
                with patch.object(runner, "run_for_insurer", workflow):
                    result = self.invoke(state, recorded)
                self.assertCountEqual(calls, ["Kenya", "Uganda"])
                self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED_WITH_ISSUES)
                for outcome in result.outcomes:
                    manual = outcome.insurer_name in manual_names
                    expected = "manual_action_required" if manual else "completed"
                    self.assertEqual(outcome.status.value, expected)
                    self.assertEqual(outcome.error_code, "manual_action_required" if manual else "")
                    self.assertEqual(state.insurer_statuses["run-" + outcome.insurer_name], expected)
                for row in state.rows.values():
                    self.assertEqual(row.disposition.value, "completed")
                    self.assertEqual(row.reason_code, "manual_action_required" if row.insurer_name in manual_names else "")

    def test_probe_never_enqueues_or_creates_parent_and_reports_held_insurer(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        state.insurer_locks["kenya"] = "foreign"
        with self.assertRaisesRegex(RuntimeError, "probe_blocked_by_active_insurer"):
            self.invoke(state, lambda *_: self.fail("blocked probe cannot run"), execute=False,
                        read_only=True, run_source="readiness")
        self.assertFalse(any(event[0] in {"enqueued", "created", "legacy_finalized", "notification"} for event in self.events))
        self.assertEqual(state.events, [])

    def test_original_request_timestamp_is_passed_to_enqueue(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        self.invoke(state, lambda *_: {})
        requests = next(event[1] for event in self.events if event[0] == "enqueued")
        self.assertEqual(requests[0].requested_at, datetime(2026, 9, 10, tzinfo=timezone.utc))

    def test_disabled_flag_keeps_legacy_overlap_and_parent_status_behavior(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        self.invoke(DispatchState(), lambda *_: self.fail("legacy overlap cannot run"), flag="false")
        self.assertEqual(self.events.count(("legacy_coalesced",)), 2)
        self.assertIn(("legacy_finalized", "skipped_overlap"), self.events)
        self.assertFalse(any(event[0] == "enqueued" for event in self.events))

    def test_unblocked_probe_is_one_pass_without_queue_or_parent_writes(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(("Kenya",)), []
        result = self.invoke(state, lambda work, context: calls.append(work.insurer_name) or {}, execute=False,
                             read_only=True, run_source="readiness")
        self.assertEqual(calls, ["Kenya"])
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertFalse(any(event[0] in {"enqueued", "created", "legacy_finalized", "notification"} for event in self.events))
        self.assertEqual(state.events, [])

    def test_api_preview_adopts_and_terminalizes_exact_parent_without_executable_work(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(("Kenya",)), []
        result = self.invoke(
            state,
            lambda work, context: calls.append(work.insurer_name) or {
                "workflow_status": "completed",
                "unassigned": [types.SimpleNamespace(remaining_claims=17)],
                "plans": [types.SimpleNamespace(remaining_claims=17)],
                "reassignment_plans": [],
                "scan_context_summary": {
                    "total": 5, "complete": 5, "empty": 5, "failed": 0, "pending": 0,
                },
                "late_arrival_detection": {"count": 0, "claims": 0},
            },
            execute=False, read_only=False, adopt_preview=True, run_source="manual",
        )
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertEqual(calls, ["Kenya"])
        self.assertFalse(any(event[0] in {"enqueued", "created", "legacy_finalized", "notification"}
                             for event in self.events))
        self.assertEqual(state.events, [])
        claim = next(event for event in self.events if event[0] == "preview_claim")
        self.assertEqual((claim[1]["run_id"], claim[1]["run_source"], claim[1]["mode"]),
                         ("parent", "manual", "dry-run"))
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "completed")
        self.assertEqual(finalized[3]["error_code"], "")
        self.assertEqual(finalized[3]["outcomes"], [{
            "insurer_name": "Kenya", "status": "completed", "phase": "complete",
            "error_code": "", "discovered_piles": 1, "discovered_claims": 17,
            "planned_piles": 1, "planned_claims": 17,
            "contexts_total": 5, "contexts_complete": 5, "contexts_empty": 5,
            "contexts_failed": 0, "contexts_pending": 0,
        }])

    def test_actual_weekend_mapping_skip_cannot_complete_a_durable_preview(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        events = []
        policy = runner.WeekendRosterPolicy(
            roster_id="roster-fixture", weekend_start="2026-09-12", weekend_end="2026-09-13",
            effective_date="2026-09-12", on_shift_owner_names=["Fixture Owner"],
            off_duty_owner_names=[], eligible_bots=[],
            missing_reason="Weekend roster has no matching active bot.",
        )
        producer_store = types.SimpleNamespace(
            get_master_account=lambda name: runner.MasterAccount("master", name, "fixture", "fixture", True),
            get_bot_accounts=lambda _: [], get_weekend_roster_policy=lambda **_: policy,
            log_runner_event=lambda **event: events.append(event),
        )
        producer_args = types.SimpleNamespace(
            execute=False, effective_date="2026-09-12", worker_safe_diagnostics=True,
        )
        with patch.object(runner, "CuracelPilesRunner", side_effect=AssertionError("skip cannot open portal")):
            with self.assertRaisesRegex(RuntimeError, "workflow_outcome_unconfirmed"):
                self.invoke(
                    state,
                    lambda *_: runner._run_for_insurer_once(
                        producer_store, producer_args, "Kenya", ["All"], "All", False,
                    ),
                    execute=False, read_only=False, adopt_preview=True, run_source="manual",
                )
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "completed_with_issues")
        self.assertEqual(finalized[3]["error_code"], "workflow_outcome_unconfirmed")
        self.assertEqual(finalized[3]["outcomes"], [{
            "insurer_name": "Kenya", "status": "completed_with_issues", "phase": "complete",
            "error_code": "workflow_outcome_unconfirmed", "discovered_piles": 0,
            "discovered_claims": 0, "planned_piles": 0, "planned_claims": 0,
            "contexts_total": None, "contexts_complete": None, "contexts_empty": None,
            "contexts_failed": None, "contexts_pending": None,
        }])
        self.assertEqual([event["event_type"] for event in events], [
            "weekend_roster_missing_mapping", "weekend_roster_skipped_insurer",
        ])

    def test_preview_completion_classifier_fails_closed_without_positive_evidence(self):
        outcomes = []
        for result in ({}, {"workflow_status": "skipped"},
                       {"workflow_status": "completed", "portal_mapping_warnings": ["warning"]}):
            outcome = types.SimpleNamespace(
                insurer_name="Kenya", status=types.SimpleNamespace(value="completed"),
                error_code="", value=types.SimpleNamespace(result=result),
            )
            outcomes.append(runner.preview_diagnostic_outcome(outcome))
        self.assertEqual(
            [(item["status"], item["error_code"]) for item in outcomes],
            [
                ("completed_with_issues", "workflow_outcome_unconfirmed"),
                ("completed_with_issues", "workflow_outcome_unconfirmed"),
                ("completed_with_issues", "assignment_follow_up_required"),
            ],
        )

    def test_api_preview_failure_terminalizes_parent_with_safe_diagnostics(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        hostile = RuntimeError('password="SECRET" <html>patient</html>')
        with self.assertRaisesRegex(RuntimeError, "unexpected_error"):
            self.invoke(state, lambda *_: (_ for _ in ()).throw(hostile), execute=False,
                        read_only=False, adopt_preview=True, run_source="manual")
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "failed")
        self.assertEqual(finalized[3]["error_code"], "unexpected_error")
        self.assertEqual(finalized[3]["outcomes"][0]["error_code"], "unexpected_error")
        self.assertNotIn("SECRET", repr(finalized))
        self.assertNotIn("patient", repr(finalized))
        self.assertEqual(state.events, [])

    def test_api_preview_cannot_adopt_a_parent_with_different_persisted_scope(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        mismatch = runner.ParentScopeMismatch("persisted scope differs")
        with self.assertRaisesRegex(RuntimeError, "parent_scope_mismatch"):
            self.invoke(state, lambda *_: self.fail("mismatched preview cannot reach portal"),
                        execute=False, read_only=False, adopt_preview=True, run_source="manual",
                        preview_claim_error=mismatch)
        self.assertFalse(any(event[0] == "preview_finalized" for event in self.events))
        self.assertEqual(state.events, [])

    def test_sigterm_terminalizes_claimed_preview_without_starting_the_next_insurer(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(("Kenya", "Uganda")), []
        def portal(work, _context):
            calls.append(work.insurer_name)
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            raise RuntimeError("interrupted insurer did not complete")
        with self.assertRaisesRegex(RuntimeError, "dispatch_stopped"):
            self.invoke(state, portal, execute=False, read_only=False,
                        adopt_preview=True, run_source="manual")
        self.assertEqual(calls, ["Kenya"])
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "failed")
        self.assertEqual(finalized[3]["error_code"], "dispatch_stopped")
        self.assertEqual([item["status"] for item in finalized[3]["outcomes"]], ["failed"])
        self.assertEqual(state.events, [])

    def test_sigterm_after_completed_preview_insurer_is_partial(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(("Kenya", "Uganda")), []
        def portal(work, _context):
            calls.append(work.insurer_name)
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return {"workflow_status": "completed", "unassigned": [], "plans": [], "reassignment_plans": []}
        with self.assertRaisesRegex(RuntimeError, "dispatch_stopped"):
            self.invoke(state, portal, execute=False, read_only=False,
                        adopt_preview=True, run_source="manual")
        self.assertEqual(calls, ["Kenya"])
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "completed_with_issues")
        self.assertEqual([item["status"] for item in finalized[3]["outcomes"]], ["completed"])

    def test_exception_after_completed_preview_insurer_is_partial(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(("Kenya", "Uganda")), []
        with self.assertRaisesRegex(RuntimeError, "unexpected_error"):
            self.invoke(state, lambda work, _context: calls.append(work.insurer_name) or {"workflow_status": "completed"},
                        execute=False, read_only=False, adopt_preview=True, run_source="manual",
                        preview_heartbeat_error_after=1)
        self.assertEqual(calls, ["Kenya"])
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "completed_with_issues")
        self.assertEqual(finalized[3]["error_code"], "unexpected_error")
        self.assertEqual([item["status"] for item in finalized[3]["outcomes"]], ["completed"])

    def test_preview_claim_precedes_all_active_discovery_and_discovery_failure_is_terminal(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        with self.assertRaisesRegex(RuntimeError, "unexpected_error"):
            self.invoke(state, lambda *_: self.fail("discovery failure cannot reach portal"),
                        execute=False, read_only=False, adopt_preview=True, run_source="manual",
                        discovery_error=RuntimeError("private database diagnostic"))
        kinds = [event[0] for event in self.events]
        self.assertLess(kinds.index("preview_lock"), kinds.index("preview_claim"))
        self.assertLess(kinds.index("preview_claim"), kinds.index("accounts"))
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual((finalized[3]["status"], finalized[3]["error_code"]), ("failed", "unexpected_error"))
        self.assertLess(kinds.index("preview_unlock"), kinds.index("closed"))
        self.assertNotIn("private database diagnostic", repr(self.events))

    def test_live_preview_parent_lock_prevents_adoption_without_mutating_parent(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        with self.assertRaisesRegex(RuntimeError, "preview_parent_unavailable"):
            self.invoke(state, lambda *_: self.fail("held parent lock cannot reach portal"),
                        execute=False, read_only=False, adopt_preview=True, run_source="manual",
                        preview_lock=False)
        self.assertEqual([event[0] for event in self.events], ["store", "preview_lock", "closed"])

    def test_preview_issue_and_failure_aggregate_like_execute_parent(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya", "Uganda"))
        def portal(work, _context):
            if work.insurer_name == "Uganda":
                raise TimeoutError("private timeout")
            return {"workflow_status": "manual_action_required", "manual_action_required_count": 2,
                    "unassigned": [], "plans": [], "reassignment_plans": []}
        with self.assertRaisesRegex(RuntimeError, "portal_timeout"):
            self.invoke(state, portal, execute=False, read_only=False,
                        adopt_preview=True, run_source="manual")
        finalized = next(event for event in self.events if event[0] == "preview_finalized")
        self.assertEqual(finalized[3]["status"], "completed_with_issues")
        self.assertEqual([item["status"] for item in finalized[3]["outcomes"]],
                         ["manual_action_required", "failed"])

    def test_shutdown_signal_finishes_active_work_and_leaves_next_work_queued(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(), []
        original = signal.getsignal(signal.SIGTERM)
        def portal(work, context):
            calls.append(work.id)
            handler = signal.getsignal(signal.SIGTERM)
            self.assertTrue(callable(handler), "V2 did not install a safe shutdown handler")
            handler(signal.SIGTERM, None)
            return {}
        with self.assertRaises(RuntimeError):
            self.invoke(state, portal, maximum=1)
        self.assertEqual(calls, ["0"])
        self.assertEqual([row.disposition.value for row in state.rows.values()], ["completed", "queued"])
        self.assertIs(signal.getsignal(signal.SIGTERM), original)

    def test_v2_top_level_setup_error_never_exposes_driver_or_portal_text(self):
        with patch.dict(os.environ, {"PILES_AUTO_ASSIGNMENT_DISPATCHER_V2": "true"}):
            with patch.object(runner, "main_v2", side_effect=RuntimeError('password="SECRET" <html>patient</html>')):
                with self.assertRaises(RuntimeError) as failure:
                    runner.main()
        self.assertNotIn("SECRET", str(failure.exception))
        self.assertNotIn("patient", str(failure.exception))

    def test_actual_v2_weekend_notification_does_not_leak_into_logs_or_durable_outcomes(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state, calls = DispatchState(("Kenya",)), []
        def post(*args, **fields):
            calls.append("notification")
            raise RuntimeError(DispatcherNotificationPrivacyTests.hostile)
        with patch.object(runner, "SLACK_PRISM_BOT_TOKEN", "fixture"), \
                patch.object(runner, "SLACK_ALERTS_CHANNEL_ID", "fixture"), \
                patch.object(runner.requests, "post", post, create=True):
            result = self.invoke(state, lambda *_: {}, restored_rows=({"insurer_name": "Kenya", "owner_name": "Owner"},))
        self.assertEqual(calls, ["notification"])
        observable = self.stdout.getvalue() + self.stderr.getvalue() + repr(state.rows) + repr(state.events) + repr(result)
        for forbidden in ("SECRET-FIXTURE", "patient-fixture", "private@example.invalid", "https://private.invalid", "<html>"):
            self.assertNotIn(forbidden, observable)
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)

    def test_terminal_parent_replay_does_not_redispatch_or_renotify(self):
        from dataclasses import replace
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState(("Kenya",))
        state.rows["0"] = replace(state.rows["0"], disposition="completed")
        result = self.invoke(state, lambda *_: self.fail("terminal parent cannot rerun"), terminal_replay=True)
        self.assertEqual(result.status, runner.ParentRunStatus.COMPLETED)
        self.assertEqual(result.outcomes, ())
        self.assertFalse(any(event[0] in {"enqueued", "notification", "legacy_finalized"} for event in self.events))

    def test_assignment_notifications_are_ordered_after_all_workers_finish(self):
        from scripts.test_piles_auto_assignment_dispatch import DispatchState
        state = DispatchState()
        barrier = threading.Barrier(2)
        second_done = threading.Event()
        def portal(work, context):
            barrier.wait(timeout=3)
            if work.id == "0":
                self.assertTrue(second_done.wait(3))
            else:
                second_done.set()
            item = types.SimpleNamespace(kind="assignment", plan=types.SimpleNamespace(remaining_claims=10,
                insurer_name=work.insurer_name), owner_name=work.insurer_name, owner_slack_user_id="",
                actual_assignee_name=work.insurer_name)
            return {"notification_items": [item]}
        self.invoke(state, portal)
        self.assertIn(("assignment_thread", ("Kenya", "Uganda")), self.events)
        self.assertEqual([event[1] for event in self.events if event[0] == "owner_reply"], [("Kenya",), ("Uganda",)])


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
