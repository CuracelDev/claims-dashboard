'use client';
import { useState, useEffect, useMemo } from 'react';
import { useTheme } from '../context/ThemeContext';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const METRIC_LABELS = {
  providers_mapped:'Providers Mapped', care_items_mapped:'Care Items Mapped',
  care_items_grouped:'Care Items Grouped', resolved_cares:'Resolved Cares',
  claims_kenya:'Kenya', claims_tanzania:'Tanzania', claims_uganda:'Uganda',
  claims_uap:'UAP Old Mutual', claims_defmis:'Defmis', claims_hadiel:'Hadiel Tech', claims_axa:'AXA',
  auto_pa_reviewed:'Auto PA Reviewed', flagged_care_items:'Flagged Care Items',
  icd10_adjusted:'ICD10 Adjusted', benefits_set_up:'Benefits Set Up',
  providers_assigned:'Providers Assigned',
};

// Dynamic today — computed fresh each render, not stale module-level
const getToday = () => new Date().toISOString().split('T')[0];

const fmtDay = (d) => {
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
};

const QUICK_RANGES = [
  { label:'Today',      days: 0  },
  { label:'This week',  days: 7  },
  { label:'2 weeks',    days: 14 },
  { label:'30 days',    days: 30 },
  { label:'This month', month: true },
];

function getRangeDates(range) {
  const today = getToday();
  const todayDate = new Date(today + 'T12:00:00');
  if (range.month) {
    const from = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).toISOString().split('T')[0];
    return { from, to: today };
  }
  if (range.days === 0) return { from: today, to: today };
  const from = new Date(todayDate);
  from.setDate(todayDate.getDate() - range.days + 1);
  return { from: from.toISOString().split('T')[0], to: today };
}

/* ── ℹ️ InfoTip — hover tooltip for stat cards ─────────────── */
function InfoTip({ text, C }) {
  const [show, setShow] = useState(false);
  return (
    <div
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      style={{ position:'absolute', top:10, right:10, cursor:'default' }}
    >
      <span style={{ fontSize:13, color:C.muted, userSelect:'none' }}>ℹ</span>
      {show && (
        <div style={{
          position:'absolute', top:20, right:0, width:220, background:C.elevated,
          border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 12px',
          fontSize:11, color:C.sub, lineHeight:1.5, zIndex:50,
          boxShadow:'0 4px 20px rgba(0,0,0,0.4)', textAlign:'left',
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

export default function OpsPage() {
  const { C } = useTheme();
  const TODAY = getToday(); // Fresh on each render

  const [activeRange, setActiveRange] = useState(1);
  const [customFrom, setCustomFrom]   = useState('');
  const [customTo, setCustomTo]       = useState(TODAY);
  const [useCustom, setUseCustom]     = useState(false);

  const [teamMembers, setTeamMembers]   = useState([]);
  const [reports, setReports]           = useState([]);
  const [todayReports, setTodayReports] = useState([]);
  const [tasks, setTasks]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [expandedRow, setExpandedRow]   = useState(null);

  const { from, to } = useCustom && customFrom
    ? { from: customFrom, to: customTo }
    : getRangeDates(QUICK_RANGES[activeRange]);

  // Sync inputs to quick range dates so user can see the active range
  const handleQuickRange = (i) => {
    setActiveRange(i);
    setUseCustom(false);
    const { from: f, to: t } = getRangeDates(QUICK_RANGES[i]);
    setCustomFrom(f);
    setCustomTo(t);
  };

  useEffect(() => {
    // Initialise inputs with default range (This week)
    const { from: f, to: t } = getRangeDates(QUICK_RANGES[1]);
    setCustomFrom(f); setCustomTo(t);
  }, []);

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers(data || []));
    fetch('/api/tasks').then(r => r.json()).then(({ data }) => setTasks(data || []));
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/reports?from=${from}&to=${to}&limit=200`).then(r => r.json()),
      fetch(`/api/reports?date=${TODAY}&limit=50`).then(r => r.json()),
    ]).then(([range, today]) => {
      setReports(range.data || []);
      setTodayReports(today.data || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [from, to]);

  const getMemberScore  = (id, date) => {
    const r = reports.find(x => String(x.team_member_id) === String(id) && x.report_date === date);
    if (!r) return null;
    return Object.values(r.metrics||{}).filter(v => parseInt(v)>0).length;
  };
  const getMemberTotal  = (id) => reports.filter(r => String(r.team_member_id) === String(id))
    .reduce((s,r) => s + Object.values(r.metrics||{}).reduce((a,b) => a+(parseInt(b)||0), 0), 0);
  const getMemberDays   = (id) => new Set(reports.filter(r => String(r.team_member_id)===String(id)).map(r=>r.report_date)).size;
  const getTodayReport  = (id) => todayReports.find(r => String(r.team_member_id)===String(id));

  const allDates = [...new Set(reports.map(r => r.report_date))].sort();
  const chartData = allDates.map(d => ({
    date: d,
    output: reports.filter(r => r.report_date===d)
      .reduce((s,r) => s+Object.values(r.metrics||{}).reduce((a,b)=>a+(parseInt(b)||0),0), 0),
  }));

  const daysTracked = new Set(reports.map(r => r.report_date)).size;
  // totalOutput retained for the TOTAL row in the breakdown table
  const totalOutput = reports.reduce((s,r)=>s+Object.values(r.metrics||{}).reduce((a,b)=>a+(parseInt(b)||0),0),0);

  // Top metric across the range
  const metricTotals = {};
  reports.forEach(r => {
    Object.entries(r.metrics||{}).forEach(([k,v]) => {
      metricTotals[k] = (metricTotals[k]||0) + (parseInt(v)||0);
    });
  });
  const topMetric = Object.entries(metricTotals).sort((a,b)=>b[1]-a[1])[0];

  const getDaysInRange = () => {
    const start = new Date(from + 'T12:00:00');
    const end   = new Date(to   + 'T12:00:00');
    const diff  = Math.round((end - start) / 86400000);
    const days  = [];
    for (let i = 0; i <= Math.min(diff, 13); i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      if (d.getDay() !== 0 && d.getDay() !== 6) days.push(d.toISOString().split('T')[0]);
    }
    return days.reverse();
  };
  const days = getDaysInRange();
  const pendingTasks = tasks.filter(t => t.status !== 'done');

  const cardStyle = {
    background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20,
  };
  const inputStyle = {
    background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 8,
    color: C.text, padding: '7px 10px', fontSize: 13, outline: 'none',
  };

  return (
    <div style={{ minHeight:'100vh', background:C.bg, color:C.text, paddingBottom:60, transition:'background 0.2s' }}>

      {/* Header */}
      <div style={{ background:C.card, borderBottom:`1px solid ${C.border}`, padding:'18px 24px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:700, color:C.text }}>Operations Overview</h1>
          <p style={{ margin:'4px 0 0', fontSize:13, color:C.sub }}>Curacel Health Ops · Team performance</p>
        </div>
        <div style={{ fontSize:13, color:C.sub, background:C.elevated, padding:'8px 14px', borderRadius:8, border:`1px solid ${C.border}` }}>
          📅 {new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
        </div>
      </div>

      <div style={{ padding:'20px 24px', boxSizing:'border-box' }}>

        {/* Today score cards */}
        <div style={{ marginBottom:8, fontSize:11, fontWeight:600, color:C.muted, letterSpacing:'0.07em' }}>
          TODAY · {new Date(TODAY+'T12:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short'}).toUpperCase()}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${Math.max(teamMembers.length,1)},1fr)`, gap:10, marginBottom:24 }}>
          {teamMembers.map(m => {
            const r = getTodayReport(m.id);
            const score = r ? Object.values(r.metrics||{}).filter(v=>parseInt(v)>0).length : null;
            return (
              <div key={m.id} style={{ ...cardStyle, padding:'14px 10px', textAlign:'center', borderTop:`3px solid ${r ? (score>=5?C.accent:C.warn) : C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:6, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{m.name}</div>
                {r ? (
                  <>
                    <div style={{ fontSize:24, fontWeight:700, color:score>=5?C.accent:C.warn }}>{score}</div>
                    <div style={{ fontSize:10, color:C.sub }}>fields</div>
                  </>
                ) : (
                  <>
                    <div style={{ color:C.border, fontSize:18, margin:'4px 0' }}>—</div>
                    <div style={{ fontSize:10, color:C.muted }}>Not submitted</div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Range controls */}
        <div style={{ ...cardStyle, marginBottom:24, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          {QUICK_RANGES.map((r,i) => (
            <button key={r.label} onClick={() => handleQuickRange(i)} style={{
              padding:'7px 14px', borderRadius:8, fontSize:13, fontWeight:500, cursor:'pointer',
              border:`1px solid ${!useCustom&&activeRange===i ? C.accent : C.border}`,
              background:!useCustom&&activeRange===i ? `${C.accent}18` : 'transparent',
              color:!useCustom&&activeRange===i ? C.accent : C.sub,
            }}>{r.label}</button>
          ))}
          <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ ...inputStyle, marginLeft:8 }} />
          <span style={{ color:C.muted }}>→</span>
          <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={inputStyle} />
          <button onClick={() => { setUseCustom(true); setActiveRange(-1); }} style={{
            padding:'7px 14px', background:C.accent, color:'#0B0F1A',
            border:'none', borderRadius:8, fontWeight:700, fontSize:13, cursor:'pointer',
          }}>Apply</button>
        </div>

        {/* Stats — 4 cards with ℹ️ tooltips */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:24 }}>
          {[
            {
              val: `${todayReports.length}/${teamMembers.length}`,
              label: 'Submitted today',
              color: C.accent,
              tip: 'Number of team members who have submitted a daily report today vs total active members.',
            },
            {
              val: reports.length,
              label: 'Reports this period',
              color: C.blue,
              sub: from === to ? 'today' : `${from} – ${to}`,
              tip: 'Total individual report submissions within the selected date range.',
            },
            {
              val: daysTracked,
              label: 'Days with activity',
              color: C.purple,
              tip: 'Number of distinct calendar days within the range that have at least one report submitted — not counting days where everyone was off or no one logged anything.',
            },
            {
              val: pendingTasks.length,
              label: 'Pending tasks',
              color: pendingTasks.length > 0 ? C.warn : C.success,
              tip: 'Open tasks assigned to the team via Task Management that have not yet been marked complete.',
            },
          ].map((s, i) => (
            <div key={i} style={{ ...cardStyle, textAlign:'center', position:'relative' }}>
              {/* ℹ️ tooltip trigger */}
              <InfoTip text={s.tip} C={C} />
              <div style={{ fontSize:30, fontWeight:700, color:s.color, fontFamily:'monospace' }}>{s.val}</div>
              <div style={{ fontSize:12, color:C.sub, marginTop:4 }}>{s.label}</div>
              {s.sub && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{s.sub}</div>}
            </div>
          ))}
        </div>

        {/* Chart + Pending */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 260px', gap:18, marginBottom:24 }}>
          <div style={cardStyle}>
            <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:14 }}>Daily Output</div>
            {chartData.length===0 ? (
              <div style={{ textAlign:'center', padding:40, color:C.muted }}>No data for this range</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top:0, right:0, left:-20, bottom:0 }}>
                  <XAxis dataKey="date" tickFormatter={d => {
                    const dt = new Date(d+'T12:00:00');
                    return `${dt.getMonth()+1}-${String(dt.getDate()).padStart(2,'0')}`;
                  }} tick={{ fontSize:10, fill:C.sub }} />
                  <YAxis tick={{ fontSize:10, fill:C.sub }} tickFormatter={v => v>=1000?`${(v/1000).toFixed(0)}k`:v} />
                  <Tooltip contentStyle={{ background:C.elevated, border:`1px solid ${C.border}`, borderRadius:8, fontSize:12 }} labelFormatter={d => fmtDay(d)} />
                  <Bar dataKey="output" radius={[4,4,0,0]} name="Output">
                    {chartData.map((_,i) => <Cell key={i} fill={C.accent} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div style={{ ...cardStyle, overflowY:'auto', maxHeight:270 }}>
            <div style={{ fontSize:13, fontWeight:600, color:C.text, marginBottom:12 }}>Pending Tasks</div>
            {pendingTasks.length===0 ? (
              <div style={{ textAlign:'center', padding:20 }}>
                <div style={{ fontSize:20, marginBottom:6 }}>🎉</div>
                <div style={{ fontSize:12, color:C.sub }}>All clear</div>
              </div>
            ) : pendingTasks.slice(0,8).map(t => (
              <div key={t.id} style={{ borderBottom:`1px solid ${C.border}`, paddingBottom:8, marginBottom:8 }}>
                <div style={{ fontSize:12, fontWeight:600, color:C.text }}>{t.title}</div>
                <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
                  {t.priority && <span style={{ color:t.priority==='high'?C.danger:t.priority==='medium'?C.warn:C.sub }}>● {t.priority}</span>}
                  {t.due_date && <span style={{ marginLeft:6 }}>Due {t.due_date}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Range summary + Daily breakdown */}
        <div style={{ display:'grid', gridTemplateColumns:'200px 1fr', gap:18 }}>
          <div style={cardStyle}>
            <div style={{ fontSize:11, fontWeight:600, color:C.muted, letterSpacing:'0.07em', marginBottom:12 }}>RANGE SUMMARY</div>
            {teamMembers.map(m => {
              const total = getMemberTotal(m.id);
              const dCount = getMemberDays(m.id);
              return (
                <div key={m.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'7px 0', borderBottom:`1px solid ${C.border}` }}>
                  <span style={{ fontSize:12, color:C.text }}>{m.name}</span>
                  <span style={{ fontSize:12, color:total>0?C.accent:C.muted, fontWeight:600 }}>
                    {total>0 ? total.toLocaleString() : '—'}
                    {dCount>0 && <span style={{ fontSize:10, color:C.muted, marginLeft:4 }}>({dCount}d)</span>}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ ...cardStyle, overflowX:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14, flexWrap:'wrap', gap:8 }}>
              <div style={{ fontSize:13, fontWeight:600, color:C.text }}>
                Daily Breakdown
                <span style={{ fontSize:11, fontWeight:400, color:C.sub, marginLeft:8 }}>· Click any score to expand</span>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <span style={{ fontSize:11, background:`${C.accent}20`, color:C.accent, padding:'3px 10px', borderRadius:20 }}>≥5 on track</span>
                <span style={{ fontSize:11, background:`${C.danger}20`, color:C.danger, padding:'3px 10px', borderRadius:20 }}>&lt;5 attention</span>
              </div>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign:'left', padding:'8px 12px', color:C.sub, fontWeight:600, borderBottom:`1px solid ${C.border}` }}>Date</th>
                  {teamMembers.map(m => (
                    <th key={m.id} style={{ textAlign:'center', padding:'8px 8px', color:C.sub, fontWeight:600, borderBottom:`1px solid ${C.border}` }}>{m.name}</th>
                  ))}
                  <th style={{ textAlign:'center', padding:'8px 8px', color:C.accent, fontWeight:700, borderBottom:`1px solid ${C.border}` }}>Team</th>
                </tr>
              </thead>
              <tbody>
                {days.map(d => {
                  const isToday = d === TODAY;
                  const dayReports = reports.filter(r => r.report_date===d);
                  const teamTotal  = dayReports.reduce((s,r)=>s+Object.values(r.metrics||{}).filter(v=>parseInt(v)>0).length,0);
                  return [
                    <tr key={d} style={{ background:isToday?`${C.accent}08`:'transparent' }}>
                      <td style={{ padding:'9px 12px', borderBottom:`1px solid ${C.border}`, color:isToday?C.accent:C.text, fontWeight:isToday?700:400, whiteSpace:'nowrap' }}>
                        {fmtDay(d)}
                      </td>
                      {teamMembers.map(m => {
                        const score = getMemberScore(m.id, d);
                        const key = `${m.id}-${d}`;
                        return (
                          <td key={m.id} style={{ textAlign:'center', padding:'9px 6px', borderBottom:`1px solid ${C.border}`, cursor:score!==null?'pointer':'default' }}
                            onClick={() => score!==null && setExpandedRow(expandedRow===key?null:key)}>
                            {score===null ? <span style={{ color:C.muted }}>—</span> : (
                              <span style={{
                                display:'inline-block', minWidth:26, padding:'2px 6px', borderRadius:6,
                                fontWeight:700, background:score>=5?`${C.accent}20`:`${C.danger}20`,
                                color:score>=5?C.accent:C.danger,
                              }}>{score}</span>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ textAlign:'center', padding:'9px 6px', borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ fontWeight:700, color:teamTotal>0?C.accent:C.muted }}>{teamTotal>0?teamTotal:'—'}</span>
                      </td>
                    </tr>,
                    ...teamMembers.map(m => {
                      const key = `${m.id}-${d}`;
                      if (expandedRow !== key) return null;
                      const r = reports.find(x => String(x.team_member_id)===String(m.id) && x.report_date===d);
                      if (!r) return null;
                      return (
                        <tr key={`${key}-exp`}>
                          <td colSpan={teamMembers.length+2} style={{ background:`${C.accent}06`, padding:'10px 16px', borderBottom:`1px solid ${C.border}` }}>
                            <div style={{ fontSize:12, fontWeight:600, color:C.accent, marginBottom:6 }}>{m.name} · {fmtDay(d)}</div>
                            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                              {Object.entries(r.metrics||{}).filter(([,v])=>parseInt(v)>0).map(([key,val]) => (
                                <span key={key} style={{ background:C.elevated, border:`1px solid ${C.border}`, borderRadius:6, padding:'3px 8px', fontSize:11 }}>
                                  <span style={{ color:C.sub }}>{METRIC_LABELS[key]||key}: </span>
                                  <span style={{ color:C.text, fontWeight:600 }}>{Number(val).toLocaleString()}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    }).filter(Boolean),
                  ];
                })}
                <tr style={{ background:`${C.accent}10` }}>
                  <td style={{ padding:'10px 12px', fontWeight:700, color:C.accent, fontSize:13 }}>TOTAL</td>
                  {teamMembers.map(m => {
                    const total = getMemberTotal(m.id);
                    const dCount = getMemberDays(m.id);
                    return (
                      <td key={m.id} style={{ textAlign:'center', padding:'10px 6px' }}>
                        {total>0 ? (
                          <span style={{ color:C.accent, fontWeight:700 }}>
                            {total.toLocaleString()} <span style={{ fontSize:10, color:C.muted }}>({dCount}d)</span>
                          </span>
                        ) : <span style={{ color:C.muted }}>—</span>}
                      </td>
                    );
                  })}
                  <td style={{ textAlign:'center', padding:'10px 6px' }}>
                    <span style={{ fontWeight:700, color:C.accent }}>
                      {totalOutput.toLocaleString()}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
