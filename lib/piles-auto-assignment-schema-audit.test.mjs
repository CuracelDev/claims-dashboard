import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  auditDatabase,
  evaluateTable,
  normalizeConstraintColumns,
} from '../scripts/db-schema-audit.mjs';
import {
  evaluateQueueHealth,
  inspectQueueHealth,
} from '../scripts/audit-piles-auto-assignment-readiness.mjs';
import { insurerAdvisoryLockName } from '../scripts/piles-auto-assignment-locks.mjs';
import { buildFreshSchemaSql } from '../scripts/fresh-migrate-prod-via-adminer.mjs';

function parseYamlWithRuby(source) {
  const result = spawnSync(
    'ruby',
    ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))'],
    { input: source, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

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
      if (sql.includes('information_schema.referential_constraints')) return { rows: [] };
      if (sql.includes('pg_constraint')) return { rows: [] };
      if (sql.includes('pg_index')) return { rows: [] };
      if (sql.startsWith('select count(*)')) return { rows: [{ count: 0 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    auditDatabase(pool, { log() {} }),
    /schema audit failed/i,
  );
});

function durableWorkAuditFixture() {
  const columns = [
    ['id', 'text', 'NO'], ['parent_runner_run_id', 'text', 'YES'], ['insurer_name', 'text', 'NO'],
    ['canonical_insurer_name', 'text', 'NO'], ['source', 'text', 'NO'], ['request_scope', 'text', 'NO'],
    ['disposition', 'text', 'NO'], ['covered_by_insurer_run_id', 'text', 'YES'], ['worker_id', 'text', 'YES'],
    ['claim_token', 'text', 'YES'], ['lease_expires_at', 'timestamp with time zone', 'YES'],
    ['heartbeat_at', 'timestamp with time zone', 'YES'], ['generation_requested_at', 'timestamp with time zone', 'NO'],
    ['attempt_number', 'integer', 'NO'], ['requested_at', 'timestamp with time zone', 'NO'],
    ['claimed_at', 'timestamp with time zone', 'YES'], ['started_at', 'timestamp with time zone', 'YES'],
    ['finished_at', 'timestamp with time zone', 'YES'], ['reason_code', 'text', 'YES'],
    ['created_at', 'timestamp with time zone', 'NO'], ['updated_at', 'timestamp with time zone', 'NO'],
  ].map(([column_name, data_type, is_nullable]) => ({ column_name, data_type, is_nullable }));
  const checks = [
    { columns: ['canonical_insurer_name'], definition: "CHECK ((btrim(canonical_insurer_name) <> ''::text))" },
    { columns: ['source'], definition: "CHECK ((source = ANY (ARRAY['schedule'::text, 'manual'::text, 'readiness'::text, 'recovery'::text])))" },
    { columns: ['request_scope'], definition: "CHECK ((request_scope = ANY (ARRAY['all_active'::text, 'single_insurer'::text])))" },
    { columns: ['disposition'], definition: "CHECK ((disposition = ANY (ARRAY['queued'::text, 'claimed'::text, 'covered_by_active_cycle'::text, 'follow_up_queued'::text, 'inactive'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))" },
    { columns: ['attempt_number'], definition: 'CHECK ((attempt_number >= 0))' },
    { columns: ['reason_code'], definition: "CHECK (((reason_code IS NULL) OR ((char_length(reason_code) <= 80) AND (reason_code ~ '^[a-z0-9._-]+$'::text))))" },
  ];
  const indexes = [
    { indexname: 'piles_auto_assignment_work_items_queued_generation_idx', is_unique: true, columns: ['canonical_insurer_name', 'source', 'request_scope'], predicate: "(disposition = 'queued'::text)" },
    { indexname: 'piles_auto_assignment_work_items_follow_up_idx', is_unique: true, columns: ['canonical_insurer_name'], predicate: "(disposition = 'follow_up_queued'::text)" },
    { indexname: 'piles_auto_assignment_work_items_claim_order_idx', is_unique: false, columns: ['parent_runner_run_id', 'disposition', 'generation_requested_at', 'requested_at', 'id'], predicate: "(disposition = ANY (ARRAY['queued'::text, 'follow_up_queued'::text]))" },
    { indexname: 'piles_auto_assignment_work_items_expired_lease_idx', is_unique: false, columns: ['lease_expires_at', 'canonical_insurer_name'], predicate: "(disposition = 'claimed'::text)" },
  ];
  const foreignKeys = [
    { column_name: 'parent_runner_run_id', referenced_table: 'piles_auto_assignment_runner_runs', referenced_column: 'id', delete_rule: 'SET NULL' },
    { column_name: 'covered_by_insurer_run_id', referenced_table: 'piles_auto_assignment_insurer_runs', referenced_column: 'id', delete_rule: 'SET NULL' },
  ];
  return {
    columns,
    constraints: [{ constraint_type: 'PRIMARY KEY', columns: ['id'] }],
    checks,
    indexes,
    foreignKeys,
  };
}

function evaluateDurableWork(overrides = {}) {
  const fixture = { ...durableWorkAuditFixture(), ...overrides };
  return evaluateTable('piles_auto_assignment_work_items', fixture.columns, fixture.constraints, fixture.checks, fixture.indexes, fixture.foreignKeys);
}

test('schema audit accepts the complete durable work-item contract', () => {
  assert.deepEqual(evaluateDurableWork(), []);
});

test('schema audit rejects missing work columns, primary key, and required nullability', () => {
  const fixture = durableWorkAuditFixture();
  assert.match(evaluateDurableWork({ columns: fixture.columns.filter((column) => column.column_name !== 'claim_token') }).join(';'), /missing column claim_token/);
  assert.match(evaluateDurableWork({ constraints: [] }).join(';'), /PRIMARY KEY.*id/i);
  assert.match(evaluateDurableWork({ columns: fixture.columns.map((column) => column.column_name === 'source' ? { ...column, is_nullable: 'YES' } : column) }).join(';'), /source.*NOT NULL/i);
});

test('schema audit binds exact accepted status sets to their status columns', () => {
  const runnerColumns = [
    { column_name: 'id', data_type: 'text' }, { column_name: 'status', data_type: 'text' },
    { column_name: 'created_at', data_type: 'timestamp with time zone' },
    { column_name: 'updated_at', data_type: 'timestamp with time zone' },
  ];
  const wrongStatus = "CHECK ((status = ANY (ARRAY['queued'::text, 'started'::text, 'running'::text, 'completed'::text, 'failed'::text, 'covered_by_active_cycle'::text, 'cancelled'::text, 'manual_action_required'::text, 'partial'::text, 'skipped_overlap'::text])))";
  const decoy = "CHECK ((phase = 'completed_with_issues'::text))";
  assert.match(evaluateTable('piles_auto_assignment_runner_runs', runnerColumns, [], [
    { columns: ['status'], definition: wrongStatus },
    { columns: ['phase'], definition: decoy },
  ]).join(';'), /status CHECK.*completed_with_issues/i);

  const invertedStatus = "CHECK ((status <> ALL (ARRAY['queued'::text, 'started'::text, 'running'::text, 'completed'::text, 'completed_with_issues'::text, 'failed'::text, 'covered_by_active_cycle'::text, 'cancelled'::text, 'manual_action_required'::text, 'partial'::text, 'skipped_overlap'::text])))";
  assert.match(evaluateTable('piles_auto_assignment_runner_runs', runnerColumns, [], [
    { columns: ['status'], definition: invertedStatus },
  ]).join(';'), /status CHECK/i);

  const fixture = durableWorkAuditFixture();
  const wrongDisposition = fixture.checks.map((check) => check.columns.includes('disposition')
    ? { ...check, definition: check.definition.replace("'cancelled'::text", "'cancelled_wrong'::text") }
    : check);
  assert.match(evaluateDurableWork({ checks: wrongDisposition }).join(';'), /disposition CHECK/i);
});

test('schema audit rejects weakened canonical, attempt, and reason checks', () => {
  const fixture = durableWorkAuditFixture();
  const replaceCheck = (column, definition) => fixture.checks.map((check) => check.columns.includes(column) ? { ...check, definition } : check);
  assert.match(evaluateDurableWork({ checks: replaceCheck('canonical_insurer_name', 'CHECK (canonical_insurer_name IS NOT NULL)') }).join(';'), /canonical_insurer_name CHECK/i);
  assert.match(evaluateDurableWork({ checks: replaceCheck('canonical_insurer_name', "CHECK ((btrim(canonical_insurer_name) <> '') OR true)") }).join(';'), /canonical_insurer_name CHECK/i);
  assert.match(evaluateDurableWork({ checks: replaceCheck('attempt_number', 'CHECK (attempt_number >= -1)') }).join(';'), /attempt_number CHECK/i);
  assert.match(evaluateDurableWork({ checks: replaceCheck('attempt_number', 'CHECK ((attempt_number >= 0) OR true)') }).join(';'), /attempt_number CHECK/i);
  assert.match(evaluateDurableWork({ checks: replaceCheck('reason_code', "CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9._-]+$')") }).join(';'), /reason_code CHECK/i);
  assert.match(evaluateDurableWork({ checks: replaceCheck('reason_code', "CHECK ((reason_code IS NULL) OR ((char_length(reason_code) <= 80) AND (reason_code ~ '^[a-z0-9._-]+$')) OR true)") }).join(';'), /reason_code CHECK/i);
});

test('schema audit rejects altered work index uniqueness, keys, and predicates', () => {
  const fixture = durableWorkAuditFixture();
  const replaceIndex = (name, patch) => fixture.indexes.map((index) => index.indexname === name ? { ...index, ...patch } : index);
  const queuedName = 'piles_auto_assignment_work_items_queued_generation_idx';
  assert.match(evaluateDurableWork({ indexes: replaceIndex(queuedName, { is_unique: false }) }).join(';'), /queued_generation_idx.*UNIQUE/i);
  assert.match(evaluateDurableWork({ indexes: replaceIndex(queuedName, { columns: ['source', 'canonical_insurer_name', 'request_scope'] }) }).join(';'), /queued_generation_idx.*key columns/i);
  assert.match(evaluateDurableWork({ indexes: replaceIndex(queuedName, { predicate: "(disposition <> 'queued'::text)" }) }).join(';'), /queued_generation_idx.*predicate/i);
});

test('schema audit preserves quoted identifier case in index keys', () => {
  const fixture = durableWorkAuditFixture();
  const indexes = fixture.indexes.map((index) => (
    index.indexname === 'piles_auto_assignment_work_items_queued_generation_idx'
      ? { ...index, columns: ['"CANONICAL_INSURER_NAME"', 'source', 'request_scope'] }
      : index
  ));
  assert.match(evaluateDurableWork({ indexes }).join(';'), /queued_generation_idx.*key columns/i);
});

test('schema audit preserves case-sensitive regex literals', () => {
  const fixture = durableWorkAuditFixture();
  const checks = fixture.checks.map((check) => (
    check.columns.includes('reason_code')
      ? { ...check, definition: check.definition.replace('[a-z0-9', '[A-Z0-9') }
      : check
  ));
  assert.match(evaluateDurableWork({ checks }).join(';'), /reason_code CHECK/i);
});

test('schema audit rejects a foreign key that targets the wrong parent column', () => {
  const fixture = durableWorkAuditFixture();
  const foreignKeys = fixture.foreignKeys.map((key) => key.column_name === 'parent_runner_run_id' ? { ...key, referenced_column: 'status' } : key);
  assert.match(evaluateDurableWork({ foreignKeys }).join(';'), /parent_runner_run_id.*\.id/i);
});

test('fresh migration bootstrap emits the durable table after its parents and all queue indexes', () => {
  const sql = buildFreshSchemaSql('migration_backup_test');
  const position = (table) => sql.indexOf(`CREATE TABLE ${table}`);
  for (const [parent, child] of [
    ['piles_auto_assignment_master_accounts', 'piles_auto_assignment_bot_accounts'],
    ['piles_auto_assignment_master_accounts', 'piles_auto_assignment_rules'],
    ['piles_auto_assignment_bot_accounts', 'piles_auto_assignment_bot_metrics'],
    ['piles_auto_assignment_runner_runs', 'piles_auto_assignment_insurer_runs'],
    ['piles_auto_assignment_insurer_runs', 'piles_auto_assignment_scan_contexts'],
    ['piles_auto_assignment_scan_contexts', 'piles_auto_assignment_batches'],
    ['piles_auto_assignment_tracked_piles', 'piles_auto_assignment_pile_snapshots'],
    ['piles_auto_assignment_batches', 'piles_auto_assignment_attempts'],
    ['piles_auto_assignment_runner_runs', 'piles_auto_assignment_work_items'],
    ['piles_auto_assignment_insurer_runs', 'piles_auto_assignment_work_items'],
  ]) {
    assert.ok(position(parent) >= 0 && position(parent) < position(child), `${parent} must precede ${child}`);
  }
  for (const index of [
    'piles_auto_assignment_work_items_queued_generation_idx',
    'piles_auto_assignment_work_items_follow_up_idx',
    'piles_auto_assignment_work_items_claim_order_idx',
    'piles_auto_assignment_work_items_expired_lease_idx',
  ]) {
    assert.match(sql, new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}`));
  }
});

test('readiness queue health distinguishes warnings from unsafe incident state', () => {
  const findings = {
    queuedWithoutLiveWorker: 3,
    expiredLeases: 2,
    expiredLeasesWithFreeLock: 1,
    duplicateActiveCanonicalInsurers: 1,
    legacyPendingRows: 4,
  };
  const deployment = evaluateQueueHealth(findings, { deploymentMode: true });
  assert.equal(deployment.every((item) => item.ok), true);
  assert.equal(deployment.every((item) => item.severity === 'warning'), true);

  const incident = evaluateQueueHealth(findings, { deploymentMode: false });
  assert.equal(incident.find((item) => item.name === 'expired work with free insurer lock').ok, false);
  assert.equal(incident.find((item) => item.name === 'duplicate active canonical insurers').ok, false);
  assert.equal(incident.find((item) => item.name === 'queued work without a live worker').ok, true);
  assert.equal(incident.find((item) => item.name === 'legacy pending requests').ok, true);
});

test('readiness queue inspection probes expired insurer locks and releases acquired probes', async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      if (/queued_without_live_worker/i.test(text)) return { rows: [{ queued_without_live_worker: 2 }] };
      if (/duplicate_active_canonical_insurers/i.test(text)) return { rows: [{ duplicate_active_canonical_insurers: 0 }] };
      if (/legacy_pending_rows/i.test(text)) return { rows: [{ legacy_pending_rows: 1 }] };
      if (/select canonical_insurer_name, count\(\*\).*expired_lease_count/i.test(text)) {
        return { rows: [
          { canonical_insurer_name: 'jubilee uganda', expired_lease_count: 3 },
          { canonical_insurer_name: 'defmis', expired_lease_count: 2 },
        ] };
      }
      if (/pg_try_advisory_lock/i.test(text)) return { rows: [{ acquired: values[0].includes('jubilee uganda') }] };
      if (/pg_advisory_unlock/i.test(text)) return { rows: [{ released: true }] };
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  const findings = await inspectQueueHealth(pool);
  assert.deepEqual(findings, {
    queuedWithoutLiveWorker: 2,
    expiredLeases: 5,
    expiredLeasesWithFreeLock: 3,
    duplicateActiveCanonicalInsurers: 0,
    legacyPendingRows: 1,
  });
  assert.equal(calls.filter(({ text }) => /pg_try_advisory_lock/i.test(text)).length, 2);
  assert.equal(calls.filter(({ text }) => /pg_advisory_unlock/i.test(text)).length, 1);
  assert.ok(calls.every(({ text }) => !/\b(insert|update|delete|alter|drop|truncate)\b/i.test(text)));
});

test('deployment audit separates repair deployment from runtime incident gates', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const readiness = readFileSync(new URL('../scripts/audit-piles-auto-assignment-readiness.mjs', import.meta.url), 'utf8');

  assert.match(workflow, /audit-piles-auto-assignment-readiness\.mjs --mode deployment/);
  assert.match(readiness, /const deploymentMode = modeArg === 'deployment'/);
  assert.match(readiness, /deploymentMode \|\| stale\.rows\[0\]\.count === 0/);
  assert.match(readiness, /deploymentMode \|\| pending\.rows\[0\]\.count === 0/);
});

test('recovery modules can be imported without database access or process exit', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "await import('./scripts/recover-piles-stale-runs.mjs'); console.log('imported')"],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imported');
});

// The database is the external boundary: record real emitted statements and
// provide explicit evidence per statement, never a generic successful UPDATE.
function recoveryDatabase(responses = {}) {
  const calls = [];
  return {
    calls,
    async query(query, values = []) {
      const call = typeof query === 'string' ? { text: query, values } : query;
      calls.push(call);
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(call.text)) return { rows: [], rowCount: 0 };
      assert.ok(Object.hasOwn(responses, call.name), `Unexpected statement: ${call.name}`);
      const response = responses[call.name];
      if (response instanceof Error) throw response;
      const rows = typeof response === 'function' ? await response(call) : response;
      return { rows, rowCount: rows.length };
    },
  };
}

const workRecoveryArgs = ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--work-id', 'work-1', '--claim-token', 'token-1'];
const legacyApplyArgs = ['--apply', '--confirmation', 'CANCEL_OBSOLETE_LEGACY_REQUESTS', '--request-id', 'legacy-1'];

function expiredWorkResponses(overrides = {}) {
  return {
    'recovery-work-snapshot': [{ id: 'work-1', parent_runner_run_id: 'parent-1', insurer_name: 'UAPOM', canonical_insurer_name: 'OLD MUTUAL' }],
    'recovery-parent-lock': [{ id: 'parent-1', status: 'started', details: {} }],
    'recovery-dispatch-lock': [{ acquired: true }],
    'recovery-work-lock': [{ id: 'work-1', parent_runner_run_id: 'parent-1', insurer_name: 'UAPOM', canonical_insurer_name: 'OLD MUTUAL', claim_token: 'token-1', disposition: 'claimed', covered_by_insurer_run_id: null, started_at: null }],
    'recovery-insurer-lock': [{ acquired: true }],
    'recovery-work-evidence': [{ eligible: true }],
    'recovery-work-update': [{ id: 'work-1' }],
    ...overrides,
  };
}

test('recovery validates exact confirmation and one precise target before database use', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  for (const args of [
    ['--apply'], ['--apply', '--confirmation', 'RECOVER_STALE_RUNS'],
    workRecoveryArgs.slice(0, -2), [...workRecoveryArgs, '--parent-run-id', 'parent-1'],
    workRecoveryArgs.map((s) => s === 'RECOVER_STALE_RUNS' ? 'recover_stale_runs' : s),
    ['--confirmation', 'RECOVER_STALE_RUNS'], ['--execute'],
    [...workRecoveryArgs, '--apply'], ['--work-id', "x'; UPDATE secrets"],
  ]) {
    const db = recoveryDatabase();
    await assert.rejects(runRecovery(db, args), /arguments|confirmation|target/i);
    assert.deepEqual(db.calls, []);
  }
});

test('recovery default inspects leases and stale insurers in a read-only rolled-back transaction', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  const db = recoveryDatabase({
    'recovery-inspect': [{ insurer_name: 'UAPOM', stale_insurer_runs: 2, expired_work_leases: 3, raw: 'password=<secret>' }],
    'recovery-insurer-lock': [{ acquired: false }],
  });
  assert.deepEqual(await runRecovery(db), {
    mode: 'inspect', stale_insurer_runs: 2, expired_work_leases: 3, lock_held: 1,
  });
  assert.equal(db.calls[0].text, 'BEGIN READ ONLY');
  assert.equal(db.calls.at(-1).text, 'ROLLBACK');
  assert.ok(db.calls.every(({ text }) => !/\b(UPDATE|DELETE|INSERT|FOR UPDATE)\b/i.test(text)));
  assert.deepEqual(db.calls[2].values, ['piles-insurer:OLD MUTUAL']);
});

test('recovery fences the exact token after row locks and fresh evidence before requeue', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  const db = recoveryDatabase(expiredWorkResponses());
  assert.deepEqual(await runRecovery(db, workRecoveryArgs), {
    mode: 'recover', work_requeued: 1, insurer_runs_recovered: 0, parent_runs_repaired: 0, blocked: 0,
  });
  const names = db.calls.map(({ name }) => name);
  assert.ok(names.indexOf('recovery-work-lock') < names.indexOf('recovery-insurer-lock'));
  assert.ok(names.indexOf('recovery-insurer-lock') < names.indexOf('recovery-work-evidence'));
  const lock = db.calls.find(({ name }) => name === 'recovery-work-lock');
  assert.deepEqual(lock.values, ['work-1', 'token-1']);
  assert.match(lock.text, /FOR UPDATE/i);
  const evidence = db.calls.find(({ name }) => name === 'recovery-work-evidence');
  assert.match(evidence.text, /clock_timestamp\(\)/);
  assert.match(evidence.text, /lease_expires_at/);
  assert.match(evidence.text, /heartbeat_at/);
  assert.match(evidence.text, /piles_auto_assignment_attempts/);
  assert.match(evidence.text, /piles_auto_assignment_batches/);
  const update = db.calls.find(({ name }) => name === 'recovery-work-update');
  assert.deepEqual(update.values, ['work-1', 'token-1']);
  for (const column of ['worker_id', 'claim_token', 'lease_expires_at', 'heartbeat_at', 'claimed_at', 'started_at', 'finished_at', 'covered_by_insurer_run_id']) {
    assert.match(update.text, new RegExp(`${column} = NULL`, 'i'));
  }
  assert.match(update.text, /attempt_number = attempt_number \+ 1/);
  assert.equal(db.calls.at(-1).text, 'COMMIT');
});

test('recovery refuses replaced tokens, held locks, fresh or unsafe evidence without mutation', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  for (const overrides of [
    { 'recovery-parent-lock': [{ status: 'completed' }] },
    { 'recovery-dispatch-lock': [{ acquired: false }] },
    { 'recovery-work-lock': [] },
    { 'recovery-insurer-lock': [{ acquired: false }] },
    { 'recovery-work-evidence': [{ eligible: false }] },
  ]) {
    const db = recoveryDatabase(expiredWorkResponses(overrides));
    assert.equal((await runRecovery(db, workRecoveryArgs)).blocked, 1);
    assert.equal(db.calls.at(-1).text, 'ROLLBACK');
    assert.ok(db.calls.every(({ text }) => !/^\s*UPDATE/i.test(text)));
  }
});

test('recovery rolls back driver errors and missing guarded update results', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  for (const response of [new Error('sensitive driver data'), []]) {
    const db = recoveryDatabase(expiredWorkResponses({ 'recovery-work-update': response }));
    await assert.rejects(runRecovery(db, workRecoveryArgs));
    assert.equal(db.calls.at(-1).text, 'ROLLBACK');
  }
  const db = recoveryDatabase({ 'recovery-inspect': new Error('sensitive driver data') });
  await assert.rejects(runRecovery(db));
  assert.equal(db.calls.at(-1).text, 'ROLLBACK');
});

test('legacy cancellation rejects wrong confirmation and defaults to a read-only aggregate audit', async () => {
  const { runLegacyAudit } = await import('../scripts/audit-piles-legacy-requests.mjs');
  for (const args of [['--apply'], ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--request-id', 'legacy-1'], ['--confirmation', 'CANCEL_OBSOLETE_LEGACY_REQUESTS'], legacyApplyArgs.slice(0, -2)]) {
    const db = recoveryDatabase();
    await assert.rejects(runLegacyAudit(db, args), /arguments|confirmation|target/i);
    assert.deepEqual(db.calls, []);
  }
  const db = recoveryDatabase({ 'legacy-inspect': [{ pending_requests: 4, obsolete_requests: 1, secret: 'hidden' }] });
  assert.deepEqual(await runLegacyAudit(db), { mode: 'inspect', pending_requests: 4, obsolete_requests: 1 });
  assert.equal(db.calls[0].text, 'BEGIN READ ONLY');
  assert.equal(db.calls.at(-1).text, 'ROLLBACK');
  assert.ok(db.calls.every(({ text }) => !/\b(UPDATE|DELETE|INSERT)\b/i.test(text)));
});

test('legacy cancellation locks the owner and exact pending row then checks lock and obsolescence', async () => {
  const { runLegacyAudit } = await import('../scripts/audit-piles-legacy-requests.mjs');
  const fixture = {
    'legacy-snapshot': [{ requested_runner_run_id: 'owner-1', insurer_name: 'old mutual' }],
    'recovery-parent-lock': [{ id: 'owner-1', status: 'skipped_overlap', details: {} }],
    'recovery-dispatch-lock': [{ acquired: true }],
    'legacy-request-lock': [{ id: 'legacy-1', requested_runner_run_id: 'owner-1', insurer_name: 'old mutual', status: 'pending', claimed_by_runner_run_id: null }],
    'recovery-insurer-lock': [{ acquired: true }],
    'legacy-evidence': [{ eligible: true }],
    'legacy-cancel': [{ id: 'legacy-1' }],
  };
  const db = recoveryDatabase(fixture);
  assert.deepEqual(await runLegacyAudit(db, legacyApplyArgs), { mode: 'apply', cancelled_requests: 1, blocked: 0 });
  const mutation = db.calls.find(({ name }) => name === 'legacy-cancel');
  assert.deepEqual(mutation.values, ['legacy-1', 'owner-1']);
  assert.match(mutation.text, /status = 'pending'/);
  assert.match(mutation.text, /status = 'cancelled_legacy'/);
  assert.deepEqual(db.calls.filter(({ text }) => /^\s*UPDATE/i.test(text)), [mutation]);
  assert.equal(db.calls.at(-1).text, 'COMMIT');
  for (const override of [
    { 'legacy-snapshot': [{ requested_runner_run_id: null }] },
    { 'recovery-parent-lock': [{ status: 'running' }] },
    { 'legacy-request-lock': [] },
    { 'recovery-insurer-lock': [{ acquired: false }] },
    { 'legacy-evidence': [{ eligible: false }] },
  ]) {
    const refused = recoveryDatabase({ ...fixture, ...override });
    assert.equal((await runLegacyAudit(refused, legacyApplyArgs)).blocked, 1);
    assert.equal(refused.calls.at(-1).text, 'ROLLBACK');
    assert.ok(refused.calls.every(({ text }) => !/^\s*UPDATE/i.test(text)));
  }
  const broken = recoveryDatabase({ ...fixture, 'legacy-cancel': new Error('sensitive') });
  await assert.rejects(runLegacyAudit(broken, legacyApplyArgs));
  assert.equal(broken.calls.at(-1).text, 'ROLLBACK');
});

test('stale insurer recovery checks fresh heartbeat and pending evidence before terminalizing', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  const args = ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--insurer-run-id', 'run-1'];
  const fixture = {
    'recovery-run-snapshot': [{ id: 'run-1', runner_run_id: 'parent-1', insurer_name: 'DEFMIS' }],
    'recovery-parent-lock': [{ status: 'started', details: {} }],
    'recovery-dispatch-lock': [{ acquired: true }],
    'recovery-run-lock': [{ id: 'run-1', runner_run_id: 'parent-1', insurer_name: 'DEFMIS', status: 'running' }],
    'recovery-insurer-lock': [{ acquired: true }],
    'recovery-run-evidence': [{ eligible: true }],
    'recovery-run-update': [{ id: 'run-1' }],
  };
  const db = recoveryDatabase(fixture);
  assert.equal((await runRecovery(db, args)).insurer_runs_recovered, 1);
  assert.equal(db.calls.at(-1).text, 'COMMIT');
  const held = recoveryDatabase({ ...fixture, 'recovery-insurer-lock': [{ acquired: false }] });
  assert.equal((await runRecovery(held, args)).blocked, 1);
  const fresh = recoveryDatabase({ ...fixture, 'recovery-run-evidence': [{ eligible: false }] });
  assert.equal((await runRecovery(fresh, args)).blocked, 1);
  assert.ok(fresh.calls.every(({ text }) => !/^\s*UPDATE/i.test(text)));
});

function parentRecoveryResponses({ work = [], children = [], references = [], referenced = [] } = {}) {
  return {
    'recovery-parent-lock': [{ id: 'parent-1', status: 'started', details: { dispatch_requests: references } }],
    'recovery-parent-insurers': [],
    'recovery-parent-work': work,
    'recovery-parent-children': children,
    'recovery-parent-references': referenced,
    'recovery-parent-pending-evidence': [{ pending: false }],
    'recovery-parent-update': [{ id: 'parent-1' }],
  };
}

test('parent repair waits for owned work, active children, and unresolved foreign references', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  const args = ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--parent-run-id', 'parent-1'];
  for (const evidence of [
    { work: [{ disposition: 'queued' }] }, { work: [{ disposition: 'claimed' }] },
    { work: [{ disposition: 'follow_up_queued' }] }, { children: [{ status: 'running' }] },
    { children: [{ status: 'queued' }] },
    { references: [{ request_id: 'request-1', work_item_id: 'foreign-1', disposition: 'follow_up_queued' }], referenced: [{ id: 'foreign-1', disposition: 'claimed' }] },
    { references: [{ request_id: 'request-1', work_item_id: 'missing-1', disposition: 'queued' }] },
  ]) {
    const db = recoveryDatabase(parentRecoveryResponses(evidence));
    assert.equal((await runRecovery(db, args)).blocked, 1);
    assert.ok(db.calls.every(({ text }) => !/^\s*UPDATE/i.test(text)));
    assert.equal(db.calls.at(-1).text, 'ROLLBACK');
  }
});

test('parent repair derives owned outcomes and never counts foreign failed work as owned execution', async () => {
  const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
  const args = ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--parent-run-id', 'parent-1'];
  for (const [evidence, expected] of [
    [{ work: [{ disposition: 'completed' }], children: [{ status: 'completed' }] }, 'completed'],
    [{ work: [{ disposition: 'completed' }], children: [{ status: 'completed', aggregate_outcome: true }, { status: 'failed', aggregate_outcome: false }] }, 'completed'],
    [{ work: [{ disposition: 'completed' }, { disposition: 'failed' }] }, 'completed_with_issues'],
    [{ children: [{ status: 'partial' }] }, 'completed_with_issues'],
    [{ children: [{ status: 'manual_action_required' }] }, 'completed_with_issues'],
    [{ work: [{ disposition: 'covered_by_active_cycle' }, { disposition: 'failed' }] }, 'failed'],
    [{ work: [{ disposition: 'cancelled' }] }, 'cancelled'],
    [{ references: [{ request_id: 'request-1', work_item_id: 'foreign-1', disposition: 'follow_up_queued' }], referenced: [{ id: 'foreign-1', disposition: 'failed' }] }, 'covered_by_active_cycle'],
  ]) {
    const db = recoveryDatabase(parentRecoveryResponses(evidence));
    assert.equal((await runRecovery(db, args)).parent_runs_repaired, 1);
    assert.deepEqual(db.calls.find(({ name }) => name === 'recovery-parent-update').values, ['parent-1', expected]);
    assert.equal(db.calls.at(-1).text, 'COMMIT');
  }
  // No children/work/references is absence of outcome evidence, not success.
  const empty = recoveryDatabase(parentRecoveryResponses());
  assert.equal((await runRecovery(empty, args)).blocked, 1);
});

test('recovery workflow executes only the selected action and rejects mixed or unconfirmed mutation inputs', () => {
  const workflow = parseYamlWithRuby(readFileSync(new URL('../.github/workflows/piles-stale-run-recovery.yml', import.meta.url), 'utf8'));
  const inputs = (workflow.on || workflow.true).workflow_dispatch.inputs;
  assert.equal(inputs.action.default, 'inspect');
  assert.deepEqual(inputs.action.options, ['inspect', 'recover', 'legacy-audit', 'legacy-apply']);
  const script = workflow.jobs.recover.steps.find((step) => step.with?.script).with.script;
  const directory = mkdtempSync(join(tmpdir(), 'piles-recovery-workflow-'));
  try {
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=fixture-do-not-contact\n');
    writeFileSync(join(directory, 'node'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const base = Object.fromEntries(['ACTION', 'CONFIRMATION', 'WORK_ID', 'CLAIM_TOKEN', 'INSURER_RUN_ID', 'PARENT_RUN_ID', 'REQUEST_ID'].map((key) => [`RECOVERY_${key}`, '']));
    const run = (values) => spawnSync('/bin/sh', ['-c', script.replace('cd ~/claims-dashboard', `cd '${directory}'`)], {
      env: { ...base, ...values, PATH: directory }, encoding: 'utf8', timeout: 5000,
    });
    for (const [values, expected] of [
      [{ RECOVERY_ACTION: 'inspect' }, ['scripts/recover-piles-stale-runs.mjs']],
      [{ RECOVERY_ACTION: 'legacy-audit' }, ['scripts/audit-piles-legacy-requests.mjs']],
      [{ RECOVERY_ACTION: 'recover', RECOVERY_WORK_ID: 'w-1', RECOVERY_CLAIM_TOKEN: 't-1', RECOVERY_CONFIRMATION: 'RECOVER_STALE_RUNS' }, ['scripts/recover-piles-stale-runs.mjs', '--work-id', 'w-1', '--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--claim-token', 't-1']],
      [{ RECOVERY_ACTION: 'legacy-apply', RECOVERY_REQUEST_ID: 'r-1', RECOVERY_CONFIRMATION: 'CANCEL_OBSOLETE_LEGACY_REQUESTS' }, ['scripts/audit-piles-legacy-requests.mjs', '--request-id', 'r-1', '--apply', '--confirmation', 'CANCEL_OBSOLETE_LEGACY_REQUESTS']],
    ]) {
      const result = run(values);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
    for (const values of [
      { RECOVERY_ACTION: 'unknown' }, { RECOVERY_ACTION: 'recover' },
      { RECOVERY_ACTION: 'inspect', RECOVERY_CONFIRMATION: 'RECOVER_STALE_RUNS' },
      { RECOVERY_ACTION: 'inspect', RECOVERY_CLAIM_TOKEN: 'token' },
      { RECOVERY_ACTION: 'recover', RECOVERY_WORK_ID: 'w', RECOVERY_CONFIRMATION: 'RECOVER_STALE_RUNS' },
      { RECOVERY_ACTION: 'recover', RECOVERY_PARENT_RUN_ID: 'p', RECOVERY_INSURER_RUN_ID: 'i', RECOVERY_CONFIRMATION: 'RECOVER_STALE_RUNS' },
      { RECOVERY_ACTION: 'legacy-apply', RECOVERY_REQUEST_ID: 'r', RECOVERY_CONFIRMATION: 'RECOVER_STALE_RUNS' },
      { RECOVERY_ACTION: 'legacy-audit', RECOVERY_REQUEST_ID: 'r', RECOVERY_WORK_ID: 'w' },
    ]) {
      const result = run(values);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
    }
  } finally { rmSync(directory, { recursive: true }); }
});

test('recovery CLI errors never print adversarial arguments or database diagnostics', () => {
  for (const script of ['recover-piles-stale-runs.mjs', 'audit-piles-legacy-requests.mjs']) {
    const result = spawnSync(process.execPath, [`scripts/${script}`, '--apply', '--confirmation', 'password=<sensitive>'], {
      cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://secret@invalid' }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /sensitive|secret@invalid|password=/);
  }
});

test('workflow validates identifiers before SSH interpolation and masks the claim token', () => {
  const workflow = parseYamlWithRuby(readFileSync(new URL('../.github/workflows/piles-stale-run-recovery.yml', import.meta.url), 'utf8'));
  const validation = workflow.jobs.recover.steps[0];
  assert.equal(typeof validation.run, 'string', 'Inputs must be validated before the SSH action sees them');
  const base = Object.fromEntries(['ACTION', 'CONFIRMATION', 'WORK_ID', 'CLAIM_TOKEN', 'INSURER_RUN_ID', 'PARENT_RUN_ID', 'REQUEST_ID'].map((key) => [`RECOVERY_${key}`, '']));
  for (const value of ["x'; echo injected", 'x\ny', 'a'.repeat(201), '$(echo injected)']) {
    const result = spawnSync('/bin/bash', ['-c', validation.run], { env: { ...base, RECOVERY_ACTION: 'inspect', RECOVERY_WORK_ID: value }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /injected|x';/);
  }
  const masked = spawnSync('/bin/bash', ['-c', validation.run], { env: { ...base, RECOVERY_ACTION: 'recover', RECOVERY_CONFIRMATION: 'RECOVER_STALE_RUNS', RECOVERY_WORK_ID: 'work-1', RECOVERY_CLAIM_TOKEN: 'token-1' }, encoding: 'utf8' });
  assert.equal(masked.status, 0, masked.stderr);
  assert.equal(masked.stdout.trim(), '::add-mask::token-1');
});

// Opt-in real PostgreSQL gate, intentionally absent from offline discovery.
// Only the known private disposable Unix socket is accepted; never a URL/host.
if (process.env.PILES_RECOVERY_TEST_SOCKET) {
  test('guarded recovery executes real PostgreSQL predicates, CAS and row-wait races', async (t) => {
    assert.equal(process.env.PILES_RECOVERY_TEST_SOCKET, '/private/tmp/piles-store-task4.1tOoNJ');
    const { default: pg } = await import('pg');
    const { runRecovery } = await import('../scripts/recover-piles-stale-runs.mjs');
    const { runLegacyAudit } = await import('../scripts/audit-piles-legacy-requests.mjs');
    const config = { host: process.env.PILES_RECOVERY_TEST_SOCKET, port: 55434, database: 'task4_final', user: 'sam' };
    const clients = [];
    const connect = async () => { const client = new pg.Client(config); await client.connect(); clients.push(client); return client; };
    const db = await connect();
    const other = await connect();
    const prefix = `t12-${randomUUID()}`;
    let sequence = 0;
    const identity = () => `${prefix}-${++sequence}`;
    const parent = async (status = 'started') => {
      const id = identity();
      await db.query(`INSERT INTO piles_auto_assignment_runner_runs (id, status, run_scope, run_source, mode, finished_at)
        VALUES ($1, $2, 'all-active', 'schedule', 'execute', CASE WHEN $2 <> 'started' THEN clock_timestamp() ELSE NULL END)`, [id, status]);
      return id;
    };
    const run = async (owner, insurer, status = 'running') => {
      const id = identity();
      await db.query(`INSERT INTO piles_auto_assignment_insurer_runs (id, runner_run_id, insurer_name, status, heartbeat_at, started_at, finished_at)
        VALUES ($1, $2, $3, $4, clock_timestamp() - interval '20 minutes', clock_timestamp() - interval '20 minutes',
          CASE WHEN $4 = 'completed' THEN clock_timestamp() ELSE NULL END)`, [id, owner, insurer, status]);
      return id;
    };
    const work = async () => {
      const owner = await parent(); const id = identity(); const insurer = identity(); const token = identity();
      await db.query(`INSERT INTO piles_auto_assignment_work_items
        (id, parent_runner_run_id, insurer_name, canonical_insurer_name, source, request_scope, disposition,
          claim_token, worker_id, attempt_number, lease_expires_at, heartbeat_at, claimed_at)
        VALUES ($1, $2, $3, $3, 'schedule', 'all_active', 'claimed', $4, 'worker', 4,
          clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '20 minutes', clock_timestamp() - interval '20 minutes')`, [id, owner, insurer, token]);
      return { id, owner, insurer, token, args: ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--work-id', id, '--claim-token', token] };
    };
    const batch = async (runId, insurer, status) => {
      const id = identity();
      await db.query(`INSERT INTO piles_auto_assignment_batches
        (id, insurer_run_id, insurer_name, intended_owner_name, intended_portal_assignee, assignment_type, status_bucket, status)
        VALUES ($1, $2, $3, 'fixture', 'fixture', 'primary', 'fixture', $4)`, [id, runId, insurer, status]);
      return id;
    };
    const repairArgs = (id) => ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--parent-run-id', id];
    try {
      await t.test('inspect is read-only and exact-token recovery clears ownership and preserves generation', async () => {
        const item = await work();
        const before = (await db.query('SELECT * FROM piles_auto_assignment_work_items WHERE id = $1', [item.id])).rows[0];
        assert.equal((await runRecovery(db, ['--work-id', item.id])).expired_work_leases, 1);
        assert.deepEqual((await db.query('SELECT * FROM piles_auto_assignment_work_items WHERE id = $1', [item.id])).rows[0], before);
        assert.equal((await runRecovery(db, item.args)).work_requeued, 1);
        const after = (await db.query('SELECT * FROM piles_auto_assignment_work_items WHERE id = $1', [item.id])).rows[0];
        assert.equal(after.disposition, 'queued'); assert.equal(after.attempt_number, 5);
        for (const field of ['worker_id', 'claim_token', 'heartbeat_at', 'lease_expires_at', 'claimed_at', 'started_at', 'finished_at', 'covered_by_insurer_run_id']) assert.equal(after[field], null);
        for (const field of ['parent_runner_run_id', 'source', 'requested_at', 'generation_requested_at']) assert.deepEqual(after[field], before[field]);
        assert.equal((await runRecovery(db, item.args)).blocked, 1);
      });
      await t.test('held insurer lock, renewed lease, fresh heartbeat and replaced token each prevent recovery', async () => {
        const item = await work();
        await other.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`piles-insurer:${item.insurer}`]);
        assert.equal((await runRecovery(db, item.args)).blocked, 1);
        await other.query('SELECT pg_advisory_unlock_all()');
        for (const assignment of ["lease_expires_at = clock_timestamp() + interval '5 minutes'", 'heartbeat_at = clock_timestamp()', "claim_token = 'replacement'"]) {
          const candidate = await work();
          await db.query(`UPDATE piles_auto_assignment_work_items SET ${assignment} WHERE id = $1`, [candidate.id]);
          assert.equal((await runRecovery(db, candidate.args)).blocked, 1);
        }
      });
      await t.test('running work recovers its stale owned child atomically', async () => {
        const item = await work(); const child = await run(item.owner, item.insurer);
        await db.query('UPDATE piles_auto_assignment_work_items SET covered_by_insurer_run_id = $2, started_at = heartbeat_at WHERE id = $1', [item.id, child]);
        const result = await runRecovery(db, item.args);
        assert.equal(result.work_requeued, 1); assert.equal(result.insurer_runs_recovered, 1);
        assert.equal((await db.query('SELECT status FROM piles_auto_assignment_insurer_runs WHERE id = $1', [child])).rows[0].status, 'failed');
      });
      await t.test('a failure after child finalization rolls back both child and work transitions', async () => {
        const item = await work(); const child = await run(item.owner, item.insurer);
        await db.query('UPDATE piles_auto_assignment_work_items SET covered_by_insurer_run_id = $2, started_at = heartbeat_at WHERE id = $1', [item.id, child]);
        const failingBoundary = { query(query, values) {
          if (query?.name === 'recovery-work-update') throw new Error('Injected database write failure');
          return db.query(query, values);
        } };
        await assert.rejects(runRecovery(failingBoundary, item.args));
        assert.equal((await db.query('SELECT status FROM piles_auto_assignment_insurer_runs WHERE id = $1', [child])).rows[0].status, 'running');
        assert.equal((await db.query('SELECT disposition FROM piles_auto_assignment_work_items WHERE id = $1', [item.id])).rows[0].disposition, 'claimed');
      });
      await t.test('submission and reconciliation evidence, including stale run counters, is never replayed or changed', async () => {
        for (const evidence of ['attempt', 'batch', 'counter']) {
          const item = await work(); const child = await run(item.owner, item.insurer);
          await db.query('UPDATE piles_auto_assignment_work_items SET covered_by_insurer_run_id = $2, started_at = heartbeat_at WHERE id = $1', [item.id, child]);
          const batchId = await batch(child, item.insurer, evidence === 'batch' ? 'reconciliation_pending' : 'planned');
          if (evidence === 'attempt') await db.query(`INSERT INTO piles_auto_assignment_attempts
            (id, batch_id, insurer_run_id, insurer_name, tracking_key, intended_owner_name, intended_portal_assignee, status, submitted_at)
            VALUES ($1, $2, $3, $4, 'synthetic-never-log', 'fixture', 'fixture', 'submitted', clock_timestamp())`, [identity(), batchId, child, item.insurer]);
          if (evidence === 'counter') await db.query('UPDATE piles_auto_assignment_insurer_runs SET submitted_pile_count = 1 WHERE id = $1', [child]);
          const before = (await db.query('SELECT * FROM piles_auto_assignment_work_items WHERE id = $1', [item.id])).rows[0];
          assert.equal((await runRecovery(db, item.args)).blocked, 1);
          assert.deepEqual((await db.query('SELECT * FROM piles_auto_assignment_work_items WHERE id = $1', [item.id])).rows[0], before);
        }
      });
      await t.test('a later queued generation prevents an unsafe requeue/index collision', async () => {
        const item = await work(); const owner = await parent();
        await db.query(`INSERT INTO piles_auto_assignment_work_items (id, parent_runner_run_id, insurer_name, canonical_insurer_name, source, request_scope)
          VALUES ($1, $2, $3, $3, 'schedule', 'all_active')`, [identity(), owner, item.insurer]);
        assert.equal((await runRecovery(db, item.args)).blocked, 1);
      });
      await t.test('post-row-wait evidence observes a renewed heartbeat and replaced token', async () => {
        for (const assignment of ['heartbeat_at = clock_timestamp()', "claim_token = 'rotated-during-wait'"]) {
          const item = await work();
          await other.query('BEGIN');
          await other.query('SELECT id FROM piles_auto_assignment_work_items WHERE id = $1 FOR UPDATE', [item.id]);
          let waiting;
          const observed = new Promise((resolve) => { waiting = resolve; });
          const proxy = { query(query, values) { if (query?.name === 'recovery-work-lock') waiting(); return db.query(query, values); } };
          const recovery = runRecovery(proxy, item.args);
          await observed;
          let blocked = false;
          for (let probe = 0; probe < 100; probe += 1) {
            const activity = await other.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [db.processID]);
            if (activity.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await other.query(`UPDATE piles_auto_assignment_work_items SET ${assignment} WHERE id = $1`, [item.id]);
          await other.query('COMMIT');
          assert.equal((await recovery).blocked, 1);
          assert.equal(blocked, true, 'The recovery statement must actually wait on the locked row');
        }
      });
      await t.test('stale legacy insurer and owned mixed parent outcomes are repaired without foreign success', async () => {
        const owner = await parent(); const insurer = identity(); const child = await run(owner, insurer);
        assert.equal((await runRecovery(db, ['--apply', '--confirmation', 'RECOVER_STALE_RUNS', '--insurer-run-id', child])).insurer_runs_recovered, 1);
        await run(owner, identity(), 'completed');
        assert.equal((await runRecovery(db, repairArgs(owner))).parent_runs_repaired, 1);
        assert.equal((await db.query('SELECT status FROM piles_auto_assignment_runner_runs WHERE id = $1', [owner])).rows[0].status, 'completed_with_issues');
        const foreign = await work(); const requester = await parent();
        await db.query(`UPDATE piles_auto_assignment_runner_runs SET details = jsonb_build_object('dispatch_requests', $2::jsonb) WHERE id = $1`,
          [requester, JSON.stringify([{ request_id: 'fixture', work_item_id: foreign.id, disposition: 'follow_up_queued' }])]);
        assert.equal((await runRecovery(db, repairArgs(requester))).blocked, 1);
        await db.query("UPDATE piles_auto_assignment_work_items SET disposition = 'failed' WHERE id = $1", [foreign.id]);
        assert.equal((await runRecovery(db, repairArgs(requester))).parent_runs_repaired, 1);
        assert.equal((await db.query('SELECT status FROM piles_auto_assignment_runner_runs WHERE id = $1', [requester])).rows[0].status, 'covered_by_active_cycle');
      });
      await t.test('parent recovery uses the current owned execution, not a superseded recovered child failure', async () => {
        const item = await work();
        await run(item.owner, item.insurer, 'failed');
        const current = await run(item.owner, item.insurer, 'completed');
        await db.query("UPDATE piles_auto_assignment_work_items SET disposition = 'completed', covered_by_insurer_run_id = $2 WHERE id = $1", [item.id, current]);
        assert.equal((await runRecovery(db, repairArgs(item.owner))).parent_runs_repaired, 1);
        assert.equal((await db.query('SELECT status FROM piles_auto_assignment_runner_runs WHERE id = $1', [item.owner])).rows[0].status, 'completed');
      });
      await t.test('legacy cancellation needs an inactive scheduled owner, superseding cycle and free lock', async () => {
        const owner = await parent('skipped_overlap'); const insurer = identity(); const requestId = identity();
        await db.query(`INSERT INTO piles_auto_assignment_schedule_requests (id, insurer_name, requested_runner_run_id, requested_at)
          VALUES ($1, $2, $3, clock_timestamp() - interval '1 hour')`, [requestId, insurer, owner]);
        const args = ['--apply', '--confirmation', 'CANCEL_OBSOLETE_LEGACY_REQUESTS', '--request-id', requestId];
        assert.equal((await runLegacyAudit(db, args)).blocked, 1);
        await run(await parent('completed'), insurer, 'completed');
        assert.equal((await runLegacyAudit(db, ['--request-id', requestId])).obsolete_requests, 1);
        await other.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`piles-insurer:${insurer}`]);
        assert.equal((await runLegacyAudit(db, args)).blocked, 1);
        await other.query('SELECT pg_advisory_unlock_all()');
        await db.query("UPDATE piles_auto_assignment_runner_runs SET run_source = 'manual' WHERE id = $1", [owner]);
        assert.equal((await runLegacyAudit(db, args)).blocked, 1);
        await db.query("UPDATE piles_auto_assignment_runner_runs SET run_source = 'schedule' WHERE id = $1", [owner]);
        assert.equal((await runLegacyAudit(db, args)).cancelled_requests, 1);
        assert.equal((await runLegacyAudit(db, args)).blocked, 1);
        assert.equal((await db.query('SELECT status FROM piles_auto_assignment_schedule_requests WHERE id = $1', [requestId])).rows[0].status, 'cancelled_legacy');
      });
    } finally {
      for (const client of clients) { await client.query('ROLLBACK'); await client.end(); }
    }
  });
}

test('recovery advisory-lock names match runner aliases exactly', () => {
  assert.equal(insurerAdvisoryLockName('DEFMIS'), 'piles-insurer:defmis');
  assert.equal(insurerAdvisoryLockName('Jubilee Kenya'), 'piles-insurer:jubilee kenya');
  assert.equal(insurerAdvisoryLockName('UAPOM'), 'piles-insurer:OLD MUTUAL');
  assert.equal(insurerAdvisoryLockName('old mutual'), 'piles-insurer:OLD MUTUAL');
});

test('incident inspection validates bounded read-only arguments', async () => {
  readFileSync(new URL('../scripts/inspect-piles-runner-incidents.mjs', import.meta.url), 'utf8');
  const { parseInspectorArgs } = await import('../scripts/inspect-piles-runner-incidents.mjs');

  assert.deepEqual(parseInspectorArgs([]), { hours: 24, runId: null });
  assert.deepEqual(
    parseInspectorArgs(['--hours', '168', '--run-id', '123e4567-e89b-42d3-a456-426614174000']),
    { hours: 168, runId: '123e4567-e89b-42d3-a456-426614174000' },
  );
  for (const argv of [
    ['--hours', '0'],
    ['--hours', '169'],
    ['--hours', '1.5'],
    ['--run-id', 'not-a-uuid'],
    ['--execute'],
  ]) {
    assert.throws(() => parseInspectorArgs(argv), /usage|hours|run-id|unknown/i);
  }
});

test('incident inspection builds parameterized normalized evidence queries', async () => {
  const {
    buildIncidentQueries,
    WORK_ITEMS_TABLE,
  } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const queries = buildIncidentQueries({
    hours: 24,
    runId: '123e4567-e89b-42d3-a456-426614174000',
    workItemsAvailable: true,
  });

  assert.equal(WORK_ITEMS_TABLE, 'piles_auto_assignment_work_items');
  assert.deepEqual(Object.keys(queries), [
    'parents',
    'insurers',
    'contexts',
    'batches',
    'attempt_states',
    'pending_requests',
    'work_items',
  ]);
  for (const query of Object.values(queries)) {
    assert.deepEqual(query.values, [24, '123e4567-e89b-42d3-a456-426614174000']);
    assert.match(query.text, /\$1::int/);
    assert.match(query.text, /\$2::text/);
    assert.doesNotMatch(query.text, /\b(stdout|stderr|tracking_key|password|login_email|bot_email)\b/i);
    assert.doesNotMatch(query.text, /\b(insert|update|delete|alter|drop|truncate)\b/i);
  }
  assert.match(queries.insurers.text, /regexp_replace[\s\S]*error_code/i);
  assert.match(queries.insurers.text, /case when error_message is null[\s\S]*Operational details redacted; use error_code\./i);
  assert.doesNotMatch(queries.insurers.text, /left\([\s\S]*error_message/i);
  assert.match(queries.insurers.text, /case when heartbeat_at is null then null/i);
  assert.match(queries.work_items.text, /case when heartbeat_at is null then null/i);
  assert.equal(
    'work_items' in buildIncidentQueries({ hours: 24, runId: null, workItemsAvailable: false }),
    false,
  );
});

test('incident report projects safe fields and marks unavailable work items', async () => {
  const { buildIncidentReport } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const longMessage = `portal\nmessage password=hunter2 Bearer token-value ${'x'.repeat(300)}`;
  const report = buildIncidentReport({
    hours: 24,
    runId: null,
    workItemsAvailable: false,
    sections: {
      parents: [{ id: 'parent-1', status: 'partial', stdout: 'secret output' }],
      insurers: [{
        id: 'insurer-1',
        insurer_name: 'DEFMIS',
        error_code: ' Login Failed!! ',
        error_message: longMessage,
        password: 'never-print-me',
      }],
      contexts: [],
      batches: [],
      attempt_states: [{ insurer_run_id: 'insurer-1', status: 'submitted', attempt_count: 2, tracking_key: 'secret-key' }],
      pending_requests: [],
    },
  });

  assert.equal(report.work_items_available, false);
  assert.equal(report.work_items, undefined);
  assert.deepEqual(report.parents, [{ id: 'parent-1', status: 'partial' }]);
  assert.equal(report.insurers[0].error_code, 'login_failed');
  assert.equal(report.insurers[0].error_message.includes('\n'), false);
  assert.ok(report.insurers[0].error_message.length <= 240);
  assert.equal(report.insurers[0].error_message.includes('hunter2'), false);
  assert.equal(report.insurers[0].error_message.includes('token-value'), false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('incident report replaces adversarial free-form errors with a safe template', async () => {
  const { buildIncidentReport } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const unsafeMessages = [
    '<html><body>Patient Jane Doe claim CLM-94821</body></html>',
    '{"password":"swordfish","token":"quoted-token"}',
    'Failure at https://portal.example.test/claims/CLM-94821?patient=Jane',
    'Contact patient.jane@example.test about member MED-77291',
    'Patient Jane Doe DOB 1990-01-01 has claim CLM-94821',
  ];
  const report = buildIncidentReport({
    hours: 24,
    runId: null,
    workItemsAvailable: false,
    sections: {
      parents: [],
      insurers: unsafeMessages.map((error_message, index) => ({
        id: `insurer-${index}`,
        error_code: 'scan_failed',
        error_message,
      })),
      contexts: [{
        id: 'context-1',
        error_code: 'context_failed',
        error_message: unsafeMessages.join(' | '),
      }],
      batches: [],
      attempt_states: [],
      pending_requests: [],
    },
  });

  for (const item of [...report.insurers, ...report.contexts]) {
    assert.equal(item.error_message, 'Operational details redacted; use error_code.');
  }
  const output = JSON.stringify(report);
  for (const unsafeFragment of ['<html>', 'Jane Doe', 'swordfish', 'quoted-token', 'https://', '@example.test', 'CLM-94821', 'MED-77291', '1990-01-01']) {
    assert.equal(output.includes(unsafeFragment), false, `leaked ${unsafeFragment}`);
  }
});

test('selected run overrides the time window in every evidence query', async () => {
  const { buildIncidentQueries } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const selectedRunId = '123e4567-e89b-42d3-a456-426614174000';
  const queries = buildIncidentQueries({ hours: 1, runId: selectedRunId, workItemsAvailable: true });
  const expectedSelectionPredicates = {
    parents: /where\s+\(\(\$2::text is null and created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or id = \$2::text\)/i,
    insurers: /where\s+\(\(\$2::text is null and created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or runner_run_id = \$2::text\)/i,
    contexts: /where\s+\(\(\$2::text is null and i\.created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or i\.runner_run_id = \$2::text\)/i,
    batches: /where\s+\(\(\$2::text is null and i\.created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or i\.runner_run_id = \$2::text\)/i,
    attempt_states: /where\s+\(\(\$2::text is null and i\.created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or i\.runner_run_id = \$2::text\)/i,
    pending_requests: /and\s+\(\(\$2::text is null and created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or requested_runner_run_id = \$2::text or claimed_by_runner_run_id = \$2::text\)/i,
    work_items: /where\s+\(\(\$2::text is null and created_at >= now\(\) - \(\$1::int \* interval '1 hour'\)\)\s+or parent_runner_run_id = \$2::text\)/i,
  };

  for (const [section, expectedPredicate] of Object.entries(expectedSelectionPredicates)) {
    assert.deepEqual(queries[section].values, [1, selectedRunId]);
    assert.match(queries[section].text, expectedPredicate, `${section} must include an old selected run`);
  }
});

test('incident inspection feature-detects work items inside a read-only transaction', async () => {
  const { inspectIncidents } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const calls = [];
  const client = {
    async query(query, values) {
      const text = typeof query === 'string' ? query : query.text;
      calls.push({ text, values: values ?? query.values });
      if (/to_regclass/i.test(text)) return { rows: [{ work_items_available: false }] };
      return { rows: [] };
    },
  };

  const report = await inspectIncidents(client, { hours: 24, runId: null });

  assert.equal(calls[0].text, 'BEGIN READ ONLY');
  assert.equal(calls.at(-1).text, 'ROLLBACK');
  assert.equal(report.work_items_available, false);
  assert.equal(calls.some(({ text }) => /from piles_auto_assignment_work_items/i.test(text)), false);
});

test('incident inspection rolls back when an evidence query fails', async () => {
  const { inspectIncidents } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const calls = [];
  const client = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      calls.push(text);
      if (/to_regclass/i.test(text)) return { rows: [{ work_items_available: false }] };
      if (/^select/i.test(text.trim())) throw new Error('query failed');
      return { rows: [] };
    },
  };

  await assert.rejects(inspectIncidents(client, { hours: 24, runId: null }), /query failed/);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('incident inspection attempts rollback when read-only setup fails', async () => {
  const { inspectIncidents } = await import('../scripts/inspect-piles-runner-incidents.mjs');
  const calls = [];
  const client = {
    async query(query) {
      const text = typeof query === 'string' ? query : query.text;
      calls.push(text);
      if (text === 'BEGIN READ ONLY') throw new Error('read-only setup failed');
      return { rows: [] };
    },
  };

  await assert.rejects(inspectIncidents(client, { hours: 24, runId: null }), /read-only setup failed/);
  assert.deepEqual(calls, ['BEGIN READ ONLY', 'ROLLBACK']);
});

test('incident inspection workflow parses and exposes inspection-only inputs', () => {
  const source = readFileSync(new URL('../.github/workflows/piles-incident-inspection.yml', import.meta.url), 'utf8');
  const workflow = parseYamlWithRuby(source);
  const trigger = workflow.on ?? workflow.true;
  const inputs = trigger.workflow_dispatch.inputs;
  const script = workflow.jobs.inspection.steps[0].with.script;

  assert.deepEqual(Object.keys(inputs), ['hours', 'run_id']);
  assert.equal(inputs.hours.default, 24);
  assert.match(script, /inspect-piles-runner-incidents\.mjs/);
  assert.doesNotMatch(JSON.stringify(workflow), /--apply|--execute|recover/i);
});
