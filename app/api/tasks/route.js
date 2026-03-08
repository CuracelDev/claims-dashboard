import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// GET /api/tasks?assigned_to=123 or GET /api/tasks (all tasks)
export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const assignedTo = searchParams.get("assigned_to");

    let query = supabase
      .from("tasks")
      .select(`
        *,
        team_members!tasks_assigned_to_fkey(id, name, slack_user_id)
      `)
      .order("created_at", { ascending: false });

    if (assignedTo) {
      query = query.eq("assigned_to", parseInt(assignedTo));
    }

    const { data, error } = await query;
    if (error) throw error;

    return Response.json({ tasks: data });
  } catch (err) {
    console.error("GET /api/tasks error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/tasks — create task + send Slack DM to assignee
export async function POST(request) {
  try {
    const supabase = getSupabase();
    const body = await request.json();
    const { title, description, assigned_to, assigned_by, due_date, priority, category } = body;

    if (!title || !assigned_to) {
      return Response.json({ error: "title and assigned_to are required" }, { status: 400 });
    }

    // Insert task
    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        title,
        description: description || null,
        assigned_to: parseInt(assigned_to),
        assigned_by: assigned_by || "Admin",
        due_date: due_date || null,
        priority: priority || "medium",
        category: category || "ad_hoc",
        status: "todo",
      })
      .select(`
        *,
        team_members!tasks_assigned_to_fkey(id, name, slack_user_id)
      `)
      .single();

    if (error) throw error;

    // Send Slack DM to assignee
    const slackUserId = task.team_members?.slack_user_id;
    if (slackUserId && process.env.SLACK_BOT_TOKEN) {
      try {
        const dueDateText = due_date
          ? ` — due *${new Date(due_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}*`
          : "";
        const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" }[priority] || "🟡";

        // Open DM channel
        const openRes = await fetch("https://slack.com/api/conversations.open", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ users: slackUserId }),
        });
        const openData = await openRes.json();

        if (openData.ok) {
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
                    text: `📋 *New task assigned to you by ${assigned_by || "Admin"}*`,
                  },
                },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: `*Task:*\n${title}` },
                    { type: "mrkdwn", text: `*Priority:*\n${priorityEmoji} ${(priority || "medium").charAt(0).toUpperCase() + (priority || "medium").slice(1)}` },
                  ],
                },
                ...(description
                  ? [{ type: "section", text: { type: "mrkdwn", text: `*Description:*\n${description}` } }]
                  : []),
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `${dueDateText ? `📅 Due date:${dueDateText}` : "No due date set"}\n\nOpen the platform to update your task status: <https://claims-dashboard.vercel.app/tasks|View Tasks>`,
                  },
                },
              ],
            }),
          });
        }
      } catch (slackErr) {
        console.error("Slack DM error (non-fatal):", slackErr);
      }
    }

    return Response.json({ task }, { status: 201 });
  } catch (err) {
    console.error("POST /api/tasks error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
