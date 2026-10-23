# Piles Maintenance Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Leave exactly three GitHub workflows: Deploy, Piles Regression Tests, and manually triggered Piles Maintenance.

**Architecture:** Replace the five existing maintenance workflows with one dispatcher containing separately gated jobs. Reuse the existing diagnostic and recovery commands; do not rewrite assignment logic. Delete the five superseded YAML files, rather than retaining disabled or reusable workflows in the Actions list.

**Tech Stack:** GitHub Actions YAML, existing Node/Python/shell scripts, existing Node workflow tests.

**Spec:** User-approved consolidation in this conversation: keep deployment and regression tests, consolidate diagnostics and repairs, remove the old troubleshooting-branch trigger.

## Global Constraints

- Manual dispatch only: no cron, push, or pull-request trigger for maintenance.
- Preserve production assignment cron, deployment, regression CI, and existing assignment logic unchanged.
- Do not restore Schedule Liveness notifications or the deleted Production Canary.
- Keep `contents: read`, `piles-production-host` concurrency, and `cancel-in-progress: false`.
- Preserve runtime repair's `production` environment approval and active-run refusal.
- Preserve exact mutation acknowledgements: `REPAIR PILES RUNTIME`, `RECOVER_STALE_RUNS`, and `CANCEL_OBSOLETE_LEGACY_REQUESTS`.
- No production repairs, assignment runs, or Slack messages during validation.

## Review Focus

1. A diagnostic selection must never reach a mutating job.
2. Missing, ambiguous, or irrelevant target inputs must fail before remote execution.
3. Ownership tokens must be masked before export/logging; never interpolate user input into shell source.
4. Runtime repair must retain its environment gate, exact confirmation, and active-process check.
5. Deleted workflow names must not leave broken test loaders or operational runbook instructions.

## Task 1: Consolidate dispatch and preserve safeguards

**Files:**
- Create `.github/workflows/piles-maintenance.yml`.
- Modify `lib/piles-auto-assignment-runner.test.mjs` and `scripts/inspect-piles-runner-incidents.test.mjs`.
- Delete the five YAML files for incident inspection, production readiness, runtime incident probe, runtime repair, and stale run recovery.

**Interfaces:**
- Inputs: `operation`, `insurer`, `hours`, `scope`, `target_kind`, `target_id`, `claim_token`, `confirmation`.
- Operations: `incident`, `provenance`, `historical-review`, `readiness`, `runtime-probe`, `runtime-repair`, `stale-inspect`, `stale-recover`, `legacy-audit`, `legacy-apply`. Default `incident`.
- Scope: `one-insurer` or `all-active`; default `one-insurer`.
- Target kind: `none`, `parent`, `insurer-run`, `work`, or `legacy-request`; default `none`.
- Map validated targets to the existing scripts' parent/insurer/work/request arguments. Incident permits an optional parent target; legacy actions permit only legacy-request targets; mutations require one exact applicable target. Work recovery requires its claim token, other operations reject it.
- Diagnostic jobs preserve versioned inspector transport, deployed dependency fingerprints, read-only flags, timeouts, and bounded output. Runtime repair remains a separate environment-protected job.

- [x] Write failing workflow tests for exactly three workflow files, manual-only maintenance, exclusive job routing, and all preserved operation choices.
- [x] Add executable validator/shell-fixture cases for invalid operations, incompatible targets, missing confirmations, newline injection, and token masking. Assert no remote command runs on rejected input.
- [x] Run the targeted Node tests and confirm expected failures.
- [x] Implement the unified workflow using the existing operation bodies and safely validated input mappings. Delete the five replaced workflows and migrate their existing tests to the new jobs.
- [x] Run the workflow tests and full `npm run test:piles`; verify deployment/cron source files are unchanged.
- [x] Commit the consolidation and its tests together.

## Task 2: Document and release the consolidation

**Files:** Modify `docs/piles-auto-assignment-runbook.md`; preserve dated historical plans as history.

**Interfaces:** Document the single Maintenance menu, operation-specific inputs, and exact repair acknowledgements.

- [x] Update current operational instructions to reference Maintenance and its appropriate operation rather than old workflow names.
- [ ] Run `git diff --check`, search for obsolete operational references, and verify only the three intended YAML files remain.
- [ ] Obtain an independent review of job routing, mutation guards, and unchanged scheduling/deployment behaviour; fix material findings.
- [ ] Commit documentation, push, and create a concise PR. Require regression CI, including disposable database/browser checks, before merging.
- [ ] Verify the merged main tree contains the three workflows. Do not dispatch a production mutation to test the menu. Note that historical GitHub execution records may remain visible.

## Execution

Recommended: native implementation in the existing isolated workspace, followed by one independent review. This keeps the tightly coupled YAML/input/test migration together and avoids parallel edits to the same workflow tests.
