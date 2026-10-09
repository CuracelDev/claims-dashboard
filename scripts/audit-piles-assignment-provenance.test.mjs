import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseProvenanceArgs,
  runProvenanceAudit,
} from './audit-piles-assignment-provenance.mjs';

test('arguments are bounded and mutation requires one exact target and confirmation', () => {
  assert.deepEqual(parseProvenanceArgs([]), {
    apply: false, hours: 24, insurer: null, attemptId: null,
  });
  assert.deepEqual(parseProvenanceArgs(['--hours', '72', '--insurer', 'Jubilee Kenya']), {
    apply: false, hours: 72, insurer: 'Jubilee Kenya', attemptId: null,
  });
  assert.throws(() => parseProvenanceArgs(['--hours', '0']), /Invalid provenance audit arguments/);
  assert.throws(() => parseProvenanceArgs(['--hours', '721']), /Invalid provenance audit arguments/);
  assert.throws(() => parseProvenanceArgs(['--apply']), /Invalid provenance audit arguments/);
  assert.throws(() => parseProvenanceArgs([
    '--apply', '--attempt-id', 'attempt-1', '--confirmation', 'WRONG',
  ]), /Invalid provenance audit arguments/);
  assert.equal(parseProvenanceArgs([
    '--apply', '--attempt-id', 'attempt-1',
    '--confirmation', 'REPAIR_PILES_PROVENANCE',
  ]).apply, true);
});

test('read-only audit uses bound filters, returns aggregates only, and rolls back', async () => {
  const calls = [];
  const client = {
    async query(statement, values) {
      calls.push([statement, values]);
      if (typeof statement === 'string') return { rows: [] };
      return { rows: [{
        confirmed_missing_tracked_links: 4,
        confirmed_matching_active_observations: 2,
        ambiguous_identities: 1,
        pending_runner_owned_assignments: 3,
        genuinely_unlinked_rows: 5,
        repairable_exact_matches: 1,
      }] };
    },
  };
  const report = await runProvenanceAudit(client, parseProvenanceArgs([
    '--hours', '48', '--insurer', 'DEFMIS',
  ]));

  assert.equal(calls[0][0], 'BEGIN READ ONLY');
  assert.equal(calls.at(-1)[0], 'ROLLBACK');
  assert.deepEqual(calls[1][0].values, [48, 'DEFMIS']);
  assert.deepEqual(report, {
    mode: 'inspect', window_hours: 48, insurer_filter_applied: true,
    confirmed_missing_tracked_links: 4,
    confirmed_matching_active_observations: 2,
    ambiguous_identities: 1,
    pending_runner_owned_assignments: 3,
    genuinely_unlinked_rows: 5,
    repairable_exact_matches: 1,
  });
  const serialized = JSON.stringify(report);
  for (const forbidden of ['provider', 'tracking_key', 'claim', 'attempt-1', 'DEFMIS']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
  assert.match(calls[1][0].text, /created_at >= clock_timestamp\(\) - \(\$1::int \* interval '1 hour'\)/);
  assert.doesNotMatch(calls[1][0].text, /\$\{.*insurer/i);
});

test('read-only audit rolls back if its query fails', async () => {
  const calls = [];
  const client = {
    async query(statement) {
      calls.push(statement);
      if (statement === 'BEGIN READ ONLY') return { rows: [] };
      if (statement === 'ROLLBACK') return { rows: [] };
      throw new Error('sensitive database diagnostic');
    },
  };
  await assert.rejects(() => runProvenanceAudit(client, parseProvenanceArgs([])));
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('guarded repair locks one exact confirmed match, never calls a portal, and commits atomically', async () => {
  const calls = [];
  const client = {
    async query(statement, values) {
      calls.push([statement, values]);
      if (typeof statement === 'string') return { rows: [] };
      if (statement.name === 'provenance-repair-lock') return { rows: [{
        attempt_id: 'attempt-1', insurer_name: 'DEFMIS', tracking_key: 'stable-key',
        last_pile_key: 'pile-key', bot_account_id: 'bot-1', master_account_id: 'master-1',
        intended_portal_assignee: 'CVEBOT1', observation_id: 'observation-1',
        provider: 'redacted in report', claim_month: 'June 2025', submitted_date: '',
        claims_total: 3, synced_claims: 3, remaining_claims: 0,
        assignment_type: 'Vetting', current_status: 'Vetting Ongoing',
        current_status_bucket: 'Vetting Ongoing', current_assigned: 'CVEBOT1',
      }] };
      if (statement.name === 'provenance-repair-ambiguity') {
        return { rows: [{ observation_matches: 1, attempt_matches: 1 }] };
      }
      if (statement.name === 'provenance-repair-upsert') return { rows: [{ id: 'tracked-1' }] };
      if (statement.name === 'provenance-repair-link') return { rows: [{ id: 'attempt-1' }] };
      if (statement.name === 'provenance-repair-clear') return { rows: [{ id: 'observation-1' }] };
      if (statement.name === 'provenance-repair-advisory-lock') return { rows: [{ acquired: true }] };
      throw new Error(`unexpected query: ${statement.name}`);
    },
  };
  const report = await runProvenanceAudit(client, parseProvenanceArgs([
    '--apply', '--attempt-id', 'attempt-1',
    '--confirmation', 'REPAIR_PILES_PROVENANCE',
  ]));
  assert.deepEqual(report, { mode: 'apply', repaired_attempts: 1, cleared_observations: 1, blocked: 0 });
  assert.equal(calls[0][0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.equal(calls.at(-1)[0], 'COMMIT');
  const source = readFileSync(new URL('./audit-piles-assignment-provenance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /playwright|health\.curacel|assign-pile|axios|fetch\s*\(/i);
  assert.doesNotMatch(source, /delete\s+from|status\s*=\s*'confirmed_/i);
});

test('ambiguous repair is blocked and rolled back without writes', async () => {
  const names = [];
  const client = {
    async query(statement) {
      names.push(typeof statement === 'string' ? statement : statement.name);
      if (typeof statement === 'string') return { rows: [] };
      if (statement.name === 'provenance-repair-lock') return { rows: [{ attempt_id: 'attempt-1', insurer_name: 'DEFMIS' }] };
      if (statement.name === 'provenance-repair-advisory-lock') return { rows: [{ acquired: true }] };
      if (statement.name === 'provenance-repair-ambiguity') return { rows: [{ observation_matches: 2, attempt_matches: 1 }] };
      throw new Error('write should not execute');
    },
  };
  const report = await runProvenanceAudit(client, parseProvenanceArgs([
    '--apply', '--attempt-id', 'attempt-1', '--confirmation', 'REPAIR_PILES_PROVENANCE',
  ]));
  assert.deepEqual(report, { mode: 'apply', repaired_attempts: 0, cleared_observations: 0, blocked: 1 });
  assert.equal(names.at(-1), 'ROLLBACK');
  assert.equal(names.includes('provenance-repair-upsert'), false);
});

test('incident workflow exposes read-only provenance inspection and no repair command', () => {
  const workflow = readFileSync(new URL('../.github/workflows/piles-incident-inspection.yml', import.meta.url), 'utf8');
  assert.match(workflow, /operation:/);
  assert.match(workflow, /audit-piles-assignment-provenance\.mjs/);
  assert.doesNotMatch(workflow, /REPAIR_PILES_PROVENANCE|--apply/);
});
