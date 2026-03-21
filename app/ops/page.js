'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import AttendanceGrid from './components/AttendanceGrid';
import { useTheme } from '../context/ThemeContext';
import AINarrative from '../components/AINarrative';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line } from 'recharts';

const METRIC_LABELS = {
  providers_mapped: 'Providers Mapped',
  care_items_mapped: 'Care Items Mapped',
  care_items_grouped: 'Care Items Grouped',
  resolved_cares: 'Resolved Cares',
  claims_kenya: 'Kenya',
  claims_tanzania: 'Tanzania',
  claims_uganda: 'Uganda',
  claims_uap: 'UAP Old Mutual',
  claims_defmis: 'Defmis',
  claims_hadiel: 'Hadiel Tech',
  claims_axa: 'AXA',
  auto_pa_reviewed: 'Auto PA Reviewed',
  flagged_care_items: 'Flagged Care Items',
  icd10_adjusted: 'ICD10 Adjusted',
  benefits_set_up: 'Benefits Set Up',
  providers_assigned: 'Providers Assigned',
};

const KEY_METRICS = [
  { key: 'care_items_mapped', label: 'Care Items Mapped', color: '#00E5A0' },
  { key: 'resolved_cares', label: 'Resolved Cares', color: '#5B8DEF' },
  { key: 'providers_mapped', label: 'Providers Mapped', color: '#A78BFA' },
  { key: 'care_items_grouped', label: 'Care Items Grouped', color: '#F59E0B' },
];

const CLAIMS_INSURERS = [
  { key: 'claims_kenya', label: 'Kenya' },
  { key: 'claims_tanzania', label: 'Tanzania' },
  { key: 'claims_uganda', label: 'Uganda' },
  { key: 'claims_uap', label: 'UAP Old Mutual' },
  { key: 'claims_defmis', label: 'Defmis' },
  { key: 'claims_hadiel', label: 'Hadiel Tech' },
  { key: 'claims_axa', label: 'AXA' },
];

const toLocalYMD = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const parseYMD = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};

const localDate = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return toLocalYMD(d);
};

const getToday = () => localDate(0);
const getYesterday = () => localDate(-1);

const weekStart = () => {
  const d = parseYMD(getToday());
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return toLocalYMD(mon);
};

const fmt = (d) =>
  parseYMD(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const pctChange = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const numFmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toString());

const QUICK_RANGES = [
  { label: 'Today', from: () => getToday(), to: () => getToday() },
  { label: 'This week', from: () => weekStart(), to: () => getToday() },
  {
    label: 'Last 14d',
    from: () => {
      return localDate(-13);
    },
    to: () => getToday(),
  },
  {
    label: 'This month',
    from: () => {
      const now = new Date();
      return toLocalYMD(new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0));
    },
    to: () => getToday(),
  },
];

function TrendChip({ value, inverted = false }) {
  if (value === null || value === undefined) return null;
  const positive = inverted ? value < 0 : value > 0;
  const neutral = value === 0;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 20,
        background: neutral ? '#3A4A5E22' : positive ? '#00E5A022' : '#FF4D4D22',
        color: neutral ? '#6B7A99' : positive ? '#00E5A0' : '#FF4D4D',
        display: 'inline-block',
        marginLeft: 6,
      }}
    >
      {neutral ? '—' : value > 0 ? `▲ ${value}%` : `▼ ${Math.abs(value)}%`}
    </span>
  );
}

function StatCard({ label, value, trend, trendLabel, color, sub, onClick, C }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 18,
        flex: 1,
        minWidth: 160,
        position: 'relative',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.borderColor = color || '#00E5A0';
      }}
      onMouseLeave={(e) => {
        if (onClick) e.currentTarget.style.borderColor = C.border;
      }}
    >
      <div style={{ fontSize: 12, color: '#6B7A99', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || '#00E5A0', lineHeight: 1 }}>
        {value}
      </div>
      {(trend !== undefined || sub) && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
          {sub && <span style={{ fontSize: 11, color: '#6B7A99' }}>{sub}</span>}
          {trend !== undefined && <TrendChip value={trend} />}
          {trendLabel && <span style={{ fontSize: 10, color: '#3A4A5E', marginLeft: 2 }}>{trendLabel}</span>}
        </div>
      )}
    </div>
  );
}

function MemberRow({ member, memberMap, avgMetrics, onDrilldown, C }) {
  const name = memberMap[String(member.id)]?.display_name || memberMap[String(member.id)]?.name || member.name;
  const totals = member.totals || {};
  const totalOutput = Object.values(totals).reduce((a, b) => a + b, 0);

  return (
    <tr
      style={{ cursor: 'pointer' }}
      onClick={() => onDrilldown(member)}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#1A2A3F')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#E8EEF7', whiteSpace: 'nowrap' }}>
        {name}
      </td>
      {KEY_METRICS.map((m) => {
        const val = totals[m.key] || 0;
        const avg = avgMetrics[m.key] || 0;
        const diff = avg > 0 ? Math.round(((val - avg) / avg) * 100) : null;
        return (
          <td key={m.key} style={{ padding: '10px 14px', fontSize: 13, textAlign: 'right' }}>
            <span style={{ color: '#E8EEF7' }}>{val.toLocaleString()}</span>
            {diff !== null && (
              <span
                style={{
                  fontSize: 10,
                  marginLeft: 5,
                  color: diff >= 0 ? '#00E5A0' : '#FF4D4D',
                }}
              >
                {diff >= 0 ? `+${diff}%` : `${diff}%`}
              </span>
            )}
          </td>
        );
      })}
      <td style={{ padding: '10px 14px', fontSize: 13, textAlign: 'right', fontWeight: 700, color: '#00E5A0' }}>
        {totalOutput.toLocaleString()}
      </td>
      <td style={{ padding: '10px 14px', textAlign: 'center' }}>
        <span style={{ fontSize: 11, color: '#6B7A99' }}>{member.days_reported}d</span>
      </td>
    </tr>
  );
}

function DrilldownModal({ member, memberMap, from, to, onClose, C }) {
  const name =
    memberMap[String(member.person?.id)]?.display_name ||
    memberMap[String(member.person?.id)]?.name ||
    member.person?.name ||
    'Unknown';
  const totals = member.totals || {};
  const daily = member.daily || [];

  const chartData = daily
    .map((d) => ({
      date: d.date?.slice(5),
      total: Object.values(d.metrics || {}).reduce((a, b) => a + (parseInt(b) || 0), 0),
    }))
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .slice(-7);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          padding: 28,
          width: '100%',
          maxWidth: 600,
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: C.text }}>{name}</div>
            <div style={{ fontSize: 12, color: C.sub }}>
              {fmt(from)} — {fmt(to)} · {member.days_reported} day{member.days_reported !== 1 ? 's' : ''} reported
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.sub, fontSize: 22, cursor: 'pointer' }}>
            ✕
          </button>
        </div>

        {chartData.length > 1 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>Daily output trend</div>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={chartData}>
                <XAxis dataKey="date" tick={{ fill: '#6B7A99', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip contentStyle={{ background: '#111E2E', border: '1px solid #1E2D45', borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="total" stroke="#00E5A0" strokeWidth={2} dot={{ fill: '#00E5A0', r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {Object.entries(totals)
            .filter(([, v]) => parseInt(v) > 0)
            .sort(([, a], [, b]) => b - a)
            .map(([k, v]) => (
              <div
                key={k}
                style={{
                  background: C.elevated,
                  borderRadius: 8,
                  padding: '10px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ fontSize: 12, color: C.sub }}>{METRIC_LABELS[k] || k}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{parseInt(v).toLocaleString()}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export default function OpsPage() {
  const { C } = useTheme();
  const TODAY = getToday();
  const YESTERDAY = getYesterday();

  const [rangeIdx, setRangeIdx] = useState(0);
  const [opsData, setOpsData] = useState(null);
  const [yData, setYData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState([]);
  const [drilldown, setDrilldown] = useState(null);
  const [opsTab, setOpsTab] = useState('overview');
  const [insightData, setInsightData] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const memberMap = useMemo(() => {
    const m = {};
    teamMembers.forEach((t) => {
      m[String(t.id)] = t;
    });
    return m;
  }, [teamMembers]);

  const range = QUICK_RANGES[rangeIdx];

  const loadData = useCallback(() => {
    const from = range.from();
    const to = range.to();
    setLoading(true);

    Promise.all([
      fetch(`/api/reports/weekly?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.json()),
      fetch(`/api/reports/weekly?from=${encodeURIComponent(YESTERDAY)}&to=${encodeURIComponent(YESTERDAY)}`).then((r) => r.json()),
      fetch('/api/team').then((r) => r.json()),
      fetch('/api/insights').then((r) => r.json()),
    ])
      .then(([main, yest, team, ins]) => {
        setOpsData(main);
        setYData(yest);
        setTeamMembers(team.data || []);
        setInsightData(ins);
        setLastRefresh(new Date());
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [rangeIdx, YESTERDAY, range]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const t = setInterval(loadData, 90_000);
    return () => clearInterval(t);
  }, [loadData]);

  const members = opsData?.by_person || [];
  const teamTotals = opsData?.team_totals || {};
  const yTotals = yData?.team_totals || {};

  const avgMetrics = useMemo(() => {
    if (!members.length) return {};
    const avg = {};
    for (const m of KEY_METRICS) {
      const sum = members.reduce((a, p) => a + (p.totals?.[m.key] || 0), 0);
      avg[m.key] = Math.round(sum / members.length);
    }
    return avg;
  }, [members]);

  const claimsChartData = CLAIMS_INSURERS
    .map((c) => ({ name: c.label, value: teamTotals[c.key] || 0 }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);

  const S = {
    section: { marginBottom: 24 },
    card: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' },
    th: {
      padding: '10px 14px',
      fontSize: 11,
      fontWeight: 700,
      color: '#00E5A0',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      borderBottom: `1px solid ${C.border}`,
      background: C.elevated,
      textAlign: 'right',
    },
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      <div
        style={{
          background: C.card,
          borderBottom: `1px solid ${C.border}`,
          padding: '20px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: C.text }}>Ops Overview</h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: C.sub }}>Team performance intelligence</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastRefresh && (
            <span style={{ fontSize: 11, color: C.muted }}>
              🟢 Live · refreshed {lastRefresh.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={loadData}
            style={{
              padding: '6px 14px',
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              color: C.sub,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      <div style={{ padding: '20px 24px' }}>
        <AINarrative />

        {/* Tab selector */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 20, background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, padding: 3, width: 'fit-content' }}>
          {[['overview','📊 Overview'],['attendance','📅 Attendance']].map(([key, label]) => (
            <button key={key} onClick={() => setOpsTab(key)} style={{
              padding: '7px 18px', borderRadius: 6, fontSize: 12,
              fontWeight: opsTab === key ? 700 : 400, cursor: 'pointer', border: 'none',
              background: opsTab === key ? C.accent : 'transparent',
              color: opsTab === key ? '#0B0F1A' : C.sub,
            }}>{label}</button>
          ))}
        </div>

        {opsTab === 'attendance' && (
          <AttendanceGrid teamMembers={teamMembers} C={C} />
        )}

        {opsTab === 'overview' && (
          <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {QUICK_RANGES.map((r, i) => (
            <button
              key={i}
              onClick={() => setRangeIdx(i)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: i === rangeIdx ? 700 : 400,
                background: i === rangeIdx ? '#00E5A022' : C.elevated,
                color: i === rangeIdx ? '#00E5A0' : C.sub,
                border: `1px solid ${i === rangeIdx ? '#00E5A044' : C.border}`,
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 80, color: C.sub, fontSize: 14 }}>Loading intelligence data…</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
              {KEY_METRICS.map((m) => {
                const val = teamTotals[m.key] || 0;
                const yVal = yTotals[m.key] || 0;
                const trend = rangeIdx === 0 ? pctChange(val, yVal) : null;
                return (
                  <StatCard
                    key={m.key}
                    label={m.label}
                    value={numFmt(val)}
                    trend={trend}
                    trendLabel={trend !== null ? 'vs yesterday' : undefined}
                    color={m.color}
                    sub={rangeIdx === 0 ? `Yesterday: ${numFmt(yVal)}` : undefined}
                    C={C}
                  />
                );
              })}

              {insightData?.kpis && (
                <StatCard
                  label="Submission Rate"
                  value={`${insightData.kpis.submission_rate}%`}
                  sub={`${insightData.submission?.submitted} / ${insightData.kpis.active_members} active`}
                  color={insightData.kpis.submission_rate === 100 ? '#00E5A0' : '#F59E0B'}
                  C={C}
                />
              )}

              {insightData?.kpis?.target_attainment !== null &&
                insightData?.kpis?.target_attainment !== undefined && (
                  <StatCard
                    label="Target Attainment"
                    value={`${insightData.kpis.target_attainment}%`}
                    sub={`${insightData.kpis.targets_hit} of ${insightData.kpis.targets_total} targets`}
                    color={
                      insightData.kpis.target_attainment >= 80
                        ? '#00E5A0'
                        : insightData.kpis.target_attainment >= 50
                        ? '#5B8DEF'
                        : '#FF4D4D'
                    }
                    C={C}
                  />
                )}
            </div>

            {rangeIdx === 0 && insightData?.today_vs_yesterday?.length > 0 && (
              <div style={S.section}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Today vs Yesterday
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {insightData.today_vs_yesterday
                    .filter((m) => m.today > 0 || m.yesterday > 0)
                    .map((m) => (
                      <div key={m.key} style={{ ...S.card, padding: '12px 16px', minWidth: 160 }}>
                        <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>{m.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{m.today.toLocaleString()}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <span style={{ fontSize: 11, color: C.muted }}>{m.yesterday.toLocaleString()} yest.</span>
                          <TrendChip value={m.pct_change} inverted={m.key === 'flagged_care_items'} />
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {members.length > 0 && (
              <div style={S.section}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Member Breakdown — click row to drill down
                </div>
                <div style={S.card}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th style={{ ...S.th, textAlign: 'left' }}>Member</th>
                          {KEY_METRICS.map((m) => (
                            <th key={m.key} style={S.th}>
                              {m.label.replace(' Items', '').replace(' Cares', '').replace(' Mapped', '')}
                            </th>
                          ))}
                          <th style={S.th}>Total</th>
                          <th style={{ ...S.th, textAlign: 'center' }}>Days</th>
                        </tr>
                        <tr style={{ background: '#0B1929' }}>
                          <td style={{ padding: '6px 14px', fontSize: 11, color: C.muted, fontStyle: 'italic' }}>Team avg</td>
                          {KEY_METRICS.map((m) => (
                            <td key={m.key} style={{ padding: '6px 14px', fontSize: 11, color: C.muted, textAlign: 'right' }}>
                              {(avgMetrics[m.key] || 0).toLocaleString()}
                            </td>
                          ))}
                          <td colSpan={2} />
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((p) => (
                          <MemberRow
                            key={p.person?.id || p.person?.name}
                            member={{ ...p, id: p.person?.id, name: p.person?.name, totals: p.totals, days_reported: p.days_reported }}
                            memberMap={memberMap}
                            avgMetrics={avgMetrics}
                            onDrilldown={() => setDrilldown(p)}
                            C={C}
                          />
                        ))}
                        <tr style={{ borderTop: `2px solid ${C.border}`, background: C.elevated }}>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#00E5A0' }}>Team Total</td>
                          {KEY_METRICS.map((m) => (
                            <td key={m.key} style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: '#00E5A0', textAlign: 'right' }}>
                              {(teamTotals[m.key] || 0).toLocaleString()}
                            </td>
                          ))}
                          <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: '#00E5A0', textAlign: 'right' }}>
                            {Object.values(teamTotals).reduce((a, b) => a + b, 0).toLocaleString()}
                          </td>
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {claimsChartData.length > 0 && (
              <div style={S.section}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Claims Piles by Insurer
                </div>
                <div style={{ ...S.card, padding: '16px 0 8px' }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={claimsChartData} margin={{ top: 0, right: 24, bottom: 0, left: 0 }}>
                      <XAxis dataKey="name" tick={{ fill: '#6B7A99', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis hide />
                      <Tooltip contentStyle={{ background: '#111E2E', border: '1px solid #1E2D45', borderRadius: 8, fontSize: 12 }} formatter={(v) => v.toLocaleString()} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {claimsChartData.map((_, i) => (
                          <Cell key={i} fill={['#00E5A0', '#5B8DEF', '#A78BFA', '#F59E0B', '#FF4D4D', '#22D3EE', '#F97316'][i % 7]} fillOpacity={1} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {insightData?.week_vs_lastweek?.length > 0 && rangeIdx === 1 && (
              <div style={S.section}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  This Week vs Last Week
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {insightData.week_vs_lastweek
                    .filter((m) => m.this_week > 0 || m.last_week > 0)
                    .map((m) => (
                      <div key={m.key} style={{ ...S.card, padding: '12px 16px', minWidth: 160 }}>
                        <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>{m.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{m.this_week.toLocaleString()}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          <span style={{ fontSize: 11, color: C.muted }}>{m.last_week.toLocaleString()} last wk</span>
                          <TrendChip value={m.pct_change} inverted={m.key === 'flagged_care_items'} />
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {members.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports found for this period.</div>
            )}
          </>
        )}
          </div>
        )}

      </div>

      {drilldown && (
        <DrilldownModal
          member={drilldown}
          memberMap={memberMap}
          from={range.from()}
          to={range.to()}
          onClose={() => setDrilldown(null)}
          C={C}
        />
      )}
    </div>
  );
}
