'use client';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { getSession } from '../lib/auth';

const CATEGORY_COLORS = {
  'Pipeline Health':  { bg: '#3B82F615', text: '#3B82F6', border: '#3B82F630' },
  'QA Analysis':      { bg: '#8B5CF615', text: '#8B5CF6', border: '#8B5CF630' },
  'Escalation':       { bg: '#EF444415', text: '#EF4444', border: '#EF444430' },
  'Weekly Review':    { bg: '#10B98115', text: '#10B981', border: '#10B98130' },
  'Task Assignment':  { bg: '#F59E0B15', text: '#F59E0B', border: '#F59E0B30' },
  'Reminder':         { bg: '#EC489915', text: '#EC4899', border: '#EC489930' },
  'Custom Query':     { bg: '#06B6D415', text: '#06B6D4', border: '#06B6D430' },
  'General':          { bg: '#6B728015', text: '#6B7280', border: '#6B728030' },
};

function CategoryBadge({ category, C }) {
  const colors = CATEGORY_COLORS[category] || CATEGORY_COLORS['General'];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20,
      background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
      whiteSpace: 'nowrap',
    }}>{category}</span>
  );
}

export default function PrismPage() {
  const { C } = useTheme();
  const [tab, setTab] = useState('chat');
  const [messages, setMessages] = useState([{
    role: 'prism',
    text: "Hey! I'm Prism 👋 Ask me anything about claims, QA flags, reports, or team tasks. I'll respond in Slack and echo it here.",
    ts: new Date().toISOString(),
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [member, setMember] = useState('');
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);
  const messagesRef = useRef(messages);

  useEffect(() => {
    const session = getSession();
    setMember(session?.member_name || 'You');
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (tab === 'log') fetchLogs();
  }, [tab]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  async function fetchLogs() {
    setLogsLoading(true);
    try {
      const res = await fetch('/api/prism-logs');
      const data = await res.json();
      setLogs(data.data || []);
    } catch {}
    setLogsLoading(false);
  }

  function appendPrismMessages(remoteMessages = []) {
    const existing = new Set(messagesRef.current.map(msg => msg.remoteKey).filter(Boolean));
    const existingText = new Set(messagesRef.current.map(msg => `${msg.role}:${msg.text}`));
    const additions = remoteMessages
      .filter(msg => msg.direction === 'prism' && msg.body)
      .filter(msg => {
        const key = msg.slack_ts || msg.id || `${msg.created_at}:${msg.body}`;
        if (existing.has(key)) return false;
        if (existingText.has(`prism:${msg.body}`)) return false;
        existing.add(key);
        existingText.add(`prism:${msg.body}`);
        return true;
      })
      .map(msg => ({
        role: 'prism',
        text: msg.body,
        ts: msg.created_at || new Date().toISOString(),
        remoteKey: msg.slack_ts || msg.id || `${msg.created_at}:${msg.body}`,
      }));

    if (additions.length) {
      const nextMessages = [...messagesRef.current, ...additions];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    }
    return additions.length > 0;
  }

  function pollConversation(nextConversationId) {
    if (!nextConversationId) return;
    if (pollRef.current) clearInterval(pollRef.current);

    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch(`/api/prism-chat?conversation_id=${encodeURIComponent(nextConversationId)}`);
        const data = await res.json();
        const added = appendPrismMessages(data.messages || []);
        if (added) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setLoading(false);
        }
      } catch {}

      if (attempts >= 20) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setLoading(false);
        setMessages(prev => [...prev, {
          role: 'prism',
          text: 'Message sent to Prism. I am still waiting for the Slack thread reply, so refresh shortly if it takes longer.',
          ts: new Date().toISOString(),
        }]);
      }
    }, 3000);
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;
    const messageText = input.trim();
    const userMsg = { role: 'user', text: messageText, ts: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('/api/prism-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageText, member_name: member, conversation_id: conversationId }),
      });
      const data = await res.json();
      if (!data.success) {
        setMessages(prev => [...prev, {
          role: 'prism',
          text: `Something went wrong: ${data.error}`,
          ts: new Date().toISOString(),
        }]);
        setLoading(false);
        return;
      }

      const nextConversationId = data.conversation_id || data.thread_ts;
      if (nextConversationId) setConversationId(nextConversationId);

      if (data.prism_reply) {
        setMessages(prev => [...prev, {
          role: 'prism',
          text: data.prism_reply,
          ts: new Date().toISOString(),
          category: data.category,
          remoteKey: `reply:${data.thread_ts}:${data.prism_reply}`,
        }]);
        setLoading(false);
      } else {
        pollConversation(nextConversationId);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'prism', text: 'Failed to reach Slack. Check your connection.', ts: new Date().toISOString() }]);
      setLoading(false);
    }
  }

  const timeLabel = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateLabel = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg }}>

      {/* Header */}
      <div style={{
        padding: '18px 28px', borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', gap: 12, background: C.card,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: 'linear-gradient(135deg, #7B61FF, #00E5A0)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        }}>✦</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Prism</div>
          <div style={{ fontSize: 11, color: C.muted }}>AI Agent · Responds in the test Slack channel</div>
        </div>
        <div style={{
          marginLeft: 'auto', fontSize: 10, fontWeight: 600,
          padding: '4px 10px', borderRadius: 20,
          background: '#00E5A015', color: '#00E5A0', border: '1px solid #00E5A030',
        }}>● ONLINE</div>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', borderBottom: `1px solid ${C.border}`,
        background: C.card, padding: '0 28px',
      }}>
        {[{ id: 'chat', label: '💬 Chat' }, { id: 'log', label: '📋 Intelligence Log' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '12px 20px', fontSize: 13, fontWeight: tab === t.id ? 700 : 400,
            color: tab === t.id ? C.accent : C.muted,
            borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            background: 'transparent', border: 'none', cursor: 'pointer',
            transition: 'all 0.15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Chat Tab */}
      {tab === 'chat' && (
        <>
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {messages.map((msg, i) => (
              <div key={i} style={{
                display: 'flex',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                alignItems: 'flex-end', gap: 10,
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 10, flexShrink: 0,
                  background: msg.role === 'prism' ? 'linear-gradient(135deg, #7B61FF, #00E5A0)' : C.elevated,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: msg.role === 'prism' ? 14 : 12,
                  color: msg.role === 'prism' ? '#fff' : C.muted, fontWeight: 700,
                }}>
                  {msg.role === 'prism' ? '✦' : member.charAt(0).toUpperCase()}
                </div>
                <div style={{ maxWidth: '65%' }}>
                  <div style={{
                    padding: '10px 14px', borderRadius: 12,
                    borderBottomLeftRadius: msg.role === 'prism' ? 4 : 12,
                    borderBottomRightRadius: msg.role === 'user' ? 4 : 12,
                    background: msg.role === 'prism' ? C.elevated : '#7B61FF',
                    color: msg.role === 'prism' ? C.text : '#fff',
                    fontSize: 13, lineHeight: 1.5,
                    border: `1px solid ${msg.role === 'prism' ? C.border : 'transparent'}`,
                  }}>{msg.text}</div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 4, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                    {timeLabel(msg.ts)}
                    {msg.category && <CategoryBadge category={msg.category} C={C} />}
                  </div>
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 10,
                  background: 'linear-gradient(135deg, #7B61FF, #00E5A0)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
                }}>✦</div>
                <div style={{
                  padding: '10px 16px', borderRadius: 12, borderBottomLeftRadius: 4,
                  background: C.elevated, border: `1px solid ${C.border}`,
                  fontSize: 13, color: C.muted,
                }}>Prism is thinking...</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div style={{
            padding: '16px 28px', borderTop: `1px solid ${C.border}`,
            background: C.card, display: 'flex', gap: 10, alignItems: 'center',
          }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Ask Prism anything..."
              style={{
                flex: 1, padding: '10px 16px', borderRadius: 10,
                background: C.elevated, border: `1px solid ${C.border}`,
                color: C.text, fontSize: 13, outline: 'none',
              }}
            />
            <button onClick={sendMessage} disabled={loading || !input.trim()} style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              background: loading || !input.trim() ? C.elevated : 'linear-gradient(135deg, #7B61FF, #00E5A0)',
              color: loading || !input.trim() ? C.muted : '#0B0F1A',
              fontSize: 13, fontWeight: 700,
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}>{loading ? '...' : 'Send →'}</button>
          </div>
        </>
      )}

      {/* Intelligence Log Tab */}
      {tab === 'log' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Prism Intelligence Log</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>All requests sent to Prism, auto-categorised by AI</div>
            </div>
            <button onClick={fetchLogs} style={{
              padding: '6px 14px', borderRadius: 8, border: `1px solid ${C.border}`,
              background: C.elevated, color: C.text, fontSize: 12, cursor: 'pointer',
            }}>↻ Refresh</button>
          </div>

          {logsLoading ? (
            <div style={{ textAlign: 'center', color: C.muted, padding: 40 }}>Loading...</div>
          ) : logs.length === 0 ? (
            <div style={{ textAlign: 'center', color: C.muted, padding: 40 }}>No Prism requests logged yet. Send a message to get started.</div>
          ) : (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
              {/* Table Header */}
              <div style={{
                display: 'grid', gridTemplateColumns: '120px 100px 130px 1fr 80px',
                padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
                background: C.elevated,
              }}>
                {['Date', 'Sent By', 'Category', 'Summary', 'Status'].map(h => (
                  <div key={h} style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</div>
                ))}
              </div>

              {/* Rows */}
              {logs.map((log, i) => (
                <div key={log.id} style={{
                  display: 'grid', gridTemplateColumns: '120px 100px 130px 1fr 80px',
                  padding: '12px 16px',
                  borderBottom: i < logs.length - 1 ? `1px solid ${C.border}` : 'none',
                  background: i % 2 === 0 ? 'transparent' : `${C.elevated}50`,
                  alignItems: 'center',
                }}>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    <div>{dateLabel(log.created_at)}</div>
                    <div style={{ fontSize: 10, marginTop: 2 }}>{timeLabel(log.created_at)}</div>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{log.sent_by}</div>
                  <div><CategoryBadge category={log.category} C={C} /></div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4, paddingRight: 12 }}>{log.summary}</div>
                  <div style={{
                    fontSize: 10, fontWeight: 700,
                    color: log.status === 'sent' ? '#10B981' : C.muted,
                  }}>{log.status === 'sent' ? '✅ Sent' : log.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
