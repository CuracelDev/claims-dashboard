// PATH: app/api/birthday-wish/route.js
import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

async function slackPost(channel, text, blocks) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text, blocks }),
  });
  return res.json();
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  if (secret !== 'DataOps2026') return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const testId = searchParams.get('test_id');
  const supabase = getSupabase();

  // Lagos date
  const lagosNow = new Date(Date.now() + 60 * 60000);
  const today = lagosNow.toISOString().slice(0, 10);
  const [, mm, dd] = today.split('-');

  let query = supabase.from('team_members').select('*').eq('active', true);
  if (testId) {
    query = query.eq('id', parseInt(testId));
  } else {
    // Match month and day only
    query = query.filter('birthday', 'gte', `0001-${mm}-${dd}`).filter('birthday', 'lte', `9999-${mm}-${dd}`);
  }

  const { data: members, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Filter by exact month-day match (Supabase date comparison includes year)
  const birthdayMembers = testId
    ? members
    : members.filter(m => {
        if (!m.birthday) return false;
        const bday = m.birthday.slice(5, 10); // MM-DD
        return bday === `${mm}-${dd}`;
      });

  if (birthdayMembers.length === 0) {
    return Response.json({ success: true, message: 'No birthdays today', date: today });
  }

  const results = [];
  for (const member of birthdayMembers) {
    const name = member.display_name || member.name;
    const mention = member.slack_user_id ? `<@${member.slack_user_id}>` : `*${name}*`;

    // Post to #health-ops
    const channelRes = await slackPost(
      'C03TBH0RL76',
      `🎂 Happy Birthday ${name}!`,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎂 *Happy Birthday ${mention}!* 🎉\n\nWishing you an amazing day filled with joy and celebration. Thank you for everything you bring to the team! 🙌`,
          },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_Sent with ❤️ from the Claims Intel Dashboard_` }],
        },
      ]
    );

    // Also DM the birthday person if they have a Slack ID
    if (member.slack_user_id) {
      await slackPost(
        member.slack_user_id,
        `🎂 Happy Birthday ${name}!`,
        [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎂 *Happy Birthday ${name}!* 🎉\n\nThe whole Curacel Health Ops team is wishing you an incredible day. You're a star! ⭐`,
          },
        }]
      );
    }

    results.push({ name, slack_ok: channelRes.ok });
  }

  return Response.json({ success: true, date: today, wished: results });
}
