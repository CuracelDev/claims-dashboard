"""Deterministic overlap coalescing used by the durable scheduler adapter."""

import os
import uuid
from dataclasses import dataclass
from typing import Mapping, Optional


def configured_max_concurrency(environ: Optional[Mapping[str, str]] = None) -> int:
    source = os.environ if environ is None else environ
    try:
        value = int(source.get("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY", "1"))
    except (TypeError, ValueError) as error:
        raise ValueError("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2") from error
    if value not in {1, 2}:
        raise ValueError("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2")
    return value


@dataclass(frozen=True)
class ScheduleDecision:
    insurer_name: str
    request_id: str
    status: str
    coalesced_request_id: str = ""


class CoalescingScheduler:
    """Small in-memory model of the PostgreSQL lock/coalescing contract."""

    def __init__(self) -> None:
        self.active: dict[str, ScheduleDecision] = {}
        self.pending: dict[str, ScheduleDecision] = {}

    def request(self, insurer_name: str, request_id: str = "") -> ScheduleDecision:
        key = insurer_name.strip().lower()
        request_id = request_id or str(uuid.uuid4())
        if key not in self.active:
            decision = ScheduleDecision(insurer_name, request_id, "running")
            self.active[key] = decision
            return decision
        if key not in self.pending:
            self.pending[key] = ScheduleDecision(
                insurer_name, request_id, "skipped_overlap", coalesced_request_id=request_id,
            )
        return self.pending[key]

    def finish(self, active: ScheduleDecision) -> Optional[ScheduleDecision]:
        key = active.insurer_name.strip().lower()
        self.active.pop(key, None)
        pending = self.pending.pop(key, None)
        if pending is None:
            return None
        followup = ScheduleDecision(active.insurer_name, pending.request_id, "running")
        self.active[key] = followup
        return followup
