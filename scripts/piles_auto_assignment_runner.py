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
import traceback
import uuid
from dataclasses import dataclass, replace
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

import psycopg2
import requests
from dotenv import load_dotenv
from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / ".env.local")
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".playwright-browsers"))
RUNNER_TIMEZONE = ZoneInfo((os.getenv("PILES_ASSIGNMENT_TIMEZONE") or "Africa/Lagos").strip() or "Africa/Lagos")

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
MONTH_OPTIONS = ["All", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
INSURER_ALIAS_DISPLAY = {
    "uapom": "OLD MUTUAL",
    "old mutual": "OLD MUTUAL",
}


class TeeCapture:
    def __init__(self, original: Any) -> None:
        self.original = original
        self.parts: list[str] = []

    def write(self, data: str) -> int:
        text = str(data)
        self.parts.append(text)
        return self.original.write(text)

    def flush(self) -> None:
        self.original.flush()

    def isatty(self) -> bool:
        return bool(getattr(self.original, "isatty", lambda: False)())

    def getvalue(self) -> str:
        return "".join(self.parts)


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


def label_key(text: Any) -> str:
    return re.sub(r"\s+", " ", norm(text).lower()).strip()


def canonical_insurer_key(text: Any) -> str:
    label = label_key(text)
    return INSURER_ALIAS_DISPLAY.get(label, label)


def insurer_aliases(text: Any) -> set[str]:
    label = label_key(text)
    canonical = canonical_insurer_key(text)
    aliases = {label, canonical}
    if canonical == "old mutual":
        aliases.add("uapom")
    if label == "uapom":
        aliases.add("old mutual")
    return {alias for alias in aliases if alias}


CURACEL_BASE_URL = norm(os.getenv("CURACEL_PORTAL_BASE_URL")) or "https://health.curacel.co"
CURACEL_AUTH_BASE_URL = norm(os.getenv("CURACEL_AUTH_BASE_URL")) or "https://auth.curacel.co"
PORTAL_ENVIRONMENT = norm(os.getenv("CURACEL_PORTAL_ENVIRONMENT")) or "production"
SLACK_PRISM_BOT_TOKEN = norm(os.getenv("SLACK_PRISM_BOT_TOKEN")) or norm(os.getenv("SLACK_BOT_TOKEN"))
SLACK_ALERTS_CHANNEL_ID = norm(os.getenv("SLACK_ALERTS_CHANNEL_ID"))


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


def parse_synced_claims(value: Any) -> int:
    text = norm(value)
    match = re.search(r"(\d+)\s+synced", text, re.IGNORECASE)
    if match:
        return safe_int(match.group(1), 0)
    return 0


def chunked(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def projected_finish_minutes(hours: float) -> int:
    try:
        return max(0, math.ceil(float(hours) * 60))
    except Exception:
        return 0


def default_speed_for_role(role: str) -> float:
    return 35.0 if norm(role).lower() == "primary" else 20.0


def role_capacity_weight(role: str, support_capacity_ratio: float | int | None) -> float:
    ratio = float(support_capacity_ratio or 1)
    if norm(role).lower() == "support":
        return min(max(ratio, 0.25), 1.0)
    return max(ratio, 1.0)


def role_selection_penalty_hours(role: str, support_capacity_ratio: float | int | None) -> float:
    if norm(role).lower() != "support":
        return 0.0
    ratio = min(max(float(support_capacity_ratio or 0.6), 0.25), 1.0)
    return max(0.35, (1.0 - ratio) * 1.5)


def smoothed_claims_per_hour(
    role: str,
    observed_speed: float,
    previous_speed: float = 0.0,
    *,
    claims_completed: int = 0,
    span_hours: float = 0.0,
    snapshot_count: int = 0,
) -> float:
    default_speed = default_speed_for_role(role)
    baseline = previous_speed if previous_speed > 0 else default_speed
    if observed_speed <= 0:
        return round(baseline, 2)

    confidence = 0.65
    if claims_completed < 25 or span_hours < 2 or snapshot_count < 3:
        confidence = 0.35

    blended = (baseline * (1.0 - confidence)) + (observed_speed * confidence)
    return round(max(blended, 1.0), 2)


def parse_iso_datetime(value: Any) -> datetime | None:
    text = norm(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except Exception:
        return None


def parse_clock_minutes(value: Any) -> int | None:
    text = norm(value)
    if not text:
        return None
    match = re.match(r"^(\d{1,2}):(\d{2})$", text)
    if not match:
        return None
    hour = safe_int(match.group(1), -1)
    minute = safe_int(match.group(2), -1)
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return (hour * 60) + minute


def format_clock_label(value: Any) -> str:
    minutes = parse_clock_minutes(value)
    if minutes is None:
        return norm(value) or "—"
    hour = minutes // 60
    minute = minutes % 60
    return f"{hour:02d}:{minute:02d}"


def parse_month_labels(raw_value: str | None) -> list[str]:
    text = norm(raw_value)
    if not text:
        return [datetime.now().strftime("%b")]
    labels = []
    for part in text.split(","):
        label = norm(part)
        if not label:
            continue
        if label.lower() == "all":
            return ["All"]
        if label in MONTH_OPTIONS and label not in labels:
            labels.append(label)
    return labels or [datetime.now().strftime("%b")]


def slack_mention(slack_user_id: str, fallback_name: str) -> str:
    return f"<@{slack_user_id}>" if norm(slack_user_id) else (fallback_name or "Team")


def slack_post_message(
    token: str,
    channel: str,
    text: str,
    blocks: list[dict[str, Any]] | None = None,
    thread_ts: str | None = None,
) -> dict[str, Any]:
    response = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        json={
            "channel": channel,
            "text": text,
            **({"blocks": blocks} if blocks else {}),
            **({"thread_ts": thread_ts} if thread_ts else {}),
        },
        timeout=20,
    )
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(f"Slack API error: {data.get('error', 'unknown_error')}")
    return data


def create_assignment_thread(
    scope_label: str,
    portal_environment: str,
    assigned_piles: int,
    assigned_claims: int,
    reassigned_piles: int,
    reassigned_claims: int,
    insurer_names: list[str] | None = None,
) -> str | None:
    if not (SLACK_PRISM_BOT_TOKEN and SLACK_ALERTS_CHANNEL_ID):
        return None

    total_piles = assigned_piles + reassigned_piles
    total_claims = assigned_claims + reassigned_claims
    insurer_names = [name for name in (insurer_names or []) if norm(name)]
    insurer_count = len({name.lower(): name for name in insurer_names})
    insurer_summary = (
        f"*{insurer_count} insurer(s)* touched"
        if insurer_count
        else "*0 insurer(s)* touched"
    )
    header_lines = [
        f"🤖 *Piles Auto-Assignment Update*",
        f"*{scope_label}* on the *{portal_environment}* portal",
        f"*{total_piles} pile(s)* • *{total_claims} claims* processed",
        insurer_summary,
        f"New assignments: *{assigned_piles}* pile(s) / *{assigned_claims}* claims",
        f"Reassignments: *{reassigned_piles}* pile(s) / *{reassigned_claims}* claims",
        "_See thread below for each owner summary._",
    ]
    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "\n".join(header_lines),
            },
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"📅 {datetime.now().strftime('%b %d, %Y at %I:%M %p')}",
                }
            ],
        },
    ]
    try:
        result = slack_post_message(
            SLACK_PRISM_BOT_TOKEN,
            SLACK_ALERTS_CHANNEL_ID,
            text=f"Piles Auto-Assignment Update: {scope_label} • {total_piles} pile(s)",
            blocks=blocks,
        )
        return str(result.get("ts") or "")
    except Exception as exc:
        print(f"\n⚠️ Slack thread creation failed for {scope_label}: {exc}")
        return None


def send_assignment_owner_reply(owner_items: list["NotificationItem"], thread_ts: str) -> bool:
    if not (SLACK_PRISM_BOT_TOKEN and SLACK_ALERTS_CHANNEL_ID and thread_ts):
        return False
    if not owner_items:
        return False

    owner_name = owner_items[0].owner_name or owner_items[0].actual_assignee_name or "Team"
    owner_slack_user_id = owner_items[0].owner_slack_user_id
    owner_mention = slack_mention(owner_slack_user_id, owner_name)

    grouped: dict[str, dict[str, Any]] = {}
    for item in owner_items:
        insurer_name = item.plan.insurer_name or "Unknown insurer"
        insurer_group = grouped.setdefault(
            insurer_name,
            {
                "assigned_piles": 0,
                "assigned_claims": 0,
                "reassigned_piles": 0,
                "reassigned_claims": 0,
                "bots": set(),
                "months": set(),
                "providers": set(),
                "statuses": set(),
                "previous_owners": set(),
            },
        )
        insurer_group["bots"].add(item.bot_name or item.actual_assignee_name)
        insurer_group["months"].add(item.plan.claim_month or item.plan.filter_month or "Unknown")
        if norm(item.plan.provider):
            insurer_group["providers"].add(item.plan.provider)
        if norm(item.plan.status_bucket):
            insurer_group["statuses"].add(item.plan.status_bucket)
        if item.kind == "reassignment":
            insurer_group["reassigned_piles"] += 1
            insurer_group["reassigned_claims"] += item.plan.claims
            if norm(item.previous_owner_name):
                insurer_group["previous_owners"].add(item.previous_owner_name)
        else:
            insurer_group["assigned_piles"] += 1
            insurer_group["assigned_claims"] += item.plan.claims

    total_assigned_piles = sum(group["assigned_piles"] for group in grouped.values())
    total_assigned_claims = sum(group["assigned_claims"] for group in grouped.values())
    total_reassigned_piles = sum(group["reassigned_piles"] for group in grouped.values())
    total_reassigned_claims = sum(group["reassigned_claims"] for group in grouped.values())

    header_lines = [
        f"👤 *{owner_mention}*",
        f"New assignments: *{total_assigned_piles}* pile(s) / *{total_assigned_claims}* claims",
        f"Reassignments: *{total_reassigned_piles}* pile(s) / *{total_reassigned_claims}* claims",
    ]

    detail_lines: list[str] = []
    for insurer_name in sorted(grouped.keys()):
        group = grouped[insurer_name]
        insurer_bits = [
            f"• *{insurer_name}*",
            f"{group['assigned_piles']} new pile(s) / {group['assigned_claims']} claims",
        ]
        if group["reassigned_piles"]:
            insurer_bits.append(
                f"{group['reassigned_piles']} reassigned pile(s) / {group['reassigned_claims']} claims"
            )
        detail_lines.append("  " + " • ".join(insurer_bits))

        meta_parts = []
        if group["bots"]:
            meta_parts.append("Bot(s): " + ", ".join(sorted(group["bots"])))
        if group["months"]:
            meta_parts.append("Month(s): " + ", ".join(sorted(group["months"])))
        if group["statuses"]:
            meta_parts.append("Status: " + ", ".join(sorted(group["statuses"])))
        if group["providers"]:
            provider_preview = sorted(group["providers"])
            shown = ", ".join(provider_preview[:3])
            if len(provider_preview) > 3:
                shown += f" +{len(provider_preview) - 3} more"
            meta_parts.append("Providers: " + shown)
        if group["previous_owners"]:
            meta_parts.append("Moved from: " + ", ".join(sorted(group["previous_owners"])))
        if meta_parts:
            detail_lines.append("    " + "  •  ".join(meta_parts))

    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "\n".join(header_lines + [""] + detail_lines),
            },
        }
    ]
    try:
        slack_post_message(
            SLACK_PRISM_BOT_TOKEN,
            SLACK_ALERTS_CHANNEL_ID,
            text=(
                f"Piles Auto-Assignment owner summary: {owner_name} • "
                f"{total_assigned_piles + total_reassigned_piles} pile(s)"
            ),
            blocks=blocks,
            thread_ts=thread_ts,
        )
        return True
    except Exception as exc:
        print(f"   ⚠️ Slack owner summary failed for {owner_name}: {exc}")
        return False


def send_external_assignment_alert(
    items: list["ExternalNotificationItem"],
    portal_environment: str,
    run_source: str,
) -> bool:
    if not (SLACK_PRISM_BOT_TOKEN and SLACK_ALERTS_CHANNEL_ID):
        return False
    if not items:
        return False

    insurer_count = len({norm(item.insurer_name).lower() for item in items if norm(item.insurer_name)})
    header_lines = [
        "⚠️ *Externally Assigned Piles Detected*",
        f"*{len(items)} pile(s)* were already assigned when scanned on the *{portal_environment}* portal.",
        f"Detected during a *{run_source or 'manual'}* run across *{insurer_count} insurer(s)*.",
        "_These piles were not assigned by the runner, so they are being logged separately for review._",
        "",
    ]
    detail_lines: list[str] = []
    for item in items:
        owner_text = slack_mention(item.owner_slack_user_id, item.owner_name) if norm(item.owner_name) else "Unmapped owner"
        line = (
            f"• *{item.insurer_name}* — {owner_text} — *{item.current_assigned or 'Unknown assignee'}* — "
            f"{item.claims} claims"
        )
        meta_parts = []
        if norm(item.provider):
            meta_parts.append(f"Provider: {item.provider}")
        if norm(item.claim_month):
            meta_parts.append(f"Month: {item.claim_month}")
        if norm(item.status_bucket):
            meta_parts.append(f"Status: {item.status_bucket}")
        if item.remaining_claims > 0:
            meta_parts.append(f"Remaining: {item.remaining_claims}")
        detail_lines.append(line)
        if meta_parts:
            detail_lines.append("  " + " • ".join(meta_parts))

    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "\n".join(header_lines + detail_lines),
            },
        }
    ]
    try:
        slack_post_message(
            SLACK_PRISM_BOT_TOKEN,
            SLACK_ALERTS_CHANNEL_ID,
            text=f"Externally assigned piles detected: {len(items)} pile(s)",
            blocks=blocks,
        )
        return True
    except Exception as exc:
        print(f"\n⚠️ Slack external-assignment alert failed: {exc}")
        return False


def insurer_env_key(insurer_name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", norm(insurer_name).upper()).strip("_")


def configure_portal_environment(portal_environment: str) -> str:
    global CURACEL_BASE_URL, PORTAL_ENVIRONMENT

    selected = norm(portal_environment).lower() or "production"
    if selected not in {"production", "test"}:
        selected = "production"

    if selected == "test":
        CURACEL_BASE_URL = (
            norm(os.getenv("CURACEL_PORTAL_BASE_URL_TEST"))
            or norm(os.getenv("CURACEL_PORTAL_BASE_URL"))
            or "https://dev.claims.curacel.co"
        )
    else:
        CURACEL_BASE_URL = (
            norm(os.getenv("CURACEL_PORTAL_BASE_URL_PRODUCTION"))
            or "https://health.curacel.co"
        )

    override_suffixes = ("_EMAIL", "_PASSWORD")
    generic_override_keys = [
        key for key in os.environ.keys()
        if key.startswith("CURACEL_OVERRIDE_") and key.endswith(override_suffixes)
    ]
    for key in generic_override_keys:
        os.environ.pop(key, None)

    if selected == "test":
        for key, value in list(os.environ.items()):
            if not key.startswith("CURACEL_TEST_OVERRIDE_") or not key.endswith(override_suffixes):
                continue
            mapped_key = key.replace("CURACEL_TEST_OVERRIDE_", "CURACEL_OVERRIDE_", 1)
            os.environ[mapped_key] = value

    PORTAL_ENVIRONMENT = selected
    os.environ["CURACEL_PORTAL_ENVIRONMENT"] = selected
    os.environ["CURACEL_PORTAL_BASE_URL"] = CURACEL_BASE_URL
    return selected


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
    try:
        result = subprocess.run(
            ["node", str(script), "decrypt", raw],
            capture_output=True,
            text=True,
            env=os.environ.copy(),
            check=True,
        )
    except subprocess.CalledProcessError as error:
        stderr = norm(error.stderr)
        stdout = norm(error.stdout)
        detail = stderr or stdout or f"exit status {error.returncode}"
        raise RuntimeError(f"Credential decrypt failed: {detail}") from error
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
    active_from_time: str
    active_to_time: str
    shift_grace_minutes: int
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
    tracking_key: str
    provider: str
    claims: int
    synced_claims: int
    remaining_claims: int
    month: str
    submitted_date: str
    status: str
    assigned: str
    status_bucket: str
    page_number: int
    assignment_type: str
    filter_month: str


def unique_unassigned_rows(rows: list["PileRow"]) -> list["PileRow"]:
    seen = set()
    unique_rows: list[PileRow] = []
    for row in rows:
        if norm(row.assigned):
            continue
        if row.key in seen:
            continue
        seen.add(row.key)
        unique_rows.append(row)
    return unique_rows


@dataclass
class PlannedAssignment:
    pile_key: str
    tracking_key: str
    assignee_id: str
    assignee_name: str
    assignment_type: str
    insurer_name: str
    provider: str
    claim_month: str
    submitted_date: str
    claims: int
    synced_claims: int
    remaining_claims: int
    current_status: str
    status_bucket: str
    filter_month: str


@dataclass
class PortalAssignee:
    name: str
    assignment_role: str
    support_capacity_ratio: float
    priority_order: int


@dataclass
class AppliedAssignment:
    plan: PlannedAssignment
    actual_assignee_name: str
    matched_planned_assignee: bool
    verified_on_table: bool
    observed_assigned_values: list[str]


@dataclass
class RowSelectionResult:
    count: int
    selected_keys: list[str]


@dataclass
class TrackedPile:
    id: str
    master_account_id: str
    bot_account_id: str
    insurer_name: str
    tracking_key: str
    last_pile_key: str
    provider: str
    claim_month: str
    submitted_date: str
    claims_total: int
    synced_claims: int
    remaining_claims: int
    assignment_type: str
    current_status: str
    current_status_bucket: str
    current_assigned: str
    filter_month: str
    first_assigned_at: str
    assigned_at: str
    first_seen_at: str
    last_seen_at: str
    last_progress_at: str
    last_reassigned_at: str
    completed_at: str
    is_active: bool
    is_stale: bool
    stale_reason: str
    details: dict[str, Any]


@dataclass
class ExternalAssignment:
    id: str
    master_account_id: str
    bot_account_id: str
    insurer_name: str
    tracking_key: str
    last_pile_key: str
    provider: str
    claim_month: str
    submitted_date: str
    claims_total: int
    synced_claims: int
    remaining_claims: int
    assignment_type: str
    current_status: str
    current_status_bucket: str
    current_assigned: str
    owner_name: str
    first_detected_at: str
    last_seen_at: str
    notification_sent_at: str
    cleared_at: str
    is_active: bool
    details: dict[str, Any]


@dataclass
class NotificationItem:
    kind: str
    plan: PlannedAssignment
    actual_assignee_name: str
    owner_name: str
    owner_slack_user_id: str
    bot_name: str
    previous_owner_name: str = ""
    previous_owner_slack_user_id: str = ""
    previous_assignee_name: str = ""


@dataclass
class ExternalNotificationItem:
    insurer_name: str
    provider: str
    claims: int
    remaining_claims: int
    claim_month: str
    status_bucket: str
    current_assigned: str
    owner_name: str
    owner_slack_user_id: str


def group_notification_items_by_owner(items: list[NotificationItem]) -> list[list[NotificationItem]]:
    grouped: dict[str, list[NotificationItem]] = {}
    for item in items:
        owner_key = (
            norm(item.owner_slack_user_id).lower()
            or norm(item.owner_name).lower()
            or norm(item.actual_assignee_name).lower()
            or "unassigned"
        )
        grouped.setdefault(owner_key, []).append(item)

    ordered_groups = sorted(
        grouped.values(),
        key=lambda owner_items: (
            (owner_items[0].owner_name or owner_items[0].actual_assignee_name or "").lower(),
            owner_items[0].owner_slack_user_id.lower(),
        ),
    )
    return ordered_groups


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
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select id, insurer_name, login_email, login_password, is_active
                from piles_auto_assignment_master_accounts
                """
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases][:1]
        else:
            rows = [
                row for row in self._fetchall_supabase("piles_auto_assignment_master_accounts")
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ][:1]
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

    def get_active_master_accounts(self) -> list[MasterAccount]:
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select id, insurer_name, login_email, login_password, is_active
                from piles_auto_assignment_master_accounts
                where coalesce(is_active, true) = true
                order by insurer_name asc
                """
            )
        else:
            rows = self._fetchall_supabase(
                "piles_auto_assignment_master_accounts",
                filters=[("is_active", "eq", "true")],
                order="insurer_name.asc",
            )
        accounts: list[MasterAccount] = []
        for row in rows:
            login_email, login_password = override_master_credentials(
                row["insurer_name"],
                decrypt_credential(row["login_email"]),
                decrypt_credential(row.get("login_password")),
            )
            accounts.append(MasterAccount(
                id=str(row["id"]),
                insurer_name=norm(row["insurer_name"]),
                login_email=login_email,
                login_password=login_password,
                is_active=bool(row.get("is_active", True)),
            ))
        return accounts

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
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_bot_accounts
                order by priority_order asc, owner_name asc
                """
            )
            return [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
        else:
            rows = self._fetchall_supabase(
                "piles_auto_assignment_bot_accounts",
                order="priority_order.asc",
            )
            return [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases]

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
                active_from_time=norm(row.get("active_from_time") or "09:00"),
                active_to_time=norm(row.get("active_to_time")),
                shift_grace_minutes=safe_int(row.get("shift_grace_minutes"), 120),
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
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_rules
                """
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases][:1]
        else:
            rows = [
                row for row in self._fetchall_supabase("piles_auto_assignment_rules")
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ][:1]
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

    def get_team_slack_map(self) -> dict[str, dict[str, str]]:
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select id, name, display_name, slack_user_id, active, is_active
                from team_members
                order by name asc
                """
            )
        else:
            rows = self._fetchall_supabase("team_members", order="name.asc")

        mapping: dict[str, dict[str, str]] = {}
        for row in rows:
            is_active = bool(row.get("active", True)) or bool(row.get("is_active", True))
            if not is_active:
                continue
            info = {
                "name": norm(row.get("name")),
                "display_name": norm(row.get("display_name")),
                "slack_user_id": norm(row.get("slack_user_id")),
            }
            for key in {info["name"].lower(), info["display_name"].lower()}:
                if key:
                    mapping[key] = info
        return mapping

    def get_active_tracked_piles(self, insurer_name: str) -> list[TrackedPile]:
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_tracked_piles
                where coalesce(is_active, true) = true
                order by assigned_at asc, provider asc
                """
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
        else:
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_tracked_piles",
                    filters=[("is_active", "eq", "true")],
                    order="assigned_at.asc",
                )
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ]
        return self._rows_to_tracked_piles(rows)

    def get_all_tracked_tracking_keys(self, insurer_name: str) -> set[str]:
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select tracking_key
                     , insurer_name
                from piles_auto_assignment_tracked_piles
                """
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
        else:
            rows = [
                row for row in self._fetchall_supabase("piles_auto_assignment_tracked_piles")
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ]
        return {norm(row.get("tracking_key")) for row in rows if norm(row.get("tracking_key"))}

    def _rows_to_tracked_piles(self, rows: list[dict[str, Any]]) -> list[TrackedPile]:
        tracked: list[TrackedPile] = []
        for row in rows:
            details = row.get("details") or {}
            if isinstance(details, str):
                try:
                    details = json.loads(details)
                except Exception:
                    details = {}
            tracked.append(TrackedPile(
                id=str(row["id"]),
                master_account_id=norm(row.get("master_account_id")),
                bot_account_id=norm(row.get("bot_account_id")),
                insurer_name=norm(row["insurer_name"]),
                tracking_key=norm(row["tracking_key"]),
                last_pile_key=norm(row.get("last_pile_key")),
                provider=norm(row.get("provider")),
                claim_month=norm(row.get("claim_month")),
                submitted_date=norm(row.get("submitted_date")),
                claims_total=safe_int(row.get("claims_total"), 0),
                synced_claims=safe_int(row.get("synced_claims"), 0),
                remaining_claims=safe_int(row.get("remaining_claims"), 0),
                assignment_type=norm(row.get("assignment_type") or "Vetting"),
                current_status=norm(row.get("current_status")),
                current_status_bucket=norm(row.get("current_status_bucket")),
                current_assigned=norm(row.get("current_assigned")),
                filter_month=norm(row.get("filter_month")),
                first_assigned_at=norm(row.get("first_assigned_at")),
                assigned_at=norm(row.get("assigned_at")),
                first_seen_at=norm(row.get("first_seen_at")),
                last_seen_at=norm(row.get("last_seen_at")),
                last_progress_at=norm(row.get("last_progress_at")),
                last_reassigned_at=norm(row.get("last_reassigned_at")),
                completed_at=norm(row.get("completed_at")),
                is_active=bool(row.get("is_active", True)),
                is_stale=bool(row.get("is_stale", False)),
                stale_reason=norm(row.get("stale_reason")),
                details=details if isinstance(details, dict) else {},
            ))
        return tracked

    def save_tracked_assignment(
        self,
        master_account_id: str,
        plan: PlannedAssignment,
        actual_assignee_name: str,
        bot_account_id: str,
        reassigned: bool = False,
    ) -> TrackedPile:
        now_iso = datetime.now(timezone.utc).isoformat()
        existing = None
        rows = []
        aliases = insurer_aliases(plan.insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_tracked_piles
                where tracking_key = %s
                """,
                (plan.tracking_key,),
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases][:1]
        else:
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_tracked_piles",
                    filters=[("tracking_key", "eq", plan.tracking_key)],
                )
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ][:1]
        if rows:
            existing = self._rows_to_tracked_piles(rows)[0]

        details = {
            "source": "runner",
            "last_assignment_type": plan.assignment_type,
        }

        if existing:
            payload = {
                "master_account_id": master_account_id or None,
                "bot_account_id": bot_account_id or None,
                "last_pile_key": plan.pile_key,
                "provider": plan.provider,
                "claim_month": plan.claim_month,
                "submitted_date": plan.submitted_date,
                "claims_total": plan.claims,
                "synced_claims": plan.synced_claims,
                "remaining_claims": plan.remaining_claims,
                "assignment_type": plan.assignment_type,
                "current_status": plan.current_status,
                "current_status_bucket": plan.status_bucket,
                "current_assigned": actual_assignee_name,
                "filter_month": plan.filter_month,
                "assigned_at": now_iso,
                "last_seen_at": now_iso,
                "last_progress_at": existing.last_progress_at or now_iso,
                "last_reassigned_at": now_iso if reassigned or (existing.bot_account_id and existing.bot_account_id != bot_account_id) else (existing.last_reassigned_at or None),
                "completed_at": None,
                "is_active": True,
                "is_stale": False,
                "stale_reason": None,
                "details": details,
                "updated_at": now_iso,
            }
            if self.mode == "postgres":
                self._execute_postgres(
                    """
                    update piles_auto_assignment_tracked_piles
                    set master_account_id = %s,
                        bot_account_id = %s,
                        last_pile_key = %s,
                        provider = %s,
                        claim_month = %s,
                        submitted_date = %s,
                        claims_total = %s,
                        synced_claims = %s,
                        remaining_claims = %s,
                        assignment_type = %s,
                        current_status = %s,
                        current_status_bucket = %s,
                        current_assigned = %s,
                        filter_month = %s,
                        assigned_at = %s,
                        last_seen_at = %s,
                        last_progress_at = coalesce(last_progress_at, %s),
                        last_reassigned_at = %s,
                        completed_at = null,
                        is_active = true,
                        is_stale = false,
                        stale_reason = null,
                        details = %s::jsonb,
                        updated_at = now()
                    where id = %s
                    """,
                    (
                        payload["master_account_id"],
                        payload["bot_account_id"],
                        payload["last_pile_key"],
                        payload["provider"],
                        payload["claim_month"],
                        payload["submitted_date"],
                        payload["claims_total"],
                        payload["synced_claims"],
                        payload["remaining_claims"],
                        payload["assignment_type"],
                        payload["current_status"],
                        payload["current_status_bucket"],
                        payload["current_assigned"],
                        payload["filter_month"],
                        payload["assigned_at"],
                        payload["last_seen_at"],
                        now_iso,
                        payload["last_reassigned_at"],
                        json.dumps(payload["details"]),
                        existing.id,
                    ),
                )
            else:
                self._update_supabase("piles_auto_assignment_tracked_piles", "id", existing.id, payload)
            tracked_id = existing.id
        else:
            payload = {
                "id": str(uuid.uuid4()),
                "master_account_id": master_account_id or None,
                "bot_account_id": bot_account_id or None,
                "insurer_name": plan.insurer_name,
                "tracking_key": plan.tracking_key,
                "last_pile_key": plan.pile_key,
                "provider": plan.provider,
                "claim_month": plan.claim_month,
                "submitted_date": plan.submitted_date,
                "claims_total": plan.claims,
                "synced_claims": plan.synced_claims,
                "remaining_claims": plan.remaining_claims,
                "assignment_type": plan.assignment_type,
                "current_status": plan.current_status,
                "current_status_bucket": plan.status_bucket,
                "current_assigned": actual_assignee_name,
                "filter_month": plan.filter_month,
                "first_assigned_at": now_iso,
                "assigned_at": now_iso,
                "first_seen_at": now_iso,
                "last_seen_at": now_iso,
                "last_progress_at": now_iso if plan.synced_claims > 0 else None,
                "last_reassigned_at": now_iso if reassigned else None,
                "completed_at": None,
                "is_active": True,
                "is_stale": False,
                "stale_reason": None,
                "details": details,
            }
            if self.mode == "postgres":
                self._execute_postgres(
                    """
                    insert into piles_auto_assignment_tracked_piles
                    (id, master_account_id, bot_account_id, insurer_name, tracking_key, last_pile_key, provider, claim_month, submitted_date, claims_total, synced_claims, remaining_claims, assignment_type, current_status, current_status_bucket, current_assigned, filter_month, first_assigned_at, assigned_at, first_seen_at, last_seen_at, last_progress_at, last_reassigned_at, completed_at, is_active, is_stale, stale_reason, details)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        payload["id"], payload["master_account_id"], payload["bot_account_id"], payload["insurer_name"], payload["tracking_key"],
                        payload["last_pile_key"], payload["provider"], payload["claim_month"], payload["submitted_date"], payload["claims_total"],
                        payload["synced_claims"], payload["remaining_claims"], payload["assignment_type"], payload["current_status"], payload["current_status_bucket"],
                        payload["current_assigned"], payload["filter_month"], payload["first_assigned_at"], payload["assigned_at"], payload["first_seen_at"],
                        payload["last_seen_at"], payload["last_progress_at"], payload["last_reassigned_at"], payload["completed_at"], payload["is_active"],
                        payload["is_stale"], payload["stale_reason"], json.dumps(payload["details"]),
                    ),
                )
            else:
                self._insert_supabase("piles_auto_assignment_tracked_piles", payload)
            tracked_id = payload["id"]

        return self.get_tracked_pile_by_id(tracked_id)

    def get_tracked_pile_by_id(self, tracked_id: str) -> TrackedPile:
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                "select * from piles_auto_assignment_tracked_piles where id = %s limit 1",
                (tracked_id,),
            )
        else:
            rows = self._fetchall_supabase("piles_auto_assignment_tracked_piles", filters=[("id", "eq", tracked_id)])
        if not rows:
            raise RuntimeError(f"Tracked pile '{tracked_id}' not found.")
        return self._rows_to_tracked_piles(rows)[0]

    def update_tracked_pile_observation(
        self,
        tracked: TrackedPile,
        observed_row: PileRow | None,
        bot_account_id: str,
        current_assigned: str,
        status: str,
        status_bucket: str,
        completed: bool,
        progress_claims: int,
        stale_reason: str | None = None,
    ) -> TrackedPile:
        now_iso = datetime.now(timezone.utc).isoformat()
        claims_total = observed_row.claims if observed_row else tracked.claims_total
        synced_claims = observed_row.synced_claims if observed_row else tracked.claims_total
        remaining_claims = observed_row.remaining_claims if observed_row else 0
        payload = {
            "bot_account_id": bot_account_id or None,
            "last_pile_key": observed_row.key if observed_row else tracked.last_pile_key,
            "claims_total": claims_total,
            "synced_claims": synced_claims,
            "remaining_claims": remaining_claims,
            "current_status": status,
            "current_status_bucket": status_bucket,
            "current_assigned": current_assigned,
            "last_seen_at": now_iso,
            "last_progress_at": now_iso if progress_claims > 0 else (tracked.last_progress_at or None),
            "completed_at": now_iso if completed else None,
            "is_active": not completed,
            "is_stale": bool(stale_reason) and not completed,
            "stale_reason": stale_reason,
            "updated_at": now_iso,
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                update piles_auto_assignment_tracked_piles
                set bot_account_id = %s,
                    last_pile_key = %s,
                    claims_total = %s,
                    synced_claims = %s,
                    remaining_claims = %s,
                    current_status = %s,
                    current_status_bucket = %s,
                    current_assigned = %s,
                    last_seen_at = %s,
                    last_progress_at = %s,
                    completed_at = %s,
                    is_active = %s,
                    is_stale = %s,
                    stale_reason = %s,
                    updated_at = now()
                where id = %s
                """,
                (
                    payload["bot_account_id"],
                    payload["last_pile_key"],
                    payload["claims_total"],
                    payload["synced_claims"],
                    payload["remaining_claims"],
                    payload["current_status"],
                    payload["current_status_bucket"],
                    payload["current_assigned"],
                    payload["last_seen_at"],
                    payload["last_progress_at"],
                    payload["completed_at"],
                    payload["is_active"],
                    payload["is_stale"],
                    payload["stale_reason"],
                    tracked.id,
                ),
            )
        else:
            self._update_supabase("piles_auto_assignment_tracked_piles", "id", tracked.id, payload)
        return self.get_tracked_pile_by_id(tracked.id)

    def record_tracked_snapshot(
        self,
        tracked: TrackedPile,
        observed_row: PileRow | None,
        bot_account_id: str,
        progress_claims: int,
        completed: bool,
    ) -> None:
        observed_at = datetime.now(timezone.utc).isoformat()
        payload = {
            "id": str(uuid.uuid4()),
            "tracked_pile_id": tracked.id,
            "insurer_name": tracked.insurer_name,
            "bot_account_id": bot_account_id or None,
            "tracking_key": tracked.tracking_key,
            "pile_key": observed_row.key if observed_row else tracked.last_pile_key,
            "provider": tracked.provider,
            "claims_total": observed_row.claims if observed_row else tracked.claims_total,
            "synced_claims": observed_row.synced_claims if observed_row else tracked.claims_total,
            "remaining_claims": observed_row.remaining_claims if observed_row else 0,
            "progress_claims": progress_claims,
            "status": observed_row.status if observed_row else (tracked.current_status or "completed"),
            "status_bucket": observed_row.status_bucket if observed_row else tracked.current_status_bucket,
            "assigned": observed_row.assigned if observed_row else tracked.current_assigned,
            "is_completed": completed,
            "observed_at": observed_at,
            "details": {
                "source": "runner_reconcile",
            },
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                insert into piles_auto_assignment_pile_snapshots
                (id, tracked_pile_id, insurer_name, bot_account_id, tracking_key, pile_key, provider, claims_total, synced_claims, remaining_claims, progress_claims, status, status_bucket, assigned, is_completed, observed_at, details)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    payload["id"], payload["tracked_pile_id"], payload["insurer_name"], payload["bot_account_id"], payload["tracking_key"],
                    payload["pile_key"], payload["provider"], payload["claims_total"], payload["synced_claims"], payload["remaining_claims"],
                    payload["progress_claims"], payload["status"], payload["status_bucket"], payload["assigned"], payload["is_completed"],
                    payload["observed_at"], json.dumps(payload["details"]),
                ),
            )
        else:
            self._insert_supabase("piles_auto_assignment_pile_snapshots", payload)

    def _rows_to_external_assignments(self, rows: list[dict[str, Any]]) -> list[ExternalAssignment]:
        assignments: list[ExternalAssignment] = []
        for row in rows:
            details = row.get("details") or {}
            if isinstance(details, str):
                try:
                    details = json.loads(details)
                except Exception:
                    details = {}
            assignments.append(ExternalAssignment(
                id=str(row["id"]),
                master_account_id=norm(row.get("master_account_id")),
                bot_account_id=norm(row.get("bot_account_id")),
                insurer_name=norm(row.get("insurer_name")),
                tracking_key=norm(row.get("tracking_key")),
                last_pile_key=norm(row.get("last_pile_key")),
                provider=norm(row.get("provider")),
                claim_month=norm(row.get("claim_month")),
                submitted_date=norm(row.get("submitted_date")),
                claims_total=safe_int(row.get("claims_total"), 0),
                synced_claims=safe_int(row.get("synced_claims"), 0),
                remaining_claims=safe_int(row.get("remaining_claims"), 0),
                assignment_type=norm(row.get("assignment_type") or "Vetting"),
                current_status=norm(row.get("current_status")),
                current_status_bucket=norm(row.get("current_status_bucket")),
                current_assigned=norm(row.get("current_assigned")),
                owner_name=norm(row.get("owner_name")),
                first_detected_at=norm(row.get("first_detected_at")),
                last_seen_at=norm(row.get("last_seen_at")),
                notification_sent_at=norm(row.get("notification_sent_at")),
                cleared_at=norm(row.get("cleared_at")),
                is_active=bool(row.get("is_active", True)),
                details=details if isinstance(details, dict) else {},
            ))
        return assignments

    def save_external_assignment(
        self,
        master_account_id: str,
        insurer_name: str,
        row: PileRow,
        matched_bot: BotAccount | None = None,
    ) -> tuple[ExternalAssignment, bool]:
        now_iso = datetime.now(timezone.utc).isoformat()
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_external_assignments
                where tracking_key = %s
                """,
                (row.tracking_key,),
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases][:1]
        else:
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_external_assignments",
                    filters=[("tracking_key", "eq", row.tracking_key)],
                )
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ][:1]
        existing = self._rows_to_external_assignments(rows)[0] if rows else None
        details = {
            "source": "runner_detected_external_assignment",
            "assigned_name": row.assigned,
            "status_bucket": row.status_bucket,
            "owner_name": matched_bot.owner_name if matched_bot else "",
        }
        payload = {
            "master_account_id": master_account_id or None,
            "bot_account_id": matched_bot.id if matched_bot else None,
            "insurer_name": insurer_name,
            "tracking_key": row.tracking_key,
            "last_pile_key": row.key,
            "provider": row.provider,
            "claim_month": row.month,
            "submitted_date": row.submitted_date,
            "claims_total": row.claims,
            "synced_claims": row.synced_claims,
            "remaining_claims": row.remaining_claims,
            "assignment_type": row.assignment_type,
            "current_status": row.status,
            "current_status_bucket": row.status_bucket,
            "current_assigned": row.assigned,
            "owner_name": matched_bot.owner_name if matched_bot else "",
            "last_seen_at": now_iso,
            "notification_sent_at": existing.notification_sent_at if existing else now_iso,
            "cleared_at": None,
            "is_active": True,
            "details": details,
            "updated_at": now_iso,
        }
        if existing:
            if self.mode == "postgres":
                self._execute_postgres(
                    """
                    update piles_auto_assignment_external_assignments
                    set master_account_id = %s,
                        bot_account_id = %s,
                        last_pile_key = %s,
                        provider = %s,
                        claim_month = %s,
                        submitted_date = %s,
                        claims_total = %s,
                        synced_claims = %s,
                        remaining_claims = %s,
                        assignment_type = %s,
                        current_status = %s,
                        current_status_bucket = %s,
                        current_assigned = %s,
                        owner_name = %s,
                        last_seen_at = %s,
                        cleared_at = null,
                        is_active = true,
                        details = %s::jsonb,
                        updated_at = now()
                    where id = %s
                    """,
                    (
                        payload["master_account_id"],
                        payload["bot_account_id"],
                        payload["last_pile_key"],
                        payload["provider"],
                        payload["claim_month"],
                        payload["submitted_date"],
                        payload["claims_total"],
                        payload["synced_claims"],
                        payload["remaining_claims"],
                        payload["assignment_type"],
                        payload["current_status"],
                        payload["current_status_bucket"],
                        payload["current_assigned"],
                        payload["owner_name"],
                        payload["last_seen_at"],
                        json.dumps(payload["details"]),
                        existing.id,
                    ),
                )
            else:
                self._update_supabase("piles_auto_assignment_external_assignments", "id", existing.id, payload)
            tracked_id = existing.id
            is_new = False
        else:
            record_id = str(uuid.uuid4())
            payload = {
                "id": record_id,
                **payload,
                "first_detected_at": now_iso,
            }
            if self.mode == "postgres":
                self._execute_postgres(
                    """
                    insert into piles_auto_assignment_external_assignments
                    (id, master_account_id, bot_account_id, insurer_name, tracking_key, last_pile_key, provider, claim_month, submitted_date, claims_total, synced_claims, remaining_claims, assignment_type, current_status, current_status_bucket, current_assigned, owner_name, first_detected_at, last_seen_at, notification_sent_at, cleared_at, is_active, details)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        payload["id"], payload["master_account_id"], payload["bot_account_id"], payload["insurer_name"],
                        payload["tracking_key"], payload["last_pile_key"], payload["provider"], payload["claim_month"],
                        payload["submitted_date"], payload["claims_total"], payload["synced_claims"], payload["remaining_claims"],
                        payload["assignment_type"], payload["current_status"], payload["current_status_bucket"], payload["current_assigned"],
                        payload["owner_name"], payload["first_detected_at"], payload["last_seen_at"], payload["notification_sent_at"],
                        payload["cleared_at"], payload["is_active"], json.dumps(payload["details"]),
                    ),
                )
            else:
                self._insert_supabase("piles_auto_assignment_external_assignments", payload)
            tracked_id = record_id
            is_new = True

        if self.mode == "postgres":
            final_rows = self._fetchall_postgres(
                "select * from piles_auto_assignment_external_assignments where id = %s limit 1",
                (tracked_id,),
            )
        else:
            final_rows = self._fetchall_supabase(
                "piles_auto_assignment_external_assignments",
                filters=[("id", "eq", tracked_id)],
            )
        return self._rows_to_external_assignments(final_rows)[0], is_new

    def sync_external_assignments_for_insurer(self, insurer_name: str, active_tracking_keys: set[str]) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select id, tracking_key
                     , insurer_name
                from piles_auto_assignment_external_assignments
                where coalesce(is_active, true) = true
                """
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
        else:
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_external_assignments",
                    filters=[("is_active", "eq", "true")],
                )
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ]
        for row in rows:
            tracking_key = norm(row.get("tracking_key"))
            if tracking_key in active_tracking_keys:
                continue
            if self.mode == "postgres":
                self._execute_postgres(
                    """
                    update piles_auto_assignment_external_assignments
                    set is_active = false,
                        cleared_at = coalesce(cleared_at, %s),
                        updated_at = now()
                    where id = %s
                    """,
                    (now_iso, row["id"]),
                )
            else:
                self._update_supabase(
                    "piles_auto_assignment_external_assignments",
                    "id",
                    str(row["id"]),
                    {
                        "is_active": False,
                        "cleared_at": now_iso,
                        "updated_at": now_iso,
                    },
                )

    def refresh_bot_metrics_from_tracking(
        self,
        insurer_name: str,
        bots: list[BotAccount],
        previous_metrics: dict[str, BotMetric],
        window_hours: int = 24,
    ) -> dict[str, BotMetric]:
        bot_ids = [bot.id for bot in bots]
        if not bot_ids:
            return {}
        aliases = insurer_aliases(insurer_name)

        if self.mode == "postgres":
            snapshot_rows = self._fetchall_postgres(
                """
                select bot_account_id, progress_claims, observed_at, insurer_name
                from piles_auto_assignment_pile_snapshots
                where bot_account_id = any(%s)
                  and observed_at >= (now() - (%s || ' hours')::interval)
                order by observed_at asc
                """,
                (bot_ids, str(window_hours)),
            )
            snapshot_rows = [row for row in snapshot_rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
            active_rows = self._fetchall_postgres(
                """
                select bot_account_id, remaining_claims, insurer_name
                from piles_auto_assignment_tracked_piles
                where coalesce(is_active, true) = true
                  and bot_account_id = any(%s)
                """,
                (bot_ids,),
            )
            active_rows = [row for row in active_rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
        else:
            snapshot_rows = [
                row for row in self._fetchall_supabase("piles_auto_assignment_pile_snapshots")
                if canonical_insurer_key(row.get("insurer_name")) in aliases and str(row.get("bot_account_id") or "") in bot_ids
            ]
            cutoff = datetime.now(timezone.utc).timestamp() - (window_hours * 3600)
            snapshot_rows = [
                row for row in snapshot_rows
                if datetime.fromisoformat(str(row.get("observed_at")).replace("Z", "+00:00")).timestamp() >= cutoff
            ]
            active_rows = [
                row for row in self._fetchall_supabase("piles_auto_assignment_tracked_piles")
                if canonical_insurer_key(row.get("insurer_name")) in aliases and bool(row.get("is_active", True)) and str(row.get("bot_account_id") or "") in bot_ids
            ]

        grouped_snapshots: dict[str, list[dict[str, Any]]] = {}
        for row in snapshot_rows:
            grouped_snapshots.setdefault(str(row.get("bot_account_id") or ""), []).append(row)

        active_loads: dict[str, int] = {}
        for row in active_rows:
            bot_id = str(row.get("bot_account_id") or "")
            active_loads[bot_id] = active_loads.get(bot_id, 0) + safe_int(row.get("remaining_claims"), 0)

        refreshed: dict[str, BotMetric] = {}
        for bot in bots:
            bot_rows = sorted(
                grouped_snapshots.get(bot.id, []),
                key=lambda row: str(row.get("observed_at") or ""),
            )
            claims_completed = sum(max(0, safe_int(row.get("progress_claims"), 0)) for row in bot_rows)
            span_hours = 0.0
            if len(bot_rows) >= 2:
                try:
                    first = datetime.fromisoformat(str(bot_rows[0].get("observed_at")).replace("Z", "+00:00"))
                    last = datetime.fromisoformat(str(bot_rows[-1].get("observed_at")).replace("Z", "+00:00"))
                    span_hours = max((last - first).total_seconds() / 3600, 0.0)
                except Exception:
                    span_hours = 0.0
            hours_logged = max(span_hours, 1.0) if claims_completed > 0 else span_hours
            previous = previous_metrics.get(bot.id)
            previous_speed = previous.claims_per_hour if previous else 0.0
            observed_speed = round(claims_completed / max(hours_logged, 1.0), 2) if claims_completed > 0 else 0.0
            claims_per_hour = previous_speed
            if claims_completed > 0:
                claims_per_hour = smoothed_claims_per_hour(
                    bot.assignment_role,
                    observed_speed,
                    previous_speed,
                    claims_completed=claims_completed,
                    span_hours=span_hours,
                    snapshot_count=len(bot_rows),
                )
            elif previous_speed <= 0:
                claims_per_hour = default_speed_for_role(bot.assignment_role)
            active_claim_load = active_loads.get(bot.id, 0)
            details = {
                "source": "tracked_pile_reconcile",
                "window_hours": window_hours,
                "snapshot_count": len(bot_rows),
                "observed_claims_per_hour": observed_speed,
            }

            if self.mode == "postgres":
                self._execute_postgres(
                    """
                    insert into piles_auto_assignment_bot_metrics
                    (id, bot_account_id, metric_window, claims_completed, hours_logged, claims_per_hour, active_claim_load, projected_finish_at, details, observed_at, updated_at)
                    values (%s, %s, 'rolling_24h', %s, %s, %s, %s,
                            case when %s > 0 then now() + ((%s / %s) * interval '1 hour') else null end,
                            %s::jsonb, now(), now())
                    on conflict (bot_account_id) do update
                    set metric_window = excluded.metric_window,
                        claims_completed = excluded.claims_completed,
                        hours_logged = excluded.hours_logged,
                        claims_per_hour = excluded.claims_per_hour,
                        active_claim_load = excluded.active_claim_load,
                        projected_finish_at = excluded.projected_finish_at,
                        details = excluded.details,
                        observed_at = excluded.observed_at,
                        updated_at = excluded.updated_at
                    """,
                    (
                        str(uuid.uuid4()),
                        bot.id,
                        claims_completed,
                        hours_logged,
                        claims_per_hour,
                        active_claim_load,
                        claims_per_hour,
                        active_claim_load,
                        claims_per_hour if claims_per_hour > 0 else 1,
                        json.dumps(details),
                    ),
                )
            else:
                existing_rows = self._fetchall_supabase("piles_auto_assignment_bot_metrics", filters=[("bot_account_id", "eq", bot.id)])
                payload = {
                    "bot_account_id": bot.id,
                    "metric_window": "rolling_24h",
                    "claims_completed": claims_completed,
                    "hours_logged": hours_logged,
                    "claims_per_hour": claims_per_hour,
                    "active_claim_load": active_claim_load,
                    "projected_finish_at": None,
                    "details": details,
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                if existing_rows:
                    self._update_supabase("piles_auto_assignment_bot_metrics", "bot_account_id", bot.id, payload)
                else:
                    payload["id"] = str(uuid.uuid4())
                    self._insert_supabase("piles_auto_assignment_bot_metrics", payload)

            self.update_bot_current_load(bot.id, active_claim_load)
            refreshed[bot.id] = BotMetric(
                bot_account_id=bot.id,
                claims_per_hour=claims_per_hour,
                active_claim_load=active_claim_load,
            )
        return refreshed

    def log_assignment(
        self,
        plan: PlannedAssignment,
        execute: bool,
        actual_assignee_name: str,
        planned_assignee: BotAccount | None = None,
        verified_on_table: bool = False,
        observed_assigned_values: list[str] | None = None,
        event_type_override: str | None = None,
    ) -> None:
        planned_name = planned_assignee.portal_name if planned_assignee else ""
        matched_planned = bool(planned_assignee and label_key(actual_assignee_name) == label_key(planned_name))
        event_type = event_type_override or ("assignment_planned" if not execute else "assignment")
        status = "planned" if not execute else "assigned"
        if event_type_override == "reassignment":
            status = "reassigned" if execute else "reassignment_planned"
        payload = {
            "id": str(uuid.uuid4()),
            "bot_account_id": planned_assignee.id if matched_planned and planned_assignee else None,
            "insurer_name": plan.insurer_name,
            "event_type": event_type,
            "source": "runner",
            "status": status,
            "assigned_by": "piles_auto_assignment_runner",
            "pile_count": 1,
            "claim_count": plan.claims,
            "details": {
                "pile_key": plan.pile_key,
                "assignment_type": plan.assignment_type,
                "status_bucket": plan.status_bucket,
                "assignee_name": actual_assignee_name,
                "planned_assignee_name": planned_name or None,
                "matched_planned_assignee": matched_planned,
                "verified_on_table": verified_on_table,
                "observed_assigned_values": observed_assigned_values or [],
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

    def create_runner_run(
        self,
        *,
        insurer_name: str,
        run_scope: str,
        portal_environment: str,
        backend: str,
        run_source: str,
        months: list[str],
        year: str,
        mode: str,
        details: dict[str, Any],
    ) -> str:
        run_id = str(uuid.uuid4())
        payload = {
            "id": run_id,
            "insurer_name": insurer_name or None,
            "run_scope": run_scope,
            "portal_environment": portal_environment,
            "backend": backend,
            "run_source": run_source,
            "months": months,
            "year": year,
            "mode": mode,
            "status": "started",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "details": details,
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                insert into piles_auto_assignment_runner_runs
                (id, insurer_name, run_scope, portal_environment, backend, run_source, months, year, mode, status, started_at, details)
                values (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    payload["id"],
                    payload["insurer_name"],
                    payload["run_scope"],
                    payload["portal_environment"],
                    payload["backend"],
                    payload["run_source"],
                    json.dumps(payload["months"]),
                    payload["year"],
                    payload["mode"],
                    payload["status"],
                    payload["started_at"],
                    json.dumps(payload["details"]),
                ),
            )
        else:
            self._insert_supabase("piles_auto_assignment_runner_runs", payload)
        return run_id

    def finalize_runner_run(
        self,
        run_id: str,
        *,
        status: str,
        started_at: datetime,
        stdout: str,
        stderr: str,
        details: dict[str, Any],
    ) -> None:
        finished_at = datetime.now(timezone.utc)
        payload = {
            "status": status,
            "finished_at": finished_at.isoformat(),
            "duration_ms": max(int((finished_at - started_at).total_seconds() * 1000), 0),
            "stdout": stdout,
            "stderr": stderr,
            "details": details,
            "updated_at": finished_at.isoformat(),
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                update piles_auto_assignment_runner_runs
                set status = %s,
                    finished_at = %s,
                    duration_ms = %s,
                    stdout = %s,
                    stderr = %s,
                    details = %s::jsonb,
                    updated_at = %s
                where id = %s
                """,
                (
                    payload["status"],
                    payload["finished_at"],
                    payload["duration_ms"],
                    payload["stdout"],
                    payload["stderr"],
                    json.dumps(payload["details"]),
                    payload["updated_at"],
                    run_id,
                ),
            )
        else:
            self._update_supabase("piles_auto_assignment_runner_runs", "id", run_id, payload)

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

    def update_bot_current_load(self, bot_id: str, new_load: int) -> None:
        payload = {
            "current_claim_load": new_load,
            "updated_at": datetime.utcnow().isoformat(),
        }
        if self.mode == "postgres":
            self._execute_postgres(
                """
                update piles_auto_assignment_bot_accounts
                set current_claim_load = %s,
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

    def _ensure_playwright_browsers(self) -> None:
        print("Playwright browser binary is missing. Installing chromium runtime into the configured browser path...")
        env = os.environ.copy()
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium", "chromium-headless-shell"],
            env=env,
            check=True,
        )

    def __enter__(self) -> "CuracelPilesRunner":
        self.playwright = sync_playwright().start()
        try:
            self.browser = self.playwright.chromium.launch(headless=not self.visible, slow_mo=self.slow_mo)
        except Exception as error:
            message = str(error)
            if "Executable doesn't exist" not in message:
                raise
            self._ensure_playwright_browsers()
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

    def _goto_with_soft_readiness(self, url: str, timeout_ms: int = 45000) -> None:
        assert self.page
        self.page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        try:
            self.page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            # Some production pages keep background requests open; that should not block the runner.
            pass

    def _wait_for_piles_page_ready(self, timeout_ms: int = 30000) -> None:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000)
        while time.time() < deadline:
            try:
                if "/hmo/piles" not in self.page.url:
                    time.sleep(0.25)
                    continue

                try:
                    self._dismiss_popup()
                except Exception:
                    pass

                visible_selects = self._visible_selects()
                any_select = self.page.locator(".p-select.p-component, [role='combobox']").count() > 0
                has_table = self.page.locator("table").count() > 0
                has_no_data = self.page.locator("text=No data found").count() > 0
                has_filter_button = (
                    self.page.locator("button:has-text('Filters'), button:has-text('Filter')").count() > 0
                )
                has_filter_labels = (
                    self.page.locator("text=Filter by Vetting Status, text=Select Month, text=Month, text=Year").count() > 0
                )
                ready_state = self.page.evaluate("document.readyState")

                if visible_selects or any_select or has_table or has_no_data or has_filter_button or has_filter_labels:
                    return
                if ready_state == "complete":
                    return
            except Exception:
                pass
            time.sleep(0.4)
        raise RuntimeError("Piles page loaded too slowly; the filter controls/table never became ready.")

    def _first_visible_locator(self, selectors: list[str], timeout_ms: int = 0) -> Any | None:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000) if timeout_ms > 0 else time.time()
        while True:
            for selector in selectors:
                try:
                    locator = self.page.locator(selector).first
                    if locator.count() and locator.is_visible():
                        return locator
                except Exception:
                    continue
            if timeout_ms <= 0 or time.time() >= deadline:
                return None
            time.sleep(0.25)

    def _wait_for_login_or_app_ready(self, timeout_ms: int = 20000) -> str:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000)
        while time.time() < deadline:
            try:
                self._dismiss_popup()
            except Exception:
                pass
            try:
                if "/hmo/" in self.page.url:
                    return "app"
                if self._first_visible_locator([".p-select.p-component", "button:has-text('Enter Account')", "a:has-text('Enter Account')"]):
                    return "app"
                login_input = self._first_visible_locator(
                    [
                        'input[name="loginId"]',
                        'input[type="email"]',
                        'input[name="email"]',
                        'input[placeholder*="Email"]',
                        'input[placeholder*="email"]',
                        'input[placeholder*="Username"]',
                        'input[placeholder*="username"]',
                    ]
                )
                password_input = self._first_visible_locator(
                    [
                        'input[name="password"]',
                        'input[type="password"]',
                    ]
                )
                if login_input and password_input:
                    return "login"
            except Exception:
                pass
            time.sleep(0.35)
        raise RuntimeError("Login page did not become ready.")

    def login(self, username: str, password: str) -> None:
        assert self.page
        last_error: Exception | None = None
        target_urls = [CURACEL_BASE_URL, CURACEL_AUTH_BASE_URL]
        for attempt in range(1, 4):
            try:
                target_url = target_urls[min(attempt - 1, len(target_urls) - 1)]
                self._goto_with_soft_readiness(target_url)
                ready_state = self._wait_for_login_or_app_ready(timeout_ms=20000)
                if ready_state == "app":
                    self._dismiss_popup()
                    return

                login_input = self._first_visible_locator(
                    [
                        'input[name="loginId"]',
                        'input[type="email"]',
                        'input[name="email"]',
                        'input[placeholder*="Email"]',
                        'input[placeholder*="email"]',
                        'input[placeholder*="Username"]',
                        'input[placeholder*="username"]',
                    ],
                    timeout_ms=5000,
                )
                password_input = self._first_visible_locator(
                    [
                        'input[name="password"]',
                        'input[type="password"]',
                    ],
                    timeout_ms=5000,
                )
                submit_button = self._first_visible_locator(
                    [
                        'input[type="Submit"]',
                        'button[type="submit"]',
                        "button:has-text('Login')",
                        "button:has-text('Sign in')",
                        "button:has-text('Log in')",
                    ],
                    timeout_ms=3000,
                )
                if login_input is None or password_input is None or submit_button is None:
                    raise RuntimeError("Login form fields did not become available.")

                login_input.fill(username)
                password_input.fill(password)
                submit_button.click()
                time.sleep(4)
                self._dismiss_popup()
                post_state = self._wait_for_login_or_app_ready(timeout_ms=15000)
                if post_state == "app":
                    return
                raise RuntimeError("Login failed; still on auth page.")
            except Exception as error:
                last_error = error
                if attempt < 3:
                    print(f"  Login page was not ready yet. Retrying login flow ({attempt + 1}/3)...")
                    try:
                        self.page.reload(wait_until="domcontentloaded", timeout=45000)
                    except Exception:
                        pass
                    time.sleep(2)
                    continue
        raise last_error or RuntimeError("Login failed.")

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
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                self._goto_with_soft_readiness(f"{CURACEL_BASE_URL}/hmo/piles")
                self._wait_for_piles_page_ready()
                time.sleep(1)
                self._dismiss_popup()
                return
            except Exception as error:
                last_error = error
                if attempt < 2:
                    print("  Piles page was slow to get ready. Retrying the page open...")
                    try:
                        self.page.reload(wait_until="domcontentloaded", timeout=45000)
                    except Exception:
                        pass
                    time.sleep(2)
                    continue
                raise last_error

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

    def _describe_visible_selects(self) -> list[dict[str, Any]]:
        descriptions: list[dict[str, Any]] = []
        for idx, loc in enumerate(self._visible_selects(), start=1):
            try:
                box = loc.bounding_box() or {}
                descriptions.append({
                    "index": idx,
                    "x": round(box.get("x", 0), 1),
                    "y": round(box.get("y", 0), 1),
                    "text": self._read_select_text(loc),
                })
            except Exception:
                continue
        return descriptions

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

    def _select_following_label_text(self, label_text: str) -> Any | None:
        assert self.page
        xpath = (
            f"xpath=//*[normalize-space(text())='{label_text}']"
            "/following::*[contains(@class,'p-select') and contains(@class,'p-component')][1]"
        )
        try:
            locs = self.page.locator(xpath)
            for idx in range(locs.count()):
                loc = locs.nth(idx)
                if not loc.is_visible():
                    continue
                box = loc.bounding_box()
                if box and box["y"] < 520:
                    return loc
        except Exception:
            pass
        return None

    def _choose_option_from_open_dropdown(self, desired_text: str) -> str | None:
        assert self.page
        panels = self._visible_dropdown_panels()
        option_root = panels[-1] if panels else self.page
        options = option_root.locator("li.p-select-option, .p-select-option, [role='option']")
        option_texts: list[tuple[str, Any]] = []
        for idx in range(options.count()):
            option = options.nth(idx)
            text = norm(option.inner_text())
            if text:
                option_texts.append((text, option))
            if label_key(text) == label_key(desired_text):
                option.click(force=True)
                time.sleep(0.8)
                return text
        if self.allow_test_any_assignee:
            for text, option in option_texts:
                lowered = text.lower()
                if lowered in {"select user", "no results found", "all"}:
                    continue
                option.click(force=True)
                time.sleep(0.8)
                print(f"  Test fallback: selected available assignee '{text}' instead of requested '{desired_text}'.")
                return text
        return None

    def _wait_for_dropdown_options(self, timeout_ms: int = 4000) -> None:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000)
        while time.time() < deadline:
            try:
                if self.page.locator(".p-select-option, .p-select-list li, [role='option']").count() > 0:
                    return
                if self.page.locator("input[placeholder*='Search'], input[placeholder*='search']").count() > 0:
                    return
            except Exception:
                pass
            time.sleep(0.2)

    def _open_select(self, select: Any) -> bool:
        assert self.page
        try:
            select.click()
        except Exception:
            try:
                label = select.locator("[role='combobox'], .p-select-label").first
                if label.count() and label.is_visible():
                    label.click(force=True)
                else:
                    raise
            except Exception:
                try:
                    dropdown = select.locator(".p-select-dropdown, [data-pc-section='dropdown']").first
                    if dropdown.count() and dropdown.is_visible():
                        dropdown.click(force=True)
                    else:
                        raise
                except Exception:
                    return False
        self._wait_for_dropdown_options()
        return True

    def _dropdown_option_texts(self) -> list[str]:
        assert self.page
        panels = self._visible_dropdown_panels()
        option_root = panels[-1] if panels else self.page
        options = option_root.locator("li.p-select-option, .p-select-option, [role='option']")
        texts: list[str] = []
        for idx in range(options.count()):
            text = norm(options.nth(idx).inner_text())
            if text:
                texts.append(text)
        return texts

    def _close_dropdown(self) -> None:
        assert self.page
        try:
            self.page.keyboard.press("Escape")
        except Exception:
            pass
        time.sleep(0.2)

    def _find_select_with_options(self, expected_options: list[str]) -> Any | None:
        expected_keys = [norm_key(option) for option in expected_options if norm(option)]
        for select in self._visible_selects():
            if not self._open_select(select):
                continue
            texts = self._dropdown_option_texts()
            text_keys = [norm_key(text) for text in texts]
            if any(expected in text_keys or any(expected in key for key in text_keys) for expected in expected_keys):
                self._close_dropdown()
                return select
            self._close_dropdown()
        return None

    def _append_unique_select(self, items: list[Any], candidate: Any | None) -> None:
        if candidate is None:
            return
        try:
            box = candidate.bounding_box() or {}
            fingerprint = (
                round(box.get("x", 0), 1),
                round(box.get("y", 0), 1),
                norm(self._read_select_text(candidate)),
            )
        except Exception:
            fingerprint = (id(candidate),)
        for existing in items:
            try:
                box = existing.bounding_box() or {}
                existing_fingerprint = (
                    round(box.get("x", 0), 1),
                    round(box.get("y", 0), 1),
                    norm(self._read_select_text(existing)),
                )
            except Exception:
                existing_fingerprint = (id(existing),)
            if existing_fingerprint == fingerprint:
                return
        items.append(candidate)

    def _select_candidates_for_month(self, month_label: str) -> list[Any]:
        selects = self._visible_selects()
        candidates: list[Any] = []
        self._append_unique_select(candidates, self._find_select_with_options([month_label, "All", "Jan", "Feb", "Mar"]))
        self._append_unique_select(candidates, self._select_following_label_text("Select Month"))
        self._append_unique_select(candidates, self._select_following_label_text("Month"))
        self._append_unique_select(candidates, self._select_in_container("Select Month"))
        self._append_unique_select(candidates, self._select_by_label("Select Month"))
        self._append_unique_select(candidates, self._select_by_label("Month"))
        for select in selects:
            self._append_unique_select(candidates, select)
        return candidates

    def _select_candidates_for_status(self, month_select: Any | None) -> list[Any]:
        selects = self._visible_selects()
        candidates: list[Any] = []
        self._append_unique_select(candidates, self._find_select_with_options(TARGET_STATUSES))
        self._append_unique_select(candidates, self._select_following_label_text("Filter by Vetting Status"))
        self._append_unique_select(candidates, self._select_in_container("Filter by Vetting Status"))
        self._append_unique_select(candidates, self._select_by_label("Filter by Vetting Status"))
        for select in selects:
            if month_select is select:
                continue
            self._append_unique_select(candidates, select)
        return candidates

    def _set_select_value(self, select: Any | None, desired_text: str, required: bool = False) -> bool:
        assert self.page
        if select is None:
            if required:
                raise RuntimeError(f"Could not find select for '{desired_text}'.")
            return False
        try:
            if not self._open_select(select):
                raise RuntimeError(f"Could not open select for '{desired_text}'.")
            selected_text = self._choose_option_from_open_dropdown(desired_text)
            if not selected_text:
                available_options = self._dropdown_option_texts()
                try:
                    self.page.keyboard.press("Escape")
                except Exception:
                    pass
                if required:
                    print(f"  Failed select target: '{desired_text}'")
                    print(f"  Available dropdown options: {available_options}")
                    try:
                        print(f"  Select text before failure: '{self._read_select_text(select)}'")
                    except Exception:
                        pass
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
        last_error: Exception | None = None
        final_month_select = None
        final_status_select = None

        for attempt in range(1, 4):
            if attempt > 1:
                print(f"  Retrying filters (attempt {attempt}/3)...")
                self._dismiss_popup()
                try:
                    self.page.wait_for_load_state("domcontentloaded", timeout=10000)
                except Exception:
                    pass
                time.sleep(1.2)

            month_select = None
            for candidate in self._select_candidates_for_month(month_label):
                if self._set_select_value(candidate, month_label):
                    month_select = candidate
                    break
            if month_select is None:
                month_candidates = self._select_candidates_for_month(month_label)
                month_select = month_candidates[0] if month_candidates else None
                self._set_select_value(month_select, month_label)

            status_select = None
            for candidate in self._select_candidates_for_status(month_select):
                if self._set_select_value(candidate, status_label):
                    status_select = candidate
                    break

            if status_select is not None:
                final_month_select = month_select
                final_status_select = status_select
                break

            last_error = RuntimeError(f"Could not set filter to '{status_label}'.")
            print(f"  Visible top selects at failure: {self._describe_visible_selects()}")
            self._dismiss_popup()
            try:
                self.open_piles()
            except Exception:
                try:
                    self.page.reload(wait_until="domcontentloaded", timeout=45000)
                except Exception:
                    pass
            time.sleep(1.5)

        if final_status_select is None:
            raise last_error or RuntimeError(f"Could not set filter to '{status_label}'.")

        print(
            "  Applied filter controls:"
            f" month='{self._read_select_text(final_month_select)}'"
            f" year='{self._read_year_chip_text() or year_label}'"
            f" status='{self._read_select_text(final_status_select)}'"
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

    def rows_on_current_page(self, status_bucket: str, page_number: int, filter_month: str) -> list[PileRow]:
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
            claims_cell = value("claims", 2)
            claims = safe_int(claims_cell, 0)
            synced_claims = min(claims, parse_synced_claims(claims_cell))
            remaining_claims = max(claims - synced_claims, 0)
            month = value("month", 3)
            amount_text = value("amount", 4)
            submitted_date = value("submitted date", 6)
            row_status = value("status", 7) or status_bucket
            assigned = value("assigned", len(texts) - 2 if len(texts) >= 2 else 0)
            tracking_key = "|".join([
                norm(provider),
                str(claims),
                str(synced_claims),
                norm(amount_text),
                norm(month),
                norm(submitted_date),
            ])
            key = "|".join([
                tracking_key,
                norm(status_bucket),
            ])
            piles.append(PileRow(
                key=key,
                tracking_key=tracking_key,
                provider=provider,
                claims=claims,
                synced_claims=synced_claims,
                remaining_claims=remaining_claims,
                month=month,
                submitted_date=submitted_date,
                status=row_status,
                assigned=assigned,
                status_bucket=status_bucket,
                page_number=page_number,
                assignment_type=STATUS_ASSIGNMENT_TYPE[status_bucket],
                filter_month=filter_month,
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
            page_rows = self.rows_on_current_page(status_label, page_number, month_label)
            fingerprint = tuple(row.key for row in page_rows)
            if fingerprint in seen_pages:
                break
            seen_pages.add(fingerprint)
            piles.extend(page_rows)
            if not self.goto_next_page():
                break
            page_number += 1
        return piles

    def scan_all_unassigned(self, month_labels: list[str], year_label: str) -> list[PileRow]:
        all_rows = self.scan_all_rows(month_labels, year_label)
        seen = set()
        unassigned_rows: list[PileRow] = []
        for row in all_rows:
            if norm(row.assigned):
                continue
            if row.key in seen:
                continue
            seen.add(row.key)
            unassigned_rows.append(row)
        return unassigned_rows

    def scan_all_rows(self, month_labels: list[str], year_label: str) -> list[PileRow]:
        all_rows: list[PileRow] = []
        seen = set()
        for month_label in month_labels:
            print(f"\nScanning month: {month_label}")
            for status_label in TARGET_STATUSES:
                print(f"\nScanning status: {status_label}")
                rows = self.scan_status(month_label, year_label, status_label)
                unassigned = [row for row in rows if not norm(row.assigned)]
                print(f"  Found {len(rows)} rows, {len(unassigned)} unassigned")
                for row in rows:
                    if row.key in seen:
                        continue
                    seen.add(row.key)
                    all_rows.append(row)
        return all_rows

    def reset_to_filtered_page(self, month_label: str, year_label: str, status_label: str, page_number: int) -> list[PileRow]:
        self.open_piles()
        self.apply_filters(month_label, year_label, status_label)
        self.try_set_page_size(100)
        current_page = 1
        while current_page < page_number:
            if not self.goto_next_page():
                break
            current_page += 1
        return self.rows_on_current_page(status_label, current_page, month_label)

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

    def _assignee_matches_assigned_text(self, expected_name: str, observed_text: str) -> bool:
        expected_label = label_key(expected_name)
        observed_label = label_key(observed_text)
        if not expected_label or not observed_label:
            return False
        return expected_label == observed_label

    def _select_rows(self, pile_keys: list[str], current_rows: list[PileRow]) -> RowSelectionResult:
        assert self.page
        rows = self.page.locator("table tbody tr")
        selected = 0
        selected_keys: list[str] = []
        remaining_keys = set(pile_keys)
        for idx in range(rows.count()):
            if not remaining_keys:
                break
            row = rows.nth(idx)
            cells = row.locator("td")
            texts = [norm(cells.nth(c).inner_text()) for c in range(cells.count())]
            if "no data found" in " ".join(texts).lower():
                continue
            provider = texts[1] if len(texts) > 1 else ""
            claims_cell = texts[2] if len(texts) > 2 else "0"
            claims = safe_int(claims_cell, 0)
            synced_claims = min(claims, parse_synced_claims(claims_cell))
            month = texts[3] if len(texts) > 3 else ""
            amount_text = texts[4] if len(texts) > 4 else ""
            submitted = texts[6] if len(texts) > 6 else ""
            matched_keys: list[str] = []
            if idx < len(current_rows):
                indexed_row = current_rows[idx]
                if (
                    indexed_row.provider == provider
                    and indexed_row.claims == claims
                    and indexed_row.synced_claims == synced_claims
                    and indexed_row.month == month
                    and norm(indexed_row.key).find(norm(amount_text)) >= 0
                    and indexed_row.submitted_date == submitted
                ):
                    matched_keys.append(indexed_row.key)
            if not matched_keys:
                matched_keys = [
                    pile.key
                    for pile in current_rows
                    if pile.provider == provider
                    and pile.claims == claims
                    and pile.synced_claims == synced_claims
                    and pile.month == month
                    and pile.submitted_date == submitted
                    and norm(amount_text) in norm(pile.key)
                ]
            target_key = next((key for key in matched_keys if key in remaining_keys), None)
            if not target_key:
                continue
            try:
                checkbox = row.locator("input[type='checkbox']").first
                checkbox.check(force=True)
                selected += 1
                selected_keys.append(target_key)
                remaining_keys.discard(target_key)
            except Exception:
                try:
                    row.locator("td").first.click()
                    selected += 1
                    selected_keys.append(target_key)
                    remaining_keys.discard(target_key)
                except Exception:
                    continue
        return RowSelectionResult(count=selected, selected_keys=selected_keys)

    def verify_assigned_rows(
        self,
        month_label: str,
        year_label: str,
        status_label: str,
        pile_keys: list[str],
        expected_assignee: str,
        timeout_ms: int = 15000,
    ) -> tuple[bool, list[str]]:
        deadline = time.time() + (timeout_ms / 1000)
        last_observed: list[str] = []
        target_keys = list(dict.fromkeys(pile_keys))
        while time.time() < deadline:
            current_rows = self.scan_status(month_label, year_label, status_label)
            row_map = {row.key: row for row in current_rows if row.key in target_keys}
            last_observed = [
                row_map[key].assigned if key in row_map else "<missing>"
                for key in target_keys
            ]
            if len(row_map) == len(target_keys) and all(
                self._assignee_matches_assigned_text(expected_assignee, row_map[key].assigned)
                for key in target_keys
            ):
                return True, last_observed
            time.sleep(1)
        return False, last_observed

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

    def _visible_dropdown_panels(self) -> list[Any]:
        assert self.page
        selectors = [
            ".p-select-overlay:visible",
            ".p-dropdown-panel:visible",
            "[role='listbox']:visible",
        ]
        panels: list[tuple[float, Any]] = []
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
                    panels.append((box["y"], loc))
            except Exception:
                continue
        panels.sort(key=lambda item: item[0])
        return [item[1] for item in panels]

    def _visible_dropdown_option_texts(self) -> list[str]:
        assert self.page
        texts: list[str] = []
        for panel in self._visible_dropdown_panels()[::-1]:
            try:
                options = panel.locator(".p-select-option, .p-select-list li, [role='option']")
                for idx in range(options.count()):
                    text = norm(options.nth(idx).inner_text())
                    if not text:
                        continue
                    lowered = text.lower()
                    if lowered in {"select user", "all", "no results found"}:
                        continue
                    if text not in texts:
                        texts.append(text)
            except Exception:
                continue
        return texts

    def _wait_for_assign_user_control(self, timeout_ms: int = 7000) -> Any | None:
        deadline = time.time() + (timeout_ms / 1000)
        last_wrapper_count = 0
        last_label_count = 0
        while time.time() < deadline:
            control = self._find_assign_user_control()
            if control is not None:
                return control
            try:
                last_wrapper_count = self.page.locator(".user-select-wrapper").count()
                last_label_count = self.page.locator(
                    ".user-select-wrapper .p-select-label[role='combobox']"
                ).count()
            except Exception:
                pass
            time.sleep(0.25)
        print(
            "  Debug: assign modal visible but Select User control not found."
            f" wrappers={last_wrapper_count} comboboxes={last_label_count}"
        )
        return None

    def _find_assign_user_control(self) -> Any | None:
        assert self.page
        roots = self._visible_overlay_roots()
        dialog = roots[-1] if roots else None
        roots_to_search = [dialog] if dialog is not None else []
        roots_to_search.append(self.page)

        selectors = [
            ".user-select-wrapper .p-select-label[role='combobox'][aria-haspopup='listbox']",
            ".user-select-wrapper .p-select-label[role='combobox']",
            ".user-select-wrapper [role='combobox']",
            ".user-select-wrapper .p-select-dropdown",
            ".user-select-wrapper .p-select",
        ]
        for root in roots_to_search:
            for selector in selectors:
                try:
                    locs = root.locator(selector)
                    visible: list[tuple[float, float, Any]] = []
                    for idx in range(locs.count()):
                        loc = locs.nth(idx)
                        if not loc.is_visible():
                            continue
                        box = loc.bounding_box()
                        if not box:
                            continue
                        visible.append((box["y"], box["x"], loc))
                    if not visible:
                        continue
                    visible.sort(key=lambda item: (item[0], item[1]))
                    return visible[-1][2]
                except Exception:
                    continue
        return None

    def _open_select_control(self, control: Any) -> bool:
        assert self.page
        click_targets = [
            control,
            control.locator("xpath=ancestor-or-self::*[contains(@class,'p-select')][1]").first,
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
                deadline = time.time() + 3
                while time.time() < deadline:
                    try:
                        expanded = norm(control.get_attribute("aria-expanded")).lower()
                        panels = self._visible_dropdown_panels()
                        if expanded == "true" or panels:
                            return True
                    except Exception:
                        pass
                    time.sleep(0.2)
            except Exception:
                try:
                    box = target.bounding_box()
                    if box:
                        self.page.mouse.click(box["x"] + (box["width"] / 2), box["y"] + (box["height"] / 2))
                        deadline = time.time() + 3
                        while time.time() < deadline:
                            try:
                                expanded = norm(control.get_attribute("aria-expanded")).lower()
                                panels = self._visible_dropdown_panels()
                                if expanded == "true" or panels:
                                    return True
                            except Exception:
                                pass
                            time.sleep(0.2)
                except Exception:
                    continue
        try:
            control.focus()
            self.page.keyboard.press("ArrowDown")
            deadline = time.time() + 3
            while time.time() < deadline:
                try:
                    expanded = norm(control.get_attribute("aria-expanded")).lower()
                    panels = self._visible_dropdown_panels()
                    if expanded == "true" or panels:
                        return True
                except Exception:
                    pass
                time.sleep(0.2)
        except Exception:
            pass
        return False

    def _apply_assignment_modal(self, assignment_type: str, assignee_name: str, execute: bool) -> str:
        assert self.page
        # Per current workflow, keep the assign modal on its default Vetting path.
        assignment_type = "Vetting"
        roots = self._visible_overlay_roots()
        dialog = roots[-1] if roots else None
        time.sleep(2)
        control = self._wait_for_assign_user_control()
        if control is None:
            raise RuntimeError("Could not open the Select User control inside the assign modal.")
        opened = self._open_select_control(control)
        if not opened:
            raise RuntimeError("Could not open the Select User control inside the assign modal.")
        selected_assignee = self._choose_option_from_open_dropdown(assignee_name)
        if not selected_assignee:
            available_options = self._visible_dropdown_option_texts()
            raise RuntimeError(
                f"Could not choose assignee '{assignee_name}' from the assign modal. "
                f"Visible portal options were: {available_options}"
            )

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
            verified = False
            if dialog is not None:
                try:
                    dialog.wait_for(state="hidden", timeout=10000)
                    verified = True
                except Exception:
                    pass
            if not verified:
                success_selectors = [
                    "text=Successfully",
                    "text=Assigned",
                    ".p-toast-message-success",
                    ".toast-success",
                ]
                deadline = time.time() + 10
                while time.time() < deadline:
                    try:
                        if any(self.page.locator(selector).count() > 0 for selector in success_selectors):
                            verified = True
                            break
                    except Exception:
                        pass
                    time.sleep(0.3)
            if not verified:
                raise RuntimeError(f"Assign action for '{selected_assignee}' did not show a clear portal success state.")
            self._dismiss_popup()
        else:
            print(f"  Dry run: would assign selected piles to {selected_assignee or assignee_name} as {assignment_type}.")
            try:
                self.page.keyboard.press("Escape")
            except Exception:
                pass
            time.sleep(0.5)
        return selected_assignee or assignee_name

    def discover_portal_assignees(self, month_label: str, year_label: str, sample_pile: PileRow) -> list[PortalAssignee]:
        active_month = sample_pile.filter_month or month_label
        selected = 0
        current_rows: list[PileRow] = []
        page_candidates: list[int] = []
        for page_number in [sample_pile.page_number, 1, max(1, sample_pile.page_number - 1), sample_pile.page_number + 1, 2, 3]:
            if page_number not in page_candidates:
                page_candidates.append(page_number)
        for attempt in range(3):
            for page_number in page_candidates:
                current_rows = self.reset_to_filtered_page(active_month, year_label, sample_pile.status_bucket, page_number)
                candidate_keys = [sample_pile.key]
                candidate_keys.extend([
                    row.key for row in current_rows[:12]
                    if row.key not in candidate_keys
                ])
                for candidate_key in candidate_keys:
                    selection = self._select_rows([candidate_key], current_rows)
                    selected = selection.count
                    if selected:
                        break
                if selected:
                    break
            if selected:
                break
            if attempt < 2:
                print("  Sample row could not be selected on the first try. Refreshing the filtered page and retrying...")
                time.sleep(1)
        if not selected:
            raise RuntimeError("Could not select a sample pile row to inspect the portal assignee dropdown.")
        self._open_assign_modal()
        time.sleep(2)
        control = self._wait_for_assign_user_control()
        if control is None:
            raise RuntimeError("Could not find the Select User control while discovering portal assignees.")
        opened = self._open_select_control(control)
        if not opened:
            raise RuntimeError("Could not open the Select User dropdown while discovering portal assignees.")
        option_names = self._visible_dropdown_option_texts()
        try:
            self.page.keyboard.press("Escape")
        except Exception:
            pass
        time.sleep(0.4)
        self._dismiss_popup()
        if not option_names:
            raise RuntimeError("The portal Select User dropdown opened but exposed no usable assignee options.")
        assignees: list[PortalAssignee] = []
        for idx, name in enumerate(option_names):
            assignees.append(PortalAssignee(
                name=name,
                assignment_role="primary" if idx == 0 else "support",
                support_capacity_ratio=1 if idx == 0 else 0.6,
                priority_order=idx + 1,
            ))
        return assignees

    def execute_assignment_plan(self, month_labels: list[str], year_label: str, plans: list[PlannedAssignment], execute: bool) -> tuple[dict[str, int], list[AppliedAssignment]]:
        results: dict[str, int] = {}
        applied: list[AppliedAssignment] = []
        for filter_month in month_labels:
            for status_label in TARGET_STATUSES:
                status_plans = [plan for plan in plans if plan.status_bucket == status_label and plan.filter_month == filter_month]
                if not status_plans:
                    continue
                print(f"\nApplying assignments for month/status: {filter_month} / {status_label}")
                self.open_piles()
                self.apply_filters(filter_month, year_label, status_label)
                self.try_set_page_size(100)
                page_number = 1
                seen_pages = set()
                while True:
                    current_rows = self.rows_on_current_page(status_label, page_number, filter_month)
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
                        grouped_items = list(grouped.items())
                        for group_index, ((assignee_name, assignment_type), group) in enumerate(grouped_items):
                            requested_keys = [plan.pile_key for plan in group]
                            selected_keys: list[str] = []
                            missing_keys = requested_keys[:]
                            partial_selection_detected = False

                            if group_index > 0:
                                current_rows = self.reset_to_filtered_page(filter_month, year_label, status_label, page_number)

                            selection = self._select_rows(requested_keys, current_rows)
                            if selection.selected_keys:
                                selected_keys.extend(selection.selected_keys)
                            missing_keys = [key for key in requested_keys if key not in selected_keys]
                            if missing_keys:
                                partial_selection_detected = bool(selected_keys)
                                print(
                                    f"  Partial row selection detected for '{assignee_name}' "
                                    f"in {status_label}: selected {len(selected_keys)}/{len(requested_keys)}. "
                                    "Retrying the missing piles one by one..."
                                )
                                for missing_key in missing_keys[:]:
                                    recovered = False
                                    for retry in range(3):
                                        current_rows = self.reset_to_filtered_page(filter_month, year_label, status_label, page_number)
                                        single_selection = self._select_rows([missing_key], current_rows)
                                        if single_selection.selected_keys:
                                            for key in single_selection.selected_keys:
                                                if key not in selected_keys:
                                                    selected_keys.append(key)
                                            recovered = True
                                            break
                                        time.sleep(0.6)
                                    if recovered:
                                        missing_keys = [key for key in missing_keys if key not in selected_keys]
                                        continue
                                    raise RuntimeError(
                                        f"Could not reliably select every planned pile for '{assignee_name}' "
                                        f"in status '{status_label}'. Missing pile key: {missing_key}"
                                    )

                            if not selected_keys:
                                continue

                            selected_group = [plan for plan in group if plan.pile_key in selected_keys]
                            self._open_assign_modal()
                            selected_assignee = self._apply_assignment_modal(assignment_type, assignee_name, execute)
                            verified_on_table = False
                            observed_assigned_values: list[str] = []
                            if execute:
                                verified_on_table, observed_assigned_values = self.verify_assigned_rows(
                                    filter_month,
                                    year_label,
                                    status_label,
                                    [plan.pile_key for plan in selected_group],
                                    selected_assignee,
                                )
                                if not verified_on_table:
                                    raise RuntimeError(
                                        f"Assigned column did not update to '{selected_assignee}' for "
                                        f"{len(selected_group)} verified pile(s) in status '{status_label}'. "
                                        f"Observed: {observed_assigned_values or ['<blank>']}"
                                    )
                            if partial_selection_detected:
                                print(
                                    f"  Recovered all {len(selected_group)} planned pile(s) for '{assignee_name}' "
                                    f"after retrying individual row selection."
                                )
                            results[selected_assignee] = results.get(selected_assignee, 0) + len(selected_group)
                            for plan in selected_group:
                                applied.append(AppliedAssignment(
                                    plan=plan,
                                    actual_assignee_name=selected_assignee,
                                    matched_planned_assignee=norm_key(selected_assignee) == norm_key(assignee_name),
                                    verified_on_table=verified_on_table if execute else False,
                                    observed_assigned_values=observed_assigned_values[:] if execute else [],
                                ))
                    if not self.goto_next_page():
                        break
                    page_number += 1
        return results, applied


def match_bot_to_portal_name(bots: list[BotAccount], portal_name: str) -> BotAccount | None:
    scored: list[tuple[int, int, BotAccount]] = []
    for bot in bots:
        score = portal_option_match_score(bot, portal_name)
        if score > 0:
            scored.append((score, -bot.priority_order, bot))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1]))
    return scored[0][2]


def shift_reassignment_hold(bot: BotAccount, now_utc: datetime) -> tuple[bool, str]:
    start_minutes = parse_clock_minutes(bot.active_from_time)
    if start_minutes is None:
        return False, ""

    grace_minutes = max(0, safe_int(bot.shift_grace_minutes, 120))
    local_now = now_utc.astimezone(RUNNER_TIMEZONE)
    now_minutes = (local_now.hour * 60) + local_now.minute
    end_minutes = parse_clock_minutes(bot.active_to_time)
    crosses_midnight = end_minutes is not None and end_minutes <= start_minutes

    if crosses_midnight and end_minutes is not None and now_minutes < end_minutes:
        shift_start_local = (local_now - timedelta(days=1)).replace(
            hour=start_minutes // 60,
            minute=start_minutes % 60,
            second=0,
            microsecond=0,
        )
    else:
        shift_start_local = local_now.replace(
            hour=start_minutes // 60,
            minute=start_minutes % 60,
            second=0,
            microsecond=0,
        )

    grace_ends_local = shift_start_local + timedelta(minutes=grace_minutes)
    if local_now < grace_ends_local:
        return True, (
            f"{bot.owner_name or bot.portal_name} is within shift grace until "
            f"{grace_ends_local.strftime('%H:%M')} {RUNNER_TIMEZONE.key} "
            f"(starts {format_clock_label(bot.active_from_time)}, grace {grace_minutes} mins)."
        )
    return False, ""


def is_shift_ready_for_reassignment(bot: BotAccount, now_utc: datetime) -> bool:
    hold, _ = shift_reassignment_hold(bot, now_utc)
    return not hold


def choose_best_bot_for_pile(
    pile_claims: int,
    bots: list[BotAccount],
    metrics: dict[str, BotMetric],
    exclude_bot_ids: set[str] | None = None,
    require_shift_ready: bool = False,
    now_utc: datetime | None = None,
) -> BotAccount | None:
    exclude_bot_ids = exclude_bot_ids or set()
    now_utc = now_utc or datetime.now(timezone.utc)
    eligible: list[tuple[float, float, int, int, BotAccount]] = []
    for bot in bots:
        if bot.id in exclude_bot_ids:
            continue
        if not bot.is_active or not bot.is_available or bot.availability_status not in {"available", ""}:
            continue
        if require_shift_ready and not is_shift_ready_for_reassignment(bot, now_utc):
            continue
        metric = metrics.get(bot.id)
        observed_speed = metric.claims_per_hour if metric and metric.claims_per_hour > 0 else 0
        base_speed = smoothed_claims_per_hour(bot.assignment_role, observed_speed, observed_speed)
        role_weight = role_capacity_weight(bot.assignment_role, bot.support_capacity_ratio)
        effective_speed = max(base_speed * role_weight, 1)
        current_load = metric.active_claim_load if metric else bot.current_claim_load
        projected_hours = (current_load + pile_claims) / effective_speed
        selection_score = projected_hours + role_selection_penalty_hours(bot.assignment_role, bot.support_capacity_ratio)
        eligible.append((
            selection_score,
            projected_hours,
            0 if bot.assignment_role == "primary" else 1,
            bot.priority_order,
            bot,
        ))
    if not eligible:
        return None
    eligible.sort(key=lambda item: (item[0], item[1], item[2], item[3]))
    return eligible[0][4]


def reconcile_tracked_assignments(
    store: DataStore,
    runner: CuracelPilesRunner,
    insurer_name: str,
    year_label: str,
    bots: list[BotAccount],
    previous_metrics: dict[str, BotMetric],
    rule: AssignmentRule | None,
    requested_month_labels: list[str],
) -> dict[str, Any]:
    tracked = store.get_active_tracked_piles(insurer_name)
    if not tracked:
        return {
            "tracked_count": 0,
            "completed_count": 0,
            "stale_count": 0,
            "active_count": 0,
            "stale_candidates": [],
            "metrics": previous_metrics,
        }

    months = sorted(
        {
            month for month in (
                [item.filter_month for item in tracked]
                + [item.claim_month for item in tracked]
                + requested_month_labels
            )
            if norm(month)
        },
        key=lambda month: MONTH_OPTIONS.index(month) if month in MONTH_OPTIONS else 99,
    )
    print("\nReconciling tracked assigned piles...")
    scanned_rows = runner.scan_all_rows(months or requested_month_labels, year_label)
    row_map: dict[str, PileRow] = {}
    for row in scanned_rows:
        existing = row_map.get(row.tracking_key)
        if existing is None or (not norm(existing.assigned) and norm(row.assigned)):
            row_map[row.tracking_key] = row

    now = datetime.now(timezone.utc)
    bots_by_id = {bot.id: bot for bot in bots}
    stale_candidates: list[tuple[TrackedPile, PileRow, BotAccount]] = []
    completed_count = 0
    refreshed_tracked: list[TrackedPile] = []
    for tracked_pile in tracked:
        observed = row_map.get(tracked_pile.tracking_key)
        previous_completed = max(tracked_pile.synced_claims, tracked_pile.claims_total - tracked_pile.remaining_claims)
        matched_bot = match_bot_to_portal_name(bots, observed.assigned if observed else tracked_pile.current_assigned) if (observed or tracked_pile.current_assigned) else None
        active_bot_id = matched_bot.id if matched_bot else tracked_pile.bot_account_id
        current_assignee_bot = matched_bot or bots_by_id.get(tracked_pile.bot_account_id)
        progress_claims = 0
        completed = False
        stale_reason = None

        if observed is not None:
            current_completed = max(observed.synced_claims, observed.claims - observed.remaining_claims)
            progress_claims = max(0, current_completed - previous_completed)
            completed = observed.remaining_claims <= 0
            idle_since = parse_iso_datetime(tracked_pile.last_progress_at or tracked_pile.assigned_at or tracked_pile.last_seen_at or tracked_pile.first_assigned_at)
            idle_minutes = int((now - idle_since).total_seconds() / 60) if idle_since else 0
            if (
                rule
                and not completed
                and observed.remaining_claims >= rule.stale_claim_threshold
                and idle_minutes >= rule.reassignment_threshold_minutes
            ):
                hold_reassignment = False
                hold_reason = ""
                if current_assignee_bot is not None:
                    hold_reassignment, hold_reason = shift_reassignment_hold(current_assignee_bot, now)
                if hold_reassignment:
                    stale_reason = None
                else:
                    stale_reason = f"No meaningful progress for {idle_minutes} mins with {observed.remaining_claims} claims still open."
        else:
            progress_claims = max(tracked_pile.remaining_claims, 0)
            completed = True

        updated = store.update_tracked_pile_observation(
            tracked_pile,
            observed,
            active_bot_id,
            observed.assigned if observed else tracked_pile.current_assigned,
            observed.status if observed else (tracked_pile.current_status or "completed"),
            observed.status_bucket if observed else tracked_pile.current_status_bucket,
            completed,
            progress_claims,
            stale_reason=stale_reason,
        )
        store.record_tracked_snapshot(updated, observed, active_bot_id, progress_claims, completed)
        refreshed_tracked.append(updated)
        if completed:
            completed_count += 1
        if updated.is_stale and observed is not None and matched_bot is not None:
            stale_candidates.append((updated, observed, matched_bot))

    refreshed_metrics = store.refresh_bot_metrics_from_tracking(insurer_name, bots, previous_metrics)
    active_count = len([item for item in refreshed_tracked if item.is_active])
    stale_count = len([item for item in refreshed_tracked if item.is_stale])
    return {
        "tracked_count": len(tracked),
        "completed_count": completed_count,
        "stale_count": stale_count,
        "active_count": active_count,
        "stale_candidates": stale_candidates,
        "metrics": refreshed_metrics,
        "tracked": refreshed_tracked,
    }


def detect_external_assignments(
    store: DataStore,
    master_account_id: str,
    insurer_name: str,
    rows: list[PileRow],
    bots: list[BotAccount],
    tracked_keys: set[str],
    team_slack_map: dict[str, dict[str, str]],
) -> dict[str, Any]:
    assigned_rows_by_tracking: dict[str, PileRow] = {}
    for row in rows:
        if not norm(row.assigned):
            continue
        if norm(row.tracking_key) in tracked_keys:
            continue
        existing = assigned_rows_by_tracking.get(row.tracking_key)
        if existing is None or (not norm(existing.assigned) and norm(row.assigned)):
            assigned_rows_by_tracking[row.tracking_key] = row

    notifications: list[ExternalNotificationItem] = []
    active_tracking_keys = set(assigned_rows_by_tracking.keys())
    new_detection_count = 0

    for row in assigned_rows_by_tracking.values():
        matched_bot = match_bot_to_portal_name(bots, row.assigned) if bots else None
        record, is_new = store.save_external_assignment(master_account_id, insurer_name, row, matched_bot)
        if not is_new:
            continue
        new_detection_count += 1
        owner_info = team_slack_map.get(norm(matched_bot.owner_name).lower(), {}) if matched_bot else {}
        notifications.append(ExternalNotificationItem(
            insurer_name=insurer_name,
            provider=row.provider,
            claims=row.claims,
            remaining_claims=row.remaining_claims,
            claim_month=row.month or row.filter_month,
            status_bucket=row.status_bucket,
            current_assigned=row.assigned,
            owner_name=matched_bot.owner_name if matched_bot else record.owner_name,
            owner_slack_user_id=norm(owner_info.get("slack_user_id")),
        ))
        store.log_runner_event(
            insurer_name=insurer_name,
            event_type="external_assignment_detected",
            status="detected",
            pile_count=1,
            claim_count=row.claims,
            details={
                "tracking_key": row.tracking_key,
                "pile_key": row.key,
                "provider": row.provider,
                "claim_month": row.month,
                "submitted_date": row.submitted_date,
                "claims_total": row.claims,
                "remaining_claims": row.remaining_claims,
                "status_bucket": row.status_bucket,
                "current_assigned": row.assigned,
                "owner_name": matched_bot.owner_name if matched_bot else "",
                "bot_name": matched_bot.bot_name if matched_bot else "",
                "bot_account_id": matched_bot.id if matched_bot else None,
            },
        )

    store.sync_external_assignments_for_insurer(insurer_name, active_tracking_keys)
    return {
        "active_count": len(active_tracking_keys),
        "new_detection_count": new_detection_count,
        "notifications": notifications,
    }


def build_stale_reassignment_plans(
    insurer_name: str,
    stale_candidates: list[tuple[TrackedPile, PileRow, BotAccount]],
    bots: list[BotAccount],
    metrics: dict[str, BotMetric],
    rule: AssignmentRule | None,
) -> tuple[list[PlannedAssignment], dict[str, dict[str, Any]]]:
    if not stale_candidates or not rule or rule.distribution_mode != "balanced_finish":
        return [], {}

    now_utc = datetime.now(timezone.utc)
    plans: list[PlannedAssignment] = []
    summary: dict[str, dict[str, Any]] = {}
    for tracked_pile, observed_row, current_bot in stale_candidates:
        target = choose_best_bot_for_pile(
            max(observed_row.remaining_claims, 1),
            bots,
            metrics,
            exclude_bot_ids={current_bot.id},
            require_shift_ready=True,
            now_utc=now_utc,
        )
        if target is None:
            target = choose_best_bot_for_pile(
                max(observed_row.remaining_claims, 1),
                bots,
                metrics,
                exclude_bot_ids={current_bot.id},
                require_shift_ready=False,
                now_utc=now_utc,
            )
        if target is None:
            continue

        current_metric = metrics.get(current_bot.id)
        current_observed_speed = current_metric.claims_per_hour if current_metric and current_metric.claims_per_hour > 0 else 0
        current_speed = max(
            smoothed_claims_per_hour(current_bot.assignment_role, current_observed_speed, current_observed_speed)
            * role_capacity_weight(current_bot.assignment_role, current_bot.support_capacity_ratio),
            1,
        )
        current_remaining_minutes = projected_finish_minutes((current_metric.active_claim_load if current_metric else current_bot.current_claim_load) / max(current_speed, 1))

        target_metric = metrics.get(target.id)
        target_observed_speed = target_metric.claims_per_hour if target_metric and target_metric.claims_per_hour > 0 else 0
        target_speed = max(
            smoothed_claims_per_hour(target.assignment_role, target_observed_speed, target_observed_speed)
            * role_capacity_weight(target.assignment_role, target.support_capacity_ratio),
            1,
        )
        target_projected_minutes = projected_finish_minutes(((target_metric.active_claim_load if target_metric else target.current_claim_load) + max(observed_row.remaining_claims, 1)) / max(target_speed, 1))

        if target_projected_minutes + (rule.target_completion_gap_minutes or 0) >= current_remaining_minutes:
            continue

        plans.append(PlannedAssignment(
            pile_key=observed_row.key,
            tracking_key=observed_row.tracking_key,
            assignee_id=target.id,
            assignee_name=target.portal_name,
            assignment_type=tracked_pile.assignment_type or observed_row.assignment_type,
            insurer_name=insurer_name,
            provider=observed_row.provider,
            claim_month=observed_row.month,
            submitted_date=observed_row.submitted_date,
            claims=max(observed_row.remaining_claims, 1),
            synced_claims=observed_row.synced_claims,
            remaining_claims=observed_row.remaining_claims,
            current_status=observed_row.status,
            status_bucket=observed_row.status_bucket,
            filter_month=observed_row.filter_month,
        ))

        entry = summary.setdefault(target.id, {
            "assignee_name": target.portal_name,
            "assignment_role": target.assignment_role,
            "effective_speed": round(target_speed, 2),
            "starting_claim_load": target_metric.active_claim_load if target_metric else target.current_claim_load,
            "starting_load": target_metric.active_claim_load if target_metric else target.current_claim_load,
            "assigned_piles": 0,
            "assigned_claims": 0,
            "projected_finish_hours": round(target_projected_minutes / 60, 2),
            "projected_finish_minutes": target_projected_minutes,
        })
        entry["assigned_piles"] += 1
        entry["assigned_claims"] += max(observed_row.remaining_claims, 1)

    return plans, summary


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
        base_speed = smoothed_claims_per_hour(bot.assignment_role, observed_speed, observed_speed)
        role_weight = role_capacity_weight(bot.assignment_role, bot.support_capacity_ratio)
        effective_speed = max(base_speed * role_weight, 1)
        current_load = metric.active_claim_load if metric else bot.current_claim_load
        eligible.append({
            "bot": bot,
            "effective_speed": effective_speed,
            "projected_hours": current_load / effective_speed if effective_speed else math.inf,
            "selection_penalty_hours": role_selection_penalty_hours(bot.assignment_role, bot.support_capacity_ratio),
            "selection_score": (current_load / effective_speed if effective_speed else math.inf) + role_selection_penalty_hours(bot.assignment_role, bot.support_capacity_ratio),
            "current_load": current_load,
            "starting_claim_load": current_load,
            "assigned_claims": 0,
            "assigned_piles": 0,
        })

    if not eligible:
        raise RuntimeError(f"No available bot accounts found for insurer '{insurer_name}'.")

    plans: list[PlannedAssignment] = []
    for pile in sorted(piles, key=lambda item: item.claims, reverse=True):
        chosen = min(
            eligible,
            key=lambda entry: (
                entry["selection_score"],
                entry["projected_hours"],
                entry["bot"].priority_order,
            ),
        )
        chosen["assigned_claims"] += pile.claims
        chosen["assigned_piles"] += 1
        chosen["current_load"] += pile.claims
        chosen["projected_hours"] = chosen["current_load"] / chosen["effective_speed"]
        chosen["selection_score"] = chosen["projected_hours"] + chosen["selection_penalty_hours"]
        plans.append(PlannedAssignment(
            pile_key=pile.key,
            tracking_key=pile.tracking_key,
            assignee_id=chosen["bot"].id,
            assignee_name=chosen["bot"].portal_name,
            assignment_type=pile.assignment_type,
            insurer_name=insurer_name,
            provider=pile.provider,
            claim_month=pile.month,
            submitted_date=pile.submitted_date,
            claims=pile.claims,
            synced_claims=pile.synced_claims,
            remaining_claims=pile.remaining_claims,
            current_status=pile.status,
            status_bucket=pile.status_bucket,
            filter_month=pile.filter_month,
        ))

    summary = {
        entry["bot"].id: {
            "assignee_name": entry["bot"].portal_name,
            "assignment_role": entry["bot"].assignment_role,
            "effective_speed": round(entry["effective_speed"], 2),
            "starting_claim_load": entry["starting_claim_load"],
            "starting_load": entry["starting_claim_load"],
            "assigned_piles": entry["assigned_piles"],
            "assigned_claims": entry["assigned_claims"],
            "projected_finish_hours": round(entry["projected_hours"], 2),
            "projected_finish_minutes": projected_finish_minutes(entry["projected_hours"]),
        }
        for entry in eligible
    }
    return plans, summary


def build_assignment_plan_from_portal_options(
    insurer_name: str,
    piles: list[PileRow],
    portal_assignees: list[PortalAssignee],
) -> tuple[list[PlannedAssignment], dict[str, dict[str, Any]]]:
    eligible = []
    for assignee in portal_assignees:
        base_speed = default_speed_for_role(assignee.assignment_role)
        role_weight = role_capacity_weight(assignee.assignment_role, assignee.support_capacity_ratio)
        effective_speed = max(base_speed * role_weight, 1)
        eligible.append({
            "assignee": assignee,
            "effective_speed": effective_speed,
            "projected_hours": 0,
            "selection_penalty_hours": role_selection_penalty_hours(assignee.assignment_role, assignee.support_capacity_ratio),
            "selection_score": role_selection_penalty_hours(assignee.assignment_role, assignee.support_capacity_ratio),
            "current_load": 0,
            "starting_claim_load": 0,
            "assigned_claims": 0,
            "assigned_piles": 0,
        })

    if not eligible:
        raise RuntimeError(f"No visible portal assignee options were available for insurer '{insurer_name}'.")

    plans: list[PlannedAssignment] = []
    for pile in sorted(piles, key=lambda item: item.claims, reverse=True):
        chosen = min(
            eligible,
            key=lambda entry: (
                entry["selection_score"],
                entry["projected_hours"],
                entry["assignee"].priority_order,
            ),
        )
        chosen["assigned_claims"] += pile.claims
        chosen["assigned_piles"] += 1
        chosen["current_load"] += pile.claims
        chosen["projected_hours"] = chosen["current_load"] / chosen["effective_speed"]
        chosen["selection_score"] = chosen["projected_hours"] + chosen["selection_penalty_hours"]
        plans.append(PlannedAssignment(
            pile_key=pile.key,
            tracking_key=pile.tracking_key,
            assignee_id=f"portal-option::{chosen['assignee'].name}",
            assignee_name=chosen["assignee"].name,
            assignment_type=pile.assignment_type,
            insurer_name=insurer_name,
            provider=pile.provider,
            claim_month=pile.month,
            submitted_date=pile.submitted_date,
            claims=pile.claims,
            synced_claims=pile.synced_claims,
            remaining_claims=pile.remaining_claims,
            current_status=pile.status,
            status_bucket=pile.status_bucket,
            filter_month=pile.filter_month,
        ))

    summary = {
        entry["assignee"].name: {
            "assignee_name": entry["assignee"].name,
            "assignment_role": entry["assignee"].assignment_role,
            "effective_speed": round(entry["effective_speed"], 2),
            "starting_claim_load": entry["starting_claim_load"],
            "starting_load": entry["starting_claim_load"],
            "assigned_piles": entry["assigned_piles"],
            "assigned_claims": entry["assigned_claims"],
            "projected_finish_hours": round(entry["projected_hours"], 2),
            "projected_finish_minutes": projected_finish_minutes(entry["projected_hours"]),
        }
        for entry in eligible
    }
    return plans, summary


def merge_assignment_summaries(
    base: dict[str, dict[str, Any]],
    incoming: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    merged = {key: dict(value) for key, value in (base or {}).items()}
    for key, item in (incoming or {}).items():
        if key not in merged:
            merged[key] = dict(item)
            continue
        current = merged[key]
        current["assigned_piles"] = safe_int(current.get("assigned_piles"), 0) + safe_int(item.get("assigned_piles"), 0)
        current["assigned_claims"] = safe_int(current.get("assigned_claims"), 0) + safe_int(item.get("assigned_claims"), 0)
        current["projected_finish_hours"] = item.get("projected_finish_hours", current.get("projected_finish_hours"))
        current["projected_finish_minutes"] = item.get("projected_finish_minutes", current.get("projected_finish_minutes"))
        current["effective_speed"] = item.get("effective_speed", current.get("effective_speed"))
        current["assignment_role"] = item.get("assignment_role", current.get("assignment_role"))
        current["assignee_name"] = item.get("assignee_name", current.get("assignee_name"))
        current["starting_claim_load"] = current.get("starting_claim_load", item.get("starting_claim_load", 0))
        current["starting_load"] = current.get("starting_load", item.get("starting_load", 0))
    return merged


def portal_option_match_score(bot: BotAccount, option_name: str) -> int:
    option_label = label_key(option_name)
    option_lower = norm(option_name).lower()
    candidates = [
        ("bot_name", bot.bot_name),
        ("owner_name", bot.owner_name),
        ("bot_email", bot.bot_email),
    ]
    best = 0
    for rank, (candidate_type, candidate) in enumerate(candidates):
        candidate = norm(candidate)
        if not candidate:
            continue
        candidate_label = label_key(candidate)
        candidate_lower = candidate.lower()
        bias = max(0, 4 - rank)
        if candidate_label == option_label:
            best = max(best, (1000 if candidate_type == "bot_name" else 400) + bias)
            continue
        if candidate_type == "bot_name":
            continue
        words = [word for word in candidate_lower.split() if len(word) > 2]
        if words and all(word in option_lower for word in words):
            best = max(best, 60 + bias)
    return best


def resolve_bots_to_portal_options(
    insurer_name: str,
    bots: list[BotAccount],
    portal_option_names: list[str],
) -> tuple[list[BotAccount], dict[str, str], list[str]]:
    eligible = [
        bot for bot in bots
        if bot.is_active and bot.is_available and bot.availability_status in {"available", ""}
    ]
    resolved_names: dict[str, str] = {}
    used_options: set[str] = set()
    scored_pairs: list[tuple[int, int, str, BotAccount]] = []
    options_by_label: dict[str, list[str]] = {}

    for option_name in portal_option_names:
        options_by_label.setdefault(label_key(option_name), []).append(option_name)

    for bot in eligible:
        configured_bot_name = norm(bot.bot_name)
        if not configured_bot_name:
            continue
        exact_matches = options_by_label.get(label_key(configured_bot_name), [])
        if len(exact_matches) == 1:
            resolved_names[bot.id] = exact_matches[0]
            used_options.add(exact_matches[0])
            continue
        if len(exact_matches) > 1:
            raise RuntimeError(
                f"Configured bot name '{configured_bot_name}' for insurer '{insurer_name}' matched multiple visible portal users: {exact_matches}. "
                "The runner will not guess between them."
            )

        ambiguous_matches = [
            option_name
            for option_name in portal_option_names
            if norm_key(option_name) == norm_key(configured_bot_name)
        ]
        if len(ambiguous_matches) > 1:
            raise RuntimeError(
                f"Configured bot name '{configured_bot_name}' for insurer '{insurer_name}' did not exactly match a portal user, "
                f"and multiple near-matches were visible: {ambiguous_matches}. "
                "Update the bot name in the dashboard to exactly match the portal dropdown label."
            )

    for bot in eligible:
        if bot.id in resolved_names:
            continue
        for option_name in portal_option_names:
            score = portal_option_match_score(bot, option_name)
            if score > 0:
                scored_pairs.append((score, -bot.priority_order, option_name, bot))

    for bot in eligible:
        if bot.id in resolved_names:
            continue
        candidates = [
            (score, priority, option_name)
            for score, priority, option_name, candidate_bot in scored_pairs
            if candidate_bot.id == bot.id and option_name not in used_options
        ]
        if not candidates:
            continue
        candidates.sort(key=lambda item: (-item[0], item[1], item[2].lower()))
        top_score = candidates[0][0]
        top_candidates = [item[2] for item in candidates if item[0] == top_score]
        if len(top_candidates) > 1:
            raise RuntimeError(
                f"Configured assignee '{bot.portal_name}' for insurer '{insurer_name}' matched multiple visible portal users with the same score: {top_candidates}. "
                "The runner will not guess. Update the bot name in the dashboard to exactly match one portal dropdown label."
            )
        resolved_names[bot.id] = candidates[0][2]
        used_options.add(candidates[0][2])

    unmatched = [bot.portal_name for bot in eligible if bot.id not in resolved_names]
    resolved_bots = [
        replace(bot, bot_name=resolved_names.get(bot.id, bot.bot_name))
        for bot in bots
        if bot.id in resolved_names or bot.id not in {eligible_bot.id for eligible_bot in eligible}
    ]

    if not any(bot.id in resolved_names for bot in eligible):
        raise RuntimeError(
            f"Configured bot names for insurer '{insurer_name}' did not match the real portal assignee dropdown. "
            f"Unmatched: {unmatched}. Visible portal users: {portal_option_names}"
        )

    return resolved_bots, resolved_names, unmatched


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visual Curacel Piles Auto-Assignment runner")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--insurer", help="Insurer name exactly as saved in the DB, e.g. 'Jubilee Kenya'")
    group.add_argument("--all-active", action="store_true", help="Run the workflow for every active master insurer account.")
    parser.add_argument("--portal-environment", choices=["production", "test"], default=norm(os.getenv("CURACEL_PORTAL_ENVIRONMENT")) or "production", help="Which portal configuration to use for this run.")
    parser.add_argument("--month", help="Month label(s) to filter, e.g. 'All' or 'May,Jun'. Default is current month name")
    parser.add_argument("--year", help="Year label to filter, default is current year")
    parser.add_argument("--visible", action="store_true", help="Run with a visible browser")
    parser.add_argument("--execute", action="store_true", help="Actually click Assign Claims. Default is dry-run.")
    parser.add_argument("--slow-mo", type=int, default=350, help="Playwright slow_mo in ms for visual debugging")
    parser.add_argument("--out", default="tmp/piles_auto_assignment_plan.json", help="Where to write the dry-run plan/output JSON")
    parser.add_argument("--run-source", default=norm(os.getenv("PILES_AUTO_ASSIGNMENT_RUN_SOURCE")) or "manual", help="How this run was triggered, e.g. manual or schedule.")
    parser.add_argument("--invocation-backend", default=norm(os.getenv("PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND")) or "local", help="Which compute backend launched this run, e.g. local or remote.")
    return parser.parse_args()


def run_for_insurer(
    store: DataStore,
    args: argparse.Namespace,
    insurer_name: str,
    month_labels: list[str],
    year_label: str,
    visible: bool,
) -> dict[str, Any]:
    captured_at = datetime.now(timezone.utc).isoformat()
    master = store.get_master_account(insurer_name)
    if not master.login_email or not master.login_password:
        raise RuntimeError(f"Master account for '{insurer_name}' is missing login email or password.")

    bots = store.get_bot_accounts(insurer_name)
    metrics = store.get_bot_metrics([bot.id for bot in bots])
    rule = store.get_rule(insurer_name)
    fallback_pool_used = False
    portal_assignees: list[PortalAssignee] = []
    portal_option_names: list[str] = []
    resolved_name_map: dict[str, str] = {}
    resolved_bots = bots[:]
    portal_mapping_warnings: list[str] = []
    team_slack_map = store.get_team_slack_map()
    tracked_reconcile = {
        "tracked_count": 0,
        "completed_count": 0,
        "stale_count": 0,
        "active_count": 0,
        "stale_candidates": [],
        "metrics": metrics,
        "tracked": [],
    }
    external_detection = {
        "active_count": 0,
        "new_detection_count": 0,
        "notifications": [],
    }
    late_arrival_detection = {
        "count": 0,
        "claims": 0,
        "piles": [],
        "summary": {},
        "results": {},
    }
    reassignment_plans: list[PlannedAssignment] = []
    reassignment_summary: dict[str, dict[str, Any]] = {}
    reassignment_results: dict[str, int] = {}
    reassignment_applied: list[AppliedAssignment] = []
    reassignment_previous_owner_by_tracking: dict[str, BotAccount] = {}
    slack_thread_ts = ""
    slack_replies_sent = 0

    print("=" * 72)
    print("Piles Auto-Assignment Runner")
    print(f"Insurer: {insurer_name}")
    print(f"Portal environment: {PORTAL_ENVIRONMENT}")
    print(f"Portal: {CURACEL_BASE_URL}")
    print(f"Month/Year: {', '.join(month_labels)} {year_label}")
    print(f"Mode: {'EXECUTE' if args.execute else 'DRY RUN'}")
    if rule:
        print(f"Rule mode: {rule.distribution_mode} | min chunk: {rule.minimum_claim_chunk}")
    print("=" * 72)

    with CuracelPilesRunner(visible=visible, slow_mo=args.slow_mo) as runner:
        runner.allow_test_any_assignee = False

        def ensure_portal_mapping(sample_pile: PileRow) -> None:
            nonlocal fallback_pool_used, portal_assignees, portal_option_names, resolved_name_map, resolved_bots, portal_mapping_warnings
            if portal_option_names:
                return
            portal_assignees = runner.discover_portal_assignees(sample_pile.filter_month, year_label, sample_pile)
            portal_option_names = [assignee.name for assignee in portal_assignees]
            if not bots:
                if is_test_portal(CURACEL_BASE_URL):
                    fallback_pool_used = True
                    print("Using test-portal assignee pool discovered from the real Select User dropdown:")
                    for assignee in portal_assignees:
                        print(f"  - {assignee.name}")
                    return
                raise RuntimeError(
                    f"No configured bot accounts found for insurer '{insurer_name}', and fallback assignment is blocked outside the test portal."
                )

            resolved_bots, resolved_name_map, unmatched = resolve_bots_to_portal_options(insurer_name, bots, portal_option_names)
            print("Resolved configured bot names against the real portal dropdown:")
            for bot in resolved_bots:
                if bot.id in resolved_name_map:
                    print(f"  - {bot.owner_name or bot.portal_name} -> {resolved_name_map[bot.id]}")
            if unmatched:
                warning = (
                    f"Configured bot rows missing from the live portal dropdown were excluded for this run: {unmatched}. "
                    f"Visible portal users: {portal_option_names}"
                )
                portal_mapping_warnings.append(warning)
                print(f"  Warning: {warning}")

        print("\nLogging in...")
        runner.login(master.login_email, master.login_password)
        runner.select_account(insurer_name)
        runner.open_piles()

        if bots:
            tracked_reconcile = reconcile_tracked_assignments(
                store,
                runner,
                insurer_name,
                year_label,
                bots,
                metrics,
                rule,
                month_labels,
            )
            metrics = tracked_reconcile["metrics"]
            if tracked_reconcile["tracked_count"]:
                print("\nTracked-pile reconcile summary:")
                print(
                    f"  tracked={tracked_reconcile['tracked_count']} "
                    f"active={tracked_reconcile['active_count']} "
                    f"completed={tracked_reconcile['completed_count']} "
                    f"stale={tracked_reconcile['stale_count']}"
                )

            stale_candidates = tracked_reconcile["stale_candidates"]
            if stale_candidates:
                reassignment_previous_owner_by_tracking = {
                    tracked_pile.tracking_key: current_bot
                    for tracked_pile, _, current_bot in stale_candidates
                }
                ensure_portal_mapping(stale_candidates[0][1])
                reassignment_plans, reassignment_summary = build_stale_reassignment_plans(
                    insurer_name,
                    stale_candidates,
                    resolved_bots,
                    metrics,
                    rule,
                )
                if reassignment_plans:
                    print("\nPlanned stale-pile reassignments:")
                    for item in reassignment_summary.values():
                        print(
                            f"  - {item['assignee_name']} [{item['assignment_role']}] "
                            f"piles={item['assigned_piles']} claims={item['assigned_claims']} "
                            f"projected_finish={item['projected_finish_minutes']} mins"
                        )
                    reassignment_results, reassignment_applied = runner.execute_assignment_plan(
                        month_labels,
                        year_label,
                        reassignment_plans,
                        execute=args.execute,
                    )
                    print("\nReassignment groups touched:")
                    for assignee_name, count in reassignment_results.items():
                        print(f"  - {assignee_name}: {count} pile(s)")

                    if args.execute:
                        for item in reassignment_applied:
                            planned_assignee = next((bot for bot in resolved_bots if bot.id == item.plan.assignee_id), None)
                            store.log_assignment(
                                item.plan,
                                execute=True,
                                actual_assignee_name=item.actual_assignee_name,
                                planned_assignee=planned_assignee,
                                verified_on_table=item.verified_on_table,
                                observed_assigned_values=item.observed_assigned_values,
                                event_type_override="reassignment",
                            )
                            if planned_assignee and item.matched_planned_assignee and item.verified_on_table:
                                store.save_tracked_assignment(
                                    master.id,
                                    item.plan,
                                    item.actual_assignee_name,
                                    planned_assignee.id,
                                    reassigned=True,
                                )
                    else:
                        for plan in reassignment_plans:
                            planned_assignee = next((bot for bot in resolved_bots if bot.id == plan.assignee_id), None)
                            actual_name = planned_assignee.portal_name if planned_assignee else plan.assignee_name
                            store.log_assignment(
                                plan,
                                execute=False,
                                actual_assignee_name=actual_name,
                                planned_assignee=planned_assignee,
                                event_type_override="reassignment",
                            )

                    if args.execute:
                        metrics = store.refresh_bot_metrics_from_tracking(insurer_name, resolved_bots, metrics)

        print("\nScanning pages...")
        scanned_rows = runner.scan_all_rows(month_labels, year_label)
        tracked_keys = store.get_all_tracked_tracking_keys(insurer_name)
        external_detection = detect_external_assignments(
            store,
            master.id,
            insurer_name,
            scanned_rows,
            bots,
            tracked_keys,
            team_slack_map,
        )
        if external_detection["new_detection_count"]:
            print("\nDetected externally assigned piles the runner is not tracking:")
            for item in external_detection["notifications"]:
                owner_label = item.owner_name or "Unmapped owner"
                print(
                    f"  - {item.insurer_name}: {item.current_assigned or 'Unknown assignee'} "
                    f"({owner_label}) • {item.claims} claims • {item.status_bucket or 'Unknown status'}"
                )
        unassigned = unique_unassigned_rows(scanned_rows)
        initial_unassigned_keys = {row.key for row in unassigned}
        print(f"\nTotal unassigned piles found: {len(unassigned)}")

        plans: list[PlannedAssignment] = []
        summary: dict[str, dict[str, Any]] = {}
        if unassigned:
            ensure_portal_mapping(unassigned[0])
            if not bots:
                plans, summary = build_assignment_plan_from_portal_options(insurer_name, unassigned, portal_assignees)
            else:
                plans, summary = build_assignment_plan(insurer_name, unassigned, resolved_bots, metrics)

        if summary:
            print("\nAssignment summary:")
            for item in summary.values():
                print(
                    f"  - {item['assignee_name']} [{item['assignment_role']}] "
                    f"speed={item['effective_speed']}/hr assigned={item['assigned_claims']} "
                    f"projected_finish={item['projected_finish_minutes']} mins"
                )

        output_path = ROOT / args.out
        if args.all_active:
            stem = output_path.stem
            output_path = output_path.with_name(f"{stem}-{insurer_env_key(insurer_name).lower()}{output_path.suffix}")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "insurer": insurer_name,
            "month": month_labels[0] if len(month_labels) == 1 else month_labels,
            "months": month_labels,
            "year": year_label,
            "mode": "execute" if args.execute else "dry-run",
            "captured_at": captured_at,
            "unassigned_count": len(unassigned),
            "piles": [row.__dict__ for row in unassigned],
            "reassignment_plans": [plan.__dict__ for plan in reassignment_plans],
            "plans": [plan.__dict__ for plan in plans],
            "tracked_reconcile": {
                "tracked_count": tracked_reconcile["tracked_count"],
                "completed_count": tracked_reconcile["completed_count"],
                "stale_count": tracked_reconcile["stale_count"],
                "active_count": tracked_reconcile["active_count"],
            },
            "external_detection": {
                "active_count": external_detection["active_count"],
                "new_detection_count": external_detection["new_detection_count"],
            },
            "reassignment_summary": reassignment_summary,
            "summary": summary,
            "portal_option_names": portal_option_names,
            "resolved_name_map": resolved_name_map,
            "portal_mapping_warnings": portal_mapping_warnings,
        }
        output_path.write_text(json.dumps(payload, indent=2))

        planned_scan_count = len(reassignment_plans) + len(plans)
        planned_scan_claims = sum(plan.claims for plan in reassignment_plans) + sum(plan.claims for plan in plans)

        store.log_runner_event(
            insurer_name=insurer_name,
            event_type="runner_scan",
            status="planned" if not args.execute else "ready",
            pile_count=planned_scan_count,
            claim_count=planned_scan_claims,
            details={
                "insurer_name": insurer_name,
                "mode": "execute" if args.execute else "dry-run",
                "captured_at": captured_at,
                "fallback_pool_used": fallback_pool_used,
                "month": month_labels[0] if len(month_labels) == 1 else month_labels,
                "months": month_labels,
                "year": year_label,
                "statuses": TARGET_STATUSES,
                "tracked_reconcile": {
                    "tracked_count": tracked_reconcile["tracked_count"],
                    "completed_count": tracked_reconcile["completed_count"],
                    "stale_count": tracked_reconcile["stale_count"],
                    "active_count": tracked_reconcile["active_count"],
                },
                "reassignment_summary": reassignment_summary,
                "summary": summary,
                "portal_option_names": portal_option_names,
                "resolved_name_map": resolved_name_map,
                "portal_mapping_warnings": portal_mapping_warnings,
            },
        )

        results: dict[str, int] = {}
        applied: list[AppliedAssignment] = []
        if plans:
            print("\nApplying assignment flow...")
            results, applied = runner.execute_assignment_plan(month_labels, year_label, plans, execute=args.execute)
            print("\nUI assignment groups touched:")
            for assignee_name, count in results.items():
                print(f"  - {assignee_name}: {count} pile(s)")
        elif reassignment_plans:
            print("\nNo new unassigned piles were found after tracked-pile reconciliation.")

        if args.execute and resolved_bots:
            metrics = store.refresh_bot_metrics_from_tracking(insurer_name, resolved_bots, metrics)

        print("\nFinal late-arrival rescan...")
        follow_up_rows = runner.scan_all_rows(month_labels, year_label)
        follow_up_unassigned = [
            row for row in unique_unassigned_rows(follow_up_rows)
            if row.key not in initial_unassigned_keys
        ]
        if follow_up_unassigned:
            late_arrival_detection["count"] = len(follow_up_unassigned)
            late_arrival_detection["claims"] = sum(row.claims for row in follow_up_unassigned)
            late_arrival_detection["piles"] = [row.__dict__ for row in follow_up_unassigned]
            print(
                f"Late-arrival unassigned piles detected after the first scan: "
                f"{late_arrival_detection['count']} pile(s), {late_arrival_detection['claims']} claim(s)"
            )
            ensure_portal_mapping(follow_up_unassigned[0])
            late_plans: list[PlannedAssignment]
            late_summary: dict[str, dict[str, Any]]
            if not bots:
                late_plans, late_summary = build_assignment_plan_from_portal_options(insurer_name, follow_up_unassigned, portal_assignees)
            else:
                late_plans, late_summary = build_assignment_plan(insurer_name, follow_up_unassigned, resolved_bots, metrics)
            late_arrival_detection["summary"] = late_summary
            summary = merge_assignment_summaries(summary, late_summary)
            plans.extend(late_plans)
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="late_arrival_detected",
                status="follow_up_execute" if args.execute else "follow_up_preview",
                pile_count=late_arrival_detection["count"],
                claim_count=late_arrival_detection["claims"],
                details={
                    "insurer_name": insurer_name,
                    "captured_at": captured_at,
                    "month": month_labels[0] if len(month_labels) == 1 else month_labels,
                    "months": month_labels,
                    "year": year_label,
                    "mode": "execute" if args.execute else "dry-run",
                    "late_arrivals": [row.__dict__ for row in follow_up_unassigned],
                    "follow_up_summary": late_summary,
                    "portal_option_names": portal_option_names,
                    "resolved_name_map": resolved_name_map,
                    "portal_mapping_warnings": portal_mapping_warnings,
                },
            )
            if late_summary:
                print("\nLate-arrival follow-up summary:")
                for item in late_summary.values():
                    print(
                        f"  - {item['assignee_name']} [{item['assignment_role']}] "
                        f"speed={item['effective_speed']}/hr assigned={item['assigned_claims']} "
                        f"projected_finish={item['projected_finish_minutes']} mins"
                    )
            if late_plans:
                late_results, late_applied = runner.execute_assignment_plan(month_labels, year_label, late_plans, execute=args.execute)
                late_arrival_detection["results"] = late_results
                if late_results:
                    print("\nLate-arrival follow-up groups touched:")
                    for assignee_name, count in late_results.items():
                        print(f"  - {assignee_name}: {count} pile(s)")
                for assignee_name, count in late_results.items():
                    results[assignee_name] = results.get(assignee_name, 0) + count
                applied.extend(late_applied)
                if args.execute and resolved_bots:
                    metrics = store.refresh_bot_metrics_from_tracking(insurer_name, resolved_bots, metrics)
        elif not unassigned and not reassignment_plans:
            print("No unassigned piles found. Nothing to assign.")

        payload.update({
            "plans": [plan.__dict__ for plan in plans],
            "summary": summary,
            "late_arrival_detection": late_arrival_detection,
        })
        output_path.write_text(json.dumps(payload, indent=2))

    if args.execute:
        for item in applied:
            planned_assignee = next((bot for bot in resolved_bots if bot.id == item.plan.assignee_id), None)
            store.log_assignment(
                item.plan,
                execute=True,
                actual_assignee_name=item.actual_assignee_name,
                planned_assignee=planned_assignee,
                verified_on_table=item.verified_on_table,
                observed_assigned_values=item.observed_assigned_values,
            )
            if planned_assignee and item.matched_planned_assignee and item.verified_on_table:
                store.save_tracked_assignment(
                    master.id,
                    item.plan,
                    item.actual_assignee_name,
                    planned_assignee.id,
                    reassigned=False,
                )
    else:
        for plan in plans:
            planned_assignee = next((bot for bot in resolved_bots if bot.id == plan.assignee_id), None)
            actual_name = planned_assignee.portal_name if planned_assignee else plan.assignee_name
            store.log_assignment(
                plan,
                execute=False,
                actual_assignee_name=actual_name,
                planned_assignee=planned_assignee,
            )

    notification_items: list[NotificationItem] = []
    if args.execute:
        for item in applied:
            planned_assignee = next((bot for bot in resolved_bots if bot.id == item.plan.assignee_id), None)
            owner_name = planned_assignee.owner_name if planned_assignee else item.actual_assignee_name
            owner_info = team_slack_map.get(owner_name.lower(), {})
            notification_items.append(NotificationItem(
                kind="assignment",
                plan=item.plan,
                actual_assignee_name=item.actual_assignee_name,
                owner_name=owner_name,
                owner_slack_user_id=norm(owner_info.get("slack_user_id")),
                bot_name=planned_assignee.portal_name if planned_assignee else item.actual_assignee_name,
            ))
        for item in reassignment_applied:
            planned_assignee = next((bot for bot in resolved_bots if bot.id == item.plan.assignee_id), None)
            owner_name = planned_assignee.owner_name if planned_assignee else item.actual_assignee_name
            owner_info = team_slack_map.get(owner_name.lower(), {})
            previous_bot = reassignment_previous_owner_by_tracking.get(item.plan.tracking_key)
            previous_owner_name = previous_bot.owner_name if previous_bot else ""
            previous_owner_info = team_slack_map.get(previous_owner_name.lower(), {}) if previous_owner_name else {}
            notification_items.append(NotificationItem(
                kind="reassignment",
                plan=item.plan,
                actual_assignee_name=item.actual_assignee_name,
                owner_name=owner_name,
                owner_slack_user_id=norm(owner_info.get("slack_user_id")),
                bot_name=planned_assignee.portal_name if planned_assignee else item.actual_assignee_name,
                previous_owner_name=previous_owner_name,
                previous_owner_slack_user_id=norm(previous_owner_info.get("slack_user_id")),
                previous_assignee_name=previous_bot.portal_name if previous_bot else "",
            ))

    finished_at = datetime.now(timezone.utc).isoformat()
    total_planned = len(reassignment_plans) + len(plans)
    total_claims = sum(plan.claims for plan in reassignment_plans) + sum(plan.claims for plan in plans)
    total_completed = len(reassignment_applied) + len(applied)
    total_completed_claims = sum(item.plan.claims for item in reassignment_applied) + sum(item.plan.claims for item in applied)

    store.log_runner_event(
        insurer_name=insurer_name,
        event_type="runner_complete",
        status=(
            "assigned"
            if args.execute and total_completed
            else "dry_run_complete"
            if total_planned
            else "no_work_complete"
        ),
        pile_count=total_completed if args.execute else total_planned,
        claim_count=total_completed_claims if args.execute else total_claims,
        details={
            "insurer_name": insurer_name,
            "mode": "execute" if args.execute else "dry-run",
            "captured_at": captured_at,
            "finished_at": finished_at,
            "fallback_pool_used": fallback_pool_used,
            "months": month_labels,
            "no_work": total_planned == 0,
            "message": "No unassigned piles found. Nothing to assign." if total_planned == 0 else "",
                "tracked_reconcile": {
                    "tracked_count": tracked_reconcile["tracked_count"],
                    "completed_count": tracked_reconcile["completed_count"],
                    "stale_count": tracked_reconcile["stale_count"],
                    "active_count": tracked_reconcile["active_count"],
                },
                "external_detection": {
                    "active_count": external_detection["active_count"],
                    "new_detection_count": external_detection["new_detection_count"],
                },
                "slack_thread_ts": slack_thread_ts or None,
                "slack_replies_sent": slack_replies_sent,
                "reassignment_results": reassignment_results,
                "reassignment_summary": reassignment_summary,
                "late_arrival_detection": late_arrival_detection,
            "results": results,
            "summary": summary,
            "portal_option_names": portal_option_names,
            "resolved_name_map": resolved_name_map,
            "portal_mapping_warnings": portal_mapping_warnings,
            "reassignment_assignments": [
                {
                    "pile_key": item.plan.pile_key,
                    "tracking_key": item.plan.tracking_key,
                    "status_bucket": item.plan.status_bucket,
                    "actual_assignee_name": item.actual_assignee_name,
                    "matched_planned_assignee": item.matched_planned_assignee,
                    "verified_on_table": item.verified_on_table,
                    "observed_assigned_values": item.observed_assigned_values,
                }
                for item in reassignment_applied
            ] if args.execute else [],
            "applied_assignments": [
                {
                    "pile_key": item.plan.pile_key,
                    "tracking_key": item.plan.tracking_key,
                    "status_bucket": item.plan.status_bucket,
                    "actual_assignee_name": item.actual_assignee_name,
                    "matched_planned_assignee": item.matched_planned_assignee,
                    "verified_on_table": item.verified_on_table,
                    "observed_assigned_values": item.observed_assigned_values,
                }
                for item in applied
            ] if args.execute else [],
        },
    )

    print("\nDone.")
    return {
        "insurer_name": insurer_name,
        "captured_at": captured_at,
        "tracked_reconcile": tracked_reconcile,
        "reassignment_plans": reassignment_plans,
        "reassignment_summary": reassignment_summary,
        "reassignment_results": reassignment_results,
        "reassignment_applied": reassignment_applied,
        "unassigned": unassigned,
        "plans": plans,
        "summary": summary,
        "results": results,
        "applied": applied,
        "fallback_pool_used": fallback_pool_used,
        "portal_option_names": portal_option_names,
        "resolved_name_map": resolved_name_map,
        "portal_mapping_warnings": portal_mapping_warnings,
        "notification_items": notification_items,
        "external_notification_items": external_detection["notifications"],
        "late_arrival_detection": late_arrival_detection,
    }


def main() -> None:
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    stdout_capture = TeeCapture(original_stdout)
    stderr_capture = TeeCapture(original_stderr)
    sys.stdout = stdout_capture
    sys.stderr = stderr_capture

    started_at = datetime.now(timezone.utc)
    store: DataStore | None = None
    run_id = ""
    run_details: dict[str, Any] = {}
    insurers: list[str] = []
    failures: list[tuple[str, str]] = []
    final_error: Exception | None = None
    args: argparse.Namespace | None = None
    all_notification_items: list[NotificationItem] = []
    all_external_notification_items: list[ExternalNotificationItem] = []
    slack_thread_ts = ""
    slack_replies_sent = 0
    try:
        args = parse_args()
        configure_portal_environment(args.portal_environment)
        month_labels = parse_month_labels(args.month)
        year_label = args.year or str(datetime.now().year)
        visible = args.visible or not env_bool("HEADLESS", True)

        if args.execute and not is_test_portal(CURACEL_BASE_URL) and not env_bool("ALLOW_PRODUCTION_ASSIGNMENTS", False):
            raise RuntimeError(
                "Execute mode is blocked outside the test portal. "
                "Use the dev portal, or set ALLOW_PRODUCTION_ASSIGNMENTS=true only when you intentionally want live assignments."
            )

        store = DataStore()
        insurers = [args.insurer] if args.insurer else [account.insurer_name for account in store.get_active_master_accounts()]
        if not insurers:
            raise RuntimeError("No active insurer master accounts were found to run.")

        run_details = {
            "portal_environment": PORTAL_ENVIRONMENT,
            "portal_url": CURACEL_BASE_URL,
            "months": month_labels,
            "year": year_label,
            "visible_browser": visible,
            "finalize_assignments": bool(args.execute),
            "insurers": insurers,
        }
        run_id = store.create_runner_run(
            insurer_name=args.insurer or "",
            run_scope="all-active" if args.all_active else "single",
            portal_environment=PORTAL_ENVIRONMENT,
            backend=norm(args.invocation_backend) or "local",
            run_source=norm(args.run_source) or "manual",
            months=month_labels,
            year=year_label,
            mode="execute" if args.execute else "dry-run",
            details=run_details,
        )

        for index, insurer_name in enumerate(insurers, start=1):
            if args.all_active:
                print(f"\n\n===== Running insurer {index}/{len(insurers)}: {insurer_name} =====")
            try:
                insurer_result = run_for_insurer(store, args, insurer_name, month_labels, year_label, visible)
                all_notification_items.extend(insurer_result.get("notification_items", []))
                all_external_notification_items.extend(insurer_result.get("external_notification_items", []))
            except Exception as exc:
                failures.append((insurer_name, str(exc)))
                store.log_runner_event(
                    insurer_name=insurer_name,
                    event_type="runner_complete",
                    status="failed",
                    details={
                        "insurer_name": insurer_name,
                        "mode": "execute" if args.execute else "dry-run",
                        "captured_at": datetime.now(timezone.utc).isoformat(),
                        "error": str(exc),
                    },
                )
                print(f"\nERROR for {insurer_name}: {exc}")
                if not args.all_active:
                    raise

        if args and all_external_notification_items:
            send_external_assignment_alert(
                all_external_notification_items,
                portal_environment=PORTAL_ENVIRONMENT,
                run_source=norm(args.run_source) or "manual",
            )

        if args and args.execute and all_notification_items:
            assigned_items = [item for item in all_notification_items if item.kind == "assignment"]
            reassigned_items = [item for item in all_notification_items if item.kind == "reassignment"]
            scope_label = args.insurer or "All active insurers"
            slack_thread_ts = create_assignment_thread(
                scope_label=scope_label,
                portal_environment=PORTAL_ENVIRONMENT,
                assigned_piles=len(assigned_items),
                assigned_claims=sum(item.plan.claims for item in assigned_items),
                reassigned_piles=len(reassigned_items),
                reassigned_claims=sum(item.plan.claims for item in reassigned_items),
                insurer_names=[item.plan.insurer_name for item in all_notification_items],
            ) or ""
            if slack_thread_ts:
                for owner_items in group_notification_items_by_owner(all_notification_items):
                    if send_assignment_owner_reply(owner_items, slack_thread_ts):
                        slack_replies_sent += 1

        if failures:
            raise RuntimeError(
                "One or more insurers failed: "
                + "; ".join(f"{insurer}: {error}" for insurer, error in failures)
            )
    except Exception as exc:
        final_error = exc
        print(f"\nRUN FAILED: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    finally:
        if store and run_id:
            final_details = {
                **run_details,
                "insurers": insurers,
                "failure_count": len(failures),
                "failures": [{"insurer_name": insurer, "error": error} for insurer, error in failures],
                "slack_thread_ts": slack_thread_ts or None,
                "slack_replies_sent": slack_replies_sent,
                "slack_notification_owner_count": len(group_notification_items_by_owner(all_notification_items)),
                "external_assignment_alert_count": len(all_external_notification_items),
            }
            if final_error:
                final_details["error"] = str(final_error)
            store.finalize_runner_run(
                run_id,
                status="failed" if final_error else "completed",
                started_at=started_at,
                stdout=stdout_capture.getvalue(),
                stderr=stderr_capture.getvalue(),
                details=final_details,
            )
        if store:
            store.close()
        sys.stdout = original_stdout
        sys.stderr = original_stderr

    if final_error:
        raise final_error


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
    except Exception as exc:
        print(f"\nERROR: {exc}")
        sys.exit(1)
