"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  blue: "#5B8DEF", purple: "#A78BFA",
};

const METRIC_GROUPS = [
  { key: "claims_piles", label: "Claims Piles", color: "#A78BFA", metrics: [
    { key: "claims_kenya", label: "Kenya" }, { key: "claims_tanzania", label: "Tanzania" },
    { key: "claims_uganda", label: "Uganda" }, { key: "claims_uap", label: "UAP Old Mutual" },
    { key: "claims_defmis", label: "Defmis" }, { key: "claims_hadiel", label: "Hadiel Tech" },
    { key: "claims_axa", label: "AXA" },
  ]},
  { key: "mapping_data", label: "Mapping & Data", color: "#5B8DEF", metrics: [
    { key: "providers_mapped", label: "Providers Mapped" }, { key: "care_items_mapped", label: "Care Items Mapped" },
    { key: "care_items_grouped", label: "Care Items Grouped" }, { key: "resolved_cares", label: "Resolved Cares" },
  ]},
  { key: "quality_review", label: "Quality & Review", color: "#00E5A0", metrics: [
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
function scoreColor(f) { return !f ? "#556677" : f >= 5 ? "#34D399" : "#FF5C5C"; }
function scoreBg(f)    { return !f ? "transparent" : f >= 5 ? "#34D39922" : "#FF5C5C22"; }

const fmt = n => (n ?? 0).toLocaleString();
const todayStr   = () => new Date().toISOString().slice(0, 10);
const daysAgo    = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; };

function Tip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1A2332", border: "1px solid #1E2D3D", borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontSize: 11, color: "#00E5A0", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 11, color: "#8899AA", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color }}/>
          <span style={{ flex: 1 }}>{p.name}</span>
          <span style={{ fontWeight: 600, color: "#F0F4F8" }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

function MetricPopup({ report, onClose }) {
  if (!report) return null;
  const m = report.metrics || {};
  const filled = scoreReport(report);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.65)", backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: "#111827", border: "1px solid #1E2D3D", borderRadius: 14, padding: 24, width: 440, maxWidth: "92vw", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.6)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "#F0F4F8" }}>{report._memberName}</div>
            <div style={{ fontSize: 11, color: "#556677" }}>{new Date(report.report_date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 20, color: scoreColor(filled) }}>{filled}/{TOTAL_FIELDS}</span>
            <button onClick={onClose} style={{ background: "#1A2332", border: "1px solid #1E2D3D", borderRadius: 8, color: "#8899AA", width: 28, height: 28, cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        </div>
        {METRIC_GROUPS.map(g => {
          const gFilled = g.metrics.filter(mk => m[mk.key] && parseInt(m[mk.key]) > 0);
          return (
            <div key={g.key} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: g.color, marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                <span>{g.label}</span><span style={{ color: "#556677" }}>{gFilled.length}/{g.metrics.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 12px" }}>
                {g.metrics.map(mk => {
                  const val = m[mk.key]; const has = val && parseInt(val) > 0;
                  return (
                    <div key={mk.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", borderBottom: "1px solid #1E2D3D" }}>
                      <span style={{ color: has ? "#8899AA" : "#556677" }}>{mk.label}</span>
                      <span style={{ fontFamily: "monospace", fontWeight: has ? 700 : 400, color: has ? g.color : "#556677" }}>{has ? fmt(val) : "—"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {(report.tasks_completed || report.notes) && (
          <div style={{ borderTop: "1px solid #1E2D3D", paddingTop: 12, marginTop: 4 }}>
            {report.tasks_completed && <div style={{ fontSize: 12, color: "#8899AA", marginBottom: 4 }}><span style={{ color: "#556677" }}>Tasks: </span>{report.tasks_completed}</div>}
            {report.notes && <div style={{ fontSize: 12, color: "#8899AA" }}><span style={{ color: "#556677" }}>Notes: </span>{report.notes}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OpsPage() {
  const [members, setMembers] = useState([]);
  const [reports, setReports] = useState([]);
  const [tasks,   setTasks]   = useState([]);
  const [leave,   setLeave]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [popup,   setPopup]   = useState(null);

  const today = todayStr();
  const [appliedFrom,  setAppliedFrom]  = useState(daysAgo(6));
  const [appliedTo,    setAppliedTo]    = useState(today);
  const [inputFrom,    setInputFrom]    = useState(daysAgo(6));
  const [inputTo,      setInputTo]      = useState(today);
  const [activePreset, setActivePreset] = useState("This week");

  const applyRange = useCallback(() => {
    if (inputFrom && inputTo) { setAppliedFrom(inputFrom); setAppliedTo(inputTo); setActivePreset(null); }
  }, [inputFrom, inputTo]);

  const applyPreset = (label, from, to) => {
    setInputFrom(from); setInputTo(to); setAppliedFrom(from); setAppliedTo(to); setActivePreset(label);
  };

  const presets = [
    { label: "Today",      from: today,        to: today },
    { label: "This week",  from: daysAgo(6),   to: today },
    { label: "2 weeks",    from: daysAgo(13),  to: today },
    { label: "30 days",    from: daysAgo(29),  to: today },
    { label: "This month", from: monthStart(), to: today },
  ];

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [mRes, rRes, tRes, lRes] = await Promise.all([
          fetch("/api/team"),
          fetch(`/api/reports?from=${appliedFrom}&to=${appliedTo}&limit=300`),
          fetch("/api/tasks"),
          fetch(`/api/leave?from=${today}&to=${today}`),
        ]);
        const [mData, rData, tData, lData] = await Promise.all([mRes.json(), rRes.json(), tRes.json(), lRes.json()]);
        setMembers(mData.data || []);
        setReports(rData.reports || rData.data || []);
        setTasks(tData.tasks || []);
        setLeave(lData.leave || lData.data || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    }
    load();
  }, [appliedFrom, appliedTo]);

  const todayReports  = reports.filter(r => (r.report_date || r.date) === today);
  const submittedIds  = new Set(todayReports.map(r => r.team_member_id));
  const onLeaveIds    = new Set(leave.map(l => l.team_member_id));
  const teamStatus    = members.map(m => ({
    ...m,
    status: onLeaveIds.has(m.id) ? "leave" : submittedIds.has(m.id) ? "submitted" : "pending",
    report: todayReports.find(r => r.team_member_id === m.id),
  }));

  const rangeReports = useMemo(() =>
    reports.filter(r => { const d = r.report_date || r.date || ""; return d >= appliedFrom && d <= appliedTo; }),
    [reports, appliedFrom, appliedTo]
  );

  const dates = useMemo(() => {
    const set = new Set(rangeReports.map(r => r.report_date || r.date).filter(Boolean));
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rangeReports]);

  const memberStats = useMemo(() => {
    const map = {};
    for (const m of members) {
      const myR = rangeReports.filter(r => r.team_member_id === m.id);
      map[m.id] = {
        reportsByDate: Object.fromEntries(myR.map(r => [r.report_date || r.date, { ...r, _memberName: m.name }])),
        totalFilled: myR.reduce((s, r) => s + scoreReport(r), 0),
        reportCount: myR.length,
      };
    }
    return map;
  }, [rangeReports, members]);

  const dailyChart = useMemo(() =>
    dates.slice().reverse().map(d => ({
      date: d.slice(5),
      fields: rangeReports.filter(r => (r.report_date || r.date) === d).reduce((s, r) => s + scoreReport(r), 0),
    })),
    [dates, rangeReports]
  );

  const pendingTasks  = tasks.filter(t => t.status !== "done");
  const tasksByMember = members.map(m => ({ ...m, tasks: pendingTasks.filter(t => t.assigned_to === m.id) })).filter(m => m.tasks.length > 0);
  const totalFilled   = Object.values(memberStats).reduce((s, m) => s + m.totalFilled, 0);
  const submittedToday = teamStatus.filter(m => m.status === "submitted").length;

  const inp   = { background: "#1A2332", border: "1px solid #1E2D3D", borderRadius: 8, padding: "6px 10px", color: "#F0F4F8", fontSize: 11, outline: "none", colorScheme: "dark" };
  const btnSt = on => ({ background: on ? "#00E5A0" : "transparent", color: on ? "#0B0F1A" : "#8899AA", border: `1px solid ${on ? "#00E5A0" : "#1E2D3D"}`, borderRadius: 8, padding: "5px 11px", fontSize: 11, fontWeight: 600, cursor: "pointer" });

  if (loading) return (
    <div style={{ marginLeft: 240, background: "#0B0F1A", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg,#00E5A0,#00B4D8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#0B0F1A", margin: "0 auto 16px", animation: "pulse 1.5s infinite" }}>C</div>
        <div style={{ color: "#8899AA", fontSize: 14 }}>Loading ops data...</div>
      </div>
    </div>
  );

  return (
    <div style={{ marginLeft: 240, background: "#0B0F1A", minHeight: "100vh", color: "#F0F4F8", fontFamily: "'DM Sans',sans-serif" }}>
      <style>{`
        @keyframes slideUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.5} }
        input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(.7);cursor:pointer}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:#0B0F1A}
        ::-webkit-scrollbar-thumb{background:#1E2D3D;border-radius:3px}
        .clickable:hover{opacity:.8;cursor:pointer}
      `}</style>

      {popup && <MetricPopup report={popup} onClose={() => setPopup(null)} />}

      {/* Header */}
      <div style={{ background: "#111827", borderBottom: "1px solid #1E2D3D", padding: "14px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 50 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Operations Overview</div>
          <div style={{ fontSize: 10, color: "#556677" }}>Curacel Health Ops · Team performance</div>
        </div>
        <div style={{ fontSize: 12, color: "#556677" }}>
          📅 {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>

      <div style={{ padding: "20px 28px" }}>

        {/* ── MEMBER COLUMNS ─────────────────────────────────── */}
        <div style={{ marginBottom: 24, animation: "slideUp .4s ease both" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#556677", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Today · {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(members.length, 6)}, 1fr)`, gap: 10 }}>
            {teamStatus.map(m => {
              const filled = m.report ? scoreReport(m.report) : null;
              const col = filled !== null ? scoreColor(filled) : (m.status === "leave" ? "#FFB84D" : "#556677");
              return (
                <div key={m.id} className={m.report ? "clickable" : ""} onClick={() => m.report && setPopup({ ...m.report, _memberName: m.name })}
                  style={{ background: "#111827", border: "1px solid #1E2D3D", borderTop: `3px solid ${col}`, borderRadius: 12, padding: "16px 14px", textAlign: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#F0F4F8" }}>{m.name}</div>
                  {filled !== null ? (
                    <>
                      <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: col, lineHeight: 1 }}>{filled}</div>
                      <div style={{ fontSize: 10, color: "#556677", marginTop: 3 }}>of {TOTAL_FIELDS} fields</div>
                      <div style={{ marginTop: 10, background: scoreBg(filled), borderRadius: 6, padding: "3px 8px", display: "inline-block" }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: col }}>{filled >= 5 ? "✓ On track" : "⚠ Needs attention"}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 24, color: "#556677", lineHeight: 1, marginBottom: 4 }}>{m.status === "leave" ? "⏸" : "—"}</div>
                      <div style={{ fontSize: 10, color: "#556677" }}>{m.status === "leave" ? "On leave" : "Not submitted"}</div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── MAIN: Table + Tasks sidebar ────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 272px", gap: 16, animation: "slideUp .4s ease .1s both" }}>

          {/* LEFT */}
          <div>
            {/* Controls */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
              {presets.map(p => (
                <button key={p.label} onClick={() => applyPreset(p.label, p.from, p.to)} style={btnSt(activePreset === p.label)}>{p.label}</button>
              ))}
              <div style={{ width: 1, height: 20, background: "#1E2D3D" }}/>
              <input type="date" value={inputFrom} onChange={e => setInputFrom(e.target.value)} onBlur={applyRange} style={inp}/>
              <span style={{ fontSize: 11, color: "#556677" }}>→</span>
              <input type="date" value={inputTo} onChange={e => setInputTo(e.target.value)} onBlur={applyRange} style={inp}/>
              <button onClick={applyRange} style={{ ...btnSt(false), background: "#00B87D", color: "#0B0F1A", border: "none" }}>Apply</button>
            </div>

            {/* Summary pills */}
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              {[
                { label: "Submitted today", value: `${submittedToday}/${members.length}`, color: "#34D399" },
                { label: "Total fields (range)", value: fmt(totalFilled), color: "#00E5A0" },
                { label: "Days tracked", value: dates.length, color: "#5B8DEF" },
                { label: "Pending tasks", value: pendingTasks.length, color: pendingTasks.length > 0 ? "#FFB84D" : "#556677" },
              ].map(s => (
                <div key={s.label} style={{ background: "#111827", border: "1px solid #1E2D3D", borderRadius: 10, padding: "10px 16px", display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: s.color }}>{s.value}</span>
                  <span style={{ fontSize: 11, color: "#556677" }}>{s.label}</span>
                </div>
              ))}
            </div>

            {/* Chart */}
            {dailyChart.length > 1 && (
              <div style={{ background: "#111827", border: "1px solid #1E2D3D", borderRadius: 12, padding: 20, marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "#F0F4F8" }}>Daily Fields Filled</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={dailyChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E2D3D" vertical={false}/>
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#556677" }}/>
                    <YAxis tick={{ fontSize: 10, fill: "#556677" }}/>
                    <Tooltip content={<Tip/>}/>
                    <Bar dataKey="fields" fill="#00E5A0" radius={[4,4,0,0]} name="Fields"/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Breakdown table */}
            <div style={{ background: "#111827", border: "1px solid #1E2D3D", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 18px", borderBottom: "1px solid #1E2D3D", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Daily Breakdown · Click any score to expand</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ background: "#34D39922", color: "#34D399", padding: "2px 8px", borderRadius: 4, fontSize: 10 }}>≥5 on track</span>
                  <span style={{ background: "#FF5C5C22", color: "#FF5C5C", padding: "2px 8px", borderRadius: 4, fontSize: 10 }}>{"<5 attention"}</span>
                </div>
              </div>
              {dates.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "#556677", fontSize: 13 }}>No submissions in this range</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ position: "sticky", left: 0, background: "#1A2332", padding: "10px 16px", textAlign: "left", borderBottom: "1px solid #1E2D3D", color: "#8899AA", fontWeight: 600, minWidth: 120 }}>Date</th>
                        {members.map(m => (
                          <th key={m.id} style={{ background: "#1A2332", padding: "10px 14px", textAlign: "center", borderBottom: "1px solid #1E2D3D", color: "#8899AA", fontWeight: 500, minWidth: 100, fontSize: 11, whiteSpace: "nowrap" }}>{m.name}</th>
                        ))}
                        <th style={{ position: "sticky", right: 0, background: "#1A2332", padding: "10px 14px", textAlign: "center", borderBottom: "1px solid #1E2D3D", color: "#00E5A0", fontWeight: 700 }}>Team</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dates.map((d, idx) => {
                        const dayReports = rangeReports.filter(r => (r.report_date || r.date) === d);
                        const dayTotal = dayReports.reduce((s, r) => s + scoreReport(r), 0);
                        return (
                          <tr key={d} style={{ background: idx % 2 ? "#1A233288" : "transparent" }}>
                            <td style={{ position: "sticky", left: 0, background: idx % 2 ? "#1A2332" : "#111827", padding: "10px 16px", color: "#F0F4F8", fontWeight: 500, borderBottom: "1px solid #1E2D3D", whiteSpace: "nowrap" }}>
                              {new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                            </td>
                            {members.map(m => {
                              const report = memberStats[m.id]?.reportsByDate?.[d] || null;
                              const f = report ? scoreReport(report) : null;
                              return (
                                <td key={m.id} className={report ? "clickable" : ""} onClick={() => report && setPopup(report)}
                                  style={{ padding: "10px 14px", textAlign: "center", borderBottom: "1px solid #1E2D3D" }}>
                                  {f !== null ? (
                                    <span style={{ background: scoreBg(f), color: scoreColor(f), fontFamily: "monospace", fontWeight: 700, fontSize: 14, padding: "3px 10px", borderRadius: 6, display: "inline-block" }}>{f}</span>
                                  ) : <span style={{ color: "#556677" }}>—</span>}
                                </td>
                              );
                            })}
                            <td style={{ position: "sticky", right: 0, background: idx % 2 ? "#1A2332" : "#111827", padding: "10px 14px", textAlign: "center", fontFamily: "monospace", fontWeight: 700, color: "#00E5A0", borderBottom: "1px solid #1E2D3D" }}>{dayTotal}</td>
                          </tr>
                        );
                      })}
                      <tr style={{ background: "#00E5A011" }}>
                        <td style={{ position: "sticky", left: 0, background: "#00E5A01A", padding: "11px 16px", fontWeight: 700, color: "#00E5A0", borderTop: "2px solid #00E5A044" }}>TOTAL</td>
                        {members.map(m => {
                          const ms = memberStats[m.id];
                          return (
                            <td key={m.id} style={{ padding: "11px 14px", textAlign: "center", borderTop: "2px solid #00E5A044", fontFamily: "monospace", fontWeight: 700, color: "#00E5A0", fontSize: 13 }}>
                              {ms?.totalFilled || "—"}{ms?.reportCount > 0 && <span style={{ color: "#556677", fontWeight: 400, fontSize: 10 }}> ({ms.reportCount}d)</span>}
                            </td>
                          );
                        })}
                        <td style={{ position: "sticky", right: 0, background: "#00E5A01A", padding: "11px 14px", textAlign: "center", fontFamily: "monospace", fontWeight: 700, color: "#00E5A0", fontSize: 14, borderTop: "2px solid #00E5A044" }}>{totalFilled}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Tasks sidebar */}
          <div>
            <div style={{ background: "#111827", border: "1px solid #1E2D3D", borderRadius: 12, overflow: "hidden", position: "sticky", top: 76 }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #1E2D3D", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Pending Tasks</div>
                {pendingTasks.length > 0 && <span style={{ background: "#FFB84D22", color: "#FFB84D", border: "1px solid #FFB84D44", borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 600 }}>{pendingTasks.length}</span>}
              </div>
              {tasksByMember.length === 0 ? (
                <div style={{ padding: "28px 16px", textAlign: "center", color: "#556677", fontSize: 12 }}>🎉 All clear</div>
              ) : (
                <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
                  {tasksByMember.map(m => (
                    <div key={m.id} style={{ padding: "10px 14px", borderBottom: "1px solid #1E2D3D" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{m.name}</span>
                        <span style={{ fontSize: 10, color: "#556677" }}>{m.tasks.length}</span>
                      </div>
                      {m.tasks.map(t => (
                        <div key={t.id} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 4 }}>
                          <span style={{ fontSize: 10, color: t.status === "in_progress" ? "#5B8DEF" : "#556677", marginTop: 2, flexShrink: 0 }}>{t.status === "in_progress" ? "◑" : "○"}</span>
                          <span style={{ fontSize: 11, color: "#8899AA", flex: 1, lineHeight: 1.4 }}>{t.title}</span>
                          <span style={{ fontSize: 9, flexShrink: 0 }}>{t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢"}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {/* Range totals at bottom */}
              <div style={{ padding: "10px 14px", borderTop: "1px solid #1E2D3D", background: "#1A2332" }}>
                <div style={{ fontSize: 10, color: "#556677", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: .5 }}>Range Summary</div>
                {members.map(m => {
                  const ms = memberStats[m.id];
                  const total = ms?.totalFilled || 0; const days = ms?.reportCount || 0;
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
                      <span style={{ color: "#8899AA" }}>{m.name}</span>
                      <span style={{ fontFamily: "monospace", color: total > 0 ? "#00E5A0" : "#556677", fontWeight: 600 }}>{total}<span style={{ color: "#556677", fontWeight: 400 }}> ({days}d)</span></span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
