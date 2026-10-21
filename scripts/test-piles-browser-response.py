"""Local Chromium regression; no credentials, database or real portal are used.

Run with the pinned runner requirements and `python -m playwright install chromium`.
"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright
from piles_auto_assignment_runner import CuracelPilesRunner


class ResponseWaitBrowserTests(unittest.TestCase):
    def test_delayed_next_page_response_is_processed_before_deadline(self):
        release_response = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path.startswith('/api/piles'):
                    if not release_response.wait(5):
                        self.send_error(504)
                        return
                    body = json.dumps({'data': [{'id': 'synthetic-pile'}]}).encode()
                    content_type = 'application/json'
                else:
                    body = b'''<button onclick="fetch('/api/piles?year=2025&page=2')">Next</button>'''
                    content_type = 'text/html'
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                try:
                    page = browser.new_page()
                    runner = object.__new__(CuracelPilesRunner)
                    runner.page = page
                    runner._piles_response_events = []
                    runner._piles_response_sequence = 0
                    page.on('response', runner._capture_piles_response)
                    page.goto(f'http://127.0.0.1:{server.server_port}/')
                    page.get_by_role('button', name='Next').click()
                    self.assertEqual(runner._piles_response_events, [])
                    release_response.set()
                    try:
                        runner._wait_for_piles_filter_response(
                            0, 'All', '2025', 'All', timeout_ms=1500, page_number=2)
                    except RuntimeError as error:
                        self.fail(f'Valid delayed next-page response was not processed: {error}')
                    self.assertEqual(len(runner._piles_response_events), 1)
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
