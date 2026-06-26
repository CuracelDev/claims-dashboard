import { getSupabase } from '../../../../lib/supabase';
import {
  DEFAULT_REPORT_METRIC_GROUPS,
  formatDailyReportDate,
  groupReportMetricDefinitions,
} from '../../../../lib/report-metrics';

export const dynamic = 'force-dynamic';

const CATEGORY_ICONS = {
  claims_piles: '📊',
  mapping_data: '📦',
  quality_review: '✅',
};

async function getMetricGroups() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('metric_definitions')
      .select('key, metric_key, label, category, display_order, active, is_active')
      .order('category')
      .order('display_order');
    if (error) throw error;
    const groups = groupReportMetricDefinitions(data || []);
    return groups.length ? groups : DEFAULT_REPORT_METRIC_GROUPS;
  } catch {
    return DEFAULT_REPORT_METRIC_GROUPS;
  }
}

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
    const metricGroups = await getMetricGroups();
    const total = Object.values(metrics).reduce((a, b) => a + (parseInt(b) || 0), 0);
    const date = formatDailyReportDate(report.report_date, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }, 'Unknown date');

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
    for (const group of metricGroups) {
      const rows = group.metrics
        .map((metric) => metric.key)
        .filter(k => parseInt(metrics[k]) > 0)
        .map(k => {
          const metric = group.metrics.find((item) => item.key === k);
          return `• *${metric?.label || k}:* ${metrics[k]}`;
        });
      if (rows.length > 0) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*${CATEGORY_ICONS[group.category] || '•'} ${group.label}*\n${rows.join('\n')}` }
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
