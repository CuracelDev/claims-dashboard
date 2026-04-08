import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const tables = [
  'audit_log', 'claim_errors', 'daily_reports', 'insurer_feedback_items',
  'leave_records', 'metric_definitions', 'okr_entries', 'platform_settings',
  'prism_logs', 'qa_flags', 'sessions', 'slack_summaries', 'target_logs',
  'tasks', 'team_leave', 'team_members', 'weekly_targets'
];

async function migrate() {
  console.log('--- Migration Started (Auto-Schema Version) ---');
  for (const table of tables) {
    console.log(`Table: ${table} | Preparing...`);
    
    // Fetch data samples to infer types or at least get columns
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!response.ok) {
      console.error(`  [ERROR] Could not fetch ${table} from Supabase.`);
      continue;
    }

    const sample = await response.json();
    if (!sample || sample.length === 0) {
      console.log(`  [INFO] Table ${table} is empty. Skipping creation.`);
      continue;
    }

    const columns = Object.keys(sample[0]);
    
    // Create table with JSONB for all columns as a safe fallback, 
    // or we can try to be smarter. For now, let's use TEXT/JSONB.
    const columnDefs = columns.map(c => `"${c}" TEXT`).join(', ');
    const createTableSql = `CREATE TABLE IF NOT EXISTS "${table}" (${columnDefs})`;
    
    try {
      await pgPool.query(createTableSql);
      console.log(`  [SUCCESS] Table "${table}" verified/created.`);
    } catch (err) {
      console.error(`  [ERROR] Failed to create table ${table}:`, err.message);
      continue;
    }

    // Now fetch all data
    const allResponse = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
    const allData = await allResponse.json();

    console.log(`  [INFO] Migrating ${allData.length} rows...`);
    for (const row of allData) {
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map(col => {
          let val = row[col];
          if (typeof val === 'object' && val !== null) return JSON.stringify(val);
          return val;
      });
      const safeColumns = columns.map(c => `"${c}"`).join(', ');
      const sql = `INSERT INTO "${table}" (${safeColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await pgPool.query(sql, values);
      } catch (err) {
        console.error(`    [ERROR] Insert failed for row in ${table}:`, err.message);
      }
    }
    console.log(`  [DONE] Table ${table} migration complete.`);
  }
  console.log('--- Migration Complete! ---');
  process.exit(0);
}

migrate().catch(console.error);
