// PATH: app/api/prism-chat/route.js
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

async function categorise(message) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `You are categorising a message sent to an AI agent called Prism in a health insurance ops team.

Message: "${message}"

Return ONLY a JSON object with two fields:
- category: one of [Pipeline Health, QA Analysis, Escalation, Weekly Review, Task Assignment, Reminder, Custom Query, General]
- summary: a single sentence (max 12 words) describing what was asked

Example: {"category":"Weekly Review","summary":"Requested highlights, lowlights and insights for the week"}

Return only valid JSON, no markdown, no preamble.`,
      }],
    });
    const text = res.content[0]?.text || '{}';
    return JSON.parse(text);
  } catch {
    return { category: 'General', summary: message.slice(0, 80) };
  }
}

export async function POST(request) {
  try {
    const { message, member_name } = await request.json();
    if (!message) return Response.json({ error: 'No message provided' }, { status: 400 });

    // Post to Slack
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: 'C0ALCPCE9FZ',
        text: `<@U0AF86M8TRS> ${message}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `<@U0AF86M8TRS> ${message}` },
          },
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `Sent via Claims Intel Dashboard${member_name ? ` by *${member_name}*` : ''} · <https://claims-dashboard.vercel.app/slack|Open Prism>`,
            }],
          },
        ],
        unfurl_links: false,
      }),
    });

    const slackData = await res.json();
    if (!slackData.ok) return Response.json({ success: false, error: slackData.error }, { status: 500 });

    // Categorise and log
    const { category, summary } = await categorise(message);
    const supabase = getSupabase();
    await supabase.from('prism_logs').insert({
      sent_by: member_name || 'Unknown',
      message,
      category,
      summary,
      slack_ts: slackData.ts,
      status: 'sent',
    });

    return Response.json({ success: true, ts: slackData.ts, category, summary });

  } catch (err) {
    console.error('[prism-chat error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
