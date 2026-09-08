import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRunnerArgs, startDetachedRunner, validateRunRequest } from './piles-auto-assignment-runner.mjs';

test('validation accepts one insurer and normalizes filters', () => {
  const request = validateRunRequest({ insurer_name: ' DEFMIS ', month: 'All', year: '2026' });
  assert.equal(request.insurerName, 'DEFMIS');
  assert.deepEqual(request.months, ['All']);
});

test('argv uses separate values and adopts the pre-created run id', () => {
  const request = validateRunRequest({ run_all: true, months: ['Jan', 'Feb'], finalize_assignments: false });
  const args = buildRunnerArgs(request, { runId: 'run-123', backend: 'local' });
  assert.deepEqual(args.slice(0, 6), ['--run-id', 'run-123', '--run-source', 'manual', '--invocation-backend', 'local']);
  assert.ok(args.includes('--all-active'));
  assert.ok(!args.includes('--execute'));
});

test('detached start returns without waiting for close', () => {
  const calls = [];
  const child = { unref: () => calls.push('unref'), once: () => child };
  const spawn = (...args) => { calls.push(args); return child; };
  const result = startDetachedRunner({ pythonBin: 'python3', scriptPath: 'runner.py', args: [], cwd: '/app', env: {} }, spawn);
  assert.equal(result.status, 'queued');
  assert.deepEqual(calls.at(-1), 'unref');
  assert.equal(calls[0][2].stdio, 'ignore');
  assert.equal(calls[0][2].detached, true);
});

test('synchronous spawn failure is reported', () => {
  assert.throws(
    () => startDetachedRunner({ pythonBin: 'missing', scriptPath: 'runner.py', args: [] }, () => { throw new Error('ENOENT'); }),
    /ENOENT/,
  );
});
