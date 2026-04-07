const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
  'prism_logs',
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
  for (const table of tables) {
    console.log(`Migrating table: ${table}...`);
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.error(`Error fetching from ${table}:`, error);
      continue;
    }

    if (data.length === 0) {
      console.log(`Table ${table} is empty.`);
      continue;
    }

    // This is a naive migration. For large tables, use streaming.
    // Also, assumes columns match exactly.
    const columns = Object.keys(data[0]);
    for (const row of data) {
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map(col => row[col]);
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await pgPool.query(sql, values);
      } catch (err) {
        console.error(`Error inserting into ${table}:`, err.message);
      }
    }
  }
  console.log('Migration complete!');
  process.exit(0);
}

migrate();
