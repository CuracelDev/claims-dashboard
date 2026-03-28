'use client';
import { useState, useEffect } from 'react';
import { useTheme } from '../../context/ThemeContext';

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

function CategoryBadge({ category }) {
  const colors = CATEGORY_COLORS[category] || CATEGORY_COLORS['General'];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20,
      background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
      whiteSpace: 'nowrap',
    }}>{category}</span>
  );
}

export default function PrismLogPage() {
  const { C } = useTheme();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('All');

  const categories = ['All', 'Pipeline Health', 'QA Analysis', 'Escalation', 'Weekly Review', 'Task Assignment', 'Reminder', 'Custom Query', 'General'];

  useEffect(() => { fetchLogs(); }, []);

  async function fetchLogs() {
    setLoading(true);
    try {
      const res = await fetch('/api/prism-logs');
      const data = await res.json();
      setLogs(data.data || []);
    } catch {}
    setLoading(false);
  }

  const filtered = filter === 'All' ? logs : logs.filter(l => l.category === filter);
  const dateLabel = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const timeLabel = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ padding: '28px 32px', background: C.bg, minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            background: 'linear-gradient(135deg, #7B61FF, #00E5A0)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          }}>✦</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>Prism Intelligence Log</div>
        </div>
        <div style={{ fontSize: 12, color: C.muted }}>All requests sent to Prism, auto-categorised by AI</div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Requests', value: logs.length },
          { label: 'This Week', value: logs.filter(l => new Date(l.created_at) > new Date(Date.now() - 7 * 86400000)).length },
          { label: 'Categories', value: [...new Set(logs.map(l => l.category))].length },
          { label: 'Team Members', value: [...new Set(logs.map(l => l.sent_by))].length },
        ].map(stat => (
          <div key={stat.label} style={{
            padding: '14px 20px', borderRadius: 10, background: C.card,
            border: `1px solid ${C.border}`, minWidth: 120,
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.accent }}>{stat.value}</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {categories.map(cat => (
          <button key={cat} onClick={() => setFilter(cat)} style={{
            padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
            cursor: 'pointer', transition: 'all 0.15s',
            background: filter === cat ? C.accent : C.elevated,
            color: filter === cat ? '#0B0F1A' : C.muted,
            border: `1px solid ${filter === cat ? C.accent : C.border}`,
          }}>{cat}</button>
        ))}
        <button onClick={fetchLogs} style={{
          padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
          cursor: 'pointer', background: C.elevated, color: C.muted,
          border: `1px solid ${C.border}`, marginLeft: 'auto',
        }}>↻ Refresh</button>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', color: C.muted, padding: 60 }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: C.muted, padding: 60 }}>No requests found.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '130px 110px 140px 1fr 80px',
            padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
            background: C.elevated,
          }}>
            {['Date', 'Sent By', 'Category', 'Summary', 'Status'].map(h => (
              <div key={h} style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</div>
            ))}
          </div>

          {filtered.map((log, i) => (
            <div key={log.id} style={{
              display: 'grid', gridTemplateColumns: '130px 110px 140px 1fr 80px',
              padding: '12px 16px', alignItems: 'center',
              borderBottom: i < filtered.length - 1 ? `1px solid ${C.border}` : 'none',
              background: i % 2 === 0 ? 'transparent' : `${C.elevated}50`,
            }}>
              <div>
                <div style={{ fontSize: 11, color: C.text, fontWeight: 500 }}>{dateLabel(log.created_at)}</div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{timeLabel(log.created_at)}</div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{log.sent_by}</div>
              <div><CategoryBadge category={log.category} /></div>
              <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4, paddingRight: 12 }}>{log.summary}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: log.status === 'sent' ? '#10B981' : C.muted }}>
                {log.status === 'sent' ? '✅ Sent' : log.status}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
