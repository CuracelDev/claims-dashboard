const number = (value) => Math.max(0, Number(value) || 0);
const text = (value, limit = 500) => String(value ?? '').slice(0, limit);

function publicInsurer(item, contexts, batches) {
  const ownContexts = contexts.filter((context) => context.insurer_run_id === item.id);
  const ownBatches = batches.filter((batch) => batch.insurer_run_id === item.id);
  return {
    id: text(item.id, 100),
    insurer_name: text(item.insurer_name, 160),
    status: text(item.status || 'queued', 40),
    phase: text(item.phase || 'configuration', 40),
    heartbeat_at: item.heartbeat_at || null,
    started_at: item.started_at || null,
    finished_at: item.finished_at || null,
    error_code: text(item.error_code, 80),
    error_message: text(item.error_message, 500),
    counts: {
      contexts_total: ownContexts.length,
      contexts_complete: ownContexts.filter((context) => ['complete', 'empty'].includes(context.status)).length,
      planned_piles: ownBatches.reduce((sum, batch) => sum + number(batch.planned_pile_count), 0),
      confirmed_piles: ownBatches.reduce((sum, batch) => sum + number(batch.confirmed_pile_count), 0),
      reconciliation_pending: ownBatches.reduce((sum, batch) => sum + number(batch.pending_pile_count), 0),
      conflicts: ownBatches.reduce((sum, batch) => sum + number(batch.conflict_pile_count), 0),
      failed: ownBatches.reduce((sum, batch) => sum + number(batch.failed_pile_count), 0),
    },
  };
}

export function toRunnerProgressView(run = {}, insurerRuns = [], contexts = [], batches = []) {
  const insurers = insurerRuns.map((item) => publicInsurer(item, contexts, batches));
  const active = insurers.find((item) => ['queued', 'running'].includes(item.status));
  const latestHeartbeat = insurers.map((item) => item.heartbeat_at).filter(Boolean).sort().at(-1) || null;
  const status = run.status === 'started' ? 'running' : text(run.status || 'queued', 40);
  return {
    id: text(run.id, 100),
    status,
    phase: active?.phase || insurers.at(-1)?.phase || (status === 'queued' ? 'configuration' : 'complete'),
    heartbeat_at: latestHeartbeat,
    run_scope: text(run.run_scope || 'single', 40),
    insurer_name: text(run.insurer_name, 160),
    portal_environment: text(run.portal_environment || 'production', 20),
    backend: text(run.backend || 'local', 20),
    mode: text(run.mode || 'dry-run', 20),
    months: Array.isArray(run.months) ? run.months.map((item) => text(item, 10)).slice(0, 12) : [],
    year: text(run.year, 10),
    started_at: run.started_at || null,
    finished_at: run.finished_at || null,
    duration_ms: number(run.duration_ms),
    insurers,
    counts: {
      contexts_total: contexts.length,
      contexts_complete: contexts.filter((context) => ['complete', 'empty'].includes(context.status)).length,
      discovered_piles: contexts.reduce((sum, context) => sum + number(context.distinct_pile_count), 0),
      unassigned_piles: contexts.reduce((sum, context) => sum + number(context.unassigned_pile_count), 0),
      discovered_claims: contexts.reduce((sum, context) => sum + number(context.claim_count), 0),
      planned_piles: batches.reduce((sum, batch) => sum + number(batch.planned_pile_count), 0),
      confirmed_piles: batches.reduce((sum, batch) => sum + number(batch.confirmed_pile_count), 0),
      reconciliation_pending: batches.reduce((sum, batch) => sum + number(batch.pending_pile_count), 0),
      conflicts: batches.reduce((sum, batch) => sum + number(batch.conflict_pile_count), 0),
      failed: batches.reduce((sum, batch) => sum + number(batch.failed_pile_count), 0),
    },
  };
}
