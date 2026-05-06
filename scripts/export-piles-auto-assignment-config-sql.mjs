import fs from 'fs';
import { Pool } from 'pg';

function loadLocalEnv() {
  if (!fs.existsSync('.env.local')) return;
  const lines = fs.readFileSync('.env.local', 'utf8').split(/\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

function shouldUseSsl(url) {
  const explicit = process.env.DATABASE_SSL;
  if (explicit === 'false') return false;
  if (explicit === 'true') return true;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('sslmode')?.toLowerCase() !== 'disable';
  } catch {
    return true;
  }
}

const pool = new Pool({
  connectionString: databaseUrl,
  ...(shouldUseSsl(databaseUrl)
    ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } }
    : {}),
});

const TABLES = [
  {
    name: 'piles_auto_assignment_master_accounts',
    columns: ['id', 'insurer_name', 'login_email', 'login_password', 'notes', 'is_active', 'last_password_update', 'created_at', 'updated_at'],
  },
  {
    name: 'piles_auto_assignment_bot_accounts',
    columns: ['id', 'master_account_id', 'insurer_name', 'owner_name', 'bot_name', 'bot_email', 'bot_password', 'assignment_role', 'support_capacity_ratio', 'availability_status', 'availability_note', 'notes', 'is_active', 'is_available', 'priority_order', 'current_claim_load', 'last_assigned_at', 'last_completed_at', 'created_at', 'updated_at'],
  },
  {
    name: 'piles_auto_assignment_rules',
    columns: ['id', 'master_account_id', 'insurer_name', 'distribution_mode', 'minimum_claim_chunk', 'reassignment_threshold_minutes', 'stale_claim_threshold', 'target_completion_gap_minutes', 'is_active', 'notes', 'created_at', 'updated_at'],
  },
  {
    name: 'piles_auto_assignment_bot_metrics',
    columns: ['id', 'bot_account_id', 'metric_window', 'claims_completed', 'hours_logged', 'claims_per_hour', 'active_claim_load', 'projected_finish_at', 'details', 'observed_at', 'updated_at'],
  },
];

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'`;
  if (typeof value === 'object') return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function fetchRows(client, table) {
  const res = await client.query(`select * from ${table.name} order by ${table.columns[0]} asc`);
  return res.rows;
}

function buildUpsert(table, row) {
  const columns = table.columns;
  const values = columns.map((column) => literal(row[column]));
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = EXCLUDED.${column}`);
  return `insert into ${table.name} (${columns.join(', ')}) values (${values.join(', ')}) on conflict (id) do update set ${updates.join(', ')};`;
}

async function main() {
  const client = await pool.connect();
  try {
    const lines = ['begin;'];
    for (const table of TABLES) {
      const rows = await fetchRows(client, table);
      lines.push(`-- ${table.name}`);
      for (const row of rows) {
        lines.push(buildUpsert(table, row));
      }
      lines.push('');
    }
    lines.push('commit;');
    process.stdout.write(lines.join('\n'));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
