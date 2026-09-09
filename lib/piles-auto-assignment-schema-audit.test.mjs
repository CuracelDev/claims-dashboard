import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { auditDatabase, normalizeConstraintColumns } from '../scripts/db-schema-audit.mjs';
import { insurerAdvisoryLockName } from '../scripts/piles-auto-assignment-locks.mjs';

test('constraint columns normalize PostgreSQL array strings', () => {
  assert.deepEqual(normalizeConstraintColumns('{team_member_id,report_date}'), [
    'team_member_id',
    'report_date',
  ]);
});

test('schema audit rejects missing required columns and constraints', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('information_schema.columns')) return { rows: [] };
      if (sql.includes('information_schema.table_constraints')) return { rows: [] };
      if (sql.startsWith('select count(*)')) return { rows: [{ count: 0 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    auditDatabase(pool, { log() {} }),
    /schema audit failed/i,
  );
});

test('deployment audit separates repair deployment from runtime incident gates', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const readiness = readFileSync(new URL('../scripts/audit-piles-auto-assignment-readiness.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /audit-piles-auto-assignment-readiness\.mjs --mode deployment/);
  assert.match(readiness, /const deploymentMode = modeArg === 'deployment'/);
  assert.match(readiness, /deploymentMode \|\| stale\.rows\[0\]\.count === 0/);
  assert.match(readiness, /deploymentMode \|\| pending\.rows\[0\]\.count === 0/);
});

test('stale-run recovery is confirmation and advisory-lock guarded', () => {
  const workflow = readFileSync(new URL('../.github/workflows/piles-stale-run-recovery.yml', import.meta.url), 'utf8');
  const recovery = readFileSync(new URL('../scripts/recover-piles-stale-runs.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /RECOVER_STALE_RUNS/);
  assert.match(workflow, /recover-piles-stale-runs\.mjs --apply/);
  assert.match(recovery, /pg_try_advisory_lock/);
  assert.match(recovery, /select id, runner_run_id[\s\S]*for update/);
  assert.match(recovery, /select id from piles_auto_assignment_runner_runs where id = \$1 for update/);
  assert.match(recovery, /parent\.status in \('queued', 'started', 'running'\)/);
  assert.match(recovery, /if \(!acquired\)/);
  assert.match(recovery, /status = 'running'/);
  assert.match(recovery, /Active insurer runs:/);
  assert.match(recovery, /is_stale/);
  assert.match(recovery, /if \(!run\.is_stale\)/);
  assert.match(recovery, /coalesce\(heartbeat_at, started_at, created_at\) < now\(\) - interval '15 minutes'/);
});

test('recovery advisory-lock names match runner aliases exactly', () => {
  assert.equal(insurerAdvisoryLockName('DEFMIS'), 'piles-insurer:defmis');
  assert.equal(insurerAdvisoryLockName('Jubilee Kenya'), 'piles-insurer:jubilee kenya');
  assert.equal(insurerAdvisoryLockName('UAPOM'), 'piles-insurer:OLD MUTUAL');
  assert.equal(insurerAdvisoryLockName('old mutual'), 'piles-insurer:OLD MUTUAL');
});
