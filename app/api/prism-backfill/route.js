// PATH: app/api/prism-backfill/route.js
// Note: Anthropic SDK kept for reference, now using Azure OpenAI
// import Anthropic from '@anthropic-ai/sdk';
import { chatCompletionJSON, MODELS } from '../../../lib/azure-openai';
import { getSupabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

const PRISM_ID = 'U0AF86M8TRS';
const CHANNEL = 'C03TBH0RL76';

const USER_NAMES = {
  'U016XUR9PAQ': 'Muyiwa',
  'U04F378PJ04': 'Sophie',
  'U073WM5UV8E': 'Emmanuel',
  'U0AF86M8TRS': 'Prism',
  'U0AGVJNJ20M': 'Claims Dashboard',
};

function stripMentions(text) {
  return (text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  if (secret !== 'DataOps2026') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const monthAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const res = await fetch(
      `https://slack.com/api/conversations.history?channel=${CHANNEL}&oldest=${monthAgo}&limit=100`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const history = await res.json();
    if (!history.ok) throw new Error(history.error);

    // Collect all messages including thread replies
    const allMessages = [];
    for (const msg of history.messages || []) {
      allMessages.push(msg);
      if (msg.reply_count > 0) {
        try {
          const threadRes = await fetch(
            `https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${msg.thread_ts || msg.ts}&limit=50`,
            { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
          );
          const thread = await threadRes.json();
          if (thread.ok) {
            for (const reply of thread.messages || []) {
              if (reply.ts !== msg.ts) allMessages.push(reply);
            }
          }
        } catch {}
      }
    }

    const supabase = getSupabase();
    const inserted = [];
    const skipped = [];

    for (const msg of allMessages) {
      // Only messages mentioning Prism
      const textHasPrism = msg.text?.includes(`<@${PRISM_ID}>`);
      const blockHasPrism = JSON.stringify(msg.blocks || []).includes(PRISM_ID);
      if (!textHasPrism && !blockHasPrism) continue;

      // Skip Prism's own messages
      if (msg.user === PRISM_ID) continue;

      const cleanMsg = stripMentions(msg.text);
      if (!cleanMsg) continue;

      // Check if already logged
      const { data: existing } = await supabase
        .from('prism_logs')
        .select('id')
        .eq('slack_ts', msg.ts)
        .maybeSingle();

      if (existing) {
        skipped.push(msg.ts);
        continue;
      }

      const sent_by = USER_NAMES[msg.user] || msg.user || 'Unknown';
      const { category, summary } = await categorise(cleanMsg);

      const { error } = await supabase.from('prism_logs').insert({
        sent_by,
        message: cleanMsg,
        category,
        summary,
        slack_ts: msg.ts,
        status: 'sent',
        created_at: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      });

      if (!error) inserted.push({ ts: msg.ts, sent_by, category, summary });
    }

    return Response.json({
      success: true,
      inserted: inserted.length,
      skipped: skipped.length,
      entries: inserted,
    });

  } catch (err) {
    console.error('[prism-backfill error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
