"use client";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  blue: "#5B8DEF", purple: "#A78BFA", orange: "#FB923C",
  chart: ["#00E5A0","#5B8DEF","#FF6B8A","#FFB84D","#A78BFA","#F472B6","#34D399"],
};

// All metric keys — 16 total
const METRIC_GROUPS = [
  {
    key: "claims_piles", label: "Claims Piles", color: C.purple,
    metrics: [
      { key: "claims_kenya",    label: "Kenya" },
      { key: "claims_tanzania", label: "Tanzania" },
      { key: "claims_uganda",   label: "Uganda" },
      { key: "claims_uap",      label: "UAP Old Mutual" },
      { key: "claims_defmis",   label: "Defmis" },
      { key: "claims_hadiel",   label: "Hadiel Tech" },
      { key: "claims_axa",      label: "AXA" },
    ],
  },
  {
    key: "mapping_data", label: "Mapping & Data", color: C.blue,
    metrics: [
      { key: "providers_mapped",   label: "Providers Mapped" },
      { key: "care_items_mapped",  label: "Care Items Mapped" },
      { key: "care_items_grouped", label: "Care Items Grouped" },
      { key: "resolved_cares",     label: "Resolved Cares" },
    ],
  },
  {
    key: "quality_review", label: "Quality & Review", color: C.accent,
    metrics: [
      { key: "auto_pa_reviewed",   label: "Auto PA Reviewed" },
      { key: "flagged_care_items", label: "Flagged Care Items" },
      { key: "icd10_adjusted",     label: "ICD10 Adjusted" },
      { key: "benefits_set_up",    label: "Benefits Set Up" },
      { key: "providers_assigned", label: "Providers Assigned" },
    ],
  },
];

const ALL_KEYS = METRIC_GROUPS.flatMap(g => g.metrics.map(m => m.key));
const TOTAL_FIELDS = ALL_KEYS.length; // 16

// Score a report: count fields with value > 0
function scoreReport(report) {
  const m = report?.metrics || {};
  const filled = ALL_KEYS.filter(k => m[k] && parseInt(m[k]) > 0).length;
  return { filled, total: TOTAL_FIELDS };
}

// Get sum of a metric group for a report
function groupScore(report, groupKey) {
  const group = METRIC_GROUPS.find(g => g.key === groupKey);
  if (!group) return { filled: 0, total: 0 };
  const m = report?.metrics || {};
  const filled = group.metrics.filter(mk => m[mk.key] && parseInt(m[mk.key]) > 0).length;
  return { filled, total: group.metrics.length };
}

function pct(filled, total) {
  if (!total) return 0;
  return Math.round((filled / total) * 100);
}

function cellColor(filled, total) {
  if (!filled) return { bg: "transparent", text: C.muted };
  const p = pct(filled, total);
  if (p >= 80) return { bg: `${C.success}22`, text: C.success };
  if (p >= 50) return { bg: `${C.warn}22`,    text: C.warn };
  return { bg: `${C.danger}22`, text: C.danger };
}

const fmt = n => n?.toLocaleString() ?? "0";
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgo  = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; };

function StatCard({ label, value, sub, icon, color = C.accent, delay = 0 }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 150, position: "relative", overflow: "hidden", animation: `slideUp .5s ease ${delay}s both` }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${color},transparent)` }}/>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 6, letterSpacing: .5, textTransform: "uppercase", fontWeight: 500 }}>{icon} {label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: C.text, fontFamily: "'JetBrains Mono',monospace", letterSpacing: -1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Tip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, marginBottom: 5 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 11, color: C.sub, display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }}/>
          <span style={{ flex: 1 }}>{p.name}</span>
          <span style={{ fontWeight: 600, color: C.text, fontFamily: "monospace" }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// Expandable cell showing per-group breakdown
function BreakdownCell({ report }) {
  const [open, setOpen] = useState(false);
  if (!report) return <td style={{ padding: "9px 12px", textAlign: "center", color: C.muted, borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>—</td>;

  const { filled, total } = scoreReport(report);
  const { bg, text: col } = cellColor(filled, total);

  return (
    <td
      onClick={() => setOpen(o => !o)}
      style={{ padding: "9px 12px", textAlign: "center", borderBottom: `1px solid ${C.border}`, cursor: "pointer", position: "relative", verticalAlign: "top" }}
    >
      <div style={{ background: bg, borderRadius: 6, padding: "4px 8px", display: "inline-block", minWidth: 48 }}>
        <span style={{ fontFamily: "monospace", fontWeight: 700, color: col, fontSize: 12 }}>{filled}/{total}</span>
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
          zIndex: 50, background: C.elevated, border: `1px solid ${C.border}`,
          borderRadius: 10, padding: 12, width: 210, boxShadow: "0 8px 32px rgba(0,0,0,.5)",
          textAlign: "left",
        }}>
          {METRIC_GROUPS.map(g => {
            const gs = groupScore(report, g.key);
            const m = report?.metrics || {};
            return (
              <div key={g.key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: g.color, marginBottom: 4 }}>
                  {g.label} — {gs.filled}/{gs.total}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" }}>
                  {g.metrics.map(mk => {
                    const val = m[mk.key];
                    const hasVal = val && parseInt(val) > 0;
                    return (
                      <div key={mk.key} style={{ fontSize: 10, color: hasVal ? C.text : C.muted, display: "flex", justifyContent: "space-between", gap: 4 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mk.label}</span>
                        <span style={{ fontFamily: "monospace", color: hasVal ? g.color : C.muted, flexShrink: 0 }}>{hasVal ? fmt(val) : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {report.tasks_completed && (
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 4, fontSize: 10, color: C.sub }}>
              <span style={{ color: C.muted }}>Tasks: </span>{report.tasks_completed}
            </div>
          )}
          {report.notes && (
            <div style={{ fontSize: 10, color: C.sub, marginTop: 4 }}>
              <span style={{ color: C.muted }}>Notes: </span>{report.notes}
            </div>
          )}
        </div>
      )}
    </td>
  );
}

export default function OpsPage() {
  const [members, setMembers] = useState([]);
  const [reports, setReports] = useState([]);
  const [tasks,   setTasks]   = useState([]);
  const [leave,   setLeave]   = useState([]);
  const [loading, setLoading] = useState(true);

  const today = todayStr();

  // ── Flicker fix: separate input state from fetch trigger ──────────────
  const [appliedFrom, setAppliedFrom] = useState(daysAgo(6));
  const [appliedTo,   setAppliedTo]   = useState(today);
  const [inputFrom,   setInputFrom]   = useState(daysAgo(6));
  const [inputTo,     setInputTo]     = useState(today);

  const applyRange = useCallback(() => {
    if (inputFrom && inputTo) {
      setAppliedFrom(inputFrom);
      setAppliedTo(inputTo);
    }
  }, [inputFrom, inputTo]);

  const applyPreset = useCallback((from, to) => {
    setInputFrom(from);
    setInputTo(to);
    setAppliedFrom(from);
    setAppliedTo(to);
  }, []);

  const presets = [
    { label: "Today",      from: today,        to: today },
    { label: "This week",  from: daysAgo(6),   to: today },
    { label: "2 weeks",    from: daysAgo(13),  to: today },
    { label: "30 days",    from: daysAgo(29),  to: today },
    { label: "This month", from: monthStart(), to: today },
  ];

  // ── Fetch (only fires when applied range changes) ─────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [mRes, rRes, tRes, lRes] = await Promise.all([
          fetch("/api/team"),
          fetch(`/api/reports?from=${appliedFrom}&to=${appliedTo}&limit=200`),
          fetch("/api/tasks"),
          fetch(`/api/leave?from=${today}&to=${today}`),
        ]);
        const [mData, rData, tData, lData] = await Promise.all([
          mRes.json(), rRes.json(), tRes.json(), lRes.json(),
        ]);
        setMembers(mData.data || []);
        setReports(rData.reports || rData.data || []);
        setTasks(tData.tasks || []);
        setLeave(lData.leave || lData.data || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    }
    load();
  }, [appliedFrom, appliedTo]);

  // ── Today's status ────────────────────────────────────────────────────
  const todayReports = reports.filter(r => (r.report_date || r.date) === today);
  const submittedIds = new Set(todayReports.map(r => r.team_member_id));
  const onLeaveIds   = new Set(leave.map(l => l.team_member_id));

  const teamStatus = members.map(m => ({
    ...m,
    status: onLeaveIds.has(m.id) ? "leave" : submittedIds.has(m.id) ? "submitted" : "pending",
    report: todayReports.find(r => r.team_member_id === m.id),
  }));
  const submitted = teamStatus.filter(m => m.status === "submitted").length;
  const onLeave   = teamStatus.filter(m => m.status === "leave").length;
  const pending   = teamStatus.filter(m => m.status === "pending").length;

  // ── Pending tasks ─────────────────────────────────────────────────────
  const pendingTasks = tasks.filter(t => t.status !== "done");
  const tasksByMember = members
    .map(m => ({ ...m, tasks: pendingTasks.filter(t => t.assigned_to === m.id) }))
    .filter(m => m.tasks.length > 0);

  // ── Range reports ─────────────────────────────────────────────────────
  const rangeReports = useMemo(() =>
    reports.filter(r => {
      const d = r.report_date || r.date || "";
      return d >= appliedFrom && d <= appliedTo;
    }),
    [reports, appliedFrom, appliedTo]
  );

  // ── All dates in range that have at least one report ─────────────────
  const dates = useMemo(() => {
    const set = new Set(rangeReports.map(r => r.report_date || r.date).filter(Boolean));
    return [...set].sort((a, b) => b.localeCompare(a)); // newest first
  }, [rangeReports]);

  // ── Per-member stats ─────────────────────────────────────────────────
  const memberStats = useMemo(() => {
    return members.map(m => {
      const myReports = rangeReports.filter(r => r.team_member_id === m.id);
      const totalFilled = myReports.reduce((s, r) => s + scoreReport(r).filled, 0);
      const totalPossible = myReports.length * TOTAL_FIELDS;
      return {
        ...m,
        reportCount: myReports.length,
        totalFilled,
        totalPossible,
        avgFilled: myReports.length ? Math.round(totalFilled / myReports.length) : 0,
        completionPct: totalPossible ? pct(totalFilled, totalPossible) : 0,
        reportsByDate: Object.fromEntries(myReports.map(r => [r.report_date || r.date, r])),
      };
    }).filter(m => m.reportCount > 0).sort((a, b) => b.completionPct - a.completionPct);
  }, [rangeReports, members]);

  // ── Daily chart data ──────────────────────────────────────────────────
  const dailyChart = useMemo(() => {
    return dates.slice().reverse().map(d => {
      const dayReports = rangeReports.filter(r => (r.report_date || r.date) === d);
      const totalFilled = dayReports.reduce((s, r) => s + scoreReport(r).filled, 0);
      return { date: d.slice(5), filled: totalFilled, submissions: dayReports.length };
    });
  }, [dates, rangeReports]);

  // ── Summary stats ─────────────────────────────────────────────────────
  const totalFilled    = memberStats.reduce((s, m) => s + m.totalFilled, 0);
  const totalPossible  = memberStats.reduce((s, m) => s + m.totalPossible, 0);
  const overallPct     = totalPossible ? pct(totalFilled, totalPossible) : 0;
  const avgPerDay      = dates.length ? Math.round(totalFilled / dates.length) : 0;
  const bestDay        = dailyChart.length ? dailyChart.reduce((a, b) => b.filled > a.filled ? b : a, dailyChart[0]) : null;

  // ── Styles ────────────────────────────────────────────────────────────
  const inp = {
    background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8,
    padding: "7px 12px", color: C.text, fontSize: 12, outline: "none",
    colorScheme: "dark",
  };
  const btnStyle = on => ({
    background: on ? C.accent : "transparent",
    color: on ? C.bg : C.sub,
    border: `1px solid ${on ? C.accent : C.border}`,
    borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 600,
    cursor: "pointer", transition: "all .15s",
  });

  const statusChip = status => {
    const cfg = {
      submitted: { bg: `${C.success}22`, color: C.success, border: `${C.success}44`, label: "✓ Submitted" },
      leave:     { bg: `${C.warn}22`,    color: C.warn,    border: `${C.warn}44`,    label: "⏸ On Leave" },
      pending:   { bg: `${C.muted}22`,   color: C.muted,   border: `${C.muted}44`,   label: "○ Pending" },
    }[status] || {};
    return (
      <span style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600 }}>
        {cfg.label}
      </span>
    );
  };

  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: `linear-gradient(135deg,${C.accent},#00B4D8)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: C.bg, margin: "0 auto 16px", animation: "pulse 1.5s infinite" }}>C</div>
        <div style={{ color: C.sub, fontSize: 14 }}>Loading ops data...</div>
      </div>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
        @keyframes pulse   { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(.7); cursor: pointer }
        ::-webkit-scrollbar { width: 6px; height: 6px }
        ::-webkit-scrollbar-track { background: ${C.bg} }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px }
        .cell-wrap { position: relative }
      `}</style>

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, marginLeft: 240 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -.3 }}>Operations Overview</div>
          <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops · Team performance at a glance</div>
        </div>
        <div style={{ fontSize: 12, color: C.muted }}>
          📅 {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>

      <div style={{ marginLeft: 240, padding: "20px 28px", maxWidth: 1440 }}>

        {/* ── TODAY'S TEAM STATUS ─────────────────────────────── */}
        <div style={{ marginBottom: 24, animation: "slideUp .4s ease both" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Today's Team Status
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <StatCard label="Submitted"    value={submitted} sub={`of ${members.length} members`}                              icon="✅" color={C.success} delay={.05}/>
            <StatCard label="Pending"      value={pending}   sub="not yet submitted"                                           icon="○"  color={C.muted}   delay={.1}/>
            <StatCard label="On Leave"     value={onLeave}   sub="absent today"                                                icon="⏸" color={C.warn}    delay={.15}/>
            <StatCard label="Fields Today" value={todayReports.reduce((s,r) => s + scoreReport(r).filled, 0)} sub={`of ${submitted * TOTAL_FIELDS} possible`} icon="📊" color={C.accent} delay={.2}/>
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Member Status</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: 10 }}>
              {teamStatus.map(m => {
                const score = m.report ? scoreReport(m.report) : null;
                return (
                  <div key={m.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8,
                    padding: "10px 14px",
                    borderLeft: `3px solid ${m.status === "submitted" ? C.success : m.status === "leave" ? C.warn : C.muted}`,
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {score && (
                        <span style={{ fontSize: 11, fontFamily: "monospace", color: C.accent }}>
                          {score.filled}/{score.total} fields
                        </span>
                      )}
                      {statusChip(m.status)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── PENDING TASKS ───────────────────────────────────── */}
        {tasksByMember.length > 0 && (
          <div style={{ marginBottom: 24, animation: "slideUp .4s ease .1s both" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
              Pending Tasks
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 12 }}>
              {tasksByMember.map(m => (
                <div key={m.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</span>
                    <span style={{ background: `${C.warn}22`, color: C.warn, border: `1px solid ${C.warn}44`, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>{m.tasks.length} pending</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {m.tasks.slice(0, 3).map(t => (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{ color: t.status === "in_progress" ? C.blue : C.muted }}>{t.status === "in_progress" ? "◑" : "○"}</span>
                        <span style={{ color: C.sub, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                        <span style={{ fontSize: 10 }}>{t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢"}</span>
                      </div>
                    ))}
                    {m.tasks.length > 3 && <div style={{ fontSize: 11, color: C.muted, paddingLeft: 16 }}>+{m.tasks.length - 3} more</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── OUTPUT SUMMARY ──────────────────────────────────── */}
        <div style={{ animation: "slideUp .4s ease .15s both" }}>

          {/* Controls */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 1 }}>
              Output Summary
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {presets.map(p => (
                <button key={p.label}
                  onClick={() => applyPreset(p.from, p.to)}
                  style={btnStyle(appliedFrom === p.from && appliedTo === p.to)}
                >
                  {p.label}
                </button>
              ))}
              <div style={{ width: 1, height: 20, background: C.border }}/>
              <span style={{ fontSize: 11, color: C.sub }}>From</span>
              <input
                type="date"
                value={inputFrom}
                onChange={e => setInputFrom(e.target.value)}
                onBlur={applyRange}
                style={inp}
              />
              <span style={{ fontSize: 11, color: C.sub }}>To</span>
              <input
                type="date"
                value={inputTo}
                onChange={e => setInputTo(e.target.value)}
                onBlur={applyRange}
                style={inp}
              />
              <button onClick={applyRange} style={{ ...btnStyle(false), background: C.accentDim, color: C.bg, border: "none" }}>
                Apply
              </button>
            </div>
          </div>

          {/* Stat cards */}
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <StatCard label="Fields Filled"   value={fmt(totalFilled)}      sub={`of ${fmt(totalPossible)} possible`}        icon="📊" color={C.accent}  delay={.15}/>
            <StatCard label="Completion Rate" value={`${overallPct}%`}      sub="across all submissions"                     icon="🎯" color={C.blue}    delay={.2}/>
            <StatCard label="Avg Fields/Day"  value={fmt(avgPerDay)}        sub="fields filled per day"                      icon="📈" color={C.purple}  delay={.25}/>
            <StatCard label="Best Day"        value={bestDay?.date || "—"}  sub={bestDay ? `${bestDay.filled} fields filled` : "no data"} icon="🏆" color={C.warn} delay={.3}/>
          </div>

          {/* Chart + leaderboard */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginBottom: 14 }}>

            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Daily Fields Filled</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>Total metric fields completed by the whole team each day</div>
              {dailyChart.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No submissions in this range</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dailyChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }}/>
                    <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                    <Tooltip content={<Tip/>}/>
                    <Bar dataKey="filled" fill={C.accent} radius={[4,4,0,0]} name="Fields Filled"/>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Output by Member</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>Fields filled / {TOTAL_FIELDS} per report, averaged</div>
              {memberStats.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No submissions</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {memberStats.map((m, i) => (
                    <div key={m.id}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: C.muted, width: 16, fontFamily: "monospace" }}>{i+1}</span>
                        <span style={{ fontSize: 13, flex: 1 }}>{m.name}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", color: C.accent }}>{m.avgFilled}/{TOTAL_FIELDS}</span>
                        <span style={{ fontSize: 11, color: C.muted }}>avg</span>
                      </div>
                      <div style={{ height: 4, background: C.elevated, borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ width: `${m.completionPct}%`, height: "100%", background: m.completionPct >= 80 ? C.success : m.completionPct >= 50 ? C.warn : C.danger, borderRadius: 2, transition: "width .6s ease" }}/>
                      </div>
                      <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
                        {m.reportCount} {m.reportCount === 1 ? "day" : "days"} · {m.completionPct}% completion · {fmt(m.totalFilled)} total fields
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── BREAKDOWN TABLE ─────────────────────────────── */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 14 }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>📋 Daily Breakdown by Member</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Click any cell to see full metric breakdown · Score = fields filled / {TOTAL_FIELDS}</div>
              </div>
              <div style={{ display: "flex", gap: 10, fontSize: 11, color: C.muted }}>
                <span style={{ background: `${C.success}22`, color: C.success, padding: "2px 8px", borderRadius: 4 }}>≥80%</span>
                <span style={{ background: `${C.warn}22`,    color: C.warn,    padding: "2px 8px", borderRadius: 4 }}>50–79%</span>
                <span style={{ background: `${C.danger}22`,  color: C.danger,  padding: "2px 8px", borderRadius: 4 }}>{"<50%"}</span>
              </div>
            </div>
            {dates.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: C.muted, fontSize: 13 }}>No submissions in this date range</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ position: "sticky", left: 0, background: C.elevated, padding: "10px 16px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 600, minWidth: 130 }}>
                        Date
                      </th>
                      {members.map(m => (
                        <th key={m.id} style={{ background: C.elevated, padding: "10px 12px", textAlign: "center", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 500, whiteSpace: "nowrap", fontSize: 11, minWidth: 100 }}>
                          {m.name}
                        </th>
                      ))}
                      <th style={{ position: "sticky", right: 0, background: C.elevated, padding: "10px 14px", textAlign: "center", borderBottom: `1px solid ${C.border}`, color: C.accent, fontWeight: 700, minWidth: 80 }}>
                        Team
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dates.map((d, idx) => {
                      const dayReports = rangeReports.filter(r => (r.report_date || r.date) === d);
                      const dayTotal   = dayReports.reduce((s, r) => s + scoreReport(r).filled, 0);
                      const dayPoss    = members.length * TOTAL_FIELDS;
                      const { bg: dayBg, text: dayCol } = cellColor(dayTotal, dayPoss);
                      return (
                        <tr key={d} style={{ background: idx % 2 ? `${C.elevated}55` : "transparent" }}>
                          <td style={{ position: "sticky", left: 0, background: idx % 2 ? C.elevated : C.card, padding: "10px 16px", fontWeight: 500, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                            {new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                          </td>
                          {members.map(m => {
                            const memberStats2 = memberStats.find(ms => ms.id === m.id);
                            const report = memberStats2?.reportsByDate?.[d] || null;
                            return <BreakdownCell key={m.id} report={report}/>;
                          })}
                          <td style={{ position: "sticky", right: 0, background: idx % 2 ? C.elevated : C.card, padding: "10px 14px", textAlign: "center", borderBottom: `1px solid ${C.border}` }}>
                            <span style={{ background: dayBg, color: dayCol, fontFamily: "monospace", fontWeight: 700, fontSize: 12, padding: "3px 8px", borderRadius: 4 }}>
                              {dayTotal}/{dayReports.length * TOTAL_FIELDS}
                            </span>
                          </td>
                        </tr>
                      );
                    })}

                    {/* Totals row */}
                    <tr style={{ background: `${C.accent}11` }}>
                      <td style={{ position: "sticky", left: 0, background: `${C.accent}22`, padding: "11px 16px", fontWeight: 700, color: C.accent, borderTop: `2px solid ${C.accent}44` }}>
                        TOTAL
                      </td>
                      {members.map(m => {
                        const ms = memberStats.find(x => x.id === m.id);
                        return (
                          <td key={m.id} style={{ padding: "11px 12px", textAlign: "center", borderTop: `2px solid ${C.accent}44` }}>
                            {ms ? (
                              <span style={{ fontFamily: "monospace", fontWeight: 700, color: C.accent, fontSize: 12 }}>
                                {ms.totalFilled}<span style={{ color: C.muted, fontWeight: 400 }}>/{ms.totalPossible}</span>
                              </span>
                            ) : <span style={{ color: C.muted }}>—</span>}
                          </td>
                        );
                      })}
                      <td style={{ position: "sticky", right: 0, background: `${C.accent}22`, padding: "11px 14px", textAlign: "center", fontFamily: "monospace", fontWeight: 700, color: C.accent, fontSize: 13, borderTop: `2px solid ${C.accent}44` }}>
                        {totalFilled}/{totalPossible}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
