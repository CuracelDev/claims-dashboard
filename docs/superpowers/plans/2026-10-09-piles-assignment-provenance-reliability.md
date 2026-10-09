# Piles Assignment Provenance Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every portal assignment made by the runner remains durably attributable to the runner, self-heals its tracked-pile mirror, and can never be presented as a manual or external assignment without positive evidence.

**Architecture:** The durable assignment-attempt ledger becomes the source of truth for provenance. `piles_auto_assignment_tracked_piles` remains a compatibility/read-model table and is materialized idempotently from confirmed attempts. External detection becomes an evidence-based classifier with `runner_confirmed`, `runner_pending`, `conflict`, and `unlinked` outcomes; only a future positive portal audit integration may emit `verified_external`.

**Tech Stack:** Python 3, Playwright runner, PostgreSQL/psycopg, Next.js/React, Supabase REST, Node.js test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-08-piles-auto-assignment-reliability-design.md`

## Production evidence baseline

- Portal pile `797188` was assigned to `CVEBOT1` at `2026-10-08T08:23:26Z` by the DEFMIS master-login account.
- Runner `7bdf7f2a-3fda-4b99-9eb2-7ebf10472d3f`, insurer run `ef69cbda-98e5-4a94-88c5-1d4525e5a7f0`, submitted the matching batch at `08:23:25.393Z`.
- That DEFMIS run recorded 52 submitted and 52 `confirmed_visible` attempts, covering 110 claims, with zero pending, conflict, or failure outcomes.
- A later scan labelled the three-claim Bristol Park pile as external because the detector consulted the tracked-pile mirror but not confirmed attempt evidence.
- `CVEBOT1` is the portal assignee. Sophie is its configured owner; neither the runner database nor the Slack alert established that Sophie performed the action.
- “Remaining: 3” represented unsynced claims, not an unassigned pile. The three claims were vetted and the pile progressed to Defmis Approval.

## Global Constraints

- Never assign or reassign a production pile during automated testing, migration, audit, or rollout verification.
- Never infer a human actor from a bot-to-owner mapping.
- Never classify absence of runner tracking as proof of an external/manual action.
- Persist intent before portal side effects and preserve all submitted/confirmed evidence across retries and rollback.
- Schema changes must be additive and deploy before application/worker changes.
- Existing table and API compatibility must be retained during rollout.
- Do not store credentials, patient data, raw page HTML, raw portal response payloads, or raw claim identifiers in evidence.
- Matching must fail closed on ambiguous identities; fuzzy matching must not merge distinct piles.
- Production repair must be read-only by default, idempotent when explicitly applied, and incapable of portal writes.

## Review Focus

- A confirmed attempt whose tracked mirror is missing must be classified as runner-owned and repaired exactly once.
- A submitted/reconciliation-pending attempt observed under its intended assignee must not trigger an external alert or a duplicate assignment.
- The same natural identity appearing twice must remain ambiguous and must not be auto-linked.
- A bot owner’s name must be displayed only as configuration metadata, never as the actor who assigned the pile.
- Read-only probes, dry runs, and provenance audits must not write tracking rows, clear detections, send alerts, or contact assignment endpoints.

---

### Task 1: Characterize provenance decisions as a pure domain model

**Files:**
- Create: `scripts/piles_auto_assignment/ownership.py`
- Create: `scripts/test_piles_auto_assignment_ownership.py`
- Modify: `scripts/piles_auto_assignment/domain.py`

**Interfaces:**
- Consumes: canonical identity aliases and persisted attempt/tracked evidence.
- Produces: `AssignmentOwnership`, `OwnershipEvidence`, and `classify_assignment_ownership(...)` for later runner and UI work.

- [ ] **Step 1: Write failing tests for the production failure class**

  Cover exact confirmed-attempt matching, confirmed reconciliation, submitted/pending ownership, tracked compatibility rows, wrong-assignee conflict, no-evidence unlinked rows, and ambiguous duplicate identities. Assert that no case without positive actor evidence returns `verified_external`.

- [ ] **Step 2: Run the focused test and confirm it fails**

  Run: `python3 -m unittest scripts/test_piles_auto_assignment_ownership.py -v`

- [ ] **Step 3: Implement the pure classifier**

  Add these states: `runner_confirmed`, `runner_pending`, `conflict`, `unlinked`, and `verified_external`. Require explicit portal-audit evidence for `verified_external`; a missing tracked row alone yields `unlinked`.

- [ ] **Step 4: Add a DEFMIS regression fixture**

  Model the `08:23:25` confirmed batch followed by the assigned Bristol Park row and assert `runner_confirmed`, with `CVEBOT1` as assignee and Sophie only as configured owner metadata.

- [ ] **Step 5: Run tests and commit**

  Run: `python3 -m unittest scripts/test_piles_auto_assignment_ownership.py -v`

  Commit: `test: characterize piles assignment provenance`

### Task 2: Add indexed ledger provenance queries

**Files:**
- Modify: `scripts/piles-auto-assignment-schema.sql`
- Modify: `scripts/fresh-migrate-prod-via-adminer.mjs`
- Modify: `scripts/piles_auto_assignment/store.py`
- Modify: `scripts/test_piles_auto_assignment_store.py`
- Modify: `scripts/db-schema-audit.mjs`

**Interfaces:**
- Consumes: insurer name plus bounded current-row tracking and last-pile aliases.
- Produces: `ExecutionLedger.find_assignment_ownership(insurer_name, identity_keys)` and indexes supporting exact lookup.

- [ ] **Step 1: Write database-store tests**

  Assert that confirmed, submitted, and reconciliation-pending attempts are returned; unrelated insurers and terminal failed/manual attempts are excluded; tracking and last-pile aliases are both matched; duplicate matches are returned as ambiguous rather than silently selected.

- [ ] **Step 2: Add additive indexes**

  Add idempotent indexes for `(insurer_name, tracking_key, status)` and `(insurer_name, last_pile_key, status)`. Update schema audit expectations. Do not add destructive constraints or rewrite existing rows.

- [ ] **Step 3: Implement the bounded query**

  Query only the identities present in the current scan. Return attempt ID, insurer-run ID, bot ID, intended owner, intended portal assignee, status, tracking aliases, claim count, timestamps, and sanitized evidence codes.

- [ ] **Step 4: Verify migration idempotency and query plans**

  Run schema application twice against a disposable PostgreSQL database and use `EXPLAIN` fixtures to ensure the new lookups do not scan the entire attempts table.

- [ ] **Step 5: Run tests and commit**

  Run: `npm run test:piles && npm run db:audit`

  Commit: `perf: index piles assignment provenance lookups`

### Task 3: Materialize confirmed attempts into the tracked-pile mirror

**Files:**
- Modify: `scripts/piles_auto_assignment/store.py`
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_store.py`
- Modify: `scripts/test_piles_auto_assignment_reconciliation.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Consumes: a confirmed attempt and a positively matched current `PileRow` observation.
- Produces: `ExecutionLedger.materialize_confirmed_assignment(attempt_id, observation)` that idempotently upserts the mirror and links `attempt.tracked_pile_id`.

- [ ] **Step 1: Write crash-window and idempotency tests**

  Cover: confirmation committed before mirror creation, repeated materialization, an existing legacy mirror, a completed/inactive mirror becoming active again, and a concurrent materializer. Assert one tracked row and one stable attempt link.

- [ ] **Step 2: Implement a single database transaction**

  Lock the attempt, verify it is `confirmed_visible` or `confirmed_reconciled`, upsert the canonical tracked row, and set `tracked_pile_id` before commit. Never synthesize confirmation from absence or from an unassigned observation.

- [ ] **Step 3: Use materialization after immediate verification**

  Replace the separate best-effort `save_tracked_assignment` path for ledger-enabled runs. Preserve the legacy path only while the ledger feature flag is disabled.

- [ ] **Step 4: Use materialization after reconciliation**

  When reconciliation positively observes the intended assignee, materialize before external/unlinked detection runs. A confirmed reconciliation without enough row metadata remains confirmed but emits a named `tracked_materialization_pending` diagnostic for a later scan.

- [ ] **Step 5: Verify failure safety and commit**

  Inject failures before transaction start, after row lock, after upsert, and before commit. Assert rollback leaves no half-link and later execution self-heals.

  Run: `npm run test:piles`

  Commit: `fix: materialize confirmed piles tracking atomically`

### Task 4: Make external detection ledger-aware and fail closed

**Files:**
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/piles_auto_assignment/ownership.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`
- Modify: `scripts/test_piles_auto_assignment_ownership.py`

**Interfaces:**
- Consumes: current assigned rows, tracked aliases, and `find_assignment_ownership(...)` evidence.
- Produces: classified observations and notification candidates; only `unlinked`/`verified_external` observations enter the compatibility external-assignment table.

- [ ] **Step 1: Add failing orchestration tests**

  Reproduce the production sequence: plan, submit, confirm, omit the mirror, scan the assigned row later. Assert self-heal, zero external notifications, and no duplicate assignment plan.

- [ ] **Step 2: Classify before persisting external observations**

  Order evidence as: exact tracked link, confirmed ledger attempt, pending runner attempt with intended assignee, conflict, explicit external audit, unlinked. Never let a lower-confidence source override a higher-confidence source.

- [ ] **Step 3: Clear prior false detections safely**

  When an existing active external record matches confirmed runner evidence, mark it cleared with `details.clear_reason = 'runner_provenance_confirmed'`, retain its timestamps/history, and link the confirming attempt/run in sanitized details.

- [ ] **Step 4: Protect ambiguous identities**

  If multiple current rows or attempts share the same aliases, log `assignment_provenance_ambiguous`, send no blame-bearing alert, perform no automatic reassignment, and surface manual review.

- [ ] **Step 5: Run tests and commit**

  Run: `npm run test:piles`

  Commit: `fix: reconcile runner provenance before external detection`

### Task 5: Strengthen identity correlation without unsafe fuzzy matching

**Files:**
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `scripts/piles_auto_assignment/evidence.py`
- Modify: `scripts/piles_auto_assignment/store.py`
- Modify: `scripts/test_piles_auto_assignment_evidence.py`
- Modify: `scripts/test_piles_auto_assignment_runner.py`

**Interfaces:**
- Consumes: existing response `id` hashes, DOM row attributes, canonical natural identity, and attempt aliases.
- Produces: optional `portal_identity_hash` evidence stored in attempt/tracked JSON details; raw portal IDs are never persisted.

- [ ] **Step 1: Add tests for UI formatting drift**

  Cover currency formatting, date formatting, whitespace/case, synced/status movement, and a mutable displayed amount. Exact hashed portal identity may bridge display drift; natural identity alone must not bridge ambiguous rows.

- [ ] **Step 2: Carry the already-computed response ID hash into matched `PileRow` evidence**

  Persist only the SHA-256 value after a one-to-one response/DOM match. Do not persist the raw portal ID or response payload.

- [ ] **Step 3: Add identity precedence**

  Match portal identity hash first, canonical exact aliases second, and normalized natural identity third only when unique. Record which method established the link.

- [ ] **Step 4: Confirm privacy and collision behavior**

  Assert logs and JSON evidence contain no provider/claim values beyond fields already allowed by the existing operational schema, no raw portal IDs, and no raw page content.

- [ ] **Step 5: Run tests and commit**

  Run: `npm run test:piles`

  Commit: `fix: add durable hashed portal pile identity`

### Task 6: Correct Slack and dashboard semantics

**Files:**
- Modify: `scripts/piles_auto_assignment_runner.py`
- Modify: `app/tools/piles-auto-assignment/page.js`
- Modify: `app/api/tools/piles-auto-assignment/route.js`
- Modify: `scripts/test_piles_auto_assignment_runner.py`
- Create or modify: `lib/piles-auto-assignment-provenance.test.mjs`

**Interfaces:**
- Consumes: ownership classification, assignee account, mapped owner, and provenance evidence.
- Produces: truthful Slack blocks and dashboard rows with explicit confidence/source labels.

- [ ] **Step 1: Write copy and rendering tests**

  Assert that `runner_confirmed` sends no external alert; `unlinked` says “Unlinked Assigned Pile Detected”; `verified_external` is used only with explicit audit evidence; bot-owner copy says “configured owner” and never says or implies that person performed the action.

- [ ] **Step 2: Correct Slack content**

  Include insurer, portal assignee, configured owner, claim count, unsynced count, status, and provenance status. Rename “Remaining” to “Unsynced” unless the metric is positively known to mean remaining workload.

- [ ] **Step 3: Correct the dashboard section**

  Rename it to “Unlinked / Externally Observed Assignments.” Add provenance, assignee account, configured owner, related runner evidence, and clear reason. Explain that unlinked does not prove a manual action.

- [ ] **Step 4: Preserve compatibility**

  Keep reading old rows whose details have no classification and render them as `legacy_unverified`, not `verified_external`.

- [ ] **Step 5: Run tests/build and commit**

  Run: `npm run test:piles && npm run build`

  Commit: `fix: report assignment provenance without false attribution`

### Task 7: Add a guarded historical audit and repair tool

**Files:**
- Create: `scripts/audit-piles-assignment-provenance.mjs`
- Create: `scripts/audit-piles-assignment-provenance.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/piles-incident-inspection.yml`
- Modify: `docs/piles-auto-assignment-runbook.md`

**Interfaces:**
- Consumes: confirmed attempts, tracked rows, and external/unlinked observations.
- Produces: bounded aggregate audit output and an explicitly confirmed, database-only repair mode.

- [ ] **Step 1: Write read-only audit tests**

  Report counts for confirmed attempts lacking tracked links, confirmed attempts matching active external rows, ambiguous identities, pending runner-owned assignments, and genuinely unlinked rows. Output no credentials, provider names, claim identifiers, tracking keys, or raw errors.

- [ ] **Step 2: Implement read-only-by-default execution**

  Start `BEGIN READ ONLY`, use parameterized queries, bound insurer/time filters, and always roll back. Add `npm run audit:piles-provenance`.

- [ ] **Step 3: Add guarded repair mode**

  Require `--apply --confirmation REPAIR_PILES_PROVENANCE`. Repair only exact, unambiguous confirmed-attempt matches: materialize/link tracking and clear false external records. Never contact the portal, alter attempt confirmation, assign/reassign, or delete history.

- [ ] **Step 4: Extend the incident workflow safely**

  Add an operation/input that runs only the read-only provenance audit by default. Keep mutation out of the incident-inspection workflow; production repair remains a separately approved host operation.

- [ ] **Step 5: Run tests and commit**

  Run: `node --test scripts/audit-piles-assignment-provenance.test.mjs && npm run test:piles`

  Commit: `ops: add piles provenance audit and guarded repair`

### Task 8: Add rollout controls, readiness checks, and monitoring

**Files:**
- Modify: `scripts/audit-piles-auto-assignment-readiness.mjs`
- Modify: `scripts/prepare-piles-production-runtime.sh`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/piles-production-readiness.yml`
- Modify: `docs/piles-auto-assignment-runbook.md`
- Modify: relevant readiness tests

**Interfaces:**
- Consumes: schema/index presence, provenance feature flag, and audit counts.
- Produces: deploy gates and operational evidence without portal mutation.

- [ ] **Step 1: Add readiness tests**

  Require new indexes, the audit script, supported schema, and explicit `PILES_ASSIGNMENT_PROVENANCE_V2` configuration. Readiness must fail safely if ledger ownership queries are unavailable.

- [ ] **Step 2: Add shadow/cutover behavior**

  In shadow mode, calculate new classifications and log aggregate disagreements without changing alerts or records. In enabled mode, use ledger-aware classification and self-healing. Assignment planning/execution behavior must remain unchanged.

- [ ] **Step 3: Document deployment order**

  1. Back up the database.
  2. Deploy additive indexes/schema.
  3. Deploy worker/app in shadow mode.
  4. Run readiness and provenance audits.
  5. Require zero ambiguous auto-repair candidates.
  6. Enable provenance V2.
  7. Run the exact guarded historical repair if separately approved.
  8. Observe at least two complete all-insurer scheduled cycles.

- [ ] **Step 4: Define rollback**

  Disable provenance V2 to restore legacy classification while retaining all ledger, tracking, clear-reason, and audit history. Do not roll back schema, delete attempts, or resubmit assignments.

- [ ] **Step 5: Run checks and commit**

  Run: `npm run test:piles && npm run audit:piles-readiness -- --mode fixture && npm run build`

  Commit: `ops: gate piles provenance rollout`

### Task 9: Whole-branch verification and production-safe acceptance

**Files:**
- Modify only if verification reveals a defect.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: evidence that the release fixes attribution without changing assignment safety.

- [ ] **Step 1: Run all repository checks**

  Run:

  ```bash
  npm run test:piles
  npm run test:piles:acceptance
  npm run db:audit
  npm run build
  git diff --check
  ```

- [ ] **Step 2: Run deterministic end-to-end fixtures**

  Exercise immediate confirmation, later confirmation, crash after confirmation, duplicate delivery, status movement, UI formatting drift, ambiguous identity, conflict, read-only probe, and legacy rows. Assert no duplicate submission and no false external alert.

- [ ] **Step 3: Conduct security and privacy review**

  Confirm no secrets, raw portal IDs, raw HTML, patient data, or unbounded database diagnostics enter logs, API responses, Slack, or GitHub Actions.

- [ ] **Step 4: Run production read-only evidence checks**

  Use the existing incident inspection plus the new provenance audit. For the known DEFMIS case, expect a confirmed runner match and a repair candidate or already repaired mirror—not a verified external/manual assignment.

- [ ] **Step 5: Observe live rollout without synthetic assignments**

  Monitor two normal scheduled all-insurer runs. Require: complete contexts, no new false attribution, zero ambiguous auto-repairs, no increase in conflicts/pending attempts, and confirmed assignment totals consistent across ledger, mirror, and notifications.

- [ ] **Step 6: Final commit if documentation/evidence updates are needed**

  Commit: `docs: finalize piles provenance rollout evidence`

## Commit sequence

1. `test: characterize piles assignment provenance`
2. `perf: index piles assignment provenance lookups`
3. `fix: materialize confirmed piles tracking atomically`
4. `fix: reconcile runner provenance before external detection`
5. `fix: add durable hashed portal pile identity`
6. `fix: report assignment provenance without false attribution`
7. `ops: add piles provenance audit and guarded repair`
8. `ops: gate piles provenance rollout`
9. Optional evidence-only documentation commit after final verification.

Each commit must pass its focused tests before creation and the entire `npm run test:piles` suite immediately after creation. Do not combine schema, behavior, UI copy, repair tooling, and rollout gates into one commit.
