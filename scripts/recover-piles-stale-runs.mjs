import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { canonicalInsurerLockKey, insurerAdvisoryLockName } from './piles-auto-assignment-locks.mjs';

const ACTIVE = new Set(['queued', 'started', 'running']);
const TERMINAL = new Set(['completed', 'completed_with_issues', 'failed', 'covered_by_active_cycle', 'cancelled', 'manual_action_required', 'partial', 'skipped_overlap']);
const PENDING_WORK = new Set(['queued', 'claimed', 'follow_up_queued']);
const ID = /^[A-Za-z0-9._-]{1,200}$/;

export function parseRecoveryArgs(argv, legacy = false) {
  const values = {};
  const allowed = legacy ? ['--apply', '--confirmation', '--request-id']
    : ['--apply', '--confirmation', '--work-id', '--claim-token', '--insurer-run-id', '--parent-run-id'];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new Error('Invalid recovery arguments.');
    if (key === '--apply') values[key] = true;
    else {
      const value = argv[++index];
      if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid recovery arguments.');
      values[key] = value;
    }
  }
  const apply = values['--apply'] === true;
  const confirmation = legacy ? 'CANCEL_OBSOLETE_LEGACY_REQUESTS' : 'RECOVER_STALE_RUNS';
  const targets = (legacy ? ['--request-id'] : ['--work-id', '--insurer-run-id', '--parent-run-id']).filter((key) => values[key]);
  if (targets.length > 1 || (apply && targets.length !== 1)) throw new Error('One exact recovery target is required.');
  if ((apply && values['--confirmation'] !== confirmation) || (!apply && values['--confirmation'])) throw new Error('Exact confirmation is required only with --apply.');
  if (Boolean(values['--claim-token']) !== Boolean(apply && values['--work-id'])) throw new Error('Work recovery requires the exact claim token. Invalid arguments.');
  return { apply, target: targets[0] || null, id: values[targets[0]] || null, token: values['--claim-token'] || null };
}

export async function recoveryQuery(client, name, text, values = []) {
  return (await client.query({ name, text, values })).rows;
}

export async function recoveryLock(client, insurer, dispatch = false) {
  const lockName = dispatch ? `piles-dispatch:${canonicalInsurerLockKey(insurer)}` : insurerAdvisoryLockName(insurer);
  const rows = await recoveryQuery(client, dispatch ? 'recovery-dispatch-lock' : 'recovery-insurer-lock',
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [lockName]);
  return rows[0]?.acquired === true;
}

export async function recoveryParentLock(client, id) {
  if (!id) return null;
  return (await recoveryQuery(client, 'recovery-parent-lock',
    'SELECT id, status, details FROM piles_auto_assignment_runner_runs WHERE id = $1 FOR UPDATE', [id]))[0];
}

export function terminalRecoveryParent(parent) { return TERMINAL.has(parent?.status); }

// Identifiers below are module-owned SQL, never operator input.
export function canonicalRecoverySql(column) {
  return `(CASE WHEN lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g')) IN ('uapom', 'old mutual')
    THEN 'OLD MUTUAL' ELSE lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g')) END)`;
}

// Unresolved canonical-insurer evidence blocks retry. Even a confirmed submission
// on the target run blocks replay; reconciliation is a separate operation.
function unsafeSubmissionSql(canonical, runId) {
  return `EXISTS (SELECT 1 FROM piles_auto_assignment_attempts attempt
    WHERE (${canonicalRecoverySql('attempt.insurer_name')} = ${canonical}
      AND attempt.status IN ('submitted', 'reconciliation_pending', 'conflict', 'manual_action_required'))
      OR (attempt.insurer_run_id = ${runId} AND attempt.submitted_at IS NOT NULL))
    OR EXISTS (SELECT 1 FROM piles_auto_assignment_batches batch
    WHERE (${canonicalRecoverySql('batch.insurer_name')} = ${canonical}
      AND (batch.status IN ('submitted', 'partially_confirmed', 'reconciliation_pending', 'conflict')
        OR batch.pending_pile_count > 0 OR batch.conflict_pile_count > 0))
      OR (batch.insurer_run_id = ${runId} AND batch.submitted_at IS NOT NULL))`;
}

async function inspectRecovery(client, options) {
  const rows = await recoveryQuery(client, 'recovery-inspect', `
    SELECT insurer_name, sum(stale_insurer_runs)::integer AS stale_insurer_runs,
      sum(expired_work_leases)::integer AS expired_work_leases FROM (
      SELECT insurer_name, 1 AS stale_insurer_runs, 0 AS expired_work_leases
      FROM piles_auto_assignment_insurer_runs WHERE status = 'running'
        AND coalesce(heartbeat_at, started_at, created_at) < clock_timestamp() - interval '15 minutes'
        AND ($1::text IS NULL OR ($1 = '--insurer-run-id' AND id = $2) OR ($1 = '--parent-run-id' AND runner_run_id = $2))
      UNION ALL SELECT insurer_name, 0, 1 FROM piles_auto_assignment_work_items
      WHERE disposition = 'claimed' AND lease_expires_at <= clock_timestamp()
        AND ($1::text IS NULL OR ($1 = '--work-id' AND id = $2) OR ($1 = '--parent-run-id' AND parent_runner_run_id = $2))
    ) evidence GROUP BY insurer_name ORDER BY insurer_name
  `, [options.target, options.id]);
  const report = { mode: 'inspect', stale_insurer_runs: 0, expired_work_leases: 0, lock_held: 0 };
  const observed = new Set();
  for (const row of rows) {
    report.stale_insurer_runs += Number(row.stale_insurer_runs);
    report.expired_work_leases += Number(row.expired_work_leases);
    const canonical = canonicalInsurerLockKey(row.insurer_name);
    if (!observed.has(canonical) && !await recoveryLock(client, canonical)) report.lock_held += 1;
    observed.add(canonical);
  }
  return report;
}

async function lockRun(client, id) {
  return (await recoveryQuery(client, 'recovery-run-lock', `
    SELECT id, runner_run_id, insurer_name, status FROM piles_auto_assignment_insurer_runs
    WHERE id = $1 FOR UPDATE
  `, [id]))[0];
}

async function updateStaleRun(client, id) {
  const rows = await recoveryQuery(client, 'recovery-run-update', `
    UPDATE piles_auto_assignment_insurer_runs
    SET status = 'failed', phase = 'complete', error_code = 'stale_heartbeat_recovered',
        error_message = 'Expired heartbeat and free insurer lock verified by guarded recovery.',
        finished_at = clock_timestamp(), heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = $1 AND status = 'running'
      AND coalesce(heartbeat_at, started_at, created_at) < clock_timestamp() - interval '15 minutes'
    RETURNING id
  `, [id]);
  if (rows.length !== 1) throw new Error('Guarded recovery state changed.');
}

async function recoverWork(client, options, report) {
  const snapshot = (await recoveryQuery(client, 'recovery-work-snapshot', `
    SELECT id, parent_runner_run_id, insurer_name, canonical_insurer_name
    FROM piles_auto_assignment_work_items WHERE id = $1
  `, [options.id]))[0];
  if (!snapshot) return false;
  const parent = await recoveryParentLock(client, snapshot.parent_runner_run_id);
  if (!ACTIVE.has(parent?.status) || !await recoveryLock(client, snapshot.insurer_name, true)) return false;
  // Lock first, then sample time/lock evidence in a new statement (Task 6).
  const work = (await recoveryQuery(client, 'recovery-work-lock', `
    SELECT id, parent_runner_run_id, insurer_name, canonical_insurer_name, claim_token,
      disposition, covered_by_insurer_run_id, started_at FROM piles_auto_assignment_work_items
    WHERE id = $1 AND claim_token = $2 AND disposition = 'claimed' FOR UPDATE
  `, [options.id, options.token]))[0];
  if (!work || work.parent_runner_run_id !== snapshot.parent_runner_run_id
      || canonicalInsurerLockKey(work.insurer_name) !== snapshot.canonical_insurer_name
      || work.canonical_insurer_name !== snapshot.canonical_insurer_name
      || (work.started_at && !work.covered_by_insurer_run_id)) return false;
  let run;
  if (work.covered_by_insurer_run_id) {
    run = await lockRun(client, work.covered_by_insurer_run_id);
    if (!run || run.runner_run_id !== work.parent_runner_run_id || run.status !== 'running'
        || canonicalInsurerLockKey(run.insurer_name) !== work.canonical_insurer_name) return false;
  }
  if (!await recoveryLock(client, work.insurer_name)) return false;
  const evidence = await recoveryQuery(client, 'recovery-work-evidence', `
    SELECT (work.disposition = 'claimed' AND work.claim_token = $2
      AND work.lease_expires_at <= clock_timestamp()
      AND work.heartbeat_at <= clock_timestamp() - interval '120 seconds'
      AND (work.covered_by_insurer_run_id IS NULL OR EXISTS (
        SELECT 1 FROM piles_auto_assignment_insurer_runs run
        WHERE run.id = work.covered_by_insurer_run_id AND run.runner_run_id = work.parent_runner_run_id
          AND run.status = 'running' AND run.submitted_pile_count = 0
          AND run.reconciliation_pending_pile_count = 0 AND run.conflict_pile_count = 0
          AND coalesce(run.heartbeat_at, run.started_at, run.created_at) < clock_timestamp() - interval '15 minutes'))
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_work_items other
        WHERE other.id <> work.id AND other.canonical_insurer_name = work.canonical_insurer_name
          AND (other.disposition = 'claimed' OR (other.disposition = 'queued'
            AND other.source = work.source AND other.request_scope = work.request_scope)))
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_insurer_runs other
        WHERE ${canonicalRecoverySql('other.insurer_name')} = work.canonical_insurer_name
          AND other.status IN ('queued', 'running') AND other.id IS DISTINCT FROM work.covered_by_insurer_run_id)
      AND NOT (${unsafeSubmissionSql('work.canonical_insurer_name', 'work.covered_by_insurer_run_id')})
    ) AS eligible FROM piles_auto_assignment_work_items work WHERE work.id = $1
  `, [options.id, options.token]);
  if (evidence[0]?.eligible !== true) return false;
  if (run) await updateStaleRun(client, run.id);
  const updated = await recoveryQuery(client, 'recovery-work-update', `
    UPDATE piles_auto_assignment_work_items
    SET disposition = 'queued', attempt_number = attempt_number + 1,
      worker_id = NULL, claim_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
      claimed_at = NULL, started_at = NULL, finished_at = NULL, covered_by_insurer_run_id = NULL,
      reason_code = 'expired_lease_recovered', updated_at = clock_timestamp()
    WHERE id = $1 AND claim_token = $2 AND disposition = 'claimed'
      AND lease_expires_at <= clock_timestamp() AND heartbeat_at <= clock_timestamp() - interval '120 seconds'
    RETURNING id
  `, [options.id, options.token]);
  if (updated.length !== 1) throw new Error('Guarded recovery state changed.');
  report.work_requeued = 1;
  report.insurer_runs_recovered = run ? 1 : 0;
  return true;
}

async function recoverInsurer(client, options, report) {
  const snapshot = (await recoveryQuery(client, 'recovery-run-snapshot', `
    SELECT id, runner_run_id, insurer_name FROM piles_auto_assignment_insurer_runs WHERE id = $1
  `, [options.id]))[0];
  if (!snapshot || !await recoveryParentLock(client, snapshot.runner_run_id)
      || !await recoveryLock(client, snapshot.insurer_name, true)) return false;
  const run = await lockRun(client, options.id);
  if (!run || run.status !== 'running' || run.runner_run_id !== snapshot.runner_run_id
      || canonicalInsurerLockKey(run.insurer_name) !== canonicalInsurerLockKey(snapshot.insurer_name)
      || !await recoveryLock(client, run.insurer_name)) return false;
  const evidence = await recoveryQuery(client, 'recovery-run-evidence', `
    SELECT (run.status = 'running'
      AND coalesce(run.heartbeat_at, run.started_at, run.created_at) < clock_timestamp() - interval '15 minutes'
      AND run.submitted_pile_count = 0 AND run.reconciliation_pending_pile_count = 0 AND run.conflict_pile_count = 0
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_work_items work
        WHERE (work.covered_by_insurer_run_id = run.id OR work.canonical_insurer_name = $2)
          AND work.disposition IN ('queued', 'claimed', 'follow_up_queued'))
      AND NOT (${unsafeSubmissionSql('$2', 'run.id')})
    ) AS eligible FROM piles_auto_assignment_insurer_runs run WHERE run.id = $1
  `, [options.id, canonicalInsurerLockKey(run.insurer_name)]);
  if (evidence[0]?.eligible !== true) return false;
  await updateStaleRun(client, options.id);
  report.insurer_runs_recovered = 1;
  return true;
}

function parentOutcome(work, children, acknowledgement) {
  const signals = new Set();
  const mapping = {
    completed: 'completed', failed: 'failed', completed_with_issues: 'issue', partial: 'issue',
    manual_action_required: 'issue', inactive: 'inactive', skipped_inactive: 'inactive',
    cancelled: 'cancelled', covered_by_active_cycle: 'covered', skipped_overlap: 'covered',
  };
  for (const value of [...work.map((row) => row.disposition), ...children.map((row) => row.status)]) {
    if (!mapping[value]) return null;
    signals.add(mapping[value]);
  }
  if (acknowledgement) signals.add('covered');
  if (!signals.size) return null;
  if (signals.size === 1 && signals.has('covered')) return 'covered_by_active_cycle';
  if ([...signals].every((s) => ['cancelled', 'inactive'].includes(s)) && signals.has('cancelled')) return 'cancelled';
  if (signals.has('failed') && !signals.has('completed') && !signals.has('issue')) return 'failed';
  if (signals.has('failed') || signals.has('issue') || signals.has('cancelled')) return 'completed_with_issues';
  return 'completed';
}

async function repairParent(client, options, report) {
  const parent = await recoveryParentLock(client, options.id);
  if (!ACTIVE.has(parent?.status)) return false;
  const insurers = await recoveryQuery(client, 'recovery-parent-insurers', `
    SELECT insurer_name FROM piles_auto_assignment_work_items WHERE parent_runner_run_id = $1
    UNION SELECT insurer_name FROM piles_auto_assignment_insurer_runs WHERE runner_run_id = $1 ORDER BY insurer_name
  `, [options.id]);
  for (const insurer of insurers) {
    if (!await recoveryLock(client, insurer.insurer_name, true) || !await recoveryLock(client, insurer.insurer_name)) return false;
  }
  const work = await recoveryQuery(client, 'recovery-parent-work', `
    SELECT disposition FROM piles_auto_assignment_work_items WHERE parent_runner_run_id = $1 FOR UPDATE
  `, [options.id]);
  const children = await recoveryQuery(client, 'recovery-parent-children', `
    SELECT child.status, (NOT EXISTS (
      SELECT 1 FROM piles_auto_assignment_work_items work WHERE work.parent_runner_run_id = $1)
      OR EXISTS (SELECT 1 FROM piles_auto_assignment_work_items work
        WHERE work.parent_runner_run_id = child.runner_run_id AND work.covered_by_insurer_run_id = child.id)
    ) AS aggregate_outcome
    FROM piles_auto_assignment_insurer_runs child WHERE child.runner_run_id = $1 FOR UPDATE OF child
  `, [options.id]);
  if (work.some((row) => PENDING_WORK.has(row.disposition)) || children.some((row) => ACTIVE.has(row.status))) return false;
  const references = parent.details?.dispatch_requests ?? [];
  if (!Array.isArray(references) || references.length > 256 || references.some((ref) =>
    !ref || Object.keys(ref).sort().join(',') !== 'disposition,request_id,work_item_id'
      || typeof ref.request_id !== 'string' || !ID.test(ref.request_id)
      || typeof ref.work_item_id !== 'string' || !ID.test(ref.work_item_id)
      || !['queued', 'claimed', 'follow_up_queued', 'covered_by_active_cycle', 'inactive', 'completed', 'failed', 'cancelled'].includes(ref.disposition))) return false;
  if (references.length) {
    const ids = [...new Set(references.map((ref) => ref.work_item_id))].sort();
    // Foreign generations stay read-only, avoiding cross-parent lock cycles and
    // never attributing another parent's insurer outcomes to this parent.
    const rows = await recoveryQuery(client, 'recovery-parent-references', `
      SELECT id, disposition FROM piles_auto_assignment_work_items WHERE id = ANY($1::text[])
    `, [ids]);
    if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.id)
        || !['completed', 'failed', 'cancelled', 'covered_by_active_cycle', 'inactive'].includes(row.disposition))) return false;
  }
  // All children must be inactive, but an old recovered attempt must not replace
  // the current owned work's outcome. Legacy parents have no work linkage.
  const ownedOutcomes = children.filter((row) => row.aggregate_outcome !== false);
  let outcome = parentOutcome(work, ownedOutcomes, !work.length && !children.length && references.length > 0);
  if (!outcome) return false;
  const pending = await recoveryQuery(client, 'recovery-parent-pending-evidence', `
    SELECT (EXISTS (SELECT 1 FROM piles_auto_assignment_attempts attempt
      JOIN piles_auto_assignment_insurer_runs run ON run.id = attempt.insurer_run_id
      WHERE run.runner_run_id = $1 AND attempt.status IN ('submitted', 'reconciliation_pending', 'conflict', 'manual_action_required'))
    OR EXISTS (SELECT 1 FROM piles_auto_assignment_batches batch
      JOIN piles_auto_assignment_insurer_runs run ON run.id = batch.insurer_run_id
      WHERE run.runner_run_id = $1 AND (batch.status IN ('submitted', 'partially_confirmed', 'reconciliation_pending', 'conflict')
        OR batch.pending_pile_count > 0 OR batch.conflict_pile_count > 0))) AS pending
  `, [options.id]);
  if (pending[0]?.pending !== false) outcome = 'completed_with_issues';
  const updated = await recoveryQuery(client, 'recovery-parent-update', `
    UPDATE piles_auto_assignment_runner_runs parent
    SET status = $2, finished_at = clock_timestamp(), updated_at = clock_timestamp(),
      duration_ms = least(2147483647, greatest(0, extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::integer
    WHERE parent.id = $1 AND parent.status IN ('queued', 'started', 'running')
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_work_items work
        WHERE work.parent_runner_run_id = parent.id AND work.disposition IN ('queued', 'claimed', 'follow_up_queued'))
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_insurer_runs child
        WHERE child.runner_run_id = parent.id AND child.status IN ('queued', 'running'))
    RETURNING id
  `, [options.id, outcome]);
  if (updated.length !== 1) throw new Error('Guarded recovery state changed.');
  report.parent_runs_repaired = 1;
  return true;
}

export async function runRecovery(client, argv = []) {
  const options = parseRecoveryArgs(argv);
  let committed = false;
  try {
    await client.query(options.apply ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN READ ONLY');
    if (!options.apply) return await inspectRecovery(client, options);
    const report = { mode: 'recover', work_requeued: 0, insurer_runs_recovered: 0, parent_runs_repaired: 0, blocked: 0 };
    const action = options.target === '--work-id' ? recoverWork : options.target === '--insurer-run-id' ? recoverInsurer : repairParent;
    if (!await action(client, options, report)) { report.blocked = 1; return report; }
    await client.query('COMMIT');
    committed = true;
    return report;
  } finally { if (!committed) await client.query('ROLLBACK'); }
}

export async function recoveryCli(operation, legacy = false) {
  let pool;
  let client;
  try {
    parseRecoveryArgs(process.argv.slice(2), legacy);
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Missing database configuration.');
    const sslDisabled = process.env.DATABASE_SSL === 'false' || new URL(url).searchParams.get('sslmode') === 'disable';
    pool = new pg.Pool({ connectionString: url, max: 1,
      ssl: sslDisabled ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } });
    client = await pool.connect();
    const report = await operation(client, process.argv.slice(2));
    console.log(JSON.stringify(report));
    if (report.blocked) process.exitCode = 2;
  } catch {
    console.error('Guarded operation failed; check arguments, schema and database access. No diagnostic payload is printed.');
    process.exitCode = 1;
  } finally {
    client?.release();
    if (pool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await recoveryCli(runRecovery);
