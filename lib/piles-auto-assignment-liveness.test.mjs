import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { evaluateScheduleLiveness, evaluatePilesHealth } from './piles-auto-assignment-liveness.mjs';
import { deliverScheduleTransition, transitionScheduleLiveness, readScheduleSnapshot,
  formatHealthNotification, healthExitCode } from '../scripts/audit-piles-schedule-liveness.mjs';

const now = new Date('2026-10-20T12:00:00.000Z');

test('historical backlog stays unhealthy overall without failing operational checks', () => {
  const result = evaluatePilesHealth({ ...snapshot(), assignment_issues: [{ insurer_name: 'Test',
    period: 'historical', status: 'failed', pile_count: 2, oldest_at: '2026-09-01T00:00:00Z' }] }, now);
  assert.equal(result.healthy, false);
  assert.equal(result.operational_healthy, true);
  assert.equal(result.code, 'historical_assignment_backlog');
  assert.equal(result.historical_backlog[0].pile_count, 2);
  assert.deepEqual(result.current_assignment.issues, []);
  assert.equal(healthExitCode(result), 0);
  const notification = formatHealthNotification(transitionScheduleLiveness(null, result), result);
  assert.match(notification, /historical assignment reconciliation remains open/);
  assert.doesNotMatch(notification, /✅|🚨/);
});

test('recent unresolved work and missing period evidence still fail operational checks', () => {
  for (const period of ['recent', undefined, 'invalid']) {
    const result = evaluatePilesHealth({ ...snapshot(), assignment_issues: [{ insurer_name: 'Test',
      period, status: 'failed', pile_count: 2, oldest_at: '2026-10-20T10:00:00Z' }] }, now);
    assert.equal(result.operational_healthy, false);
    assert.equal(healthExitCode(result), 20);
  }
});

test('scheduler failure is not hidden by historical-only assignment evidence', () => {
  const result = evaluatePilesHealth({ latest: null, assignment_issues: [{ insurer_name: 'Test',
    period: 'historical', status: 'failed', pile_count: 1, oldest_at: '2026-09-01T00:00:00Z' }] }, now);
  assert.equal(result.operational_healthy, false);
  assert.equal(result.scheduler.code, 'missing_schedule');
});

test('operational recovery with backlog is distinct from all-clear', () => {
  const issue = { insurer_name: 'Test', period: 'historical', status: 'failed', pile_count: 1,
    oldest_at: '2026-09-01T00:00:00Z' };
  const unhealthy = evaluatePilesHealth({ ...snapshot({ status: 'failed' }), assignment_issues: [issue] }, now);
  const recovered = evaluatePilesHealth({ ...snapshot(), assignment_issues: [issue] }, now);
  const transition = transitionScheduleLiveness(transitionScheduleLiveness(null, unhealthy).state, recovered);
  assert.equal(transition.notify, true);
  assert.equal(transition.operational_recovered, true);
  assert.equal(transition.recovered, false);
  assert.match(formatHealthNotification(transition, recovered), /operations recovered; historical/);
  assert.equal(transitionScheduleLiveness(transition.state, recovered).notify, false);
});

test('first healthy observation does not send an attention alert', () => {
  const result = evaluatePilesHealth({ ...snapshot(), assignment_issues: [] }, now);
  assert.equal(transitionScheduleLiveness(null, result).notify, false);
});

test('SQL retains old unresolved work but clears an identity with newer confirmed evidence',
  { skip: !process.env.PILES_TEST_DATABASE_URL }, async () => {
    const client = new pg.Client({ connectionString: process.env.PILES_TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`begin;
        create temporary table piles_auto_assignment_insurer_runs (id text, status text);
        create temporary table piles_auto_assignment_attempts (id text, insurer_run_id text,
          insurer_name text, tracking_key text, status text, evidence_code text,
          created_at timestamptz, updated_at timestamptz);
        insert into piles_auto_assignment_insurer_runs values ('run', 'completed');
        insert into piles_auto_assignment_attempts values
          ('a','run','Test','recovered','failed',null,now()-interval '3 hours',now()-interval '3 hours'),
          ('b','run','Test','recovered','confirmed_visible',null,now()-interval '2 hours',now()-interval '2 hours'),
          ('c','run','Test','missing','manual_action_required',null,now()-interval '7 days',now()-interval '7 days'),
          ('d','run','Test','observed','failed','planned_row_observed_assigned_at_final_scan',now(),now());`);
      const result = await readScheduleSnapshot({ query: sql => sql.includes('select runner.id')
        ? Promise.resolve({ rows: [snapshot().latest] }) : client.query(sql) });
      assert.equal(result.assignment_issues.length, 1);
      assert.equal(result.assignment_issues[0].status, 'manual_action_required');
      assert.equal(result.assignment_issues[0].pile_count, 1);
      assert.equal(result.assignment_issues[0].period, 'historical');
      await client.query(`insert into piles_auto_assignment_attempts values
        ('recent','run','Test','fresh','failed',null,now()-interval '2 hours',now()),
        ('edge','run','Test','boundary','failed',null,now()-interval '24 hours',now());`);
      const updated = await readScheduleSnapshot({ query: sql => sql.includes('select runner.id')
        ? Promise.resolve({ rows: [snapshot().latest] }) : client.query(sql) });
      assert.equal(updated.assignment_issues.find(row => row.period === 'recent').pile_count, 2);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });

test('an empty latest run cannot conceal historical unresolved assignments', () => {
  const evidence = { ...snapshot(), assignment_issues: [{ insurer_name: 'Jubilee Uganda',
    period: 'recent', status: 'manual_action_required', pile_count: 14, oldest_at: '2026-10-20T08:00:00Z' }] };
  const result = evaluatePilesHealth(evidence, now);
  assert.equal(result.scheduler.healthy, true);
  assert.equal(result.healthy, false);
  assert.equal(result.code, 'assignment_issues');
  assert.equal(result.assignment_issues[0].pile_count, 14);
  const next = evaluatePilesHealth({ ...evidence, latest: { ...evidence.latest, id: 'next-run' } }, now);
  assert.equal(transitionScheduleLiveness(transitionScheduleLiveness(null, result).state, next).notify, false);
  const resolved = evaluatePilesHealth({ ...evidence, assignment_issues: [] }, now);
  assert.equal(resolved.healthy, true);
  assert.equal(transitionScheduleLiveness(transitionScheduleLiveness(null, result).state, resolved).recovered, true);
});

test('missing assignment evidence cannot establish overall health', () => {
  const result = evaluatePilesHealth(snapshot(), now);
  assert.equal(result.healthy, false);
  assert.equal(result.code, 'assignment_evidence_unavailable');
});

test('a cycle-level issue without persisted attempts still requires attention', () => {
  const result = evaluatePilesHealth({ ...snapshot({ status: 'completed_with_issues' }), assignment_issues: [] }, now);
  assert.equal(result.scheduler.healthy, true);
  assert.equal(result.healthy, false);
  assert.equal(result.code, 'cycle_issues');
});

test('completed status cannot conceal unresolved cycle counters', () => {
  for (const counts of [{ planned_piles: 2, confirmed_piles: 1 },
    { failed_piles: 1 }, { pending_piles: 1 }, { conflict_piles: 1 }, { discovered_piles: 1 }]) {
    const result = evaluatePilesHealth({ ...snapshot(counts), assignment_issues: [] }, now);
    assert.equal(result.healthy, false);
    assert.equal(result.code, 'cycle_issues');
  }
});

function snapshot(overrides = {}) {
  return {
    latest: {
      id: 'run-1',
      status: 'completed',
      started_at: '2026-10-20T11:00:00.000Z',
      finished_at: '2026-10-20T11:08:00.000Z',
      confirmed_piles: 0,
      ...overrides,
    },
    consecutive_failures: 0,
  };
}

test('missing or overdue scheduled evidence is unhealthy after 75 minutes', () => {
  assert.equal(evaluateScheduleLiveness({ latest: null }, now, 75).code, 'missing_schedule');
  const result = evaluateScheduleLiveness(snapshot({
    started_at: '2026-10-20T09:00:00.000Z',
    finished_at: '2026-10-20T09:10:00.000Z',
  }), now, 75);
  assert.equal(result.healthy, false);
  assert.equal(result.code, 'schedule_overdue');
});

test('recent completed empty and assigned cycles are both healthy but distinct', () => {
  const empty = evaluateScheduleLiveness(snapshot(), now, 75);
  const assigned = evaluateScheduleLiveness(snapshot({ confirmed_piles: 8 }), now, 75);
  assert.deepEqual([empty.healthy, empty.code], [true, 'completed_empty']);
  assert.deepEqual([assigned.healthy, assigned.code], [true, 'completed_assigned']);
});

test('zero confirmations cannot be called empty when work evidence exists', () => {
  for (const evidence of [
    { discovered_piles: 1 }, { planned_piles: 1 }, { pending_piles: 1 },
    { conflict_piles: 1 }, { failed_piles: 1 },
  ]) {
    const result = evaluateScheduleLiveness(snapshot(evidence), now, 75);
    assert.equal(result.code, 'completed_with_issues');
  }
});

test('confirmed work with unresolved outcomes remains completed with issues', () => {
  for (const evidence of [
    { confirmed_piles: 2, pending_piles: 1 },
    { confirmed_piles: 2, conflict_piles: 1 },
    { confirmed_piles: 2, failed_piles: 1 },
    { confirmed_piles: 2, planned_piles: 3 },
  ]) {
    const result = evaluateScheduleLiveness(snapshot(evidence), now, 75);
    assert.equal(result.code, 'completed_with_issues');
  }
});

test('a completed-with-issues cycle is never described as an empty successful cycle', () => {
  const result = evaluateScheduleLiveness(snapshot({
    status: 'completed_with_issues',
    confirmed_piles: 0,
  }), now, 75);
  assert.deepEqual([result.healthy, result.code], [true, 'completed_with_issues']);
});

test('a covered scheduled request proves launch liveness without claiming assignments', () => {
  const result = evaluateScheduleLiveness(snapshot({
    status: 'covered_by_active_cycle',
    confirmed_piles: 0,
  }), now, 75);
  assert.deepEqual([result.healthy, result.code], [true, 'covered_by_active_cycle']);
});

test('recent active work is healthy while an expired active cycle is stale', () => {
  const active = evaluateScheduleLiveness(snapshot({
    status: 'running', finished_at: null, heartbeat_at: '2026-10-20T11:58:00.000Z',
  }), now, 75);
  assert.deepEqual([active.healthy, active.code], [true, 'active']);
  const stale = evaluateScheduleLiveness(snapshot({
    status: 'running', started_at: '2026-10-20T09:00:00.000Z', finished_at: null,
    heartbeat_at: '2026-10-20T09:30:00.000Z',
  }), now, 75);
  assert.deepEqual([stale.healthy, stale.code], [false, 'stale_active']);
});

test('repeated failures are explicit and do not resemble completed-empty work', () => {
  const result = evaluateScheduleLiveness({
    ...snapshot({ status: 'failed', finished_at: '2026-10-20T11:55:00.000Z' }),
    consecutive_failures: 3,
  }, now, 75);
  assert.deepEqual([result.healthy, result.code], [false, 'repeated_failures']);
  assert.equal(result.failure_count, 3);
});

test('notification transition deduplicates an unchanged incident and reports recovery', () => {
  const unhealthy = evaluateScheduleLiveness({ latest: null }, now, 75);
  const first = transitionScheduleLiveness(null, unhealthy);
  assert.equal(first.notify, true);
  const repeated = transitionScheduleLiveness(first.state, unhealthy);
  assert.equal(repeated.notify, false);
  const recovered = transitionScheduleLiveness(
    repeated.state,
    evaluateScheduleLiveness(snapshot(), now, 75),
  );
  assert.equal(recovered.notify, true);
  assert.equal(recovered.recovered, true);
});

test('failed notification does not persist a state that would suppress retry', async () => {
  const transition = transitionScheduleLiveness(null, evaluateScheduleLiveness({ latest: null }, now, 75));
  const events = [];
  await assert.rejects(
    deliverScheduleTransition(transition, { code: 'missing_schedule' }, {
      notify: async () => { events.push('notify'); throw new Error('delivery failed'); },
      persist: () => events.push('persist'),
    }),
    /delivery failed/,
  );
  assert.deepEqual(events, ['notify']);
});
