import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateScheduleLiveness } from './piles-auto-assignment-liveness.mjs';
import { deliverScheduleTransition, transitionScheduleLiveness } from '../scripts/audit-piles-schedule-liveness.mjs';

const now = new Date('2026-10-20T12:00:00.000Z');

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

test('a completed-with-issues cycle is never described as an empty successful cycle', () => {
  const result = evaluateScheduleLiveness(snapshot({
    status: 'completed_with_issues',
    confirmed_piles: 0,
  }), now, 75);
  assert.deepEqual([result.healthy, result.code], [true, 'completed_with_issues']);
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
