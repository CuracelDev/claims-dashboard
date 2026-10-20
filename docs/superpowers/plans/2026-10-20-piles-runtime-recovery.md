# Piles Runtime Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Piles Auto Assignment launch use a verified atomic Python runtime and safely recover the confirmed missing-`pip`/missing-`site-packages` production failure.

**Architecture:** A standard-library checker validates immutable runtime generations identified by a content fingerprint. Deployment or a locked schedule-time recovery builds a new generation off to the side, verifies imports and Playwright, and atomically promotes it; cron fails closed until verification succeeds.

**Tech Stack:** POSIX shell, Python 3 standard library and `unittest`, Node.js test runner, GitHub Actions, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-piles-runtime-recovery-design.md`

## Global Constraints

- Never install into the active runtime generation.
- Runtime repair and tests must never pass `--execute` or perform an assignment.
- No runtime diagnostic may print secret environment values or credentials.
- Schedule-time repair must not run `sudo` or `apt-get`.
- `PILES_RUNTIME_RECOVERY_MODE` accepts exactly `audit` or `repair`.
- Pointer promotion must be atomic and same-filesystem; a failed build leaves both pointers unchanged.
- Deployment, readiness, manual repair, and cron must use the same checker and fingerprint contract.

## Review Focus

- A Python executable survives while `pip` and the complete `site-packages` tree disappear: checker fails and repair promotes a fresh generation.
- Two cron launches find the same damaged runtime: one repair occurs and neither launch bypasses verification.
- The builder receives SIGTERM after installation but before promotion: active pointers remain unchanged and the temporary generation is removed.
- Requirements or Python major/minor change while an old generation exists: the old manifest is rejected and a new fingerprint is selected.
- Browser files exist but Chromium cannot launch: full verification fails and no pointer is promoted.

---

### Task 1: Preserve the production incident probes

**Files:**
- Modify: `.github/workflows/piles-runtime-incident-probe.yml`
- Modify: `lib/piles-auto-assignment-runner.test.mjs`

**Interfaces:**
- Consumes: existing SSH incident workflow and shell-fixture test harness.
- Produces: sanitized scheduler, import, virtualenv-integrity, and filesystem-timestamp evidence used during rollout.

- [ ] Cherry-pick the five existing diagnostic commits `bb4e3aa..12cb7ac` in order.
- [ ] Run `node --test lib/piles-auto-assignment-runner.test.mjs`; expect all tests to pass.
- [ ] Run `git diff --check`; expect no output.
- [ ] Preserve the five small commits as the auditable diagnostic history.

### Task 2: Implement the deterministic runtime checker

**Files:**
- Create: `scripts/piles_runtime_health.py`
- Create: `scripts/test_piles_runtime_health.py`

**Interfaces:**
- Consumes: runtime root, requirements path, target Python path, manifest path, browser mode.
- Produces: `compute_runtime_fingerprint(requirements_path, python_version, builder_version, browser_config) -> str`, `inspect_runtime(...) -> dict`, CLI JSON/human output, and stable exit status.

- [ ] Write failing unit tests for healthy fixtures and every state in the spec, including the exact production corruption and secret-redaction assertions.
- [ ] Run `python3 -m unittest scripts/test_piles_runtime_health.py -v`; expect failures because the module is absent.
- [ ] Implement the standard-library checker and CLI with light and full verification modes.
- [ ] Run the focused unit test; expect all tests to pass.
- [ ] Run `npm run test:piles`; expect all Piles tests to pass.
- [ ] Commit with `feat(piles): add deterministic runtime integrity checks`.

### Task 3: Build and promote immutable runtime generations

**Files:**
- Modify: `scripts/prepare-piles-production-runtime.sh`
- Create: `scripts/test_piles_runtime_builder.py`

**Interfaces:**
- Consumes: Task 2 fingerprint/checker CLI, requirements file, runtime root, shared browser path.
- Produces: verified `generations/<fingerprint>`, atomic `current` and `previous` pointers, manifest schema version `1`.

- [ ] Write failing fixture tests for recovery from missing `pip`/`site-packages`, healthy no-op, failed install, failed browser probe, concurrent build, requirements change, and termination before promotion.
- [ ] Run `python3 -m unittest scripts/test_piles_runtime_builder.py -v`; expect failures against the in-place builder.
- [ ] Implement locked temporary generation creation, `ensurepip`, pinned install, browser install/probe, manifest creation, and atomic pointer promotion.
- [ ] Run builder tests; expect all tests to pass.
- [ ] Run `sh -n scripts/prepare-piles-production-runtime.sh && npm run test:piles`; expect success.
- [ ] Commit with `feat(piles): build production runtime atomically`.

### Task 4: Gate every scheduled launch and repair safely

**Files:**
- Modify: `scripts/run-piles-auto-assignment.sh`
- Modify: `lib/piles-auto-assignment-runner.test.mjs`

**Interfaces:**
- Consumes: Task 2 checker and Task 3 builder; `PILES_RUNTIME_RECOVERY_MODE`, `PILES_RUNTIME_REPAIR_WAIT_SECONDS`, `PILES_RUNTIME_ROOT`.
- Produces: fail-closed audit mode and verified repair-mode runner launch.

- [ ] Add failing shell-fixture tests proving healthy launch, audit-mode rejection, repair then launch, repair failure, invalid mode, concurrent repair reuse, and no `--execute` during repair.
- [ ] Run `node --test lib/piles-auto-assignment-runner.test.mjs`; expect the new cases to fail.
- [ ] Implement preflight, bounded locked repair, post-repair recheck, active fingerprint logging, and explicit mode validation.
- [ ] Run the focused Node tests; expect all tests to pass.
- [ ] Run `sh -n scripts/run-piles-auto-assignment.sh && npm run test:piles`; expect success.
- [ ] Commit with `feat(piles): self-heal runtime before scheduled execution`.

### Task 5: Enforce runtime integrity in deployment and readiness

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/piles-production-readiness.yml`
- Create: `.github/workflows/piles-runtime-repair.yml`
- Modify: `lib/piles-auto-assignment-runner.test.mjs`

**Interfaces:**
- Consumes: checker CLI, atomic builder, `current/bin/python`.
- Produces: deployment gate, readiness gate, and approval-gated repair workflow that cannot execute assignments.

- [ ] Add failing workflow-structure and executable-fixture tests for build-before-cron, full runtime verification, current-pointer configuration, and absence of `--execute` in repair/readiness.
- [ ] Run the focused Node test; expect failures.
- [ ] Update deploy/readiness and add the repair workflow with environment approval and exact confirmation input.
- [ ] Run Node workflow tests and shell syntax checks; expect success.
- [ ] Run `npm run test:piles`; expect success.
- [ ] Commit with `ci(piles): enforce atomic runtime readiness`.

### Task 6: Detect missed launches and bound cron evidence

**Files:**
- Create: `scripts/audit-piles-schedule-liveness.mjs`
- Create: `lib/piles-auto-assignment-liveness.test.mjs`
- Create: `.github/workflows/piles-schedule-liveness.yml`
- Modify: `scripts/install-piles-auto-assignment-cron.sh`
- Modify: `lib/piles-auto-assignment-runner.test.mjs`

**Interfaces:**
- Consumes: latest scheduled parent status/timestamps and configured 75-minute threshold.
- Produces: `evaluateScheduleLiveness(snapshot, now, thresholdMinutes) -> result`, independent watchdog, deduplicated failure/recovery signal, bounded log rotation.

- [ ] Write failing pure liveness tests for overdue, completed-empty, completed-assigned, repeated failure, active-within-lease, and recovery cases; add failing cron log-rotation contract test.
- [ ] Run both focused Node test files; expect failures.
- [ ] Implement the read-only audit, scheduled workflow, and size/age-based log rotation without changing assignment state.
- [ ] Run focused tests; expect all tests to pass.
- [ ] Run `npm run test:piles`; expect success.
- [ ] Commit with `ops(piles): detect missed cycles and rotate evidence`.

### Task 7: Document, surface, and release the repair

**Files:**
- Modify: `docs/piles-auto-assignment-runbook.md`
- Modify: `app/api/tools/piles-auto-assignment/runner-runs/route.js`
- Modify: `lib/piles-auto-assignment-view-model.mjs`
- Modify: `lib/piles-auto-assignment-view-model.test.mjs`
- Modify: `app/tools/piles-auto-assignment/page.js`

**Interfaces:**
- Consumes: liveness result and existing runner-history payload.
- Produces: explicit scheduler/runtime-health presentation, rollout checklist, rollback procedure, and evidence checklist.

- [ ] Add failing view-model tests for overdue scheduler, runtime unhealthy, completed-empty, completed assignments, and “covered by active cycle” copy.
- [ ] Run `node --test lib/piles-auto-assignment-view-model.test.mjs`; expect failures.
- [ ] Add the minimal API/view-model/UI fields and update the runbook with audit-mode rollout, repair, read-only validation, activation, monitoring, and atomic rollback.
- [ ] Run focused view-model tests; expect success.
- [ ] Run `npm run test:piles`, Python compile checks, shell syntax checks, `npm run build`, `git diff --check`, and dependency audit; record every result.
- [ ] Commit with `docs(piles): complete runtime recovery operations`.

### Task 8: Whole-branch review and non-mutating release proof

**Files:**
- Modify only files required by Critical or Important review findings.

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: reviewed branch with production-safe release evidence and no production mutation.

- [ ] Generate the whole-branch review package from the merge base through HEAD and obtain one fresh-context review.
- [ ] Re-grade findings by user impact; fix every Critical/Important finding using a new failing regression test followed by the full green suite.
- [ ] Run the complete offline verification matrix and a fixture reproduction of the production corruption.
- [ ] Confirm every discovered test fixture reaches a terminal disposition; do not run a live execute-mode crawl.
- [ ] Record deployment order and the exact gated production commands in the runbook; do not deploy or assign from this task.
- [ ] Commit review fixes, if any, with `fix(piles): close runtime recovery review findings`.

## Self-review

- Spec coverage: Tasks 2–7 cover the runtime contract, atomic repair, schedule gate, workflow convergence, liveness, UI evidence, deployment, and rollback; Task 8 covers final review and non-mutating release proof.
- Interface consistency: the checker/fingerprint produced by Task 2 is consumed unchanged by Tasks 3–5; liveness is pure in Task 6 and consumed by Task 7.
- Review-focus coverage: every listed failure mode has an explicit owning test in Tasks 2–5.
- Proportion: tasks name contracts and assertions without embedding implementation bodies.
