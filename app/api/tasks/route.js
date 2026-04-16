import { getSupabase } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

async function attachTaskMembers(supabase, tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks || [];

  const memberIds = [...new Set(tasks.map((task) => task.assigned_to).filter(Boolean))];
  if (memberIds.length === 0) return tasks;

  const { data: members, error } = await supabase
    .from("team_members")
    .select("id, name, slack_user_id");

  if (error) throw error;

  const memberMap = new Map((members || []).map((member) => [String(member.id), member]));
  return tasks.map((task) => ({
    ...task,
    team_members: memberMap.get(String(task.assigned_to)) || null,
  }));
}

// GET /api/tasks?assigned_to=123 or GET /api/tasks (all tasks)
export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const assignedTo = searchParams.get("assigned_to");

    let query = supabase
      .from("tasks")
      .select("*")
      .order("created_at", { ascending: false });

    if (assignedTo) {
      query = query.eq("assigned_to", parseInt(assignedTo));
    }

    const { data, error } = await query;
    if (error) throw error;

    const tasks = await attachTaskMembers(supabase, data || []);
    return Response.json({ tasks });
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
      .single();

    if (error) throw error;

    const { data: member } = await supabase
      .from("team_members")
      .select("id, name, slack_user_id")
      .eq("id", parseInt(assigned_to))
      .maybeSingle();

    const taskWithMember = {
      ...task,
      team_members: member || null,
    };

    // Send Slack DM to assignee
    const slackUserId = taskWithMember.team_members?.slack_user_id;
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

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        member_id:   null,
        member_name: assigned_by || 'Admin',
        action:      'task.create',
        entity_type: 'task',
        entity_id:   task.id || null,
        details:     { title, assigned_to: parseInt(assigned_to), priority: priority || 'medium' },
        source:      'app',
      });
    } catch {}

    return Response.json({ task: taskWithMember }, { status: 201 });
  } catch (err) {
    console.error("POST /api/tasks error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
