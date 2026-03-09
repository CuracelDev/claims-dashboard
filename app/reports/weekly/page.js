'use client';
import { useState, useEffect } from 'react';
import { useTheme } from '../../context/ThemeContext';

const METRIC_LABELS = {
  providers_mapped: 'Providers Mapped', care_items_mapped: 'Care Items Mapped',
  care_items_grouped: 'Care Items Grouped', resolved_cares: 'Resolved Cares',
  claims_kenya: 'Kenya', claims_tanzania: 'Tanzania', claims_uganda: 'Uganda',
  claims_uap: 'UAP Old Mutual', claims_defmis: 'Defmis', claims_hadiel: 'Hadiel Tech', claims_axa: 'AXA',
  auto_pa_reviewed: 'Auto PA Reviewed', flagged_care_items: 'Flagged Care Items',
  icd10_adjusted: 'ICD10 Adjusted', benefits_set_up: 'Benefits Set Up',
  providers_assigned: 'Providers Assigned',
};

const METRIC_GROUPS = {
  'Claims Piles': ['claims_kenya','claims_tanzania','claims_uganda','claims_uap','claims_defmis','claims_hadiel','claims_axa'],
  'Mapping & Data': ['providers_mapped','care_items_mapped','care_items_grouped','resolved_cares'],
  'Quality & Review': ['auto_pa_reviewed','flagged_care_items','icd10_adjusted','benefits_set_up','providers_assigned'],
};

const MEDALS = ['🥇','🥈','🥉'];

function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon.toISOString().split('T')[0], sun.toISOString().split('T')[0]];
}

const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
const fmtFull = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });

function exportCSV(data, from, to) {
  if (!data?.by_person?.length) return;
  const allKeys = [...new Set(data.by_person.flatMap(p => Object.keys(p.totals)))];
  const headers = ['Name', 'Role', 'Days Reported', 'Total Output', ...allKeys.map(k => METRIC_LABELS[k] || k)];
  const rows = data.by_person.map(p => [
    p.person?.name || '', p.person?.role || '', p.days_reported, p.total_output,
    ...allKeys.map(k => p.totals[k] || 0),
  ]);
  rows.push(['TEAM TOTAL', '', data.by_person.reduce((a,p) => a + p.days_reported, 0),
    data.by_person.reduce((a,p) => a + p.total_output, 0),
    ...allKeys.map(k => data.team_totals[k] || 0)]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `weekly-summary-${from}-${to}.csv`; a.click();
  URL.revokeObjectURL(url);
}

export default function WeeklyPage() {
  const { C } = useTheme();
  const today = new Date().toISOString().split('T')[0];

  // View mode: 'week' | 'custom'
  const [mode, setMode] = useState('week');
  const [selectedDate, setSelectedDate] = useState(today);
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  });
  const [customTo, setCustomTo] = useState(today);
  const [activeFrom, setActiveFrom] = useState('');
  const [activeTo, setActiveTo]   = useState('');

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);

  // Compute the active range
  const weekRange = getWeekRange(selectedDate);
  const from = mode === 'week' ? weekRange[0] : activeFrom || customFrom;
  const to   = mode === 'week' ? weekRange[1] : activeTo   || customTo;

  // Fetch when from/to change
  useEffect(() => {
    if (!from || !to) return;
    setLoading(true); setError(null);
    fetch(`/api/reports/weekly?from=${from}&to=${to}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  // Sync week mode immediately when date changes
  useEffect(() => {
    if (mode === 'week') { /* useEffect above handles it via from/to */ }
  }, [selectedDate, mode]);

  const applyCustom = () => {
    setActiveFrom(customFrom);
    setActiveTo(customTo);
  };

  // Styles derived from theme
  const cardStyle = {
    background: C.card, border: `1px solid ${C.border}`,
    borderRadius: 12, padding: 20, marginBottom: 16,
  };
  const inputStyle = {
    background: C.inputBg, border: `1px solid ${C.border}`,
    borderRadius: 8, color: C.text, padding: '8px 12px',
    fontSize: 13, outline: 'none',
  };

  // Days in range for grid header (week mode: Mon-Fri, custom mode: show days)
  const getDaysInRange = () => {
    if (mode === 'week') {
      const days = [];
      const start = new Date(from + 'T12:00:00');
      for (let i = 0; i < 7; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        days.push(d.toISOString().split('T')[0]);
      }
      return days.filter(d => {
        const day = new Date(d + 'T12:00:00').getDay();
        return day !== 0 && day !== 6;
      });
    }
    // Custom: show up to 14 days, or aggregate if longer
    const start = new Date(from + 'T12:00:00');
    const end = new Date(to + 'T12:00:00');
    const diff = Math.round((end - start) / 86400000);
    if (diff <= 14) {
      const days = [];
      for (let i = 0; i <= diff; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) days.push(d.toISOString().split('T')[0]);
      }
      return days;
    }
    return null; // null = show aggregated view, not daily grid
  };

  const days = getDaysInRange();
  const showGrid = !!days;

  const getDayReport = (personId, dayStr) => {
    if (!data?.daily_breakdown) return null;
    return data.daily_breakdown?.find(r =>
      String(r.team_member_id) === String(personId) && r.report_date === dayStr
    ) || null;
  };

  const getScore = (report) => {
    if (!report) return null;
    return Object.values(report.metrics || {}).filter(v => parseInt(v) > 0).length;
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60, transition: 'background 0.2s' }}>
      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.text }}>Weekly Summary</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.sub }}>Team performance aggregated by period</p>
      </div>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 32px' }}>

        {/* ── Controls ── */}
        <div style={{ ...cardStyle, marginBottom: 20 }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {[['week','📅 Weekly'], ['custom','📊 Custom Range']].map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                border: `1px solid ${mode === m ? C.accent : C.border}`,
                background: mode === m ? `${C.accent}18` : 'transparent',
                color: mode === m ? C.accent : C.sub, cursor: 'pointer',
              }}>{label}</button>
            ))}
          </div>

          {mode === 'week' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: C.sub }}>Pick any day in the week:</span>
              <input type="date" value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)} style={inputStyle} />
              <span style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>
                {fmt(from)} – {fmt(to)}
              </span>
              <button onClick={() => exportCSV(data, from, to)} disabled={!data?.by_person?.length}
                style={{
                  padding: '7px 16px', background: !data?.by_person?.length ? C.elevated : `${C.accent}18`,
                  color: !data?.by_person?.length ? C.muted : C.accent,
                  border: `1px solid ${!data?.by_person?.length ? C.border : C.accent}40`,
                  borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: !data?.by_person?.length ? 'not-allowed' : 'pointer',
                  marginLeft: 'auto',
                }}>
                ⬇ CSV
              </button>
            </div>
          )}

          {mode === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: C.sub }}>From</span>
                <input type="date" value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: C.sub }}>To</span>
                <input type="date" value={customTo}
                  onChange={e => setCustomTo(e.target.value)} style={inputStyle} />
              </div>
              <button onClick={applyCustom} style={{
                padding: '8px 20px', background: C.accent, color: '#0B0F1A',
                border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}>Apply</button>
              {activeFrom && (
                <span style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>
                  {fmt(activeFrom)} – {fmt(activeTo)}
                </span>
              )}
              <button onClick={() => exportCSV(data, from, to)} disabled={!data?.by_person?.length}
                style={{
                  padding: '7px 16px', background: !data?.by_person?.length ? C.elevated : `${C.accent}18`,
                  color: !data?.by_person?.length ? C.muted : C.accent,
                  border: `1px solid ${!data?.by_person?.length ? C.border : C.accent}40`,
                  borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: !data?.by_person?.length ? 'not-allowed' : 'pointer',
                  marginLeft: 'auto',
                }}>
                ⬇ CSV
              </button>
            </div>
          )}
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>}
        {error && <div style={{ textAlign: 'center', padding: 40, color: C.danger }}>{error}</div>}

        {data && !loading && data.total_reports > 0 && (
          <>
            {/* ── Team Hero Banner ── */}
            <div style={{
              background: `linear-gradient(135deg, ${C.accentDim}, ${C.accent})`,
              borderRadius: 12, padding: 24, marginBottom: 16,
            }}>
              <div style={{ fontWeight: 700, fontSize: 18, color: '#0B0F1A', marginBottom: 3 }}>
                Team Total — {fmt(from)} – {fmt(to)}
              </div>
              <div style={{ fontSize: 12, color: '#0B0F1A99', marginBottom: 14 }}>
                {data.total_reports} reports · {data.by_person?.length} members
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {Object.entries(data.team_totals || {}).filter(([,v]) => v > 0).map(([key, val]) => (
                  <div key={key} style={{ background: '#00000022', borderRadius: 8, padding: '8px 14px' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#0B0F1A' }}>{val.toLocaleString()}</div>
                    <div style={{ fontSize: 11, color: '#0B0F1A99' }}>{METRIC_LABELS[key] || key}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Week At A Glance Grid (only in week or short custom range) ── */}
            {showGrid && data.daily_breakdown && (
              <div style={{ ...cardStyle, overflowX: 'auto' }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3, color: C.text }}>
                  📅 {mode === 'week' ? 'Week at a Glance' : 'Daily Breakdown'}
                  <span style={{ fontSize: 11, color: C.sub, marginLeft: 8, fontWeight: 400 }}>
                    {fmt(from)} – {fmt(to)} · Click a row to expand
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 14 }}>
                  🟢 ≥5 fields · 🔴 &lt;5 · — not submitted
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 12, color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>
                        Member
                      </th>
                      {days.map(d => {
                        const isToday = d === today;
                        return (
                          <th key={d} style={{
                            textAlign: 'center', padding: '8px 10px', fontSize: 11,
                            color: isToday ? C.accent : C.sub, fontWeight: isToday ? 700 : 500,
                            borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
                          }}>
                            {fmtFull(d)}
                            {isToday && <div style={{ fontSize: 9, color: C.accent }}>TODAY</div>}
                          </th>
                        );
                      })}
                      <th style={{ textAlign: 'center', padding: '8px 12px', fontSize: 12, color: C.accent, fontWeight: 700, borderBottom: `1px solid ${C.border}` }}>Total</th>
                      <th style={{ textAlign: 'center', padding: '8px 12px', fontSize: 12, color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>Tasks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.by_person || []).map((person, pi) => {
                      const isExpanded = expandedRow === person.person?.id;
                      return (
                        <>
                          <tr key={person.person?.id}
                            onClick={() => setExpandedRow(isExpanded ? null : person.person?.id)}
                            style={{ cursor: 'pointer', background: isExpanded ? `${C.accent}08` : 'transparent', transition: 'background 0.15s' }}>
                            <td style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, color: C.text }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 14 }}>{MEDALS[pi] || '👤'}</span>
                                <div>
                                  <div style={{ fontSize: 13, fontWeight: 600 }}>{person.person?.name}</div>
                                  <div style={{ fontSize: 10, color: C.muted }}>{person.days_reported}d submitted</div>
                                </div>
                              </div>
                            </td>
                            {days.map(d => {
                              const report = getDayReport(person.person?.id, d);
                              const leave = data.leave_days?.find(l =>
                                String(l.team_member_id) === String(person.person?.id) &&
                                d >= l.start_date && d <= l.end_date
                              );
                              const score = report ? getScore(report) : null;
                              return (
                                <td key={d} style={{ textAlign: 'center', padding: '10px 8px', borderBottom: `1px solid ${C.border}` }}>
                                  {leave ? (
                                    <span style={{ fontSize: 11, color: C.warn }}>Off</span>
                                  ) : score === null ? (
                                    <span style={{ color: C.muted, fontSize: 16 }}>—</span>
                                  ) : (
                                    <span style={{
                                      display: 'inline-block', minWidth: 28, padding: '3px 7px',
                                      borderRadius: 6, fontSize: 12, fontWeight: 700,
                                      background: score >= 5 ? '#34D39920' : '#FF5C5C20',
                                      color: score >= 5 ? C.success : C.danger,
                                    }}>{score}</span>
                                  )}
                                </td>
                              );
                            })}
                            <td style={{ textAlign: 'center', padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
                              <span style={{ fontSize: 16, fontWeight: 700, color: C.accent }}>
                                {person.total_output.toLocaleString()}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center', padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
                              {person.tasks_done > 0 ? (
                                <span style={{ fontSize: 11, background: `${C.blue}20`, color: C.blue, padding: '2px 8px', borderRadius: 10 }}>
                                  ✓{person.tasks_done}
                                </span>
                              ) : <span style={{ color: C.muted }}>—</span>}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${person.person?.id}-exp`}>
                              <td colSpan={days.length + 3} style={{ padding: '0 12px 16px', background: `${C.accent}06` }}>
                                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '12px 0' }}>
                                  {Object.entries(METRIC_GROUPS).map(([groupName, keys]) => {
                                    const groupTotal = keys.reduce((s, k) => s + (person.totals[k] || 0), 0);
                                    if (!groupTotal) return null;
                                    return (
                                      <div key={groupName} style={{
                                        background: C.card, border: `1px solid ${C.border}`,
                                        borderRadius: 8, padding: '10px 14px', minWidth: 160,
                                      }}>
                                        <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, fontWeight: 600 }}>{groupName}</div>
                                        {keys.filter(k => person.totals[k] > 0).map(k => (
                                          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                                            <span style={{ color: C.sub }}>{METRIC_LABELS[k]}</span>
                                            <span style={{ color: C.text, fontWeight: 600, marginLeft: 12 }}>{person.totals[k]}</span>
                                          </div>
                                        ))}
                                      </div>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                    {/* Team total row */}
                    <tr style={{ background: `${C.accent}10` }}>
                      <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 700, color: C.accent }}>TEAM TOTAL</td>
                      {days.map(d => {
                        const dayReports = (data.daily_breakdown || []).filter(r => r.report_date === d);
                        const dayTotal = dayReports.reduce((s, r) =>
                          s + Object.values(r.metrics || {}).reduce((a, b) => a + (parseInt(b) || 0), 0), 0);
                        return (
                          <td key={d} style={{ textAlign: 'center', padding: '10px 8px' }}>
                            {dayTotal > 0 ? (
                              <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>{dayTotal}</span>
                            ) : <span style={{ color: C.muted }}>—</span>}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: 'center', padding: '10px 12px' }}>
                        <span style={{ fontSize: 16, fontWeight: 700, color: C.accent }}>
                          {data.by_person?.reduce((s, p) => s + p.total_output, 0).toLocaleString()}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center', padding: '10px 12px', fontSize: 11, color: C.sub }}>
                        {data.by_person?.reduce((s,p) => s + (p.tasks_done||0), 0) > 0
                          ? `${data.by_person.reduce((s,p) => s + (p.tasks_done||0), 0)} done` : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* Aggregated leaderboard for longer ranges */}
            {!showGrid && (
              <div style={cardStyle}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3, color: C.text }}>🏆 Team Leaderboard</div>
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 14 }}>
                  {fmt(from)} – {fmt(to)} · Ranked by total output
                </div>
                {(data.by_person || []).map((person, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 16,
                    padding: '14px 0', borderBottom: `1px solid ${C.border}`,
                  }}>
                    <span style={{ fontSize: 22, width: 32, textAlign: 'center' }}>{MEDALS[i] || `${i+1}`}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, color: C.text }}>{person.person?.name}</span>
                        <span style={{ fontSize: 11, color: C.muted }}>{person.person?.role}</span>
                        <span style={{ fontSize: 10, background: `${C.blue}22`, color: C.blue, padding: '2px 8px', borderRadius: 20 }}>
                          {person.days_reported}d
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {Object.entries(person.totals).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).slice(0,5).map(([key,val]) => (
                          <span key={key} style={{ fontSize: 10, background: C.elevated, color: C.sub, padding: '2px 7px', borderRadius: 5 }}>
                            {METRIC_LABELS[key] || key}: <strong style={{ color: C.text }}>{val}</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 26, fontWeight: 700, color: C.accent }}>{person.total_output.toLocaleString()}</div>
                      <div style={{ fontSize: 10, color: C.muted }}>total</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Team Metric Totals ── */}
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3, color: C.text }}>
                📊 Team Metric Totals · {fmt(from)} – {fmt(to)}
              </div>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 16 }}>
                Aggregated across all team members
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                {Object.entries(METRIC_GROUPS).map(([groupName, keys]) => {
                  const groupData = keys.filter(k => (data.team_totals?.[k] || 0) > 0);
                  if (!groupData.length) return null;
                  const colors = { 'Claims Piles': C.purple, 'Mapping & Data': C.blue, 'Quality & Review': C.accent };
                  return (
                    <div key={groupName} style={{
                      border: `1px solid ${C.border}`, borderTop: `3px solid ${colors[groupName]}`,
                      borderRadius: 10, padding: 16, background: C.elevated,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: colors[groupName], marginBottom: 10 }}>
                        {groupName}
                      </div>
                      {groupData.map(k => (
                        <div key={k} style={{
                          display: 'flex', justifyContent: 'space-between',
                          fontSize: 12, padding: '4px 0', borderBottom: `1px solid ${C.border}`,
                        }}>
                          <span style={{ color: C.sub }}>{METRIC_LABELS[k]}</span>
                          <span style={{ fontWeight: 700, color: C.text }}>
                            {(data.team_totals[k] || 0).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {data && data.total_reports === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>
            No reports for {fmt(from)} – {fmt(to)}.
          </div>
        )}
      </div>
    </div>
  );
}
