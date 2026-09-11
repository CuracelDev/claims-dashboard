import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';
import { toRunnerProgressView } from '../../../../../lib/piles-auto-assignment-view-model.mjs';

export const dynamic = 'force-dynamic';

function normalizeLimit(value) {
  if (value == null || value === '') return 100;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 250);
}

// Both adapters support bound id > cursor filters. UUID insertions behind the
// cursor cannot shift a later page and duplicate/skip already-existing rows.
// This is a live read, not a transaction snapshot; later inserts behind the
// cursor become visible on the next history refresh. Stay below the hosted
// response cap with a hard request budget.
// Exceeding the budget fails rather than returning misleading partial counts.
async function loadRows(query, maximum = 100000) {
  const rows = [];
  let cursor = null;
  while (rows.length <= maximum) {
    let pageQuery = query().order('id', { ascending: true }).limit(500);
    if (cursor !== null) pageQuery = pageQuery.gt('id', cursor);
    const response = await pageQuery;
    if (response.error) throw response.error;
    const page = response.data || [];
    if (page.length > 500) throw new Error('History page budget exceeded');
    for (const row of page) {
      // Runner-produced IDs are immutable ASCII opaque values. Refuse malformed,
      // repeated or out-of-order cursors instead of looping or double counting.
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(row.id) || (cursor !== null && row.id <= cursor)) throw new Error('Invalid history cursor');
      cursor = row.id;
    }
    rows.push(...page);
    if (rows.length > maximum) throw new Error('History row budget exceeded');
    if (page.length < 500) return rows;
  }
  throw new Error('History row budget exceeded');
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = normalizeLimit(searchParams.get('limit'));
    const runId = String(searchParams.get('id') || '').trim();
    const supabase = getSupabase();

    let runQuery = supabase
      .from('piles_auto_assignment_runner_runs')
      // Details are inspected only for bounded opaque dispatch references.
      .select('id,insurer_name,run_scope,portal_environment,backend,run_source,months,year,mode,status,started_at,finished_at,duration_ms,details')
      .order('started_at', { ascending: false })
      .limit(runId ? 1 : limit);
    if (runId) runQuery = runQuery.eq('id', runId);
    const runResponse = await runQuery;
    if (runResponse.error) throw runResponse.error;
    const runs = runResponse.data || [];
    const runIds = runs.map((run) => run.id);
    if (!runIds.length) return NextResponse.json({ success: true, runs: [] });

    const insurerRuns = await loadRows(() => supabase
      .from('piles_auto_assignment_insurer_runs')
      .select('id,runner_run_id,insurer_name,status,phase,error_code,error_message,heartbeat_at,started_at,finished_at,discovered_pile_count,discovered_claim_count,planned_pile_count,submitted_pile_count,confirmed_pile_count,reconciliation_pending_pile_count,conflict_pile_count,failed_pile_count,details')
      .in('runner_run_id', runIds), 64000);
    const insurerRunIds = insurerRuns.map((item) => item.id);

    let workItems = [];
    let workItemsAvailable = true;
    try {
      workItems = await loadRows(() => supabase.from('piles_auto_assignment_work_items')
        .select('id,parent_runner_run_id,insurer_name,source,request_scope,disposition,covered_by_insurer_run_id,heartbeat_at,started_at,finished_at,reason_code')
        .in('parent_runner_run_id', runIds), 64000);
    } catch (error) {
      // Table feature detection on the exact optional-table read, for pg and
      // PostgREST. Permission, missing-column, and network errors remain errors.
      if (!['42P01', 'PGRST205'].includes(error.code)) throw error;
      workItemsAvailable = false;
    }

    let contexts = [];
    let batches = [];
    if (insurerRunIds.length) {
      [contexts, batches] = await Promise.all([
        loadRows(() => supabase.from('piles_auto_assignment_scan_contexts')
          .select('id,insurer_run_id,status,distinct_pile_count,unassigned_pile_count,claim_count')
          .in('insurer_run_id', insurerRunIds)),
        loadRows(() => supabase.from('piles_auto_assignment_batches')
          .select('id,insurer_run_id,status,planned_pile_count,selected_pile_count,confirmed_pile_count,pending_pile_count,conflict_pile_count,failed_pile_count')
          .in('insurer_run_id', insurerRunIds)),
      ]);
    }

    return NextResponse.json({
      success: true,
      work_items_available: workItemsAvailable,
      runs: runs.map((run) => {
        const ownInsurers = insurerRuns.filter((item) => item.runner_run_id === run.id);
        const ownIds = new Set(ownInsurers.map((item) => item.id));
        return toRunnerProgressView(
          run,
          ownInsurers,
          contexts.filter((item) => ownIds.has(item.insurer_run_id)),
          batches.filter((item) => ownIds.has(item.insurer_run_id)),
          workItems.filter((item) => item.parent_runner_run_id === run.id),
        );
      }),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to load runner history.' }, { status: 500 });
  }
}
