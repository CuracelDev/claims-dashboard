import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAssignmentRule } from './piles-auto-assignment-rules.mjs';

test('accepts each supported distribution mode', () => {
  for (const distribution_mode of ['balanced_finish', 'single_owner', 'manual_override']) {
    assert.equal(validateAssignmentRule({ distribution_mode, minimum_claim_chunk: 25 }).distribution_mode, distribution_mode);
  }
});

test('rejects unsupported modes', () => {
  assert.throws(() => validateAssignmentRule({ distribution_mode: 'round_robin', minimum_claim_chunk: 25 }), /distribution mode/i);
});

test('rejects non-positive integer thresholds', () => {
  assert.throws(() => validateAssignmentRule({ distribution_mode: 'balanced_finish', minimum_claim_chunk: 0 }), /minimum claim chunk/i);
  assert.throws(() => validateAssignmentRule({ distribution_mode: 'balanced_finish', minimum_claim_chunk: 2.5 }), /minimum claim chunk/i);
});

test('rejects negative stale and reassignment values', () => {
  assert.throws(() => validateAssignmentRule({
    distribution_mode: 'balanced_finish', minimum_claim_chunk: 25,
    stale_claim_threshold: -1, reassignment_threshold_minutes: 120,
    target_completion_gap_minutes: 30,
  }), /stale claim threshold/i);
});
