"""Pure dispatch coverage decisions for the durable scheduler adapter."""

import os
from typing import Mapping, Optional

from .domain import (
    DispatchDecision,
    InsurerCoverage,
    RequestScope,
    WorkDisposition,
    WorkRequest,
    execution_scope_contains,
)


def configured_max_concurrency(environ: Optional[Mapping[str, str]] = None) -> int:
    source = os.environ if environ is None else environ
    try:
        value = int(source.get("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY", "1"))
    except (TypeError, ValueError) as error:
        raise ValueError("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2") from error
    if value not in {1, 2}:
        raise ValueError("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2")
    return value


def decide_dispatch(
    request: WorkRequest,
    coverage: InsurerCoverage,
) -> DispatchDecision:
    """Decide whether a request needs work without reading mutable state."""
    disposition = WorkDisposition.QUEUED
    create_work_item = True
    covered_by_run_id = ""

    compatible_coverage = execution_scope_contains(coverage, request)
    if coverage.state == "inactive":
        disposition = WorkDisposition.INACTIVE
    elif request.request_scope == RequestScope.ALL_ACTIVE and compatible_coverage:
        active_all_cycle = coverage.active_request_scope == RequestScope.ALL_ACTIVE
        covered_by_active_cycle = active_all_cycle and coverage.state in {
            "queued",
            "claimed",
            "running",
        }
        completed_after_request = (
            active_all_cycle
            and coverage.state == "completed"
            and coverage.active_finished_at is not None
            and coverage.active_finished_at >= request.requested_at
        )
        if covered_by_active_cycle or completed_after_request:
            disposition = WorkDisposition.COVERED_BY_ACTIVE_CYCLE
            covered_by_run_id = coverage.active_run_id
    elif compatible_coverage and coverage.state in {"claimed", "running"}:
        disposition = WorkDisposition.FOLLOW_UP_QUEUED
        create_work_item = not coverage.follow_up_queued
    elif compatible_coverage and (coverage.state == "follow_up_queued" or coverage.follow_up_queued):
        disposition = WorkDisposition.FOLLOW_UP_QUEUED
        create_work_item = False
    elif compatible_coverage and coverage.state == "queued":
        disposition = WorkDisposition.QUEUED
        create_work_item = False

    return DispatchDecision(
        insurer_name=request.insurer_name,
        source=request.source,
        request_scope=request.request_scope,
        disposition=disposition,
        generation_requested_at=request.requested_at,
        create_work_item=create_work_item,
        covered_by_insurer_run_id=covered_by_run_id,
    )
