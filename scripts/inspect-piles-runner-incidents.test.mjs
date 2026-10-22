import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentReport, buildIncidentQueries } from './inspect-piles-runner-incidents.mjs';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('unresolved follow-up distinguishes later stable-identity evidence without exposing identities',
  { skip: !process.env.PILES_TEST_DATABASE_URL }, async () => {
    const client = new pg.Client({ connectionString: process.env.PILES_TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`begin;
        create temporary table piles_auto_assignment_attempts (
          id text, insurer_run_id text, insurer_name text, tracking_key text, status text,
          intended_portal_assignee text, evidence_details jsonb, submitted_at timestamptz,
          created_at timestamptz, updated_at timestamptz);
        create temporary table piles_auto_assignment_insurer_runs (id text, runner_run_id text);
        insert into piles_auto_assignment_insurer_runs values ('run', 'parent');
        insert into piles_auto_assignment_attempts values
        ('a','run','Test','old-a','failed','private-user','{"portal_identity_hash":"hash-a"}',null,now()-interval '2 days',now()-interval '2 days'),
        ('b','run','Test','new-a','confirmed_visible','private-user','{"portal_identity_hash":"hash-a"}',now(),now(),now()),
        ('c','run','Test','old-b','manual_action_required','private-user','{"portal_identity_hash":"hash-b"}',now(),now()-interval '2 hours',now()-interval '2 hours'),
        ('d','run','Test','new-b','confirmed_reconciled','different-user','{"portal_identity_hash":"hash-b"}',now(),now(),now()),
        ('e','run','Test','unknown','conflict','private-user','{}',now(),now(),now()),
        ('f','run','Other','irrelevant','confirmed_visible','private-user','{"portal_identity_hash":"hash-b"}',now(),now(),now());`);
      const statement = buildIncidentQueries({ hours: 24, runId: 'parent', workItemsAvailable: false }).unresolved_follow_up;
      assert.ok(statement, 'follow-up diagnostic query is required');
      const { rows } = await client.query(statement);
      const report = buildIncidentReport({ hours: 24, runId: 'parent', workItemsAvailable: false,
        sections: { unresolved_follow_up: rows } });
      assert.equal(report.unresolved_follow_up.length, 3);
      assert.equal(report.unresolved_follow_up.find(row => row.follow_up === 'later_same_recipient_confirmation').pile_count, 1);
      assert.equal(report.unresolved_follow_up.find(row => row.follow_up === 'later_different_recipient_confirmation').pile_count, 1);
      assert.equal(report.unresolved_follow_up.find(row => row.follow_up === 'no_later_confirmation').pile_count, 1);
      assert.doesNotMatch(JSON.stringify(report), /private-user|different-user|hash-a|old-a/);
    } finally { await client.query('rollback'); await client.end(); }
  });

test('stdin inspector transport validates arguments and exits safely without touching a database', () => {
  const source = readFileSync(new URL('./inspect-piles-runner-incidents.mjs', import.meta.url), 'utf8')
    + '\nawait main().catch(() => { console.error("Incident inspection failed safely."); process.exitCode = 1; });\n';
  const result = spawnSync(process.execPath, ['--input-type=module', '-', '--hours', 'invalid'], {
    input: source, encoding: 'utf8', timeout: 10000,
    cwd: new URL('../', import.meta.url), env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'Incident inspection failed safely.');
  assert.equal(result.stdout, '');
});

test('real SQL groups attempts separately from identities and respects parent scope',
  { skip: !process.env.PILES_TEST_DATABASE_URL }, async () => {
    const client = new pg.Client({ connectionString: process.env.PILES_TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`create temporary table piles_auto_assignment_insurer_runs
        (id text, runner_run_id text, created_at timestamptz);
        create temporary table piles_auto_assignment_attempts
        (insurer_run_id text, insurer_name text, status text, evidence_code text,
         submitted_at timestamptz, tracking_key text, claim_count int);
        insert into piles_auto_assignment_insurer_runs values ('run', 'parent', now()), ('other', 'elsewhere', now());
        insert into piles_auto_assignment_attempts values
        ('run', 'Test insurer', 'failed', 'planned_row_not_assignable_at_final_scan', null, 'pile-1', 3),
        ('run', 'Test insurer', 'failed', 'planned_row_not_assignable_at_final_scan', null, 'pile-1', 3),
        ('run', 'Test insurer', 'failed', 'secret', null, 'pile-2', 1),
        ('other', 'Test insurer', 'failed', 'secret', null, 'pile-3', 99);`);
      const query = buildIncidentQueries({ hours: 24, runId: 'parent', workItemsAvailable: false }).attempt_reasons;
      const { rows } = await client.query(query);
      const report = buildIncidentReport({ hours: 24, runId: 'parent', workItemsAvailable: false,
        sections: { attempt_reasons: rows } });
      const known = report.attempt_reasons.find(row => row.evidence_code === 'planned_row_not_assignable_at_final_scan');
      assert.equal(known.attempt_count, 2);
      assert.equal(known.unique_pile_count, 1);
      assert.equal(known.claim_count, 6); // Claim observations across attempts, not unique claims.
      assert.equal(report.attempt_reasons.length, 2);
      assert.doesNotMatch(JSON.stringify(report), /secret|pile-[123]|99/);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

test('scan diagnostics survive report projection with bounded numbers only', () => {
  const report = buildIncidentReport({ hours: 24, runId: null, workItemsAvailable: false,
    sections: { insurers: [{ failure: { phase: 'scan', module: 'piles_auto_assignment_runner',
      error_type: 'IncompleteScan', line: 6031, scan: { code: 'response_http_error',
        http_status: 503, page_number: 2, elapsed_ms: 45, page_size: true, url: 'secret' } } }] } });
  assert.deepEqual(report.insurers[0].failure.scan,
    { code: 'response_http_error', page_number: 2, elapsed_ms: 45, http_status: 503 });
  assert.doesNotMatch(JSON.stringify(report), /secret|url|page_size/);
});

test('attempt diagnostics retain allowlisted reasons and counts without identities or arbitrary text', () => {
  const report = buildIncidentReport({ hours: 24, runId: null, workItemsAvailable: false,
    sections: { attempt_reasons: [{ insurer_name: 'Jubilee Tanzania', status: 'failed',
      evidence_code: 'planned_row_not_assignable_at_final_scan', submission_state: 'not_recorded',
      attempt_count: 37, unique_pile_count: 35, claim_count: 112,
      tracking_key: 'private-claim', evidence_details: { token: 'secret' } },
    { evidence_code: 'secret-token', submission_state: 'private-url', status: 'patient-name',
      attempt_count: 'secret', unique_pile_count: -1, claim_count: {} }] } });
  assert.deepEqual(report.attempt_reasons, [
    { insurer_name: 'Jubilee Tanzania', status: 'failed',
      evidence_code: 'planned_row_not_assignable_at_final_scan', submission_state: 'not_recorded',
      attempt_count: 37, unique_pile_count: 35, claim_count: 112 },
    { evidence_code: 'other', submission_state: 'unknown', status: 'other',
      attempt_count: null, unique_pile_count: null, claim_count: null },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private|secret|patient/);
});
