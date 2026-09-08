import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';
import { toRunnerProgressView } from '../../../../../lib/piles-auto-assignment-view-model.mjs';

export const dynamic = 'force-dynamic';

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 250);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = normalizeLimit(searchParams.get('limit'));
    const runId = String(searchParams.get('id') || '').trim();
    const supabase = getSupabase();

    let runQuery = supabase
      .from('piles_auto_assignment_runner_runs')
      .select('id,insurer_name,run_scope,portal_environment,backend,run_source,months,year,mode,status,started_at,finished_at,duration_ms,created_at,updated_at')
      .order('started_at', { ascending: false })
      .limit(runId ? 1 : limit);
    if (runId) runQuery = runQuery.eq('id', runId);
    const runResponse = await runQuery;
    if (runResponse.error) throw runResponse.error;
    const runs = runResponse.data || [];
    const runIds = runs.map((run) => run.id);
    if (!runIds.length) return NextResponse.json({ success: true, runs: [] });

    const insurerResponse = await supabase
      .from('piles_auto_assignment_insurer_runs')
      .select('id,runner_run_id,insurer_name,status,phase,error_code,error_message,heartbeat_at,started_at,finished_at')
      .in('runner_run_id', runIds)
      .order('created_at', { ascending: true });
    if (insurerResponse.error) throw insurerResponse.error;
    const insurerRuns = insurerResponse.data || [];
    const insurerRunIds = insurerRuns.map((item) => item.id);

    let contexts = [];
    let batches = [];
    if (insurerRunIds.length) {
      const [contextResponse, batchResponse] = await Promise.all([
        supabase.from('piles_auto_assignment_scan_contexts')
          .select('insurer_run_id,status,distinct_pile_count,unassigned_pile_count,claim_count')
          .in('insurer_run_id', insurerRunIds),
        supabase.from('piles_auto_assignment_batches')
          .select('insurer_run_id,status,planned_pile_count,confirmed_pile_count,pending_pile_count,conflict_pile_count,failed_pile_count')
          .in('insurer_run_id', insurerRunIds),
      ]);
      if (contextResponse.error) throw contextResponse.error;
      if (batchResponse.error) throw batchResponse.error;
      contexts = contextResponse.data || [];
      batches = batchResponse.data || [];
    }

    return NextResponse.json({
      success: true,
      runs: runs.map((run) => {
        const ownInsurers = insurerRuns.filter((item) => item.runner_run_id === run.id);
        const ownIds = new Set(ownInsurers.map((item) => item.id));
        return toRunnerProgressView(
          run,
          ownInsurers,
          contexts.filter((item) => ownIds.has(item.insurer_run_id)),
          batches.filter((item) => ownIds.has(item.insurer_run_id)),
        );
      }),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to load runner history.' }, { status: 500 });
  }
}
