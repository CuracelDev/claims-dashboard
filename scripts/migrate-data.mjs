import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const { Pool } = pg;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const tables = [
  'audit_log',
  'claim_errors',
  'daily_reports',
  'insurer_feedback_items',
  'leave_records',
  'metric_definitions',
  'okr_entries',
  'platform_settings',
  'prism_conversations',
  'prism_logs',
  'prism_messages',
  'qa_flags',
  'sessions',
  'slack_summaries',
  'target_logs',
  'tasks',
  'team_leave',
  'team_members',
  'weekly_targets'
];

async function migrate() {
  console.log('--- Migration Started ---');
  for (const table of tables) {
    console.log(`Table: ${table} | Fetching from Supabase...`);
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.error(`  [ERROR] Supabase fetch failed for ${table}:`, error.message);
      continue;
    }

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
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await pgPool.query(sql, values);
        count++;
        if (count % 25 === 0) console.log(`    - Progress: ${count}/${data.length}`);
      } catch (err) {
        console.error(`    [ERROR] Insert failed for row in ${table}:`, err.message);
      }
    }
    console.log(`  [DONE] Table ${table} migration finished.`);
  }
  console.log('--- Migration Complete! ---');
  process.exit(0);
}

migrate().catch(err => {
  console.error('--- CRITICAL ERROR ---');
  console.error(err);
  process.exit(1);
});
