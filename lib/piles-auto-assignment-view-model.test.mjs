import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

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

test('durable preview diagnostics are projected as non-executable insurer outcomes', () => {
  const view = toRunnerProgressView({
    id: 'preview-parent', status: 'completed_with_issues', mode: 'dry-run', run_source: 'manual',
    details: {
      preview_protocol: 'durable_preview_v1', preview_phase: 'complete',
      preview_outcomes: [
        { insurer_name: 'DEFMIS', status: 'completed', phase: 'complete', error_code: '',
          discovered_piles: 3, discovered_claims: 45, planned_piles: 2, planned_claims: 30,
          contexts_total: 5, contexts_complete: 5, contexts_empty: 2, contexts_failed: 0, contexts_pending: 0 },
        { insurer_name: 'Jubilee Kenya', status: 'failed', phase: 'complete', error_code: 'portal_timeout',
          error_message: '<html>patient secret</html>', discovered_piles: 0, discovered_claims: 0,
          planned_piles: 0, planned_claims: 0 },
      ],
      preview_claim_token: 'must-not-leak', password: 'must-not-leak',
    },
  });
  assert.equal(view.mode, 'dry-run');
  assert.equal(view.work_disposition, 'diagnostic_preview');
  assert.match(view.summary_text, /preview.*issues.*no assignments/i);
  assert.deepEqual(view.insurers.map(({ insurer_name, status, error_code }) => ({ insurer_name, status, error_code })), [
    { insurer_name: 'DEFMIS', status: 'completed', error_code: '' },
    { insurer_name: 'Jubilee Kenya', status: 'failed', error_code: 'portal_timeout' },
  ]);
  assert.equal(view.counts.discovered_piles, 3);
  assert.equal(view.counts.discovered_claims, 45);
  assert.equal(view.counts.planned_piles, 2);
  assert.equal(view.counts.submitted_piles, 0);
  assert.equal(view.counts.confirmed_piles, 0);
  assert.equal(view.insurers[0].counts.contexts_total, 5);
  assert.equal(view.insurers[0].counts.contexts_complete, 5);
  assert.equal(view.counts.contexts_total, null, 'one insurer without measured context evidence makes the aggregate unknown');
  assert.doesNotMatch(JSON.stringify(view), /patient secret|must-not-leak|<html>/);
});

test('preview authentication failure does not invent a completed scan context', () => {
  const view = toRunnerProgressView({
    id: 'preview-parent', status: 'failed', mode: 'dry-run', run_source: 'manual',
    details: {
      preview_protocol: 'durable_preview_v1', preview_phase: 'complete',
      preview_outcomes: [{ insurer_name: 'DEFMIS', status: 'failed', phase: 'complete',
        error_code: 'authentication_failed', discovered_piles: 0, discovered_claims: 0,
        planned_piles: 0, planned_claims: 0 }],
    },
  });
  assert.equal(view.insurers[0].counts.contexts_total, null);
  assert.equal(view.insurers[0].counts.contexts_complete, null);
  assert.equal(view.insurers[0].counts.contexts_failed, null);
  assert.equal(view.counts.contexts_total, null);
  assert.equal(view.counts.contexts_complete, null);
});

test('preview context aggregates fail closed when persisted evidence is inconsistent', () => {
  const view = toRunnerProgressView({
    id: 'preview-parent', status: 'completed', mode: 'dry-run', run_source: 'manual',
    details: {
      preview_protocol: 'durable_preview_v1', preview_phase: 'complete',
      preview_outcomes: [{ insurer_name: 'DEFMIS', status: 'completed', phase: 'complete',
        contexts_total: 1, contexts_complete: 9, contexts_empty: 8,
        contexts_failed: 7, contexts_pending: 6 }],
    },
  });
  for (const key of ['contexts_total', 'contexts_complete', 'contexts_empty', 'contexts_failed', 'contexts_pending']) {
    assert.equal(view.insurers[0].counts[key], null);
    assert.equal(view.counts[key], null);
  }
});

test('active durable preview reports its parent heartbeat and current phase', () => {
  const view = toRunnerProgressView({
    id: 'preview-parent', status: 'running', mode: 'dry-run', run_source: 'manual',
    started_at: '2026-09-11T11:00:00Z', updated_at: '2026-09-11T11:59:00Z',
    details: { preview_protocol: 'durable_preview_v1', preview_phase: 'scan', preview_outcomes: [] },
  }, [], [], [], [], { now: Date.parse('2026-09-11T12:00:00Z') });
  assert.equal(view.phase, 'scan');
  assert.equal(view.heartbeat_at, '2026-09-11T11:59:00Z');
  assert.equal(view.heartbeat_state, 'fresh');
});

test('every preview parent state uses non-executable state-specific wording', () => {
  const details = { preview_protocol: 'durable_preview_v1', preview_phase: 'configuration', preview_outcomes: [] };
  for (const [status, pattern] of [
    ['queued', /preview.*queued.*no assignments/i],
    ['running', /preview.*running.*no assignments/i],
    ['cancelled', /preview.*cancelled.*no assignments/i],
    ['covered_by_active_cycle', /preview.*covered.*no assignments/i],
    ['unexpected', /preview.*unknown.*no assignments/i],
  ]) {
    const view = toRunnerProgressView({ id: 'preview', status, mode: 'dry-run', run_source: 'manual', details });
    assert.match(view.summary_text, pattern);
    if (['queued', 'running'].includes(status)) assert.doesNotMatch(view.summary_text, /completed/i);
  }
});

test('counts aggregate contexts and batches without claim identifiers', () => {
  const view = toRunnerProgressView(
    { id: 'run-1', status: 'started' },
    [{ id: 'i1', insurer_name: 'DEFMIS', status: 'running', phase: 'reconcile', heartbeat_at: '2026-09-08T10:00:00Z' }],
    [{ insurer_run_id: 'i1', status: 'complete', distinct_pile_count: 4, unassigned_pile_count: 3, claim_count: 80 }],
    [{ insurer_run_id: 'i1', status: 'reconciliation_pending', planned_pile_count: 3, confirmed_pile_count: 2, pending_pile_count: 1, conflict_pile_count: 0, failed_pile_count: 0 }],
  );
  assert.deepEqual(Object.fromEntries(Object.entries(view.counts).filter(([key]) => !['contexts_empty', 'contexts_failed', 'contexts_pending', 'selected_piles', 'submitted_piles', 'manual_action_required'].includes(key))), {
    contexts_total: 1, contexts_complete: 1, discovered_piles: 4, unassigned_piles: 3,
    discovered_claims: 80, planned_piles: 3, confirmed_piles: 2,
    reconciliation_pending: 1, conflicts: 0, failed: 0,
  });
  assert.equal(view.phase, 'reconcile');
  assert.equal(view.heartbeat_at, '2026-09-08T10:00:00Z');
});

const now = Date.parse('2026-09-11T12:00:00Z');
const parent = { id: 'run-1', status: 'started', run_source: 'manual' };
const child = { id: 'i1', runner_run_id: 'run-1', insurer_name: 'DEFMIS', status: 'running', phase: 'scan' };
const project = (run = parent, insurers = [], contexts = [], batches = [], work = []) =>
  toRunnerProgressView(run, insurers, contexts, batches, work, { now });

test('history explains legacy and current terminal outcomes without making coverage an assignment success', () => {
  for (const [status, pattern] of [
    ['partial', /issues.*legacy/i], ['skipped_overlap', /overlap.*legacy/i],
    ['completed_with_issues', /issues/i], ['covered_by_active_cycle', /no duplicate execution/i],
    ['manual_action_required', /manual action/i], ['failed', /failed/i], ['unexpected_new_state', /unknown/i],
  ]) assert.match(project({ ...parent, status }).summary_text, pattern);
  assert.equal(project({ status: 'unexpected_new_state' }).status, 'unknown');
  for (const [run_source, source_label] of [['schedule', 'Scheduled'], ['manual', 'Manual'], ['readiness', 'Read-only probe'], ['recovery', 'Recovery'], [null, 'Unknown source']]) {
    assert.equal(project({ run_source }).source_label, source_label);
  }
});

test('legacy persisted filter/scope vocabulary and PostgreSQL Date values remain readable', () => {
  const view = project({ ...parent, run_scope: 'all-active', portal_environment: 'test', backend: 'remote', months: ['Jan', 'Sep'], year: '2026', started_at: new Date('2026-09-11T11:00:00Z') });
  assert.equal(view.run_scope, 'all-active');
  assert.equal(view.portal_environment, 'test');
  assert.equal(view.backend, 'remote');
  assert.deepEqual(view.months, ['Jan', 'Sep']);
  assert.equal(view.started_at, '2026-09-11T11:00:00.000Z');
  assert.equal(view.duration_ms, 3600000);
});

test('durations preserve hours and heartbeat freshness is deterministic, independent of elapsed runtime', () => {
  const run = { ...parent, started_at: '2026-09-11T10:27:34Z', duration_ms: 0 };
  const fresh = project(run, [{ ...child, started_at: run.started_at, heartbeat_at: '2026-09-11T11:59:00Z' }]);
  assert.equal(fresh.duration_ms, 5546000);
  assert.equal(fresh.insurers[0].duration_ms, 5546000);
  assert.equal(fresh.insurers[0].heartbeat_state, 'fresh');
  for (const [heartbeat_at, state] of [['2026-09-11T11:45:00Z', 'fresh'], ['2026-09-11T11:44:59Z', 'stale'], [null, 'missing'], ['2026-09-12T12:00:00Z', 'unknown']]) {
    const view = project(run, [{ ...child, heartbeat_at }, { ...child, id: 'i2', heartbeat_at: '2026-09-11T11:59:59Z' }]);
    assert.equal(view.insurers[0].heartbeat_state, state);
    assert.equal(view.heartbeat_state, state);
  }
  const terminal = project({ ...run, status: 'completed', duration_ms: 3600000 }, [{ ...child, status: 'completed', started_at: '2026-09-11T10:00:00Z', finished_at: '2026-09-11T11:00:00Z' }]);
  assert.equal(terminal.duration_ms, 3600000);
  assert.equal(terminal.insurers[0].duration_ms, 3600000);
  assert.equal(terminal.insurers[0].heartbeat_state, 'not_applicable');
});

test('owned work without an execution is visible as queued, follow-up, covered, inactive, or failed', () => {
  for (const [disposition, status] of [['queued', 'queued'], ['follow_up_queued', 'follow_up_queued'], ['claimed', 'running'], ['covered_by_active_cycle', 'covered_by_active_cycle'], ['inactive', 'skipped_inactive'], ['failed', 'failed'], ['alien', 'unknown']]) {
    const view = project(parent, [], [], [], [{ id: 'w1', parent_runner_run_id: 'run-1', insurer_name: 'DEFMIS', source: 'manual', disposition }]);
    assert.equal(view.insurers[0]?.status, status);
    assert.equal(view.insurers[0]?.source_label, 'Manual');
    assert.equal(view.insurers[0]?.work_disposition, disposition === 'alien' ? 'unknown' : disposition);
    assert.equal(view.counts.confirmed_piles, 0);
    if (['queued', 'follow_up_queued'].includes(disposition)) assert.match(view.summary_text, /waiting|queued/i);
  }
});

test('bounded foreign references expose waiting then acknowledgement without foreign outcome or identities', () => {
  const details = { dispatch_requests: [{ request_id: 'opaque-request', work_item_id: 'foreign-work', disposition: 'follow_up_queued' }], password: 'private-value' };
  const foreign = { ...child, id: 'foreign-insurer', runner_run_id: 'foreign-parent', status: 'completed', confirmed_pile_count: 88 };
  const work = [{ id: 'foreign-work', parent_runner_run_id: 'foreign-parent', covered_by_insurer_run_id: foreign.id, disposition: 'completed' }];
  const waiting = project({ ...parent, details }, [foreign], [], [], work);
  assert.deepEqual(waiting.request_state, { state: 'waiting', count: 1, queued: 0, follow_up_queued: 1 });
  assert.match(waiting.summary_text, /waiting.*another.*generation/i);
  const acknowledged = project({ ...parent, status: 'covered_by_active_cycle', details }, [foreign], [], [], work);
  assert.equal(acknowledged.request_state.state, 'acknowledged');
  assert.equal(acknowledged.insurers.length, 0);
  assert.equal(acknowledged.counts.confirmed_piles, 0);
  assert.doesNotMatch(JSON.stringify(acknowledged), /opaque-request|foreign-work|foreign-insurer|foreign-parent|private-value/);
  for (const dispatch_requests of [[{ ...details.dispatch_requests[0], raw_html: '<html>' }], [{ request_id: 'https://private.test', work_item_id: 'w', disposition: 'queued' }], Array(257).fill(details.dispatch_requests[0]), 'bad']) {
    assert.equal(project({ ...parent, details: { dispatch_requests } }).request_state.state, 'unknown');
  }
});

test('counts remain owned and expose empty/failed/pending contexts and selected/submitted/manual evidence', () => {
  const view = project(parent, [{ ...child, status: 'manual_action_required', submitted_pile_count: 3 }], [
    { insurer_run_id: 'i1', status: 'empty' }, { insurer_run_id: 'i1', status: 'failed' }, { insurer_run_id: 'i1', status: 'pending' },
    { insurer_run_id: 'foreign', status: 'complete', distinct_pile_count: 900 },
  ], [{ insurer_run_id: 'i1', planned_pile_count: 5, selected_pile_count: 4, confirmed_pile_count: 2, pending_pile_count: 1 }]);
  assert.equal(view.counts.contexts_empty, 1);
  assert.equal(view.counts.contexts_failed, 1);
  assert.equal(view.counts.contexts_pending, 1);
  assert.equal(view.counts.contexts_total, 3);
  assert.equal(view.counts.selected_piles, 4);
  assert.equal(view.counts.submitted_piles, 3);
  assert.equal(view.counts.manual_action_required, null, 'manual pile count is unknown, never fabricated from a workflow status');
});

test('live child evidence is not hidden by insurer counters that are only updated at finalization', () => {
  const view = project(parent, [{ ...child, discovered_pile_count: 0, planned_pile_count: 0, confirmed_pile_count: 0, reconciliation_pending_pile_count: 0 }],
    [{ insurer_run_id: 'i1', status: 'complete', distinct_pile_count: 5 }],
    [{ insurer_run_id: 'i1', planned_pile_count: 5, confirmed_pile_count: 2, pending_pile_count: 3 }]);
  assert.equal(view.counts.discovered_piles, 5);
  assert.equal(view.counts.planned_piles, 5);
  assert.equal(view.counts.confirmed_piles, 2);
  assert.equal(view.counts.reconciliation_pending, 3);
});

test('completed parent is not reopened by a detached durable worker attempt', () => {
  const view = project(
    { ...parent, status: 'completed' },
    [
      { ...child, id: 'old-child', details: { dispatch_protocol: 'durable_work_v2', dispatch_work_item_id: 'w1', dispatch_attempt_number: 1 } },
      { ...child, id: 'new-child', status: 'completed', phase: 'complete', finished_at: '2026-09-11T11:00:00Z', details: { dispatch_protocol: 'durable_work_v2', dispatch_work_item_id: 'w1', dispatch_attempt_number: 2 } },
    ],
    [], [],
    [{ id: 'w1', parent_runner_run_id: 'run-1', insurer_name: 'DEFMIS', source: 'manual', disposition: 'completed', covered_by_insurer_run_id: 'new-child' }],
  );
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.insurers.map((item) => [item.id, item.status]), [['old-child', 'failed'], ['new-child', 'completed']]);
  assert.equal(view.insurers[0].error_code, 'worker_attempt_reclaimed');

  const legacy = project({ ...parent, status: 'completed' }, [{ ...child, id: 'legacy-child' }]);
  assert.equal(legacy.status, 'running', 'genuine unmarked legacy children retain active coverage semantics');
});

test('unfinished or manual work never inherits a clean completion and unknown phases remain unknown', () => {
  for (const disposition of ['queued', 'follow_up_queued']) {
    const view = project({ ...parent, status: 'completed' }, [], [], [], [{ id: 'w1', parent_runner_run_id: 'run-1', disposition }]);
    assert.equal(view.status, 'running');
  }
  const manual = project(parent, [], [], [], [{ id: 'w1', parent_runner_run_id: 'run-1', disposition: 'completed', reason_code: 'manual_action_required' }]);
  assert.equal(manual.insurers[0].status, 'manual_action_required');
  assert.equal(manual.insurers[0].counts.manual_action_required, null);
  assert.equal(project(parent, [{ ...child, phase: 'private-phase' }]).insurers[0].phase, 'unknown');
  assert.equal(project({ status: 'private-status' }).heartbeat_state, 'unknown');
  const uncertain = project({ ...parent, status: 'completed', details: { dispatch_requests: 'invalid' } });
  assert.equal(uncertain.status, 'unknown');
  const unknownWork = project({ ...parent, status: 'completed' }, [], [], [], [{ parent_runner_run_id: 'run-1', disposition: 'new_state' }]);
  assert.equal(unknownWork.status, 'unknown');
});

test('unpersisted live submission totals are unknown, while terminal zero remains a real zero', () => {
  assert.equal(project(parent, [{ ...child, submitted_pile_count: 0 }]).counts.submitted_piles, null);
  assert.equal(project(parent, [{ ...child, status: 'completed', submitted_pile_count: 0 }]).counts.submitted_piles, 0);
});

test('timing aggregate count/cardinality and invalid numeric values remain bounded and detached', () => {
  const entries = Array.from({ length: 101 }, (_, index) => ({ phase: 'scan', operation: index === 100 ? 'pagination' : 'filter', count: 1e99, total_ms: true, min_ms: NaN, max_ms: Infinity, outcomes: { success: '4', other: 1e99 } }));
  const view = project(parent, [{ ...child, details: { performance: entries } }]);
  assert.deepEqual(view.insurers[0].performance, [{ phase: 'scan', operation: 'filter', count: 1e12, total_ms: 0, min_ms: 0, max_ms: 0, outcomes: { success: 4, other: 1e12 } }]);
  entries[0].outcomes.success = 999;
  assert.equal(view.insurers[0].performance[0].outcomes.success, 4);
});

test('adversarial database errors and performance JSON are reprojected, never trusted or echoed', () => {
  const sensitive = '<html>patient Ada email@private.test https://private.test password=secret token=private tracking_key=claim-123</html>';
  const performance = [{ phase: 'scan', operation: 'filter', count: 2, total_ms: 3000, min_ms: 1400, max_ms: 1600, outcomes: { success: 2, [sensitive]: 9 }, raw_html: sensitive, samples: [sensitive] },
    { phase: sensitive, operation: sensitive, count: Infinity, total_ms: -9, min_ms: sensitive, max_ms: 1e99, outcomes: { failed: -2 } }];
  const view = project({ ...parent, stdout: sensitive, stderr: sensitive, details: { raw_html: sensitive } }, [
    { ...child, status: 'failed', error_code: sensitive, error_message: sensitive, details: { performance, secret: sensitive } },
    { ...child, id: 'i2', status: 'failed', error_code: 'scan_incomplete', error_message: sensitive },
  ], [], [], [{ id: 'w1', parent_runner_run_id: 'run-1', covered_by_insurer_run_id: 'i1', insurer_name: 'DEFMIS', disposition: 'failed', reason_code: sensitive, worker_id: sensitive, claim_token: sensitive }]);
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /password|token|stdout|stderr|tracking_key|raw_html|private|claim-123|<html>|samples|patient|email@/i);
  assert.equal(view.insurers[0].error_code, 'unknown_error');
  assert.equal(view.insurers[0].error_message, 'Operational details redacted; use error_code.');
  assert.deepEqual(view.insurers[0].performance, [
    { phase: 'scan', operation: 'filter', count: 2, total_ms: 3000, min_ms: 1400, max_ms: 1600, outcomes: { success: 2 } },
    { phase: 'other', operation: 'other', count: 0, total_ms: 0, min_ms: 0, max_ms: 1e15, outcomes: { failed: 0 } },
  ]);
  assert.equal(view.insurers[1].error_code, 'scan_incomplete');
  assert.match(view.insurers[1].error_message, /context.*not.*complete/i);
});

test('temporarily empty assignee windows are explained as deferred work', () => {
  const view = project(parent, [{
    ...child,
    status: 'completed_with_issues',
    error_code: 'no_eligible_assignees',
  }]);
  assert.match(view.insurers[0].error_message, /eligible.*time window.*next scheduled/i);
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

// Execute the actual GET handler; replace only Next's response wrapper and the
// external database boundary. TypeScript resolves the existing extensionless imports.
function historyRoute(tables, errors = {}, { beforeRead, afterRead } = {}) {
  const calls = [];
  const database = { from(table) {
    const call = { table, filters: [] };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return query; },
      order(column, options) { call.order = [column, options]; return query; },
      limit(value) { call.limit = value; return query; },
      range(from, to) { call.range = [from, to]; return query; },
      eq(column, value) { call.filters.push({ column, value, kind: 'eq' }); return query; },
      in(column, value) { call.filters.push({ column, value, kind: 'in' }); return query; },
      gt(column, value) { call.filters.push({ column, value, kind: 'gt' }); return query; },
      then(resolve) {
        beforeRead?.(call, calls);
        let rows = tables[table] || [];
        for (const filter of call.filters) rows = rows.filter((row) => filter.kind === 'eq' ? row[filter.column] === filter.value : filter.kind === 'gt' ? row[filter.column] > filter.value : filter.value.includes(row[filter.column]));
        if (call.order) {
          const [column, { ascending }] = call.order;
          rows = [...rows].sort((left, right) => (left[column] < right[column] ? -1 : left[column] > right[column] ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
        if (call.limit != null) rows = rows.slice(0, call.limit);
        rows = rows.slice(0, 1000); // PostgREST's default response cap.
        rows = rows.map((row) => Object.fromEntries(call.columns.split(',').filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])));
        rows = afterRead?.(call, rows) ?? rows;
        resolve({ data: rows, error: errors[table] || null });
      },
    };
    return query;
  } };
  const source = readFileSync(new URL('../app/api/tools/piles-auto-assignment/runner-runs/route.js', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', compiled)((name) => {
    if (name === 'next/server') return { NextResponse: { json: (body, options) => ({ body: JSON.parse(JSON.stringify(body)), status: options?.status || 200 }) } };
    if (name.endsWith('/supabase')) return { getSupabase: () => database };
    if (name.endsWith('/piles-auto-assignment-view-model.mjs')) return { toRunnerProgressView };
    throw new Error('Unexpected route dependency');
  }, exports);
  return { get: (search = '') => exports.GET({ url: `http://localhost/history${search}` }), calls };
}
const tables = {
  parents: 'piles_auto_assignment_runner_runs', insurers: 'piles_auto_assignment_insurer_runs',
  work: 'piles_auto_assignment_work_items', contexts: 'piles_auto_assignment_scan_contexts', batches: 'piles_auto_assignment_batches',
};

test('GET loads bounded parent-owned safe work and timing columns and serializes only safe diagnostics', async () => {
  const secret = '<html>patient email@private.test https://private.test token=secret tracking_key=claim-123</html>';
  const fixture = historyRoute({
    [tables.parents]: [{ ...parent, details: { dispatch_requests: [{ request_id: 'opaque-ref', work_item_id: 'foreign-work', disposition: 'follow_up_queued' }], password: secret }, stdout: secret }],
    [tables.insurers]: [{ ...child, details: { performance: [{ phase: 'scan', operation: 'filter', count: 1, total_ms: 1500, min_ms: 1500, max_ms: 1500, outcomes: { success: 1 }, raw_html: secret }] }, error_code: 'portal_timeout', error_message: secret, submitted_pile_count: 3 }],
    [tables.work]: [{ id: 'w1', parent_runner_run_id: 'run-1', insurer_name: 'DEFMIS', covered_by_insurer_run_id: 'i1', source: 'manual', disposition: 'claimed', worker_id: secret, claim_token: secret }, { id: 'foreign-work', parent_runner_run_id: 'foreign-parent', disposition: 'failed' }],
    [tables.batches]: [{ id: 'b1', insurer_run_id: 'i1', selected_pile_count: 4, tracking_key: secret }],
  });
  const response = await fixture.get('?id=run-1');
  assert.equal(response.status, 200);
  assert.equal(response.body.work_items_available, true);
  assert.equal(response.body.runs[0].insurers[0].work_disposition, 'claimed');
  assert.equal(response.body.runs[0].insurers[0].performance[0].total_ms, 1500);
  assert.equal(response.body.runs[0].counts.selected_piles, 4);
  assert.equal(response.body.runs[0].counts.submitted_piles, 3);
  assert.equal(response.body.runs[0].request_state.state, 'waiting');
  assert.doesNotMatch(JSON.stringify(response.body), /password|token|stdout|stderr|tracking_key|raw_html|private|claim-123|opaque-ref|foreign-work|<html>/i);
  const workQueries = fixture.calls.filter((call) => call.table === tables.work);
  assert.ok(workQueries.length);
  for (const query of workQueries) {
    assert.deepEqual(query.filters, [{ column: 'parent_runner_run_id', value: ['run-1'], kind: 'in' }]);
    assert.ok(query.range || query.limit, 'work queries must have explicit row bounds');
    assert.doesNotMatch(query.columns, /\*|worker|token|attempt|details|payload|stdout|stderr/);
  }
  assert.ok(fixture.calls.every((call) => !/attempts|tracked_piles/.test(call.table)));
});

test('later reconciliation batch outcomes supersede terminal snapshots without double counting', () => {
  const finished = { ...child, status: 'completed_with_issues', discovered_pile_count: 9, planned_pile_count: 3, submitted_pile_count: 3, confirmed_pile_count: 0, reconciliation_pending_pile_count: 3, conflict_pile_count: 0, failed_pile_count: 0 };
  for (const [batch, expected] of [
    [{ status: 'confirmed', confirmed_pile_count: 3, pending_pile_count: 0, conflict_pile_count: 0, failed_pile_count: 0 }, [3, 0, 0, 0]],
    [{ status: 'conflict', confirmed_pile_count: 1, pending_pile_count: 0, conflict_pile_count: 2, failed_pile_count: 0 }, [1, 0, 2, 0]],
    [{ status: 'failed', confirmed_pile_count: 0, pending_pile_count: 1, conflict_pile_count: 0, failed_pile_count: 2 }, [0, 1, 0, 2]],
  ]) {
    const row = { id: 'batch-1', insurer_run_id: 'i1', planned_pile_count: 3, ...batch };
    const view = project(parent, [finished], [], [row, { ...row }]);
    assert.deepEqual(['confirmed_piles', 'reconciliation_pending', 'conflicts', 'failed'].map((key) => view.counts[key]), expected);
    assert.equal(view.counts.discovered_piles, 9);
    assert.equal(view.counts.planned_piles, 3);
    assert.equal(view.counts.submitted_piles, 3);
  }
});

test('still-unassigned batch evidence remains pending despite a terminal insurer zero snapshot', () => {
  // ExecutionLedger's batch rollup includes still_unassigned in pending_count;
  // finalize_insurer_run only includes reconciliation_pending in its snapshot.
  const view = project(parent, [{ ...child, status: 'completed_with_issues', reconciliation_pending_pile_count: 0, confirmed_pile_count: 0 }], [], [
    { id: 'batch-1', insurer_run_id: 'i1', status: 'reconciliation_pending', pending_pile_count: 1, confirmed_pile_count: 0, conflict_pile_count: 0, failed_pile_count: 0 },
  ]);
  assert.equal(view.counts.reconciliation_pending, 1);
  assert.equal(view.insurers[0].counts.reconciliation_pending, 1);
});

test('absent batch evidence falls back to persisted insurer outcome counters', () => {
  const view = project(parent, [{ ...child, status: 'completed_with_issues', confirmed_pile_count: 2, reconciliation_pending_pile_count: 1, conflict_pile_count: 3, failed_pile_count: 4 }]);
  assert.deepEqual(['confirmed_piles', 'reconciliation_pending', 'conflicts', 'failed'].map((key) => view.counts[key]), [2, 1, 3, 4]);
});

test('producer follow-up-required code has a fixed safe explanation', () => {
  const view = project(parent, [{ ...child, status: 'completed_with_issues', error_code: 'assignment_follow_up_required', error_message: '<html>patient email@private.test token=secret</html>' }]);
  assert.equal(view.insurers[0].error_code, 'assignment_follow_up_required');
  assert.match(view.insurers[0].error_message, /assignment.*follow.up.*required/i);
  assert.doesNotMatch(JSON.stringify(view), /<html>|private|patient|secret|token/);
});

test('GET keyset reads do not recount rows when a concurrent UUID insertion precedes the prior boundary', async () => {
  for (const table of [tables.insurers, tables.work, tables.contexts, tables.batches]) {
    const db = { [tables.parents]: [parent], [tables.insurers]: [child] };
    const makeRow = (index) => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, runner_run_id: 'run-1', parent_runner_run_id: 'run-1', insurer_run_id: 'i1', insurer_name: 'DEFMIS', status: table === tables.insurers ? 'completed' : 'complete', disposition: 'queued', distinct_pile_count: 1, confirmed_pile_count: 1 });
    db[table] = Array.from({ length: 501 }, (_, index) => makeRow(index + 1));
    const fixture = historyRoute(db, {}, { beforeRead(call, calls) {
      if (call.table === table && calls.filter((item) => item.table === table).length === 2) db[table].push(makeRow(0));
    } });
    const response = await fixture.get();
    assert.equal(response.status, 200, table);
    const view = response.body.runs[0];
    const actual = table === tables.contexts ? view.counts.contexts_total : table === tables.batches ? view.counts.confirmed_piles : table === tables.insurers ? view.insurers.length : view.insurers.filter((item) => item.work_disposition === 'queued').length;
    assert.equal(actual, 501, `${table}: no existing row is lost or counted twice`);
    const pages = fixture.calls.filter((call) => call.table === table);
    assert.equal(pages.length, 2);
    assert.deepEqual(pages[1].filters.at(-1), { column: 'id', kind: 'gt', value: '10000000-0000-4000-8000-000000000500' });
    assert.ok(pages.every((page) => page.limit === 500 && !page.range));
  }
});

test('GET rejects missing, duplicate, and nonadvancing cursor evidence instead of returning counts', async () => {
  for (const mutation of ['missing', 'duplicate', 'nonadvancing']) {
    let reads = 0;
    const fixture = historyRoute({ [tables.parents]: [parent], [tables.insurers]: [child], [tables.contexts]: Array.from({ length: 501 }, (_, index) => ({ id: String(index + 1).padStart(6, '0'), insurer_run_id: 'i1', status: 'complete' })) }, {}, {
      afterRead(call, rows) {
        if (call.table !== tables.contexts) return rows;
        reads += 1;
        if (mutation === 'missing' && reads === 1) rows[0].id = null;
        if (mutation === 'duplicate' && reads === 1) rows[1].id = rows[0].id;
        if (mutation === 'nonadvancing' && reads === 2) rows[0].id = '000500';
        return rows;
      },
    });
    const response = await fixture.get();
    assert.equal(response.status, 500, mutation);
    assert.deepEqual(response.body, { success: false, error: 'Failed to load runner history.' });
  }
});

test('GET feature detects absent work table for both database adapters but does not swallow unrelated failures', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    const response = await historyRoute({ [tables.parents]: [{ ...parent, status: 'partial' }], [tables.insurers]: [child] }, { [tables.work]: { code, message: 'private error' } }).get();
    assert.equal(response.status, 200);
    assert.equal(response.body.work_items_available, false);
    assert.equal(response.body.runs[0].status, 'partial');
    assert.equal(response.body.runs[0].insurers[0].work_disposition, 'legacy');
  }
  for (const table of Object.values(tables)) {
    const response = await historyRoute({ [tables.parents]: [parent], [tables.insurers]: [child] }, { [table]: { code: '42501', message: '<html>private password=secret https://private.test' } }).get();
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { success: false, error: 'Failed to load runner history.' });
  }
});

test('GET binds exact malicious-looking IDs as values, bounds limits, and pages counts without silent truncation', async () => {
  const id = "run'); SELECT private";
  const fixture = historyRoute({
    [tables.parents]: [{ ...parent, id }], [tables.insurers]: [{ ...child, runner_run_id: id }],
    [tables.contexts]: Array.from({ length: 1001 }, (_, index) => ({ id: `c${index}`, insurer_run_id: 'i1', status: 'complete', distinct_pile_count: 1 })),
  });
  const response = await fixture.get(`?id=${encodeURIComponent(id)}&limit=999999`);
  assert.equal(response.status, 200);
  assert.equal(response.body.runs[0].counts.contexts_total, 1001);
  assert.equal(response.body.runs[0].counts.discovered_piles, 1001);
  const parentQuery = fixture.calls[0];
  assert.deepEqual(parentQuery.filters, [{ column: 'id', value: id, kind: 'eq' }]);
  assert.equal(parentQuery.limit, 1);
  assert.ok(fixture.calls.every((call) => !call.columns.includes(id)));
  const defaultLimit = historyRoute({});
  await defaultLimit.get();
  assert.equal(defaultLimit.calls[0].limit, 100);
  const maxLimit = historyRoute({});
  await maxLimit.get('?limit=999999');
  assert.equal(maxLimit.calls[0].limit, 250);
});

test('GET refuses an oversized work result instead of publishing partial successful history', async () => {
  const fixture = historyRoute({ [tables.parents]: [parent], [tables.work]: Array.from({ length: 64001 }, (_, index) => ({ id: `w${index}`, parent_runner_run_id: 'run-1', disposition: 'queued' })) });
  const response = await fixture.get();
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { success: false, error: 'Failed to load runner history.' });
  const workPages = fixture.calls.filter((call) => call.table === tables.work);
  assert.equal(workPages.length, 129, '64000 allowed rows plus exactly one bounded overflow read');
  assert.ok(workPages.every((call) => call.limit === 500));
});
