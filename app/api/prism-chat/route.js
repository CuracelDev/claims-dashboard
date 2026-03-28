// PATH: app/api/prism-chat/route.js
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { message, member_name } = await request.json();
    if (!message) return Response.json({ error: 'No message provided' }, { status: 400 });

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

    const data = await res.json();
    if (!data.ok) return Response.json({ success: false, error: data.error }, { status: 500 });
    return Response.json({ success: true, ts: data.ts });

  } catch (err) {
    console.error('[prism-chat error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
