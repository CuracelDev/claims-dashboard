import { getSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

async function sendSlackDM(userId, text, blocks) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not configured');

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: userId, text, blocks }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack DM error: ${data.error}`);
  return data;
}

export async function GET(request) {
  // Allow manual trigger with ?secret= for testing
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const isManual = secret === process.env.REMINDER_SECRET;
  const isCron = request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`;

  if (!isManual && !isCron) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();
  const today = new Date().toISOString().split('T')[0];

  try {
    // Get all active team members with slack IDs
    const { data: members, error: membersError } = await supabase
      .from('team_members')
      .select('id, name, role, slack_user_id')
      .eq('active', true);

    if (membersError) throw membersError;

    // Get who has submitted today
    const { data: reports, error: reportsError } = await supabase
      .from('daily_reports')
      .select('team_member_id')
      .eq('report_date', today);

    if (reportsError) throw reportsError;

    const submittedIds = new Set((reports || []).map(r => r.team_member_id));
    const notSubmitted = members.filter(m => !submittedIds.has(m.id));
    const submitted = members.filter(m => submittedIds.has(m.id));

    const results = { sent: [], skipped: [], errors: [] };

    const dateStr = new Date(today + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    // Send DM to each person who hasn't submitted
    for (const member of notSubmitted) {
      if (!member.slack_user_id) {
        results.skipped.push({ name: member.name, reason: 'No Slack user ID' });
        continue;
      }
      try {
        await sendSlackDM(
          member.slack_user_id,
          `⏰ Reminder: Please fill your daily report for ${dateStr}`,
          [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Hey ${member.name.split(' ')[0]}! 👋\n\nYou haven't submitted your daily report for *${dateStr}* yet.\n\nIt only takes a few minutes — please fill it in before the day ends! 🙏`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '📝 Fill Report Now', emoji: true },
                  url: 'https://claims-dashboard.vercel.app/reports',
                  style: 'primary',
                },
              ],
            },
          ]
        );
        results.sent.push(member.name);
      } catch (err) {
        results.errors.push({ name: member.name, error: err.message });
      }
    }

    // Send summary DM to Muyiwa (team lead)
    const teamLead = members.find(m => m.name.toLowerCase().includes('muyiwa'));
    if (teamLead?.slack_user_id) {
      const summaryBlocks = [
        {
          type: 'header',
          text: { type: 'plain_text', text: `📊 Daily Report Status — ${dateStr}`, emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${submitted.length} of ${members.length} team members* have submitted their reports.`,
          },
        },
      ];

      if (submitted.length > 0) {
        summaryBlocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ *Submitted:*\n${submitted.map(m => `• ${m.name}`).join('\n')}` },
        });
      }

      if (notSubmitted.length > 0) {
        summaryBlocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `⏳ *Pending:*\n${notSubmitted.map(m => `• ${m.name}`).join('\n')}` },
        });
      }

      summaryBlocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '👥 View Team Reports', emoji: true },
            url: 'https://claims-dashboard.vercel.app/reports',
          },
        ],
      });

      try {
        await sendSlackDM(teamLead.slack_user_id, `Daily report status: ${submitted.length}/${members.length} submitted`, summaryBlocks);
        results.leadSummary = 'sent';
      } catch (err) {
        results.leadSummary = `failed: ${err.message}`;
      }
    }

    // Log to slack_summaries table
    await supabase.from('slack_summaries').insert({
      date: today,
      summary_type: 'daily_reminder',
      submitted_count: submitted.length,
      pending_count: notSubmitted.length,
      results: results,
    }).select();

    return Response.json({
      success: true,
      date: today,
      total_members: members.length,
      submitted: submitted.length,
      reminders_sent: results.sent.length,
      skipped: results.skipped,
      errors: results.errors,
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
