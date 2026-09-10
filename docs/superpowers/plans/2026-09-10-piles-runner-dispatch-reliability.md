# Piles Runner Dispatch Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate redundant Piles insurer reruns, safely process different insurers with bounded concurrency, reduce evidence-free waiting, and make every production outcome diagnosable.

**Architecture:** A durable dispatcher creates insurer-scoped work items under each parent run and a bounded worker pool processes them using independent database connections and browser sessions. Existing insurer locks and assignment evidence remain authoritative; additive schema, feature flags, and legacy fallback isolate rollout risk.

**Tech Stack:** Python 3, Playwright, psycopg2/PostgreSQL advisory locks, Next.js 14, React, Supabase service client, Node.js 20 tests, GitHub Actions, PM2, cron.

**Spec:** `docs/superpowers/specs/2026-09-10-piles-runner-dispatch-reliability-design.md`

## Global Constraints

- No arbitrary hard deadline for completing a full run.
- Concurrency is configurable but restricted to exactly `1` or `2`.
- The same canonical insurer must never execute concurrently with itself.
- Schema changes are additive and must deploy before code that reads them.
- `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2` defaults to disabled until production rollout.
- Read-only validation must not click Assign Claims or mutate assignment state.
- Never log credentials, patient data, raw HTML, raw portal responses, tracking keys, or claim identifiers.
- Submitted or reconciliation-pending attempts must be reconciled before retry and never blindly resubmitted.
- Each task is committed independently only after its focused and regression tests pass.

---

## File Structure

- `scripts/piles_auto_assignment/domain.py`: work-source, disposition, work-item, and parent-outcome types.
- `scripts/piles_auto_assignment/scheduling.py`: pure coverage, deduplication, and parent-aggregation decisions.
- `scripts/piles_auto_assignment/dispatch.py`: bounded worker orchestration; no SQL or portal selectors.
- `scripts/piles_auto_assignment/store.py`: transactional work-item claims, leases, heartbeats, and finalization.
- `scripts/piles_auto_assignment/timing.py`: monotonic phase measurements and condition-based wait decisions.
- `scripts/piles_auto_assignment_runner.py`: CLI composition, one-insurer adapter, legacy/v2 feature switch, and portal integration.
- `scripts/inspect-piles-runner-incidents.mjs`: read-only sanitized production incident report.
- `lib/piles-auto-assignment-view-model.mjs`: safe API projection and status explanations.
- `app/tools/piles-auto-assignment/page.js`: parent and insurer history presentation.

### Task 1: Add read-only incident evidence before behavior changes

**Files:**
- Create: `scripts/inspect-piles-runner-incidents.mjs`
- Create: `.github/workflows/piles-incident-inspection.yml`
- Modify: `lib/piles-auto-assignment-schema-audit.test.mjs`
- Modify: `docs/piles-auto-assignment-runbook.md`

**Interfaces:**
- Consumes: `DATABASE_URL`, optional CLI `--hours <1..168>` and `--run-id <uuid>`.
- Produces: sanitized parent, insurer, context, batch, attempt-state, and pending-request summaries on stdout; never writes.

- [ ] **Step 1: Write the failing diagnostic safety test**

Add a Node test that reads both new files and asserts `BEGIN READ ONLY`, bounded inputs, normalized selected columns, no `stdout`, `stderr`, credential columns, tracking keys, or mutation flags, and a workflow containing no execute/recovery input.

```js
test('incident inspection is read-only and excludes sensitive fields', () => {
  const script = readFileSync(new URL('../scripts/inspect-piles-runner-incidents.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/piles-incident-inspection.yml', import.meta.url), 'utf8');
  assert.match(script, /BEGIN READ ONLY/i);
  assert.doesNotMatch(script, /select[^;]*(stdout|stderr|tracking_key|password)/i);
  assert.doesNotMatch(workflow, /--apply|--execute|recover/i);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the files do not exist**

Run: `node --test lib/piles-auto-assignment-schema-audit.test.mjs`

Expected: FAIL with `ENOENT` for `inspect-piles-runner-incidents.mjs`.

- [ ] **Step 3: Implement the inspector and workflow**

Use `pg.Pool({ max: 1 })`, execute `BEGIN READ ONLY`, and issue parameterized queries for the selected window/run. Print only IDs, insurer names, sources, statuses, phases, timestamps, aggregate counts, normalized error codes, bounded sanitized error messages, request dispositions, and heartbeat ages. Always `ROLLBACK` in `finally`. The workflow accepts only `hours` and optional `run_id`, SSHes to the production host, sources `.env`, and invokes the script without mutation flags.

- [ ] **Step 4: Document the exact incident command and interpretation**

Add runbook examples for a 24-hour report and one parent run, explaining `completed_with_issues`, legacy `partial`, covered work, queued follow-up, pending reconciliation, and stale heartbeat.

- [ ] **Step 5: Run focused and security checks**

Run: `node --test lib/piles-auto-assignment-schema-audit.test.mjs`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 6: Commit the diagnostic slice**

```bash
git add scripts/inspect-piles-runner-incidents.mjs .github/workflows/piles-incident-inspection.yml lib/piles-auto-assignment-schema-audit.test.mjs docs/piles-auto-assignment-runbook.md
git commit -m "ops: add read-only piles incident diagnostics"
```

### Task 2: Add the durable insurer work-item schema

**Files:**
- Modify: `scripts/piles-auto-assignment-schema.sql`
- Modify: `scripts/db-schema-audit.mjs`
- Modify: `scripts/audit-piles-auto-assignment-readiness.mjs`
- Modify: `scripts/test_piles_auto_assignment_schema.py`
- Modify: `lib/piles-auto-assignment-schema-audit.test.mjs`

**Interfaces:**
- Produces table `piles_auto_assignment_work_items` with parent ownership, source, scope, disposition, claim lease, generation, timings, and sanitized reason fields.
- Produces indexes enforcing one queued generation per canonical insurer/source class and efficient claim ordering.

- [ ] **Step 1: Write failing schema assertions**

Assert the schema contains the work-item table, accepted source/disposition checks, `parent_runner_run_id`, `covered_by_insurer_run_id`, `worker_id`, `claim_token`, `lease_expires_at`, `heartbeat_at`, `generation_requested_at`, `attempt_number`, timestamps, and partial unique indexes for queued/follow-up work. Assert parent/insurer status constraints accept `completed_with_issues` and the legacy schedule-request constraint accepts the guarded `cancelled_legacy` terminal state.

```python
def test_dispatch_work_items_are_additive_and_lease_guarded(self):
    self.assertIn("CREATE TABLE IF NOT EXISTS piles_auto_assignment_work_items", SCHEMA)
    for column in ("claim_token", "lease_expires_at", "generation_requested_at"):
        self.assertRegex(SCHEMA, rf"\b{column}\b")
    self.assertIn("covered_by_active_cycle", SCHEMA)
```

- [ ] **Step 2: Run schema tests and verify failure**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_schema.py -v`

Expected: FAIL because the work-item table is absent.

- [ ] **Step 3: Implement the additive schema**

Create the table with foreign keys using `ON DELETE SET NULL`, check constraints, `created_at/updated_at`, and indexes. Expand existing status constraints additively without altering or deleting legacy schedule-request rows. Extend schema audits to require every column, constraint, and index.

- [ ] **Step 4: Add readiness checks for queue health**

Report queued work without a live worker, expired leases, duplicate active canonical insurers, and legacy pending rows. Deployment mode reports runtime findings as warnings; incident/readiness mode fails on unsafe duplicates or expired work with a free insurer lock.

- [ ] **Step 5: Run schema, audit, and full Piles tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_schema.py -v && node --test lib/piles-auto-assignment-schema-audit.test.mjs && npm run test:piles`

Expected: PASS.

- [ ] **Step 6: Commit the schema slice**

```bash
git add scripts/piles-auto-assignment-schema.sql scripts/db-schema-audit.mjs scripts/audit-piles-auto-assignment-readiness.mjs scripts/test_piles_auto_assignment_schema.py lib/piles-auto-assignment-schema-audit.test.mjs
git commit -m "feat: add durable piles insurer work items"
```

### Task 3: Define pure request coverage and aggregation semantics

**Files:**
- Modify: `scripts/piles_auto_assignment/domain.py`
- Replace scheduler model in: `scripts/piles_auto_assignment/scheduling.py`
- Modify: `scripts/piles_auto_assignment/orchestrator.py`
- Modify: `scripts/test_piles_auto_assignment_scheduling.py`
- Modify: `scripts/test_piles_auto_assignment_orchestrator.py`

**Interfaces:**
- Produces `WorkSource`, `WorkDisposition`, `WorkRequest`, `InsurerCoverage`, `DispatchDecision`, and `ParentRunStatus`.
- Produces `decide_dispatch(request: WorkRequest, coverage: InsurerCoverage) -> DispatchDecision`.
- Produces `derive_parent_status(dispositions: Iterable[WorkDisposition], insurer_statuses: Iterable[InsurerRunStatus]) -> ParentRunStatus`.

- [ ] **Step 1: Replace legacy coalescing tests with failing coverage scenarios**

Cover idle scheduled work (`queued`), queued/running scheduled work (`covered_by_active_cycle`), completed-before-trigger work (new generation), active manual single-insurer work (`follow_up_queued`), repeated manual follow-up deduplication, inactive insurer, and source preservation.

```python
decision = decide_dispatch(
    WorkRequest("Jubilee Uganda", WorkSource.SCHEDULE, requested_at=t2),
    InsurerCoverage(state="running", active_started_at=t1),
)
self.assertEqual(decision.disposition, WorkDisposition.COVERED_BY_ACTIVE_CYCLE)
```

- [ ] **Step 2: Run focused tests and verify import/expectation failures**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_scheduling.py scripts/test_piles_auto_assignment_orchestrator.py -v`

Expected: FAIL because the new types and functions do not exist.

- [ ] **Step 3: Implement immutable domain types and pure decisions**

Use enums for persisted values and frozen dataclasses for input/output. Scheduled all-active requests never create follow-ups for queued/running insurers. Manual single-insurer requests create at most one follow-up. Parent aggregation recognizes `completed`, `completed_with_issues`, `failed`, `covered_by_active_cycle`, and `cancelled` while continuing to read legacy `partial` and `skipped_overlap`.

- [ ] **Step 4: Run focused and domain regression tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_domain.py scripts/test_piles_auto_assignment_scheduling.py scripts/test_piles_auto_assignment_orchestrator.py -v`

Expected: PASS.

- [ ] **Step 5: Commit the pure state model**

```bash
git add scripts/piles_auto_assignment/domain.py scripts/piles_auto_assignment/scheduling.py scripts/piles_auto_assignment/orchestrator.py scripts/test_piles_auto_assignment_scheduling.py scripts/test_piles_auto_assignment_orchestrator.py
git commit -m "feat: define piles dispatch coverage semantics"
```

### Task 4: Implement transactional work-item storage and leases

**Files:**
- Modify: `scripts/piles_auto_assignment/store.py`
- Modify: `scripts/test_piles_auto_assignment_store.py`

**Interfaces:**
- Produces `DispatchStore.enqueue_parent_work(parent_id, requests) -> list[DispatchDecision]`.
- Produces `DispatchStore.claim_next(parent_id, worker_id, lease_seconds=120) -> ClaimedWork | None`.
- Produces `renew_claim(work_id, claim_token, lease_seconds=120) -> bool`.
- Produces `finish_claim(work_id, claim_token, disposition, insurer_run_id=None, reason_code="") -> bool`.
- Produces `recoverable_expired_work() -> list[ClaimedWork]` and `finalize_parent(parent_id) -> ParentRunStatus`.

- [ ] **Step 1: Add recording-connection tests for enqueue, claim, renew, finish, and recovery SQL**

Assert `FOR UPDATE SKIP LOCKED`, compare-and-set claim tokens, canonical insurer comparisons, parent ownership, lease expiry plus free-lock recovery, one transaction per transition, rollback on failure, and no work mutation in `ReadOnlyExecutionLedger`.

- [ ] **Step 2: Run store tests and verify missing methods**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_store.py -v`

Expected: FAIL with missing dispatch-store methods.

- [ ] **Step 3: Implement `DispatchStore` with an independent PostgreSQL connection**

Use parameterized SQL and database timestamps. Claim with one atomic CTE update. Require matching `claim_token` for renewal/finalization. `finalize_parent` aggregates only work items whose `parent_runner_run_id` matches the requested parent and refuses to finalize while owned work is queued/claimed/running.

- [ ] **Step 4: Add stale-claim safety tests**

Demonstrate that an expired lease with a held insurer lock is not reclaimable, a free insurer lock permits guarded reclaim, and a worker with an old token cannot finish reclaimed work.

- [ ] **Step 5: Run storage and scheduling regressions**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_store.py scripts/test_piles_auto_assignment_scheduling.py -v`

Expected: PASS.

- [ ] **Step 6: Commit the transactional store**

```bash
git add scripts/piles_auto_assignment/store.py scripts/test_piles_auto_assignment_store.py
git commit -m "feat: persist and lease piles insurer work"
```

### Task 5: Extract one-insurer execution behind a worker-safe adapter

**Files:**
- Create: `scripts/piles_auto_assignment/dispatch.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Create: `scripts/test_piles_auto_assignment_dispatch.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Produces `WorkerContext(store, ledger, output, worker_id)` owned by one worker.
- Produces `ContextOutputRouter.bind(insurer_name) -> ContextManager[StringIO]` for thread-local capture through one process-wide synchronized stream proxy.
- Produces `execute_claimed_insurer(work: ClaimedWork, context_factory, run_one) -> InsurerOutcome`.
- Existing `run_insurer_recorded(...)` remains the portal adapter and executes exactly once per claimed item.

- [ ] **Step 1: Write failing worker-isolation tests**

Use fake factories to assert each claimed item receives distinct store, ledger, context-bound output buffer, and browser lifecycle; concurrent buffers do not receive each other's text; locks release in `finally`; failures become `InsurerOutcome` without stopping another work item; one claimed item invokes `run_one` exactly once.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_dispatch.py scripts/test_piles_auto_assignment_runner.py -v`

Expected: FAIL because `dispatch.py` is absent.

- [ ] **Step 3: Implement the single-work adapter**

Move lock/slot ownership outside the legacy insurer loop. Create and close each worker’s DB connection and execution ledger inside the adapter. Install one synchronized process stream proxy before threads start; route writes through a `contextvars.ContextVar` to the current insurer buffer and fall back to the original stream outside worker contexts. Return buffered text to the parent rather than swapping `sys.stdout` inside workers or sharing notification arrays and mutable runner state.

- [ ] **Step 4: Keep legacy execution unchanged behind the disabled flag**

Add `dispatcher_v2_enabled(environ=os.environ) -> bool`, default false. The legacy path remains callable for rollback, but v2 never invokes `mark_coalesced_request` or the existing `while True` follow-up loop.

- [ ] **Step 5: Run focused and full Python tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_dispatch.py scripts/test_piles_auto_assignment_runner.py -v && python3 -m unittest discover -s scripts -p 'test_piles_auto_assignment*.py'`

Expected: PASS.

- [ ] **Step 6: Commit the worker boundary**

```bash
git add scripts/piles_auto_assignment/dispatch.py scripts/piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_dispatch.py scripts/test_piles_auto_assignment_runner.py
git commit -m "refactor: isolate one piles insurer execution"
```

### Task 6: Add the bounded insurer dispatcher

**Files:**
- Modify: `scripts/piles_auto_assignment/dispatch.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_dispatch.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Produces `dispatch_parent(parent_id, work_items, max_workers, context_factory, run_one) -> DispatchResult`.
- `DispatchResult` contains ordered insurer outcomes, notification payloads, and derived parent status.

- [ ] **Step 1: Write failing concurrency and ownership tests**

Use barriers and fake locks to prove two different insurers overlap when `max_workers=2`, only one executes at a time with `max_workers=1`, the same canonical insurer never overlaps, results retain configured insurer order, and a failed future does not cancel remaining futures.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_dispatch.py -v`

Expected: FAIL because `dispatch_parent` is absent.

- [ ] **Step 3: Implement bounded execution**

Use `concurrent.futures.ThreadPoolExecutor(max_workers=max_workers)`. Submit only work items atomically claimed for the current parent. Each future owns its connection/session. Collect results in the parent thread, renew leases from worker heartbeats, finalize each claim by token, then derive and persist the parent outcome.

- [ ] **Step 4: Integrate the feature-switched v2 path**

When enabled, `main()` creates parent work items, dispatches them, aggregates notifications after futures complete, and finalizes the parent from its owned work. A competing all-active invocation records covered dispositions and exits without queuing duplicate follow-ups.

- [ ] **Step 5: Verify concurrency, overlap, and complete regressions**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_dispatch.py scripts/test_piles_auto_assignment_scheduling.py scripts/test_piles_auto_assignment_runner.py -v && npm run test:piles`

Expected: PASS with no assignment-side test invoked twice.

- [ ] **Step 6: Commit the dispatcher**

```bash
git add scripts/piles_auto_assignment/dispatch.py scripts/piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_dispatch.py scripts/test_piles_auto_assignment_runner.py
git commit -m "feat: dispatch piles insurers with bounded concurrency"
```

### Task 7: Rescan every completed or empty context for late arrivals

**Files:**
- Modify: `scripts/piles_auto_assignment/scanning.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_scanning.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Produces `late_arrival_contexts(scan_results) -> tuple[FilterContext, ...]`.
- Consumes terminal initial contexts and excludes failed/pending contexts.

- [ ] **Step 1: Write failing completeness tests**

Assert initially empty and initially assigned-only contexts are included; failed contexts are excluded and reported; repeated contexts deduplicate; concrete years remain concrete; submitted and reconciliation-pending keys route to reconciliation rather than new planning.

- [ ] **Step 2: Run focused tests and verify the initially-empty assertion fails**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_scanning.py scripts/test_piles_auto_assignment_runner.py -v`

Expected: FAIL because follow-up contexts currently originate only from unassigned rows/plans.

- [ ] **Step 3: Implement context-derived final rescanning**

Build follow-up contexts from persisted successful `ScanResult` objects, not `unassigned`. Run the existing targeted scan once per context, canonicalize identities, remove initially observed rows, and reconcile any prior attempt before creating a late plan.

- [ ] **Step 4: Verify no duplicate submission paths**

Add a runner test where a submitted attempt reappears during final rescan and assert `execute_assignment_plan` is not called for it.

- [ ] **Step 5: Run scan, reconciliation, runner, and full tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_scanning.py scripts/test_piles_auto_assignment_reconciliation.py scripts/test_piles_auto_assignment_runner.py -v && npm run test:piles`

Expected: PASS.

- [ ] **Step 6: Commit scan completeness**

```bash
git add scripts/piles_auto_assignment/scanning.py scripts/piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_scanning.py scripts/test_piles_auto_assignment_runner.py
git commit -m "fix: rescan all settled piles contexts"
```

### Task 8: Instrument phases and remove evidence-free filter waiting

**Files:**
- Create: `scripts/piles_auto_assignment/timing.py`
- Create: `scripts/test_piles_auto_assignment_timing.py`
- Modify: `scripts/piles_auto_assignment/domain.py`
- Modify: `scripts/piles_auto_assignment/store.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_evidence.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Produces `PhaseTimer.record(phase, operation, elapsed_ms, outcome)` with bounded aggregate serialization.
- Produces `decide_filter_wait(evidence, elapsed_ms, response_grace_ms=1500) -> WaitDecision` where decision is `accept`, `continue`, `retry`, or `fail`.

- [ ] **Step 1: Write failing timer privacy and wait-decision tests**

Assert monotonic nonnegative durations, aggregate count/min/max/total only, bounded operation names, no arbitrary detail payload, immediate failure on contradictory response evidence, acceptance of stable explicit-empty/table evidence after the response grace period, and continued waiting for unreadable/unsettled tables.

- [ ] **Step 2: Run focused tests and verify missing modules/functions**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_timing.py scripts/test_piles_auto_assignment_evidence.py -v`

Expected: FAIL because timing and wait decisions do not exist.

- [ ] **Step 3: Implement timing and evidence decisions**

Use `time.monotonic_ns()` and serialize only `{phase, operation, count, total_ms, min_ms, max_ms, outcomes}`. Race table settlement and network observation: once controls match and the table is stably rows/empty with no contradictory response, accept after 1.5 seconds rather than always spending the 30-second response timeout. Retain the 30-second cap only for genuinely unsettled evidence.

- [ ] **Step 4: Replace specific unconditional waits with existing positive readiness checks**

Replace the post-login 4-second sleep with `_wait_for_login_or_app_ready`; replace modal-open 2-second sleeps with `_wait_for_assign_user_control`; replace filter-change 0.8/1.2/1.5-second sleeps with `decide_filter_wait` polling; retain bounded retry backoff after an actual failed attempt. Do not alter submission acknowledgement or reconciliation safety thresholds in this commit.

- [ ] **Step 5: Persist sanitized phase aggregates and compare fixture timings**

Store phase aggregates in insurer-run `details.performance` and expose only aggregates. Add a deterministic test fixture showing five explicit-empty statuses settle after evidence grace rather than five 30-second waits.

- [ ] **Step 6: Run timing, evidence, runner, privacy, and full tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_timing.py scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_runner.py -v && npm run test:piles`

Expected: PASS.

- [ ] **Step 7: Commit measured wait optimization**

```bash
git add scripts/piles_auto_assignment/timing.py scripts/test_piles_auto_assignment_timing.py scripts/piles_auto_assignment/domain.py scripts/piles_auto_assignment/store.py scripts/piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_runner.py
git commit -m "perf: settle piles filters on positive evidence"
```

### Task 9: Make invocation sources and feature flags explicit

**Files:**
- Modify: `scripts/run-piles-auto-assignment.sh`
- Modify: `scripts/install-piles-auto-assignment-cron.sh`
- Modify: `lib/piles-auto-assignment-runner.mjs`
- Modify: `app/api/tools/piles-auto-assignment/run/route.js`
- Modify: `.github/workflows/piles-production-readiness.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `scripts/test_piles_auto_assignment_scheduling.py`
- Modify: `lib/piles-auto-assignment-runner.test.mjs`

**Interfaces:**
- Schedule wrapper always passes `--run-source schedule`.
- Manual API always passes `--run-source manual`.
- Readiness workflow always passes `--run-source readiness`.
- Deployment writes `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2` and validated concurrency configuration.

- [ ] **Step 1: Write failing source-contract tests**

Read wrapper/workflow files and assert exact source arguments. Test `buildRunnerArgs(request, { runId, backend, source: 'manual' })` rejects unsupported sources and cannot be overridden by request JSON.

- [ ] **Step 2: Run shell and runner tests and verify failure**

Run: `sh -n scripts/run-piles-auto-assignment.sh scripts/install-piles-auto-assignment-cron.sh && node --test lib/piles-auto-assignment-runner.test.mjs && python3 -m unittest scripts/test_piles_auto_assignment_scheduling.py -v`

Expected: FAIL on missing explicit readiness source/feature flag contract.

- [ ] **Step 3: Implement explicit source propagation**

Remove the generic schedule source environment override. Keep source values internal constants, validate them in Python/Node, and persist them unchanged. Add dispatcher-v2 deployment variable defaulting false and keep concurrency default one when empty.

- [ ] **Step 4: Verify cron idempotency and source isolation**

Use a temporary crontab fixture to assert reinstalling produces one marked entry containing `--run-source schedule`; verify API payload cannot inject `schedule` or `recovery`.

- [ ] **Step 5: Run focused, shell, and full tests**

Run: `sh -n scripts/run-piles-auto-assignment.sh scripts/install-piles-auto-assignment-cron.sh && node --test lib/piles-auto-assignment-runner.test.mjs && npm run test:piles`

Expected: PASS.

- [ ] **Step 6: Commit source correctness**

```bash
git add scripts/run-piles-auto-assignment.sh scripts/install-piles-auto-assignment-cron.sh lib/piles-auto-assignment-runner.mjs app/api/tools/piles-auto-assignment/run/route.js .github/workflows/piles-production-readiness.yml .github/workflows/deploy.yml scripts/test_piles_auto_assignment_scheduling.py lib/piles-auto-assignment-runner.test.mjs
git commit -m "fix: record piles invocation sources accurately"
```

### Task 10: Expose safe insurer-level history and work disposition

**Files:**
- Modify: `app/api/tools/piles-auto-assignment/runner-runs/route.js`
- Modify: `lib/piles-auto-assignment-view-model.mjs`
- Modify: `lib/piles-auto-assignment-view-model.test.mjs`

**Interfaces:**
- Produces `toRunnerProgressView(run, insurerRuns, contexts, batches, workItems)`.
- Returns sanitized parent explanation, insurer counts/errors/durations, heartbeat freshness, phase timings, and work disposition; excludes raw logs and identifiers.

- [ ] **Step 1: Write failing view-model tests**

Cover `partial` legacy explanation, `completed_with_issues`, covered-only parent, queued manual follow-up, one-hour duration input, source label, fresh heartbeat versus stale heartbeat, insurer error rendering fields, and privacy exclusions.

- [ ] **Step 2: Run focused tests and verify missing fields**

Run: `node --test lib/piles-auto-assignment-view-model.test.mjs`

Expected: FAIL on explanation, work-item, and duration fields.

- [ ] **Step 3: Extend the API query and safe projection**

Query work items by parent IDs and add only bounded safe columns. Add `summary_text`, `source_label`, per-insurer `duration_ms`, `heartbeat_state`, `counts`, `error_code`, `error_message`, `work_disposition`, and sanitized performance aggregates. Continue excluding parent `stdout`, `stderr`, `details`, and attempt identities.

- [ ] **Step 4: Verify privacy and legacy compatibility**

Assert serialized output contains none of `password`, `token`, `stdout`, `stderr`, `tracking_key`, `raw_html`, or injected sensitive fixture values, and legacy rows still render.

- [ ] **Step 5: Run view-model and full Node tests**

Run: `node --test lib/piles-auto-assignment-view-model.test.mjs && node --test lib/piles-auto-assignment*.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the API projection**

```bash
git add app/api/tools/piles-auto-assignment/runner-runs/route.js lib/piles-auto-assignment-view-model.mjs lib/piles-auto-assignment-view-model.test.mjs
git commit -m "feat: expose safe piles insurer run diagnostics"
```

### Task 11: Make Runner History truthful and actionable

**Files:**
- Modify: `app/tools/piles-auto-assignment/page.js`
- Create: `lib/piles-auto-assignment-history.mjs`
- Create: `lib/piles-auto-assignment-history.test.mjs`

**Interfaces:**
- Produces `formatDuration(ms)`, `statusPresentation(status)`, and `summarizeInsurerOutcomes(insurers)`.
- Consumes the safe view from Task 10.

- [ ] **Step 1: Write failing presentation tests**

Assert `5546000` formats as `1h 32m 26s`; `partial` displays “Completed with issues (legacy)”; covered work explains that no duplicate execution occurred; queued follow-up is not green success; fresh long-running work is visually distinct from stale work; mixed outcomes list completed/failed/pending counts.

- [ ] **Step 2: Run focused tests and verify missing module**

Run: `node --test lib/piles-auto-assignment-history.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement pure presentation helpers**

Use a fixed status-to-label/tone/explanation map and hour-aware duration formatting. Unknown statuses render as neutral `Unknown status`, not success.

- [ ] **Step 4: Render parent and insurer details**

Replace opaque cards with expandable insurer rows containing source, status, phase, duration, context and assignment counts, heartbeat state, error code/message, and work disposition. Remove the “exact output” claim and raw stdout/stderr panels. Add clear copy for long-but-fresh versus stale.

- [ ] **Step 5: Run UI helpers, full tests, and production build**

Run: `node --test lib/piles-auto-assignment-history.test.mjs lib/piles-auto-assignment-view-model.test.mjs && npm run test:piles && npm run build`

Expected: PASS and successful Next.js production build.

- [ ] **Step 6: Commit Runner History**

```bash
git add app/tools/piles-auto-assignment/page.js lib/piles-auto-assignment-history.mjs lib/piles-auto-assignment-history.test.mjs
git commit -m "feat: explain piles runner outcomes by insurer"
```

### Task 12: Extend recovery for work-item leases and legacy backlog

**Files:**
- Modify: `scripts/recover-piles-stale-runs.mjs`
- Create: `scripts/audit-piles-legacy-requests.mjs`
- Modify: `.github/workflows/piles-stale-run-recovery.yml`
- Modify: `lib/piles-auto-assignment-schema-audit.test.mjs`
- Modify: `docs/piles-auto-assignment-runbook.md`

**Interfaces:**
- Inspection reports stale insurer runs and expired work leases.
- Recovery requires exact confirmation, expired heartbeat/lease, and free canonical insurer lock.
- Legacy audit supports read-only default and `--apply --confirmation CANCEL_OBSOLETE_LEGACY_REQUESTS`.

- [ ] **Step 1: Write failing guarded-recovery tests**

Assert work-item recovery checks the claim token and free insurer lock, parent repair waits for all owned work, inspect mode contains no updates, and legacy cancellation requires exact confirmation plus an inactive owner and free lock.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test lib/piles-auto-assignment-schema-audit.test.mjs`

Expected: FAIL on missing work-item and legacy-request guards.

- [ ] **Step 3: Implement inspection/recovery transitions**

Recover only expired claimed/running work whose insurer lock is free. Increment attempt number, clear worker/token/lease, and return it to queued with a recovery reason. Repair parents only when no owned work or child insurer remains active. Keep legacy cleanup a separate explicitly confirmed operation.

- [ ] **Step 4: Update operational runbook**

Document inspect, recovery, legacy backlog audit, rollback, and the prohibition on deleting submitted/reconciliation evidence.

- [ ] **Step 5: Run recovery, schema, and full tests**

Run: `node --test lib/piles-auto-assignment-schema-audit.test.mjs && npm run test:piles`

Expected: PASS.

- [ ] **Step 6: Commit recovery support**

```bash
git add scripts/recover-piles-stale-runs.mjs scripts/audit-piles-legacy-requests.mjs .github/workflows/piles-stale-run-recovery.yml lib/piles-auto-assignment-schema-audit.test.mjs docs/piles-auto-assignment-runbook.md
git commit -m "ops: recover expired piles insurer work safely"
```

### Task 13: Add end-to-end dispatcher acceptance tests

**Files:**
- Create: `scripts/test_piles_auto_assignment_dispatch_integration.py`
- Modify: `package.json`
- Modify: `docs/piles-auto-assignment-runbook.md`

**Interfaces:**
- Uses fake PostgreSQL/store and fake portal workers; performs no external calls.
- Verifies one complete parent lifecycle under concurrency one and two.

- [ ] **Step 1: Write the integration scenarios**

Cover four active insurers, one failure with three completions, an overlapping all-active trigger, a manual follow-up, an initially empty late arrival, one pending reconciliation, worker crash/reclaim, and stable parent aggregation. Record call counts and assert no insurer generation executes twice unless it is the explicit manual follow-up.

- [ ] **Step 2: Run the new suite and verify it catches incomplete integration**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_dispatch_integration.py -v`

Expected before final integration wiring: FAIL on missing parent/work finalization interactions.

- [ ] **Step 3: Complete only the adapter wiring exposed by the scenarios**

Connect dispatcher results to parent finalization and aggregated notifications without changing portal selectors or planning. Ensure notifications are emitted once after parent collection and include only confirmed assignments.

- [ ] **Step 4: Run every repository verification gate**

Run: `python3 -m py_compile scripts/piles_auto_assignment_runner.py scripts/piles_auto_assignment/*.py`

Run: `sh -n scripts/run-piles-auto-assignment.sh scripts/install-piles-auto-assignment-cron.sh`

Run: `npm run test:piles`

Run: `npm run build`

Run: `npm audit --audit-level=high`

Run: `git diff --check`

Expected: every command succeeds with no high-severity audit finding introduced by this branch.

- [ ] **Step 5: Update the runbook acceptance checklist**

Add exact schema-first order, flags disabled defaults, incident inspection, read-only probes, concurrency-one cycle, concurrency-two enablement, queue-drain checks, portal verification evidence, and rollback commands.

- [ ] **Step 6: Commit final integration coverage**

```bash
git add scripts/test_piles_auto_assignment_dispatch_integration.py package.json docs/piles-auto-assignment-runbook.md scripts/piles_auto_assignment_runner.py scripts/piles_auto_assignment/dispatch.py
git commit -m "test: cover piles dispatcher lifecycle"
```

### Task 14: Production rollout with non-mutating gates first

**Files:**
- No source changes unless a gate exposes a separately diagnosed defect.

**Interfaces:**
- Uses deployment, incident-inspection, readiness, and stale-recovery workflows created above.

- [ ] **Step 1: Review branch commits and immutable diff**

Run: `git log --oneline origin/main..HEAD`

Run: `git diff --stat origin/main...HEAD && git diff --check origin/main...HEAD`

Expected: one coherent concern per commit and no whitespace errors.

- [ ] **Step 2: Obtain code review and resolve findings one commit at a time**

Review scheduler correctness, SQL claim atomicity, lock aliases, worker isolation, attempt idempotency, privacy, workflow permissions, deployment order, and rollback. Re-run the focused test for each amended commit followed by `npm run test:piles`.

- [ ] **Step 3: Deploy additive schema and disabled code**

Keep `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2=false` and `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1`. Verify deployment schema audit and application health before any probe.

- [ ] **Step 4: Run read-only production evidence gates**

Run incident inspection for 24 hours, then one-insurer probes for Jubilee Tanzania and Jubilee Uganda, followed by all-active read-only at concurrency one. Confirm no assignment attempts were created by probes, every context is terminal, sources are accurate, and no expired work/locks exist.

- [ ] **Step 5: Enable dispatcher v2 at concurrency one**

Observe one normal scheduled execute cycle. Confirm each insurer generation runs once, overlapping trigger dispositions are covered rather than duplicated, parents finalize, pending reconciliation is visible, and portal-confirmed assignments match ledger counts.

- [ ] **Step 6: Enable concurrency two after explicit production approval**

Observe at least one normal scheduled cycle. Confirm two different insurer locks may be held, no canonical insurer lock duplicates, host CPU/memory remain stable, portal sessions do not interfere, and work items drain without duplicate attempts.

- [ ] **Step 7: Close rollout or execute rollback**

If evidence is healthy, leave v2 enabled and record deployed commit plus inspection run links in the runbook incident log. If any safety gate fails, set concurrency to one, then disable v2, allow active portal evidence boundaries to finish, inspect queue/attempt state, and use guarded recovery only for expired work with free locks.

---

## Commit Sequence

1. `ops: add read-only piles incident diagnostics`
2. `feat: add durable piles insurer work items`
3. `feat: define piles dispatch coverage semantics`
4. `feat: persist and lease piles insurer work`
5. `refactor: isolate one piles insurer execution`
6. `feat: dispatch piles insurers with bounded concurrency`
7. `fix: rescan all settled piles contexts`
8. `perf: settle piles filters on positive evidence`
9. `fix: record piles invocation sources accurately`
10. `feat: expose safe piles insurer run diagnostics`
11. `feat: explain piles runner outcomes by insurer`
12. `ops: recover expired piles insurer work safely`
13. `test: cover piles dispatcher lifecycle`

Every commit is independently reviewable. Schema precedes code consumption; dispatcher code is disabled by default; concurrency two is a production configuration step, not bundled with deployment.
