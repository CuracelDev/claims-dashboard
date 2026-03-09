import { getSupabase } from '../../../lib/supabase';
export const dynamic = 'force-dynamic';



export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');
  if (secret !== process.env.REMINDER_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();
  const today = new Date().toISOString().split('T')[0];
  const botToken = process.env.SLACK_BOT_TOKEN;

  try {
    const { data: members, error: membersErr } = await supabase
      .from('team_members')
      .select('id, name, slack_user_id, role')
      .eq('active', true);
    if (membersErr) throw membersErr;

    const { data: reports } = await supabase
      .from('daily_reports')
      .select('team_member_id')
      .eq('report_date', today);
    const submittedIds = new Set((reports || []).map(r => r.team_member_id));

    const { data: leaveToday } = await supabase
      .from('team_leave')
      .select('team_member_id')
      .lte('start_date', today)
      .gte('end_date', today);
    const onLeaveIds = new Set((leaveToday || []).map(l => l.team_member_id));

    const sendDM = async (slackUserId, blocks) => {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${botToken}` },
        body: JSON.stringify({ channel: slackUserId, blocks }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      return data;
    };

    const reminderResults = [];
    const skipped = [];
    const submitted = [];
    let remindersSent = 0;

    for (const member of members) {
      if (submittedIds.has(member.id)) {
        submitted.push({ name: member.name });
        continue;
      }
      if (onLeaveIds.has(member.id)) {
        skipped.push({ name: member.name, reason: 'On leave' });
        continue;
      }
      if (!member.slack_user_id) {
        skipped.push({ name: member.name, reason: 'No Slack user ID' });
        continue;
      }
      try {
        const dayLabel = new Date(today + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
        await sendDM(member.slack_user_id, [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `👋 Hey *${member.name}*, your daily report for *${dayLabel}* hasn't been submitted yet.\n\nTakes less than 2 minutes — let's keep the team in sync! 🙌` },
          },
          {
            type: 'actions',
            elements: [{ type: 'button', text: { type: 'plain_text', text: '📝 Fill Report Now' }, style: 'primary', url: 'https://claims-dashboard.vercel.app/reports' }],
          },
        ]);
        reminderResults.push({ name: member.name, status: 'sent' });
        remindersSent++;
      } catch (err) {
        reminderResults.push({ name: member.name, status: 'error', error: err.message });
      }
    }

    const muyiwa = members.find(m => m.name?.toLowerCase().includes('muyiwa'));
    if (muyiwa?.slack_user_id) {
      const pendingNames = members.filter(m => !submittedIds.has(m.id) && !onLeaveIds.has(m.id)).map(m => m.name);
      const onLeaveNames = members.filter(m => onLeaveIds.has(m.id)).map(m => m.name);
      try {
        await sendDM(muyiwa.slack_user_id, [{
          type: 'section',
          text: { type: 'mrkdwn', text: `📊 *Daily Report Summary* — ${today}\n\n✅ *Submitted (${submittedIds.size}):* ${submitted.map(s => s.name).join(', ') || 'None'}\n⏳ *Pending (${pendingNames.length}):* ${pendingNames.join(', ') || 'None'}\n🌙 *On leave (${onLeaveNames.length}):* ${onLeaveNames.join(', ') || 'None'}` },
        }]);
      } catch (err) { console.error('Summary DM failed:', err.message); }
    }

    await supabase.from('slack_summaries').insert({
      date: today, summary_type: 'daily_reminder',
      submitted_count: submittedIds.size,
      pending_count: members.length - submittedIds.size - onLeaveIds.size,
      results: { reminders: reminderResults, skipped, on_leave: [...onLeaveIds] },
    });

    return Response.json({
      success: true, date: today,
      total_members: members.length,
      submitted: submittedIds.size,
      on_leave: onLeaveIds.size,
      reminders_sent: remindersSent,
      skipped,
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
