import { getSupabase } from "../../../lib/supabase";
import { getSettings } from "../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET && secret !== "DataOps2026") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabase();

    const now = new Date();
    const lagosOffset = 60;
    const lagosNow = new Date(now.getTime() + lagosOffset * 60000);
    const yesterday = new Date(lagosNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().slice(0, 10);
    const fromISO = `${yDate}T00:00:00+01:00`;
    const toISO   = `${yDate}T23:59:59+01:00`;

    const { data: flags, error } = await supabase
      .from("qa_flags")
      .select("*")
      .gte("flagged_at", fromISO)
      .lte("flagged_at", toISO);

    if (error) throw error;

    const total = flags.length;
    const byInsurer = {};
    const byIssue = {};
    const byProvider = {};

    for (const f of flags) {
      if (f.insurer_name) byInsurer[f.insurer_name] = (byInsurer[f.insurer_name] || 0) + 1;
      if (f.provider_name) byProvider[f.provider_name] = (byProvider[f.provider_name] || 0) + 1;

      const issues = (f.issues || "").split(";").map(i => i.trim()).filter(Boolean);
      for (const issue of issues) {
        const key = categoriseIssue(issue);
        byIssue[key] = (byIssue[key] || 0) + 1;
      }
    }

    const dateLabel = new Date(yDate + "T12:00:00Z").toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });

    let message;

    if (total === 0) {
      message = [
        `✅ *QA Daily Summary — ${dateLabel}*`,
        ``,
        `No flags raised yesterday. All claims passed QA checks. 🎉`,
        ``,
        `_Sent automatically at 6AM · <https://claims-dashboard.vercel.app/qa|View QA Dashboard>_`
      ].join("\n");
    } else {
      const insurerLines = Object.entries(byInsurer)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `  • ${name}: *${count}* flag${count !== 1 ? "s" : ""}`);

      const issueLines = Object.entries(byIssue)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `  • ${type}: *${count}*`);

      const topProviders = Object.entries(byProvider)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `  • ${name}: *${count}*`);

      message = [
        `🚨 *QA Daily Summary — ${dateLabel}*`,
        ``,
        `*${total} flag${total !== 1 ? "s" : ""}* raised across yesterday's claims`,
        ``,
        `*By Insurer:*`,
        ...insurerLines,
        ``,
        `*By Issue Type:*`,
        ...issueLines,
        ...(topProviders.length > 0 ? [
          ``,
          `*Top Flagged Providers:*`,
          ...topProviders,
        ] : []),
        ``,
        `_<https://claims-dashboard.vercel.app/qa|View full QA Dashboard →>_`,
        `_Sent automatically at 6AM Lagos time_`
      ].join("\n");
    }

    const settings = await getSettings();
    const qaChannel = settings['slack_channel_qa_insight'] ?? 'C0ALCPCE9FZ';
    const featureSlack = settings['feature_slack_sends'] ?? 'true';

    if (featureSlack === 'false') {
      return Response.json({ success: true, date: yDate, total_flags: total, slack_ok: false, slack_error: 'slack_disabled_by_settings' });
    }

    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: qaChannel,
        text: message,
        unfurl_links: false,
      }),
    });

    const slackData = await slackRes.json();

    return Response.json({
      success: true,
      date: yDate,
      total_flags: total,
      slack_ok: slackData.ok,
      slack_channel: qaChannel,
      slack_error: slackData.error || null,
    });

  } catch (err) {
    console.error("QA cron error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

function categoriseIssue(issue) {
  const s = issue.toLowerCase();
  if (s.includes("missing vetting"))     return "Missing Vetting Comment";
  if (s.includes("approved >"))          return "Approved > Submitted";
  if (s.includes("unit price mismatch")) return "Unit Price Mismatch";
  if (s.includes("submitted calc"))      return "Calculation Error";
  if (s.includes("approved unit price")) return "Approved Price Mismatch";
  if (s.includes("high quantity"))       return "High Quantity Outlier";
  return "Other";
}
