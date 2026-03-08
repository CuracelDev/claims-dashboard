import { getSupabase } from '@/lib/supabase';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const personId = searchParams.get('person_id');
    const date = searchParams.get('date');
    const memberId = searchParams.get('member_id');
    const limit = parseInt(searchParams.get('limit') || '50');

    // Single report lookup
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

    // Team view for a date
    if (date) {
      const { data, error } = await supabase
        .from('daily_reports')
        .select('*, team_members(name, display_name, role)')
        .eq('report_date', date)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ data: data || [] });
    }

    // History
    let q = supabase
      .from('daily_reports')
      .select('*, team_members(name, display_name, role)')
      .order('report_date', { ascending: false })
      .limit(limit);
    if (memberId) q = q.eq('team_member_id', parseInt(memberId));
    const { data, error } = await q;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ data: data || [] });

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

    // Convert all metric values to numbers (inputs come as strings)
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
    const { data: existing } = await supabase
      .from('daily_reports')
      .select('id')
      .eq('team_member_id', memberId)
      .eq('report_date', report_date)
      .maybeSingle();

    let data, error;
    if (existing?.id) {
      const { metrics: _m, team_member_id: _t, report_date: _d, ...updatePayload } = payload;
      ({ data, error } = await supabase
        .from('daily_reports')
        .update({ metrics: safeMetrics, ...updatePayload })
        .eq('id', existing.id)
        .select().single());
    } else {
      ({ data, error } = await supabase
        .from('daily_reports')
        .insert(payload)
        .select().single());
    }

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ data });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
