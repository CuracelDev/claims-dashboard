const MODES = new Set(['balanced_finish', 'single_owner', 'manual_override']);

export class AssignmentRuleValidationError extends Error {}

function integer(value, fallback, label, { positive = false } = {}) {
  const candidate = value === undefined ? fallback : value;
  const parsed = typeof candidate === 'number' ? candidate : Number(candidate);
  if (!Number.isInteger(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    throw new AssignmentRuleValidationError(`${label} must be ${positive ? 'a positive' : 'a non-negative'} integer.`);
  }
  return parsed;
}

export function validateAssignmentRule(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || input.distribution_mode !== undefined) {
    const mode = String(input.distribution_mode ?? 'balanced_finish').trim();
    if (!MODES.has(mode)) {
      throw new AssignmentRuleValidationError(`Unsupported distribution mode: ${mode || '(empty)'}.`);
    }
    output.distribution_mode = mode;
  }
  if (!partial || input.minimum_claim_chunk !== undefined) {
    output.minimum_claim_chunk = integer(input.minimum_claim_chunk, 25, 'Minimum claim chunk', { positive: true });
  }
  for (const [field, fallback, label] of [
    ['reassignment_threshold_minutes', 120, 'Reassignment threshold'],
    ['stale_claim_threshold', 40, 'Stale claim threshold'],
    ['target_completion_gap_minutes', 30, 'Target completion gap'],
  ]) {
    if (!partial || input[field] !== undefined) output[field] = integer(input[field], fallback, label);
  }
  if (input.support_capacity_ratio !== undefined) {
    const capacity = Number(input.support_capacity_ratio);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new AssignmentRuleValidationError('Support capacity ratio must be greater than zero.');
    }
    output.support_capacity_ratio = capacity;
  }
  return output;
}
