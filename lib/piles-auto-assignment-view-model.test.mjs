import assert from 'node:assert/strict';
import test from 'node:test';

import { toRunnerProgressView } from './piles-auto-assignment-view-model.mjs';

test('partial run exposes completed and failed insurers', () => {
  const view = toRunnerProgressView(
    { id: 'run-1', status: 'partial', mode: 'execute', details: { password: 'secret' } },
    [
      { id: 'i1', insurer_name: 'DEFMIS', status: 'completed', phase: 'complete' },
      { id: 'i2', insurer_name: 'Jubilee Kenya', status: 'failed', phase: 'complete', error_code: 'scan_incomplete', error_message: 'Safe message' },
    ],
    [],
    [],
  );
  assert.equal(view.status, 'partial');
  assert.deepEqual(view.insurers.map((item) => item.status), ['completed', 'failed']);
  assert.equal(view.insurers[1].error_code, 'scan_incomplete');
});

test('counts aggregate contexts and batches without claim identifiers', () => {
  const view = toRunnerProgressView(
    { id: 'run-1', status: 'started' },
    [{ id: 'i1', insurer_name: 'DEFMIS', status: 'running', phase: 'reconcile', heartbeat_at: '2026-09-08T10:00:00Z' }],
    [{ insurer_run_id: 'i1', status: 'complete', distinct_pile_count: 4, unassigned_pile_count: 3, claim_count: 80 }],
    [{ insurer_run_id: 'i1', status: 'reconciliation_pending', planned_pile_count: 3, confirmed_pile_count: 2, pending_pile_count: 1, conflict_pile_count: 0, failed_pile_count: 0 }],
  );
  assert.deepEqual(view.counts, {
    contexts_total: 1, contexts_complete: 1, discovered_piles: 4, unassigned_piles: 3,
    discovered_claims: 80, planned_piles: 3, confirmed_piles: 2,
    reconciliation_pending: 1, conflicts: 0, failed: 0,
  });
  assert.equal(view.phase, 'reconcile');
  assert.equal(view.heartbeat_at, '2026-09-08T10:00:00Z');
});

test('progress view never exposes details, credentials, or tracking keys', () => {
  const view = toRunnerProgressView(
    { id: 'run-1', status: 'failed', stdout: 'secret', stderr: 'secret', details: { raw_html: '<html>', password: 'secret' } },
    [{ id: 'i1', insurer_name: 'DEFMIS', status: 'failed', error_message: 'x'.repeat(1000), login_password: 'secret' }],
    [{ tracking_key: 'claim-123', ui_evidence: { raw_html: 'secret' } }],
    [],
  );
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /password|raw_html|tracking_key|claim-123|stdout|stderr/i);
  assert.ok(view.insurers[0].error_message.length <= 500);
});
