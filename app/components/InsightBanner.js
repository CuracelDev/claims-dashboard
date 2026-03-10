// PATH: app/components/InsightBanner.js
// Drop into any page: <InsightBanner />
// Self-fetching, collapsible, auto-refreshes every 60s

'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

function timeAgo(isoStr) {
  if (!isoStr) return null;
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function pctLabel(val, positive = true) {
  if (val === null || val === undefined) return null;
  const abs = Math.abs(val);
  const up  = val > 0;
  const color = up === positive ? '#00E5A0' : '#FF4D4D';
  return { text: `${up ? '▲' : '▼'} ${abs}%`, color };
}

export default function InsightBanner({ autoRefresh = true }) {
  const { C } = useTheme();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);

  const fetch_ = useCallback(() => {
    setLoading(true);
    fetch('/api/insights')
      .then(r => r.json())
      .then(d => { setData(d); setLastFetch(new Date()); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch_();
    if (!autoRefresh) return;
    const t = setInterval(fetch_, 60_000);
    return () => clearInterval(t);
  }, [fetch_, autoRefresh]);

  if (!data || data.error) return null;

  // ── Build insight messages ─────────────────────────────────────────
  const insights = [];

  // Submission alert
  if (data.submission?.pending?.length > 0) {
    const names = data.submission.pending.join(', ');
    const count = data.submission.pending.length;
    insights.push({
      icon: '⚠️',
      color: '#F59E0B',
      bg: '#F59E0B14',
      border: '#F59E0B33',
      text: `${count} member${count > 1 ? 's' : ''} haven't submitted today`,
      sub: names,
      type: 'warning',
    });
  } else if (data.submission?.submitted > 0) {
    insights.push({
      icon: '✅',
      color: '#00E5A0',
      bg: '#00E5A014',
      border: '#00E5A033',
      text: `All ${data.submission.submitted} active members submitted today`,
      sub: null,
      type: 'success',
    });
  }

  // Top metric delta vs yesterday
  const bigWin = (data.today_vs_yesterday || [])
    .filter(m => m.pct_change !== null && m.pct_change > 10 && m.today > 0)
    .sort((a, b) => b.pct_change - a.pct_change)[0];
  if (bigWin) {
    insights.push({
      icon: '📈',
      color: '#00E5A0',
      bg: '#00E5A00D',
      border: '#00E5A022',
      text: `${bigWin.label} up ${bigWin.pct_change}% vs yesterday`,
      sub: `${bigWin.today.toLocaleString()} today vs ${bigWin.yesterday.toLocaleString()} yesterday`,
      type: 'positive',
    });
  }

  // Worst metric delta vs yesterday
  const bigDrop = (data.today_vs_yesterday || [])
    .filter(m => m.pct_change !== null && m.pct_change < -15 && m.yesterday > 0)
    .sort((a, b) => a.pct_change - b.pct_change)[0];
  if (bigDrop) {
    insights.push({
      icon: '📉',
      color: '#FF4D4D',
      bg: '#FF4D4D0D',
      border: '#FF4D4D22',
      text: `${bigDrop.label} down ${Math.abs(bigDrop.pct_change)}% vs yesterday`,
      sub: `${bigDrop.today.toLocaleString()} today vs ${bigDrop.yesterday.toLocaleString()} yesterday`,
      type: 'negative',
    });
  }

  // Behind targets
  const behindTargets = (data.targets || []).filter(t => t.pace === 'behind' && t.days_left > 0);
  if (behindTargets.length > 0) {
    const names = behindTargets.map(t => `${t.name} (${t.pct_complete ?? 0}%)`).join(' · ');
    insights.push({
      icon: '🎯',
      color: '#FF4D4D',
      bg: '#FF4D4D0D',
      border: '#FF4D4D22',
      text: `${behindTargets.length} target${behindTargets.length > 1 ? 's' : ''} behind pace`,
      sub: names,
      type: 'negative',
    });
  }

  // On-track targets
  const onTrackTargets = (data.targets || []).filter(t => t.pace === 'on_track' || t.pct_complete >= 100);
  if (onTrackTargets.length > 0 && behindTargets.length === 0) {
    insights.push({
      icon: '🎯',
      color: '#00E5A0',
      bg: '#00E5A00D',
      border: '#00E5A022',
      text: `${onTrackTargets.length} of ${data.targets.length} targets on track this week`,
      sub: null,
      type: 'positive',
    });
  }

  // QA flag spike
  if (data.qa_flags?.spike) {
    insights.push({
      icon: '🚩',
      color: '#F59E0B',
      bg: '#F59E0B0D',
      border: '#F59E0B22',
      text: `QA flags spiked — ${data.qa_flags.today} today vs ${data.qa_flags.yesterday} yesterday`,
      sub: null,
      type: 'warning',
    });
  }

  // Week-on-week best metric
  const weekWin = (data.week_vs_lastweek || [])
    .filter(m => m.pct_change !== null && m.pct_change > 5 && m.this_week > 0 && m.key !== 'flagged_care_items')
    .sort((a, b) => b.pct_change - a.pct_change)[0];
  if (weekWin) {
    insights.push({
      icon: '📊',
      color: '#5B8DEF',
      bg: '#5B8DEF0D',
      border: '#5B8DEF22',
      text: `${weekWin.label} +${weekWin.pct_change}% vs last week`,
      sub: `${weekWin.this_week.toLocaleString()} this week vs ${weekWin.last_week.toLocaleString()} last week`,
      type: 'info',
    });
  }

  if (insights.length === 0) return null;

  const kpis = data.kpis || {};

  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      marginBottom: 20,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(p => !p)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
          cursor: 'pointer',
          background: C.elevated,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#00E5A0' }}>
            ⚡ Operations Insights
          </span>
          {loading && (
            <span style={{ fontSize: 11, color: C.sub }}>refreshing…</span>
          )}
          {!loading && lastFetch && (
            <span style={{ fontSize: 11, color: C.muted }}>
              Updated {timeAgo(lastFetch)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* KPI pills */}
          {kpis.submission_rate !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px',
              borderRadius: 20, background: kpis.submission_rate === 100 ? '#00E5A022' : '#F59E0B22',
              color: kpis.submission_rate === 100 ? '#00E5A0' : '#F59E0B',
              border: `1px solid ${kpis.submission_rate === 100 ? '#00E5A033' : '#F59E0B33'}`,
            }}>
              {kpis.submission_rate}% submitted
            </span>
          )}
          {kpis.target_attainment !== null && kpis.target_attainment !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px',
              borderRadius: 20,
              background: kpis.target_attainment >= 80 ? '#00E5A022' : kpis.target_attainment >= 50 ? '#5B8DEF22' : '#FF4D4D22',
              color: kpis.target_attainment >= 80 ? '#00E5A0' : kpis.target_attainment >= 50 ? '#5B8DEF' : '#FF4D4D',
              border: `1px solid ${kpis.target_attainment >= 80 ? '#00E5A033' : kpis.target_attainment >= 50 ? '#5B8DEF33' : '#FF4D4D33'}`,
            }}>
              {kpis.target_attainment}% targets on track
            </span>
          )}
          <span style={{ color: C.sub, fontSize: 16, userSelect: 'none' }}>
            {collapsed ? '▾' : '▴'}
          </span>
        </div>
      </div>

      {/* Insight rows */}
      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {insights.map((ins, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '9px 16px',
              borderBottom: i < insights.length - 1 ? `1px solid ${C.border}` : 'none',
              background: ins.bg,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0 }}>{ins.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: ins.color, fontWeight: 600 }}>
                  {ins.text}
                </span>
                {ins.sub && (
                  <span style={{ fontSize: 12, color: C.sub, marginLeft: 8 }}>
                    — {ins.sub}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
