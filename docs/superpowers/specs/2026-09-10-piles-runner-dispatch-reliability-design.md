# Piles Runner Dispatch Reliability Design

## Purpose

Remove unnecessary Piles Auto-Assignment delays and duplicate work while preserving portal safety. The system will dispatch insurer work independently with bounded concurrency, report mixed outcomes truthfully, expose actionable insurer-level diagnostics, and retain a rapid fallback to sequential execution.

## Production Evidence

On 10 September 2026, an all-active run started at 09:00 and remained active for more than ninety minutes. A 10:00 trigger completed as `skipped_overlap` in two seconds. During read-only inspection, the active child moved from Jubilee Kenya `apply` back to `scan`, consistent with the active runner claiming the overlap request and repeating the insurer workflow.

Recent completed runs took approximately 23–33 minutes and ended as `failed` or `partial`. The current parent status rules define `partial` as a mixture of successful and failed insurer outcomes, but Runner History does not render those child outcomes or their errors. The history cards also label execute runs as `manual`, so scheduled and manual sources cannot currently be trusted without inspecting production configuration.

The current all-active implementation acquires one global capacity slot per insurer inside a sequential loop. A competing all-active run that cannot acquire that slot creates a pending follow-up for every insurer, including insurers already queued or running in the active parent. The active parent may then claim those requests and repeat full insurer scans. When execution crosses the next hourly boundary, this can produce continuing redundant work and starve later insurers such as Jubilee Tanzania and Jubilee Uganda.

## Goals

- Eliminate redundant insurer reruns caused by overlapping all-active triggers.
- Allow different insurers to execute concurrently within a configurable safety limit of one or two.
- Guarantee that the same insurer never executes concurrently with itself.
- Preserve every legitimate manual or scheduled request without creating an unbounded backlog.
- Reduce runtime by measuring and removing unnecessary waits, reloads, repeated scans, and repeated authentication.
- Revisit every successfully scanned context for late arrivals, including contexts that were initially empty.
- Make parent and insurer statuses understandable and evidence-backed.
- Expose sanitized errors, phase timings, counts, and request disposition in Runner History.
- Provide read-only production incident tooling that does not assign claims or expose credentials or claim identifiers.
- Roll out schema, dispatcher, concurrency, and performance changes independently with feature flags and rollback paths.

## Non-Goals

- No arbitrary hard deadline for completing a full run.
- No concurrency above two during this project.
- No replacement of PostgreSQL advisory locks.
- No Redis, BullMQ, or additional queue infrastructure.
- No changes to assignment balancing rules except where necessary to prevent skipped or duplicated work.
- No weakening of post-assignment verification or production assignment guards.

## Architecture

The Python portal workflow remains insurer-scoped. A dispatcher creates one parent run and one durable work item per requested insurer. A bounded worker pool claims those work items. Each worker acquires the existing insurer advisory lock before opening a browser and releases it in `finally` handling.

```text
scheduled/manual trigger
        |
        v
parent run + insurer work items
        |
        v
request disposition
queued | covered_by_active_cycle | follow_up_queued | inactive
        |
        v
bounded worker pool (1 or 2)
        |
        v
insurer lock -> login -> scan -> plan -> apply -> reconcile
        |
        v
insurer terminal outcome -> aggregate parent outcome
```

The dispatcher owns work scheduling and aggregation. The portal runner owns only one insurer execution. Existing planning, evidence, assignment-attempt, tracking, and notification logic remains behind that boundary.

## Durable Work Model

Extend the existing schedule-request model additively rather than introducing another queue technology.

Each insurer work item records:

- parent runner ID and insurer name;
- request source: `schedule`, `manual`, `readiness`, or `recovery`;
- request scope: `all_active` or `single_insurer`;
- disposition: `queued`, `claimed`, `covered_by_active_cycle`, `follow_up_queued`, `completed`, `failed`, or `cancelled`;
- the active insurer run that covers or claims it;
- requested, claimed, started, and finished timestamps;
- worker ID, opaque claim token, attempt number, and lease/heartbeat timestamps;
- a deduplication generation or coverage timestamp;
- a sanitized reason code.

Existing pending schedule-request rows are migrated additively. No destructive migration or table replacement is required.

## Request and Overlap Semantics

### Scheduled all-active trigger

- Create one parent record and evaluate every active insurer.
- If the insurer is not queued or running, create one queued work item.
- If the insurer is queued or running in an active all-active cycle, mark the new request `covered_by_active_cycle`. Do not create a follow-up. Its final all-context rescan is the coverage boundary for work arriving during execution.
- If the insurer has already completed in the older cycle, create one queued next-generation work item because that insurer has not covered work arriving since its completion.
- Multiple equivalent scheduled requests collapse into the same queued generation.

### Manual single-insurer trigger

- If the insurer is idle, queue it immediately.
- If it is active, create at most one `follow_up_queued` generation.
- Preserve the manual request ID and surface that it is waiting, rather than reporting it as a failed run.
- Never let an all-active worker claim an unrelated historical manual request implicitly.

### Read-only probe

- Never create or claim execute work.
- Fail clearly with `probe_blocked_by_active_insurer` when the same insurer lock is held.
- Read-only probes may run alongside another insurer only when host capacity permits.

### Parent aggregation

Parent status is derived only after all of its own work items are terminal:

- `completed`: every requested insurer completed or was inactive by explicit configuration.
- `completed_with_issues`: at least one insurer completed and at least one failed, conflicted, or requires manual action.
- `failed`: every runnable insurer failed, or parent setup failed before work could be dispatched.
- `covered_by_active_cycle`: every requested insurer was already covered by an active cycle; the parent did not start duplicate work.
- `cancelled`: explicitly cancelled before portal side effects.

Legacy `partial` and `skipped_overlap` values remain readable but are not emitted by the new dispatcher. The UI maps them to explanatory legacy labels.

## Concurrency Safety

- `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2` selects the new dispatcher.
- `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY` remains restricted to `1` or `2`.
- Rollout begins with dispatcher v2 and concurrency `1`, then enables `2` after read-only and execute-canary evidence.
- The bounded executor creates one independent database connection, execution ledger, browser context, and output capture per worker. Mutable runner state is never shared between workers; the parent aggregates returned results after futures complete.
- A global capacity advisory lock protects each worker slot.
- The existing canonical insurer advisory lock prevents same-insurer concurrency across scheduled, manual, recovery, and legacy processes.
- Lock acquisition and work-item claiming use compare-and-set database transitions.
- A worker that loses ownership cannot submit portal assignments.
- Stale recovery requires both an expired heartbeat and a free insurer lock.
- Process shutdown stops claiming new work, allows the active portal action to reach a safe evidence boundary, and leaves remaining queued work recoverable.
- Claim leases are renewable evidence for crash recovery, not permission to run the same insurer twice. Expired work is reclaimed only when its insurer lock is also free.

## Execution-Time Optimization

Optimization is evidence-driven rather than tied to a fixed overall deadline.

Record monotonic timings for login, initial navigation, each filter context, pagination, planning, row selection, modal submission, verification, reconciliation, and final rescan. Store aggregates and bounded slow-operation samples without credentials, patient data, raw HTML, or stable claim identifiers.

Use those measurements to make focused changes:

- Replace fixed sleeps with condition-based waits for a visible control, settled table, matching response, success acknowledgement, or bounded timeout.
- Avoid reopening and reauthenticating when the existing page/session is healthy.
- Avoid resetting to page one when the target row’s current page and stable identity are still valid.
- Cache discovered filter controls only within one page generation and invalidate on navigation or DOM replacement.
- Retain one bounded clean-page retry for genuinely unstable filter contexts.
- Do not remove waits that provide assignment-safety evidence.
- Preserve the final smaller assignment batch; `minimum_claim_chunk` never becomes a skip threshold.

Performance changes are committed separately from dispatcher correctness so regressions can be isolated and reverted.

## Scan Completeness and Late Arrivals

Create the complete expected context set before browser work. Every context reaches `complete`, `empty`, or `failed`.

At insurer finalization, rescan every context that completed or was explicitly empty, not only contexts that initially produced assignments. New unassigned rows are planned once. Rows already submitted or reconciliation-pending are reconciled and never blindly resubmitted.

A failed context makes the insurer outcome `completed_with_issues` or `failed` according to whether other safe work completed. The runner records the exact missing context and continues only where duplicate assignment cannot result.

## Status and Error Semantics

Statuses must describe operational facts rather than inferred console text.

Insurer outcomes expose:

- current phase and heartbeat;
- contexts expected, completed, empty, and failed;
- piles discovered, planned, selected, submitted, confirmed, pending reconciliation, conflicted, failed, and requiring manual action;
- normalized error code and sanitized message;
- phase and total durations;
- work-item source and disposition.

An insurer is not `completed` merely because its Python function returned. Submitted attempts remaining pending produce `completed_with_issues`. A no-work result is successful only when every expected context is complete or explicitly empty.

The parent must not remain `started` after all owned work is terminal. A reconciliation job repairs legacy or abandoned parent rows only when no child is active and relevant locks are free.

## Runner History and API

Runner History becomes an operational summary rather than an opaque parent list.

- Show `Scheduled`, `Manual`, `Read-only probe`, or `Recovery` from the persisted source.
- Format durations as `1h 32m 26s`, not raw seconds.
- Expand each parent into insurer rows showing status, phase, counts, duration, and sanitized error.
- Explain mixed outcomes in plain language: for example, “2 completed, 1 failed, 1 awaiting reconciliation.”
- Distinguish `covered_by_active_cycle` from `follow_up_queued`; neither is presented as a successful assignment run.
- Show fresh heartbeat activity separately from elapsed duration, because a long run is not necessarily stuck.
- Mark a run stale only from heartbeat expiry and lock evidence.
- Remove the promise of “exact output” unless a safe, access-controlled output endpoint is supplied.
- Do not return raw stdout/stderr through the general history endpoint. Provide bounded sanitized diagnostic events and insurer errors instead.

The API continues to omit credentials, raw tracking keys, claim identifiers, and raw portal data.

## Operational Diagnostics

Add a read-only GitHub Actions incident workflow and supporting script that reports, for a selected time window:

- parent runs and child insurer outcomes;
- active phases and heartbeat freshness;
- work-item dispositions and pending generations;
- context completion counts;
- assignment attempt state counts;
- normalized error codes and sanitized messages;
- worker-slot and insurer-lock observations;
- deployed commit and relevant feature-flag presence without printing values or secrets.

The diagnostic transaction is read-only. It cannot launch the runner, modify queue state, recover runs, or assign claims.

Alerting focuses on actionable evidence:

- failed insurer;
- reconciliation pending or conflict;
- heartbeat stale while the insurer lock is free;
- queued work with no live worker;
- repeated context failure;
- source misclassification.

Elapsed duration alone does not trigger failure.

## Source Accuracy

The schedule wrapper passes `--run-source schedule` explicitly and does not allow a generic environment variable to silently relabel it. Runner Control passes `manual`; readiness passes `readiness`; recovery passes `recovery`.

The database constrains accepted source values. Deployment readiness verifies the installed cron entry, schedule, executable, feature flags, Python environment, and source argument without revealing secrets.

## Testing Strategy

### Pure scheduler tests

- two different insurers can occupy two slots;
- the same insurer cannot occupy two slots;
- a later all-active trigger marks queued/running insurers as covered;
- an insurer completed before the later trigger receives one new generation;
- repeated equivalent triggers remain deduplicated;
- one manual follow-up is preserved and not consumed by an unrelated parent;
- parent status waits for and aggregates only owned work;
- shutdown and stale recovery preserve recoverable queue state.

### Runner tests

- each worker invokes exactly one insurer flow;
- every completed/empty initial context is included in the final rescan;
- initially empty contexts can produce late-arrival plans;
- submitted/pending attempts are reconciled, not reassigned;
- condition waits succeed on positive evidence and fail with bounded codes;
- retries do not repeat confirmed portal side effects;
- phase timings contain no sensitive payloads.

### API and UI tests

- source labels are accurate;
- legacy and new statuses have explanatory labels;
- mixed parent outcomes render insurer details;
- duration formatting supports hours;
- active heartbeat and stale state are distinct;
- diagnostics never expose credentials, stdout, tracking keys, or portal rows.

### Integration and production-safe validation

- fresh database migration and schema audit;
- legacy-data compatibility and rollback checks;
- local fake-worker concurrency tests;
- read-only one-insurer probes;
- read-only all-active probe with concurrency one, then two;
- execute canary only after explicit approval, limited to one insurer and normal production work;
- verify ledger-to-portal evidence without generating synthetic assignments.

## Deployment and Rollback

1. Back up the production database.
2. Apply additive schema changes and run the schema/readiness audit.
3. Audit legacy pending schedule requests. With dispatcher v2 still disabled, mark only demonstrably obsolete rows as `cancelled_legacy` when no owning run is active and the insurer lock is free; preserve an audit reason for every transition.
4. Deploy code with dispatcher v2 disabled and concurrency one.
5. Run read-only incident diagnostics and one-insurer probes.
6. Enable dispatcher v2 with concurrency one.
7. Observe at least one normal scheduled cycle and verify work ownership, parent finalization, and absence of duplicate generations.
8. Enable concurrency two.
9. Observe portal stability, host resource use, lock behaviour, assignment verification, and queue drainage.
10. Enable UI status changes after backend evidence is stable.

Rollback order:

- set concurrency back to one;
- disable dispatcher v2 and return to the legacy sequential path;
- leave additive tables and columns in place;
- stop new claims, allow active workers to finish or use guarded stale recovery;
- never delete pending/submitted evidence during rollback.

## Security and Privacy

- Credentials remain encrypted and are never included in queue rows, diagnostics, events, or UI payloads.
- Diagnostic messages use normalized codes and bounded sanitized text.
- No raw claim identifiers, tracking keys, patient data, page HTML, Slack tokens, or portal responses enter operational logs.
- Production execute mode continues to require `ALLOW_PRODUCTION_ASSIGNMENTS=true`.
- Read-only workflows cannot be changed to execute through user-controlled inputs.

## Acceptance Criteria

- An overlapping all-active trigger does not cause queued or active insurers in the current cycle to repeat.
- Different insurers can run concurrently up to the configured limit; the same insurer cannot.
- Every legitimate request reaches a visible terminal or queued disposition.
- Later insurers are not blocked by redundant earlier-insurer reruns.
- Every completed or empty context receives a final late-arrival scan.
- Parent status and UI explanation match child outcomes.
- Scheduled work is recorded as scheduled.
- Operators can identify the failed insurer, phase, context, error code, counts, and request disposition without database access.
- Stale detection depends on heartbeat and lock evidence, not total runtime.
- All unit, integration, build, schema, privacy, read-only probe, and rollout checks pass before concurrency two is enabled.
