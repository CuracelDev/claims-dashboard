// app/api/auth/signout/route.js
import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: true }); }

  const { session_token } = body;

  if (session_token) {
    // Look up session before deleting so we can log who signed out
    const { data: session } = await supabase
      .from('sessions')
      .select('member_id, team_members(name, display_name)')
      .eq('session_token', session_token)
      .maybeSingle();

    await supabase.from('sessions').delete().eq('session_token', session_token);

    // Audit log
    try {
      const member = session?.team_members;
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
