// PATH: app/api/prism-history/route.js
export const dynamic = 'force-dynamic';

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = 'C0ALCPCE9FZ';
const PRISM_ID = 'U0AF86M8TRS';
const CLAIMS_BOT_ID = 'U0AGVJNJ20M';

async function slackGet(method, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  });
  return res.json();
}

function stripMentions(text) {
  return (text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}

export async function GET() {
  try {
    // Get this week's messages
    const weekAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const history = await slackGet('conversations.history', {
      channel: CHANNEL,
      oldest: weekAgo,
      limit: 50,
    });

    if (!history.ok) {
      return Response.json({ error: history.error }, { status: 500 });
    }

    const messages = history.messages || [];
    const results = [];

    for (const msg of messages) {
      // Only process messages sent by Claims Dashboard bot to Prism
      if (msg.user !== CLAIMS_BOT_ID && msg.bot_id !== 'B0AH2KJ3KBN') continue;
      if (!msg.text?.includes(`<@${PRISM_ID}>`)) continue;

      const entry = {
        ts: msg.ts,
        sent_at: new Date(parseFloat(msg.ts) * 1000).toISOString(),
        message: stripMentions(msg.text),
        prism_reply: null,
        reply_at: null,
      };

      // Fetch thread replies
      if (msg.thread_ts || msg.reply_count > 0) {
        const thread = await slackGet('conversations.replies', {
          channel: CHANNEL,
          ts: msg.thread_ts || msg.ts,
        });

        if (thread.ok) {
          const prismReply = (thread.messages || []).find(
            m => m.user === PRISM_ID && m.ts !== msg.ts
          );
          if (prismReply) {
            entry.prism_reply = prismReply.text;
            entry.reply_at = new Date(parseFloat(prismReply.ts) * 1000).toISOString();
          }
        }
      }

      results.push(entry);
    }

    return Response.json({ success: true, data: results.reverse() });

  } catch (err) {
    console.error('[prism-history error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
