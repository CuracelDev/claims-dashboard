# Piles Auto-Assignment Runbook

## Safety contract

The runner must account for every expected month/year/status context and every planned pile. Assignment intent is persisted before a portal click. A submitted pile is retried only after a later positive observation proves it is still unassigned; disappearance remains `reconciliation_pending`. One insurer's failure does not stop another insurer.

`--read-only` blocks database writes and cannot be combined with `--execute`. It may log into and read the configured portal, acquire advisory locks, and write the local plan file, but it cannot click **Assign Claims**.

## Deployment order

1. Back up the database and apply `scripts/piles-auto-assignment-schema.sql`. The changes are additive.
2. Run `npm run db:audit` and `npm run audit:piles-readiness -- --mode database` against the target database. Both are read-only.
3. Deploy the application and worker from the same commit.
4. Set `PILES_EXECUTION_LEDGER_ENABLED=true` on the worker. Keep `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1` initially; only `1` or `2` is accepted.
5. Confirm the dashboard can queue a preview and display per-insurer heartbeats. Do not enable assignment merely to test deployment.
6. Run a read-only portal probe for one active insurer, then all active insurers:

   ```bash
   python3 scripts/piles_auto_assignment_runner.py --insurer "DEFMIS" --portal-environment production --month All --year All --read-only
   python3 scripts/piles_auto_assignment_runner.py --all-active --portal-environment production --month All --year All --read-only
   ```

   On the production host, these probes can also be run from the **Piles Production Readiness** GitHub Actions workflow. It always uses `--read-only` and cannot click **Assign Claims**.

7. Compare expected contexts with complete/empty contexts. Resolve any failed or missing context before authorizing assignment.
8. A live one-insurer canary requires separate explicit approval and `ALLOW_PRODUCTION_ASSIGNMENTS=true`. Remove that variable after the canary.

The schema must be applied before the application because the progress API and scheduler use the new ledger and coalescing tables. The fresh migration script tolerates a source database that does not yet have those additive tables.

## Required configuration

- `DATABASE_URL`: required for shared advisory locks and transactional ledger writes.
- `PILES_EXECUTION_LEDGER_ENABLED=true`: enables durable context, batch, and per-pile state.
- `PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY=1`: safe default; `2` is permitted only after capacity review.
- `HEADLESS=true`: normal server operation.
- `ALLOW_PRODUCTION_ASSIGNMENTS=true`: required only for intentionally authorized live execution.
- Portal and Slack credentials remain in the secret manager/environment and must never be copied into logs or history.

An insurer with `is_active=false` in Master Insurer Credentials is excluded from all-active runs and the Runner Control insurer dropdown. Bot eligibility separately requires an active, available bot whose time window and assignment rule permit work.

## Expected states

- Run: `queued` → `started/running` → `completed`, `partial`, `failed`, `manual_action_required`, or `skipped_overlap`.
- Context: `pending` → `scanning` → `complete`, `empty`, or `failed`.
- Attempt: `planned` → `selected` → `submitted` → `confirmed_visible` or `reconciliation_pending`.
- Reconciliation: `confirmed_reconciled`, positively observed `still_unassigned`, `conflict`, or `manual_action_required` after the retry limit.

A no-work result is trustworthy only when every expected context is `complete` or `empty`. A missing row after submission is not success.

## Monitoring and alerts

Alert when any of these occur:

- a `running` insurer heartbeat is older than 15 minutes;
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
2. Inspect the failed insurer's phase, error code, context totals, heartbeat, and attempt-state counts.
3. For filter or scan failures, use a read-only visible-browser probe; do not bypass evidence checks.
4. For pending attempts, observe the original filter context. Retry only if the pile is positively visible and unassigned.
5. For conflicts, preserve the observed assignment and resolve manually. Never overwrite an unexpected assignee automatically.
6. Notification failures are repaired separately; they do not invalidate confirmed portal assignments.

## Rollback

Remove `ALLOW_PRODUCTION_ASSIGNMENTS` immediately to stop live portal mutation. Disable scheduled/manual launch at the deployment layer if necessary. `PILES_EXECUTION_LEDGER_ENABLED=false` returns the worker to legacy persistence, but should be used only as a temporary rollback because it removes per-pile reconciliation protection. Additive tables can remain in place. Roll back application and worker together; never drop ledger tables during an incident.
