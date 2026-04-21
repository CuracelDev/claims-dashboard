import pg from 'pg';

const { Pool } = pg;

const EXPECTED = {
  daily_reports: {
    requiredColumns: {
      id: ['integer', 'bigint', 'uuid', 'text'],
      team_member_id: ['integer', 'bigint', 'uuid', 'text'],
      report_date: ['date', 'text'],
      metrics: ['jsonb', 'json', 'text'],
      tasks_completed: ['text'],
      notes: ['text'],
      status: ['text', 'character varying'],
      created_at: ['timestamp with time zone', 'timestamp without time zone', 'text'],
    },
    preferredTypes: {
      report_date: ['date'],
      metrics: ['jsonb'],
      created_at: ['timestamp with time zone', 'timestamp without time zone'],
    },
    uniqueGroups: [['team_member_id', 'report_date']],
  },
  team_members: {
    requiredColumns: {
      id: ['integer', 'bigint', 'uuid', 'text'],
      name: ['text', 'character varying'],
      display_name: ['text', 'character varying'],
      active: ['boolean', 'text'],
      is_active: ['boolean', 'text'],
    },
    preferredTypes: {
      active: ['boolean'],
      is_active: ['boolean'],
    },
  },
  audit_log: {
    requiredColumns: {
      id: ['integer', 'bigint', 'uuid', 'text'],
      member_id: ['integer', 'bigint', 'uuid', 'text'],
      details: ['jsonb', 'json', 'text'],
      created_at: ['timestamp with time zone', 'timestamp without time zone', 'text'],
    },
    preferredTypes: {
      details: ['jsonb'],
      created_at: ['timestamp with time zone', 'timestamp without time zone'],
    },
  },
};

const TABLES = [
  'audit_log',
  'claim_errors',
  'daily_reports',
  'insurer_feedback_items',
  'metric_definitions',
  'okr_entries',
  'platform_settings',
  'prism_logs',
  'qa_flags',
  'sessions',
  'target_logs',
  'tasks',
  'team_members',
  'weekly_targets',
];

function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get('sslmode') === 'disable') return undefined;
  } catch {}

  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}

async function getColumns(pool) {
  const { rows } = await pool.query(
    `
      select
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `
  );

  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row);
  }
  return byTable;
}

async function getConstraints(pool) {
  const { rows } = await pool.query(
    `
      select
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        array_agg(kcu.column_name order by kcu.ordinal_position) as columns
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema = kcu.table_schema
       and tc.table_name = kcu.table_name
      where tc.table_schema = 'public'
        and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
      group by tc.table_name, tc.constraint_name, tc.constraint_type
      order by tc.table_name, tc.constraint_name
    `
  );

  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row);
  }
  return byTable;
}

async function getRowCounts(pool, tableNames) {
  const counts = {};
  for (const table of tableNames) {
    try {
      const { rows } = await pool.query(`select count(*)::int as count from "${table}"`);
      counts[table] = rows[0]?.count ?? 0;
    } catch (err) {
      counts[table] = `error: ${err.message}`;
    }
  }
  return counts;
}

function hasConstraintGroup(constraints, columns) {
  const wanted = columns.join(',');
  return (constraints || []).some((constraint) => (constraint.columns || []).join(',') === wanted);
}

function evaluate(table, columns, constraints) {
  const expected = EXPECTED[table];
  if (!expected) return [];

  const issues = [];
  const actual = new Map((columns || []).map((column) => [column.column_name, column]));

  for (const [name, allowed] of Object.entries(expected.requiredColumns || {})) {
    const column = actual.get(name);
    if (!column) {
      issues.push(`missing column ${name}`);
      continue;
    }
    if (!allowed.includes(column.data_type)) {
      issues.push(`unexpected type for ${name}: ${column.data_type}`);
    }
  }

  for (const [name, preferred] of Object.entries(expected.preferredTypes || {})) {
    const column = actual.get(name);
    if (column && !preferred.includes(column.data_type)) {
      issues.push(`works but should be ${preferred.join(' or ')}: ${name} is ${column.data_type}`);
    }
  }

  for (const group of expected.uniqueGroups || []) {
    if (!hasConstraintGroup(constraints, group)) {
      issues.push(`missing UNIQUE/PK constraint on (${group.join(', ')})`);
    }
  }

  return issues;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required. Set it to the production Postgres connection string.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslFor(databaseUrl),
  });

  try {
    const [columnsByTable, constraintsByTable, rowCounts] = await Promise.all([
      getColumns(pool),
      getConstraints(pool),
      getRowCounts(pool, TABLES),
    ]);

    console.log('Production schema audit');
    console.log('=======================');

    for (const table of TABLES) {
      const columns = columnsByTable.get(table) || [];
      const constraints = constraintsByTable.get(table) || [];
      const issues = evaluate(table, columns, constraints);

      console.log(`\n${table}`);
      console.log(`  rows: ${rowCounts[table]}`);
      console.log(`  columns: ${columns.length ? columns.map((c) => `${c.column_name}:${c.data_type}`).join(', ') : 'missing table'}`);
      console.log(`  keys: ${constraints.length ? constraints.map((c) => `${c.constraint_type}(${c.columns.join(',')})`).join(', ') : 'none'}`);
      console.log(`  issues: ${issues.length ? issues.join('; ') : 'none detected'}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
