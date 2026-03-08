import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// PATCH /api/tasks/[id] — update status (todo → in_progress → done)
export async function PATCH(request, { params }) {
  try {
    const supabase = getSupabase();
    const { id } = params;
    const body = await request.json();
    const { status, completed_by_name } = body;

    const validStatuses = ["todo", "in_progress", "done"];
    if (!validStatuses.includes(status)) {
      return Response.json({ error: "Invalid status" }, { status: 400 });
    }

    const updatePayload = { status };
    if (status === "done") {
      updatePayload.completed_at = new Date().toISOString();
    } else {
      updatePayload.completed_at = null;
    }

    const { data: task, error } = await supabase
      .from("tasks")
      .update(updatePayload)
      .eq("id", id)
      .select(`
        *,
        team_members!tasks_assigned_to_fkey(id, name, slack_user_id)
      `)
      .single();

    if (error) throw error;

    // If marked done: notify assigner via Slack DM
    if (status === "done" && task.assigned_by && process.env.SLACK_BOT_TOKEN) {
      try {
        // Look up assigner's slack_user_id by name
        const { data: assigner } = await supabase
          .from("team_members")
          .select("slack_user_id, name")
          .ilike("name", task.assigned_by)
          .single();

        if (assigner?.slack_user_id) {
          const openRes = await fetch("https://slack.com/api/conversations.open", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ users: assigner.slack_user_id }),
          });
          const openData = await openRes.json();

          if (openData.ok) {
            const completedBy = completed_by_name || task.team_members?.name || "A team member";
            await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                channel: openData.channel.id,
                blocks: [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `✅ *Task completed!*\n*${completedBy}* just completed: *${task.title}*`,
                    },
                  },
                  {
                    type: "context",
                    elements: [
                      {
                        type: "mrkdwn",
                        text: `Completed at ${new Date().toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} Lagos time`,
                      },
                    ],
                  },
                ],
              }),
            });
          }
        }
      } catch (slackErr) {
        console.error("Slack completion DM error (non-fatal):", slackErr);
      }
    }

    return Response.json({ task });
  } catch (err) {
    console.error("PATCH /api/tasks/[id] error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]
export async function DELETE(request, { params }) {
  try {
    const supabase = getSupabase();
    const { id } = params;

    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) throw error;

    return Response.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/tasks/[id] error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
