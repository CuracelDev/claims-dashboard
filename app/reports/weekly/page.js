'use client';
import { useState, useEffect } from 'react';

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  blue: "#5B8DEF", purple: "#A78BFA",
};

const METRIC_GROUPS = [
  { key: "claims_piles", label: "Claims Piles", color: C.purple, metrics: [
    { key: "claims_kenya", label: "Kenya" }, { key: "claims_tanzania", label: "Tanzania" },
    { key: "claims_uganda", label: "Uganda" }, { key: "claims_uap", label: "UAP Old Mutual" },
    { key: "claims_defmis", label: "Defmis" }, { key: "claims_hadiel", label: "Hadiel Tech" },
    { key: "claims_axa", label: "AXA" },
  ]},
  { key: "mapping_data", label: "Mapping & Data", color: C.blue, metrics: [
    { key: "providers_mapped", label: "Providers Mapped" }, { key: "care_items_mapped", label: "Care Items Mapped" },
    { key: "care_items_grouped", label: "Care Items Grouped" }, { key: "resolved_cares", label: "Resolved Cares" },
  ]},
  { key: "quality_review", label: "Quality & Review", color: C.accent, metrics: [
    { key: "auto_pa_reviewed", label: "Auto PA Reviewed" }, { key: "flagged_care_items", label: "Flagged Care Items" },
    { key: "icd10_adjusted", label: "ICD10 Adjusted" }, { key: "benefits_set_up", label: "Benefits Set Up" },
    { key: "providers_assigned", label: "Providers Assigned" },
  ]},
];

const ALL_KEYS = METRIC_GROUPS.flatMap(g => g.metrics.map(m => m.key));
const TOTAL_FIELDS = ALL_KEYS.length;

function scoreReport(report) {
  const m = report?.metrics || {};
  return ALL_KEYS.filter(k => m[k] && parseInt(m[k]) > 0).length;
}
const scoreColor = f => !f ? C.muted : f >= 5 ? C.success : C.danger;
const fmt = n => (n ?? 0).toLocaleString();

function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon.toISOString().split('T')[0], sun.toISOString().split('T')[0]];
}
const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });

export default function WeeklyPage() {
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [members, setMembers] = useState([]);
  const [reports, setReports] = useState([]);
  const [tasks, setTasks]     = useState([]);
  const [leave, setLeave]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedMember, setExpandedMember] = useState(null);

  const [from, to] = getWeekRange(selectedDate);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/team').then(r => r.json()),
      fetch(`/api/reports?from=${from}&to=${to}&limit=200`).then(r => r.json()),
      fetch('/api/tasks').then(r => r.json()),
      fetch(`/api/leave?from=${from}&to=${to}`).then(r => r.json()),
    ]).then(([mData, rData, tData, lData]) => {
      setMembers(mData.data || []);
      setReports(rData.reports || rData.data || []);
      setTasks(tData.tasks || []);
      setLeave(lData.leave || lData.data || []);
    }).catch(console.error).finally(() => setLoading(false));
  }, [from, to]);

  // Build weekdays Mon–Fri
  const weekDays = [];
  const monDate = new Date(from + 'T12:00:00');
  for (let i = 0; i < 5; i++) {
    const d = new Date(monDate); d.setDate(monDate.getDate() + i);
    weekDays.push(d.toISOString().split('T')[0]);
  }

  // Per-member data
  const memberData = members.map(m => {
    const myReports = reports.filter(r => r.team_member_id === m.id);
    const myLeave   = leave.filter(l => l.team_member_id === m.id);
    const myTasks   = tasks.filter(t => t.assigned_to === m.id);
    const doneTasks = myTasks.filter(t => t.status === 'done');
    const pendTasks = myTasks.filter(t => t.status !== 'done');

    const reportByDay = Object.fromEntries(myReports.map(r => [r.report_date || r.date, r]));
    const leaveByDay  = Object.fromEntries(myLeave.map(l => [l.start_date || l.date, l]));

    const totalFilled = myReports.reduce((s, r) => s + scoreReport(r), 0);
    const daysReported = myReports.length;
    const metricTotals = {};
    for (const k of ALL_KEYS) {
      const total = myReports.reduce((s, r) => s + (parseInt(r.metrics?.[k]) || 0), 0);
      if (total > 0) metricTotals[k] = total;
    }

    return { ...m, reportByDay, leaveByDay, totalFilled, daysReported, metricTotals, doneTasks, pendTasks };
  });

  // Team totals
  const teamTotals = {};
  for (const k of ALL_KEYS) {
    teamTotals[k] = memberData.reduce((s, m) => s + (m.metricTotals[k] || 0), 0);
  }
  const teamTotalFields = memberData.reduce((s, m) => s + m.totalFilled, 0);

  const inp = { background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '7px 12px', fontSize: 12, outline: 'none', colorScheme: 'dark' };

  function exportCSV() {
    const headers = ['Member', 'Days Reported', 'Total Fields', ...ALL_KEYS];
    const rows = memberData.map(m => [m.name, m.daysReported, m.totalFilled, ...ALL_KEYS.map(k => m.metricTotals[k] || 0)]);
    rows.push(['TEAM TOTAL', memberData.reduce((s,m) => s+m.daysReported,0), teamTotalFields, ...ALL_KEYS.map(k => teamTotals[k] || 0)]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = `weekly-${from}-${to}.csv`; a.click();
  }

  return (
    <div style={{ marginLeft: 240, background: C.bg, minHeight: '100vh', color: C.text, fontFamily: "'DM Sans',sans-serif" }}>
      <style>{`
        @keyframes slideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(.7);cursor:pointer}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
        .member-row:hover{background:#1A233299!important;cursor:pointer}
      `}</style>

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '14px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 50 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Weekly Summary</div>
          <div style={{ fontSize: 10, color: C.muted }}>Team performance aggregated by week</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} style={inp}/>
          <span style={{ fontSize: 12, color: C.accent, fontWeight: 600 }}>{fmtDate(from)} – {fmtDate(to)}</span>
          <button onClick={exportCSV} style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, color: C.accent, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>⬇ CSV</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 80 }}>
          <div style={{ color: C.sub, fontSize: 14 }}>Loading...</div>
        </div>
      ) : (
        <div style={{ padding: '20px 28px' }}>

          {/* ── WEEK AT A GLANCE GRID ─────────────────────────── */}
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
            Week at a Glance · {fmtDate(from)} – {fmtDate(to)}
          </div>

          {/* Day headers row */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16, animation: 'slideUp .4s ease both' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ background: C.elevated, padding: '10px 16px', textAlign: 'left', borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 600, minWidth: 130, position: 'sticky', left: 0 }}>Member</th>
                    {weekDays.map(d => {
                      const isToday = d === new Date().toISOString().split('T')[0];
                      return (
                        <th key={d} style={{ background: isToday ? `${C.accent}15` : C.elevated, padding: '10px 14px', textAlign: 'center', borderBottom: `1px solid ${C.border}`, color: isToday ? C.accent : C.sub, fontWeight: isToday ? 700 : 500, minWidth: 110, fontSize: 11 }}>
                          {new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          {isToday && <div style={{ fontSize: 9, color: C.accent }}>TODAY</div>}
                        </th>
                      );
                    })}
                    <th style={{ background: C.elevated, padding: '10px 14px', textAlign: 'center', borderBottom: `1px solid ${C.border}`, color: C.accent, fontWeight: 700, minWidth: 80 }}>Total</th>
                    <th style={{ background: C.elevated, padding: '10px 14px', textAlign: 'center', borderBottom: `1px solid ${C.border}`, color: C.warn, fontWeight: 600, minWidth: 90, fontSize: 11 }}>Tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {memberData.map((m, idx) => (
                    <>
                      <tr key={m.id} className="member-row" onClick={() => setExpandedMember(expandedMember === m.id ? null : m.id)}
                        style={{ background: idx % 2 ? `${C.elevated}55` : 'transparent', transition: 'background .15s' }}>
                        <td style={{ position: 'sticky', left: 0, background: idx % 2 ? C.elevated : C.card, padding: '12px 16px', fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{m.name}</span>
                            <span style={{ fontSize: 10, color: C.muted }}>{expandedMember === m.id ? '▲' : '▼'}</span>
                          </div>
                        </td>
                        {weekDays.map(d => {
                          const report = m.reportByDay[d];
                          const isLeave = m.leaveByDay[d];
                          const filled = report ? scoreReport(report) : null;
                          return (
                            <td key={d} style={{ padding: '12px 14px', textAlign: 'center', borderBottom: `1px solid ${C.border}` }}>
                              {isLeave ? (
                                <span style={{ fontSize: 10, color: C.warn, background: `${C.warn}22`, padding: '3px 8px', borderRadius: 4 }}>Off</span>
                              ) : filled !== null ? (
                                <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 14, color: scoreColor(filled), background: filled >= 5 ? `${C.success}22` : `${C.danger}22`, padding: '3px 10px', borderRadius: 6, display: 'inline-block' }}>{filled}</span>
                              ) : (
                                <span style={{ color: C.muted, fontSize: 13 }}>—</span>
                              )}
                            </td>
                          );
                        })}
                        <td style={{ padding: '12px 14px', textAlign: 'center', borderBottom: `1px solid ${C.border}`, fontFamily: 'monospace', fontWeight: 700, color: m.totalFilled > 0 ? C.accent : C.muted, fontSize: 14 }}>
                          {m.totalFilled}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'center', borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                            {m.doneTasks.length > 0 && <span style={{ fontSize: 10, background: `${C.success}22`, color: C.success, padding: '2px 7px', borderRadius: 4 }}>✓{m.doneTasks.length}</span>}
                            {m.pendTasks.length > 0 && <span style={{ fontSize: 10, background: `${C.warn}22`, color: C.warn, padding: '2px 7px', borderRadius: 4 }}>○{m.pendTasks.length}</span>}
                            {m.doneTasks.length === 0 && m.pendTasks.length === 0 && <span style={{ color: C.muted, fontSize: 11 }}>—</span>}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded metric breakdown */}
                      {expandedMember === m.id && (
                        <tr key={`${m.id}-expand`}>
                          <td colSpan={weekDays.length + 3} style={{ padding: 0, borderBottom: `1px solid ${C.border}` }}>
                            <div style={{ background: `${C.accent}08`, padding: '16px 20px' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                                {METRIC_GROUPS.map(g => (
                                  <div key={g.key}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: g.color, marginBottom: 8 }}>{g.label}</div>
                                    {g.metrics.map(mk => {
                                      const val = m.metricTotals[mk.key];
                                      if (!val) return null;
                                      return (
                                        <div key={mk.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', borderBottom: `1px solid ${C.border}` }}>
                                          <span style={{ color: C.sub }}>{mk.label}</span>
                                          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: g.color }}>{fmt(val)}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                              {/* Tasks list */}
                              {(m.doneTasks.length > 0 || m.pendTasks.length > 0) && (
                                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                  {m.doneTasks.length > 0 && (
                                    <div>
                                      <div style={{ fontSize: 11, fontWeight: 600, color: C.success, marginBottom: 6 }}>✓ Done this week</div>
                                      {m.doneTasks.map(t => <div key={t.id} style={{ fontSize: 11, color: C.sub, padding: '2px 0' }}>✓ {t.title}</div>)}
                                    </div>
                                  )}
                                  {m.pendTasks.length > 0 && (
                                    <div>
                                      <div style={{ fontSize: 11, fontWeight: 600, color: C.warn, marginBottom: 6 }}>○ Pending</div>
                                      {m.pendTasks.map(t => <div key={t.id} style={{ fontSize: 11, color: C.sub, padding: '2px 0' }}>{t.priority === 'high' ? '🔴' : '🟡'} {t.title}</div>)}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}

                  {/* Team total row */}
                  <tr style={{ background: `${C.accent}11` }}>
                    <td style={{ position: 'sticky', left: 0, background: `${C.accent}1A`, padding: '11px 16px', fontWeight: 700, color: C.accent, borderTop: `2px solid ${C.accent}44` }}>TEAM TOTAL</td>
                    {weekDays.map(d => {
                      const dayReports = reports.filter(r => (r.report_date || r.date) === d);
                      const dayTotal   = dayReports.reduce((s, r) => s + scoreReport(r), 0);
                      return (
                        <td key={d} style={{ padding: '11px 14px', textAlign: 'center', borderTop: `2px solid ${C.accent}44`, fontFamily: 'monospace', fontWeight: 700, color: dayTotal > 0 ? C.accent : C.muted }}>
                          {dayTotal || '—'}
                        </td>
                      );
                    })}
                    <td style={{ padding: '11px 14px', textAlign: 'center', borderTop: `2px solid ${C.accent}44`, fontFamily: 'monospace', fontWeight: 700, color: C.accent, fontSize: 14 }}>{teamTotalFields}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'center', borderTop: `2px solid ${C.accent}44`, color: C.muted, fontSize: 11 }}>
                      {tasks.filter(t => t.status === 'done').length} done
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* ── TEAM METRIC TOTALS ──────────────────────────────── */}
          {Object.values(teamTotals).some(v => v > 0) && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, animation: 'slideUp .4s ease .1s both' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>Team Metric Totals · {fmtDate(from)} – {fmtDate(to)}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
                {METRIC_GROUPS.map(g => (
                  <div key={g.key}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: g.color, marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${C.border}` }}>{g.label}</div>
                    {g.metrics.map(mk => {
                      const val = teamTotals[mk.key];
                      if (!val) return null;
                      return (
                        <div key={mk.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ color: C.sub }}>{mk.label}</span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: g.color }}>{fmt(val)}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          {reports.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: C.muted, fontSize: 14 }}>
              No reports for {fmtDate(from)} – {fmtDate(to)}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
