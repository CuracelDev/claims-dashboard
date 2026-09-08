"""Pure, deterministic assignment eligibility, planning, and batching."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, time
from typing import Any, Callable, Iterable, Mapping, Optional
from zoneinfo import ZoneInfo


SUPPORTED_MODES = {"balanced_finish", "single_owner", "manual_override"}
AVAILABLE_STATUSES = {"", "available", "weekend_added"}
LAGOS = ZoneInfo("Africa/Lagos")


class InvalidAssignmentConfiguration(RuntimeError):
    pass


def _value(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _parse_time(value: Any) -> Optional[time]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%H:%M").time()
    except ValueError as error:
        raise InvalidAssignmentConfiguration(f"Invalid active time '{raw}'; expected HH:MM.") from error


def _inside_window(now: time, start: Optional[time], end: Optional[time]) -> bool:
    if start is None and end is None:
        return True
    start = start or time.min
    end = end or time.max
    if start <= end:
        return start <= now <= end
    return now >= start or now <= end


@dataclass(frozen=True)
class Exclusion:
    subject_id: str
    reason_code: str


@dataclass(frozen=True)
class EligibilityResult:
    eligible: tuple[Any, ...]
    exclusions: tuple[Exclusion, ...]


@dataclass(frozen=True)
class PlanDecision:
    pile: Any
    bot: Any
    work_claims: int


@dataclass(frozen=True)
class ManualDisposition:
    pile: Any
    reason_code: str = "manual_override"


@dataclass(frozen=True)
class PlanningResult:
    plans: tuple[PlanDecision, ...]
    exclusions: tuple[Exclusion, ...]
    manual_action_required: tuple[ManualDisposition, ...]


@dataclass(frozen=True)
class AssignmentBatch:
    items: tuple[PlanDecision, ...]
    work_claims: int


def validate_rule(rule: Any) -> str:
    mode = str(_value(rule, "distribution_mode", "balanced_finish") or "").strip()
    if mode not in SUPPORTED_MODES:
        raise InvalidAssignmentConfiguration(f"Unsupported distribution mode '{mode}'.")
    minimum = _value(rule, "minimum_claim_chunk", 25)
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum <= 0:
        raise InvalidAssignmentConfiguration("Minimum claim chunk must be a positive integer.")
    return mode


def eligible_bots(
    bots: Iterable[Any],
    *,
    effective_at: Optional[datetime] = None,
) -> EligibilityResult:
    when = effective_at or datetime.now(LAGOS)
    if when.tzinfo is None:
        when = when.replace(tzinfo=LAGOS)
    local_time = when.astimezone(LAGOS).time().replace(tzinfo=None)
    eligible = []
    exclusions = []
    for bot in bots:
        bot_id = str(_value(bot, "id", ""))
        if _value(bot, "is_active", True) is False:
            exclusions.append(Exclusion(bot_id, "inactive"))
            continue
        if _value(bot, "is_available", True) is False:
            exclusions.append(Exclusion(bot_id, "unavailable"))
            continue
        status = str(_value(bot, "availability_status", "") or "").strip().lower()
        if status not in AVAILABLE_STATUSES:
            exclusions.append(Exclusion(bot_id, "availability_status"))
            continue
        ratio = float(_value(bot, "support_capacity_ratio", 1) or 0)
        if ratio <= 0:
            exclusions.append(Exclusion(bot_id, "invalid_capacity"))
            continue
        start = _parse_time(_value(bot, "active_from_time", ""))
        end = _parse_time(_value(bot, "active_to_time", ""))
        if not _inside_window(local_time, start, end):
            exclusions.append(Exclusion(bot_id, "outside_active_window"))
            continue
        eligible.append(bot)
    eligible.sort(key=lambda item: (int(_value(item, "priority_order", 100) or 100), str(_value(item, "id", ""))))
    return EligibilityResult(tuple(eligible), tuple(exclusions))


def _metric(metrics: Mapping[str, Any], bot: Any) -> Any:
    return metrics.get(str(_value(bot, "id", "")))


def _speed(bot: Any, metric: Any) -> float:
    observed = float(_value(metric, "claims_per_hour", 0) or 0)
    base = observed if observed > 0 else 1.0
    role = str(_value(bot, "assignment_role", "primary") or "primary").lower()
    ratio = float(_value(bot, "support_capacity_ratio", 1) or 1)
    return max(base * (ratio if role == "support" else 1), 0.01)


def plan_assignments(
    mode: str,
    piles: Iterable[Any],
    bots: Iterable[Any],
    metrics: Mapping[str, Any],
    rule: Any,
    *,
    effective_at: Optional[datetime] = None,
    primary_min_share: float = 0.6,
    speed_resolver: Optional[Callable[[Any, Any], float]] = None,
) -> PlanningResult:
    configured_mode = validate_rule(rule)
    if mode != configured_mode:
        raise InvalidAssignmentConfiguration(
            f"Requested mode '{mode}' does not match configured mode '{configured_mode}'."
        )
    pile_exclusions = []
    pending = []
    for pile in piles:
        remaining = max(int(_value(pile, "remaining_claims", 0) or 0), 0)
        if remaining == 0:
            pile_exclusions.append(Exclusion(str(_value(pile, "tracking_key", "")), "no_remaining_claims"))
        else:
            pending.append((pile, remaining))
    pending.sort(key=lambda item: (-item[1], str(_value(item[0], "tracking_key", ""))))

    if mode == "manual_override":
        return PlanningResult(
            (), tuple(pile_exclusions),
            tuple(ManualDisposition(pile) for pile, _remaining in pending),
        )

    eligibility = eligible_bots(bots, effective_at=effective_at)
    if not eligibility.eligible:
        raise InvalidAssignmentConfiguration("No eligible bot accounts are available for assignment.")

    if mode == "single_owner":
        primaries = [
            bot for bot in eligibility.eligible
            if str(_value(bot, "assignment_role", "primary") or "primary").lower() == "primary"
        ]
        if len(primaries) != 1:
            raise InvalidAssignmentConfiguration(
                "Single owner mode requires exactly one eligible primary bot."
            )
        return PlanningResult(
            tuple(PlanDecision(pile, primaries[0], remaining) for pile, remaining in pending),
            tuple([*pile_exclusions, *eligibility.exclusions]),
            (),
        )

    resolver = speed_resolver or _speed
    entries = []
    for bot in eligibility.eligible:
        metric = _metric(metrics, bot)
        speed = max(float(resolver(bot, metric)), 0.01)
        load = max(int(_value(metric, "active_claim_load", _value(bot, "current_claim_load", 0)) or 0), 0)
        entries.append({"bot": bot, "speed": speed, "load": load, "assigned": 0})

    def choose(candidates):
        return min(
            candidates,
            key=lambda entry: (
                (entry["load"] + entry["assigned"]) / entry["speed"],
                int(_value(entry["bot"], "priority_order", 100) or 100),
                str(_value(entry["bot"], "id", "")),
            ),
        )

    decisions = []
    remaining_items = list(pending)
    primary_entries = [
        entry for entry in entries
        if str(_value(entry["bot"], "assignment_role", "primary") or "primary").lower() == "primary"
    ]
    if primary_entries and len(primary_entries) < len(entries):
        floor = max(1, math.ceil(sum(work for _pile, work in pending) * primary_min_share))
        assigned_to_primary = 0
        while remaining_items and assigned_to_primary < floor:
            pile, work = remaining_items.pop(0)
            entry = choose(primary_entries)
            entry["assigned"] += work
            assigned_to_primary += work
            decisions.append(PlanDecision(pile, entry["bot"], work))
    for pile, work in remaining_items:
        entry = choose(entries)
        entry["assigned"] += work
        decisions.append(PlanDecision(pile, entry["bot"], work))
    return PlanningResult(
        tuple(decisions), tuple([*pile_exclusions, *eligibility.exclusions]), ()
    )


def batch_plans(plans: Iterable[PlanDecision], *, target_claims: int) -> tuple[AssignmentBatch, ...]:
    if target_claims <= 0:
        raise InvalidAssignmentConfiguration("Batch target must be positive.")
    groups: dict[tuple[str, str, str, str, str], list[PlanDecision]] = {}
    for plan in plans:
        pile = plan.pile
        key = (
            str(_value(plan.bot, "id", "")),
            str(_value(pile, "assignment_type", "")),
            str(_value(pile, "status_bucket", "")),
            str(_value(pile, "filter_month", "")),
            str(_value(pile, "filter_year", "")),
        )
        groups.setdefault(key, []).append(plan)
    batches = []
    for key in sorted(groups):
        current = []
        current_claims = 0
        for plan in groups[key]:
            current.append(plan)
            current_claims += plan.work_claims
            if current_claims >= target_claims:
                batches.append(AssignmentBatch(tuple(current), current_claims))
                current = []
                current_claims = 0
        if current:
            batches.append(AssignmentBatch(tuple(current), current_claims))
    return tuple(batches)
