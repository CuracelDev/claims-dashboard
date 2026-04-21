import { getSupabase } from '../../../lib/supabase';
export const dynamic = 'force-dynamic';

async function attachTeamMembers(supabase, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];

  const memberIds = [...new Set(rows.map((row) => row.team_member_id).filter(Boolean))];
  if (memberIds.length === 0) return rows;

  const { data: members, error } = await supabase
    .from('team_members')
    .select('id, name')
    .in('id', memberIds);

  if (error) throw error;

  const memberMap = new Map((members || []).map((member) => [String(member.id), member]));
  return rows.map((row) => ({
    ...row,
    team_members: memberMap.get(String(row.team_member_id)) || null,
  }));
}


export async function GET(req) {
  const supabase = getSupabase();
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date');
  const memberId = searchParams.get('member_id');
  const all = searchParams.get('all');

  try {
    if (date && all) {
      const { data, error } = await supabase
        .from('team_leave')
        .select('*')
        .lte('start_date', date)
        .gte('end_date', date);
      if (error) throw error;
      return Response.json({ data: await attachTeamMembers(supabase, data || []) });
    }

    if (date && memberId) {
      const { data, error } = await supabase
        .from('team_leave')
        .select('*')
        .eq('team_member_id', memberId)
        .lte('start_date', date)
        .gte('end_date', date);
      if (error) throw error;
      return Response.json({ data, on_leave: data.length > 0 });
    }

    if (memberId) {
      const today = new Date().toISOString().split('T')[0];
      const { data, error } = await supabase
        .from('team_leave')
        .select('*')
        .eq('team_member_id', memberId)
        .gte('end_date', today)
        .order('start_date', { ascending: true });
      if (error) throw error;
      return Response.json({ data });
    }

    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
      .from('team_leave')
      .select('*')
      .gte('end_date', today)
      .order('start_date', { ascending: true });
    if (error) throw error;
    return Response.json({ data: await attachTeamMembers(supabase, data || []) });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  const supabase = getSupabase();
  try {
    const body = await req.json();
    const { team_member_id, leave_type, start_date, end_date, reason, marked_by } = body;
    if (!team_member_id || !leave_type || !start_date || !end_date) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }
    const { data, error } = await supabase
      .from('team_leave')
      .insert({ team_member_id, leave_type, start_date, end_date, reason, marked_by })
      .select()
      .single();
    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  const supabase = getSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });
  try {
    const { error } = await supabase.from('team_leave').delete().eq('id', id);
    if (error) throw error;
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
