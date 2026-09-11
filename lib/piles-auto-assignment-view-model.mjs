// Database diagnostic JSON is untrusted: only explicit projections leave here.
const STATUSES = new Set(['queued', 'running', 'completed', 'completed_with_issues', 'partial', 'failed', 'manual_action_required', 'skipped_inactive', 'skipped_overlap', 'covered_by_active_cycle', 'cancelled', 'follow_up_queued']);
const DISPOSITIONS = new Set(['queued', 'claimed', 'covered_by_active_cycle', 'follow_up_queued', 'inactive', 'completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['queued', 'running', 'follow_up_queued']);
const PHASES = new Set(['configuration', 'login', 'navigation', 'scan', 'plan', 'apply', 'verify', 'reconcile', 'final_rescan', 'complete']);
const TIMER_PHASES = new Set(['login', 'navigation', 'scan', 'plan', 'apply', 'verify', 'reconcile', 'final_rescan', 'other']);
const OPERATIONS = new Set(['login', 'open_piles', 'filter', 'pagination', 'planning', 'row_selection', 'modal', 'verification', 'reconciliation', 'final_rescan', 'phase', 'other']);
const OUTCOMES = new Set(['success', 'failed', 'accept', 'retry', 'fail', 'other']);
const SOURCES = { schedule: 'Scheduled', manual: 'Manual', readiness: 'Read-only probe', recovery: 'Recovery' };
const ERRORS = {
  scan_incomplete: 'Some scan contexts did not complete.',
  portal_timeout: 'The portal did not respond within the operation timeout.',
  filter_not_confirmed: 'The requested portal filters could not be confirmed.',
  authentication_failed: 'Portal authentication failed.',
  assignment_conflict: 'Assignment evidence conflicts; manual review is required.',
  assignment_follow_up_required: 'Assignment follow-up is required; review pending reconciliation and issue counts.',
  invalid_configuration: 'Insurer configuration needs review.',
  manual_action_required: 'Manual action is required; no automatic success is implied.',
  workflow_outcome_unconfirmed: 'The workflow outcome could not be confirmed.',
  work_ownership_lost: 'Execution ownership was lost; inspect recovery evidence.',
  worker_capacity_unavailable: 'Waiting for worker capacity.',
  insurer_lock_unavailable: 'Waiting for the active insurer execution.',
  dispatch_stopped: 'Dispatch stopped; unfinished work remains recoverable.',
  worker_attempt_reclaimed: 'The expired worker attempt was superseded by a fenced reclaim.',
  probe_blocked_by_active_insurer: 'Read-only probe blocked by an active insurer.',
  probe_capacity_unavailable: 'Read-only probe blocked by worker capacity.',
  stale_heartbeat_recovered: 'Stale execution was recovered after safety checks.',
  unexpected_error: 'Insurer execution could not complete.',
};
const SUMMARIES = {
  queued: 'Work is queued and waiting for execution.', running: 'Insurer work is in progress.',
  follow_up_queued: 'A follow-up is queued and waiting for the active execution.',
  completed: 'Owned insurer workflows completed; see confirmed assignment counts.',
  completed_with_issues: 'Completed with issues; review insurer outcomes and reconciliation counts.',
  partial: 'Completed with issues (legacy partial outcome).', failed: 'The run failed; review insurer diagnostics.',
  manual_action_required: 'Manual action is required; assignments are not confirmed by this status.',
  skipped_inactive: 'Insurer is inactive by configuration; no execution was requested.',
  skipped_overlap: 'Skipped for overlap (legacy); this does not confirm assignments.',
  covered_by_active_cycle: 'Scheduling acknowledgement: no duplicate execution occurred; another cycle covers this request.',
  cancelled: 'The run was cancelled.', unknown: 'Unknown status; completion is not confirmed.',
};
const member = (value, allowed, fallback = 'unknown') => typeof value === 'string' && allowed.has(value) ? value : fallback;
const own = (object, key) => Object.hasOwn(object, key);
const sourceLabel = (source) => own(SOURCES, source) ? SOURCES[source] : 'Unknown source';
const number = (value, cap = 1e12) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : 0;
  return Number.isFinite(parsed) ? Math.min(cap, Math.max(0, parsed)) : 0;
};
const count = (value) => Math.trunc(number(value));
const opaque = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : '';
const label = (value) => typeof value === 'string' && /^[\p{L}\p{N} '&()._-]{1,160}$/u.test(value) ? value : '';
function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function duration(item, status, now) {
  const start = timestamp(item.started_at), finish = timestamp(item.finished_at);
  if (ACTIVE.has(status) && start) return number(now - Date.parse(start), 1e15);
  if (number(item.duration_ms, 1e15)) return number(item.duration_ms, 1e15);
  return start && finish ? number(Date.parse(finish) - Date.parse(start), 1e15) : 0;
}
function heartbeat(item, status, now) {
  if (!ACTIVE.has(status)) return status === 'unknown' ? 'unknown' : 'not_applicable';
  const at = timestamp(item.heartbeat_at);
  if (!at) return 'missing';
  const age = now - Date.parse(at);
  if (age < 0) return 'unknown';
  // Freshness only: without lock evidence this is not a recovery verdict.
  return age <= 15 * 60 * 1000 ? 'fresh' : 'stale';
}
function safeError(code, message) {
  const normalized = typeof code === 'string' ? code.trim().toLowerCase() : '';
  const known = own(ERRORS, normalized);
  return {
    error_code: known ? normalized : code || message ? 'unknown_error' : '',
    error_message: known ? ERRORS[normalized] : code || message ? 'Operational details redacted; use error_code.' : '',
  };
}
function performance(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set(), output = [];
  for (const value of values.slice(0, 100)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const phase = member(value.phase, TIMER_PHASES, 'other'), operation = member(value.operation, OPERATIONS, 'other');
    const key = `${phase}:${operation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ phase, operation, count: count(value.count), total_ms: number(value.total_ms, 1e15),
      min_ms: number(value.min_ms, 1e15), max_ms: number(value.max_ms, 1e15),
      outcomes: Object.fromEntries([...OUTCOMES].filter((name) => value.outcomes && own(value.outcomes, name)).map((name) => [name, count(value.outcomes[name])])),
    });
  }
  return output;
}
function countsFor(item, contexts, batches) {
  // A later reconciliation updates the original batch, not the terminal
  // insurer snapshot. Count each identified batch once; the last observation
  // wins if a caller supplies it twice. Legacy callers may omit batch IDs.
  batches = [...new Map(batches.map((batch) => [opaque(batch.id) || Symbol(), batch])).values()];
  const sum = (rows, key) => count(rows.reduce((sum, row) => sum + count(row[key]), 0));
  const ledgerOr = (key, fallback) => ACTIVE.has(item.status) || item[key] == null ? fallback : count(item[key]);
  const currentOutcome = (batchKey, insurerKey) => batches.length ? sum(batches, batchKey) : count(item[insurerKey]);
  return {
    contexts_total: contexts.length,
    contexts_complete: contexts.filter((row) => ['complete', 'empty'].includes(row.status)).length,
    contexts_empty: contexts.filter((row) => row.status === 'empty').length,
    contexts_failed: contexts.filter((row) => row.status === 'failed').length,
    contexts_pending: contexts.filter((row) => !['complete', 'empty', 'failed'].includes(row.status)).length,
    discovered_piles: ledgerOr('discovered_pile_count', sum(contexts, 'distinct_pile_count')),
    unassigned_piles: sum(contexts, 'unassigned_pile_count'),
    discovered_claims: ledgerOr('discovered_claim_count', sum(contexts, 'claim_count')),
    planned_piles: ledgerOr('planned_pile_count', sum(batches, 'planned_pile_count')),
    selected_piles: sum(batches, 'selected_pile_count'),
    submitted_piles: ACTIVE.has(item.status) && !count(item.submitted_pile_count) ? null : count(item.submitted_pile_count),
    confirmed_piles: currentOutcome('confirmed_pile_count', 'confirmed_pile_count'),
    reconciliation_pending: currentOutcome('pending_pile_count', 'reconciliation_pending_pile_count'),
    conflicts: currentOutcome('conflict_pile_count', 'conflict_pile_count'),
    failed: currentOutcome('failed_pile_count', 'failed_pile_count'),
    // Manual workflows may have zero attempts; their pile count is not persisted.
    manual_action_required: item.status === 'manual_action_required' || item.error_code === 'manual_action_required' ? null : 0,
  };
}
function requestState(run, workItems) {
  const empty = { state: 'none', count: 0, queued: 0, follow_up_queued: 0 };
  const refs = run.details?.dispatch_requests;
  if (refs === undefined) return empty;
  if (!Array.isArray(refs) || refs.length > 256 || refs.some((ref) => !ref || Object.keys(ref).sort().join(',') !== 'disposition,request_id,work_item_id' || !opaque(ref.request_id) || !opaque(ref.work_item_id) || !DISPOSITIONS.has(ref.disposition))) return { ...empty, state: 'unknown' };
  const owned = new Set(workItems.map((item) => item.id));
  const foreign = refs.filter((ref) => !owned.has(ref.work_item_id));
  if (!foreign.length) return empty;
  const status = run.status === 'started' ? 'running' : member(run.status, STATUSES);
  // Parent finalization validates references. Do not fetch or aggregate foreign
  // outcomes: a still-active requesting parent conservatively remains waiting.
  const state = ACTIVE.has(status) ? 'waiting' : ['completed', 'completed_with_issues', 'covered_by_active_cycle', 'failed', 'manual_action_required'].includes(status) ? 'acknowledged' : 'unknown';
  return { state, count: foreign.length, queued: foreign.filter((ref) => ref.disposition === 'queued').length, follow_up_queued: foreign.filter((ref) => ref.disposition === 'follow_up_queued').length };
}
function publicInsurer(item, contexts, batches, work, source, now) {
  const status = member(item.status, STATUSES);
  return {
    id: opaque(item.id), insurer_name: label(item.insurer_name), status,
    phase: item.phase == null ? (ACTIVE.has(status) ? 'configuration' : 'complete') : member(item.phase, PHASES),
    source_label: sourceLabel(work?.source ?? source), work_disposition: work ? member(work.disposition, DISPOSITIONS) : 'legacy',
    heartbeat_at: timestamp(item.heartbeat_at), heartbeat_state: heartbeat(item, status, now),
    started_at: timestamp(item.started_at), finished_at: timestamp(item.finished_at), duration_ms: duration(item, status, now),
    ...safeError(item.error_code || work?.reason_code, item.error_message), counts: countsFor(item, contexts, batches),
    // Phase lifetimes and nested operation totals must not be added together.
    performance: performance(item.details?.performance),
  };
}
export function toRunnerProgressView(run = {}, insurerRuns = [], contexts = [], batches = [], workItems = [], { now = Date.now() } = {}) {
  let status = run.status === 'started' ? 'running' : member(run.status ?? 'queued', STATUSES);
  const ownRuns = insurerRuns.filter((item) => item.runner_run_id == null || item.runner_run_id === run.id);
  const ownWork = workItems.filter((item) => item.parent_runner_run_id === run.id);
  const insurers = ownRuns.map((item) => {
    const linkedWork = ownWork.find((work) => work.covered_by_insurer_run_id === item.id);
    const markedWorkId = item.details?.dispatch_protocol === 'durable_work_v2'
      && Number.isSafeInteger(item.details?.dispatch_attempt_number)
      && item.details.dispatch_attempt_number > 0
      ? opaque(item.details?.dispatch_work_item_id) : '';
    // Durable children are attempts, not standalone legacy coverage. If their
    // exact work linkage is gone or corrupt, show the preserved attempt as
    // superseded instead of reopening an already-final parent as "running".
    const detached = Boolean(markedWorkId && linkedWork?.id !== markedWorkId);
    const visibleItem = detached
      ? { ...item, status: 'failed', phase: 'complete', error_code: 'worker_attempt_reclaimed', error_message: '' }
      : item;
    return publicInsurer(visibleItem,
      contexts.filter((row) => row.insurer_run_id === item.id), batches.filter((row) => row.insurer_run_id === item.id),
      linkedWork, run.run_source, now);
  });
  const executionIds = new Set(ownRuns.map((item) => item.id));
  for (const work of ownWork.filter((item) => !executionIds.has(item.covered_by_insurer_run_id))) {
    const disposition = member(work.disposition, DISPOSITIONS);
    const workStatus = disposition === 'completed' && work.reason_code === 'manual_action_required' ? 'manual_action_required' : disposition === 'claimed' ? 'running' : disposition === 'inactive' ? 'skipped_inactive' : disposition;
    insurers.push(publicInsurer({ insurer_name: work.insurer_name, status: workStatus, heartbeat_at: work.heartbeat_at,
      started_at: work.started_at, finished_at: work.finished_at, error_code: work.reason_code }, [], [], work, run.run_source, now));
  }
  const active = insurers.filter((item) => ACTIVE.has(item.status));
  if (active.length && status === 'completed') status = 'running';
  const request_state = requestState(run, ownWork);
  if (status === 'completed' && (request_state.state === 'unknown' || insurers.some((item) => item.status === 'unknown'))) status = 'unknown';
  const dispositions = new Set(ownWork.map((item) => member(item.disposition, DISPOSITIONS)));
  const aggregate = countsFor({}, [], []);
  for (const key of Object.keys(aggregate)) aggregate[key] = insurers.some((item) => item.counts[key] === null) ? null : count(insurers.reduce((sum, item) => sum + item.counts[key], 0));
  let summary_text = SUMMARIES[status];
  if (request_state.state === 'waiting') summary_text = 'Waiting for another parent’s insurer generation; no duplicate execution is owned by this request.';
  else if (request_state.state === 'unknown') summary_text = 'Request acknowledgement is unknown; completion is not confirmed.';
  else if (active.some((item) => ['queued', 'follow_up_queued'].includes(item.status))) summary_text = 'Insurer work is queued and waiting; assignments are not yet confirmed.';
  return {
    id: opaque(run.id), status, summary_text, source_label: sourceLabel(run.run_source),
    phase: active[0]?.phase || insurers.at(-1)?.phase || (ACTIVE.has(status) ? 'configuration' : status === 'unknown' ? 'unknown' : 'complete'),
    heartbeat_at: insurers.map((item) => item.heartbeat_at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null,
    heartbeat_state: status === 'unknown' ? 'unknown' : !ACTIVE.has(status) ? 'not_applicable' : ['stale', 'unknown', 'missing', 'fresh'].find((state) => active.some((item) => item.heartbeat_state === state)) || 'missing',
    run_scope: member(run.run_scope ?? 'single', new Set(['single', 'all-active', 'all_active', 'single_insurer'])), insurer_name: label(run.insurer_name),
    portal_environment: member(run.portal_environment ?? 'production', new Set(['production', 'test', 'staging', 'local'])),
    backend: member(run.backend ?? 'local', new Set(['local', 'production', 'github', 'remote'])), mode: member(run.mode ?? 'dry-run', new Set(['dry-run', 'execute'])),
    months: Array.isArray(run.months) ? run.months.slice(0, 12).filter((value) => typeof value === 'string' && /^(All|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)$/.test(value)) : [],
    year: typeof run.year === 'string' && /^(All|\d{4})$/.test(run.year) ? run.year : '',
    started_at: timestamp(run.started_at), finished_at: timestamp(run.finished_at), duration_ms: duration(run, status, now),
    work_disposition: dispositions.size > 1 ? 'mixed' : [...dispositions][0] || (request_state.state === 'waiting' ? 'waiting' : request_state.state === 'acknowledged' ? 'covered_by_active_cycle' : 'legacy'),
    request_state, insurers, counts: aggregate,
  };
}
