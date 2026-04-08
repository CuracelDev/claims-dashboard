// PATH: app/api/prism-chat/route.js
// Note: Anthropic SDK kept for reference, now using Azure OpenAI
// import Anthropic from '@anthropic-ai/sdk';
import { chatCompletionJSON, MODELS } from '../../../lib/azure-openai';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const PRISM_ID = 'U0AF86M8TRS';
const CHANNEL = 'C06DVSADD6J';

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
    // Check thread replies on our message
    const threadRes = await fetch(
      `https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${ts}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const threadData = await threadRes.json();
    if (threadData.ok) {
      const reply = (threadData.messages || []).find(
        m => m.user === PRISM_ID && m.ts !== ts
      );
      if (reply) return reply.text;
    }
    // Also check recent channel messages for any Prism response
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${CHANNEL}&oldest=${ts}&limit=10`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const histData = await histRes.json();
    if (histData.ok) {
      const reply = (histData.messages || []).find(m => m.user === PRISM_ID);
      if (reply) return reply.text;
    }
  }
  return null;
}

// JSON schema for structured output
const CATEGORISE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['Pipeline Health', 'QA Analysis', 'Escalation', 'Weekly Review', 'Task Assignment', 'Reminder', 'Custom Query', 'General'],
    },
    summary: {
      type: 'string',
      description: 'Single sentence summary, max 12 words',
    },
  },
  required: ['category', 'summary'],
  additionalProperties: false,
};

async function categorise(message) {
  try {
    const result = await chatCompletionJSON({
      model: MODELS.GPT_41,
      messages: [{
        role: 'user',
        content: `Categorise this message sent to an AI agent in a health insurance ops team.

Message: "${message}"

Provide:
- category: the most appropriate category for this message
- summary: a single sentence summary (max 12 words)`,
      }],
      maxTokens: 150,
      temperature: 0.3,
      jsonSchema: CATEGORISE_SCHEMA,
      schemaName: 'message_category',
    });
    return result || { category: 'General', summary: message.slice(0, 80) };
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
