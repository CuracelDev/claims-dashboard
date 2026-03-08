import { getSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// GET /api/team
export async function GET() {
  const supabase = getSupabase();
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select('*')
      .order('name');
    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/team — add new member
export async function POST(request) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const { name, role, slack_user_id } = body;
    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });

    // Check for name collision
    const { data: existing } = await supabase
      .from('team_members')
      .select('id, name, active')
      .ilike('name', name.trim());

    let finalName = name.trim();
    let collision = null;

    if (existing && existing.length > 0) {
      const activeMatch = existing.find(m => m.active !== false);
      if (activeMatch) {
        collision = { type: 'collision', existing: activeMatch, suggested: finalName };
        return Response.json({ collision });
      }
      // Inactive match = same person returning
      const inactiveMatch = existing.find(m => m.active === false);
      if (inactiveMatch) {
        collision = { type: 'returning', existing: inactiveMatch };
        return Response.json({ collision });
      }
    }

    const { data, error } = await supabase
      .from('team_members')
      .insert({ name: finalName, role: role || '', slack_user_id: slack_user_id || '', active: true })
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// PATCH /api/team — update member (name, role, active status, reactivate)
export async function PATCH(request) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const { id, name, role, slack_user_id, active, display_name } = body;
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (role !== undefined) updates.role = role;
    if (slack_user_id !== undefined) updates.slack_user_id = slack_user_id;
    if (active !== undefined) updates.active = active;
    if (display_name !== undefined) updates.display_name = display_name;

    const { data, error } = await supabase
      .from('team_members')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
