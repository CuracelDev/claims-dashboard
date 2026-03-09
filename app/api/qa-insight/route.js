export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const { aggregations, total, date_range, send_to_slack = false } = body;

    if (!aggregations) {
      return Response.json({ error: "No aggregation data provided" }, { status: 400 });
    }

    // Build context for Claude
    const { by_issue = [], by_insurer = [], top_providers = [], daily_trend = [] } = aggregations;

    const fromDate = date_range?.from ? new Date(date_range.from).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "N/A";
    const toDate   = date_range?.to   ? new Date(date_range.to).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "N/A";

    // Trend direction
    const trendDays = daily_trend.slice(-7);
    const firstHalf = trendDays.slice(0, Math.floor(trendDays.length / 2)).reduce((s, d) => s + d.total, 0);
    const secondHalf = trendDays.slice(Math.floor(trendDays.length / 2)).reduce((s, d) => s + d.total, 0);
    const trendDirection = secondHalf > firstHalf ? "increasing" : secondHalf < firstHalf ? "decreasing" : "stable";

    const prompt = `You are a senior claims quality analyst for Curacel, an AI-powered insurance infrastructure company operating across Africa and the Middle East.

Analyse this QA flag data and write a concise, professional insight summary (3–4 sentences max). Be direct, specific, and actionable. Mention numbers. Flag any concerning patterns. Suggest one clear action if warranted. Do not use bullet points — write in flowing prose only.

Period: ${fromDate} to ${toDate}
Total flags: ${total}
Trend: ${trendDirection} over the last ${trendDays.length} days

Issue breakdown:
${by_issue.map(i => `- ${i.issue}: ${i.count} flags`).join("\n") || "No issues"}

By insurer:
${by_insurer.map(i => `- ${i.insurer}: ${i.count} flags`).join("\n") || "No insurer data"}

Top flagged providers:
${top_providers.slice(0, 5).map(p => `- ${p.name}: ${p.count} flags`).join("\n") || "No provider data"}

Write the insight now:`;

    // Call Anthropic API
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) throw new Error(aiData.error?.message || "AI generation failed");

    const insight = aiData.content?.[0]?.text?.trim();
    if (!insight) throw new Error("Empty response from AI");

    // Optionally send to Slack
    let slackOk = null;
    if (send_to_slack) {
      const slackMessage = [
        `🧠 *QA AI Insight — ${fromDate} to ${toDate}*`,
        ``,
        insight,
        ``,
        `*${total} total flags* · ${by_issue[0]?.issue || "—"} most common · ${by_insurer[0]?.insurer || "—"} most affected`,
        ``,
        `_<https://claims-dashboard.vercel.app/qa|View QA Dashboard →>_`,
      ].join("\n");

      const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: process.env.SLACK_HEALTH_OPS_CHANNEL_ID || "#health-ops",
          text: slackMessage,
          unfurl_links: false,
        }),
      });
      const slackData = await slackRes.json();
      slackOk = slackData.ok;
    }

    return Response.json({
      insight,
      sent_to_slack: send_to_slack ? slackOk : null,
      period: { from: fromDate, to: toDate },
      total,
    });

  } catch (err) {
    console.error("POST /api/qa-insight error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
