// app/api/auth/members/route.js
// Returns active team members for the login name-picker grid.
// Never returns report_pin — PIN check is server-side only in /verify.
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, display_name, report_pin, slack_user_id')
    .eq('is_active', true)
    .order('name');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Unique members by name or id to avoid duplicates in UI
  const uniqueMap = new Map();
  data.forEach(m => {
    const key = m.id || m.name;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, m);
    }
  });

  const uniqueData = Array.from(uniqueMap.values());

  return Response.json({
    members: uniqueData.map((m) => ({
      id: m.id, // Keep as string (text in DB)
      name: m.display_name || m.name,
      has_pin: !!m.report_pin,
      slack_user_id: m.slack_user_id || null,
      initials: (m.display_name || m.name)
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2),
    })),
  });
}
