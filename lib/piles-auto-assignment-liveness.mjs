const ACTIVE = new Set(['queued', 'started', 'running']);
const COMPLETE = new Set(['completed', 'completed_with_issues', 'partial']);

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
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
  const failureCount = Math.max(0, Number(snapshot.consecutive_failures || 0));
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
  if (COMPLETE.has(latest.status)) {
    if (latest.status !== 'completed') {
      return { ...base, healthy: true, code: 'completed_with_issues' };
    }
    return Number(latest.confirmed_piles || 0) > 0
      ? { ...base, healthy: true, code: 'completed_assigned' }
      : { ...base, healthy: true, code: 'completed_empty' };
  }
  return { ...base, healthy: false, code: 'unexpected_terminal_status' };
}
