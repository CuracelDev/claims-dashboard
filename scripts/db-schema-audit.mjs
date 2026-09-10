import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  piles_auto_assignment_insurer_runs: {
    requiredColumns: {
      id: ['text'], runner_run_id: ['text'], insurer_name: ['text'],
      status: ['text'], phase: ['text'], heartbeat_at: ['timestamp with time zone'],
      details: ['jsonb'], created_at: ['timestamp with time zone'], updated_at: ['timestamp with time zone'],
    },
    preferredTypes: { details: ['jsonb'] },
    requiredEnumChecks: [{
      column: 'status',
      values: ['queued', 'running', 'completed', 'completed_with_issues', 'partial', 'failed', 'manual_action_required', 'skipped_inactive', 'skipped_overlap', 'covered_by_active_cycle', 'cancelled'],
    }],
  },
  piles_auto_assignment_scan_contexts: {
    requiredColumns: {
      id: ['text'], insurer_run_id: ['text'], insurer_name: ['text'], filter_month: ['text'],
      requested_year: ['text'], effective_years: ['jsonb'], status_bucket: ['text'], status: ['text'],
      ui_evidence: ['jsonb'], network_evidence: ['jsonb'], table_evidence: ['jsonb'],
    },
    preferredTypes: { effective_years: ['jsonb'], ui_evidence: ['jsonb'], network_evidence: ['jsonb'], table_evidence: ['jsonb'] },
    uniqueGroups: [['insurer_run_id', 'filter_month', 'requested_year', 'status_bucket']],
  },
  piles_auto_assignment_batches: {
    requiredColumns: {
      id: ['text'], insurer_run_id: ['text'], scan_context_id: ['text'], insurer_name: ['text'],
      intended_owner_name: ['text'], intended_portal_assignee: ['text'], status: ['text'], details: ['jsonb'],
    },
    preferredTypes: { details: ['jsonb'] },
  },
  piles_auto_assignment_attempts: {
    requiredColumns: {
      id: ['text'], batch_id: ['text'], insurer_run_id: ['text'], insurer_name: ['text'],
      tracking_key: ['text'], intended_owner_name: ['text'], intended_portal_assignee: ['text'],
      status: ['text'], attempt_number: ['integer'], evidence_details: ['jsonb'],
    },
    preferredTypes: { evidence_details: ['jsonb'] },
    uniqueGroups: [['batch_id', 'tracking_key']],
  },
  piles_auto_assignment_bot_account_history: {
    requiredColumns: {
      id: ['text'], bot_account_id: ['text'], insurer_name: ['text'], owner_name: ['text'],
      availability_status: ['text'], is_active: ['boolean'], is_available: ['boolean'],
      change_source: ['text'], effective_at: ['timestamp with time zone'], created_at: ['timestamp with time zone'],
    },
  },
  piles_auto_assignment_schedule_requests: {
    requiredColumns: {
      id: ['text'], insurer_name: ['text'], requested_runner_run_id: ['text'], status: ['text'],
      claimed_by_runner_run_id: ['text'], requested_at: ['timestamp with time zone'],
      created_at: ['timestamp with time zone'], updated_at: ['timestamp with time zone'],
    },
    requiredEnumChecks: [{ column: 'status', values: ['pending', 'claimed', 'cancelled_legacy'] }],
  },
  piles_auto_assignment_runner_runs: {
    requiredColumns: {
      id: ['text'], status: ['text'], created_at: ['timestamp with time zone'],
      updated_at: ['timestamp with time zone'],
    },
    requiredEnumChecks: [{
      column: 'status',
      values: ['queued', 'started', 'running', 'completed', 'completed_with_issues', 'failed', 'covered_by_active_cycle', 'cancelled', 'manual_action_required', 'partial', 'skipped_overlap'],
    }],
  },
  piles_auto_assignment_work_items: {
    requiredColumns: {
      id: ['text'], parent_runner_run_id: ['text'], insurer_name: ['text'],
      canonical_insurer_name: ['text'], source: ['text'], request_scope: ['text'],
      disposition: ['text'], covered_by_insurer_run_id: ['text'], worker_id: ['text'],
      claim_token: ['text'], lease_expires_at: ['timestamp with time zone'],
      heartbeat_at: ['timestamp with time zone'], generation_requested_at: ['timestamp with time zone'],
      attempt_number: ['integer'], requested_at: ['timestamp with time zone'],
      claimed_at: ['timestamp with time zone'], started_at: ['timestamp with time zone'],
      finished_at: ['timestamp with time zone'], reason_code: ['text'],
      created_at: ['timestamp with time zone'], updated_at: ['timestamp with time zone'],
    },
    requiredNullability: {
      id: 'NO', parent_runner_run_id: 'YES', insurer_name: 'NO', canonical_insurer_name: 'NO',
      source: 'NO', request_scope: 'NO', disposition: 'NO', covered_by_insurer_run_id: 'YES',
      worker_id: 'YES', claim_token: 'YES', lease_expires_at: 'YES', heartbeat_at: 'YES',
      generation_requested_at: 'NO', attempt_number: 'NO', requested_at: 'NO', claimed_at: 'YES',
      started_at: 'YES', finished_at: 'YES', reason_code: 'YES', created_at: 'NO', updated_at: 'NO',
    },
    requiredPrimaryKey: ['id'],
    requiredEnumChecks: [
      { column: 'source', values: ['schedule', 'manual', 'readiness', 'recovery'] },
      { column: 'request_scope', values: ['all_active', 'single_insurer'] },
      { column: 'disposition', values: ['queued', 'claimed', 'covered_by_active_cycle', 'follow_up_queued', 'inactive', 'completed', 'failed', 'cancelled'] },
    ],
    requiredExpressionChecks: [
      { column: 'canonical_insurer_name', normalized: "btrimcanonical_insurer_name<>''" },
      { column: 'attempt_number', normalized: 'attempt_number>=0' },
      { column: 'reason_code', normalized: "reason_codeisnullorchar_lengthreason_code<=80andreason_code~'^[a-z0-9._-]+$'" },
    ],
    requiredForeignKeys: [
      { column: 'parent_runner_run_id', table: 'piles_auto_assignment_runner_runs', referencedColumn: 'id', deleteRule: 'SET NULL' },
      { column: 'covered_by_insurer_run_id', table: 'piles_auto_assignment_insurer_runs', referencedColumn: 'id', deleteRule: 'SET NULL' },
    ],
    requiredIndexes: [
      { name: 'piles_auto_assignment_work_items_queued_generation_idx', unique: true, columns: ['canonical_insurer_name', 'source', 'request_scope'], predicate: { kind: 'equals', column: 'disposition', values: ['queued'] } },
      { name: 'piles_auto_assignment_work_items_follow_up_idx', unique: true, columns: ['canonical_insurer_name'], predicate: { kind: 'equals', column: 'disposition', values: ['follow_up_queued'] } },
      { name: 'piles_auto_assignment_work_items_claim_order_idx', unique: false, columns: ['parent_runner_run_id', 'disposition', 'generation_requested_at', 'requested_at', 'id'], predicate: { kind: 'in', column: 'disposition', values: ['queued', 'follow_up_queued'] } },
      { name: 'piles_auto_assignment_work_items_expired_lease_idx', unique: false, columns: ['lease_expires_at', 'canonical_insurer_name'], predicate: { kind: 'equals', column: 'disposition', values: ['claimed'] } },
    ],
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
  'piles_auto_assignment_bot_accounts',
  'piles_auto_assignment_bot_metrics',
  'piles_auto_assignment_bot_account_history',
  'piles_auto_assignment_batches',
  'piles_auto_assignment_attempts',
  'piles_auto_assignment_insurer_runs',
  'piles_auto_assignment_logs',
  'piles_auto_assignment_master_accounts',
  'piles_auto_assignment_rules',
  'piles_auto_assignment_scan_contexts',
  'piles_auto_assignment_schedule_requests',
  'piles_auto_assignment_runner_runs',
  'piles_auto_assignment_work_items',
  'prism_conversations',
  'prism_logs',
  'prism_messages',
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
        array_agg(kcu.column_name::text order by kcu.ordinal_position) as columns
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
    byTable.get(row.table_name).push({
      ...row,
      columns: normalizeConstraintColumns(row.columns),
    });
  }
  return byTable;
}

async function getCheckConstraints(pool) {
  const { rows } = await pool.query(
    `
      select
        relation.relname as table_name,
        constraint_record.conname as constraint_name,
        pg_get_constraintdef(constraint_record.oid) as definition,
        array_remove(array_agg(attribute.attname order by constraint_key.ordinality), null) as columns
      from pg_constraint constraint_record
      join pg_class relation on relation.oid = constraint_record.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      left join lateral unnest(constraint_record.conkey)
        with ordinality as constraint_key(attnum, ordinality) on true
      left join pg_attribute attribute
        on attribute.attrelid = constraint_record.conrelid
       and attribute.attnum = constraint_key.attnum
      where namespace.nspname = 'public'
        and constraint_record.contype = 'c'
      group by relation.relname, constraint_record.conname, constraint_record.oid
      order by relation.relname, constraint_record.conname
    `
  );
  for (const row of rows) row.columns = normalizeConstraintColumns(row.columns);
  return groupByTable(rows);
}

async function getIndexes(pool) {
  const { rows } = await pool.query(
    `
      select
        table_relation.relname as table_name,
        index_relation.relname as indexname,
        index_record.indisunique as is_unique,
        array(
          select pg_get_indexdef(index_record.indexrelid, key_position, true)
          from generate_series(1, index_record.indnkeyatts) key_position
          order by key_position
        ) as columns,
        pg_get_expr(index_record.indpred, index_record.indrelid) as predicate
      from pg_index index_record
      join pg_class index_relation on index_relation.oid = index_record.indexrelid
      join pg_class table_relation on table_relation.oid = index_record.indrelid
      join pg_namespace namespace on namespace.oid = table_relation.relnamespace
      where namespace.nspname = 'public'
      order by table_relation.relname, index_relation.relname
    `
  );
  for (const row of rows) row.columns = normalizeConstraintColumns(row.columns);
  return groupByTable(rows);
}

async function getForeignKeys(pool) {
  const { rows } = await pool.query(
    `
      select
        constraint_table.table_name,
        constraint_table.constraint_name,
        constraint_column.column_name,
        referenced_table.table_name as referenced_table,
        referenced_table.column_name as referenced_column,
        referential.delete_rule
      from information_schema.table_constraints constraint_table
      join information_schema.key_column_usage constraint_column
        on constraint_column.constraint_schema = constraint_table.constraint_schema
       and constraint_column.constraint_name = constraint_table.constraint_name
      join information_schema.referential_constraints referential
        on referential.constraint_schema = constraint_table.constraint_schema
       and referential.constraint_name = constraint_table.constraint_name
      join information_schema.constraint_column_usage referenced_table
        on referenced_table.constraint_schema = referential.unique_constraint_schema
       and referenced_table.constraint_name = referential.unique_constraint_name
      where constraint_table.table_schema = 'public'
        and constraint_table.constraint_type = 'FOREIGN KEY'
      order by constraint_table.table_name, constraint_table.constraint_name,
               constraint_column.ordinal_position
    `
  );
  return groupByTable(rows);
}

function groupByTable(rows) {
  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row);
  }
  return byTable;
}

export function normalizeConstraintColumns(value) {
  if (Array.isArray(value)) return value.map((column) => String(column));
  const raw = String(value || '').trim();
  if (!raw) return [];
  const body = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1) : raw;
  if (!body) return [];
  return body.split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
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

function sameValues(actual, expected) {
  const normalizedActual = [...new Set(actual.map(String))].sort();
  const normalizedExpected = [...new Set(expected.map(String))].sort();
  return normalizedActual.length === normalizedExpected.length
    && normalizedActual.every((value, index) => value === normalizedExpected[index]);
}

function sqlStringValues(definition) {
  return [...String(definition || '').matchAll(/'((?:''|[^'])*)'/g)]
    .map((match) => match[1].replaceAll("''", "'"));
}

function normalizeIndexColumn(value) {
  return normalizeSqlExpression(value);
}

function normalizeSqlExpression(value) {
  const sql = String(value || '').trim();
  let normalized = '';
  let quote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote === "'") {
      normalized += character;
      if (character === "'" && sql[index + 1] === "'") {
        normalized += sql[index + 1];
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"' && sql[index + 1] === '"') {
        normalized += '"';
        index += 1;
      } else if (character === '"') {
        quote = null;
      } else {
        normalized += character;
      }
      continue;
    }
    if (character === "'") {
      quote = character;
      normalized += character;
      continue;
    }
    if (character === '"') {
      quote = character;
      continue;
    }
    const cast = sql.slice(index).match(/^::\s*(?:text|character\s+varying)\b/i)?.[0];
    if (cast) {
      index += cast.length - 1;
      continue;
    }
    if (/\s/.test(character) || character === '(' || character === ')') continue;
    normalized += character.toLowerCase();
  }

  return normalized;
}

function predicateMatches(actual, requirement) {
  const normalized = normalizeSqlExpression(actual);
  const column = normalizeIndexColumn(requirement.column);
  if (!sameValues(sqlStringValues(actual), requirement.values)) return false;
  if (requirement.kind === 'equals') {
    return normalized === `${column}='${requirement.values[0]}'`;
  }
  if (requirement.kind === 'in') {
    const orderedValues = requirement.values.map((value) => `'${value}'`).join(',');
    return normalized === `${column}=anyarray[${orderedValues}]`
      || normalized === `${column}in${orderedValues}`;
  }
  return false;
}

function enumCheckMatches(checkConstraints, requirement) {
  return checkConstraints.some((constraint) => {
    if (!normalizeConstraintColumns(constraint.columns).includes(requirement.column)) return false;
    const actualValues = sqlStringValues(constraint.definition);
    if (!sameValues(actualValues, requirement.values)) return false;
    const normalized = normalizeSqlExpression(constraint.definition).replace(/^check/, '');
    const column = normalizeIndexColumn(requirement.column);
    const orderedValues = actualValues.map((value) => `'${value}'`).join(',');
    return normalized === `${column}=anyarray[${orderedValues}]`
      || normalized === `${column}in${orderedValues}`;
  });
}

function expressionCheckMatches(checkConstraints, requirement) {
  return checkConstraints.some((constraint) => (
    normalizeConstraintColumns(constraint.columns).includes(requirement.column)
    && normalizeSqlExpression(constraint.definition).replace(/^check/, '') === requirement.normalized
  ));
}

export function evaluateTable(
  table,
  columns,
  constraints,
  checkConstraints = [],
  indexes = [],
  foreignKeys = [],
) {
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

  for (const [name, required] of Object.entries(expected.requiredNullability || {})) {
    const column = actual.get(name);
    if (column && column.is_nullable !== required) {
      issues.push(`${name} must be ${required === 'NO' ? 'NOT NULL' : 'nullable'}`);
    }
  }

  if (expected.requiredPrimaryKey) {
    const present = constraints.some((constraint) => (
      constraint.constraint_type === 'PRIMARY KEY'
      && sameValues(constraint.columns || [], expected.requiredPrimaryKey)
    ));
    if (!present) issues.push(`missing PRIMARY KEY on (${expected.requiredPrimaryKey.join(', ')})`);
  }

  for (const group of expected.uniqueGroups || []) {
    if (!hasConstraintGroup(constraints, group)) {
      issues.push(`missing UNIQUE/PK constraint on (${group.join(', ')})`);
    }
  }

  for (const requirement of expected.requiredEnumChecks || []) {
    if (!enumCheckMatches(checkConstraints, requirement)) {
      issues.push(`${requirement.column} CHECK must accept exactly: ${requirement.values.join(', ')}`);
    }
  }

  for (const requirement of expected.requiredExpressionChecks || []) {
    if (!expressionCheckMatches(checkConstraints, requirement)) {
      issues.push(`${requirement.column} CHECK expression is missing or weakened`);
    }
  }

  for (const requirement of expected.requiredForeignKeys || []) {
    const present = foreignKeys.some((foreignKey) => (
      foreignKey.column_name === requirement.column
      && foreignKey.referenced_table === requirement.table
      && foreignKey.referenced_column === requirement.referencedColumn
      && foreignKey.delete_rule === requirement.deleteRule
    ));
    if (!present) {
      issues.push(`missing FOREIGN KEY ${requirement.column} -> ${requirement.table}.${requirement.referencedColumn} ON DELETE ${requirement.deleteRule}`);
    }
  }

  const indexesByName = new Map(indexes.map((index) => [index.indexname, index]));
  for (const requirement of expected.requiredIndexes || []) {
    const index = indexesByName.get(requirement.name);
    if (!index) {
      issues.push(`missing index ${requirement.name}`);
      continue;
    }
    if (Boolean(index.is_unique) !== requirement.unique) {
      issues.push(`index ${requirement.name} must ${requirement.unique ? 'be UNIQUE' : 'not be UNIQUE'}`);
    }
    const actualColumns = normalizeConstraintColumns(index.columns).map(normalizeIndexColumn);
    const requiredColumns = requirement.columns.map(normalizeIndexColumn);
    if (actualColumns.join(',') !== requiredColumns.join(',')) {
      issues.push(`index ${requirement.name} has incorrect key columns`);
    }
    if (!predicateMatches(index.predicate, requirement.predicate)) {
      issues.push(`index ${requirement.name} has incorrect predicate`);
    }
  }

  return issues;
}

export async function auditDatabase(pool, logger = console) {
  const [columnsByTable, constraintsByTable, checksByTable, indexesByTable, foreignKeysByTable, rowCounts] = await Promise.all([
    getColumns(pool),
    getConstraints(pool),
    getCheckConstraints(pool),
    getIndexes(pool),
    getForeignKeys(pool),
    getRowCounts(pool, TABLES),
  ]);

  logger.log('Production schema audit');
  logger.log('=======================');

  let issueCount = 0;
  for (const table of TABLES) {
    const columns = columnsByTable.get(table) || [];
    const constraints = constraintsByTable.get(table) || [];
    const checks = checksByTable.get(table) || [];
    const indexes = indexesByTable.get(table) || [];
    const foreignKeys = foreignKeysByTable.get(table) || [];
    const issues = evaluateTable(table, columns, constraints, checks, indexes, foreignKeys);
    issueCount += issues.filter((issue) => !issue.startsWith('works but should')).length;

    logger.log(`\n${table}`);
    logger.log(`  rows: ${rowCounts[table]}`);
    logger.log(`  columns: ${columns.length ? columns.map((c) => `${c.column_name}:${c.data_type}`).join(', ') : 'missing table'}`);
    logger.log(`  keys: ${constraints.length ? constraints.map((c) => `${c.constraint_type}(${c.columns.join(',')})`).join(', ') : 'none'}`);
    logger.log(`  checks: ${checks.length ? checks.map((c) => c.constraint_name).join(', ') : 'none'}`);
    logger.log(`  indexes: ${indexes.length ? indexes.map((i) => i.indexname).join(', ') : 'none'}`);
    logger.log(`  foreign keys: ${foreignKeys.length ? foreignKeys.map((f) => `${f.column_name}->${f.referenced_table}(${f.delete_rule})`).join(', ') : 'none'}`);
    logger.log(`  issues: ${issues.length ? issues.join('; ') : 'none detected'}`);
  }

  if (issueCount > 0) {
    throw new Error(`Production schema audit failed with ${issueCount} issue(s).`);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Set it to the production Postgres connection string.');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslFor(databaseUrl),
  });

  try {
    await auditDatabase(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
