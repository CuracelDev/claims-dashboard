import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { evaluateScheduleLiveness } from '../lib/piles-auto-assignment-liveness.mjs';

export { evaluateScheduleLiveness } from '../lib/piles-auto-assignment-liveness.mjs';

const { Pool } = pg;

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
       where insurer.runner_run_id = runner.id) as confirmed_piles,
      (select coalesce(sum(insurer.discovered_pile_count), 0)::int
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as discovered_piles,
      (select coalesce(sum(insurer.planned_pile_count), 0)::int
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as planned_piles,
      (select coalesce(sum(insurer.reconciliation_pending_pile_count), 0)::int
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as pending_piles,
      (select coalesce(sum(insurer.conflict_pile_count), 0)::int
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as conflict_piles,
      (select coalesce(sum(insurer.failed_pile_count), 0)::int
       from piles_auto_assignment_insurer_runs insurer
       where insurer.runner_run_id = runner.id) as failed_piles
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
