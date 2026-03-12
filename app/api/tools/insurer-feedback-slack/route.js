import { NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { insight, total, open, fixed, insurer } = await req.json();
    const webhookUrl = process.env.SLACK_WEBHOOK_HEALTHOPS;
    if (!webhookUrl) return NextResponse.json({ error: 'No Slack webhook configured.' }, { status: 400 });

    const resolutionRate = total ? Math.round(fixed/total*100) : 0;
    const payload = {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔍 Insurer Feedback Intelligence Report' } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Insurer:*\n' + (insurer || 'JBL Uganda') },
          { type: 'mrkdwn', text: '*Total Items:*\n' + total },
          { type: 'mrkdwn', text: '*Open Issues:*\n' + open },
          { type: 'mrkdwn', text: '*Resolution Rate:*\n' + resolutionRate + '%' },
        ]},
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*AI Analysis:*\n' + insight.slice(0, 2800) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Generated from Claims Intel · Insurer Feedback Intelligence' }] },
      ]
    };

    const res = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error('Slack webhook failed');
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
