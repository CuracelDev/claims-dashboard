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
