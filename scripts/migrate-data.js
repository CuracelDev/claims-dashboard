const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

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

console.log('Starting migration script...');
console.log('Target DB:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));

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
  console.log('Migrate function started...');
  for (const table of tables) {
    console.log(`Connecting to Supabase for table: ${table}...`);
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.error(`Error fetching from ${table}:`, error);
      continue;
    }
    console.log(`Fetched ${data.length} rows from ${table}.`);

    if (data.length === 0) {
      console.log(`Table ${table} is empty.`);
      continue;
    }

    // This is a naive migration. For large tables, use streaming.
    // Also, assumes columns match exactly.
    const columns = Object.keys(data[0]);
    let count = 0;
    for (const row of data) {
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map(col => row[col]);
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await pgPool.query(sql, values);
        count++;
        if (count % 10 === 0) console.log(`  - Migrated ${count}/${data.length} rows for ${table}`);
      } catch (err) {
        console.error(`Error inserting into ${table}:`, err.message);
      }
    }
    console.log(`Finished table ${table}: ${count} rows migrated.`);
  }
  console.log('Migration complete!');
  process.exit(0);
}

migrate();
