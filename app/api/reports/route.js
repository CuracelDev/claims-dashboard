import { getSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const personId = searchParams.get('person_id');
    const date = searchParams.get('date');
    const limit = searchParams.get('limit');

    if (personId && date) {
      // Single report lookup
      const { data, error } = await supabase
        .from('daily_reports')
        .select('*')
        .eq('team_member_id', personId)
        .eq('report_date', date)
        .maybeSingle();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ data });
    }

    if (date) {
      // Team view — all reports for a date
      const q = supabase
        .from('daily_reports')
        .select('*, team_members(name, display_name, role)')
        .eq('report_date', date)
        .order('created_at', { ascending: false });
      if (limit) q.limit(parseInt(limit));
      const { data, error } = await q;
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ data });
    }

    // History — filter by person and/or date range
    const memberId = searchParams.get('member_id');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const pageLimit = parseInt(searchParams.get('limit') || '50');

    let q = supabase
      .from('daily_reports')
      .select('*, team_members(name, display_name, role)')
      .order('report_date', { ascending: false })
      .limit(pageLimit);

    if (memberId) q = q.eq('team_member_id', memberId);
    if (from) q = q.gte('report_date', from);
    if (to) q = q.lte('report_date', to);

    const { data, error } = await q;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ data });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const supabase = getSupabase();
    const body = await request.json();

    // Handle partial updates (e.g. sent_to_slack flag)
    if (body.id) {
      const { id, ...updates } = body;
      const { data, error } = await supabase
        .from('daily_reports')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ data });
    }

    const { team_member_id, report_date, metrics, tasks_completed, notes, status } = body;

    if (!team_member_id || !report_date) {
      return Response.json({ error: 'team_member_id and report_date are required' }, { status: 400 });
    }

    // Ensure metrics is a plain object (not array, not string)
    const safeMetrics = metrics && typeof metrics === 'object' && !Array.isArray(metrics)
      ? metrics
      : {};

    // Check if report exists for this person+date
    const memberId = parseInt(team_member_id);
    const { data: existing } = await supabase
      .from('daily_reports')
      .select('id')
      .eq('team_member_id', memberId)
      .eq('report_date', report_date)
      .maybeSingle();

    let data, error;
    if (existing?.id) {
      ({ data, error } = await supabase
        .from('daily_reports')
        .update({ metrics: safeMetrics, tasks_completed: tasks_completed || null, notes: notes || null, status: status || 'submitted' })
        .eq('id', existing.id)
        .select().single());
    } else {
      ({ data, error } = await supabase
        .from('daily_reports')
        .insert({ team_member_id: memberId, report_date, metrics: safeMetrics, tasks_completed: tasks_completed || null, notes: notes || null, status: status || 'submitted' })
        .select().single());
    }

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ data });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
