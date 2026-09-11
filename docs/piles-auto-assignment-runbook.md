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
   python3 scripts/piles_auto_assignment_runner.py --insurer "DEFMIS" --portal-environment production --month All --year All --read-only
   python3 scripts/piles_auto_assignment_runner.py --all-active --portal-environment production --month All --year All --read-only
   ```

   On the production host, these probes can also be run from the **Piles Production Readiness** GitHub Actions workflow. It always uses `--read-only` and cannot click **Assign Claims**.

7. Compare expected contexts with complete/empty contexts. Resolve any failed or missing context before authorizing assignment.
8. A live one-insurer canary requires separate explicit approval and `ALLOW_PRODUCTION_ASSIGNMENTS=true`. Remove that variable after the canary.

The additive schema must be applied and audited before deploying code that consumes work-item leases or `cancelled_legacy`, including the recovery scripts. Leave these additions in place on rollback. The fresh migration script tolerates a source database that does not yet have those additive tables; it is not an incident recovery tool.

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

Legacy cancellation is narrower than age-based cleanup. The exact row must still be `pending`, unclaimed, and owned by an existing terminal scheduled all-active **execute** parent with a finish timestamp, no active child, and no owned nonterminal work. A different execute cycle for the same canonical insurer must have started after the request, completed cleanly, and have no pending/conflict/manual-action evidence. Manual, dry-run, orphaned, active-owner, and merely old requests remain untouched. The free canonical insurer lock is rechecked before the guarded status transition to `cancelled_legacy`; `updated_at` plus the workflow audit trail preserve the cancellation record without rewriting parent details.

The **Piles Stale Run Recovery** workflow has four disjoint actions: `inspect` (default), `recover`, `legacy-audit`, and `legacy-apply`. Inspection actions reject confirmation/token inputs. Recovery requires exactly one of `work_id` plus `claim_token`, `insurer_run_id`, or `parent_run_id` and exact `RECOVER_STALE_RUNS`; legacy apply accepts only `request_id` and exact `CANCEL_OBSOLETE_LEGACY_REQUESTS`. Inputs are validated before SSH; the token is masked. Use the dedicated **Piles Incident Inspection** workflow when no mutation capability is needed.

Exit 0 means the selected operation completed; read-only counts may still report unhealthy candidates. Exit 2 means a mutation was blocked and rolled back. Exit 1 means invalid input/schema/access or a database failure; the transaction is rolled back (or disconnected if access was lost), and no raw driver diagnostic is logged. Reinspect exact targets after any failure or uncertain connection outcome; never assume a failed CLI means a commit could not have reached the database. Do not repeatedly apply based on an old inspection.

## Rollback

Stop new scheduled/manual launches, return concurrency to `1`, then set `PILES_AUTO_ASSIGNMENT_DISPATCHER_V2=false` for future launches. Remove `ALLOW_PRODUCTION_ASSIGNMENTS` from future process configuration; changing an environment file does not stop an already-running process. Let active workers reach a safe evidence boundary, then inspect leases, locks, and submission state. Keep `PILES_EXECUTION_LEDGER_ENABLED=true`: disabling it removes per-pile reconciliation protection and is not a normal dispatcher rollback.

Roll back application and worker together while retaining additive tables, queue rows and all submitted/reconciliation evidence. Use only the exact guarded operations above for expired/free-lock work. A committed requeue is not undone by restoring an old token, and a legacy cancellation must not be changed blindly back to `pending` (a newer request may now own the unique pending slot). Keep launches paused, preserve the audit trail, and obtain a reviewed repair/new request if a committed operational change was mistaken. Never drop ledger tables, delete attempts, or run a destructive fresh migration during an incident.
