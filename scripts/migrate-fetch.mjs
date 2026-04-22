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
  'prism_conversations', 'prism_logs', 'prism_messages', 'qa_flags', 'sessions', 'slack_summaries', 'target_logs',
  'tasks', 'team_leave', 'team_members', 'weekly_targets'
];

async function migrate() {
  console.log('--- Migration Started (Fetch Version) ---');
  for (const table of tables) {
    console.log(`Table: ${table} | Fetching...`);
    
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`  [ERROR] Fetch failed for ${table}:`, err);
      continue;
    }

    const data = await response.json();
    if (!data || data.length === 0) {
      console.log(`  [INFO] Table ${table} is empty.`);
      continue;
    }

    console.log(`  [SUCCESS] Fetched ${data.length} rows. Migrating...`);
    const columns = Object.keys(data[0]);
    let count = 0;
    for (const row of data) {
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map(col => row[col]);
      // Wrap column names in double quotes to handle reserved words
      const safeColumns = columns.map(c => `"${c}"`).join(', ');
      const sql = `INSERT INTO "${table}" (${safeColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await pgPool.query(sql, values);
        count++;
      } catch (err) {
        console.error(`    [ERROR] Insert failed for ${table}:`, err.message);
      }
    }
    console.log(`  [DONE] Table ${table}: ${count} rows migrated.`);
  }
  console.log('--- Migration Complete! ---');
  process.exit(0);
}

migrate().catch(console.error);
