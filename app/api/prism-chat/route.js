// PATH: app/api/prism-chat/route.js
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const PRISM_ID = 'U0AF86M8TRS';
const CHANNEL = 'C03TBH0RL76';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

async function slackPost(body) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function pollForReply(ts, maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 4000));
    const res = await fetch(
      `https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${ts}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const data = await res.json();
    if (data.ok) {
      const reply = (data.messages || []).find(
        m => m.user === PRISM_ID && m.ts !== ts
      );
      if (reply) return reply.text;
    }
  }
  return null;
}

async function categorise(message) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Categorise this message sent to an AI agent in a health insurance ops team.

Message: "${message}"

Return ONLY valid JSON with:
- category: one of [Pipeline Health, QA Analysis, Escalation, Weekly Review, Task Assignment, Reminder, Custom Query, General]
- summary: single sentence max 12 words

Example: {"category":"Weekly Review","summary":"Requested highlights and insights for the week"}

No markdown, no preamble, just JSON.`,
      }],
    });
    return JSON.parse(res.content[0]?.text || '{}');
  } catch {
    return { category: 'General', summary: message.slice(0, 80) };
  }
}

export async function POST(request) {
  try {
    const { message, member_name } = await request.json();
    if (!message) return Response.json({ error: 'No message provided' }, { status: 400 });

    // Post to Slack
    const slackData = await slackPost({
      channel: CHANNEL,
      text: message,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `<@${PRISM_ID}> ${message}` },
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
    });

    if (!slackData.ok) {
      return Response.json({ success: false, error: slackData.error }, { status: 500 });
    }

    // Poll for Prism's reply (max 15s)
    const prismReply = await pollForReply(slackData.ts);

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

    return Response.json({
      success: true,
      ts: slackData.ts,
      category,
      summary,
      prism_reply: prismReply,
    });

  } catch (err) {
    console.error('[prism-chat error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
