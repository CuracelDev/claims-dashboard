export async function POST(request) {
  try {
    const body = await request.json();
    const { report, teamMember, webhookUrl, channel } = body;

    if (!report || !teamMember) {
      return Response.json({ error: 'report and teamMember are required' }, { status: 400 });
    }

    // Format the Slack message as a clean Block Kit message
    const date = new Date(report.report_date).toLocaleDateString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const metrics = report.metrics || {};

    // Group metrics for display
    const mappingMetrics = ['providers_mapped', 'care_items_mapped', 'care_items_grouped', 'resolved_cares'];
    const claimsMetrics = ['claims_kenya', 'claims_tanzania', 'claims_uganda', 'claims_uap', 'claims_defmis', 'claims_hadiel', 'claims_axa'];
    const qualityMetrics = ['auto_pa_reviewed', 'auto_pa_approved', 'flagged_care_items', 'icd10_adjusted', 'benefits_set_up', 'providers_assigned'];

    const formatMetricRow = (key, label) => {
      const val = metrics[key];
      if (val === undefined || val === null || val === '') return null;
      return `• *${label}:* ${val}`;
    };

    const METRIC_LABELS = {
      providers_mapped: 'Providers Mapped',
      care_items_mapped: 'Care Items Mapped',
      care_items_grouped: 'Care Items Grouped',
      resolved_cares: 'Resolved Cares',
      claims_kenya: 'Kenya Claims',
      claims_tanzania: 'Tanzania Claims',
      claims_uganda: 'Uganda Claims',
      claims_uap: 'UAP Old Mutual',
      claims_defmis: 'Defmis',
      claims_hadiel: 'Hadiel Tech',
      claims_axa: 'AXA',
      auto_pa_reviewed: 'Auto PA Reviewed',
      auto_pa_approved: 'Auto PA Approved',
      flagged_care_items: 'Flagged Care Items',
      icd10_adjusted: 'ICD10 Adjusted (Jubilee)',
      benefits_set_up: 'Benefits Set Up',
      providers_assigned: 'Providers Assigned',
    };

    const mappingRows = mappingMetrics.map(k => formatMetricRow(k, METRIC_LABELS[k])).filter(Boolean);
    const claimsRows = claimsMetrics.map(k => formatMetricRow(k, METRIC_LABELS[k])).filter(Boolean);
    const qualityRows = qualityMetrics.map(k => formatMetricRow(k, METRIC_LABELS[k])).filter(Boolean);

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📋 Daily Report — ${teamMember.name}`, emoji: true }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*${date}* | ${teamMember.role}` }]
      },
      { type: 'divider' }
    ];

    if (mappingRows.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*📦 Mapping & Data*\n${mappingRows.join('\n')}` }
      });
    }

    if (claimsRows.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*📊 Claims Piles Checked*\n${claimsRows.join('\n')}` }
      });
    }

    if (qualityRows.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*✅ Quality & Review*\n${qualityRows.join('\n')}` }
      });
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
        text: { type: 'mrkdwn', text: `*💬 Notes*\n${report.notes}` }
      });
    }

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Submitted via Curacel Health Ops Platform` }]
    });

    // Send to Slack
    const slackWebhook = webhookUrl || process.env.SLACK_WEBHOOK_HEALTHOPS;
    if (!slackWebhook) {
      return Response.json({ error: 'No Slack webhook configured' }, { status: 400 });
    }

    const slackRes = await fetch(slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks, text: `Daily Report from ${teamMember.name}` }),
    });

    if (!slackRes.ok) {
      const errText = await slackRes.text();
      throw new Error(`Slack API error: ${errText}`);
    }

    return Response.json({
      success: true,
      channel: channel || 'health-ops',
      sent_at: new Date().toISOString(),
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
