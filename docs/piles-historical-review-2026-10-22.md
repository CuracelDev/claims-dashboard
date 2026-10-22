# Historical assignment review — 22 October 2026

## Production evidence

These were read-only scans using deployed browser dependencies and diagnostic
revision `8c3bb91`. No assignments, ledger repairs, schedule changes, deployment,
or Slack messages were performed by the diagnostics.

| Insurer | GitHub inspection run | Completed (UTC) | Latest unresolved candidates | Visible active piles | Visible unassigned | Candidate outcomes |
| --- | --- | --- | --- | --- | --- | --- |
| Jubilee Uganda | [39807470830](https://github.com/CuracelDev/claims-dashboard/actions/runs/39807470830) | 15:47:55 | 4 | 0 | 0 | 4 missing |
| DEFMIS | [39807682628](https://github.com/CuracelDev/claims-dashboard/actions/runs/39807682628) | 15:52:28 | 13 | 1 | 0 | 13 missing |

Both diagnostics reported complete scans of the configured active status set,
all months and years, with a 24-hour candidate window. Neither supplied positive
ownership evidence for the historical exceptions. This does **not** establish
that these claims were assigned, completed, or eligible for reassignment; active
screens cannot explain records that have left those screens. It also does not
prove overall production assignment health outside these snapshots.

The earlier database snapshot distinguished four submitted Uganda exceptions
and one submitted DEFMIS exception from twelve DEFMIS failures without submission.
Those distinctions remain important: a failed pre-submission selection cannot be
retroactively attributed to the runner merely because someone else later owns it.

## Implementation and safety review

- Read-only targeted review is available through the incident workflow. It uses
  existing insurer/capacity locks and refuses candidate truncation.
- A separate, explicitly acknowledged single-attempt confirmation path requires
  fresh exact portal identity and intended ownership, original submission,
  unchanged records, no superseding attempt, and no tracked-mirror collision.
- Confirmation and its tracked projection/counters are atomic. Original failure
  evidence is retained and original run outcomes are not rewritten as successes.
- Duplicate scan observations now fail closed if ownership or portal identity
  conflicts, including on repeated pages before deduplication.
- Regression tests exercise identity ambiguity, missing rows, stale evidence,
  superseding attempts, mirror collisions, foreign locks and transaction rollback
  against disposable PostgreSQL. No test submits production assignments.

Independent review identified the duplicate-observation and tracked-mirror edge
cases; both were reproduced in tests and corrected before release. Confirmation
tooling is not deployed or activated by running the read-only diagnostic workflow.

Local release validation passed: 584 Python tests, 169 Node tests (no skips),
and 12 explicit PostgreSQL transaction tests using a disposable localhost database.
These validate the tooling and safeguards, not the missing historical ownership.

## Outstanding evidence checkpoint

Keep all 17 exceptions unresolved until authoritative claim/pile history identifies
their current or terminal state. Match immutable pile/claim IDs, assignment actor,
recipient and timestamps against the original submission evidence. Do not mark
missing rows confirmed or reset them for blind retry. If that history positively
shows an eligible unassigned pile, use the normal assignment path with current
recipient eligibility and duplication checks; this reviewer never assigns it.
