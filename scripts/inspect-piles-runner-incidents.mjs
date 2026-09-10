import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;

export const WORK_ITEMS_TABLE = 'piles_auto_assignment_work_items';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_FIELDS = Object.freeze({
  parents: [
    'id', 'insurer_name', 'run_scope', 'backend', 'run_source', 'mode', 'status',
    'started_at', 'finished_at', 'duration_ms', 'created_at', 'updated_at',
  ],
  insurers: [
    'id', 'runner_run_id', 'insurer_name', 'status', 'phase',
    'discovered_pile_count', 'discovered_claim_count', 'planned_pile_count',
    'planned_claim_count', 'submitted_pile_count', 'submitted_claim_count',
    'confirmed_pile_count', 'confirmed_claim_count',
    'reconciliation_pending_pile_count', 'reconciliation_pending_claim_count',
    'conflict_pile_count', 'failed_pile_count', 'error_code', 'error_message',
    'heartbeat_at', 'heartbeat_age_seconds', 'started_at', 'finished_at',
    'duration_ms', 'created_at', 'updated_at',
  ],
  contexts: [
    'id', 'insurer_run_id', 'insurer_name', 'filter_month', 'requested_year',
    'status_bucket', 'status', 'page_count', 'distinct_pile_count',
    'unassigned_pile_count', 'claim_count', 'error_code', 'error_message',
    'started_at', 'settled_at', 'finished_at', 'created_at', 'updated_at',
  ],
  batches: [
    'id', 'insurer_run_id', 'scan_context_id', 'insurer_name', 'status_bucket',
    'status', 'planned_pile_count', 'planned_claim_count', 'selected_pile_count',
    'confirmed_pile_count', 'pending_pile_count', 'conflict_pile_count',
    'failed_pile_count', 'attempt_count', 'submitted_at', 'finished_at',
    'created_at', 'updated_at',
  ],
  attempt_states: ['insurer_run_id', 'insurer_name', 'status', 'attempt_count', 'claim_count'],
  pending_requests: [
    'id', 'insurer_name', 'requested_runner_run_id', 'status',
    'claimed_by_runner_run_id', 'requested_at', 'claimed_at', 'created_at', 'updated_at',
  ],
  work_items: [
    'id', 'parent_runner_run_id', 'insurer_name', 'source', 'request_scope',
    'disposition', 'covered_by_insurer_run_id', 'worker_id', 'attempt_number',
    'lease_expires_at', 'heartbeat_at', 'heartbeat_age_seconds',
    'generation_requested_at', 'requested_at', 'claimed_at', 'started_at',
    'finished_at', 'reason_code', 'created_at', 'updated_at',
  ],
});

export function parseInspectorArgs(argv) {
  const options = { hours: 24, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--hours') {
      const value = argv[index + 1];
      if (!/^\d+$/.test(value ?? '')) throw new Error('hours must be an integer from 1 to 168');
      options.hours = Number(value);
      index += 1;
      continue;
    }
    if (argument === '--run-id') {
      const value = argv[index + 1];
      if (!UUID_PATTERN.test(value ?? '')) throw new Error('run-id must be a UUID');
      options.runId = value.toLowerCase();
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}. Usage: --hours <1..168> [--run-id <uuid>]`);
  }
  if (!Number.isInteger(options.hours) || options.hours < 1 || options.hours > 168) {
    throw new Error('hours must be an integer from 1 to 168');
  }
  return options;
}

function query(text, hours, runId) {
  return { text, values: [hours, runId] };
}

export function buildIncidentQueries({ hours, runId, workItemsAvailable }) {
  const queries = {
    parents: query(`
      select id, insurer_name, run_scope, backend, run_source, mode, status,
             started_at, finished_at, duration_ms, created_at, updated_at
      from piles_auto_assignment_runner_runs
      where created_at >= now() - ($1::int * interval '1 hour')
        and ($2::text is null or id = $2::text)
      order by created_at desc
    `, hours, runId),
    insurers: query(`
      select id, runner_run_id, insurer_name, status, phase,
             discovered_pile_count, discovered_claim_count,
             planned_pile_count, planned_claim_count,
             submitted_pile_count, submitted_claim_count,
             confirmed_pile_count, confirmed_claim_count,
             reconciliation_pending_pile_count, reconciliation_pending_claim_count,
             conflict_pile_count, failed_pile_count,
             regexp_replace(lower(trim(coalesce(error_code, 'unknown'))), '[^a-z0-9._-]+', '_', 'g') as error_code,
             regexp_replace(left(coalesce(error_message, ''), 240), '[[:cntrl:]]+', ' ', 'g') as error_message,
             heartbeat_at,
             case when heartbeat_at is null then null
                  else greatest(0, extract(epoch from (now() - heartbeat_at)))::int
             end as heartbeat_age_seconds,
             started_at, finished_at,
             greatest(0, extract(epoch from (coalesce(finished_at, now()) - started_at)) * 1000)::bigint as duration_ms,
             created_at, updated_at
      from piles_auto_assignment_insurer_runs
      where (($2::text is null and created_at >= now() - ($1::int * interval '1 hour'))
             or runner_run_id = $2::text)
      order by created_at desc
    `, hours, runId),
    contexts: query(`
      select c.id, c.insurer_run_id, c.insurer_name, c.filter_month, c.requested_year,
             c.status_bucket, c.status, c.page_count, c.distinct_pile_count,
             c.unassigned_pile_count, c.claim_count,
             regexp_replace(lower(trim(coalesce(c.error_code, 'unknown'))), '[^a-z0-9._-]+', '_', 'g') as error_code,
             regexp_replace(left(coalesce(c.error_message, ''), 240), '[[:cntrl:]]+', ' ', 'g') as error_message,
             c.started_at, c.settled_at, c.finished_at, c.created_at, c.updated_at
      from piles_auto_assignment_scan_contexts c
      join piles_auto_assignment_insurer_runs i on i.id = c.insurer_run_id
      where (($2::text is null and i.created_at >= now() - ($1::int * interval '1 hour'))
             or i.runner_run_id = $2::text)
      order by c.created_at desc
    `, hours, runId),
    batches: query(`
      select b.id, b.insurer_run_id, b.scan_context_id, b.insurer_name,
             b.status_bucket, b.status, b.planned_pile_count, b.planned_claim_count,
             b.selected_pile_count, b.confirmed_pile_count, b.pending_pile_count,
             b.conflict_pile_count, b.failed_pile_count, b.attempt_count,
             b.submitted_at, b.finished_at, b.created_at, b.updated_at
      from piles_auto_assignment_batches b
      join piles_auto_assignment_insurer_runs i on i.id = b.insurer_run_id
      where (($2::text is null and i.created_at >= now() - ($1::int * interval '1 hour'))
             or i.runner_run_id = $2::text)
      order by b.created_at desc
    `, hours, runId),
    attempt_states: query(`
      select a.insurer_run_id, a.insurer_name, a.status,
             count(*)::int as attempt_count, coalesce(sum(a.claim_count), 0)::int as claim_count
      from piles_auto_assignment_attempts a
      join piles_auto_assignment_insurer_runs i on i.id = a.insurer_run_id
      where (($2::text is null and i.created_at >= now() - ($1::int * interval '1 hour'))
             or i.runner_run_id = $2::text)
      group by a.insurer_run_id, a.insurer_name, a.status
      order by a.insurer_run_id, a.status
    `, hours, runId),
    pending_requests: query(`
      select id, insurer_name, requested_runner_run_id, status,
             claimed_by_runner_run_id, requested_at, claimed_at, created_at, updated_at
      from piles_auto_assignment_schedule_requests
      where status = 'pending'
        and (($2::text is null and created_at >= now() - ($1::int * interval '1 hour'))
             or requested_runner_run_id = $2::text or claimed_by_runner_run_id = $2::text)
      order by requested_at desc
    `, hours, runId),
  };

  if (workItemsAvailable) {
    queries.work_items = query(`
      select id, parent_runner_run_id, insurer_name, source, request_scope, disposition,
             covered_by_insurer_run_id, worker_id, attempt_number, lease_expires_at,
             heartbeat_at,
             case when heartbeat_at is null then null
                  else greatest(0, extract(epoch from (now() - heartbeat_at)))::int
             end as heartbeat_age_seconds,
             generation_requested_at, requested_at, claimed_at, started_at, finished_at,
             regexp_replace(lower(trim(coalesce(reason_code, ''))), '[^a-z0-9._-]+', '_', 'g') as reason_code,
             created_at, updated_at
      from piles_auto_assignment_work_items
      where (($2::text is null and created_at >= now() - ($1::int * interval '1 hour'))
             or parent_runner_run_id = $2::text)
      order by created_at desc
    `, hours, runId);
  }

  return queries;
}

function normalizeErrorCode(value) {
  const normalized = String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return normalized || 'unknown';
}

function sanitizeMessage(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bpostgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://[REDACTED]@')
    .slice(0, 240);
}

function projectRows(section, rows) {
  return rows.map((row) => {
    const projected = {};
    for (const field of SAFE_FIELDS[section]) {
      if (row[field] !== undefined) projected[field] = row[field];
    }
    if ('error_code' in projected) projected.error_code = normalizeErrorCode(projected.error_code);
    if ('reason_code' in projected) projected.reason_code = normalizeErrorCode(projected.reason_code);
    if ('error_message' in projected) projected.error_message = sanitizeMessage(projected.error_message);
    return projected;
  });
}

export function buildIncidentReport({ hours, runId, workItemsAvailable, sections }) {
  const report = {
    generated_at: new Date().toISOString(),
    window_hours: hours,
    selected_run_id: runId,
    work_items_available: workItemsAvailable,
  };
  for (const section of ['parents', 'insurers', 'contexts', 'batches', 'attempt_states', 'pending_requests']) {
    report[section] = projectRows(section, sections[section] ?? []);
  }
  if (workItemsAvailable) report.work_items = projectRows('work_items', sections.work_items ?? []);
  return report;
}

export async function inspectIncidents(client, options) {
  try {
    await client.query('BEGIN READ ONLY');
    const availability = await client.query(
      'select to_regclass($1::text) is not null as work_items_available',
      [WORK_ITEMS_TABLE],
    );
    const workItemsAvailable = availability.rows[0]?.work_items_available === true;
    const queries = buildIncidentQueries({ ...options, workItemsAvailable });
    const sections = {};
    for (const [section, statement] of Object.entries(queries)) {
      sections[section] = (await client.query(statement)).rows;
    }
    return buildIncidentReport({ ...options, workItemsAvailable, sections });
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function runInspector(databaseUrl, options) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client;
  try {
    client = await pool.connect();
    return await inspectIncidents(client, options);
  } finally {
    client?.release();
    await pool.end();
  }
}

async function main() {
  const options = parseInspectorArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('database URL is required'), { code: 'missing_database_url' });
  const report = await runInspector(process.env.DATABASE_URL, options);
  console.log(JSON.stringify(report, null, 2));
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    const code = normalizeErrorCode(error?.code ?? 'inspection_failed');
    console.error(`Incident inspection failed (${code}).`);
    process.exitCode = 1;
  });
}
