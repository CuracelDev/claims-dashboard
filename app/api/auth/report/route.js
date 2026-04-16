import { getSupabase } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

async function slackDM(userId, text) {
  // Open DM channel
  const openRes = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: userId }),
  });
  const openData = await openRes.json();
  if (!openData.ok) throw new Error(`Slack open DM failed: ${openData.error}`);

  const channelId = openData.channel.id;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, member_id, pin } = body;
    const supabase = getSupabase();

    // ── SEND PIN ────────────────────────────────────────────────────────
    if (action === "send") {
      if (!member_id) return Response.json({ error: "member_id required" }, { status: 400 });

      // Get member
      const { data: member, error: mErr } = await supabase
        .from("team_members")
        .select("id, name, slack_user_id, report_pin")
        .eq("id", member_id)
        .single();

      if (mErr || !member) return Response.json({ error: "Member not found" }, { status: 404 });
      if (!member.slack_user_id) return Response.json({ error: "No Slack account linked for this member" }, { status: 400 });

      // Generate 6-digit PIN
      const newPin = String(Math.floor(100000 + Math.random() * 900000));

      // Save PIN to team_members
      const { error: updateErr } = await supabase
        .from("team_members")
        .update({ report_pin: newPin })
        .eq("id", member.id);

      if (updateErr) throw updateErr;

      // Send via Slack DM
      await slackDM(
        member.slack_user_id,
        `🔐 *Your Claims Intel PIN*\n\nHey ${member.name}! Your PIN for submitting daily reports is:\n\n*${newPin}*\n\nUse this to log in at claims-dashboard.vercel.app/reports\nYou can request a new PIN anytime from the login screen.`
      );

      return Response.json({ success: true, message: "PIN sent to your Slack DM" });
    }

    // ── VERIFY PIN ──────────────────────────────────────────────────────
    if (action === "verify") {
      if (!member_id || !pin) return Response.json({ error: "member_id and pin required" }, { status: 400 });

      const { data: member, error: mErr } = await supabase
        .from("team_members")
        .select("id, name, report_pin")
        .eq("id", member_id)
        .single();

      if (mErr || !member) return Response.json({ error: "Member not found" }, { status: 404 });
      if (!member.report_pin) return Response.json({ error: "No PIN set — request one via Slack" }, { status: 400 });

      if (String(pin).trim() !== String(member.report_pin).trim()) {
        return Response.json({ error: "Incorrect PIN. Try again or request a new one." }, { status: 401 });
      }

      return Response.json({ success: true, member_id: member.id, name: member.name });
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });

  } catch (err) {
    console.error("Auth error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
