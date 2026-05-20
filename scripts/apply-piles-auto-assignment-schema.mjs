import fs from 'fs';
import pg from 'pg';

const { Pool } = pg;

function loadLocalEnv() {
  const files = ['.env', '.env.local'];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\n/);
    for (const line of lines) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && process.env[match[1]] === undefined) {
        // Strip any wrapping quotes
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        process.env[match[1]] = val;
      }
    }
  }
}

function sslConfig(databaseUrl) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  if (databaseUrl?.includes('localhost') || databaseUrl?.includes('127.0.0.1')) return undefined;
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Add it to .env.local or export it before running this script.');
  process.exit(1);
}

const sql = fs.readFileSync('scripts/piles-auto-assignment-schema.sql', 'utf8');
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: sslConfig(databaseUrl),
});

try {
  await pool.query(sql);
  console.log('Piles auto-assignment schema applied.');
} finally {
  await pool.end();
}
