import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      if (sql.includes('pg_indexes')) return { rows: [] };
      if (sql.startsWith('select count(*)')) return { rows: [{ count: 0 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    auditDatabase(pool, { log() {} }),
    /schema audit failed/i,
  );
});

test('schema audit enforces the complete durable work-item contract', () => {
  const columns = [
    ['id', 'text'], ['parent_runner_run_id', 'text'], ['insurer_name', 'text'],
    ['canonical_insurer_name', 'text'], ['source', 'text'], ['request_scope', 'text'],
    ['disposition', 'text'], ['covered_by_insurer_run_id', 'text'], ['worker_id', 'text'],
    ['claim_token', 'text'], ['lease_expires_at', 'timestamp with time zone'],
    ['heartbeat_at', 'timestamp with time zone'], ['generation_requested_at', 'timestamp with time zone'],
    ['attempt_number', 'integer'], ['requested_at', 'timestamp with time zone'],
    ['claimed_at', 'timestamp with time zone'], ['started_at', 'timestamp with time zone'],
    ['finished_at', 'timestamp with time zone'], ['reason_code', 'text'],
    ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone'],
  ].map(([column_name, data_type]) => ({ column_name, data_type }));
  const checks = [{
    constraint_name: 'work_contract',
    definition: "CHECK (((source = ANY (ARRAY['schedule','manual','readiness','recovery'])) AND (request_scope = ANY (ARRAY['all_active','single_insurer'])) AND (disposition = ANY (ARRAY['queued','claimed','covered_by_active_cycle','follow_up_queued','inactive','completed','failed','cancelled'])) AND ((reason_code IS NULL) OR (reason_code ~ '^[a-z0-9._-]+$'))))",
  }];
  const indexes = [
    { indexname: 'piles_auto_assignment_work_items_queued_generation_idx', indexdef: "CREATE UNIQUE INDEX piles_auto_assignment_work_items_queued_generation_idx ON piles_auto_assignment_work_items (canonical_insurer_name, source, request_scope) WHERE disposition = 'queued'" },
    { indexname: 'piles_auto_assignment_work_items_follow_up_idx', indexdef: "CREATE UNIQUE INDEX piles_auto_assignment_work_items_follow_up_idx ON piles_auto_assignment_work_items (canonical_insurer_name) WHERE disposition = 'follow_up_queued'" },
    { indexname: 'piles_auto_assignment_work_items_claim_order_idx', indexdef: 'CREATE INDEX piles_auto_assignment_work_items_claim_order_idx ON piles_auto_assignment_work_items (parent_runner_run_id, disposition, generation_requested_at, requested_at, id)' },
    { indexname: 'piles_auto_assignment_work_items_expired_lease_idx', indexdef: "CREATE INDEX piles_auto_assignment_work_items_expired_lease_idx ON piles_auto_assignment_work_items (lease_expires_at, canonical_insurer_name) WHERE disposition = 'claimed'" },
  ];
  const foreignKeys = [
    { column_name: 'parent_runner_run_id', referenced_table: 'piles_auto_assignment_runner_runs', delete_rule: 'SET NULL' },
    { column_name: 'covered_by_insurer_run_id', referenced_table: 'piles_auto_assignment_insurer_runs', delete_rule: 'SET NULL' },
  ];

  assert.deepEqual(
    evaluateTable('piles_auto_assignment_work_items', columns, [], checks, indexes, foreignKeys),
    [],
  );
  assert.match(
    evaluateTable('piles_auto_assignment_work_items', columns.filter((column) => column.column_name !== 'claim_token'), [], checks, indexes, foreignKeys).join(';'),
    /missing column claim_token/,
  );
  assert.match(
    evaluateTable('piles_auto_assignment_work_items', columns, [], checks, indexes.slice(1), foreignKeys).join(';'),
    /queued_generation_idx/,
  );
  assert.match(
    evaluateTable('piles_auto_assignment_work_items', columns, [], [], indexes, foreignKeys).join(';'),
    /missing CHECK.*schedule/i,
  );
  assert.match(
    evaluateTable('piles_auto_assignment_work_items', columns, [], checks, indexes, foreignKeys.slice(1)).join(';'),
    /missing FOREIGN KEY parent_runner_run_id/,
  );
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
        return { rows: [{ canonical_insurer_name: 'jubilee uganda' }, { canonical_insurer_name: 'defmis' }] };
      }
      if (/pg_try_advisory_lock/i.test(text)) return { rows: [{ acquired: values[0].includes('jubilee uganda') }] };
      if (/pg_advisory_unlock/i.test(text)) return { rows: [{ released: true }] };
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  const findings = await inspectQueueHealth(pool);
  assert.deepEqual(findings, {
    queuedWithoutLiveWorker: 2,
    expiredLeases: 2,
    expiredLeasesWithFreeLock: 1,
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
