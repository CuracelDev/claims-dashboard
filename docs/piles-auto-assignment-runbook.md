# Piles Auto-Assignment Runbook

## Safety contract

The runner must account for every expected month/year/status context and every planned pile. Assignment intent is persisted before a portal click. A submitted pile is retried only after a later positive observation proves it is still unassigned; disappearance remains `reconciliation_pending`. One insurer's failure does not stop another insurer.

`--read-only` blocks database writes and cannot be combined with `--execute`. It may log into and read the configured portal, acquire advisory locks, and write the local plan file, but it cannot click **Assign Claims**.

## Deployment order

1. Back up the database and apply `scripts/piles-auto-assignment-schema.sql`. The changes are additive.
2. Run `npm run db:audit` and `npm run audit:piles-readiness -- --mode database` against the target database. Both are read-only.
3. Audit legacy pending requests using the read-only command below. With new launches stopped and dispatcher v2 still disabled, separately approve cancellation of each demonstrably obsolete request; never bulk-delete the backlog.
4. Deploy the application and worker from the same commit with `PILES_EXECUTION_LEDGER_ENABLED=true`, `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2=false`, and `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1`. Only `1` or `2` is accepted; enabling v2 or concurrency two requires a separately approved rollout.
5. Confirm the dashboard can queue a preview and display per-insurer heartbeats. Do not enable assignment merely to test deployment.
6. Run a read-only portal probe for one active insurer, then all active insurers:

   ```bash
   "$PILES_ASSIGNMENT_PYTHON_BIN" scripts/piles_auto_assignment_runner.py --insurer "DEFMIS" --portal-environment production --month All --year All --run-source readiness --read-only
   "$PILES_ASSIGNMENT_PYTHON_BIN" scripts/piles_auto_assignment_runner.py --all-active --portal-environment production --month All --year All --run-source readiness --read-only
   ```

   On the production host, these probes can also be run from the **Piles Production Readiness** GitHub Actions workflow. It always uses `--read-only` and cannot click **Assign Claims**.

7. Compare expected contexts with complete/empty contexts. Resolve any failed or missing context before authorizing assignment.
8. A live one-insurer canary requires separate explicit approval and `ALLOW_PRODUCTION_ASSIGNMENTS=true`. Remove that variable after the canary.

The additive schema must be applied and audited before deploying code that consumes work-item leases or `cancelled_legacy`, including the recovery scripts. Leave these additions in place on rollback. The fresh migration script tolerates a source database that does not yet have those additive tables; it is not an incident recovery tool.

## Dispatcher acceptance checklist

This checklist is an approval record, not authorization to deploy, activate flags, run a live canary, or recover work. Complete the offline gates before requesting production approval. Record the commit, operator, timestamp, aggregate counts and inspection/workflow links for each stage; do not retain credentials, claim identities, raw plan files or portal HTML.

- [ ] Offline gate: run `npm run test:piles:acceptance`, `python3 -m py_compile scripts/piles_auto_assignment_runner.py scripts/piles_auto_assignment/*.py`, `sh -n scripts/run-piles-auto-assignment.sh scripts/install-piles-auto-assignment-cron.sh`, `npm run test:piles`, `npm run build`, `npm audit --audit-level=high`, and `git diff --check`. The full Piles discovery includes acceptance automatically. The offline acceptance suite uses actual scheduler/dispatcher/store/ledger/runner logic with fake PostgreSQL dialect/session locks and fake portal/delivery boundaries; it never performs real assignments. It does not replace the separate real-PostgreSQL row-wait/lease race gate. Compare audit findings with the recorded branch baseline (7 moderate, 8 high, 1 critical), requiring zero newly introduced findings and no unresolved high/critical finding in a production dependency changed for this work.
- [ ] Schema first: back up the target database; stage only the additive schema and audit scripts from the approved commit; apply with `npm run db:piles-auto-assignment`; run `npm run db:audit` and `npm run audit:piles-readiness -- --mode database`. Inspect legacy requests using `node scripts/audit-piles-legacy-requests.mjs`; any exact-row cancellation remains separately approved. Only then deploy the matching app/worker code with ledger `true`, dispatcher v2 `false`, concurrency `1`. Verify installed cron/source, Python executable, deployed commit and app health without printing environment values.
- [ ] Inspection baseline: in the authorized host shell and exported environment described under Incident response, run `node scripts/inspect-piles-runner-incidents.mjs --hours 24` and `node scripts/recover-piles-stale-runs.mjs`. Resolve duplicates, stale/free-lock work, failed contexts and unexplained legacy backlog before continuing. Elapsed duration alone is not a stale-work finding.
- [ ] Read-only one-insurer probes: run the commands below for Jubilee Tanzania and Jubilee Uganda, followed by all-active at concurrency one. Confirm every expected context is complete/empty, provenance is `readiness`, and probes create no assignment attempts or execute work. A same-insurer lock conflict must return the explicit blocked code; do not force the lock. Retain aggregate evidence only.

  ```bash
  "$PILES_ASSIGNMENT_PYTHON_BIN" scripts/piles_auto_assignment_runner.py --insurer "Jubilee Tanzania" --portal-environment production --month All --year All --run-source readiness --read-only
  "$PILES_ASSIGNMENT_PYTHON_BIN" scripts/piles_auto_assignment_runner.py --insurer "Jubilee Uganda" --portal-environment production --month All --year All --run-source readiness --read-only
  PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1 "$PILES_ASSIGNMENT_PYTHON_BIN" scripts/piles_auto_assignment_runner.py --all-active --portal-environment production --month All --year All --run-source readiness --read-only
  ```

- [ ] Dispatcher v2/concurrency-one approval: explicitly approve activation, keep concurrency `1`, repeat the read-only gates, then approve a one-insurer canary using ordinary queued production work. Do not create synthetic claims. Observe a normal scheduled all-active execute cycle; source must be `schedule`, every owned generation executes once, later insurers are reached, overlap requests are covered, manual follow-up is exactly one separately owned generation, and parents become terminal only after their owned work settles.
- [ ] Portal/evidence check: reconcile submitted totals against confirmed-visible, confirmed-reconciled, pending, conflict and failed/manual outcomes. Verify confirmation against the normal authorized portal view without copying claim identifiers. Confirm late arrivals from initially empty contexts are handled once; pending/submitted rows are reconciled without blind resubmission. One failing insurer must not stop the others. An uninterrupted parent sends one confirmed-only aggregate after collection, with no duplicate owner item; pending/conflict/manual/unmatched items are never announced as confirmed assignments.
- [ ] Concurrency-two approval: only after the preceding cycle is healthy, obtain separate approval for `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=2`. Repeat the all-active read-only command with `2`, then observe a normal execute cycle. The read-only all-active path remains sequential, so its configured ceiling is not proof of parallel portal safety: the execute evidence must demonstrate at most two different insurer sessions, no simultaneous canonical alias, no cross-session interference, stable host CPU/memory and truthful ordered parent outcomes.
- [ ] Queue drain: inspect the exact cycle with `node scripts/inspect-piles-runner-incidents.mjs --run-id PARENT_RUN_ID --hours 24` and rerun readiness. All owned work is terminal; no queued/follow-up generation is left without a live owner; no expired lease with a free lock is unexplained; pending reconciliation remains visible rather than relabeled success. Confirm a manual follow-up belongs to its requesting parent and reused requests are acknowledgements, not extra execution.
- [ ] Sign off the deployed commit, approvals, inspection links, context/work/attempt counts, concurrency evidence and rollback decision. If any safety check fails, pause new launches and follow Rollback. Production acceptance remains incomplete until these external evidence gates are explicitly authorized and recorded.

Parent notification limitation: SIGTERM drains active work at a safe evidence boundary and leaves remaining work recoverable. A `running` parent emits no assignment, external-assignment or weekend-restore summary. A resumed parent can have durable confirmed assignments from a prior process but no reconstructable prior notification payload: batches record portal action rather than new-assignment/reassignment kind, and immutable owner/previous-owner/provider notification metadata is incomplete. V2 compares all owned executable generation IDs with its current completed collection, excluding inactive/coverage acknowledgements and foreign references. It also compares exact confirmed-visible/confirmed-reconciled identities with returned verified notification items using ephemeral per-generation hashes, never logged, serialized or persisted. Checks are bounded to 256 generations and 10,000 confirmations. On missing/extra/duplicate identities, malformed/oversized evidence or database failure, it emits only the fixed `parent_notification_incomplete` warning and sends none of those parent summaries. This also catches a worker failing after confirmation or final reconciliation confirming an item absent from its notification payload. Portal and ledger outcomes remain authoritative; repair notifications separately under operator approval. There is no durable notification outbox or exactly-once delivery guarantee across a crash after parent finalization/during transport. Replaying a terminal parent never reassigns or automatically renotifies it. Insurer-local weekend roster scheduling updates remain unchanged: they report configuration changes applied within that insurer workflow, not parent assignment confirmation.

## Required configuration

- `DATABASE_URL`: required for shared advisory locks and transactional ledger writes.
- `PILES_EXECUTION_LEDGER_ENABLED=true`: enables durable context, batch, and per-pile state.
- `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1`: safe default; `2` is permitted only after capacity review.
- `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2=false`: default-disabled dispatcher rollout/rollback switch.
- `HEADLESS=true`: normal server operation.
- `ALLOW_PRODUCTION_ASSIGNMENTS=true`: required only for intentionally authorized live execution.
- Portal and Slack credentials remain in the secret manager/environment and must never be copied into logs or history.

An insurer with `is_active=false` in Master Insurer Credentials is excluded from all-active runs and the Runner Control insurer dropdown. Bot eligibility separately requires an active, available bot whose time window and assignment rule permit work.

## Expected states

- Parent: `queued` → `started/running` → `completed`, `completed_with_issues`, `failed`, `covered_by_active_cycle`, or `cancelled`. Legacy `partial`, `manual_action_required`, and `skipped_overlap` remain readable.
- Work item: `queued/follow_up_queued` → `claimed` → `completed/failed/cancelled`. Executing work stays `claimed`; there is no persisted work-item `running` disposition. Its linked insurer run is `running`.
- Context: `pending` → `scanning` → `complete`, `empty`, or `failed`.
- Attempt: `planned` → `selected` → `submitted` → `confirmed_visible` or `reconciliation_pending`.
- Reconciliation: `confirmed_reconciled`, positively observed `still_unassigned`, `conflict`, or `manual_action_required` after the retry limit.

A no-work result is trustworthy only when every expected context is `complete` or `empty`. A missing row after submission is not success.

## Monitoring and alerts

Alert when any of these occur:

- a `running` insurer heartbeat is older than 15 minutes and its canonical insurer lock is free;
- reconciliation remains pending longer than 30 minutes;
- any conflict appears;
- a scan context fails or remains pending after its insurer run finishes;
- an active insurer has no active rule or no eligible owner;
- a run is `partial` or `failed`;
- coalesced requests remain pending beyond the next schedule interval.

Use the dashboard for sanitized status. These read-only queries provide counts without exposing claim identifiers:

```sql
select insurer_name, status, phase, error_code, heartbeat_at
from piles_auto_assignment_insurer_runs
where created_at > now() - interval '24 hours'
order by created_at desc;

select status, count(*)
from piles_auto_assignment_attempts
where created_at > now() - interval '24 hours'
group by status order by status;

select insurer_name, count(*) pending_requests
from piles_auto_assignment_schedule_requests
where status = 'pending'
group by insurer_name;
```

For every run, verify this invariant: submitted attempts equal confirmed-visible plus confirmed-reconciled plus reconciliation-pending plus conflict plus failed/manual dispositions.

## Incident response

1. Disable new live work by removing `ALLOW_PRODUCTION_ASSIGNMENTS` or switching scheduled execution off. Do not delete ledger rows.
2. Inspect the failed insurer's phase, error code, context totals, heartbeat, and attempt-state counts. From the production host, generate a sanitized report for the last 24 hours:

   ```bash
   cd ~/claims-dashboard
   set -a
   . ./.env
   set +a
   node scripts/inspect-piles-runner-incidents.mjs --hours 24
   ```

   Use an authorized host shell with Node dependencies installed and the deployed repository's `.env` available. Do not enable `set -x`, echo environment values, or copy credentials into commands/logs. Subsequent direct-host commands below assume this same repository directory and exported environment.

   To inspect one parent run, add its UUID:

   ```bash
   node scripts/inspect-piles-runner-incidents.mjs --hours 24 --run-id 123e4567-e89b-42d3-a456-426614174000
   ```

   The **Piles Incident Inspection** GitHub Actions workflow runs these same read-only commands. It accepts only `hours` and optional `run_id`. The inspector starts a read-only database transaction, prints only bounded operational fields, and rolls the transaction back. `work_items_available=false` is expected before the dispatcher work-item schema is deployed; use `pending_requests` for the legacy queue view in that case.
3. For filter or scan failures, use a read-only visible-browser probe; do not bypass evidence checks.
4. For pending attempts, observe the original filter context. Retry only if the pile is positively visible and unassigned.
5. For conflicts, preserve the observed assignment and resolve manually. Never overwrite an unexpected assignee automatically.
6. Notification failures are repaired separately; they do not invalidate confirmed portal assignments.

Interpret the incident report as follows:

- `completed_with_issues` means safe work completed but at least one insurer, context, conflict, or reconciliation outcome still needs attention. Legacy `partial` carries the older mixed-outcome meaning and remains readable.
- `covered_by_active_cycle` means an already-running all-active cycle owns the request; it is evidence of deduplication, not a new successful assignment run.
- `follow_up_queued` means a manual request arrived during an active insurer run and one later generation is waiting. Confirm that it is eventually claimed or cancelled explicitly.
- `reconciliation_pending` means submission occurred without enough positive portal evidence to declare success or retry. Observe the original context before taking action.
- A large elapsed duration is not itself a failure. Treat a heartbeat as stale only when `heartbeat_age_seconds` exceeds the 15-minute threshold and lock evidence shows that no live insurer worker owns the run.

## Guarded recovery and legacy backlog

These scripts do not launch the runner, contact the portal, assign claims, delete rows, or change attempt/batch evidence. Requeuing makes work eligible for a later dispatcher claim, so stop new scheduled/manual launches and let active workers reach a safe evidence boundary before approving any mutation. Do not use a live worker's token or force an advisory unlock. Back up the database, confirm the deployed commit, and apply/audit the additive schema first.

Default inspection opens `BEGIN READ ONLY` and always rolls back. Reports contain only fixed aggregate fields, not raw errors, names, IDs, tokens, HTML, or claim identifiers:

```bash
node scripts/recover-piles-stale-runs.mjs
node scripts/recover-piles-stale-runs.mjs --work-id WORK_ITEM_ID
node scripts/recover-piles-stale-runs.mjs --insurer-run-id INSURER_RUN_ID
node scripts/recover-piles-stale-runs.mjs --parent-run-id PARENT_RUN_ID
node scripts/audit-piles-legacy-requests.mjs
node scripts/audit-piles-legacy-requests.mjs --request-id LEGACY_REQUEST_ID
```

Use the incident report to identify exact work/insurer/parent/request IDs; legacy IDs may be 32-character opaque IDs rather than UUIDs. For work recovery, obtain the current `claim_token` for that exact work ID through an authorized private database console, using a bound parameter: `SELECT claim_token FROM piles_auto_assignment_work_items WHERE id = $1 AND disposition = 'claimed'`. Do not print the token in Actions logs, tickets, or shared terminals. Inspection is a candidate snapshot, never permission to recover later without rechecking.

After separate approval, choose exactly one mutation target:

```bash
# In Bash, read the current token privately instead of saving it in shell history.
read -r -s -p 'Current claim token: ' PILES_RECOVERY_TOKEN
node scripts/recover-piles-stale-runs.mjs --apply --confirmation RECOVER_STALE_RUNS --work-id WORK_ITEM_ID --claim-token "$PILES_RECOVERY_TOKEN"
unset PILES_RECOVERY_TOKEN

# Legacy/unlinked stale insurer run; cannot bypass nonterminal insurer work.
node scripts/recover-piles-stale-runs.mjs --apply --confirmation RECOVER_STALE_RUNS --insurer-run-id INSURER_RUN_ID

# Repair one abandoned parent after all owned/referenced work has settled.
node scripts/recover-piles-stale-runs.mjs --apply --confirmation RECOVER_STALE_RUNS --parent-run-id PARENT_RUN_ID

# Separate operation and distinct exact confirmation; never a bulk cancellation.
node scripts/audit-piles-legacy-requests.mjs --apply --confirmation CANCEL_OBSOLETE_LEGACY_REQUESTS --request-id LEGACY_REQUEST_ID
```

Work recovery requires the exact current token, an expired lease, a work heartbeat at least 120 seconds old, an active owning parent, and free canonical dispatch/insurer locks. A linked running insurer must additionally have a heartbeat older than 15 minutes and matching parent/insurer ownership. Time and evidence are sampled after row locks using fresh database time, not elapsed wall time or transaction-start time. Recovery increments the work attempt number, clears worker/token/lease/heartbeat/run linkage and lifecycle timestamps, preserves source/parent/generation, and requeues with `expired_lease_recovered`. A stale linked insurer is failed atomically with that requeue.

Recovery refuses any conflicting claimed work or later queued generation for the same insurer/source/scope; it never cancels or overwrites the competing generation to make room. Missing run linkage after execution started, terminal linked runs, fresh heartbeats, held locks, wrong tokens, and orphaned work stay blocked for explicit review. Submitted/reconciliation/conflict/manual-action evidence blocks replay, including recorded submissions that were later confirmed. Never delete or reset such evidence to bypass a guard; reconcile the original portal context first through the normal evidence workflow.

Parent repair requires no queued/claimed/follow-up owned work, no active child insurer, and free relevant insurer locks. Missing/nonterminal reused references block repair; another parent's failed/successful insurer outcome never becomes this parent's owned result. Empty/unknown outcomes are not guessed as success. Mixed, failed, cancelled, covered, and reconciliation outcomes remain distinct. Recovered queued work leaves its parent nonterminal: this operation does not start a new run or automatically resume it. Resume the original parent only through the separately approved dispatcher workflow after inspecting the queue.

Legacy cancellation is narrower than age-based cleanup. The exact row must still be `pending`, unclaimed, and owned by an existing terminal scheduled all-active **execute** parent with a finish timestamp, no active child, and no owned nonterminal work. A different execute cycle for the same canonical insurer must have started after the request, completed cleanly, and have no pending/conflict/manual-action evidence. It must use the same known portal environment and cover all requested months and years: exact scope is sufficient; explicit `All` can cover a narrower scope; a narrower cycle cannot cover `All`. Persisted month arrays accept known short/full month labels with case/space normalization and set coverage; empty/null/scalar/unknown arrays and mixed `All` plus other labels are not evidence. Years must be explicit `All` or a known four-digit `20xx` value. Missing or unknown scope is never inferred as `All`, even when two missing values match. A manual successor may qualify if its execute scope is sufficient, but manual requests, dry-run cycles, orphaned/active-owner requests, and age alone remain ineligible. The free canonical insurer lock is rechecked before the guarded status transition to `cancelled_legacy`; `updated_at` plus the workflow audit trail preserve the cancellation record without rewriting parent details.

The **Piles Stale Run Recovery** workflow has four disjoint actions: `inspect` (default), `recover`, `legacy-audit`, and `legacy-apply`. Inspection actions reject confirmation/token inputs. Recovery requires exactly one of `work_id` plus `claim_token`, `insurer_run_id`, or `parent_run_id` and exact `RECOVER_STALE_RUNS`; legacy apply accepts only `request_id` and exact `CANCEL_OBSOLETE_LEGACY_REQUESTS`. The first step reads the workflow event JSON privately via `GITHUB_EVENT_PATH`, registers token masking immediately, validates without echoing input, then exports values via `GITHUB_ENV` for later steps. No token value or input expression is placed in job/first-step environment, script, or action inputs before masking, so the runner's initial command/environment preamble cannot print it. Masking protects logs, not workflow-dispatch input metadata: dispatched inputs can remain in event records accessible to authorized workflow operators. If that retention is unsuitable, use the private direct-host recovery command instead; never treat workflow inputs as a secret store. Use the dedicated **Piles Incident Inspection** workflow when no mutation capability is needed.

Exit 0 means the selected operation completed; read-only counts may still report unhealthy candidates. Exit 2 means a mutation was blocked and rolled back. Exit 1 means invalid input/schema/access or a database failure; the transaction is rolled back (or disconnected if access was lost), and no raw driver diagnostic is logged. Reinspect exact targets after any failure or uncertain connection outcome; never assume a failed CLI means a commit could not have reached the database. Do not repeatedly apply based on an old inspection.

## Rollback

Stop new scheduled/manual launches, return concurrency to `1`, then set `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2=false` for future launches. Remove `ALLOW_PRODUCTION_ASSIGNMENTS` from future process configuration; changing an environment file does not stop an already-running process. Let active workers reach a safe evidence boundary, then inspect leases, locks, and submission state. Keep `PILES_EXECUTION_LEDGER_ENABLED=true`: disabling it removes per-pile reconciliation protection and is not a normal dispatcher rollback.

In the authorized host shell, the exact process-local rollback settings and read-only checks are:

```bash
export PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1
export PILES_AUTO_ASSIGNMENT_DISPATCHER_V2=false
export PILES_EXECUTION_LEDGER_ENABLED=true
unset ALLOW_PRODUCTION_ASSIGNMENTS
node scripts/inspect-piles-runner-incidents.mjs --hours 24
node scripts/recover-piles-stale-runs.mjs
npm run audit:piles-readiness -- --mode database
```

Persist those same flag values and remove production-assignment approval in the approved deployment configuration and host `.env` before any new launcher starts; shell exports alone do not change cron, Runner Control, remote workers or an existing process. Keep launches paused while configuration is reconciled. These commands intentionally do not restart a worker, modify queues, force-unlock an insurer, or resubmit an assignment. Exact guarded recovery commands are listed above and still need their separate target/confirmation approval.

Roll back application and worker together while retaining additive tables, queue rows and all submitted/reconciliation evidence. Use only the exact guarded operations above for expired/free-lock work. A committed requeue is not undone by restoring an old token, and a legacy cancellation must not be changed blindly back to `pending` (a newer request may now own the unique pending slot). Keep launches paused, preserve the audit trail, and obtain a reviewed repair/new request if a committed operational change was mistaken. Never drop ledger tables, delete attempts, or run a destructive fresh migration during an incident.
