#!/usr/bin/env python3
"""
Visual Playwright runner for Piles Auto-Assignment.

Typical usage:
  python3 scripts/piles_auto_assignment_runner.py --insurer "Jubilee Kenya" --visible
  python3 scripts/piles_auto_assignment_runner.py --insurer "Jubilee Kenya" --visible --execute

Default mode is dry-run: it scans, plans, and shows the browser flow without clicking Assign Claims.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import psycopg2
import requests
from dotenv import load_dotenv
from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env.local")

TARGET_STATUSES = [
    "Vetting Pending",
    "Vetting Ongoing",
    "Audit Pending",
    "Audit Ongoing",
    "AI Audit",
]
STATUS_ASSIGNMENT_TYPE = {
    "Vetting Pending": "Vetting",
    "Vetting Ongoing": "Vetting",
    "Audit Pending": "Vetting",
    "Audit Ongoing": "Vetting",
    "AI Audit": "Vetting",
}


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def is_test_portal(url: str) -> bool:
    lowered = norm(url).lower()
    return "dev.claims.curacel.co" in lowered


def norm(text: Any) -> str:
    return str(text or "").strip()


def norm_key(text: Any) -> str:
    return "".join(ch.lower() for ch in norm(text) if ch.isalnum())


CURACEL_BASE_URL = norm(os.getenv("CURACEL_PORTAL_BASE_URL")) or "https://health.curacel.co"


def safe_int(value: Any, default: int = 0) -> int:
    text = str(value or "").replace(",", " ").strip()
    match = re.search(r"\d+", text)
    if match:
        try:
            return int(match.group(0))
        except Exception:
            pass
    try:
        return int(float(str(value).replace(",", "").strip()))
    except Exception:
        return default


def chunked(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def insurer_env_key(insurer_name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", norm(insurer_name).upper()).strip("_")


def override_master_credentials(insurer_name: str, email: str, password: str) -> tuple[str, str]:
    key = insurer_env_key(insurer_name)
    override_email = norm(os.getenv(f"CURACEL_OVERRIDE_{key}_EMAIL"))
    override_password = norm(os.getenv(f"CURACEL_OVERRIDE_{key}_PASSWORD"))
    return override_email or email, override_password or password


_DECRYPT_CACHE: dict[str, str] = {}


def decrypt_credential(value: Any) -> str:
    raw = norm(value)
    if not raw or not raw.startswith("enc:v1:"):
        return raw
    if raw in _DECRYPT_CACHE:
        return _DECRYPT_CACHE[raw]

    script = ROOT / "scripts" / "piles_auto_assignment_credential_cli.mjs"
    result = subprocess.run(
        ["node", str(script), "decrypt", raw],
        capture_output=True,
        text=True,
        env=os.environ.copy(),
        check=True,
    )
    decrypted = result.stdout.strip()
    _DECRYPT_CACHE[raw] = decrypted
    return decrypted


@dataclass
class MasterAccount:
    id: str
    insurer_name: str
    login_email: str
    login_password: str
    is_active: bool


@dataclass
class BotAccount:
    id: str
    insurer_name: str
    owner_name: str
    bot_name: str
    bot_email: str
    bot_password: str
    assignment_role: str
    support_capacity_ratio: float
    availability_status: str
    availability_note: str
    is_active: bool
    is_available: bool
    current_claim_load: int
    priority_order: int

    @property
    def portal_name(self) -> str:
        return norm(self.bot_name) or norm(self.owner_name)


@dataclass
class BotMetric:
    bot_account_id: str
    claims_per_hour: float
    active_claim_load: int


@dataclass
class AssignmentRule:
    insurer_name: str
    distribution_mode: str
    minimum_claim_chunk: int
    reassignment_threshold_minutes: int
    stale_claim_threshold: int
    target_completion_gap_minutes: int


@dataclass
class PileRow:
    key: str
    provider: str
    claims: int
    month: str
    submitted_date: str
    status: str
    assigned: str
    status_bucket: str
    page_number: int
    assignment_type: str


@dataclass
class PlannedAssignment:
    pile_key: str
    assignee_id: str
    assignee_name: str
    assignment_type: str
    insurer_name: str
    claims: int
    status_bucket: str


class DataStore:
    def __init__(self) -> None:
        self.database_url = norm(os.getenv("DATABASE_URL"))
        self.supabase_url = norm(os.getenv("NEXT_PUBLIC_SUPABASE_URL"))
        self.supabase_key = norm(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
        self.mode = "postgres" if self.database_url else "supabase"
        self.conn = None

        if self.mode == "postgres":
            self.conn = psycopg2.connect(self.database_url)
            self.conn.autocommit = True
        elif not (self.supabase_url and self.supabase_key):
            raise RuntimeError("Missing DATABASE_URL or Supabase URL/service role key.")

    def close(self) -> None:
        if self.conn:
            self.conn.close()

    def _fetchall_postgres(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        assert self.conn
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]

    def _execute_postgres(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        assert self.conn
        with self.conn.cursor() as cur:
            cur.execute(sql, params)

    def _fetchall_supabase(self, table: str, filters: list[tuple[str, str, str]] | None = None, order: str | None = None) -> list[dict[str, Any]]:
        params = ["select=*"]
        if order:
            params.append(f"order={quote(order, safe=',.')}")
        if filters:
            for field, op, value in filters:
                params.append(f"{quote(field)}={quote(f'{op}.{value}', safe='.')}")
        url = f"{self.supabase_url}/rest/v1/{table}?" + "&".join(params)
        res = requests.get(url, headers={
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
        }, timeout=30)
        res.raise_for_status()
        return res.json()

    def _insert_supabase(self, table: str, payload: dict[str, Any]) -> None:
        url = f"{self.supabase_url}/rest/v1/{table}"
        res = requests.post(url, headers={
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }, json=payload, timeout=30)
        res.raise_for_status()

    def _update_supabase(self, table: str, field: str, value: str, payload: dict[str, Any]) -> None:
        url = f"{self.supabase_url}/rest/v1/{table}?{quote(field)}=eq.{quote(value)}"
        res = requests.patch(url, headers={
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }, json=payload, timeout=30)
        res.raise_for_status()

    def get_master_account(self, insurer_name: str) -> MasterAccount:
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select id, insurer_name, login_email, login_password, is_active
                from piles_auto_assignment_master_accounts
                where lower(insurer_name) = lower(%s)
                limit 1
                """,
                (insurer_name,),
            )
        else:
            rows = self._fetchall_supabase(
                "piles_auto_assignment_master_accounts",
                filters=[("insurer_name", "eq", insurer_name)],
            )
        if not rows:
            override_email, override_password = override_master_credentials(insurer_name, "", "")
            if override_email and override_password:
                return MasterAccount(
                    id=f"env-override-{insurer_env_key(insurer_name).lower()}",
                    insurer_name=norm(insurer_name),
                    login_email=override_email,
                    login_password=override_password,
                    is_active=True,
                )
            raise RuntimeError(f"No master account found for insurer '{insurer_name}'.")
        row = rows[0]
        login_email, login_password = override_master_credentials(
            insurer_name,
            decrypt_credential(row["login_email"]),
            decrypt_credential(row.get("login_password")),
        )
        return MasterAccount(
            id=str(row["id"]),
            insurer_name=norm(row["insurer_name"]),
            login_email=login_email,
            login_password=login_password,
            is_active=bool(row.get("is_active", True)),
        )

    def get_bot_accounts(self, insurer_name: str) -> list[BotAccount]:
        return self._rows_to_bot_accounts(self._fetch_bot_account_rows(insurer_name))

    def get_all_bot_accounts(self) -> list[BotAccount]:
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_bot_accounts
                order by insurer_name asc, priority_order asc, owner_name asc
                """
            )
        else:
            rows = self._fetchall_supabase(
                "piles_auto_assignment_bot_accounts",
                order="insurer_name.asc,priority_order.asc",
            )
        return self._rows_to_bot_accounts(rows)

    def _fetch_bot_account_rows(self, insurer_name: str) -> list[dict[str, Any]]:
        if self.mode == "postgres":
            return self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_bot_accounts
                where lower(insurer_name) = lower(%s)
                order by priority_order asc, owner_name asc
                """,
                (insurer_name,),
            )
        else:
            return self._fetchall_supabase(
                "piles_auto_assignment_bot_accounts",
                filters=[("insurer_name", "eq", insurer_name)],
                order="priority_order.asc",
            )

    def _rows_to_bot_accounts(self, rows: list[dict[str, Any]]) -> list[BotAccount]:
        return [
            BotAccount(
                id=str(row["id"]),
                insurer_name=norm(row["insurer_name"]),
                owner_name=norm(row["owner_name"]),
                bot_name=norm(row.get("bot_name")),
                bot_email=decrypt_credential(row.get("bot_email")),
                bot_password=decrypt_credential(row.get("bot_password")),
                assignment_role=norm(row.get("assignment_role") or "primary").lower(),
                support_capacity_ratio=float(row.get("support_capacity_ratio") or 1),
                availability_status=norm(row.get("availability_status") or "available").lower(),
                availability_note=norm(row.get("availability_note")),
                is_active=bool(row.get("is_active", True)),
                is_available=bool(row.get("is_available", True)),
                current_claim_load=safe_int(row.get("current_claim_load"), 0),
                priority_order=safe_int(row.get("priority_order"), 100),
            )
            for row in rows
        ]

    def get_bot_metrics(self, bot_ids: list[str]) -> dict[str, BotMetric]:
        if not bot_ids:
            return {}
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select bot_account_id, claims_per_hour, active_claim_load
                from piles_auto_assignment_bot_metrics
                where bot_account_id = any(%s)
                """,
                (bot_ids,),
            )
        else:
            # Supabase REST doesn't love array filters in this tiny helper; fetch all and filter client-side.
            rows = [row for row in self._fetchall_supabase("piles_auto_assignment_bot_metrics") if str(row.get("bot_account_id")) in bot_ids]
        return {
            str(row["bot_account_id"]): BotMetric(
                bot_account_id=str(row["bot_account_id"]),
                claims_per_hour=float(row.get("claims_per_hour") or 0),
                active_claim_load=safe_int(row.get("active_claim_load"), 0),
            )
            for row in rows
        }

    def get_rule(self, insurer_name: str) -> AssignmentRule | None:
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_rules
                where lower(insurer_name) = lower(%s)
                limit 1
                """,
                (insurer_name,),
            )
        else:
            rows = self._fetchall_supabase(
                "piles_auto_assignment_rules",
                filters=[("insurer_name", "eq", insurer_name)],
            )
        if not rows:
            return None
        row = rows[0]
        return AssignmentRule(
            insurer_name=norm(row["insurer_name"]),
            distribution_mode=norm(row.get("distribution_mode") or "balanced_finish"),
            minimum_claim_chunk=safe_int(row.get("minimum_claim_chunk"), 25),
            reassignment_threshold_minutes=safe_int(row.get("reassignment_threshold_minutes"), 120),
            stale_claim_threshold=safe_int(row.get("stale_claim_threshold"), 40),
            target_completion_gap_minutes=safe_int(row.get("target_completion_gap_minutes"), 30),
        )

    def log_assignment(self, plan: PlannedAssignment, assignee: BotAccount, execute: bool) -> None:
        payload = {
            "id": str(uuid.uuid4()),
            "bot_account_id": assignee.id,
            "insurer_name": assignee.insurer_name,
            "event_type": "assignment_planned" if not execute else "assignment",
            "source": "runner",
            "status": "planned" if not execute else "assigned",
            "assigned_by": "piles_auto_assignment_runner",
            "pile_count": 1,
            "claim_count": plan.claims,
            "details": {
                "pile_key": plan.pile_key,
                "assignment_type": plan.assignment_type,
                "status_bucket": plan.status_bucket,
                "assignee_name": assignee.portal_name,
            },
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                insert into piles_auto_assignment_logs
                (id, bot_account_id, insurer_name, event_type, source, status, assigned_by, pile_count, claim_count, details)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    payload["id"],
                    payload["bot_account_id"],
                    payload["insurer_name"],
                    payload["event_type"],
                    payload["source"],
                    payload["status"],
                    payload["assigned_by"],
                    payload["pile_count"],
                    payload["claim_count"],
                    json.dumps(payload["details"]),
                ),
            )
        else:
            self._insert_supabase("piles_auto_assignment_logs", payload)

    def log_runner_event(
        self,
        insurer_name: str,
        event_type: str,
        status: str,
        details: dict[str, Any],
        pile_count: int = 0,
        claim_count: int = 0,
    ) -> None:
        payload = {
            "id": str(uuid.uuid4()),
            "insurer_name": insurer_name,
            "event_type": event_type,
            "source": "runner",
            "status": status,
            "assigned_by": "piles_auto_assignment_runner",
            "pile_count": pile_count,
            "claim_count": claim_count,
            "details": details,
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                insert into piles_auto_assignment_logs
                (id, insurer_name, event_type, source, status, assigned_by, pile_count, claim_count, details)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    payload["id"],
                    payload["insurer_name"],
                    payload["event_type"],
                    payload["source"],
                    payload["status"],
                    payload["assigned_by"],
                    payload["pile_count"],
                    payload["claim_count"],
                    json.dumps(payload["details"]),
                ),
            )
        else:
            self._insert_supabase("piles_auto_assignment_logs", payload)

    def update_bot_load(self, bot_id: str, new_load: int) -> None:
        payload = {
            "current_claim_load": new_load,
            "last_assigned_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                update piles_auto_assignment_bot_accounts
                set current_claim_load = %s,
                    last_assigned_at = now(),
                    updated_at = now()
                where id = %s
                """,
                (new_load, bot_id),
            )
        else:
            self._update_supabase("piles_auto_assignment_bot_accounts", "id", bot_id, payload)


class CuracelPilesRunner:
    def __init__(self, visible: bool = True, slow_mo: int = 350) -> None:
        self.visible = visible
        self.slow_mo = slow_mo
        self.allow_test_any_assignee = False
        self.playwright = None
        self.browser: Browser | None = None
        self.page: Page | None = None

    def __enter__(self) -> "CuracelPilesRunner":
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(headless=not self.visible, slow_mo=self.slow_mo)
        self.page = self.browser.new_page(viewport={"width": 1500, "height": 950})
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self.browser:
            self.browser.close()
        if self.playwright:
            self.playwright.stop()

    def _dismiss_popup(self) -> None:
        assert self.page
        for _ in range(2):
            try:
                self.page.keyboard.press("Escape")
                time.sleep(0.2)
            except Exception:
                pass
            for selector in [
                ".p-dialog-close",
                "[aria-label='Close']",
                "button:has-text('Close')",
                "button:has-text('close')",
            ]:
                try:
                    btn = self.page.locator(selector).first
                    if btn.is_visible(timeout=300):
                        btn.click()
                        time.sleep(0.2)
                except Exception:
                    pass

    def login(self, username: str, password: str) -> None:
        assert self.page
        self.page.goto(CURACEL_BASE_URL, wait_until="networkidle")
        self.page.locator('input[name="loginId"]').fill(username)
        self.page.locator('input[name="password"]').fill(password)
        self.page.locator('input[type="Submit"]').click()
        time.sleep(4)
        self._dismiss_popup()
        if "auth.curacel.co" in self.page.url:
            raise RuntimeError("Login failed; still on auth page.")

    def select_account(self, insurer_name: str) -> None:
        assert self.page
        time.sleep(2)
        if "/hmo/" in self.page.url:
            return
        dropdown = self.page.locator(".p-select.p-component").first
        if dropdown.count() == 0:
            return
        dropdown.click()
        time.sleep(1)
        options = self.page.locator(".p-select-option, .p-select-list li, [role='option']")
        matched = None
        for idx in range(options.count()):
            text = norm(options.nth(idx).inner_text())
            if self._fuzzy_match(insurer_name, text):
                matched = options.nth(idx)
                break
        if matched is None:
            self.page.keyboard.press("Escape")
            return
        matched.click()
        time.sleep(1)
        for selector in ["button:has-text('Enter Account')", "a:has-text('Enter Account')"]:
            btn = self.page.locator(selector).first
            try:
                if btn.count() and btn.is_visible():
                    btn.click()
                    break
            except Exception:
                continue
        time.sleep(3)
        self._dismiss_popup()

    def open_piles(self) -> None:
        assert self.page
        self.page.goto(f"{CURACEL_BASE_URL}/hmo/piles", wait_until="networkidle")
        time.sleep(2)
        self._dismiss_popup()

    def _visible_selects(self) -> list[Any]:
        assert self.page
        selectors = self.page.locator(".p-select.p-component")
        visible: list[tuple[float, float, Any]] = []
        for idx in range(selectors.count()):
            loc = selectors.nth(idx)
            try:
                box = loc.bounding_box()
                if box and box["y"] < 420:
                    visible.append((box["y"], box["x"], loc))
            except Exception:
                continue
        visible.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in visible]

    def _select_by_label(self, label_text: str) -> Any | None:
        assert self.page
        label_key = norm_key(label_text)
        candidates = self.page.locator(".p-select.p-component")
        for idx in range(candidates.count()):
            loc = candidates.nth(idx)
            try:
                if not loc.is_visible():
                    continue
                box = loc.bounding_box()
                if not box or box["y"] > 420:
                    continue
                text = norm(loc.inner_text())
                if label_key in norm_key(text):
                    return loc
                labelledby = loc.get_attribute("aria-labelledby") or ""
                if label_key in norm_key(labelledby):
                    return loc
            except Exception:
                continue
        return None

    def _select_in_container(self, label_text: str) -> Any | None:
        assert self.page
        selectors = [
            f"div:has-text('{label_text}') .p-select.p-component",
            f"div:has-text('{label_text}') .p-multiselect.p-component",
            f"div:has-text('{label_text}') [role='combobox']",
        ]
        visible: list[tuple[float, float, Any]] = []
        for selector in selectors:
            try:
                locs = self.page.locator(selector)
                for idx in range(locs.count()):
                    loc = locs.nth(idx)
                    if not loc.is_visible():
                        continue
                    box = loc.bounding_box()
                    if box and box["y"] < 420:
                        visible.append((box["y"], box["x"], loc))
            except Exception:
                continue
        if not visible:
            return None
        visible.sort(key=lambda item: (item[0], item[1]))
        return visible[0][2]

    def _choose_option_from_open_dropdown(self, desired_text: str) -> str | None:
        assert self.page
        options = self.page.locator(".p-select-option, .p-select-list li, [role='option']")
        option_texts: list[tuple[str, Any]] = []
        for idx in range(options.count()):
            option = options.nth(idx)
            text = norm(option.inner_text())
            if text:
                option_texts.append((text, option))
            if norm_key(text) == norm_key(desired_text) or norm_key(desired_text) in norm_key(text):
                option.click()
                time.sleep(0.8)
                return text
        if self.allow_test_any_assignee:
            for text, option in option_texts:
                lowered = text.lower()
                if lowered in {"select user", "no results found", "all"}:
                    continue
                option.click()
                time.sleep(0.8)
                print(f"  Test fallback: selected available assignee '{text}' instead of requested '{desired_text}'.")
                return text
        return None

    def _set_select_value(self, select: Any | None, desired_text: str, required: bool = False) -> bool:
        assert self.page
        if select is None:
            if required:
                raise RuntimeError(f"Could not find select for '{desired_text}'.")
            return False
        try:
            select.click()
            time.sleep(0.5)
            selected_text = self._choose_option_from_open_dropdown(desired_text)
            if not selected_text:
                try:
                    self.page.keyboard.press("Escape")
                except Exception:
                    pass
                if required:
                    raise RuntimeError(f"Could not set filter to '{desired_text}'.")
                return False
            return True
        except Exception:
            if required:
                raise
            return False

    def _read_select_text(self, select: Any | None) -> str:
        if select is None:
            return ""
        try:
            return norm(select.inner_text())
        except Exception:
            return ""

    def _read_year_chip_text(self) -> str:
        assert self.page
        selectors = [
            "div:has-text('Year')",
            "label:has-text('Year')",
        ]
        for selector in selectors:
            try:
                locs = self.page.locator(selector)
                for idx in range(locs.count()):
                    loc = locs.nth(idx)
                    if not loc.is_visible():
                        continue
                    box = loc.bounding_box()
                    if not box or box["y"] > 420:
                        continue
                    text = norm(loc.inner_text())
                    year_match = re.search(r"\b20\d{2}\b", text)
                    if year_match:
                        return year_match.group(0)
            except Exception:
                continue
        return ""

    def apply_filters(self, month_label: str, year_label: str, status_label: str) -> None:
        assert self.page
        month_select = self._select_in_container("Select Month") or self._select_by_label("Select Month")
        year_select = None
        status_select = self._select_by_label("Filter by Vetting Status")

        selects = self._visible_selects()
        if month_select is None and len(selects) >= 1:
            month_select = selects[0]
        if status_select is None and len(selects) >= 2:
            status_select = selects[-1]

        self._set_select_value(month_select, month_label)
        self._set_select_value(status_select, status_label, required=True)

        print(
            "  Applied filter controls:"
            f" month='{self._read_select_text(month_select)}'"
            f" year='{self._read_year_chip_text() or year_label}'"
            f" status='{self._read_select_text(status_select)}'"
        )

        for selector in ["button:has-text('Filters')", "button:has-text('Filter')"]:
            try:
                button = self.page.locator(selector).first
                if button.count() and button.is_visible():
                    button.click()
                    break
            except Exception:
                continue
        try:
            self.page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass
        time.sleep(1.5)
        self.wait_for_table_ready()

    def try_set_page_size(self, page_size: int = 100) -> None:
        assert self.page
        # Best-effort only; pagination controls vary.
        selectors = [
            "[aria-label='Rows per page']",
            ".p-paginator-rpp-options",
            ".p-dropdown.p-component",
        ]
        for selector in selectors:
            try:
                loc = self.page.locator(selector)
                if loc.count() == 0:
                    continue
                target = loc.last
                if target.is_visible():
                    target.click()
                    time.sleep(0.4)
                    if self._choose_option_from_open_dropdown(str(page_size)):
                        time.sleep(1)
                        return
                    self.page.keyboard.press("Escape")
            except Exception:
                continue

    def _table_headers(self) -> list[str]:
        assert self.page
        headers = []
        ths = self.page.locator("table thead tr th")
        for idx in range(ths.count()):
            headers.append(norm(ths.nth(idx).inner_text()))
        return headers

    def wait_for_table_ready(self, timeout_ms: int = 12000) -> None:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000)
        last_fingerprint = None
        stable_ticks = 0
        while time.time() < deadline:
            try:
                rows = self.page.locator("table tbody tr")
                count = rows.count()
                texts = [norm(rows.nth(i).inner_text()) for i in range(min(count, 3))] if count > 0 else []
                no_data = self.page.locator("text=No data found").count() > 0
                fingerprint = ("rows", tuple(texts)) if texts else ("empty", no_data)
                if fingerprint == last_fingerprint:
                    stable_ticks += 1
                else:
                    stable_ticks = 0
                    last_fingerprint = fingerprint
                if stable_ticks >= 2 and (texts or no_data):
                    return
            except Exception:
                pass
            time.sleep(0.5)

    def rows_on_current_page(self, status_bucket: str, page_number: int) -> list[PileRow]:
        assert self.page
        headers = self._table_headers()
        header_map = {norm_key(h): i for i, h in enumerate(headers)}
        rows = self.page.locator("table tbody tr")
        piles: list[PileRow] = []
        for idx in range(rows.count()):
            row = rows.nth(idx)
            cells = row.locator("td")
            texts = [norm(cells.nth(c).inner_text()) for c in range(cells.count())]
            joined = " ".join(texts).lower()
            if "no data found" in joined:
                continue

            def value(label: str, fallback_index: int | None = None) -> str:
                key = norm_key(label)
                if key in header_map and header_map[key] < len(texts):
                    return texts[header_map[key]]
                if fallback_index is not None and fallback_index < len(texts):
                    return texts[fallback_index]
                return ""

            provider = value("provider", 1)
            claims = safe_int(value("claims", 2), 0)
            month = value("month", 3)
            submitted_date = value("submitted date", 6)
            row_status = value("status", 7) or status_bucket
            assigned = value("assigned", len(texts) - 2 if len(texts) >= 2 else 0)
            key = "|".join([
                norm(provider),
                str(claims),
                norm(month),
                norm(submitted_date),
                norm(status_bucket),
            ])
            piles.append(PileRow(
                key=key,
                provider=provider,
                claims=claims,
                month=month,
                submitted_date=submitted_date,
                status=row_status,
                assigned=assigned,
                status_bucket=status_bucket,
                page_number=page_number,
                assignment_type=STATUS_ASSIGNMENT_TYPE[status_bucket],
            ))
        return piles

    def goto_next_page(self) -> bool:
        assert self.page
        selectors = [
            "button[aria-label='Next Page']",
            "button[aria-label='Next']",
            ".p-paginator-next",
            "button:has-text('Next')",
        ]
        for selector in selectors:
            try:
                loc = self.page.locator(selector).first
                if loc.count() == 0 or not loc.is_visible():
                    continue
                disabled = loc.get_attribute("disabled") is not None
                classes = norm(loc.get_attribute("class")).lower()
                if disabled or "disabled" in classes:
                    return False
                loc.click()
                time.sleep(1)
                self.wait_for_table_ready()
                return True
            except Exception:
                continue
        return False

    def scan_status(self, month_label: str, year_label: str, status_label: str) -> list[PileRow]:
        self.apply_filters(month_label, year_label, status_label)
        self.try_set_page_size(100)
        seen_pages = set()
        piles: list[PileRow] = []
        page_number = 1
        while True:
            page_rows = self.rows_on_current_page(status_label, page_number)
            fingerprint = tuple(row.key for row in page_rows)
            if fingerprint in seen_pages:
                break
            seen_pages.add(fingerprint)
            piles.extend(page_rows)
            if not self.goto_next_page():
                break
            page_number += 1
        return piles

    def scan_all_unassigned(self, month_label: str, year_label: str) -> list[PileRow]:
        all_rows: list[PileRow] = []
        seen = set()
        for status_label in TARGET_STATUSES:
            print(f"\nScanning status: {status_label}")
            rows = self.scan_status(month_label, year_label, status_label)
            unassigned = [row for row in rows if not norm(row.assigned)]
            print(f"  Found {len(rows)} rows, {len(unassigned)} unassigned")
            for row in unassigned:
                if row.key in seen:
                    continue
                seen.add(row.key)
                all_rows.append(row)
        return all_rows

    def _fuzzy_match(self, insurer_name: str, option_text: str) -> bool:
        insurer_lower = norm(insurer_name).lower()
        option_lower = norm(option_text).lower()
        if insurer_lower in option_lower:
            return True
        words = [w for w in insurer_lower.split() if w]
        if words and all(w in option_lower for w in words):
            return True
        key_words = [w for w in words if len(w) > 3]
        return bool(key_words and any(w in option_lower for w in key_words))

    def _select_rows(self, pile_keys: list[str], current_rows: list[PileRow]) -> int:
        assert self.page
        rows = self.page.locator("table tbody tr")
        selected = 0
        for idx in range(rows.count()):
            row = rows.nth(idx)
            cells = row.locator("td")
            texts = [norm(cells.nth(c).inner_text()) for c in range(cells.count())]
            if "no data found" in " ".join(texts).lower():
                continue
            provider = texts[1] if len(texts) > 1 else ""
            claims = safe_int(texts[2] if len(texts) > 2 else "0", 0)
            month = texts[3] if len(texts) > 3 else ""
            submitted = texts[6] if len(texts) > 6 else ""
            matched = next((p for p in current_rows if p.provider == provider and p.claims == claims and p.month == month and p.submitted_date == submitted), None)
            if not matched or matched.key not in pile_keys:
                continue
            try:
                checkbox = row.locator("input[type='checkbox']").first
                checkbox.check(force=True)
                selected += 1
            except Exception:
                try:
                    row.locator("td").first.click()
                    selected += 1
                except Exception:
                    continue
        return selected

    def _open_assign_modal(self) -> None:
        assert self.page
        try:
            self.page.evaluate("window.scrollTo(0, 0)")
            time.sleep(0.4)
        except Exception:
            pass

        actions_clicked = False
        action_selectors = [
            "button:has-text('Actions')",
            ".actionDropdownBtn",
            "[role='button']:has-text('Actions')",
        ]
        for selector in action_selectors:
            try:
                locs = self.page.locator(selector)
                for idx in range(locs.count()):
                    button = locs.nth(idx)
                    if not button.is_visible():
                        continue
                    try:
                        button.scroll_into_view_if_needed(timeout=2000)
                    except Exception:
                        pass
                    button.click(force=True)
                    actions_clicked = True
                    break
                if actions_clicked:
                    break
            except Exception:
                continue
        if not actions_clicked:
            raise RuntimeError("Could not open the Actions menu on the piles page.")

        time.sleep(0.8)
        assign_clicked = False
        try:
            exact_nodes = self.page.locator("xpath=//*[normalize-space(text())='Assign to']")
            for idx in range(exact_nodes.count()):
                node = exact_nodes.nth(idx)
                if not node.is_visible():
                    continue
                clicked = False
                try:
                    ancestor = node.locator(
                        "xpath=ancestor::*[self::button or self::a or self::li or @role='menuitem' or contains(@class,'item') or contains(@class,'option')][1]"
                    )
                    if ancestor.count() and ancestor.first.is_visible():
                        ancestor.first.click(force=True)
                        clicked = True
                except Exception:
                    pass
                if not clicked:
                    try:
                        node.click(force=True)
                        clicked = True
                    except Exception:
                        pass
                if clicked:
                    assign_clicked = True
                    break
        except Exception:
            pass
        if not assign_clicked:
            raise RuntimeError("Could not choose 'Assign to' from the Actions menu.")
        time.sleep(1)

    def _visible_overlay_roots(self) -> list[Any]:
        assert self.page
        selectors = [
            ".p-dialog:visible",
            "[role='dialog']:visible",
            ".p-sidebar:visible",
            ".p-overlaypanel:visible",
        ]
        roots: list[tuple[float, Any]] = []
        for selector in selectors:
            try:
                locs = self.page.locator(selector)
                for idx in range(locs.count()):
                    loc = locs.nth(idx)
                    if not loc.is_visible():
                        continue
                    box = loc.bounding_box()
                    if not box:
                        continue
                    roots.append((box["y"], loc))
            except Exception:
                continue
        roots.sort(key=lambda item: item[0])
        return [item[1] for item in roots]

    def _find_assign_user_control(self) -> Any | None:
        assert self.page
        roots = self._visible_overlay_roots()
        search_roots = roots[::-1] + [self.page.locator("body")]
        selectors = [
            ".p-select.p-component",
            ".p-dropdown.p-component",
            "[role='combobox']",
            "button[aria-haspopup='listbox']",
        ]
        best: tuple[float, Any] | None = None
        for root in search_roots:
            for selector in selectors:
                try:
                    locs = root.locator(selector)
                    for idx in range(locs.count()):
                        loc = locs.nth(idx)
                        if not loc.is_visible():
                            continue
                        text = norm(loc.inner_text())
                        box = loc.bounding_box()
                        if not box:
                            continue
                        score = box["y"]
                        if "select user" in text.lower():
                            score -= 500
                        elif box["y"] < 250:
                            # Bias away from top-level account selectors when a modal is open.
                            score += 400
                        if best is None or score < best[0]:
                            best = (score, loc)
                except Exception:
                    continue
        return best[1] if best else None

    def _open_select_control(self, control: Any) -> bool:
        assert self.page
        click_targets = [
            control,
            control.locator(".p-select-dropdown").first,
            control.locator(".p-dropdown-trigger").first,
            control.locator("[aria-haspopup='listbox']").first,
            control.locator("svg").first,
        ]
        for target in click_targets:
            try:
                if target.count() == 0 or not target.is_visible():
                    continue
                target.click(force=True)
                time.sleep(0.4)
                if self.page.locator(".p-select-option, .p-select-list li, [role='option']").count() > 0:
                    return True
            except Exception:
                try:
                    box = target.bounding_box()
                    if box:
                        self.page.mouse.click(box["x"] + (box["width"] / 2), box["y"] + (box["height"] / 2))
                        time.sleep(0.4)
                        if self.page.locator(".p-select-option, .p-select-list li, [role='option']").count() > 0:
                            return True
                except Exception:
                    continue
        try:
            control.focus()
            self.page.keyboard.press("ArrowDown")
            time.sleep(0.4)
            if self.page.locator(".p-select-option, .p-select-list li, [role='option']").count() > 0:
                return True
        except Exception:
            pass
        return False

    def _apply_assignment_modal(self, assignment_type: str, assignee_name: str, execute: bool) -> None:
        assert self.page
        # Per current workflow, keep the assign modal on its default Vetting path.
        assignment_type = "Vetting"
        time.sleep(0.8)
        control = self._find_assign_user_control()
        if control is None:
            raise RuntimeError("Could not open the Select User control inside the assign modal.")
        opened = self._open_select_control(control)
        if not opened:
            raise RuntimeError("Could not open the Select User control inside the assign modal.")
        selected_assignee = self._choose_option_from_open_dropdown(assignee_name)
        if not selected_assignee:
            try:
                search = self.page.locator("input[placeholder*='Search'], input[placeholder*='search']").last
                if search.count() and search.is_visible():
                    search.fill(assignee_name)
                    time.sleep(0.4)
                    selected_assignee = self._choose_option_from_open_dropdown(assignee_name)
                    if not selected_assignee:
                        raise RuntimeError(f"Could not choose assignee '{assignee_name}' from the assign modal.")
            except Exception:
                raise RuntimeError(f"Could not choose assignee '{assignee_name}' from the assign modal.")

        time.sleep(0.5)
        if execute:
            clicked = False
            for root in self._visible_overlay_roots()[::-1] + [self.page.locator("body")]:
                for selector in [
                    "button:has-text('Assign Claims')",
                    "button:has-text('Assign')",
                    "[role='button']:has-text('Assign Claims')",
                    "[role='button']:has-text('Assign')",
                ]:
                    try:
                        button = root.locator(selector).first
                        if button.count() and button.is_visible():
                            button.click(force=True)
                            clicked = True
                            break
                    except Exception:
                        continue
                if clicked:
                    break
            if not clicked:
                raise RuntimeError("Could not click the final Assign Claims button inside the assign modal.")
            time.sleep(2)
            self._dismiss_popup()
        else:
            print(f"  Dry run: would assign selected piles to {selected_assignee or assignee_name} as {assignment_type}.")
            try:
                self.page.keyboard.press("Escape")
            except Exception:
                pass
            time.sleep(0.5)

    def execute_assignment_plan(self, month_label: str, year_label: str, plans: list[PlannedAssignment], execute: bool) -> dict[str, int]:
        results: dict[str, int] = {}
        for status_label in TARGET_STATUSES:
            status_plans = [plan for plan in plans if plan.status_bucket == status_label]
            if not status_plans:
                continue
            print(f"\nApplying assignments for status: {status_label}")
            self.open_piles()
            self.apply_filters(month_label, year_label, status_label)
            self.try_set_page_size(100)
            page_number = 1
            seen_pages = set()
            while True:
                current_rows = self.rows_on_current_page(status_label, page_number)
                fingerprint = tuple(row.key for row in current_rows)
                if fingerprint in seen_pages:
                    break
                seen_pages.add(fingerprint)
                current_keys = {row.key for row in current_rows}
                page_plans = [plan for plan in status_plans if plan.pile_key in current_keys]
                if page_plans:
                    grouped: dict[tuple[str, str], list[PlannedAssignment]] = {}
                    for plan in page_plans:
                        grouped.setdefault((plan.assignee_name, plan.assignment_type), []).append(plan)
                    for (assignee_name, assignment_type), group in grouped.items():
                        selected = self._select_rows([plan.pile_key for plan in group], current_rows)
                        if not selected:
                            continue
                        self._open_assign_modal()
                        self._apply_assignment_modal(assignment_type, assignee_name, execute)
                        results[assignee_name] = results.get(assignee_name, 0) + selected
                if not self.goto_next_page():
                    break
                page_number += 1
        return results


def build_assignment_plan(
    insurer_name: str,
    piles: list[PileRow],
    bots: list[BotAccount],
    metrics: dict[str, BotMetric],
) -> tuple[list[PlannedAssignment], dict[str, dict[str, Any]]]:
    eligible = []
    for bot in bots:
        if not bot.is_active:
            continue
        if bot.availability_status not in {"available", ""} or not bot.is_available:
            continue
        metric = metrics.get(bot.id)
        observed_speed = metric.claims_per_hour if metric and metric.claims_per_hour > 0 else 0
        base_speed = observed_speed or (35 if bot.assignment_role == "primary" else 20)
        role_weight = bot.support_capacity_ratio if bot.assignment_role == "support" else max(bot.support_capacity_ratio or 1, 1)
        effective_speed = max(base_speed * role_weight, 1)
        current_load = metric.active_claim_load if metric else bot.current_claim_load
        eligible.append({
            "bot": bot,
            "effective_speed": effective_speed,
            "projected_hours": current_load / effective_speed if effective_speed else math.inf,
            "current_load": current_load,
            "assigned_claims": 0,
        })

    if not eligible:
        raise RuntimeError(f"No available bot accounts found for insurer '{insurer_name}'.")

    plans: list[PlannedAssignment] = []
    for pile in sorted(piles, key=lambda item: item.claims, reverse=True):
        chosen = min(
            eligible,
            key=lambda entry: (
                entry["projected_hours"],
                0 if entry["bot"].assignment_role == "primary" else 1,
                entry["bot"].priority_order,
            ),
        )
        chosen["assigned_claims"] += pile.claims
        chosen["current_load"] += pile.claims
        chosen["projected_hours"] = chosen["current_load"] / chosen["effective_speed"]
        plans.append(PlannedAssignment(
            pile_key=pile.key,
            assignee_id=chosen["bot"].id,
            assignee_name=chosen["bot"].portal_name,
            assignment_type=pile.assignment_type,
            insurer_name=insurer_name,
            claims=pile.claims,
            status_bucket=pile.status_bucket,
        ))

    summary = {
        entry["bot"].id: {
            "assignee_name": entry["bot"].portal_name,
            "assignment_role": entry["bot"].assignment_role,
            "effective_speed": round(entry["effective_speed"], 2),
            "starting_load": (metrics.get(entry["bot"].id).active_claim_load if metrics.get(entry["bot"].id) else entry["bot"].current_claim_load),
            "assigned_claims": entry["assigned_claims"],
            "projected_finish_hours": round(entry["projected_hours"], 2),
        }
        for entry in eligible
    }
    return plans, summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visual Curacel Piles Auto-Assignment runner")
    parser.add_argument("--insurer", required=True, help="Insurer name exactly as saved in the DB, e.g. 'Jubilee Kenya'")
    parser.add_argument("--month", help="Month label to filter, default is current month name")
    parser.add_argument("--year", help="Year label to filter, default is current year")
    parser.add_argument("--visible", action="store_true", help="Run with a visible browser")
    parser.add_argument("--execute", action="store_true", help="Actually click Assign Claims. Default is dry-run.")
    parser.add_argument("--slow-mo", type=int, default=350, help="Playwright slow_mo in ms for visual debugging")
    parser.add_argument("--out", default="tmp/piles_auto_assignment_plan.json", help="Where to write the dry-run plan/output JSON")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    month_label = args.month or datetime.now().strftime("%b")
    year_label = args.year or str(datetime.now().year)
    visible = args.visible or not env_bool("HEADLESS", True)
    captured_at = datetime.now(timezone.utc).isoformat()

    if args.execute and not is_test_portal(CURACEL_BASE_URL) and not env_bool("ALLOW_PRODUCTION_ASSIGNMENTS", False):
        raise RuntimeError(
            "Execute mode is blocked outside the test portal. "
            "Use the dev portal, or set ALLOW_PRODUCTION_ASSIGNMENTS=true only when you intentionally want live assignments."
        )

    store = DataStore()
    try:
        master = store.get_master_account(args.insurer)
        if not master.login_email or not master.login_password:
            raise RuntimeError(f"Master account for '{args.insurer}' is missing login email or password.")
        bots = store.get_bot_accounts(args.insurer)
        fallback_pool_used = False
        if not bots and is_test_portal(CURACEL_BASE_URL):
            bots = store.get_all_bot_accounts()
            fallback_pool_used = True
            print("Using test-portal fallback assignee pool because this insurer has no configured bot rows.")
        metrics = store.get_bot_metrics([bot.id for bot in bots])
        rule = store.get_rule(args.insurer)

        print("=" * 72)
        print(f"Piles Auto-Assignment Runner")
        print(f"Insurer: {args.insurer}")
        print(f"Portal: {CURACEL_BASE_URL}")
        print(f"Month/Year: {month_label} {year_label}")
        print(f"Mode: {'EXECUTE' if args.execute else 'DRY RUN'}")
        if rule:
            print(f"Rule mode: {rule.distribution_mode} | min chunk: {rule.minimum_claim_chunk}")
        print("=" * 72)

        with CuracelPilesRunner(visible=visible, slow_mo=args.slow_mo) as runner:
            runner.allow_test_any_assignee = fallback_pool_used and is_test_portal(CURACEL_BASE_URL)
            print("\nLogging in...")
            runner.login(master.login_email, master.login_password)
            runner.select_account(args.insurer)
            runner.open_piles()

            print("\nScanning pages...")
            unassigned = runner.scan_all_unassigned(month_label, year_label)
            print(f"\nTotal unassigned piles found: {len(unassigned)}")
            if not unassigned:
                print("No unassigned piles found. Nothing to assign.")
                return

            plans, summary = build_assignment_plan(args.insurer, unassigned, bots, metrics)
            print("\nAssignment summary:")
            for item in summary.values():
                print(
                    f"  - {item['assignee_name']} [{item['assignment_role']}] "
                    f"speed={item['effective_speed']}/hr assigned={item['assigned_claims']} "
                    f"projected_finish={item['projected_finish_hours']}h"
                )

            output_path = ROOT / args.out
            output_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "insurer": args.insurer,
                "month": month_label,
                "year": year_label,
                "mode": "execute" if args.execute else "dry-run",
                "captured_at": captured_at,
                "unassigned_count": len(unassigned),
                "piles": [row.__dict__ for row in unassigned],
                "plans": [plan.__dict__ for plan in plans],
                "summary": summary,
            }
            output_path.write_text(json.dumps(payload, indent=2))
            print(f"\nPlan written to {output_path}")

            store.log_runner_event(
                insurer_name=args.insurer,
                event_type="runner_scan",
                status="planned" if not args.execute else "ready",
                pile_count=len(unassigned),
                claim_count=sum(row.claims for row in unassigned),
                details={
                    "insurer_name": args.insurer,
                    "mode": "execute" if args.execute else "dry-run",
                    "captured_at": captured_at,
                    "fallback_pool_used": fallback_pool_used,
                    "month": month_label,
                    "year": year_label,
                    "statuses": TARGET_STATUSES,
                    "summary": summary,
                    "plan_file": str(output_path),
                },
            )

            print("\nApplying assignment flow...")
            results = runner.execute_assignment_plan(month_label, year_label, plans, execute=args.execute)
            print("\nUI assignment groups touched:")
            for assignee_name, count in results.items():
                print(f"  - {assignee_name}: {count} pile(s)")

        for plan in plans:
            assignee = next(bot for bot in bots if bot.id == plan.assignee_id)
            store.log_assignment(plan, assignee, execute=args.execute)

        if args.execute:
            assigned_by_bot: dict[str, int] = {}
            for plan in plans:
                assigned_by_bot[plan.assignee_id] = assigned_by_bot.get(plan.assignee_id, 0) + plan.claims
            for bot in bots:
                if bot.id in assigned_by_bot:
                    metric = metrics.get(bot.id)
                    starting = metric.active_claim_load if metric else bot.current_claim_load
                    store.update_bot_load(bot.id, starting + assigned_by_bot[bot.id])

        store.log_runner_event(
            insurer_name=args.insurer,
            event_type="runner_complete",
            status="assigned" if args.execute else "dry_run_complete",
            pile_count=len(plans),
            claim_count=sum(plan.claims for plan in plans),
            details={
                "insurer_name": args.insurer,
                "mode": "execute" if args.execute else "dry-run",
                "captured_at": captured_at,
                "fallback_pool_used": fallback_pool_used,
                "results": results,
                "summary": summary,
            },
        )

        print("\nDone.")
    finally:
        store.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
    except Exception as exc:
        print(f"\nERROR: {exc}")
        sys.exit(1)
