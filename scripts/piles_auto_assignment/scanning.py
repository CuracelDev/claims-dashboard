"""Deterministic completeness accounting for portal table scans."""

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Tuple

from .domain import ContextStatus


class IncompleteScan(RuntimeError):
    pass


class TrackingKeyCollision(RuntimeError):
    pass


def _value(row: Any, name: str, default: Any = None) -> Any:
    if isinstance(row, Mapping):
        return row.get(name, default)
    return getattr(row, name, default)


def _identity(row: Any) -> Tuple[str, str, int, str]:
    return (
        str(_value(row, "tracking_key", "")).strip(),
        str(_value(row, "provider", "")).strip(),
        int(_value(row, "claims", 0) or 0),
        str(_value(row, "submitted_date", "")).strip(),
    )


@dataclass(frozen=True)
class FilterContext:
    filter_month: str
    requested_year: str
    status_bucket: str


def late_arrival_contexts(scan_results: Iterable["ScanResult"]) -> tuple[FilterContext, ...]:
    """Select settled initial contexts, independent of their row/plan counts."""
    return tuple(sorted({
        result.context for result in scan_results
        if result.context is not None
        and result.status in {ContextStatus.COMPLETE, ContextStatus.EMPTY}
    }, key=lambda context: (context.filter_month, context.requested_year, context.status_bucket)))


@dataclass(frozen=True)
class ScanResult:
    status: ContextStatus
    rows: tuple[Any, ...]
    page_count: int
    distinct_pile_count: int
    unassigned_pile_count: int
    claim_count: int
    page_fingerprints: tuple[tuple[Tuple[str, str, int, str], ...], ...]
    context: FilterContext | None = None


class ScanAccumulator:
    def __init__(self) -> None:
        self._rows: dict[str, Any] = {}
        self._identities: dict[str, Tuple[str, str, int, str]] = {}
        self._page_fingerprints: list[tuple[Tuple[str, str, int, str], ...]] = []
        self._seen_page_fingerprints: set[tuple[Tuple[str, str, int, str], ...]] = set()
        self._collisions: set[str] = set()

    def observe_page(self, page_number: int, rows: Iterable[Any]) -> bool:
        del page_number
        page_rows = list(rows)
        fingerprint = tuple(_identity(row) for row in page_rows)
        if fingerprint in self._seen_page_fingerprints:
            return True
        self._seen_page_fingerprints.add(fingerprint)
        self._page_fingerprints.append(fingerprint)

        for row in page_rows:
            identity = _identity(row)
            tracking_key = identity[0]
            if not tracking_key:
                self._collisions.add("<missing>")
                continue
            previous = self._identities.get(tracking_key)
            if previous is not None and previous != identity:
                self._collisions.add(tracking_key)
                continue
            self._identities[tracking_key] = identity
            self._rows.setdefault(tracking_key, row)
        return False

    def finish(self, *, explicit_empty: bool = False) -> ScanResult:
        if self._collisions:
            keys = ", ".join(sorted(self._collisions))
            raise TrackingKeyCollision(f"Conflicting rows shared tracking key(s): {keys}")
        if not self._rows and not explicit_empty:
            raise IncompleteScan(
                "The scan produced no rows and the portal did not explicitly confirm an empty table."
            )
        rows = tuple(self._rows.values())
        return ScanResult(
            status=ContextStatus.EMPTY if not rows else ContextStatus.COMPLETE,
            rows=rows,
            page_count=len(self._page_fingerprints),
            distinct_pile_count=len(rows),
            unassigned_pile_count=sum(
                1 for row in rows if not str(_value(row, "assigned", "")).strip()
            ),
            claim_count=sum(max(int(_value(row, "claims", 0) or 0), 0) for row in rows),
            page_fingerprints=tuple(self._page_fingerprints),
        )
