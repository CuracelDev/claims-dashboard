// app/api/tasks/[id]/route.js
import { getSupabase } from '../../../../lib/supabase';
export const dynamic = 'force-dynamic';

async function attachTaskMember(supabase, task) {
  if (!task?.assigned_to) return task;

  const { data: member, error } = await supabase
    .from('team_members')
    .select('id, name, slack_user_id')
    .eq('id', task.assigned_to)
    .maybeSingle();

  if (error) throw error;

  return {
    ...task,
    team_members: member || null,
  };
}

// PATCH /api/tasks/[id] — update status
export async function PATCH(request, context) {
  try {
    const supabase = getSupabase();
    const { id } = await context.params;
    const body = await request.json();
    const { status, completed_by_name } = body;

    const validStatuses = ['todo', 'in_progress', 'done'];
    if (!validStatuses.includes(status)) {
      return Response.json({ error: 'Invalid status' }, { status: 400 });
    }

    const updatePayload = { status };
    if (status === 'done') {
      updatePayload.completed_at = new Date().toISOString();
    } else {
      updatePayload.completed_at = null;
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .update(updatePayload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;
    const enrichedTask = await attachTaskMember(supabase, task);

    // Slack DM if marked done
    if (status === 'done' && enrichedTask.assigned_by && process.env.SLACK_BOT_TOKEN) {
      try {
        const { data: assigner } = await supabase
          .from('team_members')
          .select('slack_user_id, name')
          .ilike('name', enrichedTask.assigned_by)
          .single();

        if (assigner?.slack_user_id) {
          const openRes = await fetch('https://slack.com/api/conversations.open', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ users: assigner.slack_user_id }),
          });
          const openData = await openRes.json();

          if (openData.ok) {
            const completedBy = completed_by_name || enrichedTask.team_members?.name || 'A team member';
            await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel: openData.channel.id,
                blocks: [
                  { type: 'section', text: { type: 'mrkdwn', text: `✅ *Task completed!*\n*${completedBy}* just completed: *${enrichedTask.title}*` } },
                  { type: 'context', elements: [{ type: 'mrkdwn', text: `Completed at ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} Lagos time` }] },
                ],
              }),
            });
          }
        }
      } catch (slackErr) {
        console.error('Slack completion DM error (non-fatal):', slackErr);
      }
    }

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        member_id:   null,
        member_name: completed_by_name || 'App',
        action:      'task.update',
        entity_type: 'task',
        entity_id:   parseInt(id),
        details:     { status, title: enrichedTask.title },
        source:      'app',
      });
    } catch {}

    return Response.json({ task: enrichedTask });
  } catch (err) {
    console.error('PATCH /api/tasks/[id] error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]
export async function DELETE(request, context) {
  try {
    const supabase = getSupabase();
    const { id } = await context.params;

    // Fetch task title before deleting for audit context
    const { data: task } = await supabase
      .from('tasks')
      .select('title, assigned_by')
      .eq('id', id)
      .maybeSingle();

    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) throw error;

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        member_id:   null,
        member_name: task?.assigned_by || 'Admin',
        action:      'task.delete',
        entity_type: 'task',
        entity_id:   parseInt(id),
        details:     { title: task?.title },
        source:      'app',
      });
    } catch {}

    return Response.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/tasks/[id] error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
