// PATH: app/api/prism-backfill/route.js
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const PRISM_ID = 'U0AF86M8TRS';
const CHANNEL = 'C0ALCPCE9FZ';
const CLAIMS_BOT_ID = 'U0AGVJNJ20M';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function stripMentions(text) {
  return (text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
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

No markdown, no preamble, just JSON.`,
      }],
    });
    return JSON.parse(res.content[0]?.text || '{}');
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
    const weekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const res = await fetch(
      `https://slack.com/api/conversations.history?channel=${CHANNEL}&oldest=${weekAgo}&limit=50`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const history = await res.json();
    if (!history.ok) throw new Error(history.error);

    const supabase = getSupabase();
    const inserted = [];
    const skipped = [];

    for (const msg of history.messages || []) {
      // Only messages from Claims Dashboard bot mentioning Prism
      if (msg.user !== CLAIMS_BOT_ID && msg.bot_id !== 'B0AH2KJ3KBN') continue;
      // Check text field OR blocks for Prism mention
      const textHasPrism = msg.text?.includes(`<@${PRISM_ID}>`);
      const blockHasPrism = JSON.stringify(msg.blocks || []).includes(PRISM_ID);
      if (!textHasPrism && !blockHasPrism) continue;

      // Pull message from block text if available, else fall back to msg.text
      let rawText = msg.text || '';
      const sectionBlock = (msg.blocks || []).find(b => b.type === 'section');
      if (sectionBlock?.text?.text) rawText = sectionBlock.text.text;
      const cleanMsg = stripMentions(rawText);
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

      // Get sender name from blocks context
      let sent_by = 'Claims Dashboard';
      const context = msg.blocks?.find(b => b.type === 'context');
      if (context) {
        const match = context.elements?.[0]?.text?.match(/by \*([^*]+)\*/);
        if (match) sent_by = match[1];
      }

      // Categorise
      const { category, summary } = await categorise(cleanMsg);

      // Insert
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
