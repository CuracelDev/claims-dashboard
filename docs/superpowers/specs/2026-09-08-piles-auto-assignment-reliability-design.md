# Piles Auto-Assignment Reliability Design

## Purpose

Make Piles Auto-Assignment reliable, recoverable, observable, and truthful across every active insurer. The system must not silently skip work, duplicate assignments after retries, misreport successful portal changes as failures, or expose configuration that the runner does not enforce.

This design addresses the production failures observed on 8 September 2026 and the same failure classes across filters, scanning, planning, assignment, reconciliation, scheduling, manual triggers, configuration, and reporting.

## Current System

The Next.js dashboard stores insurer credentials, bot configuration, assignment rules, runner history, tracked piles, external assignments, weekend rosters, and event logs in PostgreSQL/Supabase. A Python Playwright runner logs into the Curacel portal, scans every configured month/year/status context, plans assignments, clicks the portal controls, verifies the result in the table, and stores tracking and notification data. Cron invokes an all-active run hourly. Runner Control invokes the same runner through a synchronous Next.js endpoint.

The existing concurrency lock prevents two whole-run processes from assigning simultaneously. The runner creates one overall run record and emits loosely structured JSON event details, but it has no durable per-insurer, per-context, per-batch, or per-pile execution state.

## Production Findings

The investigation established the following failure classes:

1. The year-filter code requires a newly captured matching `/piles` GET response within ten seconds. A correct visible filter can therefore fail when the selection is a no-op, the response is cached, the portal is slow, or the request shape is not captured.
2. The assignment verifier treats more than five percent of target rows disappearing from the filtered table as a failed assignment even when every remaining row has the correct assignee. This aborts the insurer and prevents successful but missing rows from being tracked.
3. Failed insurer execution prevents remaining work for that insurer from being attempted, while later scans may classify the successfully changed portal rows as external assignments.
4. Daniel's available primary row is Jubilee Uganda. Uganda repeatedly failed at filter-response confirmation while hundreds of claims were awaiting assignment; later scans found those piles assigned outside the runner's tracked flow.
5. Bot availability explains some apparent omissions, but availability changes have no durable, queryable audit history.
6. `minimum_claim_chunk` is displayed and stored but is not used by new-assignment execution.
7. `single_owner` and `manual_override` are displayed and stored but are not implemented for new assignments. New assignments always use balanced-finish planning.
8. Runner Control waits synchronously for a process that can take more than an hour, so the reverse proxy returns a false `504` while the process continues.
9. Whole-run locking means an hourly trigger is skipped when the previous multi-insurer run lasts longer than an hour. The skip is reported as a failure rather than an expected coalesced scheduling outcome.
10. Playwright response-finalization warnings are stored in stderr even when the run completed successfully, creating noisy failure signals.

## Design Principles

- Never equate missing evidence with confirmed failure or confirmed success.
- Never retry a portal assignment until the system has established that the pile is still unassigned.
- Persist intent before side effects and persist evidence after each side effect.
- Make every filter context and every pile reach an explicit terminal or pending state.
- Isolate insurer and batch failures so unrelated work can continue.
- Treat browser network events as supporting evidence, not the sole source of truth.
- Make every dashboard option correspond to enforced runner behaviour.
- Preserve production safety: dry-run and read-only probes must not mutate portal assignments.
- Keep schema changes additive and deployable before application changes.

## Target Architecture

The existing CLI remains the process entry point, while focused modules take responsibility for domain models, planning, portal evidence, persistence, and orchestration. This permits incremental extraction from the existing runner without a high-risk rewrite.

Suggested package boundaries:

- `scripts/piles_auto_assignment/domain.py`: enums and immutable records for run, context, batch, attempt, and evidence states.
- `scripts/piles_auto_assignment/planning.py`: pure eligibility, rule validation, batching, balanced-finish, and single-owner planning.
- `scripts/piles_auto_assignment/evidence.py`: pure decisions that combine UI state, network state, table state, and reconciliation observations.
- `scripts/piles_auto_assignment/store.py`: durable state transitions and idempotent database operations.
- `scripts/piles_auto_assignment/portal.py`: Playwright control discovery, filter application, scanning, assignment, and observation.
- `scripts/piles_auto_assignment/orchestrator.py`: per-insurer workflow, continuation policy, retries, and final outcomes.
- `scripts/piles_auto_assignment_runner.py`: environment setup, CLI parsing, compatibility exports, and orchestration entry point.

Extraction must follow characterization tests. Behaviour moves behind interfaces incrementally; the runner is not rewritten in one commit.

## Durable Data Model

All identifiers use UUID text values to remain compatible with existing tables.

### Insurer runs

Add `piles_auto_assignment_insurer_runs`:

- `id`
- `runner_run_id`, referencing `piles_auto_assignment_runner_runs`
- `master_account_id`
- `insurer_name`
- `status`: `queued`, `running`, `completed`, `partial`, `failed`, `skipped_inactive`, or `skipped_overlap`
- `phase`: `configuration`, `login`, `scan`, `plan`, `apply`, `reconcile`, or `complete`
- discovered, planned, submitted, confirmed, reconciliation-pending, conflict, and failed pile/claim counts
- `heartbeat_at`, `started_at`, `finished_at`, `error_code`, and sanitized `error_message`
- timestamps

One row exists for each insurer requested by an overall run. Overall status is derived from insurer outcomes rather than inferred from captured stdout.

### Scan contexts

Add `piles_auto_assignment_scan_contexts`:

- `id`, `insurer_run_id`
- insurer, month, requested year, effective years, and status bucket
- `status`: `pending`, `scanning`, `complete`, `empty`, or `failed`
- page count, distinct pile count, unassigned pile count, and claim counts
- UI, network, and table evidence summaries
- `started_at`, `settled_at`, `finished_at`, and sanitized failure fields

A uniqueness constraint on insurer run, month, requested year, and status prevents duplicate context records.

### Assignment batches

Add `piles_auto_assignment_batches`:

- `id`, `insurer_run_id`, `scan_context_id`
- intended bot and visible portal assignee
- assignment type and status bucket
- `status`: `planned`, `selecting`, `selected`, `submitted`, `partially_confirmed`, `confirmed`, `reconciliation_pending`, `conflict`, or `failed`
- planned, selected, confirmed, pending, conflict, and failed counts
- attempt count and timestamps

### Assignment attempts

Add `piles_auto_assignment_attempts`:

- `id`, `batch_id`, `insurer_run_id`, and optional existing tracked-pile reference
- stable tracking key and last observed pile key
- intended bot, intended portal assignee, and observed assignee
- `status`: `planned`, `selected`, `submitted`, `confirmed_visible`, `confirmed_reconciled`, `reconciliation_pending`, `still_unassigned`, `conflict`, or `failed`
- claim totals and filter context
- attempt number, evidence code, sanitized evidence details, and timestamps

Uniqueness on batch and stable tracking key prevents duplicate plans inside a batch. State-transition updates use compare-and-set conditions so retries and process recovery remain idempotent.

### Configuration history

Add `piles_auto_assignment_bot_account_history`:

- bot account and insurer identifiers
- previous and new role, capacity, activity, availability, schedule, and portal-name values
- actor name/member ID, source, reason, and timestamp

Every API, weekend override, restoration, and administrative edit writes history in the same database transaction as the configuration change.

### Existing tables

- Add nullable `runner_run_id` and `insurer_run_id` references to assignment logs.
- Continue populating tracked piles, snapshots, external assignments, and legacy logs for dashboard compatibility.
- Do not store portal credentials, patient data, or raw page HTML in new evidence records.

## Execution State Machine

For each discovered unassigned pile:

```text
discovered -> planned -> selected -> submitted -> confirmed_visible
                                          |             |
                                          |             -> confirmed_reconciled
                                          -> reconciliation_pending
                                                        |-> still_unassigned -> eligible for retry
                                                        |-> confirmed_reconciled
                                                        |-> conflict
                                                        -> failed
```

The runner persists `planned` before selecting rows and `submitted` immediately after the portal reports a successful action. A submitted or reconciliation-pending attempt is never blindly resubmitted.

Terminal definitions:

- `confirmed_visible`: the target row remains visible with the intended assignee.
- `confirmed_reconciled`: the row moved or disappeared, and a subsequent targeted observation positively found it assigned to the intended assignee or a portal audit/result source positively confirmed that assignment. Disappearance by itself remains pending.
- `still_unassigned`: a targeted scan conclusively found the same stable pile unassigned; retry is allowed within the configured attempt limit.
- `conflict`: a targeted scan found another assignee; no automatic overwrite is permitted.
- `failed`: the system has definitive failure evidence or exhausted safe recovery while the item remains assignable.

An indeterminate observation remains pending and is surfaced operationally; it is never silently counted as completed.

## Filter Synchronization

`apply_filters` will produce structured `FilterEvidence` rather than returning only on the presence of one network event.

Required evidence:

1. The month control visibly matches the requested month.
2. The year control contains exactly the requested year set; `All` means every currently exposed four-digit year.
3. The status control visibly matches the requested status.
4. The table reaches a settled state: valid headers plus stable row identity/count across two observations, or an explicit empty state.

Supporting evidence:

- A matching successful portal response received after the interaction.
- A matching response already in flight before a no-op selection.
- Rendered row years consistent with a concrete requested year.

A missing new response is not fatal when required UI and table evidence is satisfied. A non-success response, contradictory table contents, or an unsettled table remains a failure. Timeouts become named configuration values with bounded retries and diagnostic reason codes.

The response observer must record relevant GET and non-GET requests by endpoint and filter parameters without assuming one fixed request shape.

## Scan Completeness

The orchestrator creates every expected scan-context record before browser work begins. Each context transitions independently.

For each context, scanning will:

- confirm filter evidence;
- record every visited page fingerprint;
- detect repeated, missing, or unexpectedly reordered pages;
- retry a page from a clean filter reset when instability occurs;
- deduplicate by canonical tracking key while preserving collisions as conflicts;
- distinguish explicit empty state from absent/unreadable rows;
- complete only after pagination termination is confirmed;
- record counts before planning.

Planning begins only from completed or explicitly empty contexts. A failed context makes the insurer result partial or failed and names the missing context; other completed contexts may continue only when doing so cannot cause duplication.

A targeted late-arrival scan runs for contexts that produced assignments. New rows are planned as new attempts. Previously submitted rows are routed to reconciliation instead of new planning.

## Planning and Rule Semantics

All planning functions are pure and operate on a persisted configuration snapshot.

### Eligibility

A bot is eligible only when its insurer, assignment rule, and bot row are active; the bot is available; its availability status is accepted; its portal name resolves uniquely; and any weekend policy permits it.

Every excluded bot receives one or more explicit reason codes in the insurer-run record. An insurer with no valid eligible target fails before any portal side effect.

### Balanced finish

`balanced_finish` uses current confirmed remaining load, smoothed observed speed, role capacity, and the primary minimum share. Tie-breaking is deterministic by projected finish, role, priority, and stable bot ID.

### Single owner

`single_owner` assigns all new work to exactly one active, available primary. Zero or multiple eligible primaries is a configuration error. Support bots are available only for explicitly governed stale reassignment.

### Manual override

`manual_override` does not perform scheduled new assignments. It records discovered work as `manual_action_required` and surfaces it in the dashboard. A future explicit owner-selection feature is outside this reliability project; the current misleading implication of automatic distribution is removed.

### Minimum claim chunk

`minimum_claim_chunk` is a target assignment-batch size, not a threshold for skipping work. Piles are indivisible. The batching algorithm accumulates whole piles until the target is met or exceeded, submits the batch, and always submits a final smaller remainder. A single pile larger than the target forms its own batch.

The API validates supported modes, positive thresholds, capacity ranges, schedules, and role constraints before saving.

## Assignment and Verification

The portal adapter receives one persisted batch at a time.

1. Reapply and confirm the exact filter context.
2. Reconcile any attempts already marked submitted or pending.
3. Relocate planned rows by stable tracking key.
4. Persist selected attempts after checking the actual selected-row count.
5. Open the assignment dialog and resolve the intended assignee uniquely.
6. Click once and require the dialog/toast or portal response to acknowledge submission.
7. Persist the batch and attempts as submitted before further navigation.
8. Perform targeted visible-table verification.
9. Confirm matching visible rows individually.
10. Route missing rows to reconciliation; route wrong-assignee rows to conflict.
11. Continue with safe remaining batches and contexts.

The percentage-based missing-row allowance is removed. Evidence is evaluated per pile. Batch status is derived from its attempts.

## Reconciliation and Recovery

Reconciliation runs:

- immediately after a partially observed batch;
- before retrying any prior submitted attempt;
- at insurer finalization;
- at the beginning of a later run when pending attempts exist.

It searches the original context, related target statuses, and tracked/external assignment observations using canonical tracking keys. Outcomes are confirmed, still unassigned, conflict, or pending. Only `still_unassigned` may return to a new batch, with a bounded attempt count.

On process restart, the orchestrator resumes from durable state or safely finalizes stale run records. Submitted attempts are reconciled before any new assignment work.

## Insurer Isolation, Locks, and Scheduling

Retain a short global orchestration lock only for creating/coalescing scheduled work, and use an insurer-scoped advisory lock for portal execution. A failed insurer does not prevent another insurer from running or completing.

Scheduler behaviour:

- If an insurer is active, record `skipped_overlap` and set one pending coalesced run request.
- Do not enqueue multiple duplicates while the insurer remains active.
- When the active insurer run finishes, claim the pending request once.
- Emit heartbeats during long scans and batches.
- Mark abandoned runs only after a configurable heartbeat expiry.
- Start with a maximum concurrency of one. Permit a configuration value of two only after read-only and canary evidence shows the host and portal tolerate it.

Scheduled overlap is an expected status, not a stack-trace failure.

## Manual Runner Control

The manual POST endpoint will validate input, create a run request with a caller-generated run ID, spawn the local runner detached, and return `202 Accepted` immediately with the run ID. The runner adopts that ID and creates or updates the same durable run record.

The frontend polls Runner History while any selected run is queued or active. It shows overall and per-insurer phases, heartbeats, counts, partial outcomes, and sanitized errors. Network timeout no longer determines runner success.

Spawn failures update the pre-created run to failed. Duplicate client submissions require an idempotency key or are rejected while an equivalent request is active.

## Observability

Dashboard and logs will expose counts for:

- discovered;
- unassigned;
- planned;
- selected;
- submitted;
- confirmed;
- reconciliation pending;
- still unassigned;
- conflict;
- failed;
- external assignment;
- bots excluded by reason;
- contexts complete, empty, or failed.

Structured error codes include filter-control mismatch, response failure, table unsettled, pagination unstable, row relocation failure, assignee mismatch, portal submission failure, reconciliation pending, and configuration invalid.

Successful runs must not carry harmless Playwright shutdown warnings as operational stderr. Expected cleanup errors are suppressed or recorded as debug diagnostics. Alerts trigger on repeated context failures, pending reconciliation age, conflicts, no eligible bot, and missed/coalesced scheduling beyond threshold.

## Failure Policy

- No portal side effect occurs if configuration, assignee resolution, or scan identity is ambiguous.
- A failed filter context cannot be reported as empty.
- A submitted assignment cannot be retried based only on row disappearance.
- A conflict cannot be automatically reassigned.
- One insurer failure does not erase successful insurer results.
- Slack notification failures do not change confirmed assignment state; they are reported separately and retried independently.
- Database persistence failure before a portal click aborts the click.
- Database persistence failure after a portal click produces a reconciliation-critical outcome and stops further clicks for that insurer.

## Compatibility and Migration

Schema changes are additive. Existing runner history, logs, tracked piles, external assignments, and dashboard views remain readable throughout rollout.

Deployment order:

1. Add schema and indexes.
2. Add dual-write persistence behind a disabled feature flag.
3. Introduce pure planning/evidence modules and characterization tests.
4. Enable scan-context recording in dry-run.
5. Enable durable assignment attempts for one test/canary insurer.
6. Enable per-insurer orchestration and reconciliation.
7. Switch Runner Control to asynchronous execution.
8. Enable all active insurers after acceptance checks.

Each stage supports rollback to the previous runner. New tables may remain during rollback because old code does not depend on them.

## Testing Strategy

### Unit tests

- Filter evidence with changed, unchanged, cached, delayed, failed, GET, and non-GET network activity.
- Exact all-years selection and year-option refresh.
- Explicit empty versus unreadable/unsettled table.
- Pagination repetition, reordering, deduplication, and tracking-key collision.
- Eligibility and every exclusion reason.
- Balanced-finish determinism and primary share.
- Single-owner validation.
- Manual-override no-assignment behaviour.
- Minimum-claim batch formation, including final remainder and oversized pile.
- Every legal and illegal attempt-state transition.
- Visible confirmation, disappearance, wrong assignee, still-unassigned retry, and retry exhaustion.

### Persistence tests

- Idempotent run, context, batch, and attempt creation.
- Compare-and-set transitions.
- Crash recovery from planned, selected, submitted, and pending states.
- Transactional configuration history.
- Legacy dual writes and foreign-key behaviour.

### Browser adapter tests

- PrimeVue single-select and multiselect variants.
- No-op filter selection without a new request.
- Slow response followed by a settled correct table.
- Explicit API failure despite correct-looking controls.
- Rows disappearing after assignment.
- Rows moving pages or statuses.
- Partial row selection and dialog failures.

### API and UI tests

- Validation for every rule mode and threshold.
- Inactive insurers absent from manual selection.
- Asynchronous `202` response and polling.
- Spawn failure and duplicate submission.
- Per-insurer partial outcomes and reconciliation backlog rendering.

### End-to-end acceptance

- Local test suite and Python compilation.
- Next.js production build.
- Database migration verification and rollback rehearsal.
- Read-only production filter and scan probes with no assignment click.
- Shadow comparison of discovered and planned counts against the previous path.
- Explicitly approved one-insurer canary with small bounded batches.
- Verification that confirmed plus pending plus conflict plus failed equals submitted for every run.
- Verification that every discovered unassigned pile is planned, deliberately excluded with a reason, or pending manual action.

## Acceptance Criteria

The project is ready for full production rollout when:

1. Every requested scan context has an explicit outcome.
2. Every discovered unassigned pile has a durable disposition.
3. No submitted attempt is blindly duplicated after retry or restart.
4. Row disappearance alone does not abort an insurer or count as definitive failure.
5. Wrong-assignee evidence prevents automatic overwrite and raises a conflict.
6. All saved rule modes and thresholds alter behaviour exactly as documented.
7. Every bot exclusion is visible with a reason and configuration changes are auditable.
8. Manual triggers return promptly and display the eventual authoritative result.
9. Long and overlapping scheduled runs coalesce without silent gaps or duplicate execution.
10. One insurer failure does not prevent other insurers from completing.
11. Production read-only probes pass across all active insurers.
12. A controlled canary confirms assignment, persistence, reconciliation, and notification end to end.

## Out of Scope

- Reverse-engineering or adopting unsupported Curacel private APIs as the primary assignment mechanism.
- Automatically resolving wrong-assignee conflicts.
- Splitting an individual portal pile into smaller claim groups.
- Increasing production browser concurrency above two.
- Storing raw claim payloads or page HTML for diagnostics.
