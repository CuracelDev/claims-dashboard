# Piles Assignment Completion Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account for every discovered pile, recover transient scanning and selection failures safely, and report confirmed assignment outcomes accurately across all insurers.

**Architecture:** Retain the existing dispatcher, execution ledger and browser runner. Repair their discovery → selection → submission → reconciliation boundaries using stable pile identity and persisted evidence. Treat uncertain submissions separately from work proven never submitted; preserve resumable work without blindly replaying assignments.

**Tech Stack:** Python, Playwright, PostgreSQL, Node.js, Next.js, GitHub Actions.

**Spec:** The user's investigation/implementation request and requirements in this document, informed by the 21 October production audit and `docs/piles-auto-assignment-runbook.md`. Read the runbook from the current implementation base before execution.

## Global constraints

- Start implementation from freshly fetched main in an isolated branch/worktree; this local worktree is behind production. Preserve unrelated user changes. Reconfirm production SHA; the audited deployment was `8599e2a985d01218c7cd7152b203445cb281dd85`.
- Production investigation is read-only. Tests must not click assignment, trigger execute runs, change schedules, or repair live records. Deployment and historical remediation are separate operational actions.
- Apply fixes to every insurer, manual and scheduled dispatch, every supported month/year/status scope, and both fresh assignments and reassignments. No insurer-specific bypasses.
- The 9 a.m. gate applies to reassignments; it must not block eligible fresh assignments. Preserve existing roster, eligibility, inactive-insurer and ownership rules.
- Never convert missing/ambiguous evidence to success. Never replay an uncertain submission just because a timeout occurred.
- Do not truncate discovery to a fixed number of pages, piles or elapsed minutes. Bound individual recovery attempts; retain explicit outstanding work when recovery is exhausted.
- Every discovered identity must have an explainable outcome: confirmed intended owner, positively observed existing owner, explicit ineligibility, safely retryable work, or unresolved/conflicting evidence. An existing owner is not proof that this runner assigned it.
- Aggregate attempts across runs are not unique missed piles. Preserve assignment provenance and distinguish piles from claims.
- Keep credentials, patient information, portal bodies and identifying production fixtures out of commits and Actions logs.

## Evidence and open questions

Production inspection: https://github.com/CuracelDev/claims-dashboard/actions/runs/39622910942 (snapshot 2026-10-21 15:08 UTC).

- Uganda: six scans failed at deployed runner line 6031, where the next-page response could not be confirmed. The underlying HTTP/timeout/context mismatch is not yet known.
- Uganda's 08:00 Lagos run submitted 57 piles; later ledger evidence confirmed 43 and marked 14 (21 claims) for manual action. Their ultimate portal ownership is not established.
- Tanzania's morning run planned 44 piles including arrivals, confirmed seven, and recorded 37 unsubmitted failures (112 claims). Deferral/final relocation is a candidate explanation; exact attempt reason codes must confirm it.
- Subsequent Tanzania scans reported no unassigned piles. This does not link those earlier failures to later owners or establish runner recovery.
- Kenya had 41 confirmed attempts/77 claims and no failed attempts in the inspected window; completeness of discovery still needs independent comparison.
- Liveness reported healthy despite assignment issues. Availability and assignment correctness need separate signals.

Do not claim a root cause from aggregated counters alone. Tasks 1–2 decide the exact repair within the boundaries below; record and review any scope change before coding it.

## Review focus

1. Rows move between pages/statuses while assignments change the table: Tasks 2–4 verify identity coverage and relocation.
2. Portal accepts a submission but the worker loses its response: Tasks 4–5 verify reconciliation without duplicate assignment.
3. A pile becomes assigned by another actor during planning: Tasks 3–4 preserve ownership and do not label it runner-confirmed.
4. Worker crashes or a scheduled request overlaps recovery: Tasks 4 and 7 verify leases, resumability and exactly one submission owner.
5. Roster/time/insurer eligibility changes while a retry is pending: Tasks 3, 4 and 7 revalidate eligibility and the reassignment-only time gate.

## File map

- `scripts/inspect-piles-runner-incidents.mjs`, `.github/workflows/piles-incident-inspection.yml`: sanitized investigation output.
- `scripts/piles_auto_assignment_runner.py`: browser navigation, selection, response evidence and workflow integration.
- `scripts/piles_auto_assignment/scanning.py`, `reconciliation.py`, `store.py`, `dispatch.py`: existing coverage, reconciliation, persistence and work ownership responsibilities; inspect current interfaces before modifying.
- Existing `scripts/test_piles_auto_assignment_{runner,scanning,execution,reconciliation,store,dispatch_integration}.py`: regression and acceptance coverage.
- Create `scripts/inspect-piles-runner-incidents.test.mjs`: inspector projection/privacy tests.
- `lib/piles-auto-assignment-liveness.mjs`, its `.test.mjs`, `scripts/audit-piles-schedule-liveness.mjs`, `.github/workflows/piles-schedule-liveness.yml`: operational monitoring.
- `lib/piles-auto-assignment-history.mjs` and its `.test.mjs`: truthful user-facing outcomes.
- `docs/piles-auto-assignment-runbook.md` and this plan: deployment, evidence and progress record.

Avoid a broad runner rewrite. If schema additions prove necessary, add an additive migration and compatibility tests as a separate prerequisite commit; do not bundle a schema change into browser fixes.

## Commit 1 — Expose actionable, sanitized failure evidence

**Suggested commit:** `feat(piles): expose assignment recovery diagnostics`

**Interface:** Extend the existing inspection report additively with grouped attempt evidence codes, submission state and recovery counts. Preserve existing report fields and their meanings.

- [ ] Read current ledger schema, evidence writers, inspector queries and deployed response handling. Identify precisely where the original error is lost.
- [ ] Add failing tests asserting that known reason codes and numeric counts survive projection, while tokens, URLs with query values, claim details and arbitrary error text cannot appear.
- [ ] Add bounded, allowlisted diagnostics for page index, expected context, HTTP status, response-match result, elapsed wait and recovery attempt. Do not capture response bodies.
- [ ] Extend inspection with counts by attempt reason and distinct stable identity; explicitly separate attempt count, unique pile count and claim count.
- [ ] Run `node --test scripts/inspect-piles-runner-incidents.test.mjs` and affected Python diagnostics tests; review the output privacy boundary, then commit.
- [ ] Re-run committed tests and `git show --check HEAD`; log SHA and results below.

## Investigation checkpoint — Establish exact causes before behavior changes

This checkpoint uses approved read-only host/database access. If deploying new diagnostics is needed, ship Commit 1 independently through the normal release process first.

- [ ] Match the 37 Tanzania failures and 14 Uganda unresolved submissions by stable identity to attempt history, subsequent scans and authoritative current/historical portal assignment evidence. Also examine earlier Uganda failures and conflicts without double-counting identities.
- [ ] Record safe aggregate reasons: never submitted, accepted and later confirmed, moved context, changed owner, changed identity, not found, or genuinely still unassigned. Keep unknowns explicit.
- [ ] Inspect full pagination failure causes and compare actual request parameters with the runner's expected page/month/year/status. Distinguish slow response, HTTP error, stale request, selector change and matcher defect.
- [ ] Independently compare read-only portal totals/identities against runner discovery for Uganda, Tanzania, Kenya and the other active insurers. Include every configured status and year.
- [ ] Produce synthetic fixtures reproducing the observed failure shapes; do not commit production claim data.
- [ ] Update this plan with confirmed causes and attach sanitized evidence. Do not treat successful empty scans as resolution of old failures.

## Commit 2 — Recover complete pagination reliably

**Suggested commit:** `fix(piles): recover interrupted pagination without losing coverage`

**Interfaces:** Preserve `goto_next_page`, `_wait_for_piles_filter_response` and `_scan_status_with_transient_retry` contracts. Complete scan evidence must represent one verified context, not a mixture of aborted passes.

- [ ] Add failing fixture tests for the confirmed request failure plus delayed response, wrong-context response, duplicate/stale response, transient HTTP failure, and rows moving during pagination.
- [ ] Repair the proven matching/navigation defect. Use bounded read-only retries with backoff and fresh request correlation; do not simply increase every sleep or accept any successful response.
- [ ] On ambiguous navigation, reopen the exact context and deduplicate by stable identity. Do not blindly click Next twice, skip pages, or count an incomplete pass as complete.
- [ ] Verify first/last/empty pages, repeated fingerprints, page-size changes and filter/year combinations. Exhausted recovery must preserve incomplete status and diagnostic evidence.
- [ ] Run `python3 -m unittest scripts/test_piles_auto_assignment_scanning.py scripts/test_piles_auto_assignment_runner.py -v`; review and commit.
- [ ] Repeat affected tests on the commit and `git show --check HEAD`; record results.

## Commit 3 — Account for every planned, unsubmitted pile

**Suggested commit:** `fix(piles): reconcile deferred plans by stable identity`

**Interfaces:** Keep `execute_assignment_plan(..., defer_unresolved=...)`; its deferral and final scan must produce an explicit disposition for every persisted planned identity.

- [ ] Add failing tests reproducing Tanzania's verified cause: partial selection, page relocation, status/year movement, identity ambiguity, and rows assigned elsewhere between discovery and selection.
- [ ] Match relocation through the established canonical identity and verified aliases. Never match only on provider/month or silently merge different piles.
- [ ] Distinguish missing rows from positively observed assigned rows; store their different outcomes. Preserve eligible never-submitted work for safe recovery rather than silently discarding it.
- [ ] Revalidate recipient mapping, active insurer and current roster before submission. Preserve rules for fresh assignments versus reassignments.
- [ ] Assert discovered/planned identity coverage, including late arrivals, without double-counting contexts or adding overlapping counters.
- [ ] Run `python3 -m unittest scripts/test_piles_auto_assignment_execution.py scripts/test_piles_auto_assignment_planning.py -v`; review and commit.
- [ ] Re-run affected tests and commit checks; record results.

## Commit 4 — Resume outstanding work without duplicate submissions

**Suggested commit:** `fix(piles): resume recoverable work under insurer ownership`

**Interfaces:** Reuse existing ledger transitions and dispatcher lease/advisory-lock contracts. Attempt failure must not implicitly authorize replay.

- [ ] Add failing tests for worker crash before submit, after submit but before persistence, exhausted selection retries, overlapping scheduled requests and lease loss during recovery.
- [ ] Distinguish known unsubmitted work, positively observed still-unassigned work and uncertain submissions. Only the first two can become assignment candidates after fresh eligibility/ownership verification.
- [ ] Reuse existing durable work representation to resume outstanding identities in a later owned cycle; introduce additive schema only if the existing representation cannot express this safely.
- [ ] Give exhausted recoveries an explicit actionable outcome with attempt history. Prevent tight retry loops and starvation of new eligible work.
- [ ] Revalidate roster, disabled insurer, intended recipient and reassignment time before recovery. Leave conflicts/unknown submissions protected until resolved.
- [ ] Run store, reconciliation and dispatcher integration tests, including real PostgreSQL concurrency tests supported by the repository against an isolated test database; review and commit.
- [ ] Re-run affected tests and commit checks; record results.

## Commit 5 — Resolve submission uncertainty across context movement

**Suggested commit:** `fix(piles): verify pending submissions across pile movement`

**Interface:** Preserve `reconcile_pending_attempts` and its ledger decisions. Confirmation requires observed ownership matching the intended recipient, backed by valid identity evidence.

- [ ] Add failing tests for accepted submission with lost response, movement from Vetting Pending to Ongoing, completed/archived rows, different owner, ambiguous identity and no readable observation.
- [ ] Apply the verified identity/context repair to reconciliation. Use available authoritative assignment history when a pile is no longer present in the active table; do not invent a portal API or assume audit availability.
- [ ] Keep insufficient evidence unresolved with a specific reason and clear review path. Do not mark it assigned, blame a human, or automatically resubmit it.
- [ ] Ensure later reconciliation updates history totals consistently while retaining original run/attempt evidence.
- [ ] Run reconciliation, evidence and execution tests; review and commit, then repeat affected tests and commit checks.

## Commit 6 — Make assignment health and UI outcomes truthful

**Suggested commit:** `fix(piles): surface unresolved assignment health`

**Interface:** Keep scheduler liveness as an availability signal and add a distinct assignment-health result. History uses ledger-backed confirmed and unresolved outcomes.

- [ ] Add failing tests for a healthy scheduler with failed assignments, an empty later run with older unresolved work, partial confirmation, covered-by-active-cycle, and later successful reconciliation.
- [ ] Report affected insurer, issue age, verified counts and reason; distinguish current work from historical unresolved evidence.
- [ ] Make unresolved assignment health visible to the existing monitoring workflow. Deduplicate repeat alerts and retain meaningful changes; tests use fake notification delivery.
- [ ] Ensure completed/covered labels cannot imply assignment success without evidence. Correct counter freshness after later reconciliation.
- [ ] Run `node --test lib/piles-auto-assignment-liveness.test.mjs lib/piles-auto-assignment-history.test.mjs`; review, commit and repeat affected checks.

## Commit 7 — End-to-end regression coverage and release procedure

**Suggested commit:** `test(piles): cover recovery and assignment completion end to end`

- [ ] Add deterministic synthetic browser/portal scenarios exercising real discovery, selection, submission and reconciliation boundaries. Simulate the production failures and a restart; assert one submission per eligible identity and the intended recipient.
- [ ] Test every active-insurer configuration shape, multi-page/multi-year scans, late arrivals, no-work, disabled insurer, weekend roster and both sides of the 9 a.m. reassignment gate.
- [ ] Verify that a slow context cannot be falsely completed or silently dropped, and that overlapping requests preserve outstanding work without duplicate execution.
- [ ] Run `npm run test:piles`, `npm run test:piles:acceptance`, new inspector tests, `npm run build`, Python compilation and `git diff --check` from the implementation checkout. Include isolated PostgreSQL races; record unavailable checks rather than claiming them passed.
- [ ] Update the runbook with evidence capture, schema-first ordering if needed, recovery eligibility, monitoring and rollback. Rollback retains ledger evidence and never automatically replays uncertain attempts.
- [ ] Review the entire branch for correctness, concurrency, sensitive output and unintended scope. Commit tests/docs, then repeat the release checks against that exact commit.

## Production validation and historical resolution

1. Verify the final commit, CI and any additive schema prerequisites before deployment. Validate Python runtime and deployed worker/application versions together.
2. Run read-only discovery probes and compare their identity coverage with the portal. A read-only probe cannot prove submission works.
3. Observe an ordinary scheduled execution with eligible piles after deployment; do not create an execute run as a test. Trace discovery through actual confirmed ownership for each active insurer with eligible work. An insurer with no work remains unverified for assignment.
4. Check at least two subsequent scheduled cycles for recovery, duplicate submissions, unresolved backlog, conflicts and run duration. Larger representative workloads still need observation; two cycles are not a reliability guarantee.
5. Reconcile the original incident identities separately. Apply any required historical repair only to reviewed exact targets, preserving the audit trail and avoiding replay of uncertain submissions.
6. Final report distinguishes deployed changes, observed successful assignments, remaining unknowns and remediation still outstanding. No all-clear based solely on green Actions, liveness or empty scans.

## Progress and audit record

For each commit append: SHA; exact change; regression reproduced; commands/results before and after commit; reviewer findings; remaining evidence gaps. For production observations append UTC and Lagos time, deployed SHA, workflow/run references, unique identity coverage, confirmed ownership totals, unresolved reasons and any operational action taken.

**Execution status:** Implementation started on `fix/piles-assignment-completion-repair`, based on deployed/main `8599e2a`. Production unchanged.

Task 1 diagnostics: reproduced missing report reason groups and lost chained scan metadata (RED), implemented additive sanitized diagnostics (GREEN). Baseline: 23 runtime Python tests, 525 Piles Python tests, 152 Node tests passed. Updated: 23 runtime, 528 Piles Python and 152 existing Node tests passed; three new inspector tests passed, including actual PostgreSQL aggregation on an isolated temporary database. The new tests now join `npm run test:piles`; database integration additionally requires `PILES_TEST_DATABASE_URL` pointing to a disposable test database.

Ruling: Record page/HTTP/timing evidence in the existing failure JSON without a migration. Use the existing scan context records for requested filters; do not duplicate arbitrary filter/error strings in diagnostic output. More extensive retry telemetry can accompany the verified retry repair.

Investigation: identified a concrete candidate in `_wait_for_piles_filter_response`: it waits for Playwright event callbacks while calling `time.sleep`, which prevents sync Playwright from processing asynchronous events. Official documentation describes this limitation at https://playwright.dev/python/docs/library#timesleep-leads-to-outdated-state. Reproduce with a local real browser before changing this path. This finding does not yet resolve Tanzania's exact historical identities.
