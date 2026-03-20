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

function safeChange(current, previous) {
  if (!previous || previous < 10) return null; // low baseline — suppress
  return Math.round(((current - previous) / previous) * 100);
}

function buildNarrative(data) {
  if (!data) return null;
  const pending  = data?.submission?.pending || [];
  const submitted = data?.submission?.submitted || 0;
  const active   = data?.kpis?.active_members || 0;
  const targets  = data?.targets || [];
  const hitTargets    = targets.filter(t => (t.pct_complete ?? 0) >= 100);
  const behindTargets = targets.filter(t => t.pace === 'behind' && t.days_left > 0);
  const atRisk        = targets.filter(t => t.pace === 'at_risk' && t.days_left > 0);

  const parts = [];

  if (pending.length === 0 && submitted > 0) {
    parts.push(`All ${submitted} active members have reported`);
  } else if (pending.length > 0) {
    parts.push(`${submitted} of ${active} members have reported — ${pending.length} still pending`);
  }

  if (hitTargets.length > 0 && behindTargets.length === 0) {
    parts.push(`targets are on track`);
  } else if (behindTargets.length > 0) {
    parts.push(`${behindTargets.length} target${behindTargets.length > 1 ? 's need' : ' needs'} attention`);
  } else if (atRisk.length > 0) {
    parts.push(`${atRisk.length} target${atRisk.length > 1 ? 's are' : ' is'} at risk`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

export default function InsightBanner({ autoRefresh = true }) {
  const { C } = useTheme();
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchInsights = useCallback(() => {
    setLoading(true);
    fetch('/api/insights')
      .then(async r => {
        const d = await r.json();
        if (!r.ok || d?.error) throw new Error(d?.error || 'Failed');
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

  const { urgent, watchlist, positive, context } = useMemo(() => {
    const urgent    = [];
    const watchlist = [];
    const positive  = [];
    const context   = [];

    if (!data || data.error) return { urgent, watchlist, positive, context };

    const pending       = data?.submission?.pending || [];
    const submitted     = data?.submission?.submitted || 0;
    const active        = data?.kpis?.active_members || 0;
    const targets       = data?.targets || [];
    const todayVsYest   = data?.today_vs_yesterday || [];
    const weekVsLast    = data?.week_vs_lastweek || [];

    // ── URGENT ──────────────────────────────────────────────────────────
    if (pending.length > 0) {
      const isLate = new Date().getHours() >= 15;
      urgent.push({
        icon: isLate ? '🔴' : '⚠️',
        label: isLate ? 'ACTION REQUIRED' : 'PENDING',
        text: `${pending.length} of ${active} members haven't reported yet`,
        sub: pending.join(', '),
        action: isLate ? 'Send reminders immediately' : 'Monitor — reports may still come in',
        color: isLate ? '#FF4D4D' : '#F59E0B',
      });
    }

    const behindTargets = targets.filter(t => t.pace === 'behind' && t.days_left > 0);
    if (behindTargets.length > 0) {
      behindTargets.forEach(t => {
        const daysLeft = t.days_left;
        urgent.push({
          icon: '🎯',
          label: 'TARGET AT RISK',
          text: `${t.name} is behind pace — ${t.pct_complete ?? 0}% complete with ${daysLeft}d left`,
          sub: `Needs ${daysLeft > 0 ? Math.ceil((t.target_value - (t.actual || 0)) / daysLeft).toLocaleString() : '—'} per day to recover`,
          action: 'Review workload allocation for this metric',
          color: '#FF4D4D',
        });
      });
    }

    // ── WATCHLIST ────────────────────────────────────────────────────────
    const atRiskTargets = targets.filter(t => t.pace === 'at_risk' && t.days_left > 0);
    if (atRiskTargets.length > 0) {
      atRiskTargets.forEach(t => {
        watchlist.push({
          icon: '⚡',
          label: 'AT RISK',
          text: `${t.name} is progressing but may miss — ${t.pct_complete ?? 0}% with ${t.days_left}d left`,
          sub: null,
          color: '#F59E0B',
        });
      });
    }

    const drops = todayVsYest.filter(m => {
      const chg = safeChange(m.today, m.yesterday);
      return chg !== null && chg < -20 && m.yesterday > 0;
    }).sort((a, b) => safeChange(a.today, a.yesterday) - safeChange(b.today, b.yesterday));

    drops.slice(0, 2).forEach(m => {
      const chg = safeChange(m.today, m.yesterday);
      watchlist.push({
        icon: '📉',
        label: 'DECLINING',
        text: `${m.label} dropped ${Math.abs(chg)}% vs yesterday`,
        sub: `${m.today.toLocaleString()} today vs ${m.yesterday.toLocaleString()} yesterday`,
        color: '#FF4D4D',
      });
    });

    if (data?.qa_flags?.spike) {
      watchlist.push({
        icon: '🚩',
        label: 'QA SPIKE',
        text: `QA flags increased today`,
        sub: `${data.qa_flags.today} today vs ${data.qa_flags.yesterday} yesterday`,
        color: '#F59E0B',
      });
    }

    // ── POSITIVE ─────────────────────────────────────────────────────────
    if (pending.length === 0 && submitted > 0) {
      positive.push({
        icon: '✅',
        label: 'COMPLETE',
        text: `All ${submitted} active members have submitted today`,
        sub: null,
        color: '#00E5A0',
      });
    }

    const hitTargets = targets.filter(t => (t.pct_complete ?? 0) >= 100);
    hitTargets.forEach(t => {
      positive.push({
        icon: '🏆',
        label: 'TARGET HIT',
        text: `${t.name} — target achieved`,
        sub: `${typeof t.actual === 'number' ? t.actual.toLocaleString() : t.actual} of ${t.target_value?.toLocaleString()} (${t.pct_complete}%)`,
        color: '#00E5A0',
      });
    });

    // ── CONTEXT ──────────────────────────────────────────────────────────
    const gains = todayVsYest.filter(m => {
      const chg = safeChange(m.today, m.yesterday);
      return chg !== null && chg > 10 && m.today > 0;
    }).sort((a, b) => safeChange(b.today, b.yesterday) - safeChange(a.today, a.yesterday));

    gains.slice(0, 1).forEach(m => {
      const chg = safeChange(m.today, m.yesterday);
      context.push({
        icon: '📈',
        label: 'TODAY',
        text: `${m.label} up ${chg}% vs yesterday`,
        sub: `${m.today.toLocaleString()} today vs ${m.yesterday.toLocaleString()} yesterday`,
        color: '#00E5A0',
      });
    });

    const weekGains = weekVsLast.filter(m => {
      const chg = safeChange(m.this_week, m.last_week);
      return chg !== null && chg > 5 && m.this_week > 0 && m.key !== 'flagged_care_items';
    }).sort((a, b) => safeChange(b.this_week, b.last_week) - safeChange(a.this_week, a.last_week));

    weekGains.slice(0, 1).forEach(m => {
      const chg = safeChange(m.this_week, m.last_week);
      context.push({
        icon: '📊',
        label: 'THIS WEEK',
        text: `${m.label} up ${chg}% vs last week`,
        sub: `${m.this_week.toLocaleString()} this week vs ${m.last_week.toLocaleString()} last week`,
        color: '#5B8DEF',
      });
    });

    return { urgent, watchlist, positive, context };
  }, [data]);

  const allInsights = [...urgent, ...watchlist, ...positive, ...context];
  if (!data || data.error || allInsights.length === 0) return null;

  const narrative = buildNarrative(data);
  const kpis      = data.kpis || {};
  const hasUrgent = urgent.length > 0;

  function InsightRow({ ins, i, total }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        padding: '10px 16px',
        borderBottom: i < total - 1 ? `1px solid ${C.border}` : 'none',
        background: ins.color + '08',
      }}>
        <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{ins.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: ins.sub || ins.action ? 3 : 0 }}>
            <span style={{
              fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
              padding: '1px 6px', borderRadius: 4,
              background: ins.color + '22', color: ins.color,
              border: `1px solid ${ins.color}33`, flexShrink: 0,
            }}>{ins.label}</span>
            <span style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{ins.text}</span>
          </div>
          {ins.sub && (
            <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{ins.sub}</div>
          )}
          {ins.action && (
            <div style={{ fontSize: 11, color: ins.color, marginTop: 4, fontWeight: 600 }}>
              → {ins.action}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: C.card,
      border: `1px solid ${hasUrgent ? '#FF4D4D44' : C.border}`,
      borderRadius: 12, marginBottom: 20, overflow: 'hidden',
      boxShadow: hasUrgent ? '0 0 0 1px #FF4D4D22' : 'none',
    }}>

      {/* Header */}
      <div
        onClick={() => setCollapsed(p => !p)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
          cursor: 'pointer', background: C.elevated,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#00E5A0', flexShrink: 0 }}>
            ⚡ Operations Insights
          </span>
          {loading ? (
            <span style={{ fontSize: 11, color: C.sub }}>refreshing…</span>
          ) : lastFetch && (
            <span style={{ fontSize: 11, color: C.muted }}>Updated {timeAgo(lastFetch)}</span>
          )}
          {narrative && !collapsed && (
            <span style={{
              fontSize: 11, color: C.sub, marginLeft: 4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>· {narrative}</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {urgent.length > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 20,
              background: '#FF4D4D22', color: '#FF4D4D', border: '1px solid #FF4D4D33',
            }}>
              {urgent.length} urgent
            </span>
          )}
          {kpis.submission_rate !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: kpis.submission_rate === 100 ? '#00E5A022' : '#F59E0B22',
              color: kpis.submission_rate === 100 ? '#00E5A0' : '#F59E0B',
              border: `1px solid ${kpis.submission_rate === 100 ? '#00E5A033' : '#F59E0B33'}`,
            }}>
              {kpis.submission_rate}% submitted
            </span>
          )}
          {kpis.target_attainment !== null && kpis.target_attainment !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
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

      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Section headers + rows */}
          {urgent.length > 0 && (
            <>
              <div style={{ padding: '6px 16px', background: '#FF4D4D0A', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#FF4D4D', letterSpacing: '0.1em' }}>
                  🚨 ACTION REQUIRED
                </span>
              </div>
              {urgent.map((ins, i) => (
                <InsightRow key={`u${i}`} ins={ins} i={i} total={urgent.length} />
              ))}
            </>
          )}

          {watchlist.length > 0 && (
            <>
              <div style={{ padding: '6px 16px', background: '#F59E0B0A', borderBottom: `1px solid ${C.border}`, borderTop: urgent.length > 0 ? `1px solid ${C.border}` : 'none' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#F59E0B', letterSpacing: '0.1em' }}>
                  ⚠️ WATCHLIST
                </span>
              </div>
              {watchlist.map((ins, i) => (
                <InsightRow key={`w${i}`} ins={ins} i={i} total={watchlist.length} />
              ))}
            </>
          )}

          {positive.length > 0 && (
            <>
              <div style={{ padding: '6px 16px', background: '#00E5A00A', borderBottom: `1px solid ${C.border}`, borderTop: (urgent.length > 0 || watchlist.length > 0) ? `1px solid ${C.border}` : 'none' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#00E5A0', letterSpacing: '0.1em' }}>
                  ✅ PERFORMING WELL
                </span>
              </div>
              {positive.map((ins, i) => (
                <InsightRow key={`p${i}`} ins={ins} i={i} total={positive.length} />
              ))}
            </>
          )}

          {context.length > 0 && (
            <>
              <div style={{ padding: '6px 16px', background: '#5B8DEF0A', borderBottom: `1px solid ${C.border}`, borderTop: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#5B8DEF', letterSpacing: '0.1em' }}>
                  📊 CONTEXT
                </span>
              </div>
              {context.map((ins, i) => (
                <InsightRow key={`c${i}`} ins={ins} i={i} total={context.length} />
              ))}
            </>
          )}

          {/* Footer note */}
          <div style={{ padding: '8px 16px', borderTop: `1px solid ${C.border}`, background: C.elevated, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.muted }}>
              Based on {data?.submission?.total || 0} team members · auto-refreshes every 60s
            </span>
            {data?.freshness?.last_report_at && (
              <span style={{ fontSize: 10, color: C.muted }}>
                Last report: {timeAgo(data.freshness.last_report_at)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
