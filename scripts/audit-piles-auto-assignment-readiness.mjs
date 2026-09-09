import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;
const modeArg = process.argv.find((value) => value.startsWith('--mode='))?.split('=')[1]
  || process.argv[process.argv.indexOf('--mode') + 1]
  || 'local';
const REQUIRED_TABLES = [
  'piles_auto_assignment_master_accounts', 'piles_auto_assignment_bot_accounts',
  'piles_auto_assignment_rules', 'piles_auto_assignment_runner_runs',
  'piles_auto_assignment_insurer_runs', 'piles_auto_assignment_scan_contexts',
  'piles_auto_assignment_batches', 'piles_auto_assignment_attempts',
  'piles_auto_assignment_bot_account_history', 'piles_auto_assignment_schedule_requests',
];

function report(name, ok, detail) {
  const item = { name, ok, detail };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
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

function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  try {
    if (new URL(url).searchParams.get('sslmode') === 'disable') return undefined;
  } catch {}
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}

async function databaseChecks() {
  const deploymentMode = modeArg === 'deployment';
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return [report('database connection', false, 'DATABASE_URL is required for database mode')];
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString), max: 1 });
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
    const [linkage, owners, stale, pending, unsupported] = await Promise.all([
      pool.query(`select count(*)::int count from piles_auto_assignment_master_accounts m left join piles_auto_assignment_rules r on lower(r.insurer_name)=lower(m.insurer_name) and r.is_active=true where m.is_active=true and r.id is null`),
      pool.query(`select count(*)::int count from piles_auto_assignment_master_accounts m where m.is_active=true and not exists (select 1 from piles_auto_assignment_bot_accounts b where lower(b.insurer_name)=lower(m.insurer_name) and b.is_active=true and b.is_available=true)`),
      pool.query(`select count(*)::int count from piles_auto_assignment_insurer_runs where status='running' and coalesce(heartbeat_at, started_at, created_at) < now() - interval '15 minutes'`),
      pool.query(`select count(*)::int count from piles_auto_assignment_attempts where status='reconciliation_pending' and updated_at < now() - interval '30 minutes'`),
      pool.query(`select count(*)::int count from piles_auto_assignment_rules where distribution_mode not in ('balanced_finish','single_owner','manual_override') or minimum_claim_chunk < 1`),
    ]);
    checks.push(
      report('active insurer rules', linkage.rows[0].count === 0, `${linkage.rows[0].count} active insurers without an active rule`),
      report('eligible owners', owners.rows[0].count === 0, `${owners.rows[0].count} active insurers without an eligible owner`),
      report(
        'stale heartbeats',
        deploymentMode || stale.rows[0].count === 0,
        `${stale.rows[0].count} running insurer records stale over 15 minutes${deploymentMode && stale.rows[0].count ? ' (runtime warning; repair deployment allowed)' : ''}`,
      ),
      report(
        'pending reconciliation age',
        deploymentMode || pending.rows[0].count === 0,
        `${pending.rows[0].count} attempts pending over 30 minutes${deploymentMode && pending.rows[0].count ? ' (runtime warning; repair deployment allowed)' : ''}`,
      ),
      report('supported rule values', unsupported.rows[0].count === 0, `${unsupported.rows[0].count} unsupported rule rows`),
    );
    await pool.query('ROLLBACK');
    return checks;
  } finally {
    await pool.end();
  }
}

const results = modeArg === 'local' ? localChecks() : await databaseChecks();
if (!results.every((result) => result.ok)) process.exitCode = 1;
