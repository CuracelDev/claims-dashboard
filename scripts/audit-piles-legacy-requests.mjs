import { pathToFileURL } from 'node:url';
import {
  canonicalRecoverySql, parseRecoveryArgs, recoveryCli, recoveryLock, recoveryParentLock,
  recoveryQuery, terminalRecoveryParent,
} from './recover-piles-stale-runs.mjs';
import { canonicalInsurerLockKey } from './piles-auto-assignment-locks.mjs';

// Age alone is not obsolescence: require a terminal scheduled all-active execute
// owner and a later clean completed insurer cycle that supersedes the request.
const obsolete = `request.status = 'pending' AND request.claimed_by_runner_run_id IS NULL
  AND parent.status IN ('completed', 'completed_with_issues', 'failed', 'covered_by_active_cycle',
    'cancelled', 'manual_action_required', 'partial', 'skipped_overlap')
  AND parent.finished_at IS NOT NULL AND parent.finished_at <= clock_timestamp()
  AND parent.run_source = 'schedule' AND parent.run_scope = 'all-active' AND parent.mode = 'execute'
  AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_insurer_runs active
    WHERE active.runner_run_id = parent.id AND active.status IN ('queued', 'running'))
  AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_work_items work
    WHERE work.parent_runner_run_id = parent.id AND work.disposition IN ('queued', 'claimed', 'follow_up_queued'))
  AND EXISTS (SELECT 1 FROM piles_auto_assignment_insurer_runs successor
    JOIN piles_auto_assignment_runner_runs successor_parent ON successor_parent.id = successor.runner_run_id
    WHERE ${canonicalRecoverySql('successor.insurer_name')} = ${canonicalRecoverySql('request.insurer_name')}
      AND successor.runner_run_id <> parent.id AND successor_parent.mode = 'execute'
      AND successor.status = 'completed' AND successor.started_at >= request.requested_at
      AND successor.finished_at IS NOT NULL AND successor.finished_at <= clock_timestamp()
      AND successor.reconciliation_pending_pile_count = 0 AND successor.conflict_pile_count = 0
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_attempts attempt
        WHERE attempt.insurer_run_id = successor.id
          AND attempt.status IN ('submitted', 'reconciliation_pending', 'conflict', 'manual_action_required'))
      AND NOT EXISTS (SELECT 1 FROM piles_auto_assignment_batches batch
        WHERE batch.insurer_run_id = successor.id AND (batch.pending_pile_count > 0 OR batch.conflict_pile_count > 0
          OR batch.status IN ('submitted', 'partially_confirmed', 'reconciliation_pending', 'conflict'))))`;

export async function runLegacyAudit(client, argv = []) {
  const options = parseRecoveryArgs(argv, true);
  let committed = false;
  try {
    await client.query(options.apply ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN READ ONLY');
    if (!options.apply) {
      const rows = await recoveryQuery(client, 'legacy-inspect', `
        SELECT count(*)::integer AS pending_requests,
          count(*) FILTER (WHERE ${obsolete})::integer AS obsolete_requests
        FROM piles_auto_assignment_schedule_requests request
        LEFT JOIN piles_auto_assignment_runner_runs parent ON parent.id = request.requested_runner_run_id
        WHERE request.status = 'pending' AND ($1::text IS NULL OR request.id = $1)
      `, [options.id]);
      return { mode: 'inspect', pending_requests: Number(rows[0]?.pending_requests || 0), obsolete_requests: Number(rows[0]?.obsolete_requests || 0) };
    }
    const blocked = { mode: 'apply', cancelled_requests: 0, blocked: 1 };
    const snapshot = (await recoveryQuery(client, 'legacy-snapshot', `
      SELECT requested_runner_run_id, insurer_name FROM piles_auto_assignment_schedule_requests WHERE id = $1
    `, [options.id]))[0];
    if (!snapshot?.requested_runner_run_id) return blocked;
    const parent = await recoveryParentLock(client, snapshot.requested_runner_run_id);
    if (!terminalRecoveryParent(parent) || !await recoveryLock(client, snapshot.insurer_name, true)) return blocked;
    const request = (await recoveryQuery(client, 'legacy-request-lock', `
      SELECT id, requested_runner_run_id, insurer_name, status, claimed_by_runner_run_id
      FROM piles_auto_assignment_schedule_requests WHERE id = $1 AND status = 'pending' FOR UPDATE
    `, [options.id]))[0];
    if (!request || request.requested_runner_run_id !== snapshot.requested_runner_run_id
        || canonicalInsurerLockKey(request.insurer_name) !== canonicalInsurerLockKey(snapshot.insurer_name)
        || request.claimed_by_runner_run_id || !await recoveryLock(client, request.insurer_name)) return blocked;
    const evidence = await recoveryQuery(client, 'legacy-evidence', `
      SELECT (${obsolete}) AS eligible FROM piles_auto_assignment_schedule_requests request
      JOIN piles_auto_assignment_runner_runs parent ON parent.id = request.requested_runner_run_id WHERE request.id = $1
    `, [options.id]);
    if (evidence[0]?.eligible !== true) return blocked;
    const updated = await recoveryQuery(client, 'legacy-cancel', `
      UPDATE piles_auto_assignment_schedule_requests
      SET status = 'cancelled_legacy', updated_at = clock_timestamp()
      WHERE id = $1 AND requested_runner_run_id = $2 AND status = 'pending'
        AND claimed_by_runner_run_id IS NULL RETURNING id
    `, [options.id, snapshot.requested_runner_run_id]);
    if (updated.length !== 1) throw new Error('Guarded cancellation state changed.');
    await client.query('COMMIT');
    committed = true;
    return { mode: 'apply', cancelled_requests: 1, blocked: 0 };
  } finally { if (!committed) await client.query('ROLLBACK'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await recoveryCli(runLegacyAudit, true);
