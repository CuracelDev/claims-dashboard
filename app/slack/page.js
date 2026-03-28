'use client';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { getSession } from '../lib/auth';

export default function PrismPage() {
  const { C } = useTheme();
  const [messages, setMessages] = useState([
    {
      role: 'prism',
      text: "Hey! I'm Prism 👋 Ask me anything about claims, QA flags, reports, or team tasks. I'll respond in Slack and echo it here.",
      ts: new Date().toISOString(),
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [member, setMember] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    const session = getSession();
    setMember(session?.member_name || 'You');
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', text: input.trim(), ts: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/prism-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input.trim(), member_name: member }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, {
        role: 'prism',
        text: data.success
          ? "Got it — I've posted your message to Prism in Slack. Check #health-ops for the response 👀"
          : `Something went wrong: ${data.error}`,
        ts: new Date().toISOString(),
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'prism',
        text: 'Failed to reach Slack. Check your connection.',
        ts: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  }

  const timeLabel = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg }}>

      {/* Header */}
      <div style={{
        padding: '18px 28px', borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center', gap: 12,
        background: C.card,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: 'linear-gradient(135deg, #7B61FF, #00E5A0)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20,
        }}>✦</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Prism</div>
          <div style={{ fontSize: 11, color: C.muted }}>AI Agent · Responds in #health-ops</div>
        </div>
        <div style={{
          marginLeft: 'auto', fontSize: 10, fontWeight: 600,
          padding: '4px 10px', borderRadius: 20,
          background: '#00E5A015', color: '#00E5A0',
          border: '1px solid #00E5A030',
        }}>● ONLINE</div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{
            display: 'flex',
            flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
            alignItems: 'flex-end', gap: 10,
          }}>
            {/* Avatar */}
            <div style={{
              width: 32, height: 32, borderRadius: 10, flexShrink: 0,
              background: msg.role === 'prism'
                ? 'linear-gradient(135deg, #7B61FF, #00E5A0)'
                : C.elevated,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: msg.role === 'prism' ? 14 : 12,
              color: msg.role === 'prism' ? '#fff' : C.muted,
              fontWeight: 700,
            }}>
              {msg.role === 'prism' ? '✦' : member.charAt(0).toUpperCase()}
            </div>

            {/* Bubble */}
            <div style={{ maxWidth: '65%' }}>
              <div style={{
                padding: '10px 14px', borderRadius: 12,
                borderBottomLeftRadius: msg.role === 'prism' ? 4 : 12,
                borderBottomRightRadius: msg.role === 'user' ? 4 : 12,
                background: msg.role === 'prism' ? C.elevated : `#7B61FF`,
                color: msg.role === 'prism' ? C.text : '#fff',
                fontSize: 13, lineHeight: 1.5,
                border: `1px solid ${msg.role === 'prism' ? C.border : 'transparent'}`,
              }}>
                {msg.text}
              </div>
              <div style={{
                fontSize: 10, color: C.muted, marginTop: 4,
                textAlign: msg.role === 'user' ? 'right' : 'left',
              }}>{timeLabel(msg.ts)}</div>
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

      {/* Input */}
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
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          style={{
            padding: '10px 20px', borderRadius: 10, border: 'none',
            background: loading || !input.trim() ? C.elevated : 'linear-gradient(135deg, #7B61FF, #00E5A0)',
            color: loading || !input.trim() ? C.muted : '#0B0F1A',
            fontSize: 13, fontWeight: 700, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
          }}
        >
          {loading ? '...' : 'Send →'}
        </button>
      </div>
    </div>
  );
}
