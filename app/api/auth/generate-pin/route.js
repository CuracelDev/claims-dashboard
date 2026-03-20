// app/api/auth/generate-pin/route.js
// Generates a 6-digit PIN, saves to DB, DMs member on Slack
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function generatePIN() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const { member_id } = body;
  if (!member_id) {
    return Response.json({ error: 'Missing member_id' }, { status: 400 });
  }

  // 1. Get member
  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id, name, display_name, slack_user_id')
    .eq('id', parseInt(member_id))
    .single();

  if (memberErr || !member) {
    return Response.json({ error: 'Member not found' }, { status: 404 });
  }

  if (!member.slack_user_id) {
    return Response.json({ error: 'No Slack account linked. Ask your team lead to update your profile.' }, { status: 400 });
  }

  // 2. Generate + save PIN
  const pin = generatePIN();
  const { error: updateErr } = await supabase
    .from('team_members')
    .update({ report_pin: pin })
    .eq('id', parseInt(member_id));

  if (updateErr) {
    return Response.json({ error: 'Could not save PIN' }, { status: 500 });
  }

  // 3. DM via Slack
  const name = member.display_name || member.name;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: member.slack_user_id, // DM — Slack opens DM channel by user ID
      text: `🔐 Hi ${name}! Your Claims Intel PIN is: *${pin}*\n\nUse this to sign in at https://claims-dashboard.vercel.app/login\n_This PIN replaces any previous PIN._`,
    }),
  });

  const slackData = await res.json();

  if (!slackData.ok) {
    // PIN saved but Slack failed — still let them know
    return Response.json({ ok: true, slack_sent: false, slack_error: slackData.error });
  }

  return Response.json({ ok: true, slack_sent: true });
}
