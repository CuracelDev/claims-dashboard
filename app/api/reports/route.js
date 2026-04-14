// app/api/reports/route.js
import { getSupabase } from '../../../lib/supabase';
export const dynamic = 'force-dynamic';

async function attachTeamMembers(supabase, reports) {
  if (!Array.isArray(reports) || reports.length === 0) return reports || [];

  const memberIds = [...new Set(reports.map((r) => r.team_member_id).filter(Boolean))];
  if (memberIds.length === 0) return reports;

  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, name, display_name, role')
    .in('id', memberIds);

  if (error) throw error;

  const memberMap = new Map((members || []).map((m) => [String(m.id), m]));
  return reports.map((r) => ({
    ...r,
    team_members: memberMap.get(String(r.team_member_id)) || null,
  }));
}

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const personId = searchParams.get('person_id');
    const date = searchParams.get('date');
    const memberId = searchParams.get('member_id');
    const limit = parseInt(searchParams.get('limit') || '50');

    if (personId && date) {
      const { data, error } = await supabase
        .from('daily_reports')
        .select('*')
        .eq('team_member_id', parseInt(personId))
        .eq('report_date', date)
        .maybeSingle();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ data });
    }

    if (date) {
      const { data, error } = await supabase
        .from('daily_reports')
        .select('*')
        .eq('report_date', date)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      const withMembers = await attachTeamMembers(supabase, data || []);
      return Response.json({ data: withMembers });
    }

    let q = supabase
      .from('daily_reports')
      .select('*')
      .order('report_date', { ascending: false })
      .limit(limit);
    if (memberId) q = q.eq('team_member_id', parseInt(memberId));
    const { data, error } = await q;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    const withMembers = await attachTeamMembers(supabase, data || []);
    return Response.json({ data: withMembers });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const supabase = getSupabase();
    const body = await request.json();

    // Partial update (e.g. sent_to_slack)
    if (body.id) {
      const { id, ...updates } = body;
      const { data, error } = await supabase
        .from('daily_reports').update(updates).eq('id', id).select().single();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ data });
    }

    const { team_member_id, report_date, metrics, tasks_completed, notes, status } = body;
    if (!team_member_id || !report_date) {
      return Response.json({ error: 'team_member_id and report_date are required' }, { status: 400 });
    }

    const memberId = parseInt(team_member_id);

    const safeMetrics = {};
    if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) {
      for (const [k, v] of Object.entries(metrics)) {
        const num = parseInt(v);
        if (!isNaN(num)) safeMetrics[k] = num;
      }
    }

    const payload = {
      team_member_id: memberId,
      report_date,
      metrics: safeMetrics,
      tasks_completed: tasks_completed || null,
      notes: notes || null,
      status: status || 'submitted',
    };

    // Check if exists
    const { data: existingRows } = await supabase
      .from('daily_reports')
      .select('id')
      .eq('team_member_id', memberId)
      .eq('report_date', report_date)
      .order('created_at', { ascending: false })
      .limit(1);
    const existing = existingRows?.[0];

    let data, error, isEdit;
    if (existing?.id) {
      isEdit = true;
      ({ data, error } = await supabase
        .from('daily_reports')
        .update({ metrics: safeMetrics, tasks_completed: tasks_completed || null, notes: notes || null, status: status || 'submitted' })
        .eq('id', existing.id)
        .select().single());
    } else {
      isEdit = false;
      ({ data, error } = await supabase
        .from('daily_reports')
        .insert(payload)
        .select().single());
    }

    if (error) return Response.json({ error: error.message }, { status: 500 });

    // Look up member name for audit
    const { data: member } = await supabase
      .from('team_members')
      .select('name, display_name')
      .eq('id', memberId)
      .maybeSingle();

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        member_id:   memberId,
        member_name: member?.display_name || member?.name || 'Unknown',
        action:      isEdit ? 'report.edit' : 'report.submit',
        entity_type: 'daily_report',
        entity_id:   data?.id || null,
        details:     { report_date, status: status || 'submitted' },
        source:      'app',
      });
    } catch {}

    return Response.json({ data });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
