// PATH: app/api/slack-delete/route.js
// Deletes a Slack message by channel + ts
// The bot must be the one who posted it

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { channel, ts } = await request.json();

    if (!channel || !ts) {
      return Response.json({ error: 'channel and ts are required' }, { status: 400 });
    }

    const res = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, ts }),
    });

    const result = await res.json();

    if (!result.ok) {
      console.error('[slack-delete] Slack error:', result.error);
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error('[slack-delete] Error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
