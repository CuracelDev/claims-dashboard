// app/api/auth/signout/route.js
// Deletes the session row from Supabase on sign out.
// Called by the Sign Out button in the sidebar/header.
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: true }); // silent — client clears localStorage anyway
  }

  const { session_token } = body;

  if (session_token) {
    await supabase
      .from('sessions')
      .delete()
      .eq('session_token', session_token);
    // Errors are intentionally swallowed — client-side clear happens regardless
  }

  return Response.json({ ok: true });
}
