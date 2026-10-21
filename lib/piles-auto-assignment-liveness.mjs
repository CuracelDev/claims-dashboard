const ACTIVE = new Set(['queued', 'started', 'running']);
const COMPLETE = new Set(['completed', 'completed_with_issues', 'partial']);

export function evaluatePilesHealth(snapshot, now = new Date(), thresholdMinutes = 75) {
  const scheduler = evaluateScheduleLiveness(snapshot, now, thresholdMinutes);
  const allowed = new Set(['failed', 'manual_action_required', 'conflict', 'reconciliation_pending',
    'selected', 'submitted', 'planned', 'still_unassigned']);
  const rows = snapshot?.assignment_issues;
  const valid = Array.isArray(rows) && rows.every(row => row &&
    typeof row.insurer_name === 'string' && allowed.has(row.status) &&
    Number.isSafeInteger(row.pile_count) && row.pile_count > 0 &&
    row.oldest_at != null && validDate(row.oldest_at));
  if (!valid) return { ...scheduler, scheduler, healthy: false, code: 'assignment_evidence_unavailable' };
  const issues = rows.map(row => ({ insurer_name: row.insurer_name, status: row.status,
    pile_count: row.pile_count, oldest_at: validDate(row.oldest_at).toISOString() }))
    .sort((a, b) => `${a.insurer_name}:${a.status}`.localeCompare(`${b.insurer_name}:${b.status}`));
  if (scheduler.healthy && issues.length) {
    return { ...scheduler, scheduler, healthy: false, code: 'assignment_issues',
      assignment_issues: issues, incident_key: `assignment_issues:${JSON.stringify(issues)}` };
  }
  if (scheduler.healthy && scheduler.code === 'completed_with_issues') {
    return { ...scheduler, scheduler, healthy: false, code: 'cycle_issues', assignment_issues: issues };
  }
  return { ...scheduler, scheduler, assignment_issues: issues };
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function nonnegativeNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function evaluateScheduleLiveness(snapshot, now = new Date(), thresholdMinutes = 75) {
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
    throw new TypeError('thresholdMinutes must be a positive number');
  }
  const latest = snapshot?.latest || null;
  if (!latest) return { healthy: false, code: 'missing_schedule', latest_id: null, failure_count: 0 };
  const current = validDate(now);
  const started = validDate(latest.started_at);
  if (!current || !started) return { healthy: false, code: 'invalid_schedule_evidence', latest_id: latest.id || null, failure_count: 0 };
  const ageMinutes = Math.max(0, (current - started) / 60000);
  const failureCount = Math.floor(nonnegativeNumber(snapshot.consecutive_failures));
  const base = {
    latest_id: latest.id || null,
    latest_status: latest.status || 'unknown',
    age_minutes: Math.floor(ageMinutes),
    failure_count: failureCount,
  };

  if (failureCount >= 2) return { ...base, healthy: false, code: 'repeated_failures' };
  if (ACTIVE.has(latest.status)) {
    const heartbeat = validDate(latest.heartbeat_at) || started;
    const heartbeatAge = Math.max(0, (current - heartbeat) / 60000);
    return heartbeatAge <= thresholdMinutes
      ? { ...base, healthy: true, code: 'active' }
      : { ...base, healthy: false, code: 'stale_active' };
  }
  if (ageMinutes > thresholdMinutes) return { ...base, healthy: false, code: 'schedule_overdue' };
  if (latest.status === 'failed') return { ...base, healthy: false, code: 'latest_failed' };
  if (latest.status === 'covered_by_active_cycle') {
    return { ...base, healthy: true, code: 'covered_by_active_cycle' };
  }
  if (COMPLETE.has(latest.status)) {
    if (latest.status !== 'completed') {
      return { ...base, healthy: true, code: 'completed_with_issues' };
    }
    const confirmedPiles = nonnegativeNumber(latest.confirmed_piles);
    const plannedPiles = nonnegativeNumber(latest.planned_piles);
    const unresolvedOutcome = [latest.pending_piles, latest.conflict_piles, latest.failed_piles]
      .some((value) => nonnegativeNumber(value) > 0) || plannedPiles > confirmedPiles;
    if (unresolvedOutcome) {
      return { ...base, healthy: true, code: 'completed_with_issues' };
    }
    if (confirmedPiles > 0) {
      return { ...base, healthy: true, code: 'completed_assigned' };
    }
    const unresolvedWork = [
      latest.discovered_piles, latest.planned_piles,
    ].some((value) => nonnegativeNumber(value) > 0);
    return unresolvedWork
      ? { ...base, healthy: true, code: 'completed_with_issues' }
      : { ...base, healthy: true, code: 'completed_empty' };
  }
  return { ...base, healthy: false, code: 'unexpected_terminal_status' };
}
