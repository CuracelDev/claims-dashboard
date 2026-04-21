// app/api/auth/signout/route.js
import { getSupabase } from '../../../../lib/supabase';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const supabase = getSupabase();

  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: true }); }

  const { session_token } = body;

  if (session_token) {
    // Look up session before deleting so we can log who signed out
    const { data: session } = await supabase
      .from('sessions')
      .select('member_id')
      .eq('session_token', session_token)
      .maybeSingle();

    let member = null;
    if (session?.member_id) {
      const { data } = await supabase
        .from('team_members')
        .select('name, display_name')
        .eq('id', session.member_id)
        .maybeSingle();
      member = data;
    }

    await supabase.from('sessions').delete().eq('session_token', session_token);

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        member_id:   session?.member_id ? parseInt(session.member_id) : null,
        member_name: member?.display_name || member?.name || 'Unknown',
        action:      'auth.logout',
        entity_type: 'session',
        entity_id:   null,
        source:      'app',
      });
    } catch {}
  }

  return Response.json({ ok: true });
}
