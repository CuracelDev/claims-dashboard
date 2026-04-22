// PATH: app/api/prism-chat/route.js
// Note: Anthropic SDK kept for reference, now using Azure OpenAI
// import Anthropic from '@anthropic-ai/sdk';
import { chatCompletionJSON, MODELS } from '../../../lib/azure-openai';
import { getSupabase } from '../../../lib/supabase';
import {
  cleanSlackText,
  getPrismConfig,
  isPrismSlackMessage,
  slackGet,
  slackPost,
} from '../../../lib/prism-slack';

export const dynamic = 'force-dynamic';

async function pollForReply(channel, threadTs, afterTs, maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 4000));
    const threadData = await slackGet('conversations.replies', {
      channel,
      ts: threadTs,
      oldest: afterTs,
      limit: 20,
    });

    if (threadData.ok) {
      const reply = (threadData.messages || []).find(
        m => isPrismSlackMessage(m) && m.ts !== afterTs
      );
      if (reply) return reply.text;
    }

    if (threadTs === afterTs) {
      const histData = await slackGet('conversations.history', {
        channel,
        oldest: afterTs,
        limit: 10,
      });
      if (!histData.ok) continue;
      const reply = (histData.messages || []).find(m => isPrismSlackMessage(m));
      if (reply) return reply.text;
    }
  }
  return null;
}

async function safeSelectConversation(supabase, conversationId) {
  if (!conversationId) return null;
  const { data, error } = await supabase
    .from('prism_conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) {
    console.warn('[prism-chat] conversation lookup skipped:', error.message);
    return null;
  }
  return data;
}

async function safeCreateConversation(supabase, { memberName, channel, threadTs }) {
  const { data, error } = await supabase
    .from('prism_conversations')
    .insert({
      created_by: memberName || 'Unknown',
      slack_channel: channel,
      slack_thread_ts: threadTs,
      status: 'open',
    })
    .select('id, slack_channel, slack_thread_ts')
    .single();

  if (error) {
    console.warn('[prism-chat] conversation persistence skipped:', error.message);
    return null;
  }
  return data;
}

async function safeInsertMessage(supabase, message) {
  const { error } = await supabase.from('prism_messages').insert(message);
  if (error) console.warn('[prism-chat] message persistence skipped:', error.message);
}

async function safeInsertLog(supabase, log) {
  const { error } = await supabase.from('prism_logs').insert(log);
  if (error) console.warn('[prism-chat] log insert skipped:', error.message);
}

async function safeUpdateReply(supabase, { threadTs, reply }) {
  if (!reply) return;

  await supabase
    .from('prism_logs')
    .update({ prism_reply: reply, status: 'replied' })
    .eq('slack_ts', threadTs);
}

function slackMessagesToChat(messages = [], threadTs) {
  return messages
    .filter((msg) => msg.ts !== threadTs || !isPrismSlackMessage(msg))
    .map((msg) => ({
      id: msg.ts,
      direction: isPrismSlackMessage(msg) ? 'prism' : 'user',
      body: cleanSlackText(msg.text),
      slack_ts: msg.ts,
      created_at: new Date(parseFloat(msg.ts) * 1000).toISOString(),
    }))
    .filter((msg) => msg.body);
}

// JSON schema for structured output
const CATEGORISE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['Pipeline Health', 'QA Analysis', 'Escalation', 'Weekly Review', 'Task Assignment', 'Reminder', 'Custom Query', 'General'],
    },
    summary: {
      type: 'string',
      description: 'Single sentence summary, max 12 words',
    },
  },
  required: ['category', 'summary'],
  additionalProperties: false,
};

async function categorise(message) {
  try {
    const result = await chatCompletionJSON({
      model: MODELS.GPT_41,
      messages: [{
        role: 'user',
        content: `Categorise this message sent to an AI agent in a health insurance ops team.

Message: "${message}"

Provide:
- category: the most appropriate category for this message
- summary: a single sentence summary (max 12 words)`,
      }],
      maxTokens: 150,
      temperature: 0.3,
      jsonSchema: CATEGORISE_SCHEMA,
      schemaName: 'message_category',
    });
    return result || { category: 'General', summary: message.slice(0, 80) };
  } catch {
    return { category: 'General', summary: message.slice(0, 80) };
  }
}

export async function POST(request) {
  try {
    const { message, member_name, conversation_id } = await request.json();
    if (!message) return Response.json({ error: 'No message provided' }, { status: 400 });

    const { channel, prismUserId, dashboardUrl } = getPrismConfig();
    const supabase = getSupabase();
    const existingConversation = await safeSelectConversation(supabase, conversation_id);
    const fallbackThreadTs = conversation_id && /^\d+\.\d+$/.test(conversation_id)
      ? conversation_id
      : null;
    const threadTs = existingConversation?.slack_thread_ts || fallbackThreadTs;
    const slackChannel = existingConversation?.slack_channel || channel;

    const slackData = await slackPost('chat.postMessage', {
      channel: slackChannel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `<@${prismUserId}> ${message}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `<@${prismUserId}> ${message}` },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `Sent via Claims Intel Dashboard${member_name ? ` by *${member_name}*` : ''} · <${dashboardUrl}/slack|Open Prism>`,
          }],
        },
      ],
      unfurl_links: false,
    });

    if (!slackData.ok) {
      return Response.json({ success: false, error: slackData.error }, { status: 500 });
    }

    const slackThreadTs = threadTs || slackData.ts;
    const persistedConversation = existingConversation
      || await safeCreateConversation(supabase, {
        memberName: member_name,
        channel: slackChannel,
        threadTs: slackThreadTs,
      });
    const responseConversationId = persistedConversation?.id || slackThreadTs;

    await safeInsertMessage(supabase, {
      conversation_id: persistedConversation?.id,
      direction: 'user',
      body: message,
      slack_ts: slackData.ts,
      slack_user_id: null,
      status: 'sent',
    });

    const prismReply = await pollForReply(slackChannel, slackThreadTs, slackData.ts);

    const { category, summary } = await categorise(message);
    await safeInsertLog(supabase, {
      sent_by: member_name || 'Unknown',
      message,
      category,
      summary,
      slack_ts: slackData.ts,
      status: prismReply ? 'replied' : 'sent',
      prism_reply: prismReply,
    });

    if (prismReply) {
      await safeInsertMessage(supabase, {
        conversation_id: persistedConversation?.id,
        direction: 'prism',
        body: cleanSlackText(prismReply),
        slack_ts: null,
        slack_user_id: getPrismConfig().prismUserId,
        status: 'received',
      });
      await safeUpdateReply(supabase, { threadTs: slackThreadTs, reply: prismReply });
    }

    return Response.json({
      success: true,
      conversation_id: responseConversationId,
      thread_ts: slackThreadTs,
      ts: slackData.ts,
      category,
      summary,
      prism_reply: prismReply,
    });

  } catch (err) {
    console.error('[prism-chat error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get('conversation_id');
    if (!conversationId) return Response.json({ error: 'No conversation_id provided' }, { status: 400 });

    const { channel } = getPrismConfig();
    const supabase = getSupabase();
    const conversation = await safeSelectConversation(supabase, conversationId);

    if (conversation?.id) {
      const { data, error } = await supabase
        .from('prism_messages')
        .select('*')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true });

      if (!error && data?.length) {
        return Response.json({
          success: true,
          conversation_id: conversation.id,
          thread_ts: conversation.slack_thread_ts,
          messages: data.map((msg) => ({
            id: msg.id,
            direction: msg.direction,
            body: msg.body,
            slack_ts: msg.slack_ts,
            created_at: msg.created_at,
          })),
        });
      }
    }

    const threadTs = conversation?.slack_thread_ts || (
      /^\d+\.\d+$/.test(conversationId) ? conversationId : null
    );
    if (!threadTs) return Response.json({ success: true, conversation_id: conversationId, messages: [] });

    const thread = await slackGet('conversations.replies', {
      channel: conversation?.slack_channel || channel,
      ts: threadTs,
      limit: 100,
    });

    if (!thread.ok) return Response.json({ error: thread.error }, { status: 500 });

    return Response.json({
      success: true,
      conversation_id: conversation?.id || threadTs,
      thread_ts: threadTs,
      messages: slackMessagesToChat(thread.messages || [], threadTs),
    });
  } catch (err) {
    console.error('[prism-chat GET error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
