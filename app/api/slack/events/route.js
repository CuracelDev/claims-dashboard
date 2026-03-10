import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ── Slack API helpers ─────────────────────────────────────────────────────
async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getTeamMembers() {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("team_members")
    .select("id, name, slack_user_id")
    .order("name");
  return data || [];
}

// ── Block Kit builders ────────────────────────────────────────────────────
function buildTaskModal(trigger_id, prefill = {}) {
  return {
    trigger_id,
    view: {
      type: "modal",
      callback_id: "create_task_modal",
      title: { type: "plain_text", text: "Assign a Task" },
      submit: { type: "plain_text", text: "Create Task" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "task_title",
          label: { type: "plain_text", text: "Task Title" },
          element: {
            type: "plain_text_input",
            action_id: "title_input",
            placeholder: { type: "plain_text", text: "What needs to be done?" },
            initial_value: prefill.title || "",
          },
        },
        {
          type: "input",
          block_id: "task_description",
          optional: true,
          label: { type: "plain_text", text: "Description" },
          element: {
            type: "plain_text_input",
            action_id: "description_input",
            multiline: true,
            placeholder: { type: "plain_text", text: "Any extra context..." },
          },
        },
        {
          type: "input",
          block_id: "task_assignees",
          label: { type: "plain_text", text: "Assign To" },
          element: {
            type: "multi_static_select",
            action_id: "assignees_input",
            placeholder: { type: "plain_text", text: "Select team members" },
            options: (prefill.members || []).map(m => ({
              text: { type: "plain_text", text: m.name },
              value: String(m.id),
            })),
          },
        },
        {
          type: "input",
          block_id: "task_priority",
          label: { type: "plain_text", text: "Priority" },
          element: {
            type: "static_select",
            action_id: "priority_input",
            initial_option: {
              text: { type: "plain_text", text: "🟡 Medium" },
              value: "medium",
            },
            options: [
              { text: { type: "plain_text", text: "🔴 High" },   value: "high" },
              { text: { type: "plain_text", text: "🟡 Medium" }, value: "medium" },
              { text: { type: "plain_text", text: "🟢 Low" },    value: "low" },
            ],
          },
        },
        {
          type: "input",
          block_id: "task_due_date",
          optional: true,
          label: { type: "plain_text", text: "Due Date" },
          element: {
            type: "datepicker",
            action_id: "due_date_input",
            placeholder: { type: "plain_text", text: "Pick a date" },
          },
        },
        {
          type: "input",
          block_id: "task_assigned_by",
          label: { type: "plain_text", text: "Assigned By" },
          element: {
            type: "plain_text_input",
            action_id: "assigned_by_input",
            placeholder: { type: "plain_text", text: "Your name" },
            initial_value: prefill.assigned_by || "",
          },
        },
      ],
    },
  };
}

function buildTaskConfirmMessage(task, assigneeNames) {
  const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" }[task.priority] || "🟡";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *Task assigned successfully!*`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Task:*\n${task.title}` },
        { type: "mrkdwn", text: `*Priority:*\n${priorityEmoji} ${task.priority}` },
        { type: "mrkdwn", text: `*Assigned to:*\n${assigneeNames.join(", ")}` },
        { type: "mrkdwn", text: `*Due:*\n${task.due_date || "No deadline"}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View on Dashboard →" },
          url: "https://claims-dashboard.vercel.app/tasks",
          action_id: "view_dashboard",
        },
      ],
    },
  ];
}

// ── Main handler ──────────────────────────────────────────────────────────
export async function POST(request) {
  const contentType = request.headers.get("content-type") || "";

  // ── Handle URL verification challenge ──────────────────────────────────
  if (contentType.includes("application/json")) {
    const body = await request.json();

    // Slack URL verification
    if (body.type === "url_verification") {
      return Response.json({ challenge: body.challenge });
    }

    // ── Handle Events ───────────────────────────────────────────────────
    if (body.type === "event_callback") {
      const event = body.event;

      // Bot mentioned in a channel
      if (event.type === "app_mention") {
        const text = (event.text || "").toLowerCase();
        const trigger_id = body.trigger_id;

        // Respond immediately to avoid Slack timeout
        // Then open modal or send quick reply
        const members = await getTeamMembers();

        // Extract who tagged the bot to pre-fill assigned_by
        let assigned_by = "";
        try {
          const userInfo = await slackPost("users.info", { user: event.user });
          assigned_by = userInfo.user?.real_name || userInfo.user?.name || "";
        } catch (e) {}

        // Post interactive message in channel
        await slackPost("chat.postMessage", {
          channel: event.channel,
          thread_ts: event.ts,
          text: "👋 Ready to assign a task! Click below to fill in the details.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `👋 *Hey <@${event.user}>!* Ready to assign a task?`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "✏️ Create Task" },
                  style: "primary",
                  action_id: "open_task_modal",
                  value: JSON.stringify({
                    channel: event.channel,
                    thread_ts: event.ts,
                    assigned_by,
                  }),
                },
              ],
            },
          ],
        });

        return Response.json({ ok: true });
      }
    }
  }

  // ── Handle Interactivity (button clicks, modal submissions) ───────────
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const payload = JSON.parse(params.get("payload") || "{}");

    // Button click — open modal
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];

      if (action?.action_id === "open_task_modal") {
        const meta = JSON.parse(action.value || "{}");
        const members = await getTeamMembers();

        await slackPost("views.open", buildTaskModal(payload.trigger_id, {
          members,
          assigned_by: meta.assigned_by || "",
          _meta: meta,
        }));

        // Store channel/thread in private_metadata for modal submit
        await slackPost("views.update", {
          view_id: payload.view?.id,
        }).catch(() => {});

        return Response.json({ ok: true });
      }
    }

    // Modal submitted
    if (payload.type === "view_submission" && payload.view?.callback_id === "create_task_modal") {
      const values = payload.view.state.values;

      const title        = values.task_title?.title_input?.value;
      const description  = values.task_description?.description_input?.value || null;
      const assigneeIds  = values.task_assignees?.assignees_input?.selected_options?.map(o => parseInt(o.value)) || [];
      const priority     = values.task_priority?.priority_input?.selected_option?.value || "medium";
      const due_date     = values.task_due_date?.due_date_input?.selected_date || null;
      const assigned_by  = values.task_assigned_by?.assigned_by_input?.value || "Slack";

      // Get private metadata (channel + thread)
      let meta = {};
      try { meta = JSON.parse(payload.view.private_metadata || "{}"); } catch (e) {}

      const supabase = getSupabase();
      const members = await getTeamMembers();

      // Create one task per assignee
      const createdTasks = [];
      for (const memberId of assigneeIds) {
        const member = members.find(m => m.id === memberId);
        if (!member) continue;

        const { data: task, error } = await supabase
          .from("tasks")
          .insert({
            title,
            description,
            assigned_to: memberId,
            assigned_by,
            due_date,
            priority,
            status: "todo",
            category: "ad_hoc",
          })
          .select()
          .single();

        if (error) continue;
        createdTasks.push({ task, member });

        // DM the assignee
        if (member.slack_user_id) {
          const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" }[priority] || "🟡";
          await slackPost("chat.postMessage", {
            channel: member.slack_user_id,
            text: `You've been assigned a new task!`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `📋 *New task assigned to you by ${assigned_by}*`,
                },
              },
              {
                type: "section",
                fields: [
                  { type: "mrkdwn", text: `*Task:*\n${title}` },
                  { type: "mrkdwn", text: `*Priority:*\n${priorityEmoji} ${priority}` },
                  { type: "mrkdwn", text: `*Due:*\n${due_date || "No deadline"}` },
                  ...(description ? [{ type: "mrkdwn", text: `*Notes:*\n${description}` }] : []),
                ],
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "View Task Board →" },
                    url: "https://claims-dashboard.vercel.app/tasks",
                    action_id: "view_tasks",
                  },
                ],
              },
            ],
          });
        }
      }

      // Post confirmation back to original channel/thread
      if (meta.channel && createdTasks.length > 0) {
        const assigneeNames = createdTasks.map(c => c.member.name);
        await slackPost("chat.postMessage", {
          channel: meta.channel,
          thread_ts: meta.thread_ts,
          text: `Task assigned to ${assigneeNames.join(", ")}`,
          blocks: buildTaskConfirmMessage(
            { title, priority, due_date },
            assigneeNames
          ),
        });
      }

      return Response.json({ response_action: "clear" });
    }
  }

  return Response.json({ ok: true });
}
