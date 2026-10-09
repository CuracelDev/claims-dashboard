import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { canonicalInsurerLockKey } from './piles-auto-assignment-locks.mjs';

const { Pool } = pg;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_INSURER = /^[\p{L}\p{N} .&'()/_-]{1,120}$/u;
const CONFIRMATION = 'REPAIR_PILES_PROVENANCE';

function invalidArguments() {
  return new Error('Invalid provenance audit arguments.');
}

export function parseProvenanceArgs(argv) {
  const values = {};
  const allowed = new Set(['--apply', '--confirmation', '--hours', '--insurer', '--attempt-id']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw invalidArguments();
    if (key === '--apply') values[key] = true;
    else {
      const value = argv[++index];
      if (typeof value !== 'string' || value.length === 0) throw invalidArguments();
      values[key] = value;
    }
  }
  const apply = values['--apply'] === true;
  const hours = values['--hours'] === undefined ? 24 : Number(values['--hours']);
  const insurer = values['--insurer'] ?? null;
  const attemptId = values['--attempt-id'] ?? null;
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw invalidArguments();
  if (insurer !== null && !SAFE_INSURER.test(insurer)) throw invalidArguments();
  if (attemptId !== null && !SAFE_ID.test(attemptId)) throw invalidArguments();
  if (apply && (values['--hours'] !== undefined || insurer !== null)) throw invalidArguments();
  if (apply !== Boolean(attemptId)
      || (apply && values['--confirmation'] !== CONFIRMATION)
      || (!apply && values['--confirmation'] !== undefined)) throw invalidArguments();
  return { apply, hours, insurer, attemptId };
}

function canonical(column) {
  return `(CASE WHEN lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g')) IN ('uapom', 'old mutual')
    THEN 'old mutual' ELSE lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g')) END)`;
}

function identityMatch(attempt = 'a', observation = 'o') {
  return `(
    ${attempt}.tracking_key = ${observation}.tracking_key
    OR nullif(${attempt}.last_pile_key, '') IN (${observation}.tracking_key, ${observation}.last_pile_key)
    OR nullif(${observation}.last_pile_key, '') IN (${attempt}.tracking_key, ${attempt}.last_pile_key)
    OR (
      length(coalesce(${attempt}.evidence_details ->> 'portal_identity_hash', '')) = 64
      AND ${attempt}.evidence_details ->> 'portal_identity_hash'
          = ${observation}.details ->> 'portal_identity_hash'
    )
  )`;
}

export function buildProvenanceAuditQuery({ hours, insurer }) {
  return {
    name: 'provenance-audit-aggregates',
    values: [hours, insurer],
    text: `
      WITH scoped_attempts AS (
        SELECT a.* FROM piles_auto_assignment_attempts a
        WHERE a.created_at >= clock_timestamp() - ($1::int * interval '1 hour')
          AND ($2::text IS NULL OR ${canonical('a.insurer_name')} = ${canonical('$2::text')})
          AND a.status IN ('submitted', 'reconciliation_pending', 'confirmed_visible', 'confirmed_reconciled')
      ), scoped_observations AS (
        SELECT o.* FROM piles_auto_assignment_external_assignments o
        WHERE o.is_active = true
          AND o.last_seen_at >= clock_timestamp() - ($1::int * interval '1 hour')
          AND ($2::text IS NULL OR ${canonical('o.insurer_name')} = ${canonical('$2::text')})
      ), matches AS (
        SELECT a.id AS attempt_id, o.id AS observation_id, a.status,
               lower(btrim(a.intended_portal_assignee)) = lower(btrim(o.current_assigned)) AS assignee_matches
        FROM scoped_attempts a JOIN scoped_observations o
          ON ${canonical('a.insurer_name')} = ${canonical('o.insurer_name')}
         AND ${identityMatch()}
      ), attempt_cardinality AS (
        SELECT attempt_id, count(*)::int AS match_count FROM matches GROUP BY attempt_id
      ), observation_cardinality AS (
        SELECT observation_id, count(*)::int AS match_count FROM matches GROUP BY observation_id
      ), exact_matches AS (
        SELECT DISTINCT m.attempt_id, m.observation_id FROM matches m
        JOIN attempt_cardinality ac ON ac.attempt_id = m.attempt_id AND ac.match_count = 1
        JOIN observation_cardinality oc ON oc.observation_id = m.observation_id AND oc.match_count = 1
        WHERE m.status IN ('confirmed_visible', 'confirmed_reconciled') AND m.assignee_matches
      )
      SELECT
        (SELECT count(*)::int FROM scoped_attempts
          WHERE status IN ('confirmed_visible', 'confirmed_reconciled') AND tracked_pile_id IS NULL)
          AS confirmed_missing_tracked_links,
        (SELECT count(*)::int FROM exact_matches) AS confirmed_matching_active_observations,
        (SELECT count(*)::int FROM attempt_cardinality WHERE match_count > 1)
          + (SELECT count(*)::int FROM observation_cardinality WHERE match_count > 1)
          AS ambiguous_identities,
        (SELECT count(*)::int FROM scoped_attempts
          WHERE status IN ('submitted', 'reconciliation_pending')) AS pending_runner_owned_assignments,
        (SELECT count(*)::int FROM scoped_observations o WHERE NOT EXISTS (
          SELECT 1 FROM matches m WHERE m.observation_id = o.id
        )) AS genuinely_unlinked_rows,
        (SELECT count(*)::int FROM exact_matches e JOIN scoped_attempts a ON a.id = e.attempt_id
          WHERE a.tracked_pile_id IS NULL) AS repairable_exact_matches
    `,
  };
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function inspect(client, options) {
  const result = await client.query(buildProvenanceAuditQuery(options));
  const row = result.rows[0] ?? {};
  return {
    mode: 'inspect',
    window_hours: options.hours,
    insurer_filter_applied: options.insurer !== null,
    confirmed_missing_tracked_links: number(row.confirmed_missing_tracked_links),
    confirmed_matching_active_observations: number(row.confirmed_matching_active_observations),
    ambiguous_identities: number(row.ambiguous_identities),
    pending_runner_owned_assignments: number(row.pending_runner_owned_assignments),
    genuinely_unlinked_rows: number(row.genuinely_unlinked_rows),
    repairable_exact_matches: number(row.repairable_exact_matches),
  };
}

function blockedRepair() {
  return { mode: 'apply', repaired_attempts: 0, cleared_observations: 0, blocked: 1 };
}

async function repair(client, options) {
  const lock = await client.query({
    name: 'provenance-repair-lock',
    values: [options.attemptId],
    text: `
      SELECT a.id AS attempt_id, a.insurer_name, a.tracking_key, a.last_pile_key,
             a.bot_account_id, r.master_account_id, a.intended_portal_assignee,
             o.id AS observation_id, coalesce(o.provider, 'Unknown') AS provider,
             o.claim_month, o.submitted_date, o.claims_total, o.synced_claims,
             o.remaining_claims, o.assignment_type, o.current_status,
             o.current_status_bucket, o.current_assigned
      FROM piles_auto_assignment_attempts a
      JOIN piles_auto_assignment_insurer_runs r ON r.id = a.insurer_run_id
      JOIN piles_auto_assignment_external_assignments o
        ON ${canonical('a.insurer_name')} = ${canonical('o.insurer_name')}
       AND ${identityMatch()}
      WHERE a.id = $1 AND a.tracked_pile_id IS NULL
        AND a.status IN ('confirmed_visible', 'confirmed_reconciled')
        AND o.is_active = true
        AND lower(btrim(a.intended_portal_assignee)) = lower(btrim(o.current_assigned))
      FOR UPDATE OF a, o
    `,
  });
  if (lock.rows.length !== 1) return blockedRepair();
  const candidate = lock.rows[0];

  const advisory = await client.query({
    name: 'provenance-repair-advisory-lock',
    values: [`piles-insurer:${canonicalInsurerLockKey(candidate.insurer_name)}`],
    text: 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
  });
  if (advisory.rows[0]?.acquired !== true) return blockedRepair();

  const ambiguity = await client.query({
    name: 'provenance-repair-ambiguity',
    values: [candidate.attempt_id, candidate.observation_id],
    text: `
      SELECT
        (SELECT count(*)::int FROM piles_auto_assignment_external_assignments o
         JOIN piles_auto_assignment_attempts a ON a.id = $1
         WHERE o.is_active = true
           AND ${canonical('a.insurer_name')} = ${canonical('o.insurer_name')}
           AND ${identityMatch()}) AS observation_matches,
        (SELECT count(*)::int FROM piles_auto_assignment_attempts a
         JOIN piles_auto_assignment_external_assignments o ON o.id = $2
         WHERE a.status IN ('confirmed_visible', 'confirmed_reconciled')
           AND ${canonical('a.insurer_name')} = ${canonical('o.insurer_name')}
           AND ${identityMatch()}) AS attempt_matches
    `,
  });
  if (number(ambiguity.rows[0]?.observation_matches) !== 1
      || number(ambiguity.rows[0]?.attempt_matches) !== 1) return blockedRepair();

  const upsert = await client.query({
    name: 'provenance-repair-upsert',
    values: [
      candidate.master_account_id, candidate.bot_account_id, candidate.insurer_name,
      candidate.tracking_key, candidate.last_pile_key, candidate.provider,
      candidate.claim_month, candidate.submitted_date, candidate.claims_total,
      candidate.synced_claims, candidate.remaining_claims, candidate.assignment_type,
      candidate.current_status, candidate.current_status_bucket,
      candidate.current_assigned,
    ],
    text: `
      INSERT INTO piles_auto_assignment_tracked_piles
        (master_account_id, bot_account_id, insurer_name, tracking_key, last_pile_key,
         provider, claim_month, submitted_date, claims_total, synced_claims,
         remaining_claims, assignment_type, current_status, current_status_bucket,
         current_assigned, first_assigned_at, assigned_at, first_seen_at, last_seen_at,
         is_active, is_stale, stale_reason, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, greatest($9::int, 0), greatest($10::int, 0),
              greatest($11::int, 0), $12, $13, $14, $15, clock_timestamp(), clock_timestamp(),
              clock_timestamp(), clock_timestamp(), true, false, null,
              '{"source":"guarded_provenance_repair"}'::jsonb)
      ON CONFLICT (insurer_name, tracking_key) DO UPDATE SET
        bot_account_id = excluded.bot_account_id,
        last_pile_key = excluded.last_pile_key,
        current_assigned = excluded.current_assigned,
        last_seen_at = clock_timestamp(), is_active = true, is_stale = false,
        stale_reason = null,
        details = coalesce(piles_auto_assignment_tracked_piles.details, '{}'::jsonb)
                  || excluded.details,
        updated_at = clock_timestamp()
      RETURNING id
    `,
  });
  if (upsert.rows.length !== 1) throw new Error('Guarded provenance repair state changed.');
  const trackedId = upsert.rows[0].id;
  const linked = await client.query({
    name: 'provenance-repair-link',
    values: [trackedId, candidate.attempt_id],
    text: `UPDATE piles_auto_assignment_attempts
      SET tracked_pile_id = $1, updated_at = clock_timestamp()
      WHERE id = $2 AND tracked_pile_id IS NULL
        AND status IN ('confirmed_visible', 'confirmed_reconciled') RETURNING id`,
  });
  if (linked.rows.length !== 1) throw new Error('Guarded provenance repair state changed.');
  const cleared = await client.query({
    name: 'provenance-repair-clear',
    values: [candidate.observation_id, candidate.attempt_id],
    text: `UPDATE piles_auto_assignment_external_assignments
      SET is_active = false, cleared_at = coalesce(cleared_at, clock_timestamp()),
          details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
            'clear_reason', 'runner_provenance_confirmed',
            'confirming_attempt_id', $2::text,
            'repair_source', 'guarded_provenance_repair'),
          updated_at = clock_timestamp()
      WHERE id = $1 AND is_active = true RETURNING id`,
  });
  if (cleared.rows.length !== 1) throw new Error('Guarded provenance repair state changed.');
  return { mode: 'apply', repaired_attempts: 1, cleared_observations: 1, blocked: 0 };
}

export async function runProvenanceAudit(client, options) {
  let committed = false;
  try {
    await client.query(options.apply ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN READ ONLY');
    const report = options.apply ? await repair(client, options) : await inspect(client, options);
    if (options.apply && report.blocked === 0) {
      await client.query('COMMIT');
      committed = true;
    }
    return report;
  } finally {
    if (!committed) await client.query('ROLLBACK');
  }
}

function poolConfig(databaseUrl, environment = process.env) {
  let ssl;
  if (environment.DATABASE_SSL !== 'false') {
    try {
      if (new URL(databaseUrl).searchParams.get('sslmode') !== 'disable') {
        ssl = { rejectUnauthorized: environment.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
      }
    } catch {
      ssl = { rejectUnauthorized: environment.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
    }
  }
  return { connectionString: databaseUrl, ssl, max: 1 };
}

async function main() {
  const options = parseProvenanceArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('Database URL required.'), { code: 'missing_database_url' });
  const pool = new Pool(poolConfig(process.env.DATABASE_URL));
  let client;
  try {
    client = await pool.connect();
    const report = await runProvenanceAudit(client, options);
    console.log(JSON.stringify(report, null, 2));
    if (report.blocked) process.exitCode = 2;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Piles provenance audit failed (details redacted).');
    process.exitCode = 1;
  });
}
