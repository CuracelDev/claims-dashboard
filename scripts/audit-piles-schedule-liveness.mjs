import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
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
    return Number(latest.confirmed_piles || 0) > 0
      ? { ...base, healthy: true, code: 'completed_assigned' }
      : { ...base, healthy: true, code: 'completed_empty' };
  }
  return { ...base, healthy: false, code: 'unexpected_terminal_status' };
}

export function transitionScheduleLiveness(previousState, result) {
  const incidentKey = result.healthy ? 'healthy' : `${result.code}:${result.latest_id || 'none'}`;
  const previousKey = previousState?.incident_key || null;
  const previousHealthy = previousState?.healthy;
  return {
    notify: previousKey !== incidentKey,
    recovered: result.healthy && previousHealthy === false,
    state: {
      schema_version: 1,
      healthy: result.healthy,
      incident_key: incidentKey,
      code: result.code,
      latest_id: result.latest_id || null,
    },
  };
}

function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  try {
    if (new URL(url).searchParams.get('sslmode') === 'disable') return undefined;
  } catch {}
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}

export async function readScheduleSnapshot(pool) {
  const result = await pool.query(`
    select runner.id, runner.status, runner.started_at, runner.finished_at,
      (select max(insurer.heartbeat_at)
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as heartbeat_at,
      (select coalesce(sum(insurer.confirmed_pile_count), 0)::int
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as confirmed_piles
    from piles_auto_assignment_runner_runs runner
    where runner.run_source = 'schedule'
    order by runner.started_at desc nulls last, runner.created_at desc
    limit 6
  `);
  const latest = result.rows[0] || null;
  let consecutiveFailures = 0;
  for (const row of result.rows) {
    if (row.status !== 'failed') break;
    consecutiveFailures += 1;
  }
  return { latest, consecutive_failures: consecutiveFailures };
}

function parseArguments(argv) {
  const options = { thresholdMinutes: 75, stateFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--threshold-minutes') options.thresholdMinutes = Number(argv[++index]);
    else if (value === '--state-file') options.stateFile = String(argv[++index] || '');
    else throw new Error('Unsupported liveness audit argument');
  }
  if (!Number.isFinite(options.thresholdMinutes) || options.thresholdMinutes <= 0 || options.thresholdMinutes > 1440) {
    throw new Error('threshold minutes must be between 1 and 1440');
  }
  return options;
}

function readState(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeState(path, state) {
  if (!path) return;
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function notifyIfNeeded(transition, result) {
  const webhook = process.env.SLACK_WEBHOOK_HEALTHOPS;
  if (!transition.notify || !webhook) return;
  const text = transition.recovered
    ? `✅ Piles scheduler recovered: ${result.code}. Latest scheduled run ${result.latest_id || 'unavailable'}.`
    : `🚨 Piles scheduler unhealthy: ${result.code}. Latest scheduled run ${result.latest_id || 'unavailable'}.`;
  const response = await fetch(webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error('Piles liveness notification failed');
}

export async function deliverScheduleTransition(
  transition,
  result,
  { notify = notifyIfNeeded, persist = () => {} } = {},
) {
  if (transition.notify) await notify(transition, result);
  persist(transition.state);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: sslFor(process.env.DATABASE_URL), max: 1 });
  let transactionOpen = false;
  try {
    await pool.query('BEGIN READ ONLY');
    transactionOpen = true;
    const snapshot = await readScheduleSnapshot(pool);
    await pool.query('ROLLBACK');
    transactionOpen = false;
    const result = evaluateScheduleLiveness(snapshot, new Date(), options.thresholdMinutes);
    const transition = transitionScheduleLiveness(readState(options.stateFile), result);
    await deliverScheduleTransition(transition, result, {
      persist: (state) => writeState(options.stateFile, state),
    });
    console.log(JSON.stringify({ ...result, notify: transition.notify, recovered: transition.recovered }));
    process.exitCode = result.healthy ? 0 : 20;
  } finally {
    if (transactionOpen) {
      try { await pool.query('ROLLBACK'); } catch {}
    }
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(() => {
    console.error('Piles schedule liveness audit failed safely.');
    process.exitCode = 1;
  });
}
