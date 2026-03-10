'use client';
import { useState, useEffect } from 'react';
import { useTheme } from '../../context/ThemeContext';

const METRIC_GROUPS = [
  {
    label: 'Claims Piles Checked', color: '#A78BFA',
    metrics: [
      { key: 'claims_kenya',    label: 'Kenya' },
      { key: 'claims_tanzania', label: 'Tanzania' },
      { key: 'claims_uganda',   label: 'Uganda' },
      { key: 'claims_uap',      label: 'UAP Old Mutual' },
      { key: 'claims_defmis',   label: 'Defmis' },
      { key: 'claims_hadiel',   label: 'Hadiel Tech' },
      { key: 'claims_axa',      label: 'AXA' },
    ],
  },
  {
    label: 'Mapping & Data', color: '#5B8DEF',
    metrics: [
      { key: 'providers_mapped',   label: 'Providers Mapped' },
      { key: 'care_items_mapped',  label: 'Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Care Items Grouped' },
      { key: 'resolved_cares',     label: 'Resolved Cares' },
    ],
  },
  {
    label: 'Quality & Review', color: '#00B87D',
    metrics: [
      { key: 'auto_pa_reviewed',   label: 'Auto PA Reviewed/Approved' },
      { key: 'flagged_care_items', label: 'Flagged Care Items' },
      { key: 'icd10_adjusted',     label: 'ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up',    label: 'Benefits Set Up' },
      { key: 'providers_assigned', label: 'Providers Assigned' },
    ],
  },
];

const ALL_METRICS = METRIC_GROUPS.flatMap(g => g.metrics);

// Targets live on their own dedicated page (🎯 Targets in sidebar) — not here



function getWeekBounds(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon.toISOString().split('T')[0], sun.toISOString().split('T')[0]];
}

function lastWeekBounds() {
  const d = new Date(); d.setDate(d.getDate() - 7);
  return getWeekBounds(d.toISOString().split('T')[0]);
}

const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const QUICK = [
  { label: 'This week',  fn: () => getWeekBounds(new Date().toISOString().split('T')[0]) },
  { label: 'Last week',  fn: () => lastWeekBounds() },
  { label: 'Last 30d',   fn: () => { const t = new Date(); const f = new Date(t); f.setDate(t.getDate()-29); return [f.toISOString().split('T')[0], t.toISOString().split('T')[0]]; } },
  { label: 'This month', fn: () => { const t = new Date(); return [new Date(t.getFullYear(),t.getMonth(),1).toISOString().split('T')[0], t.toISOString().split('T')[0]]; } },
];

export default function WeeklyPage() {
  const { C } = useTheme();
  const today = new Date().toISOString().split('T')[0];

  const [activeQ, setActiveQ]     = useState(1);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo]     = useState(today);
  const [from, setFrom] = useState('');
  const [to, setTo]     = useState('');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  useEffect(() => {
    const [f, t] = QUICK[1].fn();
    setFrom(f); setTo(t);
  }, []);

  useEffect(() => {
    if (!from || !to) return;
    setLoading(true); setError(null); setData(null);
    fetch(`/api/reports/weekly?from=${from}&to=${to}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  const applyQuick = (i) => {
    setActiveQ(i);
    const [f, t] = QUICK[i].fn();
    setFrom(f); setTo(t);
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    setActiveQ(-1);
    setFrom(customFrom); setTo(customTo);
  };

  const exportCSV = () => {
    if (!members.length) return;
    const headers = ['Group', 'Metric', ...members.map(p => p.person?.name), 'Team Total'];
    const rows = [];
    METRIC_GROUPS.forEach(g => {
      g.metrics.forEach(m => {
        const vals = members.map(p => p.totals[m.key] || 0);
        const total = vals.reduce((a, b) => a + b, 0);
        if (total === 0) return;
        rows.push([g.label, m.label, ...vals, total]);
      });
    });
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `report-${from}-${to}.csv`; a.click();
  };

  const members = data?.by_person || [];
  const teamTotals = data?.team_totals || {};

  const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12 };
  const inp  = { background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '7px 12px', fontSize: 13, outline: 'none' };
  const MEDALS = ['🥇','🥈','🥉'];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60, transition: 'background 0.2s' }}>

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Weekly Summary</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.sub }}>Team performance aggregated by period</p>
      </div>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 32px', boxSizing: 'border-box' }}>

        {/* Period controls */}
        <div style={{ ...card, padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {QUICK.map((q, i) => (
              <button key={q.label} onClick={() => applyQuick(i)} style={{
                padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                border: `1px solid ${activeQ === i ? C.accent : C.border}`,
                background: activeQ === i ? `${C.accent}18` : 'transparent',
                color: activeQ === i ? C.accent : C.sub,
              }}>{q.label}</button>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 4 }}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={inp} />
              <span style={{ color: C.muted, fontSize: 13 }}>→</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={inp} />
              <button onClick={applyCustom} style={{
                padding: '7px 16px', background: C.accent, color: '#0B0F1A',
                border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}>Apply</button>
            </div>
            {from && to && (
              <span style={{ fontSize: 13, color: C.accent, fontWeight: 600, marginLeft: 4 }}>
                {fmt(from)} – {fmt(to)}
              </span>
            )}
            <button onClick={exportCSV} disabled={!members.length} style={{
              marginLeft: 'auto', padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: members.length ? 'pointer' : 'not-allowed',
              background: members.length ? `${C.accent}18` : 'transparent',
              color: members.length ? C.accent : C.muted,
              border: `1px solid ${members.length ? C.accent + '44' : C.border}`,
              borderRadius: 8,
            }}>⬇ CSV</button>
          </div>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 80, color: C.sub, fontSize: 14 }}>Loading…</div>}
        {error   && <div style={{ textAlign: 'center', padding: 40, color: C.danger }}>{error}</div>}

        {!loading && data && data.total_reports === 0 && (
          <div style={{ ...card, padding: 60, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No reports found</div>
            <div style={{ fontSize: 13, color: C.sub }}>No submissions for {fmt(from)} – {fmt(to)}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>Try a different date range</div>
          </div>
        )}

        {!loading && data && data.total_reports > 0 && (
          <>
            {/* Banner */}
            <div style={{
              background: `linear-gradient(135deg, ${C.accentDim}, ${C.accent})`,
              borderRadius: 12, padding: '16px 24px', marginBottom: 20,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#0B0F1A' }}>{fmt(from)} – {fmt(to)}</div>
                <div style={{ fontSize: 12, color: '#0B0F1A88', marginTop: 2 }}>
                  {data.total_reports} reports · {members.length} contributors
                </div>
              </div>
              <div style={{ display: 'flex', gap: 20 }}>
                {members.map(p => (
                  <div key={p.person?.id} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#0B0F1A' }}>{p.days_reported}</div>
                    <div style={{ fontSize: 11, color: '#0B0F1A88' }}>{p.person?.name?.split(' ')[0]}</div>
                  </div>
                ))}
                <div style={{ textAlign: 'center', opacity: 0.7 }}>
                  <div style={{ fontSize: 11, color: '#0B0F1A88', marginTop: 2 }}>days each</div>
                </div>
              </div>
            </div>

            {/* ── Main Metric Table (Excel-style) ── */}
            <div style={{ ...card, overflowX: 'auto', marginBottom: 20 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{
                      textAlign: 'left', padding: '14px 20px', fontSize: 12, fontWeight: 600,
                      color: C.sub, background: C.elevated, borderBottom: `2px solid ${C.border}`,
                      position: 'sticky', left: 0, zIndex: 2, minWidth: 200,
                    }}>Metric</th>
                    {members.map(p => (
                      <th key={p.person?.id} style={{
                        textAlign: 'center', padding: '12px 16px', fontSize: 13, fontWeight: 700,
                        color: C.text, background: C.elevated, borderBottom: `2px solid ${C.border}`,
                        borderLeft: `1px solid ${C.border}`, minWidth: 110,
                      }}>
                        {p.person?.name}
                        <div style={{ fontSize: 10, color: C.muted, fontWeight: 400, marginTop: 1 }}>
                          {p.days_reported}d
                        </div>
                      </th>
                    ))}
                    <th style={{
                      textAlign: 'center', padding: '12px 16px', fontSize: 13, fontWeight: 700,
                      color: C.accent, background: `${C.accent}15`, borderBottom: `2px solid ${C.accent}55`,
                      borderLeft: `2px solid ${C.accent}55`, minWidth: 110,
                    }}>
                      Team Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {METRIC_GROUPS.map((group, gi) => {
                    const activeMetrics = group.metrics.filter(m =>
                      members.some(p => (p.totals[m.key] || 0) > 0)
                    );
                    if (!activeMetrics.length) return null;
                    return [
                      // Group header
                      <tr key={`g${gi}`}>
                        <td colSpan={members.length + 2} style={{
                          padding: '10px 20px 7px',
                          borderTop: gi > 0 ? `2px solid ${C.border}` : 'none',
                          background: `${group.color}10`,
                        }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: group.color, letterSpacing: '0.06em' }}>
                            ▸ {group.label.toUpperCase()}
                          </span>
                        </td>
                      </tr>,
                      // Metric rows
                      ...activeMetrics.map((m, mi) => {
                        const rowTotal = members.reduce((s, p) => s + (p.totals[m.key] || 0), 0);
                        const isAlt = mi % 2 === 1;
                        const bg = isAlt ? `${C.elevated}88` : 'transparent';
                        return (
                          <tr key={m.key}>
                            <td style={{
                              padding: '10px 20px', color: C.sub, fontSize: 13,
                              borderBottom: `1px solid ${C.border}`,
                              background: isAlt ? C.elevated : C.card,
                              position: 'sticky', left: 0, zIndex: 1,
                            }}>
                              {m.label}
                            </td>
                            {members.map(p => {
                              const val = p.totals[m.key] || 0;
                              return (
                                <td key={p.person?.id} style={{
                                  textAlign: 'center', padding: '10px 16px',
                                  borderBottom: `1px solid ${C.border}`,
                                  borderLeft: `1px solid ${C.border}`,
                                  background: bg,
                                  color: val > 0 ? C.text : C.muted,
                                  fontWeight: val > 0 ? 700 : 400,
                                  fontFamily: val > 0 ? 'monospace' : 'inherit',
                                }}>
                                  {val > 0 ? val.toLocaleString() : '—'}
                                </td>
                              );
                            })}
                            <td style={{
                              textAlign: 'center', padding: '10px 16px',
                              borderBottom: `1px solid ${C.border}`,
                              borderLeft: `2px solid ${C.accent}44`,
                              background: `${C.accent}08`,
                              color: rowTotal > 0 ? C.accent : C.muted,
                              fontWeight: 700, fontFamily: 'monospace',
                            }}>
                              {rowTotal > 0 ? rowTotal.toLocaleString() : '—'}
                            </td>
                          </tr>
                        );
                      }),
                    ];
                  })}
                  {/* Days row */}
                  <tr style={{ background: C.elevated }}>
                    <td style={{
                      padding: '12px 20px', fontWeight: 700, color: C.text,
                      borderTop: `2px solid ${C.border}`,
                      position: 'sticky', left: 0, background: C.elevated, zIndex: 1,
                    }}>📅 Days Reported</td>
                    {members.map(p => (
                      <td key={p.person?.id} style={{
                        textAlign: 'center', padding: '12px 16px',
                        borderTop: `2px solid ${C.border}`, borderLeft: `1px solid ${C.border}`,
                        color: C.blue, fontWeight: 700, fontSize: 15,
                      }}>{p.days_reported}</td>
                    ))}
                    <td style={{
                      textAlign: 'center', padding: '12px 16px',
                      borderTop: `2px solid ${C.border}`, borderLeft: `2px solid ${C.accent}44`,
                      background: `${C.accent}08`, color: C.accent, fontWeight: 700, fontSize: 15,
                    }}>
                      {members.reduce((s, p) => s + p.days_reported, 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Per-member summary cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14 }}>
              {members.map((p, i) => {
                const top = Object.entries(p.totals)
                  .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
                return (
                  <div key={p.person?.id} style={{
                    ...card, padding: 16,
                    borderTop: `3px solid ${['#FFD700','#C0C0C0','#CD7F32'][i] || C.border}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 18 }}>{MEDALS[i] || '👤'}</span>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{p.person?.name}</div>
                        <div style={{ fontSize: 11, color: C.muted }}>{p.days_reported} days</div>
                      </div>
                    </div>
                    {top.map(([key, val]) => {
                      const label = ALL_METRICS.find(m => m.key === key)?.label || key;
                      return (
                        <div key={key} style={{
                          display: 'flex', justifyContent: 'space-between',
                          padding: '5px 0', borderBottom: `1px solid ${C.border}`, fontSize: 12,
                        }}>
                          <span style={{ color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{label}</span>
                          <span style={{ color: C.text, fontWeight: 700, fontFamily: 'monospace', marginLeft: 8 }}>{val.toLocaleString()}</span>
                        </div>
                      );
                    })}
                    {top.length === 0 && <div style={{ fontSize: 12, color: C.muted, textAlign: 'center', padding: 8 }}>No data</div>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
