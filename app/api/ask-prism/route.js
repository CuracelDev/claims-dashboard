// PATH: app/api/ask-prism/route.js
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { total, date_range, aggregations } = await request.json();

    const dateStr = date_range?.from === date_range?.to
      ? date_range?.from
      : `${date_range?.from} to ${date_range?.to}`;

    const topIssue = (aggregations?.by_issue || []).sort((a, b) => b.count - a.count)[0];
    const topInsurer = (aggregations?.by_insurer || []).sort((a, b) => b.count - a.count)[0];
    const topProvider = (aggregations?.top_providers || []).sort((a, b) => b.count - a.count)[0];

    const message = [
      `<@U0AF86M8TRS> I need a QA analysis for the Claims Intel dashboard.`,
      ``,
      `*Date:* ${dateStr}`,
      `*Total Flags:* ${total}`,
      topIssue ? `*Top Issue:* ${topIssue.issue} (${topIssue.count})` : null,
      topInsurer ? `*Top Insurer:* ${topInsurer.insurer} (${topInsurer.count} flags)` : null,
      topProvider ? `*Top Provider:* ${topProvider.provider_name || topProvider.name} (${topProvider.count} flags)` : null,
      ``,
      `Please give me: highlights, patterns, anomalies, and your top 2 recommendations.`,
      `<https://claims-dashboard.vercel.app/qa|View QA Dashboard →>`
    ].filter(Boolean).join('\n');

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: 'C0ALCPCE9FZ',
        text: message,
        unfurl_links: false,
      }),
    });

    const data = await res.json();
    if (!data.ok) return Response.json({ success: false, error: data.error }, { status: 500 });
    return Response.json({ success: true, ts: data.ts });

  } catch (err) {
    console.error('[ask-prism error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
