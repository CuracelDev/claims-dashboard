'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTheme } from '../context/ThemeContext';

function timeAgo(isoStr) {
  if (!isoStr) return null;
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortList(arr = [], max = 6) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  if (arr.length <= max) return arr.join(', ');
  return `${arr.slice(0, max).join(', ')} +${arr.length - max} more`;
}

export default function InsightBanner({ autoRefresh = true }) {
  const { C } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchInsights = useCallback(() => {
    setLoading(true);
    fetch('/api/insights')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || d?.error) throw new Error(d?.error || 'Failed to load insights');
        setData(d);
        setLastFetch(new Date().toISOString());
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchInsights();
    if (!autoRefresh) return;
    const t = setInterval(fetchInsights, 60_000);
    return () => clearInterval(t);
  }, [fetchInsights, autoRefresh]);

  const insights = useMemo(() => {
    if (!data || data.error) return [];

    const rows = [];

    const submitted = data?.submission?.submitted || 0;
    const pending = data?.submission?.pending || [];
    const totalTargets = data?.targets?.length || 0;

    if (pending.length > 0) {
      rows.push({
        icon: '⚠️',
        color: '#F59E0B',
        bg: '#F59E0B14',
        text: `${pending.length} member${pending.length > 1 ? 's' : ''} still pending today`,
        sub: shortList(pending),
      });
    } else if (submitted > 0) {
      rows.push({
        icon: '✅',
        color: '#00E5A0',
        bg: '#00E5A014',
        text: `All ${submitted} active member${submitted > 1 ? 's have' : ' has'} submitted today`,
        sub: null,
      });
    }

    const bestToday = (data?.today_vs_yesterday || [])
      .filter((m) => m?.pct_change !== null && m?.pct_change > 10 && m?.today > 0)
      .sort((a, b) => b.pct_change - a.pct_change)[0];

    if (bestToday) {
      rows.push({
        icon: '📈',
        color: '#00E5A0',
        bg: '#00E5A00D',
        text: `${bestToday.label} up ${bestToday.pct_change}% vs yesterday`,
        sub: `${bestToday.today.toLocaleString()} today vs ${bestToday.yesterday.toLocaleString()} yesterday`,
      });
    }

    const biggestDrop = (data?.today_vs_yesterday || [])
      .filter((m) => m?.pct_change !== null && m?.pct_change < -15 && m?.yesterday > 0)
      .sort((a, b) => a.pct_change - b.pct_change)[0];

    if (biggestDrop) {
      rows.push({
        icon: '📉',
        color: '#FF4D4D',
        bg: '#FF4D4D0D',
        text: `${biggestDrop.label} down ${Math.abs(biggestDrop.pct_change)}% vs yesterday`,
        sub: `${biggestDrop.today.toLocaleString()} today vs ${biggestDrop.yesterday.toLocaleString()} yesterday`,
      });
    }

    const behindTargets = (data?.targets || []).filter(
      (t) => t?.pace === 'behind' && t?.days_left > 0
    );

    if (behindTargets.length > 0) {
      rows.push({
        icon: '🎯',
        color: '#FF4D4D',
        bg: '#FF4D4D0D',
        text: `${behindTargets.length} target${behindTargets.length > 1 ? 's are' : ' is'} behind pace`,
        sub: behindTargets
          .map((t) => `${t.name} (${t.pct_complete ?? 0}%)`)
          .slice(0, 4)
          .join(' · '),
      });
    } else {
      const onTrackTargets = (data?.targets || []).filter(
        (t) => t?.pace === 'on_track' || (t?.pct_complete ?? 0) >= 100
      );

      if (onTrackTargets.length > 0 && totalTargets > 0) {
        rows.push({
          icon: '🎯',
          color: '#00E5A0',
          bg: '#00E5A00D',
          text: `${onTrackTargets.length} of ${totalTargets} target${totalTargets > 1 ? 's are' : ' is'} on track`,
          sub: null,
        });
      }
    }

    if (data?.qa_flags?.spike) {
      rows.push({
        icon: '🚩',
        color: '#F59E0B',
        bg: '#F59E0B0D',
        text: `QA flags increased today`,
        sub: `${data.qa_flags.today} today vs ${data.qa_flags.yesterday} yesterday`,
      });
    }

    const weekWin = (data?.week_vs_lastweek || [])
      .filter(
        (m) =>
          m?.pct_change !== null &&
          m?.pct_change > 5 &&
          m?.this_week > 0 &&
          m?.key !== 'flagged_care_items'
      )
      .sort((a, b) => b.pct_change - a.pct_change)[0];

    if (weekWin) {
      rows.push({
        icon: '📊',
        color: '#5B8DEF',
        bg: '#5B8DEF0D',
        text: `${weekWin.label} +${weekWin.pct_change}% vs last week`,
        sub: `${weekWin.this_week.toLocaleString()} this week vs ${weekWin.last_week.toLocaleString()} last week`,
      });
    }

    return rows.slice(0, 5);
  }, [data]);

  if (!data || data.error || insights.length === 0) return null;

  const kpis = data.kpis || {};

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        marginBottom: 20,
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setCollapsed((p) => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
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
          {loading ? (
            <span style={{ fontSize: 11, color: C.sub }}>refreshing…</span>
          ) : (
            lastFetch && (
              <span style={{ fontSize: 11, color: C.muted }}>
                Updated {timeAgo(lastFetch)}
              </span>
            )
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {kpis.submission_rate !== undefined && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 20,
                background: kpis.submission_rate === 100 ? '#00E5A022' : '#F59E0B22',
                color: kpis.submission_rate === 100 ? '#00E5A0' : '#F59E0B',
                border: `1px solid ${
                  kpis.submission_rate === 100 ? '#00E5A033' : '#F59E0B33'
                }`,
              }}
            >
              {kpis.submission_rate}% submitted
            </span>
          )}

          {kpis.target_attainment !== null && kpis.target_attainment !== undefined && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 20,
                background:
                  kpis.target_attainment >= 80
                    ? '#00E5A022'
                    : kpis.target_attainment >= 50
                    ? '#5B8DEF22'
                    : '#FF4D4D22',
                color:
                  kpis.target_attainment >= 80
                    ? '#00E5A0'
                    : kpis.target_attainment >= 50
                    ? '#5B8DEF'
                    : '#FF4D4D',
                border: `1px solid ${
                  kpis.target_attainment >= 80
                    ? '#00E5A033'
                    : kpis.target_attainment >= 50
                    ? '#5B8DEF33'
                    : '#FF4D4D33'
                }`,
              }}
            >
              {kpis.target_attainment}% targets on track
            </span>
          )}

          <span style={{ color: C.sub, fontSize: 16, userSelect: 'none' }}>
            {collapsed ? '▾' : '▴'}
          </span>
        </div>
      </div>

      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {insights.map((ins, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 16px',
                borderBottom: i < insights.length - 1 ? `1px solid ${C.border}` : 'none',
                background: ins.bg,
              }}
            >
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
