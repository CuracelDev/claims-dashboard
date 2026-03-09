"use client";
import { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend, PieChart, Pie, Cell,
} from "recharts";

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  chart: ["#00E5A0","#FF6B8A","#5B8DEF","#FFB84D","#A78BFA","#F472B6","#34D399","#F59E0B"],
};

const fmt = n => n?.toLocaleString() ?? "0";

const ISSUE_COLORS = {
  "Missing Vetting Comment": "#FFB84D",
  "Approved > Submitted":    "#FF5C5C",
  "Unit Price Mismatch":     "#FF6B8A",
  "Calculation Error":       "#A78BFA",
  "Approved Price Mismatch": "#5B8DEF",
  "High Quantity Outlier":   "#F472B6",
  "Other":                   "#8899AA",
};

function StatCard({ label, value, sub, icon, color = C.accent, delay = 0 }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 160, position: "relative", overflow: "hidden", animation: `slideUp .5s ease ${delay}s both` }}>
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
          <span style={{ flex: 1 }}>{p.name || p.dataKey}</span>
          <span style={{ fontWeight: 600, color: C.text, fontFamily: "monospace" }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function QADashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [insurer, setInsurer] = useState("");
  const [issueType, setIssueType] = useState("");
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  // Quick date presets
  const presets = [
    { label: "Today",    days: 0 },
    { label: "7 days",   days: 7 },
    { label: "30 days",  days: 30 },
    { label: "90 days",  days: 90 },
  ];

  function applyPreset(days) {
    const end = new Date();
    const start = new Date();
    if (days > 0) start.setDate(start.getDate() - days);
    setFrom(start.toISOString().slice(0, 10));
    setTo(end.toISOString().slice(0, 10));
    setPage(1);
  }

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to, limit: "1000" });
      if (insurer)   params.set("insurer", insurer);
      if (issueType) params.set("issue_type", issueType);
      if (provider)  params.set("provider", provider);
      const res = await fetch(`/api/qa-flags?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, [from, to, insurer, issueType, provider]);

  // Filtered flags for table
  const filteredFlags = useMemo(() => {
    if (!data?.flags) return [];
    const s = search.toLowerCase();
    return data.flags.filter(f =>
      !s ||
      (f.claim_id || "").toLowerCase().includes(s) ||
      (f.full_name || "").toLowerCase().includes(s) ||
      (f.provider_name || "").toLowerCase().includes(s) ||
      (f.issues || "").toLowerCase().includes(s)
    );
  }, [data, search]);

  const paginatedFlags = filteredFlags.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.ceil(filteredFlags.length / PAGE_SIZE);

  // Chart data
  const dailyTrend = data?.aggregations?.daily_trend || [];
  const byIssue    = data?.aggregations?.by_issue || [];
  const byInsurer  = data?.aggregations?.by_insurer || [];
  const topProviders = data?.aggregations?.top_providers || [];

  // Stat card values
  const total     = data?.total || 0;
  const topIssue  = byIssue[0]?.issue || "—";
  const topIns    = byInsurer[0]?.insurer || "—";
  const topProv   = topProviders[0]?.name || "—";

  // Unique insurer list for filter
  const insurerOptions = useMemo(() =>
    [...new Set((data?.flags || []).map(f => f.insurer_name).filter(Boolean))].sort(),
  [data]);

  const inp = { background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", color: C.text, fontSize: 12, outline: "none" };
  const btn = (on) => ({ background: on ? C.accent : "transparent", color: on ? C.bg : C.sub, border: `1px solid ${on ? C.accent : C.border}`, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .2s" });

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes fadeIn  { from { opacity: 0 } to { opacity: 1 } }
        ::-webkit-scrollbar { width: 6px; height: 6px }
        ::-webkit-scrollbar-track { background: ${C.bg} }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(.7); cursor: pointer }
        select { -webkit-appearance: auto; appearance: auto; cursor: pointer }
      `}</style>

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg,${C.accent},#00B4D8)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: C.bg }}>C</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -.3 }}>QA Flag Tracker</div>
            <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops · Claims Quality Assurance</div>
          </div>
        </div>
        <button onClick={fetchData} style={{ background: "transparent", border: `1px solid ${C.sub}`, color: C.sub, borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
          🔄 Refresh
        </button>
      </div>

      <div style={{ padding: "20px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* Filters */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 20px", marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", animation: "slideUp .4s ease both" }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>◉ Filters</div>

          {/* Date presets */}
          <div style={{ display: "flex", gap: 4 }}>
            {presets.map(p => (
              <button key={p.label} onClick={() => applyPreset(p.days)} style={{ ...btn(false), fontSize: 11, padding: "5px 10px" }}>{p.label}</button>
            ))}
          </div>

          <div style={{ height: 20, width: 1, background: C.border }}/>

          {/* Date range */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: C.sub }}>From</span>
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} style={inp}/>
            <span style={{ fontSize: 11, color: C.sub }}>To</span>
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} style={inp}/>
          </div>

          <div style={{ height: 20, width: 1, background: C.border }}/>

          {/* Insurer filter */}
          <select value={insurer} onChange={e => { setInsurer(e.target.value); setPage(1); }} style={inp}>
            <option value="">All Insurers</option>
            {insurerOptions.map(i => <option key={i} value={i}>{i}</option>)}
          </select>

          {/* Issue type filter */}
          <select value={issueType} onChange={e => { setIssueType(e.target.value); setPage(1); }} style={inp}>
            <option value="">All Issue Types</option>
            {Object.keys(ISSUE_COLORS).map(k => <option key={k} value={k}>{k}</option>)}
          </select>

          <div style={{ flex: 1 }}/>

          {/* Search */}
          <input placeholder="Search claim ID, name, provider..." value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            style={{ ...inp, width: 240 }}/>
        </div>

        {/* Stat Cards */}
        {!loading && data && (
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", animation: "slideUp .4s ease .05s both" }}>
            <StatCard label="Total Flags"      value={fmt(total)}    icon="🚨" color={C.danger}  delay={.05}/>
            <StatCard label="Top Issue"        value={byIssue[0]?.count || 0} sub={topIssue}  icon="⚠️" color={C.warn}   delay={.1}/>
            <StatCard label="Most Affected"    value={byInsurer[0]?.count || 0} sub={topIns}  icon="🏥" color="#5B8DEF" delay={.15}/>
            <StatCard label="Top Provider"     value={topProviders[0]?.count || 0} sub={topProv} icon="🏨" color="#A78BFA" delay={.2}/>
            <StatCard label="Days in Range"    value={Math.ceil((new Date(to) - new Date(from)) / 86400000) + 1} sub={`${from} → ${to}`} icon="📅" color={C.accent} delay={.25}/>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "40px", color: C.sub, fontSize: 13 }}>Loading QA data...</div>
        )}

        {error && (
          <div style={{ background: C.card, border: `1px solid ${C.danger}44`, borderRadius: 12, padding: 24, textAlign: "center", color: C.danger, marginBottom: 16 }}>
            ⚠️ {error}
          </div>
        )}

        {!loading && data && (
          <>
            {/* Charts row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14, animation: "fadeIn .4s ease" }}>

              {/* Daily trend */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>📈 Daily Flag Trend</div>
                {dailyTrend.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No data in range</div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={dailyTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={d => d.slice(5)}/>
                      <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                      <Tooltip content={<Tip/>}/>
                      <Line type="monotone" dataKey="total" stroke={C.danger} strokeWidth={2} dot={{ r: 3 }} name="Flags"/>
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Issue type breakdown */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>⚠️ Issues Breakdown</div>
                {byIssue.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={byIssue} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false}/>
                      <XAxis type="number" tick={{ fontSize: 10, fill: C.muted }}/>
                      <YAxis type="category" dataKey="issue" tick={{ fontSize: 9, fill: C.sub }} width={160}/>
                      <Tooltip content={<Tip/>}/>
                      <Bar dataKey="count" radius={[0,4,4,0]} name="Count">
                        {byIssue.map((entry, i) => (
                          <Cell key={i} fill={ISSUE_COLORS[entry.issue] || C.chart[i % C.chart.length]}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Second charts row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>

              {/* Insurer breakdown */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>🏥 Flags by Insurer</div>
                {byInsurer.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No data</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {byInsurer.map((item, i) => (
                      <div key={item.insurer} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontSize: 12, color: C.text, width: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.insurer}</span>
                        <div style={{ flex: 1, height: 22, background: C.elevated, borderRadius: 6, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${total > 0 ? (item.count / total * 100) : 0}%`, background: `linear-gradient(90deg,${C.chart[i % C.chart.length]},${C.chart[i % C.chart.length]}88)`, borderRadius: 6, display: "flex", alignItems: "center", paddingLeft: 8, transition: "width .5s ease" }}>
                            {(item.count / total * 100) > 10 && <span style={{ fontSize: 9, fontWeight: 600, color: C.bg }}>{(item.count / total * 100).toFixed(0)}%</span>}
                          </div>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: "monospace", width: 40, textAlign: "right" }}>{item.count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Top providers */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>🏨 Top Flagged Providers</div>
                {topProviders.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: 12, textAlign: "center", padding: "40px 0" }}>No data</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {topProviders.map((p, i) => (
                      <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontSize: 11, color: C.muted, width: 18, textAlign: "right", fontFamily: "monospace" }}>{i + 1}</span>
                        <span style={{ fontSize: 12, color: C.text, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: C.warn, fontFamily: "monospace" }}>{p.count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Flags Table */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 14, animation: "fadeIn .4s ease" }}>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>🚨 Flag Log <span style={{ fontSize: 12, color: C.muted, fontWeight: 400 }}>({filteredFlags.length} records)</span></div>
                <div style={{ fontSize: 11, color: C.muted }}>Page {page} of {totalPages || 1}</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                  <thead>
                    <tr>
                      {["Flagged At", "Claim ID", "Enrollee", "Provider", "Insurer", "Item", "Issue", "Bill Submitted", "Bill Approved", "Status"].map(h => (
                        <th key={h} style={{ position: "sticky", top: 0, background: C.elevated, padding: "10px 12px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedFlags.length === 0 ? (
                      <tr><td colSpan={10} style={{ padding: "32px", textAlign: "center", color: C.muted }}>No flags found</td></tr>
                    ) : paginatedFlags.map((f, i) => {
                      const issueColor = ISSUE_COLORS[categoriseIssue(f.issues || "")] || C.muted;
                      return (
                        <tr key={f.id} style={{ background: i % 2 ? `${C.elevated}44` : "transparent" }}>
                          <td style={{ padding: "9px 12px", color: C.muted, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{f.flagged_at ? new Date(f.flagged_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                          <td style={{ padding: "9px 12px", fontFamily: "monospace", color: C.accent, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{f.claim_id || "—"}</td>
                          <td style={{ padding: "9px 12px", color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{f.full_name || "—"}</td>
                          <td style={{ padding: "9px 12px", color: C.sub, borderBottom: `1px solid ${C.border}`, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.provider_name || "—"}</td>
                          <td style={{ padding: "9px 12px", color: C.sub, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{f.insurer_name || "—"}</td>
                          <td style={{ padding: "9px 12px", color: C.sub, borderBottom: `1px solid ${C.border}`, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.item_description || "—"}</td>
                          <td style={{ padding: "9px 12px", borderBottom: `1px solid ${C.border}`, maxWidth: 200 }}>
                            <span style={{ background: `${issueColor}22`, color: issueColor, border: `1px solid ${issueColor}44`, borderRadius: 4, padding: "2px 8px", fontSize: 10, whiteSpace: "nowrap" }}>
                              {f.issues ? f.issues.split(";")[0].trim() : "—"}
                            </span>
                          </td>
                          <td style={{ padding: "9px 12px", textAlign: "right", fontFamily: "monospace", color: C.text, borderBottom: `1px solid ${C.border}` }}>{f.bill_submitted?.toLocaleString() || "—"}</td>
                          <td style={{ padding: "9px 12px", textAlign: "right", fontFamily: "monospace", color: f.bill_approved > f.bill_submitted ? C.danger : C.text, borderBottom: `1px solid ${C.border}` }}>{f.bill_approved?.toLocaleString() || "—"}</td>
                          <td style={{ padding: "9px 12px", borderBottom: `1px solid ${C.border}` }}>
                            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: `${C.muted}22`, color: C.muted }}>{f.item_status || "—"}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "center", gap: 8 }}>
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    style={{ ...btn(false), opacity: page === 1 ? 0.4 : 1 }}>← Prev</button>
                  <span style={{ fontSize: 12, color: C.sub, padding: "7px 14px" }}>Page {page} of {totalPages}</span>
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    style={{ ...btn(false), opacity: page === totalPages ? 0.4 : 1 }}>Next →</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function categoriseIssue(issue) {
  const s = issue.toLowerCase();
  if (s.includes("missing vetting"))    return "Missing Vetting Comment";
  if (s.includes("approved >"))         return "Approved > Submitted";
  if (s.includes("unit price mismatch")) return "Unit Price Mismatch";
  if (s.includes("submitted calc"))     return "Calculation Error";
  if (s.includes("approved unit price")) return "Approved Price Mismatch";
  if (s.includes("high quantity"))      return "High Quantity Outlier";
  return "Other";
}
