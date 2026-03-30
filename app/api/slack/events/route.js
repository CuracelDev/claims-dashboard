import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

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

// ── Error parsers ─────────────────────────────────────────────

function parseImportError(text) {
  // Matches: "Failed to import JHL claim on ..."
  if (!text.includes("Failed to import")) return null;

  const invId        = text.match(/Inv ID:\s*([^\n]+)/)?.[1]?.trim() || null;
  const providerCode = text.match(/Provider Code:\s*([^\n]+)/)?.[1]?.trim() || null;
  const errorMsg     = text.match(/Error:\s*"?([^\n"]+)"?/)?.[1]?.trim() || null;
  const hmo          = text.match(/by HMO:\s*([^\n]+)/)?.[1]?.trim() || null;
  const env          = text.match(/ENV:\s*([^\n\s]+)/)?.[1]?.trim() || null;

  return {
    error_type:    'import_failure',
    hmo,
    env,
    inv_id:        invId,
    provider_code: providerCode,
    error_message: errorMsg,
    refs:          null,
  };
}

function parseRefError(text) {
  // Matches: "Failed claims refs and messages:"
  if (!text.includes("Failed claims refs") && !text.includes("Ref:")) return null;

  const refs = [];
  const refRegex = /Ref:\s*([A-Z0-9]+)\s*-\s*Error:\s*([^\n]+)/g;
  let match;
  while ((match = refRegex.exec(text)) !== null) {
    refs.push({ ref: match[1].trim(), error: match[2].trim() });
  }
  if (refs.length === 0) return null;

  // Try to extract HMO / env if present
  const hmo = text.match(/HMO:\s*([^\n]+)/)?.[1]?.trim() || null;
  const env = text.match(/ENV:\s*([^\n\s]+)/)?.[1]?.trim() || null;

  // Build a summary error message from first ref
  const errorMsg = refs[0]?.error || null;

  return {
    error_type:    'ref_failure',
    hmo,
    env,
    inv_id:        null,
    provider_code: null,
    error_message: errorMsg,
    refs,
  };
}

function parseErrorMessage(text) {
  return parseImportError(text) || parseRefError(text) || null;
}

// ── Save error to Supabase ─────────────────────────────────────
async function saveClaimError({ channel_id, channel_name, message_ts, raw_message, parsed }) {
  const supabase = getSupabase();
  const { error } = await supabase.from("claim_errors").insert({
    channel_id,
    channel_name,
    message_ts,
    raw_message,
    error_type:    parsed.error_type,
    hmo:           parsed.hmo,
    env:           parsed.env,
    inv_id:        parsed.inv_id,
    provider_code: parsed.provider_code,
    error_message: parsed.error_message,
    refs:          parsed.refs,
  });
  if (error) console.error("[claim_errors] insert error:", error.message);
}

// ── Menu shown when bot is mentioned ─────────────────────────
function buildMenuBlocks(userName) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `👋 Hey *${userName}*! I'm the Claims Intel bot. Here's what I can do:`,
      },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📋 Assign a Task", emoji: true },
          style: "primary",
          action_id: "open_task_modal",
          value: JSON.stringify({}),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📊 Today's Reports", emoji: true },
          action_id: "check_reports",
          value: "today",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "⏳ Pending Tasks", emoji: true },
          action_id: "check_pending_tasks",
          value: "pending",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🎯 Weekly Targets", emoji: true },
          action_id: "check_targets",
          value: "targets",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "💡 You can also type a command directly e.g. `@claimsbot assign task` or `@claimsbot reports today`",
        },
      ],
    },
  ];
}

function buildTaskModal(trigger_id, meta = {}, members = []) {
  return {
    trigger_id,
    view: {
      type: "modal",
      callback_id: "create_task_modal",
      private_metadata: JSON.stringify(meta),
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
            options: members.map(m => ({
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
            initial_option: { text: { type: "plain_text", text: "🟡 Medium" }, value: "medium" },
            options: [
              { text: { type: "plain_text", text: "🔴 High" },   value: "high"   },
              { text: { type: "plain_text", text: "🟡 Medium" }, value: "medium" },
              { text: { type: "plain_text", text: "🟢 Low" },    value: "low"    },
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
            initial_value: meta.assigned_by || "",
          },
        },
      ],
    },
  };
}

async function getTodayReports() {
  const supabase = getSupabase();
  const today = new Date().toISOString().split("T")[0];
  const { data: reports } = await supabase
    .from("daily_reports")
    .select("team_member_id, metrics, status")
    .eq("report_date", today);
  const { data: members } = await supabase
    .from("team_members")
    .select("id, name")
    .eq("is_active", true);
  const submitted = (reports || []).map(r => {
    const m = (members || []).find(x => x.id === r.team_member_id);
    return m?.name || "Unknown";
  });
  const pending = (members || []).filter(m => !submitted.includes(m.name)).map(m => m.name);
  return { submitted, pending, total: (members || []).length };
}

async function getPendingTasks() {
  const supabase = getSupabase();
  const { data: tasks } = await supabase
    .from("tasks")
    .select("title, priority, due_date, assigned_to, status")
    .in("status", ["todo", "in_progress"])
    .order("due_date", { ascending: true })
    .limit(5);
  if (!tasks || tasks.length === 0) return [];
  const memberIds = [...new Set(tasks.map(t => t.assigned_to).filter(Boolean))];
  const { data: members } = await supabase
    .from("team_members")
    .select("id, name")
    .in("id", memberIds);
  const memberMap = {};
  (members || []).forEach(m => { memberMap[m.id] = m.name; });
  return tasks.map(t => ({ ...t, member_name: memberMap[t.assigned_to] || "Unassigned" }));
}

async function getActiveTargets() {
  const supabase = getSupabase();
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase
    .from("weekly_targets")
    .select("*")
    .lte("start_date", today)
    .gte("end_date", today);
  return data || [];
}

// ── Main handler ──────────────────────────────────────────────
export async function POST(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await request.json();

    if (body.type === "url_verification") {
      return Response.json({ challenge: body.challenge });
    }

    if (body.type === "event_callback") {
      const event = body.event;

      // ── Passive message listener — error tracking ──────────
      if (
        event.type === "message" &&
        !event.subtype &&           // ignore edits, deletes, joins
        
        event.text
      ) {
        const parsed = parseErrorMessage(event.text);
        if (parsed) {
          // Get channel name if available
          let channel_name = null;
          try {
            const info = await slackPost("conversations.info", { channel: event.channel });
            channel_name = info.channel?.name || null;
          } catch {}

          await saveClaimError({
            channel_id:   event.channel,
            channel_name,
            message_ts:   event.ts,
            raw_message:  event.text,
            parsed,
          });
        }
        return Response.json({ ok: true });
      }

      // ── App mention handler ────────────────────────────────
      if (event.type === "app_mention") {
        const text = (event.text || "").toLowerCase().replace(/<@.*?>/g, "").trim();

        let userName = "there";
        try {
          const userInfo = await slackPost("users.info", { user: event.user });
          userName = userInfo.user?.real_name || userInfo.user?.name || "there";
        } catch (e) {}

        const meta = { channel: event.channel, thread_ts: event.ts, assigned_by: userName };

        if (text.includes("assign") || text.includes("task")) {
          const members = await getTeamMembers();
          await slackPost("chat.postMessage", {
            channel: event.channel,
            thread_ts: event.ts,
            text: "Opening task form...",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `📋 *Assign a Task* — click below to fill in the details:` } },
              { type: "actions", elements: [{
                type: "button", text: { type: "plain_text", text: "✏️ Open Task Form" },
                style: "primary", action_id: "open_task_modal",
                value: JSON.stringify(meta),
              }]},
            ],
          });
          return Response.json({ ok: true });
        }

        if (text.includes("report") || text.includes("today") || text.includes("status")) {
          const { submitted, pending, total } = await getTodayReports();
          await slackPost("chat.postMessage", {
            channel: event.channel,
            thread_ts: event.ts,
            text: "Today's report status",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `📊 *Daily Reports — Today*` } },
              { type: "section", fields: [
                { type: "mrkdwn", text: `*✅ Submitted (${submitted.length}/${total}):*\n${submitted.length ? submitted.join(", ") : "_None yet_"}` },
                { type: "mrkdwn", text: `*⏳ Pending (${pending.length}):*\n${pending.length ? pending.join(", ") : "_All done!_"}` },
              ]},
              { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View Dashboard →" }, url: "https://claims-dashboard.vercel.app/reports", action_id: "view_reports" }]},
            ],
          });
          return Response.json({ ok: true });
        }

        if (text.includes("pending") || text.includes("tasks")) {
          const tasks = await getPendingTasks();
          const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢" };
          await slackPost("chat.postMessage", {
            channel: event.channel,
            thread_ts: event.ts,
            text: "Pending tasks",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `⏳ *Pending Tasks (${tasks.length})* — showing up to 5` } },
              ...tasks.map(t => ({ type: "section", text: { type: "mrkdwn", text: `${{ high:"🔴",medium:"🟡",low:"🟢" }[t.priority]||"🟡"} *${t.title}* — ${t.member_name||"Unassigned"}${t.due_date?` · Due ${t.due_date}`:""}` } })),
              ...(tasks.length === 0 ? [{ type: "section", text: { type: "mrkdwn", text: "_No pending tasks_ 🎉" } }] : []),
              { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View Task Board →" }, url: "https://claims-dashboard.vercel.app/tasks", action_id: "view_tasks" }]},
            ],
          });
          return Response.json({ ok: true });
        }

        if (text.includes("target") || text.includes("goal")) {
          const targets = await getActiveTargets();
          await slackPost("chat.postMessage", {
            channel: event.channel,
            thread_ts: event.ts,
            text: "Weekly targets",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `🎯 *Active Weekly Targets (${targets.length})*` } },
              ...targets.map(t => ({ type: "section", text: { type: "mrkdwn", text: `• *${t.name}* — target: ${t.target_value?.toLocaleString()||"—"} · ${t.start_date} → ${t.end_date}` } })),
              ...(targets.length === 0 ? [{ type: "section", text: { type: "mrkdwn", text: "_No active targets this week_" } }] : []),
              { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View Targets →" }, url: "https://claims-dashboard.vercel.app/targets", action_id: "view_targets" }]},
            ],
          });
          return Response.json({ ok: true });
        }

        await slackPost("chat.postMessage", {
          channel: event.channel,
          thread_ts: event.ts,
          text: `👋 Hey ${userName}! Here's what I can do.`,
          blocks: buildMenuBlocks(userName),
        });

        return Response.json({ ok: true });
      }
    }
  }

  // ── Interactivity ─────────────────────────────────────────
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const payload = JSON.parse(params.get("payload") || "{}");

    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      const channel = payload.channel?.id || payload.container?.channel_id;
      const thread_ts = payload.message?.thread_ts || payload.message?.ts;

      if (action?.action_id === "open_task_modal") {
        const meta = JSON.parse(action.value || "{}");
        const metaWithThread = { ...meta, channel: meta.channel || channel, thread_ts: meta.thread_ts || thread_ts };
        const members = await getTeamMembers();
        await slackPost("views.open", buildTaskModal(payload.trigger_id, metaWithThread, members));
        return Response.json({ ok: true });
      }

      if (action?.action_id === "check_reports") {
        const { submitted, pending, total } = await getTodayReports();
        await slackPost("chat.postMessage", {
          channel, thread_ts, text: "Today's reports",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `📊 *Daily Reports — Today*` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*✅ Submitted (${submitted.length}/${total}):*\n${submitted.length ? submitted.join(", ") : "_None yet_"}` },
              { type: "mrkdwn", text: `*⏳ Pending (${pending.length}):*\n${pending.length ? pending.join(", ") : "_All done!_"}` },
            ]},
          ],
        });
        return Response.json({ ok: true });
      }

      if (action?.action_id === "check_pending_tasks") {
        const tasks = await getPendingTasks();
        await slackPost("chat.postMessage", {
          channel, thread_ts, text: "Pending tasks",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `⏳ *Pending Tasks (${tasks.length})*` } },
            ...tasks.map(t => ({ type: "section", text: { type: "mrkdwn", text: `${{ high:"🔴",medium:"🟡",low:"🟢" }[t.priority]||"🟡"} *${t.title}* — ${t.member_name||"Unassigned"}${t.due_date?` · Due ${t.due_date}`:""}` } })),
            ...(tasks.length===0?[{ type:"section", text:{type:"mrkdwn", text:"_No pending tasks_ 🎉"} }]:[]),
          ],
        });
        return Response.json({ ok: true });
      }

      if (action?.action_id === "check_targets") {
        const targets = await getActiveTargets();
        await slackPost("chat.postMessage", {
          channel, thread_ts, text: "Weekly targets",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `🎯 *Active Weekly Targets (${targets.length})*` } },
            ...targets.map(t => ({ type:"section", text:{type:"mrkdwn", text:`• *${t.name}* — ${t.target_value?.toLocaleString()||"—"}`} })),
            ...(targets.length===0?[{type:"section",text:{type:"mrkdwn",text:"_No active targets_"}}]:[]),
          ],
        });
        return Response.json({ ok: true });
      }
    }

    if (payload.type === "view_submission" && payload.view?.callback_id === "create_task_modal") {
      const values = payload.view.state.values;
      const title       = values.task_title?.title_input?.value;
      const description = values.task_description?.description_input?.value || null;
      const assigneeIds = values.task_assignees?.assignees_input?.selected_options?.map(o => parseInt(o.value)) || [];
      const priority    = values.task_priority?.priority_input?.selected_option?.value || "medium";
      const due_date    = values.task_due_date?.due_date_input?.selected_date || null;
      const assigned_by = values.task_assigned_by?.assigned_by_input?.value || "Slack";

      let meta = {};
      try { meta = JSON.parse(payload.view.private_metadata || "{}"); } catch(e) {}

      const supabase = getSupabase();
      const members  = await getTeamMembers();
      const createdTasks = [];

      for (const memberId of assigneeIds) {
        const member = members.find(m => m.id === memberId);
        if (!member) continue;
        const { data: task, error } = await supabase.from("tasks").insert({
          title, description, assigned_to: memberId, assigned_by,
          due_date, priority, status: "todo", category: "ad_hoc",
        }).select().single();
        if (error) continue;
        createdTasks.push({ task, member });
        if (member.slack_user_id) {
          const pEmoji = { high:"🔴", medium:"🟡", low:"🟢" }[priority]||"🟡";
          await slackPost("chat.postMessage", {
            channel: member.slack_user_id,
            text: `New task assigned to you by ${assigned_by}`,
            blocks: [
              { type:"section", text:{type:"mrkdwn", text:`📋 *New task from ${assigned_by}*`} },
              { type:"section", fields:[
                { type:"mrkdwn", text:`*Task:*\n${title}` },
                { type:"mrkdwn", text:`*Priority:*\n${pEmoji} ${priority}` },
                { type:"mrkdwn", text:`*Due:*\n${due_date||"No deadline"}` },
                ...(description?[{type:"mrkdwn",text:`*Notes:*\n${description}`}]:[]),
              ]},
              { type:"actions", elements:[{type:"button", text:{type:"plain_text",text:"View Task Board →"}, url:"https://claims-dashboard.vercel.app/tasks", action_id:"view_tasks"}]},
            ],
          });
        }
      }

      if (meta.channel && createdTasks.length > 0) {
        const names = createdTasks.map(c => c.member.name);
        const pEmoji = { high:"🔴", medium:"🟡", low:"🟢" }[priority]||"🟡";
        await slackPost("chat.postMessage", {
          channel: meta.channel, thread_ts: meta.thread_ts,
          text: `Task assigned to ${names.join(", ")}`,
          blocks: [
            { type:"section", text:{type:"mrkdwn", text:`✅ *Task assigned to ${names.join(", ")}*`} },
            { type:"section", fields:[
              { type:"mrkdwn", text:`*Task:*\n${title}` },
              { type:"mrkdwn", text:`*Priority:*\n${pEmoji} ${priority}` },
              { type:"mrkdwn", text:`*Assigned to:*\n${names.join(", ")}` },
              { type:"mrkdwn", text:`*Due:*\n${due_date||"No deadline"}` },
            ]},
            { type:"actions", elements:[{type:"button", text:{type:"plain_text",text:"View Dashboard →"}, url:"https://claims-dashboard.vercel.app/tasks", action_id:"view_dashboard"}]},
          ],
        });
      }

      return Response.json({ response_action: "clear" });
    }
  }

  return Response.json({ ok: true });
}
