import pg from 'pg';
import { insurerAdvisoryLockName } from './piles-auto-assignment-locks.mjs';

const { Pool } = pg;
const apply = process.argv.includes('--apply');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  try {
    if (new URL(url).searchParams.get('sslmode') === 'disable') return undefined;
  } catch {}
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}

const pool = new Pool({ connectionString: databaseUrl, ssl: sslFor(databaseUrl), max: 1 });
const client = await pool.connect();
let recovered = 0;
let locked = 0;

try {
  const active = await client.query(`
    select id, runner_run_id, insurer_name, phase, heartbeat_at, started_at,
           coalesce(heartbeat_at, started_at, created_at) < now() - interval '15 minutes' as is_stale
    from piles_auto_assignment_insurer_runs
    where status = 'running'
    order by coalesce(heartbeat_at, started_at, created_at)
  `);
  const staleCount = active.rows.filter((run) => run.is_stale).length;
  console.log(`Active insurer runs: ${active.rowCount}; stale: ${staleCount}`);

  for (const run of active.rows) {
    const lockName = insurerAdvisoryLockName(run.insurer_name);
    const lockResult = await client.query(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
      [lockName],
    );
    const acquired = Boolean(lockResult.rows[0]?.acquired);
    console.log(
      `${run.insurer_name}: phase=${run.phase} heartbeat=${run.heartbeat_at?.toISOString?.() || run.heartbeat_at} `
      + `freshness=${run.is_stale ? 'stale' : 'fresh'} insurer_lock=${acquired ? 'free' : 'held'} `
      + `action=${apply && run.is_stale ? 'recover' : 'inspect'}`,
    );

    if (!run.is_stale) {
      if (acquired) {
        await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      }
      continue;
    }
    if (!acquired) {
      locked += 1;
      continue;
    }

    try {
      if (!apply) continue;
      await client.query('begin');
      const current = await client.query(`
        select id, runner_run_id
        from piles_auto_assignment_insurer_runs
        where id = $1
          and status = 'running'
          and coalesce(heartbeat_at, started_at, created_at) < now() - interval '15 minutes'
        for update
      `, [run.id]);
      if (!current.rowCount) {
        await client.query('rollback');
        continue;
      }
      const runnerRunId = current.rows[0].runner_run_id;
      if (runnerRunId) {
        await client.query(
          'select id from piles_auto_assignment_runner_runs where id = $1 for update',
          [runnerRunId],
        );
      }

      await client.query(`
        update piles_auto_assignment_insurer_runs
        set status = 'failed',
            phase = 'complete',
            error_code = 'stale_heartbeat_recovered',
            error_message = 'Run was stale and its insurer advisory lock was free; finalized by guarded recovery.',
            heartbeat_at = now(),
            finished_at = coalesce(finished_at, now()),
            updated_at = now(),
            details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
              'stale_recovery_at', now(),
              'stale_recovery_mode', 'advisory_lock_guarded'
            )
        where id = $1
      `, [run.id]);

      if (runnerRunId) {
        await client.query(`
          update piles_auto_assignment_runner_runs parent
          set status = case
                when exists (
                  select 1 from piles_auto_assignment_insurer_runs child
                  where child.runner_run_id = parent.id
                    and (
                      child.status in ('completed', 'partial', 'manual_action_required')
                      or child.confirmed_pile_count > 0
                    )
                ) then 'partial'
                else 'failed'
              end,
              finished_at = coalesce(finished_at, now()),
              updated_at = now(),
              details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
                'stale_recovery_at', now(),
                'stale_recovery_mode', 'advisory_lock_guarded'
              )
          where parent.id = $1
            and parent.status in ('queued', 'started', 'running')
            and not exists (
              select 1 from piles_auto_assignment_insurer_runs active
              where active.runner_run_id = parent.id and active.status in ('queued', 'running')
            )
        `, [runnerRunId]);
      }
      await client.query('commit');
      recovered += 1;
    } catch (error) {
      if (apply) await client.query('rollback');
      throw error;
    } finally {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
    }
  }
} finally {
  client.release();
  await pool.end();
}

console.log(`Recovery summary: recovered=${recovered} lock_held=${locked} mode=${apply ? 'apply' : 'inspect'}`);
if (apply && locked) process.exitCode = 2;
