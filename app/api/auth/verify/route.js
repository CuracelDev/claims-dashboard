// app/api/auth/verify/route.js
// Validates PIN server-side and creates a session row in Supabase.
// Returns a session_token UUID — the client stores this token.
// The token is the only thing the client can use to prove identity.
// Tampering with member_id or member_name in localStorage does nothing
// without a matching valid session_token in the sessions table.
import { getSupabase } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const supabase = getSupabase();

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ valid: false, error: 'Bad request' }, { status: 400 });
  }

  const { member_id, pin } = body;

  if (!member_id || !pin) {
    return Response.json({ valid: false, error: 'Missing fields' }, { status: 400 });
  }

  // 1. Look up member + PIN server-side
  const { data: member, error: memberError } = await supabase
    .from('team_members')
    .select('id, name, display_name, report_pin, is_active')
    .eq('id', member_id)
    .single();

  if (memberError || !member) {
    return Response.json({ valid: false, error: 'Member not found' }, { status: 401 });
  }

  if (!member.is_active) {
    return Response.json({ valid: false, error: 'Account inactive' }, { status: 403 });
  }

  // eslint-disable-next-line eqeqeq
  if (member.report_pin != pin) {
    return Response.json({ valid: false, error: 'Incorrect PIN' }, { status: 401 });
  }

  // 2. Create a session row — Supabase generates the UUID token
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .insert({
      member_id: member.id,
      is_guest: false,
      expires_at: expiresAt,
    })
    .select('session_token')
    .single();

  if (sessionError || !session) {
    console.error('[verify] session insert error:', sessionError?.message);
    return Response.json({ valid: false, error: 'Session creation failed' }, { status: 500 });
  }

  // Write audit log
  await supabase.from('audit_log').insert({
    member_id:   member.id,
    member_name: member.display_name || member.name,
    action:      'auth.login',
    entity_type: 'session',
    entity_id:   null,
    source:      'app',
  });

  return Response.json({
    valid: true,
    session_token: session.session_token,
    member_id: member.id,
    member_name: member.display_name || member.name,
  });
}
