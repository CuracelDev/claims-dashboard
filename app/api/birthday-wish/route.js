// PATH: app/api/birthday-wish/route.js
import Anthropic from '@anthropic-ai/sdk';
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

async function generateWish(name) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a warm, heartfelt, and prayerful birthday message for a team member named ${name} at Curacel, an African insurance tech company. 

The message should:
- Feel genuine and personal, not corporate
- Include a short prayer or blessing (non-denominational but warm — "May God..." or "May this year bring..." style)
- Celebrate their contribution to the team
- Be 3-4 sentences max
- End with a warm sign-off from "the Health Ops team"
- No emojis in the text itself (those will be added separately)
- No markdown, plain text only`,
      }],
    });
    return res.content[0]?.text || `Happy Birthday ${name}! Wishing you a wonderful day filled with joy and blessings.`;
  } catch {
    return `Happy Birthday ${name}! The whole Health Ops team is celebrating you today. May this new year of your life bring you abundant joy, good health, and everything your heart desires. You are deeply valued and appreciated — from the Health Ops team.`;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  if (secret !== 'DataOps2026') return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const testId = searchParams.get('test_id');
  const supabase = getSupabase();

  const lagosNow = new Date(Date.now() + 60 * 60000);
  const today = lagosNow.toISOString().slice(0, 10);
  const [, mm, dd] = today.split('-');

  let query = supabase.from('team_members').select('*').eq('active', true);
  if (testId) {
    query = query.eq('id', parseInt(testId));
  }

  const { data: members, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const birthdayMembers = testId
    ? members
    : members.filter(m => {
        if (!m.birthday) return false;
        return m.birthday.slice(5, 10) === `${mm}-${dd}`;
      });

  if (birthdayMembers.length === 0) {
    return Response.json({ success: true, message: 'No birthdays today', date: today });
  }

  const results = [];

  for (const member of birthdayMembers) {
    const name = member.display_name || member.name;
    const mention = member.slack_user_id ? `<@${member.slack_user_id}>` : `*${name}*`;

    // Generate personalised wish
    const wish = await generateWish(name);

    // Post to alerts channel — tags the person
    const channelRes = await slackPost(
      'C0ALCPCE9FZ',
      `🎂 Happy Birthday ${name}!`,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎂🎉 *Happy Birthday ${mention}!*`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: wish,
          },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `_Sent with ❤️ from the Claims Intel Dashboard · <https://claims-dashboard.vercel.app/team|Team Page>_`,
          }],
        },
      ]
    );

    // DM the birthday person
    if (member.slack_user_id) {
      await slackPost(
        member.slack_user_id,
        `🎂 Happy Birthday ${name}!`,
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🎂🎉 *Happy Birthday ${name}!*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: wish,
            },
          },
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `_With love from the Health Ops team ❤️_`,
            }],
          },
        ]
      );
    }

    results.push({ name, slack_ok: channelRes.ok, wish });
  }

  return Response.json({ success: true, date: today, wished: results });
}
