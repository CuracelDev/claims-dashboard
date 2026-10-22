# Piles monitoring separation and unresolved evidence investigation

Approved scope: investigate real production concerns and separate scheduler health,
current assignment incidents and historical reconciliation backlog. Never submit
assignments, clear old evidence or infer current portal ownership from missing rows.

## Task 1 — Read-only production evidence

- Inspect recent run/attempt reasons and compare later confirmed evidence for the
  same tracking key or stable portal identity. Output aggregate evidence only.
- Preserve unknown outcomes; a later confirmation is ledger evidence, not a live
  portal ownership check. Different recipients and ambiguous identities must not
  become confirmed recovery.
- Test SQL/projection using isolated PostgreSQL before using versioned inspection.

## Task 2 — Separate health signals

- Retain overall assignment health and all historical records.
- Report recent (last 24 hours by attempt creation) and historical unresolved
  cohorts separately. This is a reporting window, not a recovery deadline.
- Fail operational checks for unhealthy scheduler, current cycle issues, recent
  unresolved attempts, or missing/invalid evidence. Historical backlog alone is
  a warning, never a claim that all assignments are healthy.
- Deduplicate unchanged alerts; report operational recovery independently from
  outstanding historical backlog. Do not send a false all-clear.
- Add failing tests first, then implementation and full regression verification.

## Task 3 — Verification and handoff

- Real SQL, notification/state, inspector privacy and boundary tests; full Piles
  suite and production build. Independent review of the full change set.
- Commit scoped changes and record production evidence and uncertainties.
- Deployment/merge is separate from investigation; do not change production
  schedules or historical assignment records during this task.

## Decisions and evidence

- Base: a01a6a1. Existing isolated worktree reused on a fresh branch.
- The prior health query considered all historical attempts and intentionally
  returned exit 20 for the backlog. This conflated scheduler operation with old
  evidence. Age alone will not remove an item or mark it resolved.

## Production findings and implementation record

- Read-only snapshot [39793792493](https://github.com/CuracelDev/claims-dashboard/actions/runs/39793792493),
  October 22 14:13 UTC / 15:13 Lagos: DEFMIS had 10 missing-at-final-scan
  planned identities (13 claims), one exhausted selection retry (one claim),
  one positively observed already-assigned row, and one uncertain historical
  submission (two claims). Uganda had four uncertain submissions (five claims).
  Latest scheduled parents completed; other assignments were confirmed in all
  four insurers during the window. These exceptions are not an overall outage.
- Follow-up snapshot [39795791250](https://github.com/CuracelDev/claims-dashboard/actions/runs/39795791250),
  14:27 UTC / 15:27 Lagos: 82 historical failed tracking keys had later confirmed
  evidence using the same insurer and stable portal hash (3 Kenya, 79 Uganda).
  This does not prove current ownership or justify replay/automatic closure.
  No later matching confirmation was found for the recent DEFMIS/Uganda groups.
- The first version of the follow-up query preferred same-recipient evidence
  when both same/different recipients appeared later. Independent review found
  this ambiguity; a failing real SQL test reproduced it. Commit `5efab06`
  preserves a separate mixed-recipient category. The 82-identity total above is
  unaffected, but the earlier same/different breakdown is not an exclusive
  ownership conclusion and is intentionally not repeated here.
- `9d24921`: aggregate-only read-only diagnostics, tested with real temporary SQL
  tables; statement timeout bounds queries without returning partial success.
- `914e9cc`: overall health remains false for backlog, but operational exit status
  separates scheduler/current assignment incidents from historical warnings.
  Missing cohort evidence fails closed; notifications distinguish operational
  recovery from full reconciliation. No production schedule or ledger changed.
- Focused reviewed tests: 25/25 with real isolated PostgreSQL. Full suite before
  the mixed-evidence correction: 23 runtime + 532 runner Python, 167 Node tests,
  no skips. Build passed. Final postcommit regression recorded at handoff.
- Remaining: current portal/audit ownership verification for recent exceptions;
  explain Tanzania's current-cycle manual-action outcomes; representative query
  performance and release validation. No claim that all piles are assigned.
- Final postcommit suite: 23 runtime + 532 runner Python and 167 Node tests passed,
  no skips, with isolated PostgreSQL enabled. No production data mutations or
  assignment tests were performed. The independent review's mixed-recipient
  finding was reproduced RED, corrected GREEN, and covered by this full suite.
