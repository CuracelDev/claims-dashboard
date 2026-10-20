import fs from 'fs';
import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const ROUTINE_CONTRACTS = [
  {
    signature: 'public.piles_audit_bot_account_insert()',
    serviceRoleExecute: false,
    publicExecuteAllowed: true,
    auditTriggerRequired: true,
    fragments: [
      'insert into piles_auto_assignment_bot_account_history',
      "'bot_accounts_api_create'",
      "'password_configured'",
      "coalesce(new.bot_password, '') <> ''",
      'return new',
    ],
  },
  {
    signature: 'public.piles_update_bot_account_with_history(text,jsonb,text,text,text,text)',
    serviceRoleExecute: true,
    // SECURITY INVOKER preserves the caller's table and RLS permissions, so a
    // legacy owner-managed PUBLIC EXECUTE ACL does not add database authority.
    publicExecuteAllowed: true,
    fragments: [
      'select * into previous_row from piles_auto_assignment_bot_accounts',
      'for update',
      'update piles_auto_assignment_bot_accounts set',
      'previous_safe :=',
      'next_safe :=',
      'insert into piles_auto_assignment_bot_account_history',
      'return next_row',
    ],
  },
];

function normalizedSignature(value) {
  return String(value || '').toLowerCase().replace(/^public\./, '').replace(/\s+/g, '');
}

function normalizedRoutineSource(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function evaluateRoutineContracts(rows) {
  const bySignature = new Map((rows || []).map((row) => [normalizedSignature(row.signature), row]));
  const issues = [];
  for (const contract of ROUTINE_CONTRACTS) {
    const row = bySignature.get(normalizedSignature(contract.signature));
    if (!row || !row.source) {
      issues.push(`missing required routine ${contract.signature}`);
      continue;
    }
    if (row.security_definer) {
      issues.push(`routine ${contract.signature} must remain SECURITY INVOKER`);
    }
    if (!contract.publicExecuteAllowed && row.public_execute) {
      issues.push(`routine ${contract.signature} must not grant PUBLIC EXECUTE`);
    }
    if (contract.serviceRoleExecute && !row.service_role_execute) {
      issues.push(`routine ${contract.signature} must grant service_role EXECUTE when that role exists`);
    }
    if (contract.auditTriggerRequired && !row.audit_trigger_bound) {
      issues.push(`routine ${contract.signature} must remain bound to the exact AFTER INSERT row trigger`);
    }
    const source = normalizedRoutineSource(row.source);
    const missing = contract.fragments.filter((fragment) => !source.includes(fragment));
    if (missing.length) {
      issues.push(`routine contract mismatch for ${contract.signature}`);
    }
  }
  return issues;
}

async function loadRoutineContracts(client) {
  const signatures = ROUTINE_CONTRACTS.map(({ signature }) => signature);
  const { rows } = await client.query(
    `with expected(signature) as (select unnest($1::text[]))
     select expected.signature, routine.prosecdef as security_definer, routine.prosrc as source,
       exists (
         select 1 from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
         where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
       ) as public_execute,
       case when routine.oid is null then false
         when exists (select 1 from pg_roles where rolname = 'service_role')
         then has_function_privilege('service_role', expected.signature, 'EXECUTE')
         else true
       end as service_role_execute,
       exists (
         select 1 from pg_trigger trigger
         where trigger.tgname = 'piles_audit_bot_account_insert_trigger'
           and trigger.tgrelid = to_regclass('public.piles_auto_assignment_bot_accounts')
           and trigger.tgfoid = routine.oid
           and trigger.tgtype = 5
           and not trigger.tgisinternal
       ) as audit_trigger_bound
     from expected
     left join pg_proc routine on routine.oid = to_regprocedure(expected.signature)`,
    [signatures],
  );
  return rows;
}

export async function applySchema(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    const issues = evaluateRoutineContracts(await loadRoutineContracts(client));
    if (issues.length) throw new Error(`Piles routine contract audit failed: ${issues.join('; ')}`);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  loadLocalEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Add it to .env.local or export it before running this script.');
  }
  const sql = fs.readFileSync('scripts/piles-auto-assignment-schema.sql', 'utf8');
  const pool = new Pool({ connectionString: databaseUrl, ssl: sslConfig(databaseUrl) });
  try {
    await applySchema(pool, sql);
    console.log('Piles auto-assignment schema applied and routine contracts verified.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
