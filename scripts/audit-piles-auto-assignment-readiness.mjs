import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const modeFlagIndex = process.argv.indexOf('--mode');
const modeArg = process.argv.find((value) => value.startsWith('--mode='))?.split('=')[1]
  || (modeFlagIndex >= 0 ? process.argv[modeFlagIndex + 1] : '')
  || 'local';
const REQUIRED_TABLES = [
  'piles_auto_assignment_master_accounts', 'piles_auto_assignment_bot_accounts',
  'piles_auto_assignment_rules', 'piles_auto_assignment_runner_runs',
  'piles_auto_assignment_insurer_runs', 'piles_auto_assignment_scan_contexts',
  'piles_auto_assignment_batches', 'piles_auto_assignment_attempts',
  'piles_auto_assignment_bot_account_history', 'piles_auto_assignment_schedule_requests',
  'piles_auto_assignment_work_items',
];

function report(name, ok, detail, severity = ok ? 'pass' : 'error') {
  const item = { name, ok, detail, severity };
  const label = severity === 'warning' ? 'WARN' : ok ? 'PASS' : 'FAIL';
  console.log(`${label} ${name}: ${detail}`);
  return item;
}

function localChecks() {
  const schema = readFileSync(new URL('./piles-auto-assignment-schema.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('./piles_auto_assignment_runner.py', import.meta.url), 'utf8');
  return [
    report('additive schema', REQUIRED_TABLES.every((table) => schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`)), `${REQUIRED_TABLES.length} required table definitions`),
    report('attempt idempotency', schema.includes('piles_auto_assignment_attempts_active_key_idx'), 'active pile key is unique'),
    report('transactional bot history', schema.includes('piles_update_bot_account_with_history'), 'audited mutation function is defined'),
    report('read-only execute guard', runner.includes('--read-only cannot be combined with --execute'), 'probe cannot click Assign Claims'),
    report('insurer overlap coalescing', runner.includes('mark_coalesced_request'), 'overlaps become one pending follow-up'),
  ];
}

export function evaluateQueueHealth(findings, { deploymentMode = false } = {}) {
  const values = [
    ['queued work without a live worker', findings.queuedWithoutLiveWorker, false],
    ['expired claim leases', findings.expiredLeases, false],
    ['expired work with free insurer lock', findings.expiredLeasesWithFreeLock, true],
    ['duplicate active canonical insurers', findings.duplicateActiveCanonicalInsurers, true],
    ['legacy pending requests', findings.legacyPendingRows, false],
  ];
  return values.map(([name, count, unsafe]) => {
    const numericCount = Number(count || 0);
    const isError = numericCount > 0 && unsafe && !deploymentMode;
    const severity = isError ? 'error' : numericCount > 0 ? 'warning' : 'pass';
    return { name, ok: !isError, detail: `${numericCount} row(s)`, severity };
  });
}

export async function inspectQueueHealth(pool) {
  const queued = await pool.query(`
    select count(*)::int as queued_without_live_worker
    from piles_auto_assignment_work_items queued_work
    where queued_work.disposition in ('queued', 'follow_up_queued')
      and queued_work.requested_at < now() - interval '5 minutes'
      and not exists (
        select 1 from piles_auto_assignment_work_items live_work
        where live_work.parent_runner_run_id is not distinct from queued_work.parent_runner_run_id
          and live_work.disposition = 'claimed'
          and live_work.lease_expires_at > now()
          and live_work.heartbeat_at >= now() - interval '5 minutes'
      )
  `);
  const expired = await pool.query(`
    select canonical_insurer_name, count(*)::int as expired_lease_count
    from piles_auto_assignment_work_items
    where disposition = 'claimed'
      and lease_expires_at <= now()
    group by canonical_insurer_name
    order by canonical_insurer_name
  `);
  const duplicates = await pool.query(`
    select count(*)::int as duplicate_active_canonical_insurers
    from (
      select canonical_insurer_name
      from piles_auto_assignment_work_items
      where disposition = 'claimed'
      group by canonical_insurer_name
      having count(*) > 1
    ) duplicate_insurers
  `);
  const legacy = await pool.query(`
    select count(*)::int as legacy_pending_rows
    from piles_auto_assignment_schedule_requests
    where status = 'pending'
  `);

  let expiredLeasesWithFreeLock = 0;
  for (const row of expired.rows) {
    const lockName = `piles-insurer:${row.canonical_insurer_name}`;
    const probe = await pool.query(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
      [lockName],
    );
    if (probe.rows[0]?.acquired) {
      expiredLeasesWithFreeLock += Number(row.expired_lease_count || 1);
      await pool.query(
        'select pg_advisory_unlock(hashtextextended($1, 0)) as released',
        [lockName],
      );
    }
  }

  return {
    queuedWithoutLiveWorker: queued.rows[0]?.queued_without_live_worker || 0,
    expiredLeases: expired.rows.reduce(
      (total, row) => total + Number(row.expired_lease_count || 1),
      0,
    ),
    expiredLeasesWithFreeLock,
    duplicateActiveCanonicalInsurers: duplicates.rows[0]?.duplicate_active_canonical_insurers || 0,
    legacyPendingRows: legacy.rows[0]?.legacy_pending_rows || 0,
  };
}

function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  try {
    if (new URL(url).searchParams.get('sslmode') === 'disable') return undefined;
  } catch {}
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}

export async function databaseChecks({ pool: suppliedPool, deploymentMode: suppliedDeploymentMode } = {}) {
  const deploymentMode = suppliedDeploymentMode ?? false;
  const connectionString = process.env.DATABASE_URL;
  if (!suppliedPool && !connectionString) return [report('database connection', false, 'DATABASE_URL is required for database mode')];
  const pool = suppliedPool || new Pool({ connectionString, ssl: sslFor(connectionString), max: 1 });
  try {
    await pool.query('BEGIN READ ONLY');
    const tableResult = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)`,
      [REQUIRED_TABLES],
    );
    const present = new Set(tableResult.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    const checks = [report('database schema', missing.length === 0, missing.length ? `${missing.length} required tables missing` : 'all required tables present')];
    if (missing.length) {
      await pool.query('ROLLBACK');
      return checks;
    }
    const [linkage, owners, stale, pending, unsupported, queueHealth] = await Promise.all([
      pool.query(`select count(*)::int count from piles_auto_assignment_master_accounts m left join piles_auto_assignment_rules r on lower(r.insurer_name)=lower(m.insurer_name) and r.is_active=true where m.is_active=true and r.id is null`),
      pool.query(`select count(*)::int count from piles_auto_assignment_master_accounts m where m.is_active=true and not exists (select 1 from piles_auto_assignment_bot_accounts b where lower(b.insurer_name)=lower(m.insurer_name) and b.is_active=true and b.is_available=true)`),
      pool.query(`select count(*)::int count from piles_auto_assignment_insurer_runs where status='running' and coalesce(heartbeat_at, started_at, created_at) < now() - interval '15 minutes'`),
      pool.query(`select count(*)::int count from piles_auto_assignment_attempts where status='reconciliation_pending' and updated_at < now() - interval '30 minutes'`),
      pool.query(`select count(*)::int count from piles_auto_assignment_rules where distribution_mode not in ('balanced_finish','single_owner','manual_override') or minimum_claim_chunk < 1`),
      inspectQueueHealth(pool),
    ]);
    checks.push(
      report('active insurer rules', linkage.rows[0].count === 0, `${linkage.rows[0].count} active insurers without an active rule`),
      report('eligible owners', owners.rows[0].count === 0, `${owners.rows[0].count} active insurers without an eligible owner`),
      report(
        'stale heartbeats',
        deploymentMode || stale.rows[0].count === 0,
        `${stale.rows[0].count} running insurer records stale over 15 minutes${deploymentMode && stale.rows[0].count ? ' (runtime warning; repair deployment allowed)' : ''}`,
        deploymentMode && stale.rows[0].count ? 'warning' : undefined,
      ),
      report(
        'pending reconciliation age',
        deploymentMode || pending.rows[0].count === 0,
        `${pending.rows[0].count} attempts pending over 30 minutes${deploymentMode && pending.rows[0].count ? ' (runtime warning; repair deployment allowed)' : ''}`,
        deploymentMode && pending.rows[0].count ? 'warning' : undefined,
      ),
      report('supported rule values', unsupported.rows[0].count === 0, `${unsupported.rows[0].count} unsupported rule rows`),
      ...evaluateQueueHealth(queueHealth, { deploymentMode }).map((item) => (
        report(item.name, item.ok, item.detail, item.severity)
      )),
    );
    await pool.query('ROLLBACK');
    return checks;
  } finally {
    if (!suppliedPool) await pool.end();
  }
}

async function main() {
  const deploymentMode = modeArg === 'deployment';
  const results = modeArg === 'local' ? localChecks() : await databaseChecks({ deploymentMode });
  if (!results.every((result) => result.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
