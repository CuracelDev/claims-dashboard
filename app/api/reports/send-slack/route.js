export const dynamic = 'force-dynamic';

const METRIC_LABELS = {
  claims_kenya: 'Kenya', claims_tanzania: 'Tanzania', claims_uganda: 'Uganda',
  claims_uap: 'UAP Old Mutual', claims_defmis: 'Defmis',
  claims_hadiel: 'Hadiel Tech', claims_axa: 'AXA',
  providers_mapped: 'Providers Mapped', care_items_mapped: 'Care Items Mapped',
  care_items_grouped: 'Care Items Grouped', resolved_cares: 'Resolved Cares',
  auto_pa_reviewed: 'Auto PA Reviewed/Approved', flagged_care_items: 'Flagged Care Items',
  icd10_adjusted: 'ICD10 Adjusted (Jubilee)', benefits_set_up: 'Benefits Set Up',
  providers_assigned: 'Providers Assigned',
};

const METRIC_GROUPS = [
  { label: '📊 Claims Piles Checked', keys: ['claims_kenya','claims_tanzania','claims_uganda','claims_uap','claims_defmis','claims_hadiel','claims_axa'] },
  { label: '📦 Mapping & Data', keys: ['providers_mapped','care_items_mapped','care_items_grouped','resolved_cares'] },
  { label: '✅ Quality & Review', keys: ['auto_pa_reviewed','flagged_care_items','icd10_adjusted','benefits_set_up','providers_assigned'] },
];

export async function POST(request) {
  try {
    const body = await request.json();
    const { report, teamMember } = body;

    if (!report || !teamMember) {
      return Response.json({ error: 'report and teamMember are required' }, { status: 400 });
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      return Response.json({ error: 'SLACK_BOT_TOKEN not configured' }, { status: 400 });
    }

    const slackUserId = teamMember.slack_user_id;
    if (!slackUserId) {
      return Response.json({ error: `No Slack ID set for ${teamMember.name}. Add it in Team Management.` }, { status: 400 });
    }

    const metrics = report.metrics || {};
    const total = Object.values(metrics).reduce((a, b) => a + (parseInt(b) || 0), 0);
    const date = new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📋 Your Daily Report — ${date}`, emoji: true }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total Output*\n${total}` },
          { type: 'mrkdwn', text: `*Status*\n✅ Submitted` },
        ]
      },
      { type: 'divider' },
    ];

    // Add each group that has values
    for (const group of METRIC_GROUPS) {
      const rows = group.keys
        .filter(k => parseInt(metrics[k]) > 0)
        .map(k => `• *${METRIC_LABELS[k]}:* ${metrics[k]}`);
      if (rows.length > 0) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*${group.label}*\n${rows.join('\n')}` }
        });
      }
    }

    if (report.tasks_completed) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*🗒 Tasks Completed*\n${report.tasks_completed}` }
      });
    }

    if (report.notes) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*💬 Notes / Blockers*\n${report.notes}` }
      });
    }

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Submitted via Curacel Health Ops Platform` }]
    });

    // Send DM via Bot Token
    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: slackUserId, // DM when channel = user ID
        blocks,
        text: `Your daily report for ${date} has been submitted. Total output: ${total}`,
      }),
    });

    const result = await slackRes.json();
    if (!result.ok) {
      throw new Error(`Slack error: ${result.error}`);
    }

    return Response.json({ success: true, sent_to: slackUserId, sent_at: new Date().toISOString() });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
