import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET /api/reports?person_id=&date=&from=&to=&limit=
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const personId = searchParams.get('person_id');
  const date = searchParams.get('date');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const limit = parseInt(searchParams.get('limit') || '50');

  try {
    let query = supabase
      .from('daily_reports')
      .select(`
        *,
        team_members (id, name, role, slack_user_id)
      `)
      .order('report_date', { ascending: false })
      .limit(limit);

    if (personId) query = query.eq('team_member_id', personId);
    if (date) query = query.eq('report_date', date);
    if (from) query = query.gte('report_date', from);
    if (to) query = query.lte('report_date', to);

    const { data, error } = await query;
    if (error) throw error;

    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/reports — create or upsert a daily report
export async function POST(request) {
  try {
    const body = await request.json();
    const { team_member_id, report_date, metrics, tasks_completed, notes, status } = body;

    if (!team_member_id || !report_date) {
      return Response.json({ error: 'team_member_id and report_date are required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('daily_reports')
      .upsert(
        {
          team_member_id,
          report_date,
          metrics: metrics || {},
          tasks_completed: tasks_completed || '',
          notes: notes || '',
          status: status || 'submitted',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'team_member_id,report_date' }
      )
      .select()
      .single();

    if (error) throw error;

    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// PATCH /api/reports — update slack send status
export async function PATCH(request) {
  try {
    const body = await request.json();
    const { id, sent_to_slack, slack_channel, sent_at } = body;

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const { data, error } = await supabase
      .from('daily_reports')
      .update({ sent_to_slack, slack_channel, sent_at })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
