// app/api/okr/route.js
import { getSupabase } from '../../../lib/supabase';
export const dynamic = 'force-dynamic';

// Seed data for Q1 2026 — only loaded if table is empty for that quarter
const Q1_SEED = [
  // Objective 1
  { quarter: 'Q1', objective: 'Hit reliable claims turnaround performance (14-hour SLA) across clients', kr_number: 'KR1', key_result: 'Achieve ≥ 90% of claims processed within 14 hours (quarter average, across supported clients)', target: '90%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Hit reliable claims turnaround performance (14-hour SLA) across clients', kr_number: 'KR2', key_result: 'Maintain speed edge: ≥ 60% of claims processed within 1 hour (quarter average)', target: '60%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Hit reliable claims turnaround performance (14-hour SLA) across clients', kr_number: 'KR3', key_result: 'Control the tail: ≤ 5% of claims exceed 24 hours turnaround time', target: '5%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Hit reliable claims turnaround performance (14-hour SLA) across clients', kr_number: 'KR4', key_result: 'Process 500,000 claims', target: '500000', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Hit reliable claims turnaround performance (14-hour SLA) across clients', kr_number: 'KR5', key_result: 'Process 70,000 claims piles', target: '70000', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Hit reliable claims turnaround performance (14-hour SLA) across clients', kr_number: 'KR6', key_result: 'Resolve 300,000 cares', target: '300000', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  // Objective 2
  { quarter: 'Q1', objective: 'Reduce reactivity by building a proactive incident-prevention system', kr_number: 'KR1', key_result: 'Improve incident recovery speed: reduce MTTR from 2–3 hours → ≤ 90 minutes for data/claims incidents (median)', target: '90', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Reduce reactivity by building a proactive incident-prevention system', kr_number: 'KR2', key_result: 'Reduce critical disruption: Sev-1 incidents ≤ 3 in Q1', target: '3', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Reduce reactivity by building a proactive incident-prevention system', kr_number: 'KR3', key_result: 'Prevent repeat issues: ≥ 80% of incidents have documented RCA + permanent fix shipped within 10 business days', target: '80%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Reduce reactivity by building a proactive incident-prevention system', kr_number: 'KR4', key_result: 'Reduce rework rate by 20%', target: '20%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Reduce reactivity by building a proactive incident-prevention system', kr_number: 'KR5', key_result: 'Close 95% of escalations within SLA', target: '95%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  // Objective 3
  { quarter: 'Q1', objective: 'Increase data trust via stronger vendor controls, reconciliation, and governance', kr_number: 'KR1', key_result: 'Increase auto-approval rate by 10%', target: '10%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Increase data trust via stronger vendor controls, reconciliation, and governance', kr_number: 'KR2', key_result: 'Complete 100,000 care mappings', target: '100000', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Increase data trust via stronger vendor controls, reconciliation, and governance', kr_number: 'KR3', key_result: 'Flag 5,000,000 cares', target: '5000000', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Increase data trust via stronger vendor controls, reconciliation, and governance', kr_number: 'KR4', key_result: 'Move 50% of HealthOps processes to Curacel playbook', target: '50%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Increase data trust via stronger vendor controls, reconciliation, and governance', kr_number: 'KR5', key_result: 'Maintain data quality accuracy ≥ 98%', target: '98%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  // Objective 4
  { quarter: 'Q1', objective: 'Build an AI-First & High-Performance Data Operations team', kr_number: 'KR1', key_result: 'Each team member completes 2 role-relevant AI automation courses', target: '2', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Build an AI-First & High-Performance Data Operations team', kr_number: 'KR2', key_result: 'Conduct 2 external AI / Ops workshops', target: '2', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Build an AI-First & High-Performance Data Operations team', kr_number: 'KR3', key_result: 'Conduct 1 internal AI workflow automation workshop', target: '1', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
  { quarter: 'Q1', objective: 'Build an AI-First & High-Performance Data Operations team', kr_number: 'KR4', key_result: 'Achieve Expert-level proficiency for 30% of team on AI competency tracker', target: '30%', actual: '', status: 'In Progress', start_date: '1/1/2026', due_date: '31/3/2026' },
];

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const quarter = searchParams.get('quarter') || 'Q1';

    // Check if data exists for this quarter
    const { data: existing, error: checkErr } = await supabase
      .from('okr_entries')
      .select('id')
      .eq('quarter', quarter)
      .limit(1);

    if (checkErr) throw checkErr;

    // Seed Q1 if empty
    if (quarter === 'Q1' && (!existing || existing.length === 0)) {
      const { error: seedErr } = await supabase.from('okr_entries').insert(Q1_SEED);
      if (seedErr) console.error('[okr seed]', seedErr.message);
    }

    const { data, error } = await supabase
      .from('okr_entries')
      .select('*')
      .eq('quarter', quarter)
      .order('id', { ascending: true });

    if (error) throw error;

    return new Response(JSON.stringify({ data: data || [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ data: [], error: err.message }), { status: 500 });
  }
}

export async function POST(request) {
  try {
    const supabase = getSupabase();
    const body = await request.json();
    const { action, row } = body;

    if (action === 'upsert') {
      // Update existing row
      const grade = computeGrade(row.target, row.actual);
      const { error } = await supabase
        .from('okr_entries')
        .update({ target: row.target, actual: row.actual, grade, status: row.status })
        .eq('id', row.id);
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (action === 'insert') {
      const grade = computeGrade(row.target, row.actual);
      const { data, error } = await supabase
        .from('okr_entries')
        .insert({ ...row, grade })
        .select()
        .single();
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    }

    if (action === 'delete') {
      const { error } = await supabase.from('okr_entries').delete().eq('id', row.id);
      if (error) throw error;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

function computeGrade(target, actual) {
  if (!target || !actual || actual === '') return null;
  const t = parseFloat(String(target).replace(/[%,]/g, ''));
  const a = parseFloat(String(actual).replace(/[%,]/g, ''));
  if (isNaN(t) || isNaN(a) || t === 0) return null;
  return Math.round((a / t) * 10000) / 10000;
}
