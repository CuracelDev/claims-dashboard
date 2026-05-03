import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;

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

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = `
alter table if exists piles_auto_assignment_master_accounts
  alter column id set default md5(random()::text || clock_timestamp()::text);
alter table if exists piles_auto_assignment_bot_accounts
  alter column id set default md5(random()::text || clock_timestamp()::text);
alter table if exists piles_auto_assignment_rules
  alter column id set default md5(random()::text || clock_timestamp()::text);
alter table if exists piles_auto_assignment_bot_metrics
  alter column id set default md5(random()::text || clock_timestamp()::text);
alter table if exists piles_auto_assignment_logs
  alter column id set default md5(random()::text || clock_timestamp()::text);
`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(sql);
  console.log('Repaired local piles auto-assignment id defaults.');
} finally {
  await pool.end();
}
