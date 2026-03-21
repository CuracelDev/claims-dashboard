'use client';
// app/components/AINarrative.js
// AI-generated ops narrative using Anthropic API
// Replaces InsightBanner on Ops Overview

import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

function timeAgo(isoStr) {
  if (!isoStr) return null;
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function AINarrative() {
  const { C } = useTheme();
  const [insight,   setInsight]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [lastFetch, setLastFetch] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [data,      setData]      = useState(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Fetch raw insights data
      const res  = await fetch('/api/insights');
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);

      // 2. Build prompt
      const pending   = json.submission?.pending || [];
      const submitted = json.submission?.submitted || 0;
      const total     = json.submission?.total || 0;
      const targets   = json.targets || [];
      const kpis      = json.kpis || {};
      const todayVs   = json.today_vs_yesterday || [];
      const weekVs    = json.week_vs_lastweek || [];

      const prompt = `You are the operations intelligence system for Curacel Health Ops, an African health insurance claims processing team.

Here is today's operational data:

TEAM SUBMISSIONS:
- ${submitted} of ${total} members have submitted reports today
- Pending: ${pending.length > 0 ? pending.join(', ') : 'None — all submitted'}
- Submission rate: ${kpis.submission_rate ?? 0}%

TARGETS (${targets.length} active):
${targets.map(t => `- ${t.name}: ${t.pct_complete ?? 0}% complete, pace: ${t.pace}, ${t.days_left}d left`).join('\n') || '- No active targets'}

TODAY VS YESTERDAY:
${todayVs.filter(m => m.today > 0 || m.yesterday > 0).map(m => `- ${m.label}: ${m.today} today vs ${m.yesterday} yesterday (${m.pct_change !== null ? (m.pct_change > 0 ? '+' : '') + m.pct_change + '%' : 'n/a'})`).join('\n') || '- No data'}

THIS WEEK VS LAST WEEK:
${weekVs.filter(m => m.this_week > 0 || m.last_week > 0).map(m => `- ${m.label}: ${m.this_week?.toLocaleString()} this week vs ${m.last_week?.toLocaleString()} last week`).join('\n') || '- No data'}

Write a concise 2-3 sentence operational intelligence summary for the team lead. Be direct and specific. Lead with the most urgent issue if any. Mention specific numbers. End with one clear recommended action. Do not use bullet points. Do not use markdown. Write in plain sentences.`;

      // 3. Call Anthropic
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const aiData = await aiRes.json();
      const text   = aiData.content?.[0]?.text || '';
      setInsight(text);
      setLastFetch(new Date().toISOString());
    } catch (e) {
      setInsight('Unable to generate insight at this time.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    generate();
    const t = setInterval(generate, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(t);
  }, [generate]);

  const kpis = data?.kpis || {};
  const hasUrgent = (data?.submission?.pending?.length || 0) > 0 ||
    (data?.targets || []).some(t => t.pace === 'behind');

  return (
    <div style={{
      background: C.card,
      border: `1px solid ${hasUrgent ? '#FF4D4D44' : C.border}`,
      borderRadius: 12, marginBottom: 20, overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(p => !p)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', cursor: 'pointer',
          background: C.elevated,
          borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#00E5A0' }}>⚡ Operations Insights</span>
          {loading
            ? <span style={{ fontSize: 11, color: C.sub }}>generating…</span>
            : lastFetch && <span style={{ fontSize: 11, color: C.muted }}>Updated {timeAgo(lastFetch)}</span>
          }
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {kpis.submission_rate !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: kpis.submission_rate === 100 ? '#00E5A022' : '#F59E0B22',
              color: kpis.submission_rate === 100 ? '#00E5A0' : '#F59E0B',
              border: `1px solid ${kpis.submission_rate === 100 ? '#00E5A033' : '#F59E0B33'}`,
            }}>{kpis.submission_rate}% submitted</span>
          )}
          {kpis.target_attainment !== null && kpis.target_attainment !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: kpis.target_attainment >= 80 ? '#00E5A022' : kpis.target_attainment >= 50 ? '#5B8DEF22' : '#FF4D4D22',
              color: kpis.target_attainment >= 80 ? '#00E5A0' : kpis.target_attainment >= 50 ? '#5B8DEF' : '#FF4D4D',
              border: `1px solid ${kpis.target_attainment >= 80 ? '#00E5A033' : kpis.target_attainment >= 50 ? '#5B8DEF33' : '#FF4D4D33'}`,
            }}>{kpis.target_attainment}% targets on track</span>
          )}
          <button
            onClick={e => { e.stopPropagation(); generate(); }}
            style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              borderRadius: 6, padding: '2px 8px', cursor: 'pointer',
              fontSize: 10, color: C.muted,
            }}
          >↺</button>
          <span style={{ color: C.sub, fontSize: 16 }}>{collapsed ? '▾' : '▴'}</span>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ padding: '14px 16px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 14, height: 14, borderRadius: '50%',
                border: `2px solid ${C.accent}`, borderTopColor: 'transparent',
                animation: 'spin 0.8s linear infinite', flexShrink: 0,
              }} />
              <span style={{ fontSize: 13, color: C.sub }}>Analysing team performance…</span>
            </div>
          ) : (
            <p style={{
              fontSize: 14, color: C.text, lineHeight: 1.7,
              margin: 0, fontWeight: 400,
            }}>
              {insight}
            </p>
          )}
        </div>
      )}

      {/* Footer */}
      {!collapsed && !loading && (
        <div style={{
          padding: '6px 16px', borderTop: `1px solid ${C.border}`,
          background: C.elevated, display: 'flex', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 10, color: C.muted }}>
            AI-generated · based on {data?.submission?.total || 0} team members
          </span>
          {data?.freshness?.last_report_at && (
            <span style={{ fontSize: 10, color: C.muted }}>
              Last report: {timeAgo(data.freshness.last_report_at)}
            </span>
          )}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
