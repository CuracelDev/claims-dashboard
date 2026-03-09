"use client";
import { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend,
} from "recharts";

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  chart: ["#00E5A0","#5B8DEF","#FF6B8A","#FFB84D","#A78BFA","#F472B6","#34D399"],
};

const fmt = n => n?.toLocaleString() ?? "0";

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
          <span style={{ fontWeight: 600, color: C.text, fontFamily: "monospace" }}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function OpsPage() {
  const [members, setMembers]       = useState([]);
  const [reports, setReports]       = useState([]);
  const [tasks, setTasks]           = useState([]);
  const [leave, setLeave]           = useState([]);
  const [loading, setLoading]       = useState(true);

  // Date range for output summary
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);

  const presets = [
    { label: "Today",      fn: () => { setFrom(today); setTo(today); } },
    { label: "This week",  fn: () => { const d = new Date(); d.setDate(d.getDate() - 6); setFrom(d.toISOString().slice(0,10)); setTo(today); } },
    { label: "30 days",    fn: () => { const d = new Date(); d.setDate(d.getDate() - 29); setFrom(d.toISOString().slice(0,10)); setTo(today); } },
    { label: "This month", fn: () => { const d = new Date(); setFrom(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`); setTo(today); } },
  ];

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [mRes, rRes, tRes, lRes] = await Promise.all([
          fetch("/api/team"),
          fetch(`/api/reports?from=${from}&to=${to}`),
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
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [from, to]);

  // ── Today's team status ──────────────────────────────────
  const todayStr = today;
  const todayReports = reports.filter(r => r.report_date === todayStr || r.date === todayStr);
  const submittedIds = new Set(todayReports.map(r => r.team_member_id || r.member_id));
  const onLeaveIds   = new Set(leave.map(l => l.team_member_id || l.member_id));

  const teamStatus = members.map(m => ({
    ...m,
    status: onLeaveIds.has(m.id) ? "leave" : submittedIds.has(m.id) ? "submitted" : "pending",
    report: todayReports.find(r => (r.team_member_id || r.member_id) === m.id),
  }));

  const submitted = teamStatus.filter(m => m.status === "submitted").length;
  const onLeave   = teamStatus.filter(m => m.status === "leave").length;
  const pending   = teamStatus.filter(m => m.status === "pending").length;

  // ── Pending tasks by member ──────────────────────────────
  const pendingTasks = tasks.filter(t => t.status !== "done");
  const tasksByMember = members.map(m => ({
    ...m,
    tasks: pendingTasks.filter(t => t.assigned_to === m.id),
  })).filter(m => m.tasks.length > 0);

  // ── Daily output summary (date range) ───────────────────
  const rangeReports = useMemo(() => {
    return reports.filter(r => {
      const d = r.report_date || r.date || "";
      return d >= from && d <= to;
    });
  }, [reports, from, to]);

  // Per-day totals
  const dailySummary = useMemo(() => {
    const map = {};
    for (const r of rangeReports) {
      const day = r.report_date || r.date;
      if (!day) continue;
      if (!map[day]) map[day] = { date: day, total: 0, members: 0 };
      map[day].total += r.total_output || r.output || 0;
      map[day].members++;
    }
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }, [rangeReports]);

  // Per-member totals for the range
  const memberTotals = useMemo(() => {
    const map = {};
    for (const r of rangeReports) {
      const id = r.team_member_id || r.member_id;
      const name = members.find(m => m.id === id)?.name || "Unknown";
      if (!map[id]) map[id] = { name, total: 0, days: 0 };
      map[id].total += r.total_output || r.output || 0;
      map[id].days++;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [rangeReports, members]);

  const totalOutput = memberTotals.reduce((s, m) => s + m.total, 0);
  const avgPerDay   = dailySummary.length > 0 ? Math.round(totalOutput / dailySummary.length) : 0;

  const inp = { background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", color: C.text, fontSize: 12, outline: "none" };
  const btnStyle = (on) => ({ background: on ? C.accent : "transparent", color: on ? C.bg : C.sub, border: `1px solid ${on ? C.accent : C.border}`, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" });

  const statusChip = (status) => {
    const config = {
      submitted: { bg: `${C.success}22`, color: C.success, border: `${C.success}44`, label: "✓ Submitted" },
      leave:     { bg: `${C.warn}22`,    color: C.warn,    border: `${C.warn}44`,    label: "⏸ On Leave" },
      pending:   { bg: `${C.muted}22`,   color: C.muted,   border: `${C.muted}44`,   label: "○ Pending" },
    }[status] || {};
    return (
      <span style={{ background: config.bg, color: config.color, border: `1px solid ${config.border}`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600 }}>
        {config.label}
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
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes fadeIn  { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pulse   { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(.7); cursor: pointer }
        ::-webkit-scrollbar { width: 6px; height: 6px }
        ::-webkit-scrollbar-track { background: ${C.bg} }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px }
      `}</style>

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg,${C.accent},#00B4D8)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: C.bg }}>C</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -.3 }}>Operations Overview</div>
            <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops · Team performance at a glance</div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: C.muted }}>
          📅 {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>

      <div style={{ padding: "20px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* ── TODAY'S TEAM STATUS ───────────────────────── */}
        <div style={{ marginBottom: 20, animation: "slideUp .4s ease both" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Today's Team Status
          </div>

          {/* Status summary cards */}
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <StatCard label="Submitted"  value={submitted} sub={`of ${members.length} members`} icon="✅" color={C.success} delay={.05}/>
            <StatCard label="Pending"    value={pending}   sub="not yet submitted"               icon="○"  color={C.muted}   delay={.1}/>
            <StatCard label="On Leave"   value={onLeave}   sub="absent today"                    icon="⏸" color={C.warn}    delay={.15}/>
            <StatCard label="Total Output" value={fmt(todayReports.reduce((s,r) => s + (r.total_output || r.output || 0), 0))} sub="claims processed today" icon="📊" color={C.accent} delay={.2}/>
          </div>

          {/* Member chips grid */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Member Status</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
              {teamStatus.map(m => (
                <div key={m.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8,
                  padding: "10px 14px",
                  borderLeft: `3px solid ${m.status === "submitted" ? C.success : m.status === "leave" ? C.warn : C.muted}`,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{m.name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {m.report && (
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: C.accent }}>
                        {fmt(m.report.total_output || m.report.output || 0)}
                      </span>
                    )}
                    {statusChip(m.status)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── PENDING TASKS ────────────────────────────── */}
        {tasksByMember.length > 0 && (
          <div style={{ marginBottom: 20, animation: "slideUp .4s ease .1s both" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
              Pending Tasks
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
              {tasksByMember.map(m => (
                <div key={m.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{m.name}</span>
                    <span style={{ background: `${C.warn}22`, color: C.warn, border: `1px solid ${C.warn}44`, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>
                      {m.tasks.length} pending
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {m.tasks.slice(0, 3).map(t => (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <span style={{ color: t.status === "in_progress" ? "#5B8DEF" : C.muted }}>
                          {t.status === "in_progress" ? "◑" : "○"}
                        </span>
                        <span style={{ color: C.sub, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                        <span style={{ color: t.priority === "high" ? C.danger : t.priority === "medium" ? C.warn : C.success, fontSize: 10 }}>
                          {t.priority === "high" ? "🔴" : t.priority === "medium" ? "🟡" : "🟢"}
                        </span>
                      </div>
                    ))}
                    {m.tasks.length > 3 && (
                      <div style={{ fontSize: 11, color: C.muted, paddingLeft: 16 }}>+{m.tasks.length - 3} more</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── DAILY OUTPUT SUMMARY ──────────────────────── */}
        <div style={{ animation: "slideUp .4s ease .15s both" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 1 }}>
              Output Summary
            </div>
            {/* Controls */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {presets.map(p => (
                <button key={p.label} onClick={p.fn} style={{ ...btnStyle(false), fontSize: 11, padding: "5px 10px" }}>{p.label}</button>
              ))}
              <div style={{ height: 20, width: 1, background: C.border }}/>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: C.sub }}>From</span>
                <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp}/>
                <span style={{ fontSize: 11, color: C.sub }}>To</span>
                <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp}/>
              </div>
            </div>
          </div>

          {/* Output stat cards */}
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <StatCard label="Total Output"   value={fmt(totalOutput)} sub={`${from} → ${to}`}           icon="📊" color={C.accent}  delay={.15}/>
            <StatCard label="Daily Average"  value={fmt(avgPerDay)}   sub="per working day"              icon="📈" color="#5B8DEF"  delay={.2}/>
            <StatCard label="Days Tracked"   value={dailySummary.length} sub="with submissions"         icon="📅" color="#A78BFA"  delay={.25}/>
            <StatCard label="Active Members" value={memberTotals.length} sub="submitted in range"       icon="👥" color={C.success} delay={.3}/>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Daily trend chart */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Daily Team Output</div>
              {dailySummary.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No data for this range</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dailySummary}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={d => d.slice(5)}/>
                    <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                    <Tooltip content={<Tip/>}/>
                    <Bar dataKey="total" fill={C.accent} radius={[4,4,0,0]} name="Total Output"/>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Per-member leaderboard */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Output by Member</div>
              {memberTotals.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No submissions</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {memberTotals.map((m, i) => (
                    <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: C.muted, width: 16, fontFamily: "monospace" }}>{i + 1}</span>
                      <span style={{ fontSize: 13, color: C.text, flex: 1 }}>{m.name}</span>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: C.accent, fontFamily: "monospace" }}>{fmt(m.total)}</span>
                        <span style={{ fontSize: 10, color: C.muted }}>{m.days}d · avg {fmt(Math.round(m.total / m.days))}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Daily per-member breakdown table */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, fontSize: 14, fontWeight: 600 }}>
              📋 Daily Breakdown by Member
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ position: "sticky", left: 0, top: 0, zIndex: 10, background: C.elevated, padding: "10px 14px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 600, minWidth: 120 }}>Member</th>
                    {dailySummary.map(d => (
                      <th key={d.date} style={{ background: C.elevated, padding: "10px 12px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 500, whiteSpace: "nowrap", fontSize: 10 }}>
                        {new Date(d.date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      </th>
                    ))}
                    <th style={{ position: "sticky", right: 0, background: C.elevated, padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.accent, fontWeight: 700 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Team total row */}
                  <tr style={{ background: `${C.accent}11` }}>
                    <td style={{ position: "sticky", left: 0, background: `${C.accent}22`, padding: "10px 14px", fontWeight: 700, color: C.accent, borderBottom: `2px solid ${C.accent}44` }}>TEAM TOTAL</td>
                    {dailySummary.map(d => (
                      <td key={d.date} style={{ padding: "10px 12px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: C.accent, borderBottom: `2px solid ${C.accent}44` }}>{fmt(d.total)}</td>
                    ))}
                    <td style={{ position: "sticky", right: 0, background: `${C.accent}22`, padding: "10px 14px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: C.accent, fontSize: 13, borderBottom: `2px solid ${C.accent}44` }}>{fmt(totalOutput)}</td>
                  </tr>
                  {memberTotals.map((m, idx) => {
                    // Get per-day values for this member
                    const memberReports = rangeReports.filter(r => {
                      const mid = members.find(mb => mb.name === m.name)?.id;
                      return (r.team_member_id || r.member_id) === mid;
                    });
                    const dayMap = {};
                    memberReports.forEach(r => { dayMap[r.report_date || r.date] = r.total_output || r.output || 0; });
                    return (
                      <tr key={m.name} style={{ background: idx % 2 ? `${C.elevated}44` : "transparent" }}>
                        <td style={{ position: "sticky", left: 0, background: idx % 2 ? C.elevated : C.card, padding: "9px 14px", fontWeight: 500, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{m.name}</td>
                        {dailySummary.map(d => {
                          const val = dayMap[d.date] || 0;
                          return (
                            <td key={d.date} style={{ padding: "9px 12px", textAlign: "right", fontFamily: "monospace", color: val === 0 ? C.muted : C.text, borderBottom: `1px solid ${C.border}` }}>
                              {val === 0 ? "—" : fmt(val)}
                            </td>
                          );
                        })}
                        <td style={{ position: "sticky", right: 0, background: idx % 2 ? C.elevated : C.card, padding: "9px 14px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: C.accent, borderBottom: `1px solid ${C.border}` }}>{fmt(m.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
