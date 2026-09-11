// Presentation consumes only the server's safe history view, never raw run JSON.
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds % 60}s`;
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value).toLocaleString('en-GB') : 'Unknown';
}

export function isRunnerActive(run) {
  const active = (item) => ['queued', 'running', 'follow_up_queued'].includes(item?.status)
    || (item?.status === 'unknown' && !item.finished_at);
  return active(run) || run?.request_state?.state === 'waiting' || (run?.insurers || []).some(active);
}

const STATUSES = {
  completed: ['Completed', 'success', 'Owned insurer workflows completed; see confirmed assignment counts.'],
  completed_with_issues: ['Completed with issues', 'warning', 'Review insurer errors, manual action and reconciliation counts; not all work completed cleanly.'],
  partial: ['Completed with issues (legacy)', 'warning', 'Legacy mixed outcome; review each insurer and its assignment evidence.'],
  failed: ['Failed', 'danger', 'Execution failed; review the insurer phase and safe error below.'],
  manual_action_required: ['Manual action required', 'warning', 'Manual review is required; this status does not confirm assignments.'],
  covered_by_active_cycle: ['Covered by active cycle', 'info', 'Another cycle covers this request; no duplicate execution occurred. This is not an assignment success.'],
  follow_up_queued: ['Follow-up queued', 'warning', 'A follow-up is waiting for the active insurer execution; assignments are not yet confirmed.'],
  queued: ['Queued', 'info', 'Work is waiting for execution; assignments are not yet confirmed.'],
  waiting: ['Waiting', 'warning', 'Waiting for another parent’s insurer generation; no duplicate execution is owned by this request.'],
  running: ['Running', 'info', 'Work is in progress; check heartbeat freshness separately from elapsed duration.'],
  skipped_inactive: ['Inactive — not run', 'neutral', 'Insurer is inactive by configuration; no execution was requested.'],
  skipped_overlap: ['Skipped for overlap (legacy)', 'neutral', 'Legacy overlap handling skipped this run; assignments are not confirmed by this status.'],
  cancelled: ['Cancelled', 'neutral', 'Work was cancelled; review any recorded assignment evidence.'],
  unknown: ['Unknown status', 'neutral', 'Completion is not confirmed; the recorded status is not recognized.'],
};

export function statusPresentation(status) {
  const [label, tone, explanation] = STATUSES[Object.hasOwn(STATUSES, status) ? status : 'unknown'];
  return { label, tone, explanation };
}

export function heartbeatPresentation(state, durationMs) {
  if (state === 'fresh') return {
    label: durationMs >= 3600000 ? 'Long-running · fresh heartbeat' : 'Fresh heartbeat', tone: 'info',
    explanation: 'Recent heartbeat activity is recorded. A long duration alone does not mean work is stuck.',
  };
  if (state === 'stale') return {
    label: 'Stale heartbeat', tone: 'warning',
    explanation: 'Heartbeat has expired. Insurer locks are not checked here; inspect recovery evidence before taking action.',
  };
  if (state === 'not_applicable') return { label: 'Heartbeat not applicable', tone: 'neutral', explanation: 'This outcome is not active.' };
  if (state === 'missing') return { label: 'No heartbeat recorded', tone: 'warning', explanation: 'Activity is not yet evidenced by a heartbeat; elapsed duration does not establish a stuck run.' };
  return { label: 'Heartbeat unknown', tone: 'neutral', explanation: 'Heartbeat freshness cannot be confirmed.' };
}

export function summarizeInsurerOutcomes(insurers = []) {
  if (!insurers.length) return 'No insurer details recorded.';
  const groups = { completed: 0, failed: 0, 'awaiting reconciliation': 0, 'completed with issues': 0,
    'manual action required': 0, waiting: 0, running: 0, 'covered (no duplicate execution)': 0,
    inactive: 0, cancelled: 0, 'skipped for overlap (legacy)': 0, unknown: 0 };
  for (const insurer of insurers) {
    const status = insurer?.status;
    let group = 'unknown';
    if (status === 'failed') group = 'failed';
    else if (status === 'manual_action_required' || insurer?.error_code === 'manual_action_required') group = 'manual action required';
    else if (['queued', 'follow_up_queued', 'waiting'].includes(status)) group = 'waiting';
    else if (status === 'running') group = 'running';
    else if (['completed', 'completed_with_issues', 'partial'].includes(status)) {
      group = insurer?.counts?.reconciliation_pending > 0 ? 'awaiting reconciliation'
        : status === 'completed' ? 'completed' : 'completed with issues';
    } else if (status === 'covered_by_active_cycle') group = 'covered (no duplicate execution)';
    else if (status === 'skipped_inactive') group = 'inactive';
    else if (status === 'cancelled') group = 'cancelled';
    else if (status === 'skipped_overlap') group = 'skipped for overlap (legacy)';
    groups[group] += 1;
  }
  return Object.entries(groups).filter(([, count]) => count > 0).map(([group, count]) => `${count} ${group}`).join(', ');
}
