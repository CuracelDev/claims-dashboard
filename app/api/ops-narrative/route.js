// app/api/ops-narrative/route.js
import Anthropic from '@anthropic-ai/sdk';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const data = await request.json();
    const { submission, targets, kpis, today_vs_yesterday, week_vs_lastweek, freshness } = data;

    const pending   = submission?.pending || [];
    const submitted = submission?.submitted || 0;
    const total     = submission?.total || 0;

    const prompt = `You are the operations intelligence system for Curacel Health Ops, an African health insurance claims processing team.

Here is today's operational data:

TEAM SUBMISSIONS:
- ${submitted} of ${total} members have submitted reports today
- Pending: ${pending.length > 0 ? pending.join(', ') : 'None — all submitted'}
- Submission rate: ${kpis?.submission_rate ?? 0}%

TARGETS (${targets?.length || 0} active):
${(targets || []).map(t => `- ${t.name}: ${t.pct_complete ?? 0}% complete, pace: ${t.pace}, ${t.days_left}d left`).join('\n') || '- No active targets'}

TODAY VS YESTERDAY:
${(today_vs_yesterday || []).filter(m => m.today > 0 || m.yesterday > 0).map(m => `- ${m.label}: ${m.today?.toLocaleString()} today vs ${m.yesterday?.toLocaleString()} yesterday (${m.pct_change !== null ? (m.pct_change > 0 ? '+' : '') + m.pct_change + '%' : 'n/a'})`).join('\n') || '- No data'}

THIS WEEK VS LAST WEEK:
${(week_vs_lastweek || []).filter(m => m.this_week > 0 || m.last_week > 0).map(m => `- ${m.label}: ${m.this_week?.toLocaleString()} this week vs ${m.last_week?.toLocaleString()} last week`).join('\n') || '- No data'}

Write a concise 2-3 sentence operational intelligence summary for the team lead. Be direct and specific. Lead with the most urgent issue if any. Mention specific numbers. End with one clear recommended action. Do not use bullet points. Do not use markdown. Write in plain sentences only.`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    return Response.json({ insight: message.content[0].text });
  } catch (err) {
    console.error('[ops-narrative]', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
