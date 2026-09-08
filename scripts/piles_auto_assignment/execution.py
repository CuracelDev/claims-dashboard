"""Side-effect ordering for durable assignment batch execution."""

from dataclasses import asdict, dataclass, is_dataclass
from typing import Any, Mapping

from .domain import AttemptStatus


def _value(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _record(item: Any) -> dict[str, Any]:
    if isinstance(item, Mapping):
        return dict(item)
    if is_dataclass(item):
        return asdict(item)
    return dict(vars(item))


@dataclass(frozen=True)
class BatchExecutionResult:
    batch_id: str
    selected_tracking_keys: tuple[str, ...]
    acknowledgement: Any


def execute_persisted_batch(portal: Any, ledger: Any, batch: Any) -> BatchExecutionResult:
    attempts = tuple(_value(batch, "attempts", ()))
    batch_id = ledger.create_batch_with_attempts(
        _value(batch, "record", {}),
        [_record(attempt) for attempt in attempts],
    )
    selected = set(portal.select_batch(batch))
    selected_attempts = [
        attempt for attempt in attempts
        if str(_value(attempt, "tracking_key", "")) in selected
    ]
    for attempt in selected_attempts:
        ledger.transition_attempt(
            str(_value(attempt, "id", "")),
            AttemptStatus.SELECTED,
            expected={AttemptStatus.PLANNED},
        )
    acknowledgement = None
    if selected_attempts:
        acknowledgement = portal.submit_assignment(batch, selected)
        for attempt in selected_attempts:
            ledger.transition_attempt(
                str(_value(attempt, "id", "")),
                AttemptStatus.SUBMITTED,
                expected={AttemptStatus.SELECTED},
                evidence={"code": "portal_submit_returned", "details": acknowledgement},
            )
    return BatchExecutionResult(
        batch_id=batch_id,
        selected_tracking_keys=tuple(sorted(selected)),
        acknowledgement=acknowledgement,
    )
