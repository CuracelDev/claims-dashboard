# Piles Auto-Assignment Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every discovered Piles item reach a durable, auditable disposition without silent skips, unsafe duplicate retries, false failures, or misleading configuration.

**Architecture:** Retain the Python Playwright CLI but incrementally extract pure domain, evidence, planning, and batching logic behind tested interfaces. Add additive PostgreSQL execution-ledger tables and dual-write from the existing runner, then change verification to per-pile reconciliation and expose asynchronous, per-insurer progress through the existing Next.js dashboard.

**Tech Stack:** Python 3.10+, Playwright sync API, PostgreSQL/psycopg2, Next.js 16, React 18, Supabase JS, Node.js built-in test runner, Python unittest.

**Spec:** `docs/superpowers/specs/2026-09-08-piles-auto-assignment-reliability-design.md`

## Global Constraints

- No production assignment or production mutation is permitted during implementation verification without separate explicit approval.
- Schema changes must be additive and safe for the currently deployed runner.
- Persist assignment intent before any portal assignment click.
- Never retry a submitted assignment until a targeted observation proves the same stable pile is still unassigned.
- Row disappearance is not confirmation; confirmation requires positive assignment evidence.
- A failed insurer or batch must not stop unrelated insurers or safe remaining batches.
- Existing tracked-pile, external-assignment, logs, and runner-history consumers remain compatible throughout rollout.
- New evidence records must not contain credentials, raw claim payloads, or page HTML.
- Every commit must pass its focused tests, the full Piles test suite, Python compilation, and `git diff --check`; UI/API commits also require a production Next.js build.

---

### Task 1: Establish domain states and legal transitions

**Files:**
- Create: `scripts/piles_auto_assignment/__init__.py`
- Create: `scripts/piles_auto_assignment/domain.py`
- Create: `scripts/test_piles_auto_assignment_domain.py`
- Modify: `package.json`

**Interfaces:**
- Produces: `AttemptStatus`, `BatchStatus`, `ContextStatus`, `InsurerRunStatus`, `FilterEvidence`, `AssignmentObservation`, `can_transition_attempt(current, target) -> bool`, and `derive_batch_status(statuses) -> BatchStatus`.
- Consumes: no application code; this is a pure module.

- [ ] **Step 1: Write failing state-transition tests**

```python
def test_submitted_attempt_cannot_return_directly_to_planned():
    assert not can_transition_attempt(AttemptStatus.SUBMITTED, AttemptStatus.PLANNED)

def test_submitted_attempt_can_enter_reconciliation():
    assert can_transition_attempt(
        AttemptStatus.SUBMITTED,
        AttemptStatus.RECONCILIATION_PENDING,
    )

def test_batch_with_confirmed_and_pending_items_is_partially_confirmed():
    assert derive_batch_status([
        AttemptStatus.CONFIRMED_VISIBLE,
        AttemptStatus.RECONCILIATION_PENDING,
    ]) == BatchStatus.PARTIALLY_CONFIRMED
```

- [ ] **Step 2: Run the focused test and confirm it fails because the module is absent**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_domain.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement the enum and transition model**

```python
class AttemptStatus(str, Enum):
    PLANNED = "planned"
    SELECTED = "selected"
    SUBMITTED = "submitted"
    CONFIRMED_VISIBLE = "confirmed_visible"
    CONFIRMED_RECONCILED = "confirmed_reconciled"
    RECONCILIATION_PENDING = "reconciliation_pending"
    STILL_UNASSIGNED = "still_unassigned"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    CONFLICT = "conflict"
    FAILED = "failed"

ATTEMPT_TRANSITIONS = {
    AttemptStatus.PLANNED: {
        AttemptStatus.SELECTED,
        AttemptStatus.MANUAL_ACTION_REQUIRED,
        AttemptStatus.FAILED,
    },
    AttemptStatus.SELECTED: {AttemptStatus.SUBMITTED, AttemptStatus.FAILED},
    AttemptStatus.SUBMITTED: {
        AttemptStatus.CONFIRMED_VISIBLE,
        AttemptStatus.RECONCILIATION_PENDING,
        AttemptStatus.CONFLICT,
    },
    AttemptStatus.RECONCILIATION_PENDING: {
        AttemptStatus.CONFIRMED_RECONCILED,
        AttemptStatus.STILL_UNASSIGNED,
        AttemptStatus.CONFLICT,
        AttemptStatus.FAILED,
    },
    AttemptStatus.STILL_UNASSIGNED: {AttemptStatus.PLANNED, AttemptStatus.FAILED},
}
```

- [ ] **Step 4: Add `test:piles:domain` and run focused plus existing tests**

```json
{
  "scripts": {
    "test:piles": "python3 -m unittest discover -s scripts -p 'test_piles_auto_assignment*.py'",
    "test:piles:domain": "python3 -m unittest scripts/test_piles_auto_assignment_domain.py"
  }
}
```

Run: `python3 -m unittest scripts/test_piles_auto_assignment_domain.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: PASS.

- [ ] **Step 5: Commit the domain contract**

```bash
git add package.json scripts/piles_auto_assignment scripts/test_piles_auto_assignment_domain.py
git commit -m "test: define piles execution state model"
```

### Task 2: Add the additive execution ledger schema

**Files:**
- Modify: `scripts/piles-auto-assignment-schema.sql`
- Modify: `scripts/fresh-migrate-prod-via-adminer.mjs`
- Modify: `scripts/db-schema-audit.mjs`
- Create: `scripts/test_piles_auto_assignment_schema.py`

**Interfaces:**
- Consumes: state values from Task 1 as documented string values.
- Produces: `piles_auto_assignment_insurer_runs`, `piles_auto_assignment_scan_contexts`, `piles_auto_assignment_batches`, `piles_auto_assignment_attempts`, and `piles_auto_assignment_bot_account_history`; nullable run references on legacy logs.

- [ ] **Step 1: Write schema contract tests**

```python
def test_attempts_have_idempotency_and_state_constraints(self):
    sql = SCHEMA.read_text()
    self.assertIn("CREATE TABLE IF NOT EXISTS piles_auto_assignment_attempts", sql)
    self.assertIn("UNIQUE (batch_id, tracking_key)", sql)
    self.assertIn("CHECK (status IN", sql)

def test_new_tables_never_store_credentials_or_raw_html(self):
    sql = SCHEMA.read_text().lower()
    ledger = sql[sql.index("piles_auto_assignment_insurer_runs"):]
    self.assertNotIn("login_password", ledger)
    self.assertNotIn("raw_html", ledger)
```

- [ ] **Step 2: Run the schema test and confirm it fails**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_schema.py -v`
Expected: FAIL because the tables are absent.

- [ ] **Step 3: Add tables, checks, foreign keys, and indexes using only `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`**

```sql
CREATE TABLE IF NOT EXISTS piles_auto_assignment_attempts (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES piles_auto_assignment_batches(id) ON DELETE CASCADE,
  insurer_run_id text NOT NULL REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE CASCADE,
  insurer_name text NOT NULL,
  tracking_key text NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned','selected','submitted','confirmed_visible','confirmed_reconciled',
    'reconciliation_pending','still_unassigned','manual_action_required','conflict','failed'
  )),
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  evidence_code text,
  evidence_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, tracking_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS piles_auto_assignment_attempts_active_key_idx
  ON piles_auto_assignment_attempts (insurer_name, tracking_key)
  WHERE status IN ('planned','selected','submitted','reconciliation_pending','still_unassigned');
```

- [ ] **Step 4: Update both migration paths and schema-audit required tables/columns**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_schema.py -v && node --check scripts/fresh-migrate-prod-via-adminer.mjs && node --check scripts/db-schema-audit.mjs`
Expected: PASS without contacting production.

- [ ] **Step 5: Run the full local checks and commit**

```bash
git add scripts/piles-auto-assignment-schema.sql scripts/fresh-migrate-prod-via-adminer.mjs scripts/db-schema-audit.mjs scripts/test_piles_auto_assignment_schema.py
git commit -m "feat: add piles execution ledger schema"
```

### Task 3: Implement idempotent ledger persistence

**Files:**
- Create: `scripts/piles_auto_assignment/store.py`
- Create: `scripts/test_piles_auto_assignment_store.py`
- Modify: `scripts/piles_auto_assignment_runner.py`

**Interfaces:**
- Consumes: Task 1 statuses and Task 2 tables.
- Produces: `ExecutionLedger.create_insurer_run`, `create_scan_contexts`, `create_batch_with_attempts`, `transition_attempt`, `heartbeat`, and `summarize_insurer_run`; `ReadOnlyExecutionLedger` for mutation-free probes.

- [ ] **Step 1: Write tests with a recording fake connection**

```python
def test_transition_uses_compare_and_set(self):
    ledger.transition_attempt("attempt-1", AttemptStatus.SUBMITTED,
                              expected={AttemptStatus.SELECTED})
    self.assertIn("status = ANY", connection.last_sql)
    self.assertEqual(connection.last_params[-1], "attempt-1")

def test_batch_and_attempt_creation_is_one_transaction(self):
    ledger.create_batch_with_attempts(batch, attempts)
    self.assertEqual(connection.commit_count, 1)

def test_read_only_ledger_performs_no_database_writes(self):
    ledger = ReadOnlyExecutionLedger()
    ledger.create_insurer_run("run-1", master)
    ledger.transition_attempt("attempt-1", AttemptStatus.SUBMITTED,
                              expected={AttemptStatus.SELECTED})
    self.assertEqual(ledger.write_count, 0)
```

- [ ] **Step 2: Confirm focused tests fail**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_store.py -v`
Expected: FAIL because `ExecutionLedger` is absent.

- [ ] **Step 3: Implement transaction-scoped inserts and compare-and-set transitions**

```python
def transition_attempt(self, attempt_id, target, *, expected, evidence=None):
    allowed = [status.value for status in expected]
    row = self._fetchone(
        """update piles_auto_assignment_attempts
           set status=%s, evidence_code=%s, evidence_details=%s::jsonb, updated_at=now()
           where id=%s and status = any(%s) returning status""",
        (target.value, evidence.code, json.dumps(evidence.details), attempt_id, allowed),
    )
    if not row:
        raise ConcurrentStateChange(attempt_id)
```

- [ ] **Step 4: Make the runner create an insurer-run row and heartbeat without changing assignment behaviour**

```python
ledger = (
    ReadOnlyExecutionLedger()
    if args.read_only
    else ExecutionLedger(store.connection)
    if env_bool("PILES_EXECUTION_LEDGER_ENABLED", False)
    else None
)
insurer_run_id = ledger.create_insurer_run(run_id, master) if ledger else None
```

Run: `python3 -m unittest scripts/test_piles_auto_assignment_store.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: PASS.

- [ ] **Step 5: Commit persistence separately**

```bash
git add scripts/piles_auto_assignment/store.py scripts/test_piles_auto_assignment_store.py scripts/piles_auto_assignment_runner.py
git commit -m "feat: persist idempotent piles execution state"
```

### Task 4: Replace the single network gate with composite filter evidence

**Files:**
- Create: `scripts/piles_auto_assignment/evidence.py`
- Create: `scripts/test_piles_auto_assignment_evidence.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Consumes: `FilterEvidence` from Task 1.
- Produces: `evaluate_filter_evidence(evidence) -> EvidenceDecision` and portal `apply_filters(...) -> FilterEvidence`.

- [ ] **Step 1: Add failing evidence tests**

```python
def test_noop_selection_with_matching_controls_and_stable_table_passes():
    decision = evaluate_filter_evidence(FilterEvidence(
        month_matches=True, year_matches=True, status_matches=True,
        table_state="stable", network_state="not_observed",
    ))
    assert decision.accepted

def test_failed_response_rejects_even_if_controls_match():
    decision = evaluate_filter_evidence(FilterEvidence(
        month_matches=True, year_matches=True, status_matches=True,
        table_state="stable", network_state="failed",
    ))
    assert not decision.accepted
```

- [ ] **Step 2: Run focused tests and confirm the no-op case fails under current behaviour**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: FAIL for the new composite-evidence cases.

- [ ] **Step 3: Implement pure evidence evaluation and observe GET/non-GET Piles responses**

```python
def evaluate_filter_evidence(evidence):
    if evidence.network_state == "failed":
        return EvidenceDecision(False, "filter_response_failed")
    controls_match = all((evidence.month_matches,
                          evidence.year_matches,
                          evidence.status_matches))
    table_ready = evidence.table_state in {"stable", "empty"}
    return EvidenceDecision(controls_match and table_ready,
                            "confirmed" if controls_match and table_ready
                            else "filter_not_settled")
```

- [ ] **Step 4: Integrate evidence into `apply_filters`, preserving exact all-years validation while removing the mandatory-new-response assumption**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: PASS for cached, no-op, delayed, explicit-failure, empty, and wrong-year cases.

- [ ] **Step 5: Commit the filter synchronization fix**

```bash
git add scripts/piles_auto_assignment/evidence.py scripts/test_piles_auto_assignment_evidence.py scripts/piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_runner.py
git commit -m "fix: confirm piles filters with composite evidence"
```

### Task 5: Persist and enforce scan-context completeness

**Files:**
- Create: `scripts/piles_auto_assignment/scanning.py`
- Create: `scripts/test_piles_auto_assignment_scanning.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/piles_auto_assignment/store.py`

**Interfaces:**
- Consumes: filter evidence and ledger context methods.
- Produces: `ScanAccumulator.observe_page`, `finish`, and `ScanResult`; orchestrator records `complete`, `empty`, or `failed` for every expected context.

- [ ] **Step 1: Write scan completeness tests**

```python
def test_explicit_empty_is_complete_but_unreadable_table_is_failed():
    assert ScanAccumulator().finish(explicit_empty=True).status == ContextStatus.EMPTY
    with self.assertRaises(IncompleteScan):
        ScanAccumulator().finish(explicit_empty=False)

def test_tracking_key_collision_is_not_silently_deduplicated():
    scan.observe_page(1, [row_a, conflicting_row])
    with self.assertRaises(TrackingKeyCollision):
        scan.finish()
```

- [ ] **Step 2: Confirm tests fail, then implement deterministic page fingerprints, termination, and collision handling**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_scanning.py -v`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Pre-create expected month/year/status contexts and transition each around the existing scanner**

```python
contexts = ledger.create_scan_contexts(insurer_run_id, expected_contexts)
for context in contexts:
    ledger.start_scan_context(context.id)
    try:
        result = portal.scan_context(context)
        ledger.finish_scan_context(context.id, result)
    except Exception as error:
        ledger.fail_scan_context(context.id, classify_error(error))
```

- [ ] **Step 4: Verify one failed context cannot be logged as no-work and safe completed contexts remain visible**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_scanning.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: PASS.

- [ ] **Step 5: Commit scan accounting**

```bash
git add scripts/piles_auto_assignment/scanning.py scripts/test_piles_auto_assignment_scanning.py scripts/piles_auto_assignment/store.py scripts/piles_auto_assignment_runner.py
git commit -m "feat: account for every piles scan context"
```

### Task 6: Make assignment rules truthful and deterministic

**Files:**
- Create: `scripts/piles_auto_assignment/planning.py`
- Create: `scripts/test_piles_auto_assignment_planning.py`
- Create: `lib/piles-auto-assignment-rules.mjs`
- Create: `lib/piles-auto-assignment-rules.test.mjs`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `app/api/tools/piles-auto-assignment/assignment-rules/route.js`
- Modify: `app/tools/piles-auto-assignment/page.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `validate_rule`, `eligible_bots`, `plan_assignments`, `batch_plans`; JS `validateAssignmentRule(input)` used by the API.
- Consumes: existing `BotAccount`, `BotMetric`, `PileRow`, and `AssignmentRule` values.

- [ ] **Step 1: Write failing tests for all three modes and batch remainders**

```python
def test_minimum_chunk_never_drops_final_remainder():
    batches = batch_plans(plans_with_claims(12, 11, 7), target_claims=25)
    self.assertEqual(sum(len(batch.items) for batch in batches), 3)

def test_planning_uses_remaining_claims_and_excludes_completed_piles():
    result = plan_assignments("balanced_finish", [pile(total=20, remaining=4), pile(total=8, remaining=0)], bots, metrics, rule)
    self.assertEqual(sum(plan.work_claims for plan in result.plans), 4)
    self.assertEqual(result.exclusions[0].reason_code, "no_remaining_claims")

def test_bot_outside_active_window_is_excluded_with_reason():
    result = eligible_bots(bots, effective_at=lagos_time("20:00"))
    self.assertEqual(result.exclusions[0].reason_code, "outside_active_window")

def test_single_owner_rejects_multiple_available_primaries():
    with self.assertRaises(InvalidAssignmentConfiguration):
        plan_assignments("single_owner", piles, two_primary_bots, metrics, rule)

def test_manual_override_creates_manual_dispositions_without_assignments():
    result = plan_assignments("manual_override", piles, bots, metrics, rule)
    self.assertEqual(result.plans, [])
    self.assertEqual(len(result.manual_action_required), len(piles))
```

- [ ] **Step 2: Add JS validation tests for unsupported modes, non-positive thresholds, and invalid capacity**

Run: `node --test lib/piles-auto-assignment-rules.test.mjs`
Expected: FAIL because the validator is absent.

- [ ] **Step 3: Implement pure planning and validation; retain deterministic tie-breaking and the primary floor for balanced finish**

```python
def plan_assignments(mode, piles, bots, metrics, rule):
    if mode == "manual_override":
        return PlanningResult([], list(piles), exclusions=[])
    eligible, exclusions = eligible_bots(bots)
    if mode == "single_owner":
        primary = require_exactly_one_primary(eligible)
        return assign_all(piles, primary, exclusions)
    return balanced_finish(piles, eligible, metrics, rule, exclusions)
```

- [ ] **Step 4: Wire Python and API/UI to the shared documented semantics**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_planning.py scripts/test_piles_auto_assignment_runner.py -v && node --test lib/piles-auto-assignment-rules.test.mjs && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit rule semantics**

```bash
git add scripts/piles_auto_assignment/planning.py scripts/test_piles_auto_assignment_planning.py scripts/piles_auto_assignment_runner.py lib/piles-auto-assignment-rules.mjs lib/piles-auto-assignment-rules.test.mjs app/api/tools/piles-auto-assignment/assignment-rules/route.js app/tools/piles-auto-assignment/page.js package.json
git commit -m "fix: enforce piles assignment rule semantics"
```

### Task 7: Persist plans before portal side effects

**Files:**
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/piles_auto_assignment/store.py`
- Create: `scripts/test_piles_auto_assignment_execution.py`

**Interfaces:**
- Consumes: Task 3 ledger and Task 6 batches.
- Produces: `execute_persisted_batch(portal, ledger, batch) -> BatchExecutionResult`.

- [ ] **Step 1: Write ordering and crash tests**

```python
def test_attempts_are_persisted_before_portal_selection():
    execute_persisted_batch(portal, ledger, batch)
    self.assertLess(events.index("persist:planned"), events.index("portal:select"))

def test_persistence_failure_prevents_click():
    ledger.fail_on_create = True
    with self.assertRaises(DatabaseWriteError):
        execute_persisted_batch(portal, ledger, batch)
    self.assertNotIn("portal:submit", events)
```

- [ ] **Step 2: Confirm focused tests fail, then create batches and attempts transactionally before selection**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_execution.py -v`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Mark selected and submitted with compare-and-set transitions around exactly one portal click**

```python
ledger.mark_selected(batch.id, selected_tracking_keys)
portal_result = portal.submit_assignment(batch)
ledger.mark_submitted(batch.id, portal_result.acknowledgement)
```

- [ ] **Step 4: Run execution, runner, domain, and store tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_execution.py scripts/test_piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_domain.py scripts/test_piles_auto_assignment_store.py -v`
Expected: PASS.

- [ ] **Step 5: Commit pre-side-effect persistence**

```bash
git add scripts/piles_auto_assignment_runner.py scripts/piles_auto_assignment/store.py scripts/test_piles_auto_assignment_execution.py
git commit -m "feat: persist piles plans before assignment"
```

### Task 8: Replace percentage verification with per-pile evidence

**Files:**
- Modify: `scripts/piles_auto_assignment/evidence.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_evidence.py`
- Modify: `scripts/test_piles_auto_assignment_execution.py`

**Interfaces:**
- Produces: `classify_assignment_observations(expected, observed) -> list[AttemptDecision]`.
- Consumes: persisted submitted attempts.

- [ ] **Step 1: Write tests for visible matches, disappearance, wrong assignee, and all-missing batches**

```python
def test_missing_rows_are_pending_not_failed_or_confirmed():
    decisions = classify_assignment_observations(expected, observed={})
    self.assertTrue(all(item.status == AttemptStatus.RECONCILIATION_PENDING
                        for item in decisions))

def test_visible_wrong_assignee_is_conflict():
    decision = classify_assignment_observations(expected, {key: "Other Bot"})[0]
    self.assertEqual(decision.status, AttemptStatus.CONFLICT)
```

- [ ] **Step 2: Confirm current percentage logic fails the tests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_execution.py -v`
Expected: FAIL because missing rows currently abort the batch.

- [ ] **Step 3: Classify and persist each target independently; remove `allowed_missing`**

```python
for decision in classify_assignment_observations(expected, observed):
    ledger.transition_attempt(decision.attempt_id, decision.status,
                              expected={AttemptStatus.SUBMITTED},
                              evidence=decision.evidence)
```

- [ ] **Step 4: Verify an uncertain batch does not stop safe unrelated batches**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_execution.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: PASS.

- [ ] **Step 5: Commit per-pile verification**

```bash
git add scripts/piles_auto_assignment/evidence.py scripts/piles_auto_assignment_runner.py scripts/test_piles_auto_assignment_evidence.py scripts/test_piles_auto_assignment_execution.py
git commit -m "fix: verify piles assignments per item"
```

### Task 9: Reconcile pending work and recover safely

**Files:**
- Create: `scripts/piles_auto_assignment/reconciliation.py`
- Create: `scripts/test_piles_auto_assignment_reconciliation.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/piles_auto_assignment/store.py`

**Interfaces:**
- Produces: `reconcile_attempt(observations, expected_assignee) -> AttemptDecision` and `reconcile_pending_for_insurer(...)`.
- Consumes: submitted and reconciliation-pending attempts.

- [ ] **Step 1: Write retry-safety and recovery tests**

```python
def test_disappearance_without_positive_evidence_stays_pending():
    assert reconcile_attempt([], "CVEBOT3").status == AttemptStatus.RECONCILIATION_PENDING

def test_only_positive_unassigned_observation_enables_retry():
    decision = reconcile_attempt([Observation(assignable=True, assignee="")], "CVEBOT3")
    assert decision.status == AttemptStatus.STILL_UNASSIGNED

def test_positive_expected_assignment_confirms():
    decision = reconcile_attempt([Observation(assignable=False, assignee="CVEBOT3")], "CVEBOT3")
    assert decision.status == AttemptStatus.CONFIRMED_RECONCILED
```

- [ ] **Step 2: Confirm tests fail, then implement targeted original/related-context reconciliation**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_reconciliation.py -v`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Reconcile pending attempts before new planning and at insurer finalization; retry only `still_unassigned` within the attempt limit**

```python
pending = ledger.pending_attempts(insurer_name)
reconcile_pending_for_insurer(portal, ledger, pending)
retryable = ledger.retryable_attempts(insurer_name, max_attempts=2)
```

- [ ] **Step 4: Verify restart scenarios and legacy tracked/external dual writes**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_reconciliation.py scripts/test_piles_auto_assignment_execution.py scripts/test_piles_auto_assignment_runner.py -v`
Expected: PASS.

- [ ] **Step 5: Commit recovery logic**

```bash
git add scripts/piles_auto_assignment/reconciliation.py scripts/test_piles_auto_assignment_reconciliation.py scripts/piles_auto_assignment/store.py scripts/piles_auto_assignment_runner.py
git commit -m "feat: reconcile uncertain piles assignments"
```

### Task 10: Isolate insurer outcomes and classify errors

**Files:**
- Create: `scripts/piles_auto_assignment/orchestrator.py`
- Create: `scripts/test_piles_auto_assignment_orchestrator.py`
- Modify: `scripts/piles_auto_assignment_runner.py`

**Interfaces:**
- Produces: `run_insurer_workflow`, `derive_overall_run_status`, `classify_runner_error`.
- Consumes: ledger, portal adapter, planner, executor, and reconciler.

- [ ] **Step 1: Write tests for completed, partial, failed, and mixed all-active runs**

```python
def test_one_insurer_failure_does_not_stop_following_insurers():
    result = orchestrator.run_all([failing, succeeding])
    self.assertEqual(calls, ["failing", "succeeding"])
    self.assertEqual(result.status, "partial")

def test_no_work_requires_all_contexts_complete_or_empty():
    with self.assertRaises(IncompleteScan):
        finalize_no_work([ContextStatus.EMPTY, ContextStatus.FAILED])

def test_notification_failure_does_not_change_confirmed_assignment_state():
    result = orchestrator.finalize(confirmed_assignment, notification_error)
    self.assertEqual(result.assignment_status, "confirmed")
    self.assertEqual(result.notification_status, "failed")
```

- [ ] **Step 2: Confirm tests fail and extract orchestration incrementally from the CLI**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_orchestrator.py -v`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Add stable error codes and suppress only known harmless Playwright shutdown warnings**

```python
ERROR_CODES = {
    FilterResponseFailed: "filter_response_failed",
    IncompleteScan: "scan_incomplete",
    AssignmentConflict: "assignment_conflict",
}
```

- [ ] **Step 4: Run the full Python suite and compilation**

Run: `python3 -m unittest discover -s scripts -p 'test_piles_auto_assignment*.py' -v && python3 -m py_compile scripts/piles_auto_assignment_runner.py scripts/piles_auto_assignment/*.py`
Expected: PASS.

- [ ] **Step 5: Commit insurer isolation**

```bash
git add scripts/piles_auto_assignment/orchestrator.py scripts/test_piles_auto_assignment_orchestrator.py scripts/piles_auto_assignment_runner.py
git commit -m "feat: isolate piles insurer run outcomes"
```

### Task 11: Audit every bot configuration change

**Files:**
- Create: `lib/piles-auto-assignment-bot-history.mjs`
- Create: `lib/piles-auto-assignment-bot-history.test.mjs`
- Modify: `scripts/piles-auto-assignment-schema.sql`
- Modify: `scripts/fresh-migrate-prod-via-adminer.mjs`
- Modify: `app/api/tools/piles-auto-assignment/bot-accounts/route.js`
- Modify: `app/api/tools/piles-auto-assignment/weekend-roster/availability/route.js`
- Modify: `app/api/tools/piles-auto-assignment/weekend-roster/role/route.js`
- Modify: `app/api/tools/piles-auto-assignment/weekend-roster/add-bot/route.js`
- Modify: `app/api/tools/piles-auto-assignment/weekend-roster/remove-bot/route.js`
- Modify: `scripts/piles_auto_assignment_runner.py`

**Interfaces:**
- Produces: `updateBotAccountWithHistory(supabase, change)` backed by database RPC `piles_update_bot_account_with_history`, and a Python transactional equivalent for automatic restoration.
- Consumes: Task 2 history table.

- [ ] **Step 1: Write tests that require previous/new values, actor, source, and reason**

```javascript
test('history insert captures the availability transition', async () => {
  await updateBotAccountWithHistory(fakeSupabase, {
    botId: 'b1', source: 'bot_accounts_api', actorName: 'Daniel',
    previous: { availability_status: 'available' },
    next: { availability_status: 'paused' }, reason: 'Shift ended',
  });
  assert.equal(fakeSupabase.inserted.previous_values.availability_status, 'available');
});
```

- [ ] **Step 2: Confirm tests fail, then implement a single history writer used by all mutation paths**

Run: `node --test lib/piles-auto-assignment-bot-history.test.mjs`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Add and use one transactional PostgreSQL function for API mutations; reject the update if history cannot be recorded**

```sql
CREATE OR REPLACE FUNCTION piles_update_bot_account_with_history(
  target_bot_id text,
  patch jsonb,
  actor_name text,
  actor_member_id text,
  change_source text,
  change_reason text
) RETURNS piles_auto_assignment_bot_accounts
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE previous_row piles_auto_assignment_bot_accounts;
DECLARE next_row piles_auto_assignment_bot_accounts;
DECLARE previous_safe jsonb;
DECLARE next_safe jsonb;
BEGIN
  SELECT * INTO previous_row FROM piles_auto_assignment_bot_accounts
    WHERE id = target_bot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bot account not found'; END IF;
  UPDATE piles_auto_assignment_bot_accounts
    SET assignment_role = CASE WHEN patch ? 'assignment_role' THEN patch->>'assignment_role' ELSE assignment_role END,
        support_capacity_ratio = CASE WHEN patch ? 'support_capacity_ratio' THEN (patch->>'support_capacity_ratio')::numeric ELSE support_capacity_ratio END,
        availability_status = CASE WHEN patch ? 'availability_status' THEN patch->>'availability_status' ELSE availability_status END,
        availability_note = CASE WHEN patch ? 'availability_note' THEN nullif(patch->>'availability_note', '') ELSE availability_note END,
        is_active = CASE WHEN patch ? 'is_active' THEN (patch->>'is_active')::boolean ELSE is_active END,
        is_available = CASE WHEN patch ? 'is_available' THEN (patch->>'is_available')::boolean ELSE is_available END,
        priority_order = CASE WHEN patch ? 'priority_order' THEN (patch->>'priority_order')::integer ELSE priority_order END,
        current_claim_load = CASE WHEN patch ? 'current_claim_load' THEN (patch->>'current_claim_load')::integer ELSE current_claim_load END,
        active_from_time = CASE WHEN patch ? 'active_from_time' THEN patch->>'active_from_time' ELSE active_from_time END,
        active_to_time = CASE WHEN patch ? 'active_to_time' THEN nullif(patch->>'active_to_time', '') ELSE active_to_time END,
        shift_grace_minutes = CASE WHEN patch ? 'shift_grace_minutes' THEN (patch->>'shift_grace_minutes')::integer ELSE shift_grace_minutes END,
        bot_name = CASE WHEN patch ? 'bot_name' THEN nullif(patch->>'bot_name', '') ELSE bot_name END,
        notes = CASE WHEN patch ? 'notes' THEN nullif(patch->>'notes', '') ELSE notes END,
        updated_at = now()
    WHERE id = target_bot_id RETURNING * INTO next_row;
  previous_safe := jsonb_build_object(
    'assignment_role', previous_row.assignment_role,
    'support_capacity_ratio', previous_row.support_capacity_ratio,
    'availability_status', previous_row.availability_status,
    'availability_note', previous_row.availability_note,
    'is_active', previous_row.is_active,
    'is_available', previous_row.is_available,
    'priority_order', previous_row.priority_order,
    'current_claim_load', previous_row.current_claim_load,
    'active_from_time', previous_row.active_from_time,
    'active_to_time', previous_row.active_to_time,
    'shift_grace_minutes', previous_row.shift_grace_minutes,
    'bot_name', previous_row.bot_name,
    'notes', previous_row.notes
  );
  next_safe := jsonb_build_object(
    'assignment_role', next_row.assignment_role,
    'support_capacity_ratio', next_row.support_capacity_ratio,
    'availability_status', next_row.availability_status,
    'availability_note', next_row.availability_note,
    'is_active', next_row.is_active,
    'is_available', next_row.is_available,
    'priority_order', next_row.priority_order,
    'current_claim_load', next_row.current_claim_load,
    'active_from_time', next_row.active_from_time,
    'active_to_time', next_row.active_to_time,
    'shift_grace_minutes', next_row.shift_grace_minutes,
    'bot_name', next_row.bot_name,
    'notes', next_row.notes
  );
  INSERT INTO piles_auto_assignment_bot_account_history
    (bot_account_id, insurer_name, previous_values, new_values,
     actor_name, actor_member_id, source, reason)
  VALUES (target_bot_id, next_row.insurer_name, previous_safe,
          next_safe, actor_name, actor_member_id,
          change_source, change_reason);
  RETURN next_row;
END $$;

REVOKE ALL ON FUNCTION piles_update_bot_account_with_history(text, jsonb, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION piles_update_bot_account_with_history(text, jsonb, text, text, text, text) TO service_role;
```

- [ ] **Step 4: Run Node tests, Python tests, and the production build**

Run: `node --test lib/piles-auto-assignment-*.test.mjs && npm run test:piles && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit configuration accountability**

```bash
git add lib/piles-auto-assignment-bot-history.mjs lib/piles-auto-assignment-bot-history.test.mjs app/api/tools/piles-auto-assignment scripts/piles-auto-assignment-schema.sql scripts/fresh-migrate-prod-via-adminer.mjs scripts/piles_auto_assignment_runner.py
git commit -m "feat: audit piles bot availability changes"
```

### Task 12: Make manual runs asynchronous and idempotent

**Files:**
- Create: `lib/piles-auto-assignment-runner.mjs`
- Create: `lib/piles-auto-assignment-runner.test.mjs`
- Modify: `app/api/tools/piles-auto-assignment/run/route.js`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `app/api/tools/piles-auto-assignment/runner-runs/route.js`

**Interfaces:**
- Produces: `validateRunRequest`, `buildRunnerArgs`, `startDetachedRunner`; CLI `--run-id`; POST returns `{ success: true, run_id, status: 'queued' }` with HTTP 202.
- Consumes: existing Python binary resolution and runner history.

- [ ] **Step 1: Write Node tests for immediate 202 semantics, safe argv, duplicate idempotency keys, and spawn failure**

```javascript
test('detached start returns without waiting for close', async () => {
  const result = await startDetachedRunner(validRequest, fakeSpawn);
  assert.equal(result.status, 'queued');
  assert.equal(fakeSpawnResult.unrefCalled, true);
});
```

- [ ] **Step 2: Write Python tests that a supplied run ID is adopted instead of creating a second record**

Run: `node --test lib/piles-auto-assignment-runner.test.mjs && python3 -m unittest scripts/test_piles_auto_assignment_runner.py -v`
Expected: FAIL for the new behaviours.

- [ ] **Step 3: Extract validation/argv construction, pre-create the queued record, spawn with `stdio: 'ignore'`, call `unref`, and return 202**

```javascript
const child = spawn(pythonBin, ['-u', RUNNER_SCRIPT, '--run-id', runId, ...args], {
  cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore',
});
child.unref();
return { run_id: runId, status: 'queued' };
```

- [ ] **Step 4: Verify failed spawn updates the queued row and no synchronous output contract remains in the frontend/API**

Run: `node --test lib/piles-auto-assignment-runner.test.mjs && npm run build && npm run test:piles`
Expected: PASS.

- [ ] **Step 5: Commit asynchronous execution**

```bash
git add lib/piles-auto-assignment-runner.mjs lib/piles-auto-assignment-runner.test.mjs app/api/tools/piles-auto-assignment/run/route.js app/api/tools/piles-auto-assignment/runner-runs/route.js scripts/piles_auto_assignment_runner.py
git commit -m "fix: start manual piles runs asynchronously"
```

### Task 13: Add per-insurer dashboard progress and reconciliation visibility

**Files:**
- Modify: `app/api/tools/piles-auto-assignment/runner-runs/route.js`
- Modify: `app/api/tools/piles-auto-assignment/route.js`
- Modify: `app/tools/piles-auto-assignment/page.js`
- Create: `lib/piles-auto-assignment-view-model.mjs`
- Create: `lib/piles-auto-assignment-view-model.test.mjs`

**Interfaces:**
- Produces: `toRunnerProgressView(run, insurerRuns, contexts, batches)`, and API fields `insurer_runs`, `counts`, and `heartbeat_at`.
- Consumes: Task 2 ledger and Task 12 asynchronous run IDs.

- [ ] **Step 1: Write view-model tests for queued, running, partial, failed, reconciliation-pending, and completed runs**

```javascript
test('partial run exposes the failed insurer without hiding completed insurers', () => {
  const view = toRunnerProgressView(run, [completedInsurer, failedInsurer], [], []);
  assert.equal(view.status, 'partial');
  assert.deepEqual(view.insurers.map(x => x.status), ['completed', 'failed']);
});
```

- [ ] **Step 2: Confirm tests fail, then implement the pure view model and bounded API queries**

Run: `node --test lib/piles-auto-assignment-view-model.test.mjs`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Poll the selected run while queued/running and display phase, heartbeat, explicit counts, exclusions, and sanitized errors**

```javascript
useEffect(() => {
  if (!activeRunId) return undefined;
  const timer = window.setInterval(() => refreshRun(activeRunId), 5000);
  return () => window.clearInterval(timer);
}, [activeRunId]);
```

- [ ] **Step 4: Verify no credentials or raw evidence details are returned by either API**

```javascript
test('progress view exposes only sanitized execution fields', () => {
  const json = JSON.stringify(toRunnerProgressView(runWithSecrets, [], [], []));
  assert.doesNotMatch(json, /password|raw_html|tracking_key/i);
});
```

Run: `node --test lib/piles-auto-assignment-view-model.test.mjs lib/piles-auto-assignment-runner.test.mjs && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit operational visibility**

```bash
git add app/api/tools/piles-auto-assignment/runner-runs/route.js app/api/tools/piles-auto-assignment/route.js app/tools/piles-auto-assignment/page.js lib/piles-auto-assignment-view-model.mjs lib/piles-auto-assignment-view-model.test.mjs
git commit -m "feat: show durable piles run progress"
```

### Task 14: Coalesce scheduled overlap with insurer-scoped locks

**Files:**
- Modify: `scripts/piles_auto_assignment/store.py`
- Modify: `scripts/piles_auto_assignment/orchestrator.py`
- Modify: `scripts/run-piles-auto-assignment.sh`
- Create: `scripts/test_piles_auto_assignment_scheduling.py`

**Interfaces:**
- Produces: `try_acquire_insurer_lock`, `mark_coalesced_request`, `claim_coalesced_request`, and heartbeat-expiry handling.
- Consumes: Task 10 per-insurer orchestration.

- [ ] **Step 1: Write scheduling tests**

```python
def test_second_trigger_coalesces_exactly_once():
    first = scheduler.request("Jubilee Uganda")
    second = scheduler.request("Jubilee Uganda")
    third = scheduler.request("Jubilee Uganda")
    self.assertEqual(first.status, "running")
    self.assertEqual(second.status, "skipped_overlap")
    self.assertEqual(third.coalesced_request_id, second.coalesced_request_id)

def test_completion_claims_one_pending_followup():
    scheduler.finish(active_run)
    self.assertEqual(len(scheduler.claimed_followups), 1)
```

- [ ] **Step 2: Confirm tests fail, then implement insurer advisory keys and single pending coalesced requests**

Run: `python3 -m unittest scripts/test_piles_auto_assignment_scheduling.py -v`
Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 3: Keep default concurrency at one and make `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY` accept only `1` or `2`**

```python
def configured_max_concurrency() -> int:
    value = safe_int(os.getenv("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY"), 1)
    if value not in {1, 2}:
        raise InvalidAssignmentConfiguration("PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2")
    return value
```

- [ ] **Step 4: Validate shell syntax, scheduling tests, and all Python tests**

Run: `sh -n scripts/run-piles-auto-assignment.sh && python3 -m unittest scripts/test_piles_auto_assignment_scheduling.py -v && npm run test:piles`
Expected: PASS.

- [ ] **Step 5: Commit scheduler resilience**

```bash
git add scripts/piles_auto_assignment/store.py scripts/piles_auto_assignment/orchestrator.py scripts/run-piles-auto-assignment.sh scripts/test_piles_auto_assignment_scheduling.py
git commit -m "feat: coalesce overlapping piles schedules"
```

### Task 15: Complete holistic verification and rollout documentation

**Files:**
- Modify: `README.md`
- Create: `docs/piles-auto-assignment-runbook.md`
- Create: `scripts/audit-piles-auto-assignment-readiness.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run audit:piles-readiness` and an operator runbook.
- Consumes: all prior tasks.

- [ ] **Step 1: Add a read-only readiness audit that checks schema, active insurer/rule linkage, eligible owners, stale heartbeats, pending reconciliation age, and unsupported values without printing credentials or claim identifiers**

```javascript
const checks = [
  checkRequiredTables,
  checkActiveInsurerRules,
  checkEligibleOwners,
  checkStaleRuns,
  checkPendingReconciliation,
];
process.exitCode = results.every(result => result.ok) ? 0 : 1;
```

- [ ] **Step 2: Document deployment, feature flags, rollback, dry-run probes, canary approval, alerts, and incident queries**

- [ ] **Step 3: Run every local verification gate from a clean checkout**

Run: `python3 -m unittest discover -s scripts -p 'test_piles_auto_assignment*.py' -v`
Expected: all Python tests PASS.

Run: `node --test lib/piles-auto-assignment-*.test.mjs`
Expected: all Node tests PASS.

Run: `python3 -m py_compile scripts/piles_auto_assignment_runner.py scripts/piles_auto_assignment/*.py && sh -n scripts/run-piles-auto-assignment.sh && npm run build && git diff --check`
Expected: all commands PASS.

- [ ] **Step 4: Run only local/read-only readiness checks; do not apply production schema or execute assignments**

Run: `npm run audit:piles-readiness -- --mode local`
Expected: PASS or a precise non-mutating configuration report.

- [ ] **Step 5: Commit runbook and readiness tooling**

```bash
git add README.md docs/piles-auto-assignment-runbook.md scripts/audit-piles-auto-assignment-readiness.mjs package.json
git commit -m "docs: add piles reliability rollout gates"
```

## Post-Implementation Release Gates

These are operational gates, not implementation authorization:

1. Review the complete branch diff and security-sensitive credential boundaries.
2. Apply the additive schema only after explicit production-deployment approval.
3. Deploy with ledger dual-write enabled but assignment behaviour unchanged.
4. Run all-active production probes in dry-run/read-only mode.
5. Compare context and disposition counts against the portal without clicking Assign Claims.
6. Request explicit approval for a small one-insurer assignment canary.
7. Enable per-pile execution for the canary and verify `submitted = confirmed + pending + conflict + failed`.
8. Expand to all active insurers only after pending reconciliation and conflict counts meet the agreed thresholds.
9. Keep rollback available by disabling the new execution feature flag; additive tables remain intact.
