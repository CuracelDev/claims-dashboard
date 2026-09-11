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
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from dataclasses import dataclass, field, replace
from decimal import Decimal, InvalidOperation
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qsl, quote, urlsplit
from zoneinfo import ZoneInfo

import psycopg2
import requests
from dotenv import load_dotenv
from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

try:
    from piles_auto_assignment.dispatch import (ContextOutputRouter, WorkerContext, safe_worker_error,
        AssignmentSubmissionUncertain, WorkOwnershipLost, WorkerUnavailable, DispatchResult, ProbeWork,
        dispatch_parent, execute_claimed_insurer)
    from piles_auto_assignment.store import (DispatchStore, ExecutionLedger, ReadOnlyExecutionLedger,
        ParentAlreadyTerminal, ParentScopeMismatch)
    from piles_auto_assignment.domain import (AttemptStatus, FilterEvidence, InsurerRunStatus,
        ParentRunStatus, RequestScope, WorkRequest, WorkSource)
    from piles_auto_assignment.evidence import classify_assignment_observations, evaluate_filter_evidence, decide_filter_wait
    from piles_auto_assignment.timing import PhaseTimer, timed_operation
    from piles_auto_assignment.scanning import ContextStatus, FilterContext, IncompleteScan, ScanAccumulator, late_arrival_contexts
    from piles_auto_assignment.planning import (
        eligible_bots as evaluate_eligible_bots,
        plan_assignments,
    )
    from piles_auto_assignment.reconciliation import Observation, reconcile_pending_for_insurer
    from piles_auto_assignment.orchestrator import classify_runner_error, derive_overall_run_status, derive_parent_status
    from piles_auto_assignment.scheduling import configured_max_concurrency
except ModuleNotFoundError:  # Repository-level unittest import path.
    from scripts.piles_auto_assignment.dispatch import (ContextOutputRouter, WorkerContext, safe_worker_error,
        AssignmentSubmissionUncertain, WorkOwnershipLost, WorkerUnavailable, DispatchResult, ProbeWork,
        dispatch_parent, execute_claimed_insurer)
    from scripts.piles_auto_assignment.store import (DispatchStore, ExecutionLedger, ReadOnlyExecutionLedger,
        ParentAlreadyTerminal, ParentScopeMismatch)
    from scripts.piles_auto_assignment.domain import (AttemptStatus, FilterEvidence, InsurerRunStatus,
        ParentRunStatus, RequestScope, WorkRequest, WorkSource)
    from scripts.piles_auto_assignment.evidence import classify_assignment_observations, evaluate_filter_evidence, decide_filter_wait
    from scripts.piles_auto_assignment.timing import PhaseTimer, timed_operation
    from scripts.piles_auto_assignment.scanning import ContextStatus, FilterContext, IncompleteScan, ScanAccumulator, late_arrival_contexts
    from scripts.piles_auto_assignment.planning import (
        eligible_bots as evaluate_eligible_bots,
        plan_assignments,
    )
    from scripts.piles_auto_assignment.reconciliation import Observation, reconcile_pending_for_insurer
    from scripts.piles_auto_assignment.orchestrator import classify_runner_error, derive_overall_run_status, derive_parent_status
    from scripts.piles_auto_assignment.scheduling import configured_max_concurrency


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
STATUS_FILTER_CODES = {
    "Vetting Pending": "P",
    "Vetting Ongoing": "O",
    "Audit Pending": "AP",
    "Audit Ongoing": "AO",
    "AI Audit": "AA",
}
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
PRIMARY_ASSIGNMENT_FLOOR_RATIO = min(
    max(float(os.getenv("PILES_PRIMARY_MIN_SHARE") or "0.6"), 0.4),
    0.9,
)
PLANNING_SPEED_FLOOR_RATIO = min(
    max(float(os.getenv("PILES_PLANNING_SPEED_FLOOR_RATIO") or "0.5"), 0.1),
    1.0,
)
AVAILABLE_BOT_STATUSES = {"available", "", "weekend_added"}
RUNNER_ADVISORY_LOCK_KEY = 564795289053896123


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


def dispatcher_v2_enabled(environ=os.environ) -> bool:
    """Explicit opt-in; the coordinator integration is separate from this adapter."""
    return str(environ.get("PILES_AUTO_ASSIGNMENT_DISPATCHER_V2", "")).strip().lower() in {"1", "true", "yes", "on"}


def is_test_portal(url: str) -> bool:
    lowered = norm(url).lower()
    return "dev.claims.curacel.co" in lowered


def norm(text: Any) -> str:
    return str(text or "").strip()


def enabled_by_default(value: Any) -> bool:
    """Match SQL coalesce(flag, true): only an explicit false disables a row."""
    return value is not False


def norm_key(text: Any) -> str:
    return "".join(ch.lower() for ch in norm(text) if ch.isalnum())


def stable_pile_tracking_key(provider: Any, claims: Any, amount: Any, month: Any, submitted_date: Any) -> str:
    return "|".join([
        norm(provider),
        str(safe_int(claims, 0)),
        norm(amount),
        norm(month),
        norm(submitted_date),
    ])


def legacy_pile_tracking_key(
    provider: Any,
    claims: Any,
    synced_claims: Any,
    amount: Any,
    month: Any,
    submitted_date: Any,
) -> str:
    return "|".join([
        norm(provider),
        str(safe_int(claims, 0)),
        str(safe_int(synced_claims, 0)),
        norm(amount),
        norm(month),
        norm(submitted_date),
    ])


def canonical_pile_tracking_key(tracking_key: Any) -> str:
    key = norm(tracking_key)
    parts = key.split("|")
    if len(parts) == 6 and parts[1].isdigit() and parts[2].isdigit():
        return "|".join([parts[0], parts[1], parts[3], parts[4], parts[5]])
    return key


def expanded_tracking_key_set(keys: Iterable[Any]) -> set[str]:
    expanded: set[str] = set()
    for key in keys:
        value = norm(key)
        if not value:
            continue
        expanded.add(value)
        expanded.add(canonical_pile_tracking_key(value))
    return expanded


def roster_owner_key(text: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", norm(text).lower().lstrip("@")).strip()


def roster_owner_matches(owner_key: str, roster_keys: set[str]) -> bool:
    if owner_key in roster_keys:
        return True
    owner_first = owner_key.split(" ", 1)[0] if owner_key else ""
    return bool(owner_first and any(key == owner_first or key.startswith(f"{owner_first} ") for key in roster_keys))


def normalize_weekend_primary_roles(bots: list["BotAccount"]) -> list["BotAccount"]:
    """Weekend coverage must have one clear primary per insurer."""
    if not bots:
        return []
    ordered = sorted(bots, key=lambda bot: (0 if bot.assignment_role == "primary" else 1, bot.priority_order, bot.owner_name))
    primary_id = ordered[0].id
    return [
        replace(bot, assignment_role="primary" if bot.id == primary_id else "support")
        for bot in bots
    ]


def label_key(text: Any) -> str:
    return re.sub(r"\s+", " ", norm(text).lower()).strip()


def canonical_insurer_key(text: Any) -> str:
    label = label_key(text)
    return INSURER_ALIAS_DISPLAY.get(label, label)


def insurer_aliases(text: Any) -> set[str]:
    label = label_key(text)
    canonical = canonical_insurer_key(text)
    aliases = {label, canonical}
    if canonical == "OLD MUTUAL":
        aliases.add("uapom")
        aliases.add("old mutual")
    return {alias for alias in aliases if alias}


def display_insurer_name(text: Any) -> str:
    label = canonical_insurer_key(text)
    return INSURER_ALIAS_DISPLAY.get(label, norm(text) or "Unknown insurer")


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


def assignment_entry_subject(entry: dict[str, Any]) -> Any:
    return entry.get("bot") or entry.get("assignee")


def assignment_entry_role(entry: dict[str, Any]) -> str:
    subject = assignment_entry_subject(entry)
    return norm(getattr(subject, "assignment_role", ""))


def assignment_entry_priority(entry: dict[str, Any]) -> int:
    subject = assignment_entry_subject(entry)
    return int(getattr(subject, "priority_order", 999) or 999)


def choose_assignment_entry(entries: list[dict[str, Any]]) -> dict[str, Any]:
    return min(
        entries,
        key=lambda entry: (
            entry["selection_score"],
            entry["projected_hours"],
            0 if assignment_entry_role(entry).lower() == "primary" else 1,
            assignment_entry_priority(entry),
        ),
    )


def apply_assignment_entry(entry: dict[str, Any], pile: "PileRow") -> None:
    entry["assigned_claims"] += pile.claims
    entry["assigned_piles"] += 1
    entry["current_load"] += pile.claims
    entry["projected_hours"] = entry["current_load"] / entry["effective_speed"]
    entry["selection_score"] = entry["projected_hours"] + entry["selection_penalty_hours"]


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


def assignment_planning_speed(role: str, observed_speed: float, previous_speed: float = 0.0) -> float:
    """Avoid permanently starving a bot because sparse assignments made its measured speed tiny."""
    smoothed_speed = smoothed_claims_per_hour(role, observed_speed, previous_speed)
    role_floor = default_speed_for_role(role) * PLANNING_SPEED_FLOOR_RATIO
    return max(smoothed_speed, role_floor)


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
        return ["All"]
    labels = []
    for part in text.split(","):
        label = norm(part)
        if not label:
            continue
        if label.lower() == "all":
            return ["All"]
        if label in MONTH_OPTIONS and label not in labels:
            labels.append(label)
    return labels or ["All"]


def parse_year_label(raw_value: str | None) -> str:
    text = norm(raw_value)
    if not text:
        return "All"
    return "All" if text.lower() == "all" else text


def year_scan_labels(requested_year: str, available_years: list[str], *, supports_multiple: bool) -> list[str]:
    normalized_years = list(dict.fromkeys(
        norm(value) for value in available_years if re.fullmatch(r"20\d{2}", norm(value))
    ))
    if not normalized_years:
        raise RuntimeError("The Year filter opened but exposed no four-digit year options.")

    requested = parse_year_label(requested_year)
    if norm_key(requested) == "all":
        return ["All"] if supports_multiple else normalized_years
    if requested not in normalized_years:
        raise RuntimeError(
            f"Requested year '{requested}' is not available. "
            f"Visible years: {', '.join(normalized_years)}"
        )
    return [requested]


def piles_response_matches_filter_year(url: str, requested_year: str) -> bool:
    parsed_url = urlsplit(norm(url))
    if not re.search(r"/piles(?:/|$)", parsed_url.path, flags=re.IGNORECASE):
        return False
    requested = parse_year_label(requested_year)
    if norm_key(requested) == "all":
        return True
    for key, value in parse_qsl(parsed_url.query, keep_blank_values=True):
        if not re.fullmatch(r"year(?:\[\d*\])?", key, flags=re.IGNORECASE):
            continue
        if requested in re.findall(r"\b20\d{2}\b", value):
            return True
    return False


def _query_values(url: str, key_pattern: str) -> list[str]:
    parsed_url = urlsplit(norm(url))
    return [
        norm(value)
        for key, value in parse_qsl(parsed_url.query, keep_blank_values=True)
        if re.fullmatch(key_pattern, key, flags=re.IGNORECASE)
    ]


def piles_response_matches_context(
    url: str,
    month_label: str,
    year_label: str,
    status_label: str,
    *,
    page_number: int | None = None,
    page_size: int | None = None,
) -> bool:
    """Match a Piles response to the exact visible table context.

    The production Vue table serializes status objects as ``status[code]`` /
    ``status[name]`` and years as an array. Matching all requested dimensions
    prevents an earlier request from authorizing a later empty DOM state.
    """
    parsed_url = urlsplit(norm(url))
    if not re.search(r"/piles(?:/|$)", parsed_url.path, flags=re.IGNORECASE):
        return False

    requested_month = parse_month_labels(month_label)[0]
    month_values = _query_values(url, r"month")
    if norm_key(requested_month) == "all":
        if month_values and not all(norm_key(value) in {"", "0", "all"} for value in month_values):
            return False
    else:
        expected_month = str(MONTH_OPTIONS.index(requested_month))
        if expected_month not in month_values and norm_key(requested_month) not in {
            norm_key(value) for value in month_values
        }:
            return False

    requested_year = parse_year_label(year_label)
    if norm_key(requested_year) != "all":
        year_values = _query_values(url, r"year(?:\[\d*\])?")
        if requested_year not in year_values:
            return False

    requested_status = norm(status_label) or "All"
    status_values = _query_values(url, r"status(?:\[(?:id|code|name)\]|\.(?:id|code|name)|_code)?")
    if norm_key(requested_status) == "all":
        if status_values and not any(norm_key(value) in {"", "0", "all"} for value in status_values):
            return False
    else:
        expected_code = STATUS_FILTER_CODES.get(requested_status, "")
        normalized_status_values = {norm_key(value) for value in status_values}
        if (
            norm_key(requested_status) not in normalized_status_values
            and norm_key(expected_code) not in normalized_status_values
        ):
            return False

    if page_number is not None:
        if str(page_number) not in _query_values(url, r"page"):
            return False
    if page_size is not None:
        if str(page_size) not in _query_values(url, r"per_page"):
            return False
    return True


def summarize_piles_response(payload: Any) -> dict[str, Any]:
    """Return only non-sensitive pagination evidence from a Piles response."""
    if not isinstance(payload, dict) or "data" not in payload:
        return {"authoritative": False}
    container = payload.get("data")
    total = payload.get("total")
    rows: Any = container
    if isinstance(container, dict) and "data" in container:
        rows = container.get("data")
        total = container.get("total", total)
    if not isinstance(rows, (list, dict)):
        return {"authoritative": False}
    summary: dict[str, Any] = {
        "authoritative": True,
        "item_count": len(rows),
    }
    if isinstance(total, (int, float)) and not isinstance(total, bool):
        summary["total"] = int(total)
    if isinstance(rows, list):
        first_row = next((row for row in rows if isinstance(row, dict)), None)
        if first_row is not None:
            summary["row_fields"] = sorted(str(key) for key in first_row.keys())[:50]
        identity_candidates = response_identity_candidates(rows)
        if rows and len(identity_candidates) == len(rows) and all(identity_candidates):
            summary["row_identity_candidates"] = identity_candidates
        id_hashes = response_row_id_hashes(rows)
        if rows and len(id_hashes) == len(rows) and all(id_hashes):
            summary["row_id_hashes"] = id_hashes
    return summary


def _nested_display_value(value: Any) -> str:
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return norm(value)
    if not isinstance(value, dict):
        return ""
    for key in ("name", "provider_name", "business_name", "display_name", "title"):
        candidate = value.get(key)
        if isinstance(candidate, (str, int, float)) and not isinstance(candidate, bool):
            return norm(candidate)
    for key in ("provider", "user", "profile"):
        candidate = _nested_display_value(value.get(key))
        if candidate:
            return candidate
    return ""


def _canonical_amount(value: Any) -> str:
    cleaned = re.sub(r"[^0-9.\-]", "", norm(value).replace(",", ""))
    if not cleaned:
        return ""
    try:
        decimal = Decimal(cleaned)
    except InvalidOperation:
        return ""
    return format(decimal.normalize(), "f")


def _canonical_date(value: Any) -> str:
    text = norm(value)
    if not text:
        return ""
    iso_match = re.search(r"\b(20\d{2})-(\d{1,2})-(\d{1,2})(?!\d)", text)
    if iso_match:
        return f"{iso_match.group(1)}-{int(iso_match.group(2)):02d}-{int(iso_match.group(3)):02d}"
    day_first = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})(?!\d)", text)
    if day_first:
        return f"{day_first.group(3)}-{int(day_first.group(2)):02d}-{int(day_first.group(1)):02d}"
    month_name = re.search(
        r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
        r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
        r"\s+(\d{1,2}),?\s+(20\d{2})\b",
        text,
        re.IGNORECASE,
    )
    if month_name:
        parsed = datetime.strptime(
            f"{month_name.group(1)[:3]} {month_name.group(2)} {month_name.group(3)}",
            "%b %d %Y",
        )
        return parsed.date().isoformat()
    for date_format in ("%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y"):
        try:
            parsed = datetime.strptime(re.sub(r"[,]+", "", text), date_format)
            return parsed.date().isoformat()
        except ValueError:
            continue
    return ""


def _canonical_month(value: Any) -> str:
    text = norm(value).lower()
    if not text:
        return ""
    try:
        numeric_month = Decimal(text)
        number = int(numeric_month) if numeric_month == numeric_month.to_integral_value() else 0
    except (InvalidOperation, ValueError, OverflowError):
        number = 0
    if 1 <= number <= 12:
        return f"{number:02d}"
    month_names = (
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
    )
    key = norm_key(text)
    for index, name in enumerate(month_names, start=1):
        if key in {name, name[:3]}:
            return f"{index:02d}"
    return ""


def _row_identity_hash(provider: Any, claims: Any, month: Any, amount: Any, submitted_date: Any) -> str:
    identity = "|".join([
        norm_key(provider),
        str(safe_int(claims, -1)),
        _canonical_month(month),
        _canonical_amount(amount),
        _canonical_date(submitted_date),
    ])
    if any(part in {"", "-1"} for part in identity.split("|")):
        return ""
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def response_identity_candidates(rows: list[Any]) -> list[list[str]]:
    """Hash candidate renderings without retaining provider or claim values."""
    result: list[list[str]] = []
    for row in rows:
        if not isinstance(row, dict):
            result.append([])
            continue
        candidate = _row_identity_hash(
            _nested_display_value(row.get("provider")),
            row.get("submitted_claims_count"),
            row.get("month"),
            row.get("amount_requested"),
            row.get("last_claim_submitted_at"),
        )
        candidates = {candidate} if candidate else set()
        result.append(sorted(candidates))
    return result


def response_row_id_hashes(rows: list[Any]) -> list[str]:
    """Hash stable response IDs so raw identifiers never enter evidence."""
    return [
        hashlib.sha256(norm(row.get("id")).encode("utf-8")).hexdigest()
        if isinstance(row, dict) and norm(row.get("id")) else ""
        for row in rows
    ]


def _dom_attribute_id_hashes(values: Any) -> set[str]:
    hashes: set[str] = set()
    for value in values if isinstance(values, list) else []:
        text = norm(value)
        if not text:
            continue
        tokens = {text, *re.split(r"[^A-Za-z0-9_-]+", text)}
        hashes.update(
            hashlib.sha256(token.encode("utf-8")).hexdigest()
            for token in tokens if len(token) >= 4
        )
    return hashes


def supports_multiple_year_selection(
    *,
    control_classes: str,
    control_multiple_attribute: bool,
    listbox_aria_multiselectable: str,
) -> bool:
    del control_multiple_attribute
    return (
        "p-multiselect" in norm(control_classes).lower().split()
        or norm(listbox_aria_multiselectable).lower() == "true"
    )


def classify_table_snapshot(
    row_texts: list[str],
    explicit_empty_message: bool,
    table_structure_visible: bool,
    loading_visible: bool,
) -> str:
    if explicit_empty_message:
        return "empty"
    if any(norm(text) for text in row_texts):
        return "rows"
    if table_structure_visible and not loading_visible:
        return "structurally_empty"
    return "pending"


def table_snapshot_matches_filter_context(
    snapshot: dict[str, Any],
    expected_item_count: int,
    month_label: str,
    year_label: str,
    status_label: str,
    response_identity_candidates: list[list[str]],
    response_row_id_hashes: list[str] | None = None,
    *,
    require_response_identity: bool = True,
) -> bool:
    """Validate an atomic DOM snapshot against the requested filter context."""
    if snapshot.get("loading") is not False:
        return False
    headers = [norm_key(value) for value in snapshot.get("headers") or []]
    rows = snapshot.get("rows") or []
    if not isinstance(rows, list) or len(rows) != expected_item_count or expected_item_count <= 0:
        return False

    def column_index(label: str) -> int:
        key = norm_key(label)
        return next((index for index, header in enumerate(headers) if header == key), -1)

    status_index = column_index("status")
    if status_index < 0 or norm_key(status_label) == "all":
        return False
    expected_status = norm_key(status_label)
    month_index = column_index("month")
    provider_index = column_index("provider")
    claims_index = column_index("claims")
    provider_bill_index = column_index("provider bill")
    submitted_date_index = column_index("submitted date")
    expected_month = _canonical_month(month_label)
    expected_year = norm(year_label)

    visible_identity_candidates: list[set[str]] = []
    visible_id_candidates: list[set[str]] = []
    row_attributes = snapshot.get("row_attributes") or []
    for row in rows:
        if not isinstance(row, list) or status_index >= len(row):
            return False
        visible_status = norm_key(row[status_index])
        if not visible_status or expected_status not in visible_status:
            return False
        if norm_key(month_label) != "all":
            if month_index < 0 or month_index >= len(row) or _canonical_month(row[month_index]) != expected_month:
                return False
        if norm_key(expected_year) != "all":
            if (
                submitted_date_index < 0
                or submitted_date_index >= len(row)
                or expected_year not in norm(row[submitted_date_index])
            ):
                return False
        identity_indexes = (
            provider_index,
            claims_index,
            month_index,
            provider_bill_index,
            submitted_date_index,
        )
        if any(index < 0 or index >= len(row) for index in identity_indexes):
            return False
        provider_text = norm(row[provider_index])
        provider_values = {provider_text, *(norm(line) for line in provider_text.splitlines())}
        identity_hashes = {
            identity_hash
            for provider in provider_values
            if (identity_hash := _row_identity_hash(
                provider,
                row[claims_index],
                row[month_index],
                row[provider_bill_index],
                row[submitted_date_index],
            ))
        }
        visible_identity_candidates.append(identity_hashes)
        visible_id_candidates.append(
            _dom_attribute_id_hashes(row_attributes[len(visible_id_candidates)])
            if len(row_attributes) > len(visible_id_candidates) else set()
        )

    if not require_response_identity:
        return True
    expected_id_hashes = response_row_id_hashes or []
    if len(expected_id_hashes) == len(rows) and all(expected_id_hashes):
        unmatched = list(visible_id_candidates)
        for expected_hash in expected_id_hashes:
            match_index = next((i for i, candidates in enumerate(unmatched) if expected_hash in candidates), -1)
            if match_index < 0:
                return False
            unmatched.pop(match_index)
        return True

    if len(response_identity_candidates) != len(visible_identity_candidates):
        return False
    candidate_sets = [set(candidates) for candidates in response_identity_candidates]
    matched_response_rows: dict[int, int] = {}

    def match_visible_row(visible_index: int, seen: set[int]) -> bool:
        identity_hashes = visible_identity_candidates[visible_index]
        for response_index, candidates in enumerate(candidate_sets):
            if response_index in seen or identity_hashes.isdisjoint(candidates):
                continue
            seen.add(response_index)
            prior_visible = matched_response_rows.get(response_index)
            if prior_visible is None or match_visible_row(prior_visible, seen):
                matched_response_rows[response_index] = visible_index
                return True
        return False

    return all(match_visible_row(index, set()) for index in range(len(visible_identity_candidates)))


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


def send_weekend_schedule_update(
    *,
    insurer_name: str,
    policy: WeekendRosterPolicy,
    eligible_bots: list[BotAccount],
    paused_bots: list[BotAccount],
) -> None:
    if not (SLACK_PRISM_BOT_TOKEN and SLACK_ALERTS_CHANNEL_ID):
        return
    active_lines = [
        f"• {bot.owner_name} → {bot.portal_name} ({bot.assignment_role})"
        for bot in eligible_bots
    ] or ["• No active weekend bot mapped"]
    paused_names = ", ".join(bot.owner_name for bot in paused_bots) or "None"
    text = (
        f":spiral_calendar_pad: Weekend assignment schedule activated for *{display_insurer_name(insurer_name)}*\n"
        f"Roster: {policy.weekend_start} to {policy.weekend_end}\n"
        f"Active bot(s):\n" + "\n".join(active_lines) + "\n"
        f"Paused/off-duty owners for this insurer: {paused_names}"
    )
    try:
        slack_post_message(SLACK_PRISM_BOT_TOKEN, SLACK_ALERTS_CHANNEL_ID, text)
    except Exception as exc:
        print(f"\n⚠️ Slack weekend schedule update failed for {insurer_name}: {exc}")


def send_weekend_restore_update(restored_rows: list[dict[str, Any]], *, safe_diagnostics: bool = False) -> None:
    if not restored_rows or not (SLACK_PRISM_BOT_TOKEN and SLACK_ALERTS_CHANNEL_ID):
        return
    by_insurer: dict[str, list[str]] = {}
    for row in restored_rows:
        by_insurer.setdefault(display_insurer_name(row.get("insurer_name")), []).append(norm(row.get("owner_name")))
    lines = [
        f"• {insurer}: {', '.join(sorted({name for name in owners if name}))}"
        for insurer, owners in sorted(by_insurer.items())
    ]
    text = (
        ":sunrise: Weekend assignment settings restored for weekday operations.\n"
        + "\n".join(lines)
    )
    try:
        slack_post_message(SLACK_PRISM_BOT_TOKEN, SLACK_ALERTS_CHANNEL_ID, text)
    except Exception as exc:
        if safe_diagnostics:
            print("WARNING: weekend roster notification failed.")
        else:
            print(f"\n⚠️ Slack weekend restore update failed: {exc}")


def create_assignment_thread(
    scope_label: str,
    portal_environment: str,
    assigned_piles: int,
    assigned_claims: int,
    reassigned_piles: int,
    reassigned_claims: int,
    insurer_names: list[str] | None = None,
    *, safe_diagnostics: bool = False,
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
        if safe_diagnostics:
            print("WARNING: assignment summary notification failed.")
        else:
            print(f"\n⚠️ Slack thread creation failed for {scope_label}: {exc}")
        return None


def send_assignment_owner_reply(owner_items: list["NotificationItem"], thread_ts: str, *, safe_diagnostics: bool = False) -> bool:
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
            insurer_group["reassigned_claims"] += max(item.plan.remaining_claims, 0)
            if norm(item.previous_owner_name):
                insurer_group["previous_owners"].add(item.previous_owner_name)
        else:
            insurer_group["assigned_piles"] += 1
            insurer_group["assigned_claims"] += max(item.plan.remaining_claims, 0)

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
        if safe_diagnostics:
            print("WARNING: assignment owner notification failed.")
        else:
            print(f"   ⚠️ Slack owner summary failed for {owner_name}: {exc}")
        return False


def send_external_assignment_alert(
    items: list["ExternalNotificationItem"],
    portal_environment: str,
    run_source: str,
    *, safe_diagnostics: bool = False,
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
        if safe_diagnostics:
            print("WARNING: external assignment notification failed.")
        else:
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
class WeekendRosterPolicy:
    roster_id: str
    weekend_start: str
    weekend_end: str
    effective_date: str
    on_shift_owner_names: list[str]
    off_duty_owner_names: list[str]
    eligible_bots: list[BotAccount]
    missing_reason: str = ""


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
    amount_text: str
    month: str
    submitted_date: str
    status: str
    assigned: str
    status_bucket: str
    page_number: int
    assignment_type: str
    filter_month: str
    filter_year: str
    legacy_tracking_key: str = ""


def effective_filter_year(pile: "PileRow", requested_year: str) -> str:
    return norm(pile.filter_year) or requested_year


def pile_row_matches_filter_year(pile: "PileRow", requested_year: str) -> bool:
    expected_year = parse_year_label(requested_year)
    if norm_key(expected_year) == "all":
        return True
    rendered_years = set(re.findall(r"\b20\d{2}\b", norm(pile.month)))
    return not rendered_years or rendered_years == {expected_year}


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
    filter_year: str
    source_page_number: int
    legacy_tracking_key: str = ""


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


def assignment_filter_contexts(
    month_labels: list[str],
    requested_year: str,
    plans: list[PlannedAssignment],
) -> list[tuple[str, str]]:
    contexts: list[tuple[str, str]] = []
    for month_label in month_labels:
        for plan in plans:
            if plan.filter_month != month_label:
                continue
            context = (month_label, norm(plan.filter_year) or requested_year)
            if context not in contexts:
                contexts.append(context)
    return contexts


def chunk_planned_assignments(
    plans: list["PlannedAssignment"],
    target_claims: int,
) -> list[list["PlannedAssignment"]]:
    target = max(int(target_claims or 0), 1)
    batches: list[list[PlannedAssignment]] = []
    current: list[PlannedAssignment] = []
    current_claims = 0
    for plan in plans:
        current.append(plan)
        current_claims += max(plan.remaining_claims, 0)
        if current_claims >= target:
            batches.append(current)
            current = []
            current_claims = 0
    if current:
        batches.append(current)
    return batches


@dataclass
class RowSelectionResult:
    count: int
    selected_keys: list[str]


@dataclass
class AssignmentVerificationResult:
    ok: bool
    observed_values: list[str]
    matched_count: int
    missing_count: int
    wrong_values: list[str]
    decisions: list[Any] = field(default_factory=list)


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


@dataclass
class ReassignmentCandidate:
    source_kind: str
    source_id: str
    assignment_type: str
    observed_row: PileRow
    current_bot: BotAccount
    source_tracking_key: str


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
    def __init__(self, *, read_only: bool = False) -> None:
        self.read_only = read_only
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

    def try_acquire_runner_lock(self) -> bool:
        if self.mode != "postgres":
            raise RuntimeError(
                "Piles runner concurrency protection requires DATABASE_URL so all runner hosts share one lock."
            )
        rows = self._fetchall_postgres(
            "select pg_try_advisory_lock(%s) as acquired",
            (RUNNER_ADVISORY_LOCK_KEY,),
        )
        return bool(rows and rows[0].get("acquired"))

    def try_acquire_insurer_lock(self, insurer_name: str) -> bool:
        if self.mode != "postgres":
            raise RuntimeError("Insurer-scoped scheduling requires DATABASE_URL.")
        rows = self._fetchall_postgres(
            "select pg_try_advisory_lock(hashtextextended(%s, 0)) as acquired",
            (f"piles-insurer:{canonical_insurer_key(insurer_name)}",),
        )
        return bool(rows and rows[0].get("acquired"))

    def release_insurer_lock(self, insurer_name: str) -> None:
        if self.mode == "postgres":
            self._fetchall_postgres(
                "select pg_advisory_unlock(hashtextextended(%s, 0)) as released",
                (f"piles-insurer:{canonical_insurer_key(insurer_name)}",),
            )

    def try_acquire_runner_slot(self, max_concurrency: int) -> int:
        if self.mode != "postgres":
            raise RuntimeError("Runner capacity protection requires DATABASE_URL.")
        for slot in range(max_concurrency):
            rows = self._fetchall_postgres(
                "select pg_try_advisory_lock(hashtextextended(%s, 0)) as acquired",
                (f"piles-capacity:{slot}",),
            )
            if rows and rows[0].get("acquired"):
                return slot
        return -1

    def release_runner_slot(self, slot: int) -> None:
        if self.mode == "postgres" and slot >= 0:
            self._fetchall_postgres(
                "select pg_advisory_unlock(hashtextextended(%s, 0)) as released",
                (f"piles-capacity:{slot}",),
            )

    def mark_coalesced_request(self, insurer_name: str, runner_run_id: str) -> str:
        if getattr(self, "read_only", False):
            return f"read-only-{uuid.uuid4()}"
        rows = self._fetchall_postgres(
            """
            INSERT INTO piles_auto_assignment_schedule_requests
                (id, insurer_name, requested_runner_run_id, status)
            VALUES (%s, %s, %s, 'pending')
            ON CONFLICT (lower(insurer_name)) WHERE status = 'pending'
            DO UPDATE SET updated_at = piles_auto_assignment_schedule_requests.updated_at
            RETURNING id
            """,
            (str(uuid.uuid4()), insurer_name, runner_run_id or None),
        )
        return str(rows[0]["id"])

    def claim_coalesced_request(self, insurer_name: str, runner_run_id: str) -> bool:
        if getattr(self, "read_only", False):
            return False
        rows = self._fetchall_postgres(
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
        return bool(rows)

    def _fetchall_postgres(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        assert self.conn
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]

    def _execute_postgres(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        if getattr(self, "read_only", False):
            return
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
        if getattr(self, "read_only", False):
            return
        url = f"{self.supabase_url}/rest/v1/{table}"
        res = requests.post(url, headers={
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }, json=payload, timeout=30)
        res.raise_for_status()

    def _update_supabase(self, table: str, field: str, value: str, payload: dict[str, Any]) -> None:
        if getattr(self, "read_only", False):
            return
        url = f"{self.supabase_url}/rest/v1/{table}?{quote(field)}=eq.{quote(value)}"
        res = requests.patch(url, headers={
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }, json=payload, timeout=30)
        res.raise_for_status()

    def update_bot_with_history(
        self,
        bot_id: str,
        patch: dict[str, Any],
        *,
        source: str,
        reason: str,
        actor_name: str = "Piles runner",
        actor_member_id: str = "system",
    ) -> None:
        """Apply a bot mutation and its audit entry in one database transaction."""
        if getattr(self, "read_only", False):
            return
        params = (
            bot_id,
            json.dumps(patch),
            actor_name,
            actor_member_id,
            source,
            reason,
        )
        if self.mode == "postgres":
            self._fetchall_postgres(
                "select * from piles_update_bot_account_with_history(%s, %s::jsonb, %s, %s, %s, %s)",
                params,
            )
            return
        url = f"{self.supabase_url}/rest/v1/rpc/piles_update_bot_account_with_history"
        response = requests.post(url, headers={
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": "application/json",
        }, json={
            "target_bot_id": bot_id,
            "patch": patch,
            "actor_name": actor_name,
            "actor_member_id": actor_member_id,
            "change_source": source,
            "change_reason": reason,
        }, timeout=30)
        response.raise_for_status()

    def get_master_account(self, insurer_name: str) -> MasterAccount:
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select id, insurer_name, login_email, login_password, is_active
                from piles_auto_assignment_master_accounts
                """
            )
            rows = [
                row for row in rows
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ][:1]
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
            is_active=enabled_by_default(row.get("is_active")),
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
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_master_accounts",
                    order="insurer_name.asc",
                )
                if enabled_by_default(row.get("is_active"))
            ]
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
                is_active=enabled_by_default(row.get("is_active")),
            ))
        return accounts

    def get_bot_accounts(self, insurer_name: str) -> list[BotAccount]:
        return self._rows_to_bot_accounts(self._fetch_bot_account_rows(insurer_name))

    def get_weekend_roster_policy(
        self,
        *,
        effective_date: str,
        insurer_name: str,
        bots: list[BotAccount],
    ) -> WeekendRosterPolicy | None:
        try:
            target_date = datetime.strptime(effective_date, "%Y-%m-%d").date()
        except Exception:
            return None
        if target_date.weekday() not in {5, 6}:
            return None

        if self.mode == "postgres":
            rosters = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_weekend_rosters
                where weekend_start <= %s::date and weekend_end >= %s::date
                order by updated_at desc
                limit 1
                """,
                (effective_date, effective_date),
            )
        else:
            rosters = [
                row for row in self._fetchall_supabase("piles_auto_assignment_weekend_rosters", order="updated_at.desc")
                if str(row.get("weekend_start")) <= effective_date <= str(row.get("weekend_end"))
            ][:1]

        if not rosters:
            return WeekendRosterPolicy(
                roster_id="",
                weekend_start=effective_date,
                weekend_end=effective_date,
                effective_date=effective_date,
                on_shift_owner_names=[],
                off_duty_owner_names=[],
                eligible_bots=[],
                missing_reason=f"No weekend roster found for {effective_date}.",
            )

        roster = rosters[0]
        roster_id = str(roster["id"])
        if self.mode == "postgres":
            members = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_weekend_roster_members
                where roster_id = %s
                order by duty_status asc, owner_name asc
                """,
                (roster_id,),
            )
        else:
            members = self._fetchall_supabase(
                "piles_auto_assignment_weekend_roster_members",
                filters=[("roster_id", "eq", roster_id)],
                order="owner_name.asc",
            )

        on_shift_members = [row for row in members if norm(row.get("duty_status")).lower() == "on_shift"]
        off_duty_members = [row for row in members if norm(row.get("duty_status")).lower() == "off_duty"]
        on_shift_keys = {roster_owner_key(row.get("owner_name")) for row in on_shift_members if roster_owner_key(row.get("owner_name"))}
        off_duty_keys = {roster_owner_key(row.get("owner_name")) for row in off_duty_members if roster_owner_key(row.get("owner_name"))}

        eligible_bots = []
        for bot in bots:
            owner_key = roster_owner_key(bot.owner_name)
            if not bot.is_active:
                continue
            if bot.availability_status == "weekend_paused":
                continue
            if bot.availability_status == "weekend_added":
                eligible_bots.append(bot)
                continue
            if not roster_owner_matches(owner_key, on_shift_keys):
                continue
            if roster_owner_matches(owner_key, off_duty_keys):
                continue
            eligible_bots.append(bot)
        eligible_bots = normalize_weekend_primary_roles(eligible_bots)

        missing_reason = ""
        if not on_shift_keys:
            missing_reason = f"Weekend roster {roster_id} has no on-shift members."
        elif not eligible_bots:
            missing_reason = (
                f"Weekend roster {roster_id} has no active bot row for {insurer_name} "
                f"owned by on-shift people: {', '.join(sorted(on_shift_keys))}."
            )

        return WeekendRosterPolicy(
            roster_id=roster_id,
            weekend_start=str(roster.get("weekend_start") or ""),
            weekend_end=str(roster.get("weekend_end") or ""),
            effective_date=effective_date,
            on_shift_owner_names=[norm(row.get("owner_name")) for row in on_shift_members],
            off_duty_owner_names=[norm(row.get("owner_name")) for row in off_duty_members],
            eligible_bots=eligible_bots,
            missing_reason=missing_reason,
        )

    def apply_weekend_bot_state(
        self,
        policy: WeekendRosterPolicy,
        bots: list[BotAccount],
    ) -> tuple[list[BotAccount], list[BotAccount], int]:
        if not policy.roster_id:
            return policy.eligible_bots, [], 0

        eligible_ids = {bot.id for bot in policy.eligible_bots}
        role_by_bot_id = {bot.id: bot.assignment_role for bot in policy.eligible_bots}
        paused_bots = [bot for bot in bots if bot.is_active and bot.id not in eligible_ids]
        update_rows = []
        for bot in bots:
            if not bot.is_active:
                continue
            is_weekend_available = bot.id in eligible_ids
            update_rows.append({
                "bot": bot,
                "is_available": is_weekend_available,
                "availability_status": (
                    bot.availability_status
                    if is_weekend_available and bot.availability_status == "weekend_added"
                    else "available" if is_weekend_available
                    else "weekend_paused" if bot.availability_status == "weekend_paused"
                    else "weekend_off"
                ),
                "availability_note": (
                    f"Weekend roster {policy.weekend_start} to {policy.weekend_end}: on shift"
                    if is_weekend_available
                    else f"Paused by weekend roster {policy.weekend_start} to {policy.weekend_end}"
                ),
                "assignment_role": role_by_bot_id.get(bot.id, bot.assignment_role),
            })

        inserted_count = 0
        now_iso = datetime.now(timezone.utc).isoformat()
        if self.mode == "postgres":
            for row in update_rows:
                bot = row["bot"]
                with self.conn.cursor() as cur:
                    cur.execute(
                        """
                        insert into piles_auto_assignment_weekend_bot_state_snapshots
                          (id, roster_id, bot_account_id, insurer_name, owner_name,
                           previous_assignment_role, previous_availability_status,
                           previous_availability_note, previous_is_available, previous_is_active,
                           details, created_at, updated_at)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                        on conflict (roster_id, bot_account_id) do nothing
                        """,
                        (
                            str(uuid.uuid4()),
                            policy.roster_id,
                            bot.id,
                            bot.insurer_name,
                            bot.owner_name,
                            bot.assignment_role,
                            bot.availability_status,
                            bot.availability_note,
                            bot.is_available,
                            bot.is_active,
                            json.dumps({
                                "weekend_start": policy.weekend_start,
                                "weekend_end": policy.weekend_end,
                                "effective_date": policy.effective_date,
                            }),
                            now_iso,
                            now_iso,
                        ),
                    )
                    inserted_count += cur.rowcount
                self.update_bot_with_history(
                    bot.id,
                    {
                        "assignment_role": row["assignment_role"],
                        "availability_status": row["availability_status"],
                        "availability_note": row["availability_note"],
                        "is_available": row["is_available"],
                    },
                    source="weekend_roster_automatic_apply",
                    reason=f"Applied weekend roster {policy.roster_id}",
                )
        else:
            existing = self._fetchall_supabase(
                "piles_auto_assignment_weekend_bot_state_snapshots",
                filters=[("roster_id", "eq", policy.roster_id)],
            )
            existing_bot_ids = {str(row.get("bot_account_id")) for row in existing}
            for row in update_rows:
                bot = row["bot"]
                if bot.id not in existing_bot_ids:
                    inserted_count += 1
                    self._insert_supabase("piles_auto_assignment_weekend_bot_state_snapshots", {
                        "id": str(uuid.uuid4()),
                        "roster_id": policy.roster_id,
                        "bot_account_id": bot.id,
                        "insurer_name": bot.insurer_name,
                        "owner_name": bot.owner_name,
                        "previous_assignment_role": bot.assignment_role,
                        "previous_availability_status": bot.availability_status,
                        "previous_availability_note": bot.availability_note,
                        "previous_is_available": bot.is_available,
                        "previous_is_active": bot.is_active,
                        "details": {
                            "weekend_start": policy.weekend_start,
                            "weekend_end": policy.weekend_end,
                            "effective_date": policy.effective_date,
                        },
                    })
                self.update_bot_with_history(
                    bot.id,
                    {
                        "assignment_role": row["assignment_role"],
                        "availability_status": row["availability_status"],
                        "availability_note": row["availability_note"],
                        "is_available": row["is_available"],
                    },
                    source="weekend_roster_automatic_apply",
                    reason=f"Applied weekend roster {policy.roster_id}",
                )

        return policy.eligible_bots, paused_bots, inserted_count

    def restore_due_weekend_bot_states(self, effective_date: str) -> list[dict[str, Any]]:
        try:
            target_date = datetime.strptime(effective_date, "%Y-%m-%d").date()
        except Exception:
            return []
        if target_date.weekday() in {5, 6}:
            return []

        if self.mode == "postgres":
            snapshots = self._fetchall_postgres(
                """
                select s.*
                from piles_auto_assignment_weekend_bot_state_snapshots s
                join piles_auto_assignment_weekend_rosters r on r.id = s.roster_id
                where s.restored_at is null
                  and r.weekend_end < %s::date
                order by s.applied_at asc
                """,
                (effective_date,),
            )
            for row in snapshots:
                self.update_bot_with_history(
                    str(row["bot_account_id"]),
                    {
                        "assignment_role": row.get("previous_assignment_role") or "primary",
                        "availability_status": row.get("previous_availability_status") or "available",
                        "availability_note": row.get("previous_availability_note"),
                        "is_available": bool(row.get("previous_is_available", True)),
                    },
                    source="weekend_roster_automatic_restore",
                    reason=f"Weekend roster {row.get('roster_id')} ended",
                )
                self._execute_postgres(
                    """
                    update piles_auto_assignment_weekend_bot_state_snapshots
                    set restored_at = now(), updated_at = now()
                    where id = %s
                    """,
                    (row["id"],),
                )
            return snapshots

        rosters = [
            row for row in self._fetchall_supabase("piles_auto_assignment_weekend_rosters")
            if str(row.get("weekend_end")) < effective_date
        ]
        roster_ids = {str(row.get("id")) for row in rosters}
        if not roster_ids:
            return []
        snapshots = [
            row for row in self._fetchall_supabase("piles_auto_assignment_weekend_bot_state_snapshots")
            if str(row.get("roster_id")) in roster_ids and not row.get("restored_at")
        ]
        for row in snapshots:
            self.update_bot_with_history(
                str(row["bot_account_id"]),
                {
                    "assignment_role": row.get("previous_assignment_role") or "primary",
                    "availability_status": row.get("previous_availability_status") or "available",
                    "availability_note": row.get("previous_availability_note"),
                    "is_available": bool(row.get("previous_is_available", True)),
                },
                source="weekend_roster_automatic_restore",
                reason=f"Weekend roster {row.get('roster_id')} ended",
            )
            self._update_supabase("piles_auto_assignment_weekend_bot_state_snapshots", "id", str(row["id"]), {
                "restored_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
        return snapshots

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
                is_active=enabled_by_default(row.get("is_active")),
                is_available=enabled_by_default(row.get("is_available")),
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
            rows = [
                row for row in rows
                if canonical_insurer_key(row.get("insurer_name")) in aliases
                and enabled_by_default(row.get("is_active"))
            ][:1]
        else:
            rows = [
                row for row in self._fetchall_supabase("piles_auto_assignment_rules")
                if canonical_insurer_key(row.get("insurer_name")) in aliases
                and enabled_by_default(row.get("is_active"))
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
        return expanded_tracking_key_set(row.get("tracking_key") for row in rows)

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
        plan_tracking_key = canonical_pile_tracking_key(plan.tracking_key)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_tracked_piles
                """,
            )
            rows = [
                row for row in rows
                if canonical_insurer_key(row.get("insurer_name")) in aliases
                and canonical_pile_tracking_key(row.get("tracking_key")) == plan_tracking_key
            ][:1]
        else:
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_tracked_piles",
                )
                if canonical_insurer_key(row.get("insurer_name")) in aliases
                and canonical_pile_tracking_key(row.get("tracking_key")) == plan_tracking_key
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
        last_progress_at: str | None = None,
    ) -> tuple[ExternalAssignment, bool]:
        now_iso = datetime.now(timezone.utc).isoformat()
        aliases = insurer_aliases(insurer_name)
        row_tracking_key = canonical_pile_tracking_key(row.tracking_key)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_external_assignments
                """,
            )
            rows = [
                existing_row for existing_row in rows
                if canonical_insurer_key(existing_row.get("insurer_name")) in aliases
                and canonical_pile_tracking_key(existing_row.get("tracking_key")) == row_tracking_key
            ][:1]
        else:
            rows = [
                existing_row for existing_row in self._fetchall_supabase(
                    "piles_auto_assignment_external_assignments",
                )
                if canonical_insurer_key(existing_row.get("insurer_name")) in aliases
                and canonical_pile_tracking_key(existing_row.get("tracking_key")) == row_tracking_key
            ][:1]
        existing = self._rows_to_external_assignments(rows)[0] if rows else None
        previous_details = existing.details if existing and isinstance(existing.details, dict) else {}
        details = {
            "source": "runner_detected_external_assignment",
            "identity_version": "stable_v2",
            "legacy_tracking_key": row.legacy_tracking_key,
            "assigned_name": row.assigned,
            "status_bucket": row.status_bucket,
            "owner_name": matched_bot.owner_name if matched_bot else "",
            "last_progress_at": last_progress_at or norm(previous_details.get("last_progress_at")),
            "identity_fields": {
                "provider": row.provider,
                "claims_total": row.claims,
                "amount": row.amount_text,
                "claim_month": row.month,
                "submitted_date": row.submitted_date,
                "synced_claims": row.synced_claims,
                "status_bucket": row.status_bucket,
            },
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
        if getattr(self, "read_only", False):
            simulated_payload = {
                "id": existing.id if existing else str(uuid.uuid4()),
                **payload,
                "first_detected_at": existing.first_detected_at if existing else now_iso,
            }
            return self._rows_to_external_assignments([simulated_payload])[0], existing is None
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
        active_key_set = expanded_tracking_key_set(active_tracking_keys)
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
            if tracking_key in active_key_set or canonical_pile_tracking_key(tracking_key) in active_key_set:
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

    def get_active_external_assignments(self, insurer_name: str) -> list[ExternalAssignment]:
        aliases = insurer_aliases(insurer_name)
        if self.mode == "postgres":
            rows = self._fetchall_postgres(
                """
                select *
                from piles_auto_assignment_external_assignments
                where coalesce(is_active, true) = true
                order by first_detected_at asc, provider asc
                """
            )
            rows = [row for row in rows if canonical_insurer_key(row.get("insurer_name")) in aliases]
        else:
            rows = [
                row for row in self._fetchall_supabase(
                    "piles_auto_assignment_external_assignments",
                    filters=[("is_active", "eq", "true")],
                    order="first_detected_at.asc",
                )
                if canonical_insurer_key(row.get("insurer_name")) in aliases
            ]
        return self._rows_to_external_assignments(rows)

    def clear_external_assignment(self, external_assignment_id: str) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        if self.mode == "postgres":
            self._execute_postgres(
                """
                update piles_auto_assignment_external_assignments
                set is_active = false,
                    cleared_at = coalesce(cleared_at, %s),
                    updated_at = now()
                where id = %s
                """,
                (now_iso, external_assignment_id),
            )
        else:
            self._update_supabase(
                "piles_auto_assignment_external_assignments",
                "id",
                external_assignment_id,
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
        run_id: str = "",
        insurer_name: str,
        run_scope: str,
        portal_environment: str,
        backend: str,
        run_source: str,
        months: list[str],
        year: str,
        mode: str,
        details: dict[str, Any],
        preserve_existing: bool = False,
    ) -> str:
        run_id = norm(run_id) or str(uuid.uuid4())
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
        if self.mode == "postgres" and norm(run_id):
            sql = """
                insert into piles_auto_assignment_runner_runs
                (id, insurer_name, run_scope, portal_environment, backend, run_source, months, year, mode, status, started_at, details)
                values (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s::jsonb)
                on conflict (id) do update set
                  insurer_name = excluded.insurer_name,
                  run_scope = excluded.run_scope,
                  portal_environment = excluded.portal_environment,
                  backend = excluded.backend,
                  run_source = excluded.run_source,
                  months = excluded.months,
                  year = excluded.year,
                  mode = excluded.mode,
                  status = 'started',
                  started_at = excluded.started_at,
                  details = coalesce(piles_auto_assignment_runner_runs.details, '{}'::jsonb) || excluded.details,
                  updated_at = now()
                """
            if preserve_existing:
                sql = sql.partition("on conflict")[0] + "on conflict (id) do nothing"
            self._execute_postgres(
                sql,
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
            existing = self._fetchall_supabase(
                "piles_auto_assignment_runner_runs",
                filters=[("id", "eq", run_id)],
            )
            if existing:
                payload["details"] = {**dict(existing[0].get("details") or {}), **details}
                self._update_supabase("piles_auto_assignment_runner_runs", "id", run_id, payload)
            else:
                self._insert_supabase("piles_auto_assignment_runner_runs", payload)
        return run_id

    def claim_preview_runner_run(
        self,
        *,
        run_id: str,
        insurer_name: str,
        run_scope: str,
        portal_environment: str,
        backend: str,
        run_source: str,
        months: list[str],
        year: str,
        mode: str,
    ) -> str:
        """Atomically adopt one API-created preview parent and fence its writer."""
        if self.mode != "postgres" or getattr(self, "read_only", False):
            raise RuntimeError("Durable preview adoption requires a writable PostgreSQL connection.")
        if not norm(run_id) or run_source != "manual" or mode != "dry-run":
            raise ParentScopeMismatch("Durable previews require an authorized manual dry-run parent.")
        token = str(uuid.uuid4())
        protocol = json.dumps({
            "preview_protocol": "durable_preview_v1",
            "preview_claim_token": token,
            "preview_phase": "configuration",
            "preview_outcomes": [],
        })
        claimed = self._fetchall_postgres(
            """
            update piles_auto_assignment_runner_runs
            set status = 'running', started_at = clock_timestamp(), finished_at = null,
                duration_ms = 0, stdout = null, stderr = null,
                details = coalesce(details, '{}'::jsonb) || %s::jsonb,
                updated_at = clock_timestamp()
            where id = %s and status = 'queued' and mode = 'dry-run'
              and run_source = 'manual' and run_scope = %s
              and coalesce(insurer_name, '') = %s
              and portal_environment = %s and backend = %s
              and months = %s::jsonb and year is not distinct from %s
            returning id
            """,
            (protocol, run_id, run_scope, insurer_name or "", portal_environment,
             backend, json.dumps(months), year),
        )
        if claimed:
            return token
        rows = self._fetchall_postgres(
            """
            select id, status, mode, run_source, run_scope, coalesce(insurer_name, '') as insurer_name,
                   portal_environment, backend, months, year
            from piles_auto_assignment_runner_runs where id = %s
            """,
            (run_id,),
        )
        if not rows:
            raise ParentScopeMismatch("The preview parent does not exist.")
        row = rows[0]
        expected = {
            "mode": mode, "run_source": run_source, "run_scope": run_scope,
            "insurer_name": insurer_name or "", "portal_environment": portal_environment,
            "backend": backend, "months": months, "year": year,
        }
        if any(row.get(key) != value for key, value in expected.items()):
            raise ParentScopeMismatch("Invocation scope does not match persisted preview scope.")
        if row.get("status") in {"completed", "completed_with_issues", "failed", "cancelled"}:
            raise ParentAlreadyTerminal("The preview parent is already terminal.")
        raise WorkerUnavailable("preview_parent_unavailable")

    def try_acquire_preview_parent_lock(self, run_id: str) -> bool:
        run_id = norm(run_id)
        if self.mode != "postgres" or not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", run_id):
            return False
        rows = self._fetchall_postgres(
            "select pg_try_advisory_lock(hashtextextended(%s, 0)) as acquired",
            (f"piles-preview-parent:{run_id}",),
        )
        return bool(rows and rows[0].get("acquired"))

    def release_preview_parent_lock(self, run_id: str) -> None:
        run_id = norm(run_id)
        if self.mode == "postgres" and re.fullmatch(r"[A-Za-z0-9._-]{1,200}", run_id):
            self._fetchall_postgres(
                "select pg_advisory_unlock(hashtextextended(%s, 0)) as released",
                (f"piles-preview-parent:{run_id}",),
            )

    def heartbeat_preview_runner_run(self, run_id: str, token: str, phase: str) -> bool:
        phase = phase if phase in {"configuration", "login", "navigation", "scan", "plan", "reconcile", "final_rescan", "complete"} else "configuration"
        rows = self._fetchall_postgres(
            """
            update piles_auto_assignment_runner_runs
            set details = coalesce(details, '{}'::jsonb) || %s::jsonb,
                updated_at = clock_timestamp()
            where id = %s and status = 'running' and mode = 'dry-run'
              and run_source = 'manual' and details ->> 'preview_protocol' = 'durable_preview_v1'
              and details ->> 'preview_claim_token' = %s
            returning id
            """,
            (json.dumps({"preview_phase": phase}), run_id, token),
        )
        return bool(rows)

    def finalize_preview_runner_run(
        self,
        run_id: str,
        token: str,
        *,
        status: str,
        outcomes: list[dict[str, Any]],
        error_code: str = "",
    ) -> bool:
        if status not in {"completed", "completed_with_issues", "failed", "cancelled"}:
            raise ValueError("Unsupported preview terminal status.")
        safe_outcomes = list(outcomes[:64])
        details = json.dumps({
            "preview_phase": "complete",
            "preview_outcomes": safe_outcomes,
            "preview_error_code": norm(error_code)[:100] or None,
        })
        rows = self._fetchall_postgres(
            """
            update piles_auto_assignment_runner_runs
            set status = %s, finished_at = clock_timestamp(),
                duration_ms = least(2147483647, greatest(0,
                    extract(epoch from (clock_timestamp() - started_at)) * 1000)),
                stderr = nullif(%s, ''),
                details = coalesce(details, '{}'::jsonb) || %s::jsonb,
                updated_at = clock_timestamp()
            where id = %s and status = 'running' and mode = 'dry-run'
              and run_source = 'manual' and details ->> 'preview_protocol' = 'durable_preview_v1'
              and details ->> 'preview_claim_token' = %s
            returning id
            """,
            (status, norm(error_code)[:100], details, run_id, token),
        )
        return bool(rows)

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


def build_execution_ledger(store: DataStore, args: argparse.Namespace, *, required: bool = False) -> Any:
    """Build the optional durable ledger without sharing DataStore autocommit state."""
    if bool(getattr(args, "read_only", False)):
        return ReadOnlyExecutionLedger()
    if not required and not env_bool("PILES_EXECUTION_LEDGER_ENABLED", False):
        return None
    if store.mode != "postgres" or not store.database_url:
        raise RuntimeError(
            "PILES_EXECUTION_LEDGER_ENABLED requires DATABASE_URL for transactional writes."
        )
    connection = psycopg2.connect(store.database_url)
    connection.autocommit = False
    return ExecutionLedger(connection)


def build_dispatch_store(store: DataStore) -> DispatchStore:
    if store.mode != "postgres" or not store.database_url:
        raise RuntimeError("Dispatcher v2 requires DATABASE_URL")
    connection = psycopg2.connect(store.database_url)
    connection.autocommit = False
    return DispatchStore(connection)


def worker_context_factory(args: argparse.Namespace, output_router: ContextOutputRouter, *,
                           max_concurrency: int = 1, durable_claims: bool = False):
    """Build fresh resources on the calling worker; never share parent stores.

    V2 always needs a durable execution ledger (or the read-only probe ledger),
    independently of the optional legacy ledger flag. The coordinator installs
    output_router before creating threads and keeps it installed until they join.
    """
    if type(max_concurrency) is not int or max_concurrency not in (1, 2):
        raise ValueError("Worker concurrency must be exactly 1 or 2.")
    @contextmanager
    def create(work):
        with output_router.bind(work.insurer_name) as output:
            with ExitStack() as resources:
                resources.callback(output.close)
                store = DataStore(read_only=bool(args.read_only))
                resources.callback(store.close)
                ledger = build_execution_ledger(store, args, required=True)
                resources.callback(ledger.close)
                dispatch_store = build_dispatch_store(store) if durable_claims else None
                if dispatch_store:
                    resources.callback(dispatch_store.close)
                output_dir = resources.enter_context(tempfile.TemporaryDirectory(prefix="piles-work-"))
                yield WorkerContext(store, ledger, output, work.worker_id, max_concurrency,
                                    dispatch_store=dispatch_store, output_path=str(Path(output_dir) / "plan.json"))
    return create


def ensure_runner_lock_available(store: DataStore) -> None:
    if not store.try_acquire_runner_lock():
        raise RuntimeError(
            "Another Piles Auto-Assignment run is already in progress. "
            "This run stopped before scanning or assigning claims."
        )


class CuracelPilesRunner:
    def __init__(self, visible: bool = True, slow_mo: int = 350) -> None:
        self.visible = visible
        self.slow_mo = slow_mo
        self.allow_test_any_assignee = False
        self.playwright = None
        self.browser: Browser | None = None
        self.page: Page | None = None
        self._filter_state: dict[str, Any] = {
            "month": "",
            "year": "",
            "status": "",
            "page_size": None,
        }
        self._table_headers_cache: list[str] = []
        self._piles_response_events: list[tuple[int, int, str, Any]] = []
        self._piles_response_sequence = 0
        self._piles_request_sequence = 0
        self._piles_pending_requests = {}
        self._piles_request_events = []
        self._piles_request_overflow = False
        self._piles_request_starts = {}  # Bounded terminal history; live starts stay in pending.
        self._piles_response_request_starts = {}
        self._piles_request_tracking = False
        self._page_open_response_marker = 0
        self.year_filter_confirmation_timeout_ms = 5000
        self.execution_ledger: Any = None
        self.insurer_run_id = ""
        self.insurer_name = ""
        self._last_scan_result: Any = None
        self._last_filter_evidence: FilterEvidence | None = None
        self.scan_context_ids: dict[tuple[str, str, str], str] = {}
        self.assignment_attempt_ids: dict[str, str] = {}
        self.retry_attempt_numbers: dict[str, int] = {}
        self.phase_timer = PhaseTimer()

    def _heartbeat(self, phase: str) -> None:
        work_heartbeat = getattr(self, "work_heartbeat", None)
        if work_heartbeat:
            # Ownership loss is fatal even if the optional ledger heartbeat is
            # absent, throttled, or failing. Never swallow this callback.
            work_heartbeat(phase)
        timer = getattr(self, 'phase_timer', None)
        if timer:
            timer.enter_phase(phase)
        ledger = getattr(self, "execution_ledger", None)
        insurer_run_id = norm(getattr(self, "insurer_run_id", ""))
        if not ledger or not insurer_run_id:
            return
        now = time.monotonic()
        if now - float(getattr(self, "_last_heartbeat_monotonic", 0.0) or 0.0) < 10:
            return
        self._last_heartbeat_monotonic = now
        try:
            ledger.heartbeat(insurer_run_id, phase=phase)
        except Exception as error:
            last_warning = float(getattr(self, "_last_heartbeat_warning_monotonic", 0.0) or 0.0)
            if now - last_warning >= 60:
                print(f"  Warning: runner heartbeat update failed ({type(error).__name__}).")
                self._last_heartbeat_warning_monotonic = now

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
            try:
                self.browser = self.playwright.chromium.launch(headless=not self.visible, slow_mo=self.slow_mo)
            except Exception as error:
                message = str(error)
                if "Executable doesn't exist" not in message:
                    raise
                self._ensure_playwright_browsers()
                self.browser = self.playwright.chromium.launch(headless=not self.visible, slow_mo=self.slow_mo)
            self.page = self.browser.new_page(viewport={"width": 1500, "height": 950})
            self.page.on("response", self._capture_piles_response)
            self.page.on("request", self._capture_piles_request)
            self.page.on("requestfinished", self._finish_piles_request)
            self.page.on("requestfailed", self._fail_piles_request)
            self._piles_request_tracking = True
        except BaseException:
            # A failed __enter__ does not receive a context-manager __exit__.
            self.__exit__(*sys.exc_info())
            raise
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        try:
            try:
                if self.browser:
                    self.browser.close()
            finally:
                if self.playwright:
                    self.playwright.stop()
        except Exception:
            # Preserve the portal/startup error that controls retry safety.
            if exc_type is None:
                raise

    def _invalidate_filter_state(self) -> None:
        self._filter_state = {
            "month": "",
            "year": "",
            "status": "",
            "page_size": None,
        }
        self._table_headers_cache = []
        self._settled_month_control = None
        self._settled_year_control = None
        self._settled_status_control = None
        self._settled_year_display = ''

    def _capture_piles_request(self, request: Any) -> None:
        self._record_piles_request(request, 'pending')

    def _finish_piles_request(self, request: Any) -> None:
        self._record_piles_request(request, 'finished')

    def _fail_piles_request(self, request: Any) -> None:
        self._record_piles_request(request, 'failed')

    def _record_piles_request(self, request: Any, state: str) -> None:
        if norm(request.method).upper() != 'GET' or not piles_response_matches_filter_year(request.url, 'All'):
            return
        self._piles_request_sequence += 1
        sequence = self._piles_request_sequence
        key = id(request)
        if state == 'pending':
            if len(self._piles_pending_requests) >= 100:
                # Lost lifecycle tracking must never grant the DOM shortcut.
                self._piles_request_overflow = True
            else:
                self._piles_pending_requests[key] = (sequence, request)
            started = sequence
        else:
            started, _ = self._piles_pending_requests.pop(key, (0, None))
            if not started:
                self._piles_request_overflow = True
            else:
                # Only terminal metadata is evictable. A slow live request must
                # retain its generation through arbitrary completed-request churn.
                self._piles_request_starts[key] = (request, started)
                if len(self._piles_request_starts) > 100:
                    del self._piles_request_starts[next(iter(self._piles_request_starts))]
        self._piles_request_events.append((sequence, state, norm(request.url), started))
        self._piles_request_events = self._piles_request_events[-100:]

    def _filter_request_state(self, marker, month, year, status):
        matching = [(state, started) for sequence, state, url, started in self._piles_request_events
                    if sequence > marker and piles_response_matches_context(url, month, year, status, page_number=1)]
        if any(state == 'failed' for state, _ in matching):
            return 'failed'
        if self._piles_pending_requests or self._piles_request_overflow:
            return 'pending'
        if any(state == 'finished' and started > marker for state, started in matching):
            return 'finished'
        return 'not_observed'

    def _filter_observation_generation(self):
        return (self._piles_response_sequence, getattr(self, '_piles_request_sequence', 0))

    def _capture_piles_response(self, response: Any) -> None:
        try:
            if norm(response.request.method).upper() != "GET":
                return
            if not piles_response_matches_filter_year(response.url, "All"):
                return
            self._piles_response_sequence = getattr(self, "_piles_response_sequence", 0) + 1
            starts = getattr(self, '_piles_request_starts', {})
            key = id(response.request)
            request_start = getattr(self, '_piles_pending_requests', {}).get(key, (0, None))[0]
            request_start = request_start or starts.get(key, (None, 0))[1]
            if not request_start and getattr(self, '_piles_request_tracking', False):
                # Correlation loss is sticky until a new runner installs fresh
                # page hooks. Draining tracked requests cannot prove that an
                # untracked request has drained too.
                self._piles_request_overflow = True
            response_starts = getattr(self, '_piles_response_request_starts', {})
            response_starts[self._piles_response_sequence] = request_start
            self._piles_response_request_starts = {
                sequence: started for sequence, started in response_starts.items()
                if sequence > self._piles_response_sequence - 100}
            self._piles_response_events.append((
                self._piles_response_sequence,
                safe_int(response.status, 0),
                norm(response.url),
                response,
            ))
            if len(self._piles_response_events) > 100:
                self._piles_response_events = self._piles_response_events[-100:]
        except Exception:
            return

    def _wait_for_piles_filter_response(
        self,
        marker: int,
        month_label: str,
        year_label: str,
        status_label: str,
        timeout_ms: int = 10000,
        *,
        page_number: int | None = None,
        page_size: int | None = None,
    ) -> None:
        deadline = time.time() + (timeout_ms / 1000)
        while time.time() < deadline:
            self._heartbeat("scan")
            matching_events = [
                (status, url, response)
                for sequence, status, url, response in self._piles_response_events
                if sequence > marker
                if piles_response_matches_context(
                    url,
                    month_label,
                    year_label,
                    status_label,
                    page_number=page_number,
                    page_size=page_size,
                )
            ]
            if matching_events:
                status, url, response = matching_events[-1]
                if 200 <= status < 400:
                    return
                raise RuntimeError(
                    "Piles data request for "
                    f"'{year_label} / {month_label} / {status_label}' failed with HTTP {status}: {url}"
                )
            time.sleep(0.1)
        raise RuntimeError(
            "No completed Piles data request confirmed "
            f"'{year_label} / {month_label} / {status_label}' within {timeout_ms}ms."
        )

    def _filter_network_state(
        self,
        marker: int,
        month_label: str,
        year_label: str,
        status_label: str,
        *,
        page_number: int | None = None,
        page_size: int | None = None,
        request_marker: int | None = None,
        response_ceiling: int | None = None,
    ) -> tuple[str, dict[str, Any]]:
        matching_events = [
            (sequence, status, response)
            for sequence, status, url, response in self._piles_response_events
            if sequence > marker
            and (response_ceiling is None or sequence <= response_ceiling)
            and (request_marker is None
                 or getattr(self, '_piles_response_request_starts', {}).get(sequence, 0) > request_marker
                 or (not getattr(self, '_piles_request_tracking', False)
                     and not getattr(self, '_piles_response_request_starts', {}).get(sequence, 0)))
            and piles_response_matches_context(
                url,
                month_label,
                year_label,
                status_label,
                page_number=page_number,
                page_size=page_size,
            )
        ]
        if not matching_events:
            return "not_observed", {}
        sequence, status, response = matching_events[-1]
        details = {"sequence": sequence, "http_status": status}
        if not 200 <= status < 400:
            return "failed", details
        try:
            summary = summarize_piles_response(response.json())
        except Exception as error:
            summary = {"authoritative": False, "payload_error": type(error).__name__}
        details.update(summary)
        details["authoritative_empty"] = (
            summary.get("authoritative") is True
            and summary.get("item_count") == 0
            and summary.get("total", 0) == 0
        )
        return "succeeded", details

    def _dismiss_popup(self) -> None:
        assert self.page
        for _ in range(2):
            try:
                self.page.keyboard.press("Escape")
                time.sleep(0.2)
            except Exception:
                pass
            for selector in [
                ".swal2-cancel",
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

    def _wait_for_login_or_app_ready(self, timeout_ms: int = 20000, *, require_app: bool = False) -> str:
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
                if login_input and password_input and not require_app:
                    return "login"
            except Exception:
                pass
            self.page.wait_for_timeout(350)
        raise RuntimeError("Login page did not become ready.")

    @timed_operation('login', 'login')
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
                self._dismiss_popup()
                post_state = self._wait_for_login_or_app_ready(timeout_ms=15000, require_app=True)
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

    @timed_operation('navigation', 'open_piles')
    def open_piles(self) -> None:
        assert self.page
        last_error: Exception | None = None
        for attempt in range(3):
            navigation_marker = self._piles_response_sequence
            try:
                self._goto_with_soft_readiness(f"{CURACEL_BASE_URL}/hmo/piles")
                self._wait_for_piles_page_ready()
                if self._piles_response_sequence == navigation_marker:
                    self.page.reload(wait_until="domcontentloaded", timeout=45000)
                    self._wait_for_piles_page_ready()
                time.sleep(1)
                self._dismiss_popup()
                self._page_open_response_marker = navigation_marker
                self._invalidate_filter_state()
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

    def _visible_multiselects(self) -> list[Any]:
        assert self.page
        selectors = self.page.locator(".p-multiselect.p-component")
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

    def _visible_filter_controls(self) -> list[Any]:
        assert self.page
        selectors = self.page.locator(
            ".p-select.p-component, .p-multiselect.p-component, "
            "[data-pc-name='select'], [data-pc-name='multiselect'], [role='combobox']"
        )
        visible: list[tuple[float, float, Any]] = []
        for index in range(selectors.count()):
            control = selectors.nth(index)
            try:
                box = control.bounding_box()
                if box and box["y"] < 420 and box["width"] > 0 and box["height"] > 0:
                    visible.append((box["y"], box["x"], control))
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

    def _describe_visible_filter_controls(self) -> list[dict[str, Any]]:
        descriptions: list[dict[str, Any]] = []
        for index, control in enumerate(self._visible_filter_controls(), start=1):
            try:
                box = control.bounding_box() or {}
                descriptions.append({
                    "index": index,
                    "x": round(box.get("x", 0), 1),
                    "y": round(box.get("y", 0), 1),
                    "text": self._read_select_text(control),
                    "class": norm(control.get_attribute("class")),
                    "data_pc_name": norm(control.get_attribute("data-pc-name")),
                    "role": norm(control.get_attribute("role")),
                    "aria_label": norm(control.get_attribute("aria-label")),
                    "aria_controls": norm(control.get_attribute("aria-controls")),
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
            "/following::*[(contains(@class,'p-select') or contains(@class,'p-multiselect')) and contains(@class,'p-component')][1]"
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

    def _find_multiselect_with_options(self, expected_options: list[str]) -> Any | None:
        expected_keys = [norm_key(option) for option in expected_options if norm(option)]
        for select in self._visible_multiselects():
            if not self._open_select(select):
                continue
            texts = self._dropdown_option_texts()
            text_keys = [norm_key(text) for text in texts]
            if any(expected in text_keys or any(expected in key for key in text_keys) for expected in expected_keys):
                self._close_dropdown()
                return select
            self._close_dropdown()
        return None

    def _choose_option_from_open_dropdown(self, desired_text: str, control: Any | None = None) -> str | None:
        assert self.page
        if control is not None:
            option_root = self._dropdown_root_for_control(control)
        else:
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
                option.click()
                if control is None:  # Assignment dropdown timing is unchanged.
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

    def _wait_for_dropdown_options(self, control: Any | None = None, timeout_ms: int = 4000) -> bool:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000)
        while time.time() < deadline:
            try:
                if control is not None:
                    option_root = self._dropdown_root_owned_by(control)
                    if option_root is not None:
                        options = option_root.locator(
                            ".p-select-option, li.p-multiselect-option, li[role='option'], "
                            "[data-pc-section='option']"
                        )
                        if options.count() > 0:
                            return True
                    elif not self._dropdown_reference_ids(control):
                        panels = self._visible_dropdown_panels()
                        if panels:
                            options = panels[-1].locator(
                                ".p-select-option, li.p-multiselect-option, li[role='option'], "
                                "[data-pc-section='option']"
                            )
                            if options.count() > 0:
                                return True
                else:
                    panels = self._visible_dropdown_panels()
                    if panels:
                        options = panels[-1].locator(
                            ".p-select-option, li.p-multiselect-option, li[role='option'], "
                            "[data-pc-section='option']"
                        )
                        if options.count() > 0:
                            return True
            except Exception:
                pass
            time.sleep(0.2)
        return False

    def _open_select(self, select: Any) -> bool:
        assert self.page
        control_classes = norm(select.get_attribute("class")).lower().split()
        is_primevue_multiselect = "p-multiselect" in control_classes

        if is_primevue_multiselect:
            try:
                select.evaluate("element => element.click()")
                if self._wait_for_dropdown_options(select):
                    return True
            except Exception:
                pass

        click_targets = [
            select,
            select.locator("[role='combobox'], .p-select-label").first,
            select.locator(
                ".p-select-dropdown, .p-multiselect-dropdown, [data-pc-section='dropdown']"
            ).first,
        ]
        for target in click_targets:
            try:
                if target is not select and (not target.count() or not target.is_visible()):
                    continue
                if target is select:
                    target.click()
                else:
                    target.click(force=True)
                if self._wait_for_dropdown_options(select):
                    return True
            except Exception:
                continue

        if not is_primevue_multiselect:
            try:
                select.evaluate("element => element.click()")
                if self._wait_for_dropdown_options(select):
                    return True
            except Exception:
                pass
        return False

    def _dropdown_option_texts(self, control: Any | None = None) -> list[str]:
        assert self.page
        option_root = self._dropdown_root_for_control(control) if control is not None else self._active_dropdown_root()
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

    def _direct_month_control(self) -> Any | None:
        candidates: list[Any] = []
        self._append_unique_select(candidates, self._select_following_label_text("Select Month"))
        self._append_unique_select(candidates, self._select_following_label_text("Month"))
        self._append_unique_select(candidates, self._select_in_container("Select Month"))
        self._append_unique_select(candidates, self._select_by_label("Select Month"))
        self._append_unique_select(candidates, self._select_by_label("Month"))
        if candidates:
            return candidates[0]
        visible = self._visible_selects()
        return visible[0] if visible else None

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

    def _direct_status_control(self, month_select: Any | None = None) -> Any | None:
        candidates: list[Any] = []
        self._append_unique_select(candidates, self._select_following_label_text("Filter by Vetting Status"))
        self._append_unique_select(candidates, self._select_in_container("Filter by Vetting Status"))
        self._append_unique_select(candidates, self._select_by_label("Filter by Vetting Status"))
        if candidates:
            return candidates[0]
        # An unlabeled first select is not evidence of a status control. In
        # fallback layouts month/year precede it; prove its role by options.
        return self._find_select_with_options(TARGET_STATUSES)

    def _select_candidates_for_year(self, year_label: str) -> list[Any]:
        multiselects = self._visible_multiselects()
        candidates: list[Any] = []
        expected_options = [year_label] if norm_key(year_label) != "all" else [str(datetime.now().year), str(datetime.now().year - 1)]
        self._append_unique_select(candidates, self._find_multiselect_with_options(expected_options))
        self._append_unique_select(candidates, self._select_following_label_text("Year"))
        self._append_unique_select(candidates, self._select_in_container("Year"))
        for select in multiselects:
            self._append_unique_select(candidates, select)
        return candidates

    def _direct_year_control(self) -> Any | None:
        candidates: list[Any] = []
        self._append_unique_select(candidates, self._select_following_label_text("Year"))
        self._append_unique_select(candidates, self._select_in_container("Year"))
        if candidates:
            return candidates[0]
        visible = self._visible_multiselects()
        return visible[0] if visible else None

    def _year_control_candidates(self) -> list[Any]:
        candidates: list[Any] = []
        self._append_unique_select(candidates, self._select_following_label_text("Year"))
        self._append_unique_select(candidates, self._select_in_container("Year"))
        for control in self._visible_filter_controls():
            self._append_unique_select(candidates, control)
        return candidates

    def _dropdown_reference_ids(self, control: Any) -> list[str]:
        owners: list[Any] = [control]
        for selector in ("[role='combobox']", "[aria-controls]", "[aria-owns]"):
            try:
                descendants = control.locator(selector)
                for index in range(descendants.count()):
                    owners.append(descendants.nth(index))
            except Exception:
                continue

        referenced_ids: list[str] = []
        for owner in owners:
            for attribute in ("aria-controls", "aria-owns"):
                try:
                    owner_ids = norm(owner.get_attribute(attribute)).split()
                except Exception:
                    continue
                for referenced_id in owner_ids:
                    if referenced_id not in referenced_ids:
                        referenced_ids.append(referenced_id)
        return referenced_ids

    def _dropdown_root_owned_by(self, control: Any) -> Any | None:
        assert self.page
        for referenced_id in self._dropdown_reference_ids(control):
            try:
                panel = self.page.locator(f"[id={json.dumps(referenced_id)}]").first
                if panel.count() and panel.is_visible():
                    return panel
            except Exception:
                continue
        return None

    def _dropdown_root_for_control(self, control: Any) -> Any:
        return self._dropdown_root_owned_by(control) or self._active_dropdown_root()

    def _inspect_year_control(self, control: Any) -> tuple[list[str], bool]:
        assert self.page
        if not self._open_select(control):
            return [], False
        try:
            option_root = self._dropdown_root_for_control(control)
            options = option_root.locator(
                ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
            )
            option_texts = [
                norm(options.nth(index).inner_text())
                for index in range(options.count())
            ]
            available_years = list(dict.fromkeys(
                text for text in option_texts if re.fullmatch(r"20\d{2}", text)
            ))
            listbox_aria = ""
            if norm(option_root.get_attribute("role")).lower() == "listbox":
                listbox_aria = norm(option_root.get_attribute("aria-multiselectable"))
            else:
                listbox = option_root.locator("[role='listbox']").first
                if listbox.count():
                    listbox_aria = norm(listbox.get_attribute("aria-multiselectable"))
            supports_multiple = supports_multiple_year_selection(
                control_classes=norm(control.get_attribute("class")),
                control_multiple_attribute=control.get_attribute("multiple") is not None,
                listbox_aria_multiselectable=listbox_aria,
            )
            return available_years, supports_multiple
        finally:
            self._close_dropdown()

    def _find_year_filter_control(self) -> tuple[Any, list[str], bool]:
        for control in self._year_control_candidates():
            try:
                available_years, supports_multiple = self._inspect_year_control(control)
                if available_years:
                    return control, available_years, supports_multiple
            except Exception:
                continue
        raise RuntimeError(
            "Could not identify the Year filter from the visible controls. "
            f"Visible filter controls: {self._describe_visible_filter_controls()}"
        )

    def year_filter_capabilities(self) -> tuple[bool, list[str]]:
        _control, available_years, supports_multiple = self._find_year_filter_control()
        return supports_multiple, available_years

    def _read_selected_multiselect_years(self, control: Any) -> set[str]:
        if not self._open_select(control):
            return set()
        try:
            option_root = self._dropdown_root_for_control(control)
            options = option_root.locator(
                ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
            )
            try:
                option_states = options.evaluate_all(
                    """elements => elements.map(element => ({
                        text: element.innerText.trim(),
                        ariaSelected: element.getAttribute('aria-selected'),
                        dataSelected: element.getAttribute('data-p-selected'),
                    }))"""
                )
                return {
                    norm(state.get("text"))
                    for state in option_states
                    if re.fullmatch(r"20\d{2}", norm(state.get("text")))
                    if (
                        norm(state.get("ariaSelected")).lower() == "true"
                        or norm(state.get("dataSelected")).lower() == "true"
                    )
                }
            except Exception:
                # Lightweight test doubles and older Playwright versions may not
                # expose evaluate_all; keep the stable-DOM fallback for them.
                pass
            selected_years: set[str] = set()
            for index in range(options.count()):
                option = options.nth(index)
                text = norm(option.inner_text())
                if not re.fullmatch(r"20\d{2}", text):
                    continue
                is_selected = (
                    norm(option.get_attribute("aria-selected")).lower() == "true"
                    or norm(option.get_attribute("data-p-selected")).lower() == "true"
                )
                if is_selected:
                    selected_years.add(text)
            return selected_years
        finally:
            self._close_dropdown()

    def _wait_for_year_filter_selection(
        self,
        control: Any,
        desired_years: set[str],
        *,
        supports_multiple: bool,
    ) -> None:
        timeout_ms = getattr(self, "year_filter_confirmation_timeout_ms", 5000)
        deadline = time.time() + (timeout_ms / 1000)
        observed_years: set[str] = set()
        observed_text = ""
        while time.time() < deadline:
            if supports_multiple:
                observed_years = self._read_selected_multiselect_years(control)
            else:
                observed_text = self._read_select_text(control)
                observed_years = set(re.findall(r"\b20\d{2}\b", observed_text))
            if observed_years == desired_years:
                return
            time.sleep(0.1)
        observed_label = sorted(observed_years, reverse=True) if supports_multiple else observed_text
        raise RuntimeError(
            "Year filter selection was not confirmed. "
            f"Requested {sorted(desired_years, reverse=True)}, observed {observed_label}."
        )

    def _apply_year_filter(self, year_label: str) -> Any:
        year_select, available_years, supports_multiple = self._find_year_filter_control()
        desired_year_values = year_scan_labels(
            year_label,
            available_years,
            supports_multiple=supports_multiple,
        )
        if supports_multiple:
            values_to_select = available_years if desired_year_values == ["All"] else desired_year_values
            self._set_multiselect_values(year_select, values_to_select, required=True)
            self._wait_for_year_filter_selection(
                year_select,
                set(values_to_select),
                supports_multiple=True,
            )
        else:
            desired_year = desired_year_values[0]
            self._set_select_value(year_select, desired_year, required=True)
            self._wait_for_year_filter_selection(
                year_select,
                {desired_year},
                supports_multiple=False,
            )
        return year_select

    def _set_select_value(self, select: Any | None, desired_text: str, required: bool = False) -> bool:
        assert self.page
        if select is None:
            if required:
                raise RuntimeError(f"Could not find select for '{desired_text}'.")
            return False
        try:
            if not self._open_select(select):
                raise RuntimeError(f"Could not open select for '{desired_text}'.")
            selected_text = self._choose_option_from_open_dropdown(desired_text, select)
            if not selected_text:
                available_options = self._dropdown_option_texts(select)
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
            timeout_ms = getattr(self, "select_confirmation_timeout_ms", 5000)
            deadline = time.time() + (timeout_ms / 1000)
            observed_text = ""
            while time.time() < deadline:
                self._heartbeat("scan")
                observed_text = self._read_select_text(select)
                if label_key(observed_text) == label_key(selected_text):
                    return True
                time.sleep(0.1)
            raise RuntimeError(
                f"Select value was not confirmed. Requested '{selected_text}', observed '{observed_text}'."
            )
        except Exception:
            if required:
                raise
            return False

    def _set_multiselect_values(self, select: Any | None, desired_values: list[str], required: bool = False) -> bool:
        assert self.page
        if select is None:
            if required:
                raise RuntimeError(f"Could not find multiselect for '{desired_values}'.")
            return False
        desired_keys = {label_key(value) for value in desired_values if norm(value)}
        try:
            if not self._open_select(select):
                raise RuntimeError(f"Could not open multiselect for '{desired_values}'.")
            option_root = self._dropdown_root_for_control(select)
            options = option_root.locator(
                ".p-select-option, li.p-multiselect-option, li[role='option'], [data-pc-section='option']"
            )
            available: list[tuple[str, bool]] = []
            for idx in range(options.count()):
                option = options.nth(idx)
                text = norm(option.inner_text())
                if not text:
                    continue
                selected = norm(option.get_attribute("aria-selected")).lower() == "true" or norm(option.get_attribute("data-p-selected")).lower() == "true"
                available.append((text, selected))

            if not available:
                raise RuntimeError("No year options were visible in the multiselect.")

            available_keys = {label_key(text) for text, _ in available}
            if not desired_keys.issubset(available_keys):
                raise RuntimeError(
                    f"Requested multiselect values {desired_values} were not all visible. "
                    f"Available options: {[text for text, _ in available]}"
                )

            if desired_keys == available_keys:
                overlay_root = self._active_multiselect_root()
                if self._click_multiselect_select_all(overlay_root):
                    self._close_dropdown()
                    return True

            self._close_dropdown()
            for text, selected in available:
                should_select = label_key(text) in desired_keys
                if should_select == selected:
                    continue
                if not self._open_select(select):
                    raise RuntimeError(f"Could not reopen multiselect while setting '{text}'.")
                try:
                    fresh_root = self._dropdown_root_for_control(select)
                    fresh_options = fresh_root.locator(
                        ".p-select-option, li.p-multiselect-option, li[role='option'], "
                        "[data-pc-section='option']"
                    )
                    target = None
                    for index in range(fresh_options.count()):
                        candidate = fresh_options.nth(index)
                        if label_key(candidate.inner_text()) == label_key(text):
                            target = candidate
                            break
                    if target is None:
                        raise RuntimeError(f"Year option '{text}' disappeared while updating the filter.")
                    try:
                        target.evaluate("element => element.click()")
                    except Exception:
                        target.click(force=True)
                    time.sleep(0.4)
                finally:
                    self._close_dropdown()
            return True
        except Exception:
            try:
                self._close_dropdown()
            except Exception:
                pass
            if required:
                raise
            return False

    def _click_multiselect_select_all(self, overlay_root: Any) -> bool:
        try:
            target = overlay_root.locator(".p-multiselect-header .p-checkbox-input").first
            if target.count() == 0 or not target.is_visible():
                return False
            input_label = norm(target.get_attribute("aria-label")).lower()
            if "all items selected" in input_label:
                return True
            try:
                target.evaluate("element => element.click()")
            except Exception:
                target.click(force=True)
            return True
        except Exception:
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

    @timed_operation('scan', 'filter')
    def apply_filters(self, month_label: str, year_label: str, status_label: str) -> FilterEvidence:
        assert self.page
        last_error: Exception | None = None
        final_month_select = None
        final_year_select = None
        final_status_select = None
        confirmed_year_display = getattr(self, '_settled_year_display', '')
        filter_response_marker = self._piles_response_sequence
        filter_state_was_initialized = all(
            norm(self._filter_state.get(key)) for key in ("month", "year", "status")
        )
        desired_year_state = "All" if norm_key(year_label) == "all" else year_label
        month_changed = self._filter_state["month"] != month_label
        year_changed = self._filter_state["year"] != desired_year_state
        status_changed = self._filter_state["status"] != status_label

        if not month_changed and not year_changed and not status_changed:
            month_control = getattr(self, '_settled_month_control', None) or self._direct_month_control()
            return self._wait_for_filter_settlement(
                filter_response_marker, month_label, year_label, status_label,
                {'month': month_control,
                 'year': getattr(self, '_settled_year_control', None),
                 'status': getattr(self, '_settled_status_control', None) or self._direct_status_control(month_control)},
                confirmed_year_display=confirmed_year_display, initial_snapshot={},
                request_marker=self._piles_request_sequence, selection_changed=False)

        self._reset_pagination_to_first_page()
        filter_response_marker = self._piles_response_sequence

        for attempt in range(1, 4):
            if attempt > 1:
                print(f"  Retrying filters (attempt {attempt}/3)...")
                self._dismiss_popup()
                try:
                    self.page.wait_for_load_state("domcontentloaded", timeout=10000)
                except Exception:
                    pass
                time.sleep(1.2)

            initial_snapshot = self._table_context_snapshot()
            filter_response_marker = self._piles_response_sequence
            filter_request_marker = self._piles_request_sequence
            month_select = (getattr(self, '_settled_month_control', None) or self._direct_month_control()
                            if not month_changed else None)
            if month_changed:
                direct_month = self._direct_month_control()
                if direct_month is not None and self._set_select_value(direct_month, month_label):
                    month_select = direct_month
                if month_select is None:
                    for candidate in self._select_candidates_for_month(month_label):
                        if self._set_select_value(candidate, month_label):
                            month_select = candidate
                            break
                if month_select is None:
                    month_candidates = self._select_candidates_for_month(month_label)
                    month_select = month_candidates[0] if month_candidates else None
                    self._set_select_value(month_select, month_label)

            year_select = None
            if year_changed:
                year_select = self._apply_year_filter(year_label)
                confirmed_year_display = self._read_select_text(year_select) or self._read_year_chip_text()

            status_select = None
            if month_changed or year_changed or status_changed:
                direct_status = self._direct_status_control(month_select)
                if direct_status is not None and self._set_select_value(direct_status, status_label):
                    status_select = direct_status
                if status_select is None:
                    for candidate in self._select_candidates_for_status(month_select):
                        if self._set_select_value(candidate, status_label):
                            status_select = candidate
                            break
            else:
                status_select = self._direct_status_control(month_select)
                if status_select is None:
                    status_candidates = self._select_candidates_for_status(month_select)
                    status_select = status_candidates[0] if status_candidates else None

            if status_select is not None:
                final_month_select = month_select
                final_year_select = year_select
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

        month_display = self._read_select_text(final_month_select) or month_label
        year_display = self._read_select_text(final_year_select) or self._read_year_chip_text() or year_label

        print(
            "  Applied filter controls:"
            f" month='{month_display}'"
            f" year='{desired_year_state if desired_year_state == 'All' else year_display}'"
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
        evidence = self._wait_for_filter_settlement(
            filter_response_marker, month_label, year_label, status_label,
            {'month': final_month_select or self._direct_month_control(),
             'year': final_year_select or getattr(self, '_settled_year_control', None),
             'status': final_status_select},
            confirmed_year_display=confirmed_year_display,
            initial_snapshot=initial_snapshot, request_marker=filter_request_marker,
            historical_marker=(self._page_open_response_marker if not filter_state_was_initialized else None),
        )
        self._filter_state.update(month=month_label, year=desired_year_state, status=status_label)
        # Cache only controls that passed the atomic context observation. Their
        # current connected/visible values are still revalidated on every reuse.
        self._settled_month_control = final_month_select
        self._settled_year_control = final_year_select or getattr(self, '_settled_year_control', None)
        self._settled_status_control = final_status_select
        self._settled_year_display = confirmed_year_display
        return evidence

    def _wait_for_filter_settlement(self, marker, month_label, year_label, status_label,
                                    filter_controls, *, confirmed_year_display, initial_snapshot,
                                    request_marker, historical_marker=None, selection_changed=True):
        """Poll DOM and network together, pumping Playwright events during the grace."""
        start = time.monotonic_ns()
        stable_since = start
        previous = None
        generation_fresh = False
        cap_ns = 30_000_000_000 if selection_changed else 6_000_000_000
        while True:
            self._heartbeat('scan')
            generation = self._filter_observation_generation()
            network_state, network = self._filter_network_state(
                marker, month_label, year_label, status_label, page_number=1,
                request_marker=request_marker if selection_changed else None)
            if network_state == 'not_observed' and historical_marker is not None:
                historical_state, historical = self._filter_network_state(
                    historical_marker, month_label, year_label, status_label,
                    page_number=1, response_ceiling=marker)
                if historical_state == 'succeeded' and historical.get('authoritative') is True:
                    network_state, network = historical_state, historical
            # Handle resolution/JSON parsing may pump callbacks; the final DOM
            # observation itself is one synchronous browser event-loop turn.
            snapshot = self._filter_context_snapshot(filter_controls)
            observed = snapshot.get('filter_controls') or {}
            controls = (
                label_key(observed.get('month')) == label_key(month_label),
                bool(confirmed_year_display) and norm(observed.get('year')) == confirmed_year_display,
                label_key(observed.get('status')) == label_key(status_label),
            )
            now = time.monotonic_ns()
            if generation != self._filter_observation_generation():
                previous = None
                if now - start >= cap_ns:
                    raise RuntimeError('Piles filters were not confirmed: filter_settlement_timeout.')
                self.page.wait_for_timeout(100)
                continue
            request_state = self._filter_request_state(request_marker, month_label, year_label, status_label)
            if request_state == 'failed':
                network_state = 'failed'
            # Ignore decorative row attributes: freshness must change actual
            # table content/readiness, not focus/checkbox metadata. Request
            # completion alone does not prove that Vue has committed its DOM.
            fresh_fields = ('rows', 'loading', 'table_visible', 'explicit_empty')
            if all(controls) and any(snapshot.get(key) != initial_snapshot.get(key) for key in fresh_fields):
                generation_fresh = True
            fingerprint = (snapshot, controls, generation, request_state)
            if fingerprint != previous:
                previous = deepcopy(fingerprint)
                stable_since = now
            stable = now - stable_since >= 300_000_000
            rows = snapshot.get('rows') or []
            ready = snapshot.get('table_visible') is True and snapshot.get('loading') is False
            table_state = 'unreadable'
            if ready and stable:
                table_state = ('stable' if rows else
                               'empty' if snapshot.get('explicit_empty') is True else 'structurally_empty')
            # Preserve the authoritative-empty fallback for portal versions that
            # omit table markup entirely when no rows exist. Absence alone is unknown.
            if (stable and not rows and snapshot.get('loading') is False
                    and network_state == 'succeeded' and network.get('authoritative') is True
                    and network.get('authoritative_empty') is True and table_state == 'unreadable'):
                table_state = 'structurally_empty'
            positive_dom = table_state == 'empty' or (
                table_state == 'stable' and table_snapshot_matches_filter_context(
                    snapshot, len(rows), month_label, year_label, status_label, [],
                    require_response_identity=False))
            details = {'selection_changed': selection_changed, 'positive_dom': positive_dom,
                       'generation_fresh': generation_fresh, 'request_pending': request_state == 'pending',
                       'network': {key: value for key, value in network.items()
                                   if key not in {'row_identity_candidates', 'row_id_hashes'}}}
            if network.get('authoritative') is True and table_state != 'unreadable':
                details['dom_matches_response'] = (
                    (network.get('authoritative_empty') is True and not rows)
                    or (table_state == 'stable' and table_snapshot_matches_filter_context(
                        snapshot, safe_int(network.get('item_count'), -1), month_label,
                        year_label, status_label, network.get('row_identity_candidates') or [],
                        network.get('row_id_hashes') or [])))
            evidence = FilterEvidence(*controls, table_state, network_state, details)
            decision = decide_filter_wait(evidence, (time.monotonic_ns() - start) / 1_000_000)
            if decision.decision == 'accept':
                return evidence
            if decision.decision in {'fail', 'retry'}:
                raise RuntimeError(f'Piles filters were not confirmed: {decision.code}.')
            if not selection_changed and evaluate_filter_evidence(evidence).accepted:
                return evidence
            if now - start >= cap_ns:
                raise RuntimeError('Piles filters were not confirmed: filter_settlement_timeout.')
            self.page.wait_for_timeout(100)

    def try_set_page_size(self, page_size: int = 100) -> None:
        assert self.page
        if self._filter_state.get("page_size") == page_size:
            return
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
                    selected_page_size = ""
                    try:
                        selected_page_size = norm(target.input_value())
                    except Exception:
                        selected_page_size = norm(target.get_attribute("value"))
                    if (
                        selected_page_size == str(page_size)
                        or norm(self._read_select_text(target)) == str(page_size)
                    ):
                        self._filter_state["page_size"] = page_size
                        return
                    response_marker = self._piles_response_sequence
                    previous_fingerprint = self._table_preview_fingerprint()
                    target.click()
                    time.sleep(0.4)
                    if self._choose_option_from_open_dropdown(str(page_size)):
                        self._wait_for_piles_filter_response(
                            response_marker,
                            self._filter_state["month"],
                            self._filter_state["year"],
                            self._filter_state["status"],
                            page_number=1,
                            page_size=page_size,
                        )
                        network_state, network_details = self._filter_network_state(
                            response_marker,
                            self._filter_state["month"],
                            self._filter_state["year"],
                            self._filter_state["status"],
                            page_number=1,
                            page_size=page_size,
                        )
                        if (
                            network_state != "succeeded"
                            or network_details.get("authoritative") is not True
                        ):
                            raise IncompleteScan(
                                "The Piles page-size response payload could not be verified."
                            )
                        _, coherent = self._wait_for_table_response_coherence(
                            safe_int(network_details.get("item_count"), -1),
                            previous_fingerprint,
                            timeout_ms=10000,
                            require_transition=False,
                        )
                        if not coherent:
                            raise IncompleteScan(
                                "The Piles table did not match the selected page size response."
                            )
                        self._filter_state["page_size"] = page_size
                        return
                    self.page.keyboard.press("Escape")
            except IncompleteScan:
                raise
            except Exception:
                continue

    def _table_headers(self) -> list[str]:
        assert self.page
        if self._table_headers_cache:
            return list(self._table_headers_cache)
        last_error: Exception | None = None
        for attempt in range(3):
            headers: list[str] = []
            try:
                ths = self.page.locator("table thead tr th")
                count = ths.count()
                if count == 0:
                    time.sleep(0.25)
                    continue
                for idx in range(count):
                    try:
                        headers.append(norm(ths.nth(idx).inner_text(timeout=1500)))
                    except Exception as error:
                        last_error = error
                        headers = []
                        break
                if headers:
                    self._table_headers_cache = list(headers)
                    return headers
            except Exception as error:
                last_error = error
            time.sleep(0.35)
        if last_error:
            print("  Warning: table headers were not fully readable; falling back to default column positions.")
        return []

    def wait_for_table_ready(self, timeout_ms: int = 12000) -> str:
        assert self.page
        deadline = time.time() + (timeout_ms / 1000)
        last_fingerprint = None
        stable_ticks = 0
        while time.time() < deadline:
            try:
                rows = self.page.locator("table tbody tr")
                count = rows.count()
                texts = [norm(rows.nth(i).inner_text()) for i in range(min(count, 3))] if count > 0 else []
                empty_message = self.page.locator("text=/^No Data Found$/i")
                no_data = any(
                    empty_message.nth(index).is_visible()
                    for index in range(min(empty_message.count(), 5))
                )
                table = self.page.locator("table").first
                table_body = self.page.locator("table tbody").first
                table_structure_visible = (
                    table.count() > 0
                    and table.is_visible()
                    and table_body.count() > 0
                )
                loading_visible = self._table_loading_visible()
                snapshot = classify_table_snapshot(
                    texts,
                    no_data,
                    table_structure_visible,
                    loading_visible,
                )
                fingerprint = (snapshot, tuple(texts))
                if fingerprint == last_fingerprint:
                    stable_ticks += 1
                else:
                    stable_ticks = 0
                    last_fingerprint = fingerprint
                required_ticks = 5 if snapshot == "structurally_empty" else 1
                if stable_ticks >= required_ticks and snapshot in {"rows", "empty", "structurally_empty"}:
                    return "stable" if snapshot == "rows" else snapshot
            except Exception:
                pass
            time.sleep(0.3)
        return "unreadable"

    def rows_on_current_page(
        self,
        status_bucket: str,
        page_number: int,
        filter_month: str,
        filter_year: str = "",
    ) -> list[PileRow]:
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
            if claims <= 0 and not any([provider, amount_text, month, submitted_date, row_status, assigned]):
                continue
            tracking_key = stable_pile_tracking_key(provider, claims, amount_text, month, submitted_date)
            legacy_tracking_key = legacy_pile_tracking_key(provider, claims, synced_claims, amount_text, month, submitted_date)
            key = "|".join([
                tracking_key,
                str(synced_claims),
                norm(status_bucket),
            ])
            piles.append(PileRow(
                key=key,
                tracking_key=tracking_key,
                provider=provider,
                claims=claims,
                synced_claims=synced_claims,
                remaining_claims=remaining_claims,
                amount_text=amount_text,
                month=month,
                submitted_date=submitted_date,
                status=row_status,
                assigned=assigned,
                status_bucket=status_bucket,
                page_number=page_number,
                assignment_type=STATUS_ASSIGNMENT_TYPE[status_bucket],
                filter_month=filter_month,
                filter_year=filter_year,
                legacy_tracking_key=legacy_tracking_key,
            ))
        return piles

    def _table_preview_fingerprint(self) -> tuple[str, ...]:
        assert self.page
        try:
            rows = self.page.locator("table tbody tr")
            return tuple(
                text
                for index in range(min(rows.count(), 3))
                if (text := norm(rows.nth(index).inner_text()))
                and norm_key(text) != "nodatafound"
            )
        except Exception:
            return ()

    def _visible_table_row_count(self) -> int:
        assert self.page
        try:
            rows = self.page.locator("table tbody tr")
            return sum(
                1
                for index in range(rows.count())
                if (text := norm(rows.nth(index).inner_text()))
                and norm_key(text) != "nodatafound"
            )
        except Exception:
            return -1

    def _table_context_snapshot(self) -> dict[str, Any]:
        """Read headers, row cells, and loading state in one browser evaluation."""
        return self._browser_context_snapshot()

    def _filter_context_snapshot(self, controls) -> dict[str, Any]:
        handles = {}
        try:
            # Release the previous observation before, never after, the atomic
            # read. Keep at most three handles alive until the next read/close.
            for handle in getattr(self, '_filter_observation_handles', {}).values():
                if handle is not None:
                    try:
                        handle.dispose()
                    except Exception:
                        pass
            self._filter_observation_handles = handles
            for name, control in controls.items():
                handles[name] = control.element_handle(timeout=1000) if control is not None else None
            return self._browser_context_snapshot(handles)
        except Exception:
            return {'headers': [], 'rows': [], 'loading': True}

    def _browser_context_snapshot(self, controls=None) -> dict[str, Any]:
        try:
            assert self.page
            snapshot = self.page.evaluate(
                r"""(controls) => {
                  const visible = (node) => {
                    if (!node) return false;
                    const rect = node.getBoundingClientRect();
                    const style = window.getComputedStyle(node);
                    return rect.width > 0 && rect.height > 0
                      && style.display !== 'none' && style.visibility !== 'hidden';
                  };
                  const filter_controls = Object.fromEntries(
                    Object.entries(controls || {}).map(([name, node]) => [name,
                      node && node.isConnected && visible(node) ? (node.innerText || '').trim() : null]));
                  const table = Array.from(document.querySelectorAll('table')).find(
                    (candidate) => visible(candidate) && candidate.querySelector('tbody')
                  );
                  const loading = Array.from(document.querySelectorAll(
                    "[aria-busy='true'], [role='progressbar'], .p-datatable-loading-overlay, .p-progressspinner"
                  )).some(visible);
                  if (!table) return { headers: [], rows: [], loading, table_visible: false, explicit_empty: false, filter_controls };
                  const headers = Array.from(table.querySelectorAll('thead tr th'))
                    .map((cell) => (cell.innerText || '').trim());
                  const rows = Array.from(table.querySelectorAll('tbody tr'))
                    .map((row) => Array.from(row.querySelectorAll('td'))
                      .map((cell) => (cell.innerText || '').trim()))
                    .filter((cells) => {
                      const text = cells.join(' ').replace(/\s+/g, '').toLowerCase();
                      return text && text !== 'nodatafound';
                    });
                  const rowAttributes = Array.from(table.querySelectorAll('tbody tr'))
                    .filter((row) => {
                      const text = (row.innerText || '').replace(/\s+/g, '').toLowerCase();
                      return text && text !== 'nodatafound';
                    })
                    .map((row) => Array.from(row.querySelectorAll('*')).concat([row])
                      .flatMap((node) => Array.from(node.attributes || []))
                      .filter((attribute) => attribute.name === 'href' || attribute.name === 'value'
                        || attribute.name === 'id' || attribute.name === 'name'
                        || attribute.name.startsWith('data-'))
                      .map((attribute) => attribute.value));
                  const explicit_empty = Array.from(table.querySelectorAll('tbody td'))
                    .some((cell) => visible(cell) && /^No Data Found$/i.test((cell.innerText || '').trim()));
                  return { headers, rows, row_attributes: rowAttributes, loading, table_visible: true, explicit_empty, filter_controls };
                }""", controls
            )
            return snapshot if isinstance(snapshot, dict) else {"headers": [], "rows": [], "loading": True}
        except Exception:
            return {"headers": [], "rows": [], "loading": True}

    def _table_loading_visible(self) -> bool:
        assert self.page
        try:
            loading = self.page.locator(
                "[aria-busy='true'], [role='progressbar'], .p-datatable-loading-overlay, .p-progressspinner"
            )
            return any(
                loading.nth(index).is_visible()
                for index in range(min(loading.count(), 5))
            )
        except Exception:
            return True

    def _wait_for_table_response_coherence(
        self,
        expected_item_count: int,
        previous_fingerprint: tuple[str, ...],
        *,
        timeout_ms: int,
        require_transition: bool = True,
        month_label: str = "",
        year_label: str = "",
        status_label: str = "",
        response_identity_candidates: list[list[str]] | None = None,
        response_row_id_hashes: list[str] | None = None,
    ) -> tuple[str, bool]:
        deadline = time.time() + (timeout_ms / 1000)
        last_state = "unreadable"
        previous_context_snapshot: tuple[Any, ...] | None = None
        matching_context_ticks = 0
        context_validation_required = bool(
            month_label and year_label and status_label and expected_item_count > 0
        )
        while time.time() < deadline:
            self._heartbeat("scan")
            remaining_ms = max(int((deadline - time.time()) * 1000), 1)
            last_state = self.wait_for_table_ready(timeout_ms=min(2500, remaining_ms))
            visible_count = self._visible_table_row_count()
            current_fingerprint = self._table_preview_fingerprint()
            context_snapshot = self._table_context_snapshot()
            if table_snapshot_matches_filter_context(
                context_snapshot,
                expected_item_count,
                month_label,
                year_label,
                status_label,
                response_identity_candidates or [],
                response_row_id_hashes or [],
            ):
                context_fingerprint = (
                    tuple(context_snapshot.get("headers") or []),
                    tuple(tuple(row) for row in context_snapshot.get("rows") or []),
                )
                if context_fingerprint == previous_context_snapshot:
                    matching_context_ticks += 1
                else:
                    previous_context_snapshot = context_fingerprint
                    matching_context_ticks = 0
                if matching_context_ticks >= 1:
                    return "stable", True
            else:
                previous_context_snapshot = None
                matching_context_ticks = 0
            if expected_item_count == 0:
                if visible_count == 0 and not self._table_loading_visible():
                    return (
                        last_state if last_state in {"empty", "structurally_empty"} else "structurally_empty",
                        True,
                    )
            elif (
                not context_validation_required
                and expected_item_count > 0
                and visible_count == expected_item_count
                and last_state == "stable"
                and (
                    not require_transition
                    or not previous_fingerprint
                    or current_fingerprint != previous_fingerprint
                )
            ):
                return last_state, True
            time.sleep(0.2)
        return last_state, False

    def _reset_pagination_to_first_page(self) -> None:
        assert self.page
        if not all(norm(self._filter_state.get(key)) for key in ("month", "year", "status")):
            return
        for selector in [
            "button[aria-label='First Page']",
            ".p-paginator-first",
        ]:
            try:
                button = self.page.locator(selector).first
                if button.count() == 0 or not button.is_visible():
                    continue
                disabled = button.get_attribute("disabled") is not None
                classes = norm(button.get_attribute("class")).lower()
                if disabled or "disabled" in classes:
                    return
                marker = self._piles_response_sequence
                button.click()
                self._wait_for_piles_filter_response(
                    marker,
                    self._filter_state["month"],
                    self._filter_state["year"],
                    self._filter_state["status"],
                    page_number=1,
                    page_size=self._filter_state.get("page_size"),
                )
                if self.wait_for_table_ready() == "unreadable":
                    raise IncompleteScan("The Piles table did not return to page 1 before filtering.")
                return
            except IncompleteScan:
                raise
            except Exception as error:
                raise IncompleteScan(
                    f"The Piles paginator could not return to page 1 before filtering: {error}"
                ) from error

    @timed_operation('scan', 'pagination')
    def goto_next_page(
        self,
        month_label: str = "",
        year_label: str = "",
        status_label: str = "",
        *,
        next_page: int | None = None,
    ) -> bool:
        assert self.page
        response_marker = getattr(self, "_piles_response_sequence", 0)
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
                previous_fingerprint = self._table_preview_fingerprint()
                loc.click()
                if next_page is not None:
                    try:
                        self._wait_for_piles_filter_response(
                            response_marker,
                            month_label,
                            year_label,
                            status_label,
                            page_number=next_page,
                            page_size=self._filter_state.get("page_size"),
                        )
                    except Exception as error:
                        raise IncompleteScan(
                            f"The next Piles page request was not confirmed: {error}"
                        ) from error
                    network_state, network_details = self._filter_network_state(
                        response_marker,
                        month_label,
                        year_label,
                        status_label,
                        page_number=next_page,
                        page_size=self._filter_state.get("page_size"),
                    )
                    if (
                        network_state != "succeeded"
                        or network_details.get("authoritative") is not True
                        or safe_int(network_details.get("item_count"), 0) <= 0
                    ):
                        raise IncompleteScan(
                            "The next Piles page response payload contained no readable rows."
                        )
                time.sleep(0.45)
                if self.wait_for_table_ready() != "stable":
                    raise IncompleteScan("The next Piles page did not settle into a readable row state.")
                if previous_fingerprint:
                    deadline = time.time() + 3
                    while time.time() < deadline:
                        if self._table_preview_fingerprint() != previous_fingerprint:
                            break
                        time.sleep(0.2)
                    else:
                        raise IncompleteScan(
                            "The next Piles page response completed but the visible rows did not change."
                        )
                return True
            except IncompleteScan:
                raise
            except Exception:
                continue
        return False

    def scan_status(self, month_label: str, year_label: str, status_label: str, *, only_unassigned: bool = False) -> list[PileRow]:
        self._heartbeat("scan")
        filter_evidence = self.apply_filters(month_label, year_label, status_label)
        filter_decision = evaluate_filter_evidence(filter_evidence)
        if not filter_decision.accepted:
            raise IncompleteScan(f"Piles table was not ready for scanning: {filter_decision.code}.")
        if filter_evidence.table_state in {"empty", "structurally_empty"}:
            scan = ScanAccumulator()
            result = scan.finish(explicit_empty=True)
            self._last_filter_evidence = filter_evidence
            self._last_scan_result = result
            return []
        self.try_set_page_size(100)
        settled_table_state = self.wait_for_table_ready()
        filter_evidence = replace(filter_evidence, table_state=settled_table_state)
        table_decision = evaluate_filter_evidence(filter_evidence)
        if not table_decision.accepted:
            raise IncompleteScan(f"Piles table was not ready for scanning: {table_decision.code}.")
        self._last_filter_evidence = filter_evidence
        scan = ScanAccumulator()
        page_number = 1
        while True:
            self._heartbeat("scan")
            page_rows = self.rows_on_current_page(status_label, page_number, month_label, year_label)
            mismatched_rows = [
                row for row in page_rows
                if not pile_row_matches_filter_year(row, year_label)
            ]
            if mismatched_rows:
                rendered_months = sorted({norm(row.month) or "<empty>" for row in mismatched_rows})
                raise RuntimeError(
                    f"Piles table did not settle on expected year '{year_label}'. "
                    f"Rendered month values: {', '.join(rendered_months[:5])}"
                )
            if scan.observe_page(page_number, page_rows):
                break
            if not self.goto_next_page(
                month_label,
                year_label,
                status_label,
                next_page=page_number + 1,
            ):
                break
            page_number += 1
        result = scan.finish(
            explicit_empty=filter_evidence.table_state in {"empty", "structurally_empty"}
        )
        self._last_scan_result = result
        return [
            row for row in result.rows
            if not only_unassigned or not norm(row.assigned)
        ]

    def _scan_status_with_transient_retry(
        self,
        month_label: str,
        year_label: str,
        status_label: str,
        *,
        only_unassigned: bool = False,
    ) -> list[PileRow]:
        try:
            return self.scan_status(
                month_label, year_label, status_label, only_unassigned=only_unassigned,
            )
        except Exception as error:
            if not is_retryable_scan_error(error):
                raise
            print(
                "  Piles data request did not settle. Reloading the Piles page and "
                "retrying this filter context once..."
            )
            self.open_piles()
            return self.scan_status(
                month_label, year_label, status_label, only_unassigned=only_unassigned,
            )

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
        supports_multiple, available_years = self.year_filter_capabilities()
        scan_years = year_scan_labels(
            year_label,
            available_years,
            supports_multiple=supports_multiple,
        )
        # Per-run snapshots become eligible only after ledger persistence succeeds.
        self.initial_scan_results = {
            (month, year, status): replace(
                ScanAccumulator().finish(explicit_empty=True),
                status=ContextStatus.PENDING, context=FilterContext(month, year, status),
            )
            for year in scan_years for month in month_labels for status in TARGET_STATUSES
        }
        ledger = getattr(self, "execution_ledger", None)
        insurer_run_id = norm(getattr(self, "insurer_run_id", ""))
        context_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
        if ledger and insurer_run_id:
            expected_contexts = [
                {
                    "insurer_name": norm(getattr(self, "insurer_name", "")),
                    "filter_month": month_label,
                    "requested_year": scan_year,
                    "effective_years": available_years if scan_year == "All" else [scan_year],
                    "status_bucket": status_label,
                }
                for scan_year in scan_years
                for month_label in month_labels
                for status_label in TARGET_STATUSES
            ]
            contexts = ledger.create_scan_contexts(insurer_run_id, expected_contexts)
            context_by_key = {
                (item["filter_month"], item["requested_year"], item["status_bucket"]): item
                for item in contexts
            }
            scan_context_ids = getattr(self, "scan_context_ids", {})
            scan_context_ids.update({key: item["id"] for key, item in context_by_key.items()})
            self.scan_context_ids = scan_context_ids
        for scan_year in scan_years:
            if len(scan_years) > 1:
                print(f"\nScanning year: {scan_year}")
            for month_label in month_labels:
                print(f"\nScanning month: {month_label}")
                for status_label in TARGET_STATUSES:
                    print(f"\nScanning status: {status_label}")
                    context = context_by_key.get((month_label, scan_year, status_label))
                    context_key = (month_label, scan_year, status_label)
                    if context:
                        ledger.heartbeat(insurer_run_id, phase="scan")
                        ledger.start_scan_context(context["id"])
                    self._last_scan_result = None
                    self._last_filter_evidence = None
                    try:
                        rows = self._scan_status_with_transient_retry(
                            month_label, scan_year, status_label,
                        )
                        scan_result = self._last_scan_result
                        if scan_result is None:
                            accumulator = ScanAccumulator()
                            accumulator.observe_page(1, rows)
                            scan_result = accumulator.finish(explicit_empty=not rows)
                        scan_result = replace(scan_result, context=FilterContext(*context_key))
                        if context:
                            ledger.finish_scan_context(
                                context["id"],
                                scan_result,
                                self._last_filter_evidence,
                            )
                            self.initial_scan_results[context_key] = scan_result
                    except Exception as error:
                        self.initial_scan_results[context_key] = replace(
                            self.initial_scan_results[context_key], status=ContextStatus.FAILED,
                        )
                        if context:
                            safe_diagnostics = bool(getattr(self, "safe_diagnostics", False))
                            ledger.fail_scan_context(
                                context["id"],
                                error_code=classify_runner_error(error) if safe_diagnostics else type(error).__name__.lower(),
                                error_message=safe_worker_error(error)[1] if safe_diagnostics else str(error)[:2000],
                            )
                        raise
                    unassigned = [row for row in rows if not norm(row.assigned)]
                    print(f"  Found {len(rows)} rows, {len(unassigned)} unassigned")
                    for row in rows:
                        row.filter_year = scan_year
                        if row.key in seen:
                            continue
                        seen.add(row.key)
                        all_rows.append(row)
        return all_rows

    @timed_operation('final_rescan', 'final_rescan')
    def scan_selected_statuses(
        self,
        filter_contexts: list[tuple[str, str, str]],
        year_label: str,
        *,
        only_unassigned: bool = False,
    ) -> list[PileRow]:
        all_rows: list[PileRow] = []
        seen: set[str] = set()
        for month_label, filter_year, status_label in filter_contexts:
            self._heartbeat("scan")
            active_year = norm(filter_year) or year_label
            print(f"\nScanning follow-up context: {active_year} / {month_label} / {status_label}")
            rows = self._scan_status_with_transient_retry(
                month_label, active_year, status_label, only_unassigned=only_unassigned,
            )
            if only_unassigned:
                print(f"  Found {len(rows)} unassigned rows")
            else:
                unassigned = [row for row in rows if not norm(row.assigned)]
                print(f"  Found {len(rows)} rows, {len(unassigned)} unassigned")
            for row in rows:
                # V2 needs every observation to detect contradictory assignment
                # evidence across contexts before canonical late-row deduplication.
                preserve_evidence = bool(getattr(self, "safe_diagnostics", False)) and not only_unassigned
                if row.key in seen and not preserve_evidence:
                    continue
                seen.add(row.key)
                all_rows.append(row)
        return all_rows

    def reset_to_filtered_page(self, month_label: str, year_label: str, status_label: str, page_number: int) -> list[PileRow]:
        self._heartbeat("reconcile")
        self.open_piles()
        self.apply_filters(month_label, year_label, status_label)
        self.try_set_page_size(100)
        current_page = 1
        while current_page < page_number:
            if not self.goto_next_page(
                month_label,
                year_label,
                status_label,
                next_page=current_page + 1,
            ):
                break
            current_page += 1
        return self.rows_on_current_page(status_label, current_page, month_label, year_label)

    def find_filtered_row_by_key(
        self,
        month_label: str,
        year_label: str,
        status_label: str,
        pile_key: str,
        *,
        preferred_page: int = 1,
        current_page: int | None = None,
    ) -> PileRow | None:
        page_candidates: list[int] = []
        for page_number in [
            current_page or preferred_page,
            preferred_page,
            max(1, preferred_page - 1),
            preferred_page + 1,
            max(1, preferred_page - 2),
            preferred_page + 2,
            1,
            2,
            3,
        ]:
            if page_number not in page_candidates and page_number > 0:
                page_candidates.append(page_number)
        for page_number in page_candidates:
            self._heartbeat("reconcile")
            current_rows = self.reset_to_filtered_page(month_label, year_label, status_label, page_number)
            for row in current_rows:
                if row.key == pile_key:
                    return row
        return None

    def _page_candidates_for_plan(self, plan: PlannedAssignment, current_page: int | None = None) -> list[int]:
        candidates: list[int] = []
        for page_number in [
            current_page or plan.source_page_number,
            plan.source_page_number,
            max(1, plan.source_page_number - 1),
            plan.source_page_number + 1,
            max(1, plan.source_page_number - 2),
            plan.source_page_number + 2,
            1,
            2,
            3,
        ]:
            if page_number > 0 and page_number not in candidates:
                candidates.append(page_number)
        return candidates

    def _apply_selected_group(
        self,
        filter_month: str,
        year_label: str,
        status_label: str,
        assignee_name: str,
        assignment_type: str,
        selected_group: list[PlannedAssignment],
        execute: bool,
    ) -> tuple[str, list[AppliedAssignment]]:
        selected_keys = [plan.pile_key for plan in selected_group]
        self._heartbeat("apply")
        self._open_assign_modal()
        submission_recorded = False
        def before_submit():
            nonlocal submission_recorded
            self._transition_assignment_attempts(
                selected_group, AttemptStatus.SUBMITTED, {AttemptStatus.SELECTED},
                {"code": "portal_submission_starting", "details": {}},
            )
            submission_recorded = True
        self._before_assignment_submit = before_submit if execute and getattr(self, "work_heartbeat", None) else None
        try:
            selected_assignee = self._apply_assignment_modal(assignment_type, assignee_name, execute)
        finally:
            self._before_assignment_submit = None
        verified_on_table = False
        observed_assigned_values: list[str] = []
        if execute:
            if not submission_recorded:
                self._transition_assignment_attempts(
                    selected_group,
                    AttemptStatus.SUBMITTED,
                    {AttemptStatus.SELECTED},
                    {"code": "portal_submit_returned", "details": {
                        "selected_assignee": selected_assignee,
                    }},
                )
            self._heartbeat("apply")
            source_pages: list[int] = []
            for plan in selected_group:
                for page_number in self._page_candidates_for_plan(plan):
                    if page_number not in source_pages:
                        source_pages.append(page_number)
            verification = self.verify_assigned_rows(
                filter_month,
                year_label,
                status_label,
                selected_keys,
                selected_assignee,
                tracking_keys=[plan.tracking_key for plan in selected_group],
                source_pages=source_pages,
            )
            self._heartbeat("reconcile")
            verified_on_table = verification.ok
            observed_assigned_values = verification.observed_values
            ledger = getattr(self, "execution_ledger", None)
            if ledger:
                for decision in verification.decisions:
                    if not decision.attempt_id:
                        continue
                    ledger.transition_attempt(
                        decision.attempt_id,
                        decision.status,
                        expected={AttemptStatus.SUBMITTED},
                        evidence=decision.evidence,
                    )
            if verification.missing_count or verification.wrong_values:
                print(
                    f"  Per-pile verification for '{selected_assignee}': "
                    f"confirmed={verification.matched_count}, "
                    f"reconciliation_pending={verification.missing_count}, "
                    f"conflict={len(verification.wrong_values)}."
                )

        decisions_by_tracking = {
            decision.tracking_key: decision
            for decision in verification.decisions
        } if execute else {}
        applied = [
            AppliedAssignment(
                plan=plan,
                actual_assignee_name=selected_assignee,
                matched_planned_assignee=norm_key(selected_assignee) == norm_key(assignee_name),
                verified_on_table=(
                    decisions_by_tracking.get(canonical_pile_tracking_key(plan.tracking_key)) is not None
                    and decisions_by_tracking[canonical_pile_tracking_key(plan.tracking_key)].status
                    == AttemptStatus.CONFIRMED_VISIBLE
                ) if execute else False,
                observed_assigned_values=(
                    [decisions_by_tracking[canonical_pile_tracking_key(plan.tracking_key)].evidence.details.get("observed_assignee", "")]
                    if canonical_pile_tracking_key(plan.tracking_key) in decisions_by_tracking
                    else ["<missing>"]
                ) if execute else [],
            )
            for plan in selected_group
        ]
        return selected_assignee, applied

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

    @timed_operation('apply', 'row_selection')
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

    @timed_operation('verify', 'verification')
    def verify_assigned_rows(
        self,
        month_label: str,
        year_label: str,
        status_label: str,
        pile_keys: list[str],
        expected_assignee: str,
        tracking_keys: list[str] | None = None,
        timeout_ms: int = 15000,
        source_pages: list[int] | None = None,
    ) -> AssignmentVerificationResult:
        deadline = time.time() + (timeout_ms / 1000)
        last_observed: list[str] = []
        target_keys = list(dict.fromkeys(pile_keys))
        target_tracking_by_key = {
            key: canonical_pile_tracking_key(tracking_keys[idx])
            for idx, key in enumerate(pile_keys)
            if tracking_keys and idx < len(tracking_keys) and norm(tracking_keys[idx])
        }
        target_tracking_set = {value for value in target_tracking_by_key.values() if value}
        matched_count = 0
        missing_count = len(target_keys)
        wrong_values: list[str] = []
        decisions: list[Any] = []
        page_candidates = list(dict.fromkeys(page for page in (source_pages or []) if page > 0))
        target_key_set = set(target_keys)
        while time.time() < deadline:
            self._heartbeat("reconcile")
            if page_candidates:
                current_rows: list[PileRow] = []
                seen_keys: set[str] = set()
                target_seen: set[str] = set()
                target_tracking_seen: set[str] = set()
                for page_number in page_candidates:
                    self._heartbeat("reconcile")
                    page_rows = self.reset_to_filtered_page(month_label, year_label, status_label, page_number)
                    for row in page_rows:
                        if row.key in seen_keys:
                            continue
                        seen_keys.add(row.key)
                        if row.key in target_key_set:
                            target_seen.add(row.key)
                        row_tracking_key = canonical_pile_tracking_key(row.tracking_key)
                        if row_tracking_key in target_tracking_set:
                            target_tracking_seen.add(row_tracking_key)
                        current_rows.append(row)
                    if target_key_set.issubset(target_seen) or (
                        target_tracking_set and target_tracking_set.issubset(target_tracking_seen)
                    ):
                        break
            else:
                current_rows = self.scan_status(month_label, year_label, status_label)
            rows_by_key = {row.key: row for row in current_rows}
            rows_by_tracking = {
                canonical_pile_tracking_key(row.tracking_key): row
                for row in current_rows
                if norm(row.tracking_key)
            }
            row_map = {}
            for key in target_keys:
                row = rows_by_key.get(key)
                if row is None:
                    tracking_key = target_tracking_by_key.get(key)
                    row = rows_by_tracking.get(tracking_key)
                if row is not None:
                    row_map[key] = row
            last_observed = [
                row_map[key].assigned if key in row_map else "<missing>"
                for key in target_keys
            ]
            matched_count = sum(
                1
                for key in target_keys
                if key in row_map and self._assignee_matches_assigned_text(expected_assignee, row_map[key].assigned)
            )
            missing_count = len(target_keys) - len(row_map)
            wrong_values = [
                row_map[key].assigned
                for key in target_keys
                if key in row_map and not self._assignee_matches_assigned_text(expected_assignee, row_map[key].assigned)
            ]
            expected_observations = {}
            observed_assignments = {}
            for key in target_keys:
                tracking_key = target_tracking_by_key.get(key) or key
                expected_observations[tracking_key] = {
                    "attempt_id": getattr(self, "assignment_attempt_ids", {}).get(tracking_key, ""),
                    "expected_assignee": expected_assignee,
                }
                if key in row_map:
                    observed_assignments[tracking_key] = row_map[key].assigned
            decisions = list(classify_assignment_observations(
                expected_observations,
                observed_assignments,
            ))
            matched_count = sum(
                decision.status == AttemptStatus.CONFIRMED_VISIBLE
                for decision in decisions
            )
            missing_count = sum(
                decision.status == AttemptStatus.RECONCILIATION_PENDING
                for decision in decisions
            )
            wrong_values = [
                str(decision.evidence.details.get("observed_assignee") or "")
                for decision in decisions
                if decision.status == AttemptStatus.CONFLICT
            ]
            if decisions and all(
                decision.status == AttemptStatus.CONFIRMED_VISIBLE
                for decision in decisions
            ):
                return AssignmentVerificationResult(
                    True,
                    last_observed,
                    matched_count,
                    missing_count,
                    wrong_values,
                    decisions,
                )
            if any(decision.status == AttemptStatus.CONFLICT for decision in decisions):
                return AssignmentVerificationResult(
                    False,
                    last_observed,
                    matched_count,
                    missing_count,
                    wrong_values,
                    decisions,
                )
            time.sleep(1)
        return AssignmentVerificationResult(
            False,
            last_observed,
            matched_count,
            missing_count,
            wrong_values,
            decisions,
        )

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
            ".p-multiselect-panel:visible",
            ".p-multiselect-overlay:visible",
            ".p-select-overlay:visible",
            ".p-dropdown-panel:visible",
            "[role='listbox']:visible",
        ]
        panels: list[tuple[int, float, float, Any]] = []
        seen_boxes: set[tuple[int, int, int, int]] = set()
        for priority, selector in enumerate(selectors):
            try:
                locs = self.page.locator(selector)
                for idx in range(locs.count()):
                    loc = locs.nth(idx)
                    if not loc.is_visible():
                        continue
                    box = loc.bounding_box()
                    if not box:
                        continue
                    fingerprint = (
                        round(box["x"]),
                        round(box["y"]),
                        round(box["width"]),
                        round(box["height"]),
                    )
                    if fingerprint in seen_boxes:
                        continue
                    seen_boxes.add(fingerprint)
                    area = box["width"] * box["height"]
                    panels.append((priority, box["y"], -area, loc))
            except Exception:
                continue
        panels.sort(key=lambda item: (item[1], item[0], item[2]))
        return [item[3] for item in panels]

    def _active_dropdown_root(self) -> Any:
        assert self.page
        panels = self._visible_dropdown_panels()
        return panels[-1] if panels else self.page

    def _active_multiselect_root(self) -> Any:
        assert self.page
        selectors = [
            ".p-multiselect-panel:visible",
            ".p-multiselect-overlay:visible",
            ".p-overlay:has(.p-multiselect-header):visible",
            ".p-overlay:has(.p-multiselect-list):visible",
        ]
        for selector in selectors:
            try:
                locs = self.page.locator(selector)
                for idx in range(locs.count() - 1, -1, -1):
                    loc = locs.nth(idx)
                    if loc.is_visible():
                        return loc
            except Exception:
                continue
        return self._active_dropdown_root()

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
            self._heartbeat("apply")
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
            control.locator("xpath=ancestor::*[contains(@class,'user-select-wrapper')][1]").first,
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

    @timed_operation('apply', 'modal')
    def _apply_assignment_modal(self, assignment_type: str, assignee_name: str, execute: bool) -> str:
        assert self.page
        # Per current workflow, keep the assign modal on its default Vetting path.
        assignment_type = "Vetting"
        roots = self._visible_overlay_roots()
        dialog = roots[-1] if roots else None
        control = None
        opened = False
        for attempt in range(1, 4):
            if attempt > 1:
                time.sleep(1.2)
            control = self._wait_for_assign_user_control(timeout_ms=9000)
            if control is not None:
                opened = self._open_select_control(control)
                if opened:
                    break
            try:
                if self._visible_dropdown_panels():
                    self.page.keyboard.press("Escape")
            except Exception:
                pass
        if control is None or not opened:
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
                            work_heartbeat = getattr(self, "work_heartbeat", None)
                            if work_heartbeat:
                                work_heartbeat("apply")
                                before_submit = getattr(self, "_before_assignment_submit", None)
                                if before_submit:
                                    before_submit()
                                # Ledger recording can block too. Recheck at the
                                # final boundary, not just before modal work.
                                work_heartbeat("apply")
                                try:
                                    button.click(force=True)
                                except Exception as error:
                                    raise AssignmentSubmissionUncertain() from error
                                clicked = True
                                break
                            button.click(force=True)
                            clicked = True
                            break
                    except (WorkOwnershipLost, AssignmentSubmissionUncertain):
                        raise
                    except Exception:
                        if getattr(self, "work_heartbeat", None):
                            raise
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
                if getattr(self, "work_heartbeat", None):
                    raise AssignmentSubmissionUncertain()
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
        self._heartbeat("plan")
        active_month = sample_pile.filter_month or month_label
        active_year = effective_filter_year(sample_pile, year_label)
        selected = 0
        current_rows: list[PileRow] = []
        page_candidates: list[int] = []
        for page_number in [sample_pile.page_number, 1, max(1, sample_pile.page_number - 1), sample_pile.page_number + 1, 2, 3]:
            if page_number not in page_candidates:
                page_candidates.append(page_number)
        for attempt in range(3):
            for page_number in page_candidates:
                current_rows = self.reset_to_filtered_page(active_month, active_year, sample_pile.status_bucket, page_number)
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

    def persist_assignment_plans(
        self,
        plans: list[PlannedAssignment],
        minimum_claim_chunk: int,
    ) -> None:
        self._heartbeat("plan")
        ledger = getattr(self, "execution_ledger", None)
        insurer_run_id = norm(getattr(self, "insurer_run_id", ""))
        if not ledger or not insurer_run_id:
            return
        attempt_ids = getattr(self, "assignment_attempt_ids", {})
        self.assignment_attempt_ids = attempt_ids
        unpersisted = [
            plan for plan in plans
            if plan.tracking_key not in attempt_ids
        ]
        grouped: dict[tuple[str, str, str, str, str, int], list[PlannedAssignment]] = {}
        for plan in unpersisted:
            key = (
                plan.assignee_id,
                plan.assignment_type,
                plan.status_bucket,
                plan.filter_month,
                norm(plan.filter_year),
                plan.source_page_number,
            )
            grouped.setdefault(key, []).append(plan)
        for grouped_plans in grouped.values():
            for plan_batch in chunk_planned_assignments(grouped_plans, minimum_claim_chunk):
                sample = plan_batch[0]
                batch_id = str(uuid.uuid4())
                attempts = []
                for plan in plan_batch:
                    attempt_id = str(uuid.uuid4())
                    attempts.append({
                        "id": attempt_id,
                        "tracking_key": plan.tracking_key,
                        "last_pile_key": plan.pile_key,
                        "claim_count": max(plan.remaining_claims, 0),
                        "attempt_number": getattr(self, "retry_attempt_numbers", {}).get(
                            canonical_pile_tracking_key(plan.tracking_key),
                            1,
                        ),
                        "filter_context": {
                            "month": plan.filter_month,
                            "year": norm(plan.filter_year),
                            "status": plan.status_bucket,
                            "source_page": plan.source_page_number,
                        },
                    })
                ledger.create_batch_with_attempts(
                    {
                        "id": batch_id,
                        "insurer_run_id": insurer_run_id,
                        "scan_context_id": self.scan_context_ids.get((
                            sample.filter_month,
                            norm(sample.filter_year),
                            sample.status_bucket,
                        )),
                        "insurer_name": sample.insurer_name,
                        "bot_account_id": sample.assignee_id,
                        "intended_owner_name": sample.assignee_name,
                        "intended_portal_assignee": sample.assignee_name,
                        "assignment_type": sample.assignment_type,
                        "status_bucket": sample.status_bucket,
                        "planned_claim_count": sum(max(plan.remaining_claims, 0) for plan in plan_batch),
                        "details": {"source_page": sample.source_page_number},
                    },
                    attempts,
                )
                for attempt in attempts:
                    attempt_ids[attempt["tracking_key"]] = attempt["id"]

    def _transition_assignment_attempts(
        self,
        plans: list[PlannedAssignment],
        target: Any,
        expected: set[Any],
        evidence: dict[str, Any] | None = None,
    ) -> None:
        ledger = getattr(self, "execution_ledger", None)
        if not ledger:
            return
        for plan in plans:
            attempt_id = self.assignment_attempt_ids.get(plan.tracking_key)
            if not attempt_id:
                raise RuntimeError(
                    f"Assignment attempt for tracking key '{plan.tracking_key}' was not persisted."
                )
            ledger.transition_attempt(
                attempt_id,
                target,
                expected=expected,
                evidence=evidence,
            )

    def execute_assignment_plan(
        self,
        month_labels: list[str],
        year_label: str,
        plans: list[PlannedAssignment],
        execute: bool,
        minimum_claim_chunk: int = 25,
    ) -> tuple[dict[str, int], list[AppliedAssignment]]:
        if execute:
            self.persist_assignment_plans(plans, minimum_claim_chunk)
        results: dict[str, int] = {}
        applied: list[AppliedAssignment] = []
        for filter_month, filter_year in assignment_filter_contexts(month_labels, year_label, plans):
            for status_label in TARGET_STATUSES:
                pending_status_plans = [
                    plan for plan in plans
                    if plan.status_bucket == status_label
                    and plan.filter_month == filter_month
                    and (norm(plan.filter_year) or year_label) == filter_year
                ]
                if not pending_status_plans:
                    continue
                self._heartbeat("apply")
                print(f"\nApplying assignments for year/month/status: {filter_year} / {filter_month} / {status_label}")
                self.open_piles()
                self.apply_filters(filter_month, filter_year, status_label)
                self.try_set_page_size(100)
                page_number = 1
                seen_pages = set()
                while True:
                    self._heartbeat("apply")
                    current_rows = self.rows_on_current_page(status_label, page_number, filter_month, filter_year)
                    fingerprint = tuple(row.key for row in current_rows)
                    if fingerprint in seen_pages:
                        break
                    seen_pages.add(fingerprint)
                    current_keys = {row.key for row in current_rows}
                    page_plans = [plan for plan in pending_status_plans if plan.pile_key in current_keys]
                    if page_plans:
                        grouped: dict[tuple[str, str], list[PlannedAssignment]] = {}
                        for plan in page_plans:
                            grouped.setdefault((plan.assignee_name, plan.assignment_type), []).append(plan)
                        grouped_items = [
                            (group_key, batch)
                            for group_key, grouped_plans in grouped.items()
                            for batch in chunk_planned_assignments(grouped_plans, minimum_claim_chunk)
                        ]
                        for group_index, ((assignee_name, assignment_type), group) in enumerate(grouped_items):
                            self._heartbeat("apply")
                            requested_keys = [plan.pile_key for plan in group]
                            selected_keys: list[str] = []
                            missing_keys = requested_keys[:]
                            partial_selection_detected = False
                            deferred_missing_keys: list[str] = []

                            if group_index > 0:
                                current_rows = self.reset_to_filtered_page(filter_month, filter_year, status_label, page_number)

                            selection = self._select_rows(requested_keys, current_rows)
                            if selection.selected_keys:
                                selected_keys.extend(selection.selected_keys)
                            missing_keys = [key for key in requested_keys if key not in selected_keys]
                            if missing_keys:
                                partial_selection_detected = bool(selected_keys)
                                if partial_selection_detected:
                                    print(
                                        f"  Partial row selection detected for '{assignee_name}' "
                                        f"in {status_label}: selected {len(selected_keys)}/{len(requested_keys)}. "
                                        "Deferring unstable pile rows to a follow-up pass so the already-selected rows stay intact..."
                                    )
                                    deferred_missing_keys = missing_keys[:]
                                else:
                                    print(
                                        f"  Planned pile rows for '{assignee_name}' moved before selection completed "
                                        f"in {status_label}. Trying to relocate them across the filtered pages..."
                                    )
                                    for missing_key in missing_keys[:]:
                                        recovered = False
                                        for retry in range(2):
                                            located_row = self.find_filtered_row_by_key(
                                                filter_month,
                                                filter_year,
                                                status_label,
                                                missing_key,
                                                preferred_page=next(
                                                    (plan.source_page_number for plan in group if plan.pile_key == missing_key),
                                                    page_number,
                                                ),
                                                current_page=page_number,
                                            )
                                            if located_row is None:
                                                break
                                            current_rows = self.reset_to_filtered_page(
                                                filter_month,
                                                filter_year,
                                                status_label,
                                                located_row.page_number,
                                            )
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
                                        else:
                                            deferred_missing_keys.append(missing_key)

                            if not selected_keys:
                                continue

                            selected_group = [plan for plan in group if plan.pile_key in selected_keys]
                            if execute:
                                self._transition_assignment_attempts(
                                    selected_group,
                                    AttemptStatus.SELECTED,
                                    {AttemptStatus.PLANNED},
                                )
                            selected_assignee, applied_group = self._apply_selected_group(
                                filter_month,
                                filter_year,
                                status_label,
                                assignee_name,
                                assignment_type,
                                selected_group,
                                execute,
                            )
                            if partial_selection_detected:
                                print(
                                    f"  Recovered all {len(selected_group)} planned pile(s) for '{assignee_name}' "
                                    f"after retrying individual row selection."
                                )
                            results[selected_assignee] = results.get(selected_assignee, 0) + len(selected_group)
                            applied.extend(applied_group)
                            applied_keys = {plan.pile_key for plan in selected_group}
                            pending_status_plans = [
                                plan for plan in pending_status_plans if plan.pile_key not in applied_keys
                            ]
                            if deferred_missing_keys:
                                print(
                                    f"  Deferred {len(deferred_missing_keys)} unstable pile(s) for '{assignee_name}' "
                                    f"to a follow-up selection pass."
                                )
                    if not self.goto_next_page(
                        filter_month,
                        filter_year,
                        status_label,
                        next_page=page_number + 1,
                    ):
                        break
                    page_number += 1
                if pending_status_plans:
                    print(
                        f"\nFollow-up selection pass for {len(pending_status_plans)} deferred pile(s) "
                        f"in {filter_month} / {status_label}..."
                    )
                for recovery_round in range(2):
                    self._heartbeat("reconcile")
                    if not pending_status_plans:
                        break
                    page_candidates: list[int] = []
                    for plan in pending_status_plans:
                        for page_candidate in self._page_candidates_for_plan(plan):
                            if page_candidate not in page_candidates:
                                page_candidates.append(page_candidate)
                    for recovery_page in page_candidates:
                        self._heartbeat("reconcile")
                        if not pending_status_plans:
                            break
                        current_rows = self.reset_to_filtered_page(
                            filter_month,
                            filter_year,
                            status_label,
                            recovery_page,
                        )
                        selectable_rows = [row for row in current_rows if not norm(row.assigned)]
                        rows_by_key = {row.key: row for row in selectable_rows}
                        rows_by_tracking = {row.tracking_key: row for row in selectable_rows}
                        page_plans: list[PlannedAssignment] = []
                        for plan in pending_status_plans:
                            matched_row = rows_by_key.get(plan.pile_key) or rows_by_tracking.get(plan.tracking_key)
                            if matched_row is None:
                                continue
                            plan.pile_key = matched_row.key
                            plan.source_page_number = matched_row.page_number
                            page_plans.append(plan)
                        if not page_plans:
                            continue
                        grouped: dict[tuple[str, str], list[PlannedAssignment]] = {}
                        for plan in page_plans:
                            grouped.setdefault((plan.assignee_name, plan.assignment_type), []).append(plan)
                        grouped_items = [
                            (group_key, batch)
                            for group_key, grouped_plans in grouped.items()
                            for batch in chunk_planned_assignments(grouped_plans, minimum_claim_chunk)
                        ]
                        for group_index, ((assignee_name, assignment_type), group) in enumerate(grouped_items):
                            if group_index > 0:
                                current_rows = self.reset_to_filtered_page(
                                    filter_month,
                                    filter_year,
                                    status_label,
                                    recovery_page,
                                )
                            requested_keys = [plan.pile_key for plan in group]
                            selection = self._select_rows(requested_keys, current_rows)
                            if not selection.selected_keys:
                                continue
                            selected_group = [plan for plan in group if plan.pile_key in selection.selected_keys]
                            if execute:
                                self._transition_assignment_attempts(
                                    selected_group,
                                    AttemptStatus.SELECTED,
                                    {AttemptStatus.PLANNED},
                                )
                            selected_assignee, applied_group = self._apply_selected_group(
                                filter_month,
                                filter_year,
                                status_label,
                                assignee_name,
                                assignment_type,
                                selected_group,
                                execute,
                            )
                            results[selected_assignee] = results.get(selected_assignee, 0) + len(selected_group)
                            applied.extend(applied_group)
                            selected_keys = {plan.pile_key for plan in selected_group}
                            pending_status_plans = [
                                pending_plan for pending_plan in pending_status_plans if pending_plan.pile_key not in selected_keys
                            ]
                    if pending_status_plans:
                        time.sleep(0.5)

                if pending_status_plans:
                    final_unassigned = self.scan_status(filter_month, filter_year, status_label, only_unassigned=True)
                    unassigned_by_key = {row.key: row for row in final_unassigned}
                    unassigned_by_tracking = {row.tracking_key: row for row in final_unassigned}
                    still_visible: list[PlannedAssignment] = []
                    no_longer_unassigned: list[PlannedAssignment] = []
                    for plan in pending_status_plans:
                        matched_row = unassigned_by_key.get(plan.pile_key) or unassigned_by_tracking.get(plan.tracking_key)
                        if matched_row:
                            still_visible.append(plan)
                        else:
                            no_longer_unassigned.append(plan)
                    if no_longer_unassigned:
                        print(
                            f"  Warning: {len(no_longer_unassigned)} planned pile(s) were no longer visible as "
                            f"unassigned in {filter_month} / {status_label}; leaving them for the next scan."
                        )
                    if still_visible:
                        unresolved = ", ".join(plan.pile_key for plan in still_visible[:3])
                        if len(still_visible) > 3:
                            unresolved += f", +{len(still_visible) - 3} more"
                        raise RuntimeError(
                            f"Could not reliably relocate {len(still_visible)} planned pile(s) for "
                            f"status '{status_label}' after a follow-up pass. Remaining: {unresolved}"
                        )
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
    grace_ends_local = shift_grace_end_local(bot, now_utc)
    if grace_ends_local is None:
        return False, ""
    local_now = now_utc.astimezone(RUNNER_TIMEZONE)
    grace_minutes = max(0, safe_int(bot.shift_grace_minutes, 120))
    if local_now < grace_ends_local:
        return True, (
            f"{bot.owner_name or bot.portal_name} is within shift grace until "
            f"{grace_ends_local.strftime('%H:%M')} {RUNNER_TIMEZONE.key} "
            f"(starts {format_clock_label(bot.active_from_time)}, grace {grace_minutes} mins)."
        )
    return False, ""


def shift_grace_end_local(bot: BotAccount, now_utc: datetime) -> datetime | None:
    start_minutes = parse_clock_minutes(bot.active_from_time)
    if start_minutes is None:
        return None

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

    return shift_start_local + timedelta(minutes=grace_minutes)


def is_shift_ready_for_reassignment(bot: BotAccount, now_utc: datetime) -> bool:
    hold, _ = shift_reassignment_hold(bot, now_utc)
    return not hold


def stale_reason_for_reassignment(
    *,
    bot: BotAccount | None,
    remaining_claims: int,
    idle_since: datetime | None,
    has_meaningful_progress: bool,
    now_utc: datetime,
    rule: AssignmentRule | None,
) -> str | None:
    if not rule or remaining_claims < rule.stale_claim_threshold:
        return None

    if bot is not None:
        hold_reassignment, _ = shift_reassignment_hold(bot, now_utc)
        if hold_reassignment:
            return None

    if not has_meaningful_progress:
        cutoff = shift_grace_end_local(bot, now_utc) if bot is not None else None
        if cutoff is not None:
            local_now = now_utc.astimezone(RUNNER_TIMEZONE)
            if local_now < cutoff:
                return None
            return (
                f"No progress recorded by the shift grace cutoff "
                f"({cutoff.strftime('%H:%M')} {RUNNER_TIMEZONE.key}) with {remaining_claims} claims still open."
            )
        return f"No progress recorded with {remaining_claims} claims still open."

    idle_minutes = 0
    if idle_since is not None:
        idle_minutes = max(int((now_utc - idle_since).total_seconds() / 60), 0)
    if idle_minutes >= rule.reassignment_threshold_minutes:
        return f"No meaningful progress for {idle_minutes} mins with {remaining_claims} claims still open."
    return None


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
        if not bot.is_active or not bot.is_available or bot.availability_status not in AVAILABLE_BOT_STATUSES:
            continue
        if require_shift_ready and not is_shift_ready_for_reassignment(bot, now_utc):
            continue
        metric = metrics.get(bot.id)
        observed_speed = metric.claims_per_hour if metric and metric.claims_per_hour > 0 else 0
        base_speed = assignment_planning_speed(bot.assignment_role, observed_speed, 0.0)
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
    scanned_rows: list[PileRow] | None = None,
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

    print("\nReconciling tracked assigned piles...")
    if scanned_rows is None:
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
        scanned_rows = runner.scan_all_rows(months or requested_month_labels, year_label)
    row_map: dict[str, PileRow] = {}
    for row in scanned_rows:
        existing = row_map.get(row.tracking_key)
        if existing is None or (not norm(existing.assigned) and norm(row.assigned)):
            row_map[row.tracking_key] = row
        if norm(row.legacy_tracking_key):
            legacy_existing = row_map.get(row.legacy_tracking_key)
            if legacy_existing is None or (not norm(legacy_existing.assigned) and norm(row.assigned)):
                row_map[row.legacy_tracking_key] = row

    now = datetime.now(timezone.utc)
    bots_by_id = {bot.id: bot for bot in bots}
    stale_candidates: list[ReassignmentCandidate] = []
    completed_count = 0
    refreshed_tracked: list[TrackedPile] = []
    for tracked_pile in tracked:
        observed = row_map.get(tracked_pile.tracking_key) or row_map.get(canonical_pile_tracking_key(tracked_pile.tracking_key))
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
            has_meaningful_progress = bool(parse_iso_datetime(tracked_pile.last_progress_at)) or current_completed > 0
            stale_reason = stale_reason_for_reassignment(
                bot=current_assignee_bot,
                remaining_claims=observed.remaining_claims,
                idle_since=idle_since,
                has_meaningful_progress=has_meaningful_progress,
                now_utc=now,
                rule=rule,
            )
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
            stale_candidates.append(ReassignmentCandidate(
                source_kind="tracked",
                source_id=updated.id,
                assignment_type=updated.assignment_type or observed.assignment_type,
                observed_row=observed,
                current_bot=matched_bot,
                source_tracking_key=updated.tracking_key,
            ))

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
    rule: AssignmentRule | None,
) -> dict[str, Any]:
    existing_records = store.get_active_external_assignments(insurer_name)
    existing_by_tracking: dict[str, ExternalAssignment] = {}
    for record in existing_records:
        if not norm(record.tracking_key):
            continue
        existing_by_tracking[record.tracking_key] = record
        existing_by_tracking[canonical_pile_tracking_key(record.tracking_key)] = record
    tracked_key_set = expanded_tracking_key_set(tracked_keys)
    candidate_rows_by_tracking: dict[str, list[PileRow]] = {}
    matched_bot_by_tracking: dict[str, BotAccount] = {}
    unmapped_assignment_count = 0
    unmapped_assignment_claims = 0
    unmapped_assignment_samples: list[dict[str, Any]] = []
    for row in rows:
        if not norm(row.assigned):
            continue
        matched_bot = match_bot_to_portal_name(bots, row.assigned) if bots else None
        if matched_bot is None:
            unmapped_assignment_count += 1
            unmapped_assignment_claims += max(row.claims, 0)
            if len(unmapped_assignment_samples) < 10:
                unmapped_assignment_samples.append({
                    "assigned": row.assigned,
                    "provider": row.provider,
                    "claim_month": row.month,
                    "submitted_date": row.submitted_date,
                    "claims_total": row.claims,
                    "amount": row.amount_text,
                    "status_bucket": row.status_bucket,
                })
            continue
        row_keys = expanded_tracking_key_set([row.tracking_key, row.legacy_tracking_key])
        if row_keys & tracked_key_set:
            continue
        candidate_rows_by_tracking.setdefault(row.tracking_key, []).append(row)
        matched_bot_by_tracking[row.tracking_key] = matched_bot

    if unmapped_assignment_count:
        store.log_runner_event(
            insurer_name=insurer_name,
            event_type="external_assignment_unmapped_assignee_skipped",
            status="skipped",
            pile_count=unmapped_assignment_count,
            claim_count=unmapped_assignment_claims,
            details={
                "reason": "Assigned portal rows were skipped because their assignee did not match any configured bot owner/account.",
                "sample_count": len(unmapped_assignment_samples),
                "samples": unmapped_assignment_samples,
            },
        )

    assigned_rows_by_tracking: dict[str, PileRow] = {}
    skipped_active_tracking_keys: set[str] = set()
    identity_collision_count = 0
    for tracking_key, matches in candidate_rows_by_tracking.items():
        distinct_volatile_keys = {row.key for row in matches if norm(row.key)}
        if len(distinct_volatile_keys) > 1:
            identity_collision_count += 1
            skipped_active_tracking_keys.add(tracking_key)
            sample = matches[0]
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="external_assignment_identity_collision",
                status="skipped",
                pile_count=len(matches),
                claim_count=sum(max(row.claims, 0) for row in matches),
                details={
                    "reason": "Multiple assigned rows shared the same stable tracking key, so external detection skipped them to avoid a false callout.",
                    "tracking_key": tracking_key,
                    "volatile_keys": sorted(distinct_volatile_keys)[:10],
                    "provider": sample.provider,
                    "claim_month": sample.month,
                    "submitted_date": sample.submitted_date,
                    "amount": sample.amount_text,
                    "claims_total": sample.claims,
                    "assigned_values": sorted({norm(row.assigned) for row in matches if norm(row.assigned)}),
                },
            )
            continue
        row = matches[0]
        existing = assigned_rows_by_tracking.get(row.tracking_key)
        if existing is None or (not norm(existing.assigned) and norm(row.assigned)):
            assigned_rows_by_tracking[row.tracking_key] = row

    notifications: list[ExternalNotificationItem] = []
    stale_candidates: list[ReassignmentCandidate] = []
    active_tracking_keys = expanded_tracking_key_set([
        *assigned_rows_by_tracking.keys(),
        *skipped_active_tracking_keys,
    ])
    new_detection_count = 0
    now = datetime.now(timezone.utc)

    for row in assigned_rows_by_tracking.values():
        previous_record = existing_by_tracking.get(row.tracking_key) or existing_by_tracking.get(canonical_pile_tracking_key(row.tracking_key))
        matched_bot = matched_bot_by_tracking.get(row.tracking_key)
        if matched_bot is None:
            continue
        progress_claims = max(0, row.synced_claims - safe_int(previous_record.synced_claims if previous_record else 0, 0))
        last_progress_at = (
            now.isoformat()
            if progress_claims > 0
            else norm((previous_record.details or {}).get("last_progress_at")) if previous_record and isinstance(previous_record.details, dict) else ""
        )
        record, is_new = store.save_external_assignment(
            master_account_id,
            insurer_name,
            row,
            matched_bot,
            last_progress_at=last_progress_at,
        )
        if matched_bot is not None:
            idle_since = parse_iso_datetime(last_progress_at or record.first_detected_at or record.last_seen_at)
            has_meaningful_progress = bool(last_progress_at) or row.synced_claims > 0 or safe_int(record.synced_claims, 0) > 0
            stale_reason = stale_reason_for_reassignment(
                bot=matched_bot,
                remaining_claims=row.remaining_claims,
                idle_since=idle_since,
                has_meaningful_progress=has_meaningful_progress,
                now_utc=now,
                rule=rule,
            )
            if stale_reason:
                stale_candidates.append(ReassignmentCandidate(
                    source_kind="external",
                    source_id=record.id,
                    assignment_type=record.assignment_type or row.assignment_type,
                    observed_row=row,
                    current_bot=matched_bot,
                    source_tracking_key=record.tracking_key,
                ))
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
                "legacy_tracking_key": row.legacy_tracking_key,
                "identity_version": "stable_v2",
                "pile_key": row.key,
                "provider": row.provider,
                "claim_month": row.month,
                "submitted_date": row.submitted_date,
                "amount": row.amount_text,
                "claims_total": row.claims,
                "synced_claims": row.synced_claims,
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
        "identity_collision_count": identity_collision_count,
        "notifications": notifications,
        "stale_candidates": stale_candidates,
    }


def build_stale_reassignment_plans(
    insurer_name: str,
    stale_candidates: list[ReassignmentCandidate],
    bots: list[BotAccount],
    metrics: dict[str, BotMetric],
    rule: AssignmentRule | None,
) -> tuple[list[PlannedAssignment], dict[str, dict[str, Any]]]:
    if not stale_candidates or not rule or rule.distribution_mode != "balanced_finish":
        return [], {}

    now_utc = datetime.now(timezone.utc)
    plans: list[PlannedAssignment] = []
    summary: dict[str, dict[str, Any]] = {}
    for candidate in stale_candidates:
        observed_row = candidate.observed_row
        current_bot = candidate.current_bot
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
            assignment_planning_speed(current_bot.assignment_role, current_observed_speed, 0.0)
            * role_capacity_weight(current_bot.assignment_role, current_bot.support_capacity_ratio),
            1,
        )
        current_remaining_minutes = projected_finish_minutes((current_metric.active_claim_load if current_metric else current_bot.current_claim_load) / max(current_speed, 1))

        target_metric = metrics.get(target.id)
        target_observed_speed = target_metric.claims_per_hour if target_metric and target_metric.claims_per_hour > 0 else 0
        target_speed = max(
            assignment_planning_speed(target.assignment_role, target_observed_speed, 0.0)
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
            assignment_type=candidate.assignment_type or observed_row.assignment_type,
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
            filter_year=observed_row.filter_year,
            source_page_number=observed_row.page_number,
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
    rule: AssignmentRule | None = None,
    effective_at: datetime | None = None,
) -> tuple[list[PlannedAssignment], dict[str, dict[str, Any]]]:
    active_rule = rule or AssignmentRule(
        insurer_name=insurer_name,
        distribution_mode="balanced_finish",
        minimum_claim_chunk=25,
        reassignment_threshold_minutes=120,
        stale_claim_threshold=40,
        target_completion_gap_minutes=30,
    )

    def resolve_speed(bot: BotAccount, metric: BotMetric | None) -> float:
        observed_speed = metric.claims_per_hour if metric and metric.claims_per_hour > 0 else 0
        base_speed = assignment_planning_speed(bot.assignment_role, observed_speed, 0.0)
        return max(
            base_speed * role_capacity_weight(bot.assignment_role, bot.support_capacity_ratio),
            1,
        )

    eligibility = evaluate_eligible_bots(bots, effective_at=effective_at)
    if active_rule.distribution_mode != "manual_override" and not eligibility.eligible:
        bots_by_id = {bot.id: bot for bot in bots}
        exclusions = []
        for exclusion in eligibility.exclusions:
            bot = bots_by_id.get(exclusion.subject_id)
            owner = norm(bot.owner_name if bot else "") or norm(bot.portal_name if bot else "") or exclusion.subject_id
            reason = exclusion.reason_code
            if bot and reason == "outside_active_window":
                reason += f": {norm(bot.active_from_time) or 'start'}-{norm(bot.active_to_time) or 'end'}"
            exclusions.append(f"{owner} ({reason})")
        detail = ", ".join(exclusions) or "no bot accounts were configured"
        raise RuntimeError(
            "No eligible bot accounts are available for assignment. "
            f"Safe exclusions: {detail}."
        )

    planning = plan_assignments(
        active_rule.distribution_mode,
        piles,
        bots,
        metrics,
        active_rule,
        effective_at=effective_at,
        primary_min_share=PRIMARY_ASSIGNMENT_FLOOR_RATIO,
        speed_resolver=resolve_speed,
    )
    plans = [
        PlannedAssignment(
            pile_key=decision.pile.key,
            tracking_key=decision.pile.tracking_key,
            assignee_id=decision.bot.id,
            assignee_name=decision.bot.portal_name,
            assignment_type=decision.pile.assignment_type,
            insurer_name=insurer_name,
            provider=decision.pile.provider,
            claim_month=decision.pile.month,
            submitted_date=decision.pile.submitted_date,
            claims=decision.pile.claims,
            synced_claims=decision.pile.synced_claims,
            remaining_claims=decision.work_claims,
            current_status=decision.pile.status,
            status_bucket=decision.pile.status_bucket,
            filter_month=decision.pile.filter_month,
            filter_year=decision.pile.filter_year,
            source_page_number=decision.pile.page_number,
            legacy_tracking_key=decision.pile.legacy_tracking_key,
        )
        for decision in planning.plans
    ]

    eligible = eligibility.eligible
    assigned_by_bot = {
        bot.id: [decision for decision in planning.plans if decision.bot.id == bot.id]
        for bot in eligible
    }
    summary = {}
    for bot in eligible:
        metric = metrics.get(bot.id)
        speed = resolve_speed(bot, metric)
        starting_load = metric.active_claim_load if metric else bot.current_claim_load
        assigned_claims = sum(item.work_claims for item in assigned_by_bot[bot.id])
        projected_hours = (starting_load + assigned_claims) / speed
        summary[bot.id] = {
            "assignee_name": bot.portal_name,
            "assignment_role": bot.assignment_role,
            "effective_speed": round(speed, 2),
            "starting_claim_load": starting_load,
            "starting_load": starting_load,
            "assigned_piles": len(assigned_by_bot[bot.id]),
            "assigned_claims": assigned_claims,
            "projected_finish_hours": round(projected_hours, 2),
            "projected_finish_minutes": projected_finish_minutes(projected_hours),
        }
    return plans, summary


def build_assignment_plan_from_portal_options(
    insurer_name: str,
    piles: list[PileRow],
    portal_assignees: list[PortalAssignee],
) -> tuple[list[PlannedAssignment], dict[str, dict[str, Any]]]:
    eligible = []
    for assignee in portal_assignees:
        base_speed = assignment_planning_speed(assignee.assignment_role, 0, 0)
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
    sorted_piles = sorted(piles, key=lambda item: item.claims, reverse=True)
    remaining_piles = list(sorted_piles)
    primary_entries = [entry for entry in eligible if assignment_entry_role(entry).lower() == "primary"]

    if primary_entries and len(primary_entries) < len(eligible):
        primary_floor_claims = max(1, math.ceil(sum(pile.claims for pile in sorted_piles) * PRIMARY_ASSIGNMENT_FLOOR_RATIO))
        primary_claims_assigned = 0
        while remaining_piles and primary_claims_assigned < primary_floor_claims:
            pile = remaining_piles.pop(0)
            chosen = choose_assignment_entry(primary_entries)
            apply_assignment_entry(chosen, pile)
            primary_claims_assigned += pile.claims
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
                filter_year=pile.filter_year,
                source_page_number=pile.page_number,
            ))

    for pile in remaining_piles:
        chosen = choose_assignment_entry(eligible)
        apply_assignment_entry(chosen, pile)
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
            filter_year=pile.filter_year,
            source_page_number=pile.page_number,
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
        if bot.is_active and bot.is_available and bot.availability_status in AVAILABLE_BOT_STATUSES
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
    parser.add_argument("--month", help="Month label(s) to filter, e.g. 'All' or 'May,Jun'. Default is All")
    parser.add_argument("--year", help="Year label to filter, e.g. 'All' or '2026'. Default is All")
    parser.add_argument("--visible", action="store_true", help="Run with a visible browser")
    parser.add_argument("--execute", action="store_true", help="Actually click Assign Claims. Default is dry-run.")
    parser.add_argument("--read-only", action="store_true", help="Use an in-memory execution ledger instead of writing new reliability state.")
    parser.add_argument("--adopt-preview-run", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--run-id", default="", help="Adopt a runner run record pre-created by an asynchronous launcher.")
    parser.add_argument("--slow-mo", type=int, default=350, help="Playwright slow_mo in ms for visual debugging")
    parser.add_argument("--out", default="tmp/piles_auto_assignment_plan.json", help="Where to write the dry-run plan/output JSON")
    parser.add_argument("--run-source", choices=[source.value for source in WorkSource], default="manual", help="Trusted invocation source supplied by the launcher.")
    parser.add_argument("--invocation-backend", default=norm(os.getenv("PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND")) or "local", help="Which compute backend launched this run, e.g. local or remote.")
    parser.add_argument("--effective-date", default=norm(os.getenv("PILES_AUTO_ASSIGNMENT_EFFECTIVE_DATE")), help="Override the local date used for weekend roster selection, e.g. 2026-05-23.")
    return parser.parse_args()


def is_retryable_runner_browser_error(exc: Exception) -> bool:
    phrases = (
        "target page, context or browser has been closed",
        "target closed",
        "browser has been closed",
        "page has been closed",
        "context has been closed",
    )
    seen: set[int] = set()
    pending: list[BaseException | None] = [exc]
    while pending:
        current = pending.pop()
        if current is None:
            continue
        marker = id(current)
        if marker in seen:
            continue
        seen.add(marker)
        message = norm(str(current)).lower()
        if any(phrase in message for phrase in phrases):
            return True
        pending.append(getattr(current, "__cause__", None))
        pending.append(getattr(current, "__context__", None))
    return False


def is_retryable_scan_error(exc: Exception) -> bool:
    """Recognize bounded, read-safe portal failures that a page reload can recover."""
    phrases = (
        "no completed piles data request confirmed",
        "piles filters were not confirmed: filter_settlement_timeout",
        "piles filters were not confirmed: filter_dom_response_mismatch",
        "piles table did not settle into a readable row state",
        "piles table did not match the selected page size response",
    )
    seen: set[int] = set()
    pending: list[BaseException | None] = [exc]
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        if any(phrase in norm(str(current)).lower() for phrase in phrases):
            return True
        pending.extend([
            getattr(current, "__cause__", None),
            getattr(current, "__context__", None),
        ])
    return False


def runner_effective_date(args: argparse.Namespace) -> str:
    override = norm(getattr(args, "effective_date", ""))
    if override:
        try:
            return datetime.strptime(override, "%Y-%m-%d").date().isoformat()
        except Exception:
            raise RuntimeError(f"Invalid --effective-date '{override}'. Use YYYY-MM-DD.")
    return datetime.now(RUNNER_TIMEZONE).date().isoformat()


def overlap_probe_failure(read_only: bool, insurer_name: str) -> str | None:
    if not read_only:
        return None
    return f"Read-only probe skipped {insurer_name} because another runner held its lock."


def should_send_external_assignment_alert(
    args: argparse.Namespace,
    notification_items: list[Any],
) -> bool:
    return bool(notification_items) and not bool(getattr(args, "read_only", False))


def _run_for_insurer_once(
    store: DataStore,
    args: argparse.Namespace,
    insurer_name: str,
    month_labels: list[str],
    year_label: str,
    visible: bool,
    execution_ledger: Any = None,
    insurer_run_id: str = "",
) -> dict[str, Any]:
    captured_at = datetime.now(timezone.utc).isoformat()
    master = store.get_master_account(insurer_name)
    if not master.is_active:
        raise RuntimeError(
            f"Master account for '{insurer_name}' is inactive. Enable it in Master Insurer Credentials before running it."
        )
    if not master.login_email or not master.login_password:
        raise RuntimeError(f"Master account for '{insurer_name}' is missing login email or password.")

    configured_bots = store.get_bot_accounts(insurer_name)
    bots = configured_bots[:]
    effective_date = runner_effective_date(args)
    weekend_policy = store.get_weekend_roster_policy(
        effective_date=effective_date,
        insurer_name=insurer_name,
        bots=configured_bots,
    )
    if weekend_policy is not None:
        if weekend_policy.missing_reason:
            print("=" * 72)
            print("Piles Auto-Assignment Runner")
            print(f"Insurer: {insurer_name}")
            print(f"Weekend roster date: {weekend_policy.effective_date}")
            print(f"Weekend roster skip: {weekend_policy.missing_reason}")
            print("=" * 72)
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="weekend_roster_missing_mapping",
                status="skipped",
                details={
                    "insurer_name": insurer_name,
                    "effective_date": weekend_policy.effective_date,
                    "roster_id": weekend_policy.roster_id or None,
                    "weekend_start": weekend_policy.weekend_start,
                    "weekend_end": weekend_policy.weekend_end,
                    "on_shift_owner_names": weekend_policy.on_shift_owner_names,
                    "off_duty_owner_names": weekend_policy.off_duty_owner_names,
                    "missing_reason": weekend_policy.missing_reason,
                    "mode": "execute" if args.execute else "dry-run",
                },
            )
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="weekend_roster_skipped_insurer",
                status="skipped",
                details={
                    "insurer_name": insurer_name,
                    "effective_date": weekend_policy.effective_date,
                    "reason": weekend_policy.missing_reason,
                },
            )
            return {
                "insurer_name": insurer_name,
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "tracked_reconcile": {"tracked_count": 0, "completed_count": 0, "stale_count": 0, "active_count": 0},
                "reassignment_plans": [],
                "reassignment_summary": {},
                "reassignment_results": {},
                "reassignment_applied": [],
                "unassigned": [],
                "plans": [],
                "summary": {},
                "results": {},
                "applied": [],
                "fallback_pool_used": False,
                "portal_option_names": [],
                "resolved_name_map": {},
                "portal_mapping_warnings": [weekend_policy.missing_reason],
                "notification_items": [],
                "external_notification_items": [],
                "late_arrival_detection": {"count": 0, "claims": 0, "piles": [], "summary": {}, "results": {}, "contexts": []},
            }
        bots = weekend_policy.eligible_bots
        paused_weekend_bots = [bot for bot in configured_bots if bot.is_active and bot.id not in {eligible.id for eligible in bots}]
        weekend_state_inserted = 0
        if args.execute:
            bots, paused_weekend_bots, weekend_state_inserted = store.apply_weekend_bot_state(weekend_policy, configured_bots)
        if weekend_state_inserted:
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="weekend_roster_state_applied",
                status="applied",
                details={
                    "insurer_name": insurer_name,
                    "effective_date": weekend_policy.effective_date,
                    "roster_id": weekend_policy.roster_id,
                    "eligible_bot_ids": [bot.id for bot in bots],
                    "eligible_bot_names": [bot.portal_name for bot in bots],
                    "paused_bot_ids": [bot.id for bot in paused_weekend_bots],
                    "paused_owners": [bot.owner_name for bot in paused_weekend_bots],
                },
            )
            send_weekend_schedule_update(
                insurer_name=insurer_name,
                policy=weekend_policy,
                eligible_bots=bots,
                paused_bots=paused_weekend_bots,
            )
        elif weekend_policy is not None and not args.execute:
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="weekend_roster_preview",
                status="preview",
                details={
                    "insurer_name": insurer_name,
                    "effective_date": weekend_policy.effective_date,
                    "roster_id": weekend_policy.roster_id,
                    "eligible_bot_ids": [bot.id for bot in bots],
                    "eligible_bot_names": [bot.portal_name for bot in bots],
                    "would_pause_bot_ids": [bot.id for bot in paused_weekend_bots],
                    "would_pause_owners": [bot.owner_name for bot in paused_weekend_bots],
                },
            )

    metrics = store.get_bot_metrics([bot.id for bot in configured_bots])
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
        "contexts": [],
    }
    reassignment_plans: list[PlannedAssignment] = []
    reassignment_summary: dict[str, dict[str, Any]] = {}
    reassignment_results: dict[str, int] = {}
    reassignment_applied: list[AppliedAssignment] = []
    reassignment_previous_owner_by_tracking: dict[str, BotAccount] = {}
    reassignment_source_by_tracking: dict[str, ReassignmentCandidate] = {}
    slack_thread_ts = ""
    slack_replies_sent = 0
    reconciliation_manual_count = 0
    reconciliation_manual_keys: set[str] = set()
    prior_attempt_keys: set[str] = set()
    scan_context_summary: dict[str, int] | None = None

    print("=" * 72)
    print("Piles Auto-Assignment Runner")
    print(f"Insurer: {insurer_name}")
    print(f"Portal environment: {PORTAL_ENVIRONMENT}")
    print(f"Portal: {CURACEL_BASE_URL}")
    print(f"Month/Year: {', '.join(month_labels)} {year_label}")
    print(f"Mode: {'EXECUTE' if args.execute else 'DRY RUN'}")
    if weekend_policy is not None:
        print(
            f"Weekend roster: {weekend_policy.weekend_start} to {weekend_policy.weekend_end} "
            f"| on shift: {', '.join(weekend_policy.on_shift_owner_names) or '—'}"
        )
        print(
            "Weekend eligible bots: "
            + (", ".join(f"{bot.owner_name} -> {bot.portal_name} ({bot.assignment_role})" for bot in bots) or "—")
        )
    if rule:
        print(f"Rule mode: {rule.distribution_mode} | min chunk: {rule.minimum_claim_chunk}")
    print("=" * 72)

    if weekend_policy is not None:
        store.log_runner_event(
            insurer_name=insurer_name,
            event_type="weekend_roster_applied",
            status="applied",
            details={
                "insurer_name": insurer_name,
                "effective_date": weekend_policy.effective_date,
                "roster_id": weekend_policy.roster_id,
                "weekend_start": weekend_policy.weekend_start,
                "weekend_end": weekend_policy.weekend_end,
                "on_shift_owner_names": weekend_policy.on_shift_owner_names,
                "off_duty_owner_names": weekend_policy.off_duty_owner_names,
                "eligible_bot_ids": [bot.id for bot in bots],
                "eligible_bot_names": [bot.portal_name for bot in bots],
            },
        )

    with CuracelPilesRunner(visible=visible, slow_mo=args.slow_mo) as runner:
        runner.safe_diagnostics = bool(getattr(args, "worker_safe_diagnostics", False))
        runner.allow_test_any_assignee = False
        runner.execution_ledger = execution_ledger
        runner.insurer_run_id = insurer_run_id
        runner.insurer_name = insurer_name
        runner.work_heartbeat = getattr(args, "work_heartbeat", None)
        runner.phase_timer = getattr(args, 'phase_timer', None) or PhaseTimer()

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

        print("\nScanning pages...")
        scanned_rows = runner.scan_all_rows(month_labels, year_label)

        if execution_ledger and insurer_run_id:
            for old_plan in execution_ledger.unsubmitted_plans(insurer_name):
                execution_ledger.transition_attempt(
                    old_plan["id"],
                    AttemptStatus.FAILED,
                    expected={AttemptStatus.PLANNED},
                    evidence={"code": "superseded_unsubmitted_plan", "details": {}},
                )

            rows_by_tracking: dict[str, PileRow] = {}
            for row in scanned_rows:
                for key in expanded_tracking_key_set([row.tracking_key, row.legacy_tracking_key]):
                    rows_by_tracking[key] = row

            class ScannedRowsPortal:
                def observe_attempt(self, attempt: dict[str, Any]) -> list[Observation]:
                    key = canonical_pile_tracking_key(attempt.get("tracking_key"))
                    observed = rows_by_tracking.get(key)
                    if observed is None:
                        return []
                    return [Observation(
                        assignable=not norm(observed.assigned),
                        assignee=norm(observed.assigned),
                        source="complete_initial_scan",
                    )]

            pending_attempts = execution_ledger.pending_attempts(insurer_name)
            prior_attempt_keys.update(expanded_tracking_key_set(
                key for attempt in pending_attempts
                for key in (attempt.get("tracking_key"), attempt.get("last_pile_key"))
            ))
            if pending_attempts:
                runner.phase_timer.call('reconcile', 'reconciliation', reconcile_pending_for_insurer,
                    ScannedRowsPortal(),
                    execution_ledger,
                    pending_attempts,
                )

            for retryable in execution_ledger.retryable_attempts(insurer_name, max_attempts=2):
                key = canonical_pile_tracking_key(retryable.get("tracking_key"))
                runner.retry_attempt_numbers[key] = safe_int(retryable.get("attempt_number"), 1) + 1
                execution_ledger.transition_attempt(
                    retryable["id"],
                    AttemptStatus.FAILED,
                    expected={AttemptStatus.STILL_UNASSIGNED},
                    evidence={"code": "released_for_bounded_retry", "details": {
                        "next_attempt_number": runner.retry_attempt_numbers[key],
                    }},
                )

            exhausted = execution_ledger.exhausted_attempts(insurer_name, max_attempts=2)
            for attempt in exhausted:
                key = canonical_pile_tracking_key(attempt.get("tracking_key"))
                reconciliation_manual_keys.add(key)
                execution_ledger.transition_attempt(
                    attempt["id"],
                    AttemptStatus.MANUAL_ACTION_REQUIRED,
                    expected={AttemptStatus.STILL_UNASSIGNED},
                    evidence={"code": "retry_limit_exhausted", "details": {"max_attempts": 2}},
                )
            reconciliation_manual_count = len(reconciliation_manual_keys)

        if bots:
            tracked_reconcile = reconcile_tracked_assignments(
                store,
                runner,
                insurer_name,
                year_label,
                configured_bots if weekend_policy is not None else bots,
                metrics,
                rule,
                month_labels,
                scanned_rows=scanned_rows,
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

        tracked_keys = store.get_all_tracked_tracking_keys(insurer_name)
        external_detection = detect_external_assignments(
            store,
            master.id,
            insurer_name,
            scanned_rows,
            configured_bots,
            tracked_keys,
            team_slack_map,
            rule,
        )
        if external_detection["new_detection_count"]:
            print("\nDetected externally assigned piles the runner is not tracking:")
            for item in external_detection["notifications"]:
                owner_label = item.owner_name or "Unmapped owner"
                print(
                    f"  - {item.insurer_name}: {item.current_assigned or 'Unknown assignee'} "
                    f"({owner_label}) • {item.claims} claims • {item.status_bucket or 'Unknown status'}"
                )

        stale_candidates = [
            *tracked_reconcile.get("stale_candidates", []),
            *external_detection.get("stale_candidates", []),
        ]
        if stale_candidates:
            reassignment_previous_owner_by_tracking = {
                candidate.source_tracking_key: candidate.current_bot
                for candidate in stale_candidates
            }
            reassignment_source_by_tracking = {
                candidate.source_tracking_key: candidate
                for candidate in stale_candidates
            }
            ensure_portal_mapping(stale_candidates[0].observed_row)
            reassignment_plans, reassignment_summary = runner.phase_timer.call('plan', 'planning', build_stale_reassignment_plans,
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
                    minimum_claim_chunk=rule.minimum_claim_chunk if rule else 25,
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
                        candidate = reassignment_source_by_tracking.get(item.plan.tracking_key)
                        if planned_assignee and item.matched_planned_assignee and item.verified_on_table:
                            store.save_tracked_assignment(
                                master.id,
                                item.plan,
                                item.actual_assignee_name,
                                planned_assignee.id,
                                reassigned=True,
                            )
                            if candidate and candidate.source_kind == "external":
                                store.clear_external_assignment(candidate.source_id)
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
        unassigned = [
            row for row in unique_unassigned_rows(scanned_rows)
            if canonical_pile_tracking_key(row.tracking_key) not in reconciliation_manual_keys
        ]
        initial_unassigned_keys = {row.key for row in unassigned}
        initial_observed_keys = expanded_tracking_key_set(
            key for row in scanned_rows for key in (row.tracking_key, row.legacy_tracking_key, row.key)
        )
        follow_up_context_pairs = {
            (row.filter_month, effective_filter_year(row, year_label), row.status_bucket)
            for row in unassigned
            if norm(row.filter_month) and norm(row.status_bucket)
        }
        print(f"\nTotal unassigned piles found: {len(unassigned)}")

        plans: list[PlannedAssignment] = []
        summary: dict[str, dict[str, Any]] = {}
        if unassigned:
            manual_mode = bool(rule and rule.distribution_mode == "manual_override")
            if not manual_mode:
                ensure_portal_mapping(unassigned[0])
            if manual_mode:
                plans, summary = runner.phase_timer.call('plan', 'planning', build_assignment_plan,
                    insurer_name,
                    unassigned,
                    resolved_bots,
                    metrics,
                    rule=rule,
                    effective_at=datetime.now(RUNNER_TIMEZONE),
                )
                print(
                    f"\nManual override is active: {len(unassigned)} pile(s) require manual action; "
                    "no automatic assignment will be attempted."
                )
            elif not bots:
                plans, summary = runner.phase_timer.call('plan', 'planning', build_assignment_plan_from_portal_options, insurer_name, unassigned, portal_assignees)
            else:
                plans, summary = runner.phase_timer.call('plan', 'planning', build_assignment_plan,
                    insurer_name,
                    unassigned,
                    resolved_bots,
                    metrics,
                    rule=rule,
                    effective_at=datetime.now(RUNNER_TIMEZONE),
                )

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
            "assignment_policy": {
                "primary_min_share_ratio": PRIMARY_ASSIGNMENT_FLOOR_RATIO,
            },
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

        manual_action_count = reconciliation_manual_count + (
            len(unassigned)
            if rule and rule.distribution_mode == "manual_override"
            else 0
        )
        planned_scan_count = len(reassignment_plans) + len(plans)
        planned_scan_claims = sum(
            max(plan.remaining_claims, 0) for plan in [*reassignment_plans, *plans]
        )

        store.log_runner_event(
            insurer_name=insurer_name,
            event_type="runner_scan",
            status=(
                "manual_action_required"
                if manual_action_count
                else "planned" if not args.execute else "ready"
            ),
            pile_count=planned_scan_count,
            claim_count=planned_scan_claims,
            details={
                "insurer_name": insurer_name,
                "mode": "execute" if args.execute else "dry-run",
                "captured_at": captured_at,
                "fallback_pool_used": fallback_pool_used,
                "assignment_policy": {
                    "primary_min_share_ratio": PRIMARY_ASSIGNMENT_FLOOR_RATIO,
                },
                "month": month_labels[0] if len(month_labels) == 1 else month_labels,
                "months": month_labels,
                "year": year_label,
                "statuses": TARGET_STATUSES,
                "manual_action_required_count": manual_action_count,
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
            follow_up_context_pairs.update(
                (plan.filter_month, norm(plan.filter_year) or year_label, plan.status_bucket)
                for plan in plans
                if norm(plan.filter_month) and norm(plan.status_bucket)
            )
            print("\nApplying assignment flow...")
            results, applied = runner.execute_assignment_plan(
                month_labels,
                year_label,
                plans,
                execute=args.execute,
                minimum_claim_chunk=rule.minimum_claim_chunk if rule else 25,
            )
            print("\nUI assignment groups touched:")
            for assignee_name, count in results.items():
                print(f"  - {assignee_name}: {count} pile(s)")
        elif reassignment_plans:
            print("\nNo new unassigned piles were found after tracked-pile reconciliation.")

        if args.execute and resolved_bots:
            metrics = store.refresh_bot_metrics_from_tracking(insurer_name, resolved_bots, metrics)

        follow_up_context_pairs.update(
            (plan.filter_month, norm(plan.filter_year) or year_label, plan.status_bucket)
            for plan in reassignment_plans
            if norm(plan.filter_month) and norm(plan.status_bucket)
        )
        follow_up_contexts = sorted(
            follow_up_context_pairs,
            key=lambda item: (
                -safe_int(item[1], 0),
                MONTH_OPTIONS.index(item[0]) if item[0] in MONTH_OPTIONS else 99,
                TARGET_STATUSES.index(item[2]) if item[2] in TARGET_STATUSES else 99,
            ),
        )
        v2 = bool(getattr(args, "worker_safe_diagnostics", False))
        if v2:
            snapshots = tuple(getattr(runner, "initial_scan_results", {}).values())
            scan_context_summary = {
                "total": len(snapshots),
                "complete": sum(result.status in {ContextStatus.COMPLETE, ContextStatus.EMPTY} for result in snapshots),
                "empty": sum(result.status == ContextStatus.EMPTY for result in snapshots),
                "failed": sum(result.status == ContextStatus.FAILED for result in snapshots),
                "pending": sum(result.status not in {ContextStatus.COMPLETE, ContextStatus.EMPTY, ContextStatus.FAILED}
                               for result in snapshots),
            }
            initial_observed_keys.update(expanded_tracking_key_set(
                key for result in snapshots for row in result.rows
                for key in (row.tracking_key, row.legacy_tracking_key, row.key)
            ))
            follow_up_contexts = [
                (context.filter_month, context.requested_year, context.status_bucket)
                for context in late_arrival_contexts(snapshots)
            ]
            excluded = [
                {"month": result.context.filter_month, "year": result.context.requested_year,
                 "status": result.context.status_bucket, "code": "initial_context_" + result.status.value}
                for result in snapshots if result.context is not None
                and result.status not in {ContextStatus.COMPLETE, ContextStatus.EMPTY}
            ]
            late_arrival_detection["excluded_contexts"] = excluded
            if excluded:
                store.log_runner_event(
                    insurer_name=insurer_name, event_type="late_arrival_contexts_excluded",
                    status="completed_with_issues", details={"contexts": excluded},
                )
        late_arrival_detection["contexts"] = [
            {"month": month_label, "year": filter_year, "status": status_label}
            for month_label, filter_year, status_label in follow_up_contexts
        ]

        if follow_up_contexts:
            print("\nFinal late-arrival targeted rescan...")
            if v2:
                runner._heartbeat("scan")
            follow_up_rows = runner.scan_selected_statuses(follow_up_contexts, year_label, only_unassigned=not v2)
        else:
            follow_up_rows = []
        if v2:
            if execution_ledger and insurer_run_id:
                runner._heartbeat("reconcile")
                final_pending = execution_ledger.pending_attempts(insurer_name)
                prior_attempt_keys.update(expanded_tracking_key_set(
                    key for attempt in final_pending
                    for key in (attempt.get("tracking_key"), attempt.get("last_pile_key"))
                ))
                observations_by_key: dict[str, list[Observation]] = {}
                for row in follow_up_rows:
                    for key in expanded_tracking_key_set([row.tracking_key, row.legacy_tracking_key, row.key]):
                        observations_by_key.setdefault(key, []).append(Observation(
                            assignable=not norm(row.assigned), assignee=norm(row.assigned),
                            source="complete_final_scan",
                        ))

                class FinalScanPortal:
                    def observe_attempt(self, attempt):
                        runner._heartbeat("reconcile")
                        return [observation
                                for key in expanded_tracking_key_set([attempt.get("tracking_key"), attempt.get("last_pile_key")])
                                for observation in observations_by_key.get(key, [])]

                for attempt in final_pending:
                    runner._heartbeat("reconcile")
                    decisions = runner.phase_timer.call('reconcile', 'reconciliation', reconcile_pending_for_insurer, FinalScanPortal(), execution_ledger, [attempt])
                    for decision in decisions:
                        counts = late_arrival_detection.setdefault("reconciliation", {})
                        status = decision.status.value
                        counts[status] = counts.get(status, 0) + 1
            seen_late = initial_observed_keys | prior_attempt_keys | expanded_tracking_key_set(
                key for row in follow_up_rows if norm(row.assigned)
                for key in (row.tracking_key, row.legacy_tracking_key, row.key)
            )
            follow_up_unassigned = []
            for row in follow_up_rows:
                identities = expanded_tracking_key_set([row.tracking_key, row.legacy_tracking_key, row.key])
                if not norm(row.assigned) and not identities.intersection(seen_late):
                    follow_up_unassigned.append(row)
                seen_late.update(identities)
        else:
            follow_up_unassigned = [
                row for row in unique_unassigned_rows(follow_up_rows)
                if row.key not in initial_unassigned_keys
            ]
        if follow_up_unassigned:
            if v2:
                runner._heartbeat("plan")
            late_arrival_detection["count"] = len(follow_up_unassigned)
            late_arrival_detection["claims"] = sum(row.claims for row in follow_up_unassigned)
            late_arrival_detection["piles"] = [row.__dict__ for row in follow_up_unassigned]
            print(
                f"Late-arrival unassigned piles detected after the first scan: "
                f"{late_arrival_detection['count']} pile(s), {late_arrival_detection['claims']} claim(s)"
            )
            late_manual = bool(rule and rule.distribution_mode == "manual_override")
            if not late_manual:
                ensure_portal_mapping(follow_up_unassigned[0])
            late_plans: list[PlannedAssignment]
            late_summary: dict[str, dict[str, Any]]
            if v2:
                runner._heartbeat("plan")
            if late_manual:
                manual_action_count += len(follow_up_unassigned)
                late_plans, late_summary = runner.phase_timer.call('plan', 'planning', build_assignment_plan,
                    insurer_name, follow_up_unassigned, resolved_bots, metrics,
                    rule=rule, effective_at=datetime.now(RUNNER_TIMEZONE),
                )
            elif not bots:
                late_plans, late_summary = runner.phase_timer.call('plan', 'planning', build_assignment_plan_from_portal_options, insurer_name, follow_up_unassigned, portal_assignees)
            else:
                late_plans, late_summary = runner.phase_timer.call('plan', 'planning', build_assignment_plan,
                    insurer_name,
                    follow_up_unassigned,
                    resolved_bots,
                    metrics,
                    rule=rule,
                    effective_at=datetime.now(RUNNER_TIMEZONE),
                )
            late_arrival_detection["summary"] = late_summary
            summary = merge_assignment_summaries(summary, late_summary)
            plans.extend(late_plans)
            store.log_runner_event(
                insurer_name=insurer_name,
                event_type="late_arrival_detected",
                status="manual_action_required" if late_manual else "follow_up_execute" if args.execute else "follow_up_preview",
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
                if v2:
                    runner._heartbeat("apply")
                late_month_labels = list(dict.fromkeys(plan.filter_month for plan in late_plans if norm(plan.filter_month))) or month_labels
                late_results, late_applied = runner.execute_assignment_plan(
                    late_month_labels,
                    year_label,
                    late_plans,
                    execute=args.execute,
                    minimum_claim_chunk=rule.minimum_claim_chunk if rule else 25,
                )
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
            if getattr(args, "worker_safe_diagnostics", False) and not (item.verified_on_table and item.matched_planned_assignee):
                continue
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
            if getattr(args, "worker_safe_diagnostics", False) and not (item.verified_on_table and item.matched_planned_assignee):
                continue
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
    total_claims = sum(max(plan.remaining_claims, 0) for plan in [*reassignment_plans, *plans])
    total_completed = len(reassignment_applied) + len(applied)
    total_completed_claims = sum(
        max(item.plan.remaining_claims, 0) for item in [*reassignment_applied, *applied]
    )

    store.log_runner_event(
        insurer_name=insurer_name,
        event_type="runner_complete",
        status=(
            "manual_action_required"
            if manual_action_count
            else "assigned"
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
            "assignment_policy": {
                "primary_min_share_ratio": PRIMARY_ASSIGNMENT_FLOOR_RATIO,
            },
            "months": month_labels,
            "no_work": total_planned == 0 and manual_action_count == 0,
            "manual_action_required_count": manual_action_count,
            "message": (
                f"{manual_action_count} pile(s) require manual action."
                if manual_action_count
                else "No unassigned piles found. Nothing to assign." if total_planned == 0 else ""
            ),
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
    result = {
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
    if getattr(args, "worker_safe_diagnostics", False):
        # A manual workflow can have no assignment attempts at all. Carry its
        # explicit result across the worker boundary, not only ledger counts.
        result["workflow_status"] = "manual_action_required" if manual_action_count else "completed"
        if late_arrival_detection.get("excluded_contexts") or any(
            count for status, count in late_arrival_detection.get("reconciliation", {}).items()
            if status != AttemptStatus.CONFIRMED_RECONCILED.value
        ):
            result["workflow_status"] = "completed_with_issues"
        result["manual_action_required_count"] = manual_action_count
        if scan_context_summary is not None:
            result["scan_context_summary"] = scan_context_summary
    return result


def run_for_insurer(
    store: DataStore,
    args: argparse.Namespace,
    insurer_name: str,
    month_labels: list[str],
    year_label: str,
    visible: bool,
    execution_ledger: Any = None,
    insurer_run_id: str = "",
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, 3):
        try:
            return _run_for_insurer_once(
                store,
                args,
                insurer_name,
                month_labels,
                year_label,
                visible,
                execution_ledger,
                insurer_run_id,
            )
        except Exception as exc:
            last_error = exc
            if isinstance(exc, (WorkOwnershipLost, AssignmentSubmissionUncertain)):
                raise
            if attempt >= 2 or not is_retryable_runner_browser_error(exc):
                raise
            print(
                f"\n  Browser session was interrupted while processing {insurer_name}. "
                f"Restarting the insurer flow ({attempt + 1}/2)..."
            )
            time.sleep(2)
    raise last_error or RuntimeError(f"Insurer run failed for {insurer_name}.")


def run_insurer_recorded(
    store: DataStore,
    args: argparse.Namespace,
    insurer_name: str,
    month_labels: list[str],
    year_label: str,
    visible: bool,
    execution_ledger: Any,
    runner_run_id: str,
    *,
    safe_diagnostics: bool = False,
    ownership: Any = None,
) -> dict[str, Any]:
    """Run one insurer and keep ledger-finalization failures from masking portal errors."""
    insurer_run_id = ""
    args = argparse.Namespace(**vars(args))
    args.phase_timer = PhaseTimer()
    try:
        if execution_ledger:
            master = store.get_master_account(insurer_name)
            if ownership:
                insurer_run_id = ownership.started(master)
            else:
                insurer_run_id = execution_ledger.create_insurer_run(runner_run_id, master)
            execution_ledger.heartbeat(insurer_run_id, phase="login")
        result = run_for_insurer(
            store, args, insurer_name, month_labels, year_label, visible,
            execution_ledger, insurer_run_id,
        )
        if insurer_run_id:
            status = "completed"
            error_code = ""
            if ownership:
                ownership.check()
                summary = execution_ledger.summarize_insurer_run(insurer_run_id)
                status, error_code = classify_workflow_outcome(result, summary)
                ownership.status = InsurerRunStatus(status)
                ownership.error_code = error_code
                ownership.check()
            args.phase_timer.finish()
            fields = {"status": status, "performance": args.phase_timer.serialize()}
            if error_code:
                fields["error_code"] = error_code
            execution_ledger.finalize_insurer_run(insurer_run_id, **fields)
        return result
    except Exception as exc:
        if ownership:
            # Lost owners cannot finalize even their old insurer run.
            ownership.check()
        if insurer_run_id:
            try:
                args.phase_timer.finish('failed')
                execution_ledger.finalize_insurer_run(
                    insurer_run_id,
                    status="failed",
                    error_code=safe_worker_error(exc)[0] if safe_diagnostics else classify_runner_error(exc),
                    error_message=safe_worker_error(exc)[1] if safe_diagnostics else str(exc)[:500],
                    performance=args.phase_timer.serialize(),
                )
            except Exception as ledger_error:
                if safe_diagnostics:
                    print("WARNING: could not finalize insurer ledger state.")
                else:
                    print(f"\nWARNING: could not finalize ledger state for {insurer_name}: {ledger_error}")
        raise


def run_claimed_insurer_once(work, context: WorkerContext, args: argparse.Namespace,
                             month_labels: list[str], year_label: str, visible: bool) -> dict[str, Any]:
    """V2 portal boundary: one recorded execution, no coalescing or follow-up.

    Shared invocation settings are copied before portal execution. Returned
    notification payloads belong to the caller, never a shared parent list.
    """
    worker_args = deepcopy(args)
    worker_args.worker_safe_diagnostics = True
    if context.ownership:
        worker_args.work_heartbeat = context.ownership.check
    if context.output_path:
        worker_args.out = context.output_path
    elif getattr(worker_args, "out", None):
        path = Path(worker_args.out)
        identifier = hashlib.sha256(f"{work.id}:{work.claim_token}".encode()).hexdigest()[:16]
        worker_args.out = str(path.with_name(f"{path.stem}-{identifier}{path.suffix}"))
    return run_insurer_recorded(
        context.store, worker_args, work.insurer_name, list(month_labels),
        year_label, visible, context.ledger, work.parent_runner_run_id or "",
        safe_diagnostics=True, ownership=context.ownership,
    )


def notify_dispatch_result(args: argparse.Namespace, result: DispatchResult) -> None:
    """Send only parent-aggregated payloads after every worker has joined."""
    external = list(result.external_notification_items)
    if should_send_external_assignment_alert(args, external):
        try:
            send_external_assignment_alert(external, portal_environment=PORTAL_ENVIRONMENT,
                                           run_source=norm(args.run_source) or "manual", safe_diagnostics=True)
        except Exception:
            print("WARNING: external assignment notification failed.")
    items = list(result.notification_items)
    if not args.execute or not items:
        return
    assigned = [item for item in items if item.kind == "assignment"]
    reassigned = [item for item in items if item.kind == "reassignment"]
    try:
        thread = create_assignment_thread(
            scope_label=args.insurer or "All active insurers", portal_environment=PORTAL_ENVIRONMENT,
            assigned_piles=len(assigned), assigned_claims=sum(max(item.plan.remaining_claims, 0) for item in assigned),
            reassigned_piles=len(reassigned), reassigned_claims=sum(max(item.plan.remaining_claims, 0) for item in reassigned),
            insurer_names=[item.plan.insurer_name for item in items],
            safe_diagnostics=True,
        ) or ""
        if thread:
            for owner_items in group_notification_items_by_owner(items):
                send_assignment_owner_reply(owner_items, thread, safe_diagnostics=True)
    except Exception:
        print("WARNING: assignment summary notification failed.")


def classify_workflow_outcome(
    result: Any, summary: Any = None,
) -> tuple[str, str]:
    """Require explicit workflow evidence before declaring an insurer complete."""
    result = result if isinstance(result, dict) else {}
    summary = summary if isinstance(summary, dict) else {}
    workflow_status = norm(result.get("workflow_status"))
    manual_count = safe_int(result.get("manual_action_required_count"), 0)
    if workflow_status == "manual_action_required" or manual_count or summary.get("manual_action_required", 0):
        return "manual_action_required", "manual_action_required"
    if workflow_status not in {"completed", "completed_with_issues"}:
        return "completed_with_issues", "workflow_outcome_unconfirmed"
    has_follow_up = (
        workflow_status == "completed_with_issues"
        or bool(result.get("portal_mapping_warnings"))
        or any(summary.get(key, 0) for key in ("reconciliation_pending", "submitted", "conflict", "failed"))
    )
    if has_follow_up:
        return "completed_with_issues", "assignment_follow_up_required"
    return "completed", ""


def preview_context_diagnostics(result: dict[str, Any]) -> dict[str, int | None]:
    """Accept only internally consistent measured scan-context aggregates."""
    keys = ("total", "complete", "empty", "failed", "pending")
    raw = result.get("scan_context_summary")
    unknown = {f"contexts_{key}": None for key in keys}
    if not isinstance(raw, dict):
        return unknown
    values = {key: raw.get(key) for key in keys}
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 100000
           for value in values.values()):
        return unknown
    if (values["empty"] > values["complete"]
            or values["complete"] + values["failed"] + values["pending"] != values["total"]):
        return unknown
    return {f"contexts_{key}": value for key, value in values.items()}


def preview_diagnostic_outcome(outcome: Any) -> dict[str, Any]:
    """Project a probe result into bounded, non-identifying parent diagnostics."""
    value = getattr(outcome, "value", None)
    result = getattr(value, "result", None) if value is not None else None
    result = result if isinstance(result, dict) else {}
    status = getattr(getattr(outcome, "status", None), "value", "failed")
    error_code = norm(getattr(outcome, "error_code", ""))[:100]
    if status == "completed":
        status, error_code = classify_workflow_outcome(result)
    unassigned = list(result.get("unassigned") or [])
    plans = [*list(result.get("reassignment_plans") or []), *list(result.get("plans") or [])]
    return {
        "insurer_name": norm(getattr(outcome, "insurer_name", ""))[:160],
        "status": status if status in {"completed", "completed_with_issues", "manual_action_required", "failed"} else "failed",
        "phase": "complete",
        "error_code": error_code,
        "discovered_piles": len(unassigned),
        "discovered_claims": sum(max(safe_int(getattr(item, "remaining_claims", 0), 0), 0) for item in unassigned),
        "planned_piles": len(plans),
        "planned_claims": sum(max(safe_int(getattr(item, "remaining_claims", 0), 0), 0) for item in plans),
        **preview_context_diagnostics(result),
    }


def preview_parent_status(
    diagnostics: list[dict[str, Any]], *, interrupted: bool = False,
) -> str:
    """Aggregate preview truth, treating unfinished requested work as a failure signal."""
    statuses = [InsurerRunStatus(item["status"]) for item in diagnostics]
    if interrupted:
        statuses.append(InsurerRunStatus.FAILED)
    return derive_parent_status((), statuses).value


def run_durable_preview(
    args: argparse.Namespace,
    store: DataStore,
    months: list[str],
    year: str,
    visible: bool,
    router: ContextOutputRouter,
    stopped: threading.Event,
) -> DispatchResult:
    """Run an API preview with read-only workers and one fenced parent writer."""
    scope = "all-active" if args.all_active else "single"
    if not store.try_acquire_preview_parent_lock(args.run_id):
        raise WorkerUnavailable("preview_parent_unavailable")
    try:
        token = store.claim_preview_runner_run(
            run_id=args.run_id, insurer_name=args.insurer or "", run_scope=scope,
            portal_environment=PORTAL_ENVIRONMENT, backend=norm(args.invocation_backend) or "local",
            run_source=norm(args.run_source), months=months, year=year, mode="dry-run",
        )
        finalized = False
        outcomes = []
        diagnostics: list[dict[str, Any]] = []
        parent_error = ""
        try:
            insurers = [args.insurer] if args.insurer else [
                account.insurer_name for account in store.get_active_master_accounts()
            ]
            if not insurers:
                raise RuntimeError("No active insurer master accounts were found to preview.")
            probe_args = deepcopy(args)
            probe_args.read_only = True
            probe_args.worker_safe_diagnostics = True
            def preview_heartbeat(phase="scan"):
                if stopped.is_set():
                    raise WorkerUnavailable("dispatch_stopped")
                if not store.heartbeat_preview_runner_run(args.run_id, token, phase):
                    raise WorkerUnavailable("preview_parent_ownership_lost")
            probe_args.work_heartbeat = preview_heartbeat
            factory = worker_context_factory(probe_args, router, max_concurrency=1, durable_claims=False)
            @contextmanager
            def probe_context(work):
                with factory(work) as context:
                    yield replace(context, dispatch_store=None, ownership=None)
            def run_one(work, context):
                return run_claimed_insurer_once(work, context, probe_args, months, year, visible)
            for insurer in insurers:
                if stopped.is_set():
                    parent_error = "dispatch_stopped"
                    break
                if not store.heartbeat_preview_runner_run(args.run_id, token, "scan"):
                    raise WorkerUnavailable("preview_parent_ownership_lost")
                work = ProbeWork(insurer, canonical_insurer_key(insurer))
                outcome = execute_claimed_insurer(work, probe_context, run_one, stop_event=stopped)
                if outcome.error_code == "insurer_lock_unavailable":
                    outcome = replace(outcome, error_code="probe_blocked_by_active_insurer")
                elif outcome.error_code == "worker_capacity_unavailable":
                    outcome = replace(outcome, error_code="probe_blocked_by_capacity")
                outcomes.append(outcome)
                diagnostic = preview_diagnostic_outcome(outcome)
                diagnostics.append(diagnostic)
                if diagnostic["status"] == "failed" and not parent_error:
                    parent_error = diagnostic["error_code"] or "unexpected_error"
                if stopped.is_set() and len(outcomes) < len(insurers):
                    parent_error = "dispatch_stopped"
                    break
            if parent_error == "dispatch_stopped":
                status = preview_parent_status(diagnostics, interrupted=True)
            else:
                status = preview_parent_status(diagnostics)
            error_code = parent_error or next((item["error_code"] for item in diagnostics if item["error_code"]), "")
            if not store.finalize_preview_runner_run(
                args.run_id, token, status=status, outcomes=diagnostics, error_code=error_code,
            ):
                raise WorkerUnavailable("preview_parent_ownership_lost")
            finalized = True
            result = DispatchResult(ParentRunStatus(status), tuple(outcomes))
            if status != "completed":
                raise WorkerUnavailable(error_code or "preview_completed_with_issues")
            return result
        except Exception as error:
            if not finalized:
                code = "parent_scope_mismatch" if isinstance(error, ParentScopeMismatch) else safe_worker_error(error)[0]
                try:
                    store.finalize_preview_runner_run(
                        args.run_id, token, status=preview_parent_status(diagnostics, interrupted=True),
                        outcomes=diagnostics, error_code=code,
                    )
                except Exception:
                    pass
            raise
    finally:
        store.release_preview_parent_lock(args.run_id)


def main_v2() -> DispatchResult:
    """Default-disabled composition root; no legacy follow-up or parent writer."""
    args = parse_args()
    if args.read_only and args.execute:
        raise RuntimeError("--read-only cannot be combined with --execute.")
    if args.adopt_preview_run and (args.execute or args.read_only or not norm(args.run_id)
                                   or norm(args.run_source) != "manual"):
        raise ParentScopeMismatch("Durable preview adoption requires an API-created manual preview parent.")
    configure_portal_environment(args.portal_environment)
    months, year = parse_month_labels(args.month), parse_year_label(args.year)
    visible = args.visible or not env_bool("HEADLESS", True)
    maximum = configured_max_concurrency()
    if args.execute and not is_test_portal(CURACEL_BASE_URL) and not env_bool("ALLOW_PRODUCTION_ASSIGNMENTS", False):
        raise RuntimeError("Execute mode is blocked outside the test portal without explicit production approval.")
    durable_preview = bool(not args.execute and args.adopt_preview_run)
    # Standalone non-execute invocations are probes: no parent/queue/assignment writes.
    if not args.execute and not durable_preview:
        args = deepcopy(args)
        args.read_only = True
    run_id, coordinator = "", None
    with ExitStack() as resources:
        stopped = threading.Event()
        def request_stop(_signal, _frame):
            stopped.set()
        for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
            original = signal.signal(shutdown_signal, request_stop)
            resources.callback(signal.signal, shutdown_signal, original)
        store = DataStore(read_only=bool(args.read_only))
        resources.callback(store.close)
        with ContextOutputRouter.installed() as router:
            if durable_preview:
                try:
                    return run_durable_preview(args, store, months, year, visible, router, stopped)
                except ParentAlreadyTerminal:
                    return DispatchResult(ParentRunStatus.COMPLETED, ())
                except ParentScopeMismatch:
                    raise WorkerUnavailable("parent_scope_mismatch") from None
            insurers = [args.insurer] if args.insurer else [account.insurer_name for account in store.get_active_master_accounts()]
            if not insurers:
                raise RuntimeError("No active insurer master accounts were found to run.")
            factory = worker_context_factory(args, router, max_concurrency=maximum, durable_claims=bool(args.execute))
            def run_one(work, context):
                return run_claimed_insurer_once(work, context, args, months, year, visible)
            if not args.execute:
                @contextmanager
                def probe_context(work):
                    with factory(work) as context:
                        yield replace(context, dispatch_store=None)
                outcomes = []
                for insurer in insurers:
                    work = ProbeWork(insurer, canonical_insurer_key(insurer))
                    outcome = execute_claimed_insurer(work, probe_context, run_one)
                    if outcome.error_code == "insurer_lock_unavailable":
                        outcome = replace(outcome, error_code="probe_blocked_by_active_insurer")
                    elif outcome.error_code == "worker_capacity_unavailable":
                        outcome = replace(outcome, error_code="probe_blocked_by_capacity")
                    outcomes.append(outcome)
                failures = [outcome.error_code for outcome in outcomes if outcome.status == InsurerRunStatus.FAILED]
                if failures:
                    raise WorkerUnavailable(failures[0])
                return DispatchResult(ParentRunStatus.COMPLETED, tuple(outcomes))
            try:
                coordinator = build_dispatch_store(store)
                resources.callback(coordinator.close)
                run_id = store.create_runner_run(
                    run_id=args.run_id, insurer_name=args.insurer or "",
                    run_scope="all-active" if args.all_active else "single",
                    portal_environment=PORTAL_ENVIRONMENT, backend=norm(args.invocation_backend) or "local",
                    run_source=WorkSource(norm(args.run_source) or "manual").value,
                    months=months, year=year, mode="execute",
                    details={"dispatcher_v2": True, "insurers": insurers},
                    preserve_existing=True,
                )
                requested_at = coordinator.parent_requested_at(run_id)
                requests = [WorkRequest(insurer, WorkSource(norm(args.run_source) or "manual"), requested_at,
                                        RequestScope.ALL_ACTIVE if args.all_active else RequestScope.SINGLE_INSURER,
                                        PORTAL_ENVIRONMENT, tuple(months), year)
                            for insurer in insurers]
                work_items = coordinator.enqueue_parent_work(run_id, requests)
                restored = []
                if store.try_acquire_insurer_lock("__weekend_state__"):
                    try:
                        restored = store.restore_due_weekend_bot_states(runner_effective_date(args))
                    finally:
                        store.release_insurer_lock("__weekend_state__")
                result = dispatch_parent(run_id, work_items, maximum, factory, run_one,
                                         store=coordinator, stop_event=stopped)
                if result.status == ParentRunStatus.RUNNING:
                    raise WorkerUnavailable("dispatch_work_pending")
                try:
                    collection_complete = coordinator.notification_collection_complete(
                        run_id, result.finalized_work_ids, result.notification_fingerprints)
                except Exception:
                    collection_complete = False
                if collection_complete:
                    notify_dispatch_result(args, result)
                else:
                    print("WARNING: parent_notification_incomplete; notification requires operational review.")
                if restored and collection_complete:
                    try:
                        send_weekend_restore_update(restored, safe_diagnostics=True)
                    except Exception:
                        print("WARNING: weekend roster notification failed.")
                if any(outcome.status == InsurerRunStatus.FAILED for outcome in result.outcomes):
                    raise RuntimeError("One or more insurers failed; inspect the normalized insurer outcomes.")
                return result
            except ParentAlreadyTerminal:
                return DispatchResult(coordinator.finalize_parent(run_id), ())
            except Exception as error:
                if coordinator and run_id:
                    try:
                        coordinator.fail_parent_setup(run_id)
                    except Exception:
                        pass  # Keep durable state recoverable when the DB is unavailable.
                code = "parent_scope_mismatch" if isinstance(error, ParentScopeMismatch) else safe_worker_error(error)[0]
                raise WorkerUnavailable(code) from None


def main() -> None:
    if dispatcher_v2_enabled():
        try:
            return main_v2()
        except Exception as error:
            code, _ = safe_worker_error(error)
            raise RuntimeError(f"Dispatcher could not complete ({code}).") from None
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    stdout_capture = TeeCapture(original_stdout)
    stderr_capture = TeeCapture(original_stderr)
    sys.stdout = stdout_capture
    sys.stderr = stderr_capture

    started_at = datetime.now(timezone.utc)
    store: DataStore | None = None
    execution_ledger: Any = None
    run_id = ""
    run_details: dict[str, Any] = {}
    insurers: list[str] = []
    failures: list[tuple[str, str]] = []
    insurer_statuses: list[InsurerRunStatus] = []
    notification_failures: list[dict[str, str]] = []
    final_error: Exception | None = None
    args: argparse.Namespace | None = None
    all_notification_items: list[NotificationItem] = []
    all_external_notification_items: list[ExternalNotificationItem] = []
    slack_thread_ts = ""
    slack_replies_sent = 0
    try:
        args = parse_args()
        if args.read_only and args.execute:
            raise RuntimeError("--read-only cannot be combined with --execute.")
        configure_portal_environment(args.portal_environment)
        month_labels = parse_month_labels(args.month)
        year_label = parse_year_label(args.year)
        visible = args.visible or not env_bool("HEADLESS", True)

        if args.execute and not is_test_portal(CURACEL_BASE_URL) and not env_bool("ALLOW_PRODUCTION_ASSIGNMENTS", False):
            raise RuntimeError(
                "Execute mode is blocked outside the test portal. "
                "Use the dev portal, or set ALLOW_PRODUCTION_ASSIGNMENTS=true only when you intentionally want live assignments."
            )

        store = DataStore(read_only=bool(args.read_only))
        max_concurrency = configured_max_concurrency()
        restored_weekend_rows = []
        if args.execute and store.try_acquire_insurer_lock("__weekend_state__"):
            try:
                restored_weekend_rows = store.restore_due_weekend_bot_states(runner_effective_date(args))
            finally:
                store.release_insurer_lock("__weekend_state__")
        if restored_weekend_rows:
            restored_by_insurer: dict[str, list[str]] = {}
            for row in restored_weekend_rows:
                restored_by_insurer.setdefault(norm(row.get("insurer_name")), []).append(norm(row.get("owner_name")))
            for insurer_name, owners in restored_by_insurer.items():
                store.log_runner_event(
                    insurer_name=insurer_name,
                    event_type="weekend_roster_state_restored",
                    status="restored",
                    details={
                        "effective_date": runner_effective_date(args),
                        "restored_owners": sorted({owner for owner in owners if owner}),
                        "restored_count": len(owners),
                    },
                )
            send_weekend_restore_update(restored_weekend_rows)
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
            "effective_date": runner_effective_date(args),
        }
        run_id = store.create_runner_run(
            run_id=args.run_id,
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
        execution_ledger = build_execution_ledger(store, args)

        for index, insurer_name in enumerate(insurers, start=1):
            if args.all_active:
                print(f"\n\n===== Running insurer {index}/{len(insurers)}: {insurer_name} =====")
            slot = store.try_acquire_runner_slot(max_concurrency)
            insurer_locked = slot >= 0 and store.try_acquire_insurer_lock(insurer_name)
            if not insurer_locked:
                if slot >= 0:
                    store.release_runner_slot(slot)
                insurer_statuses.append(InsurerRunStatus.SKIPPED_OVERLAP)
                probe_failure = overlap_probe_failure(args.read_only, insurer_name)
                request_id = None if probe_failure else store.mark_coalesced_request(insurer_name, run_id)
                store.log_runner_event(
                    insurer_name=insurer_name,
                    event_type="runner_overlap",
                    status="skipped_overlap",
                    details={"coalesced_request_id": request_id, "runner_run_id": run_id},
                )
                if probe_failure:
                    failures.append((insurer_name, probe_failure))
                    print(f"\nFAILED read-only probe for {insurer_name}: another runner held its lock.")
                else:
                    print(f"\nSKIPPED overlap for {insurer_name}; one follow-up request is queued.")
                continue
            try:
                followup_completed = False
                while True:
                    insurer_result = run_insurer_recorded(
                        store, args, insurer_name, month_labels, year_label, visible,
                        execution_ledger, run_id,
                    )
                    all_notification_items.extend(insurer_result.get("notification_items", []))
                    all_external_notification_items.extend(insurer_result.get("external_notification_items", []))
                    insurer_statuses.append(InsurerRunStatus.COMPLETED)
                    if followup_completed or not store.claim_coalesced_request(insurer_name, run_id):
                        break
                    followup_completed = True
                    print(f"\nRunning one coalesced follow-up for {insurer_name}...")
            except Exception as exc:
                error_code = classify_runner_error(exc)
                failures.append((insurer_name, str(exc)))
                insurer_statuses.append(InsurerRunStatus.FAILED)
                store.log_runner_event(
                    insurer_name=insurer_name,
                    event_type="runner_complete",
                    status="failed",
                    details={
                        "insurer_name": insurer_name,
                        "mode": "execute" if args.execute else "dry-run",
                        "captured_at": datetime.now(timezone.utc).isoformat(),
                        "error_code": error_code,
                        "error": str(exc),
                    },
                )
                print(f"\nERROR for {insurer_name}: {exc}")
                if not args.all_active:
                    raise
            finally:
                store.release_insurer_lock(insurer_name)
                store.release_runner_slot(slot)

        if args and should_send_external_assignment_alert(args, all_external_notification_items):
            try:
                send_external_assignment_alert(
                    all_external_notification_items,
                    portal_environment=PORTAL_ENVIRONMENT,
                    run_source=norm(args.run_source) or "manual",
                )
            except Exception as exc:
                notification_failures.append({"type": "external_assignment_alert", "error": str(exc)[:500]})
                print(f"\nWARNING: external assignment notification failed: {exc}")

        if args and args.execute and all_notification_items:
            assigned_items = [item for item in all_notification_items if item.kind == "assignment"]
            reassigned_items = [item for item in all_notification_items if item.kind == "reassignment"]
            scope_label = args.insurer or "All active insurers"
            try:
                slack_thread_ts = create_assignment_thread(
                    scope_label=scope_label,
                    portal_environment=PORTAL_ENVIRONMENT,
                    assigned_piles=len(assigned_items),
                    assigned_claims=sum(max(item.plan.remaining_claims, 0) for item in assigned_items),
                    reassigned_piles=len(reassigned_items),
                    reassigned_claims=sum(max(item.plan.remaining_claims, 0) for item in reassigned_items),
                    insurer_names=[item.plan.insurer_name for item in all_notification_items],
                ) or ""
                if slack_thread_ts:
                    for owner_items in group_notification_items_by_owner(all_notification_items):
                        if send_assignment_owner_reply(owner_items, slack_thread_ts):
                            slack_replies_sent += 1
            except Exception as exc:
                notification_failures.append({"type": "assignment_summary", "error": str(exc)[:500]})
                print(f"\nWARNING: assignment notification failed: {exc}")

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
                "notification_failures": notification_failures,
            }
            if final_error:
                final_details["error"] = str(final_error)
            store.finalize_runner_run(
                run_id,
                status=(
                    derive_overall_run_status(insurer_statuses).value
                    if insurer_statuses
                    else "failed" if final_error else "completed"
                ),
                started_at=started_at,
                stdout=stdout_capture.getvalue(),
                stderr=stderr_capture.getvalue(),
                details=final_details,
            )
        if store:
            store.close()
        if execution_ledger:
            execution_ledger.close()
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
