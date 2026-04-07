"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend, PieChart, Pie, Cell,
  AreaChart, Area,
} from "recharts";
import { useTheme } from "./context/ThemeContext";

/* ── chart palette (not in ThemeContext, stable across themes) ── */
const CHART_COLORS = [
  "#00E5A0","#FF6B8A","#5B8DEF","#FFB84D","#A78BFA",
  "#F472B6","#34D399","#F59E0B","#EF4444","#8B5CF6",
  "#EC4899","#14B8A6","#6366F1","#F97316","#06B6D4","#84CC16",
];
const PERIOD_COLORS = ["#00E5A0","#5B8DEF","#FF6B8A","#FFB84D","#A78BFA"];

const fmt = (n) => n?.toLocaleString() ?? "0";
const pct = (n, t) => t ? ((n / t) * 100).toFixed(1) : "0.0";
const pctChange = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : ((cur - prev) / prev * 100);

/* ── week helpers (safe — guards against Invalid Date) ── */
const safeDateStr = (dt) => {
  try { return (dt instanceof Date && !isNaN(dt.getTime())) ? dt.toISOString().split("T")[0] : ""; }
  catch { return ""; }
};
const getWeekNumber = (d) => {
  const date = new Date(d); if (isNaN(date.getTime())) return 0;
  date.setHours(0,0,0,0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const w1 = new Date(date.getFullYear(), 0, 4);
  return Math.round(((date - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7) + 1;
};
const getMonday = (d) => {
  const date = new Date(d); if (isNaN(date.getTime())) return d || "";
  const day = date.getDay();
  return safeDateStr(new Date(date.setDate(date.getDate() - day + (day === 0 ? -6 : 1))));
};

/* ── shared components ──────────────────────────────────── */
function StatCard({ label, value, sub, icon, color, delay = 0 }) {
  const { C } = useTheme();
  const effectiveColor = color ?? C.accent;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 170, position: "relative", overflow: "hidden", animation: `slideUp .5s ease ${delay}s both` }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${effectiveColor},transparent)` }}/>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 6, letterSpacing: .5, textTransform: "uppercase", fontWeight: 500 }}>{icon} {label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: C.text, fontFamily: "'JetBrains Mono',monospace", letterSpacing: -1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Tip({ active, payload, label }) {
  const { C } = useTheme();
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", boxShadow: "0 8px 32px rgba(0,0,0,.5)" }}>
      <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, marginBottom: 5 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ fontSize: 11, color: C.sub, display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }}/>
          <span style={{ flex: 1, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || p.dataKey}</span>
          <span style={{ fontWeight: 600, color: C.text, fontFamily: "monospace" }}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Delta({ value, small }) {
  const { C } = useTheme();
  if (value === null || value === undefined || isNaN(value)) return <span style={{ color: C.muted, fontSize: small ? 10 : 12 }}>—</span>;
  const pos = value > 0, neutral = Math.abs(value) < 0.5;
  const color = neutral ? C.muted : pos ? C.success : C.danger;
  const arrow = neutral ? "→" : pos ? "↑" : "↓";
  return <span style={{ color, fontSize: small ? 10 : 12, fontWeight: 600, fontFamily: "monospace" }}>{arrow} {Math.abs(value).toFixed(1)}%</span>;
}

function Checkbox({ checked, onChange, label, color }) {
  const { C } = useTheme();
  const effectiveColor = color ?? C.accent;
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, color: checked ? C.text : C.muted, padding: "4px 0", userSelect: "none" }} onClick={onChange}>
      <div style={{
        width: 18, height: 18, borderRadius: 4, border: `2px solid ${checked ? effectiveColor : C.border}`,
        background: checked ? effectiveColor : "transparent", display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all .15s", flexShrink: 0,
      }}>
        {checked && <span style={{ color: C.bg, fontSize: 12, fontWeight: 700, lineHeight: 1 }}>✓</span>}
      </div>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </label>
  );
}

/* ═══════════ MAIN DASHBOARD ═══════════════════════════════ */
export default function Dashboard() {
  const { C } = useTheme();
  const CHART = CHART_COLORS;
  const PERIODS = PERIOD_COLORS;

  /* ── data state ─────────────────────────────────────── */
  const [rawData, setRawData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  /* ── greeting state ─────────────────────────────────── */
  const [memberName, setMemberName] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem('claims_intel_session'); const name = raw ? (JSON.parse(raw)?.member_name || '') : '';
    setMemberName(name.split(' ')[0]);
  }, []);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  /* ── filter state ───────────────────────────────────── */
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [dateField, setDateField] = useState("submitted_at");
  const [selected, setSelected] = useState(new Set());
  const [view, setView] = useState("overview");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("claims");
  const [sortDir, setSortDir] = useState("desc");

  /* ── slack state ────────────────────────────────────── */
  const [showSlack, setShowSlack] = useState(false);
  const [slackSent, setSlackSent] = useState(false);
  const [slackChans, setSlackChans] = useState(new Set(["#health-ops"]));
  const [slackInsurers, setSlackInsurers] = useState(new Set());
  const [slackResults, setSlackResults] = useState([]);
  const [sending, setSending] = useState(false);

  /* ── compare state ──────────────────────────────────── */
  const [compMode, setCompMode] = useState("month");
  const [compMonths, setCompMonths] = useState(new Set());
  const [customPeriods, setCustomPeriods] = useState([]);
  const [compInsurers, setCompInsurers] = useState(new Set());
  const [compView, setCompView] = useState("overview");
  const [monthRangeFrom, setMonthRangeFrom] = useState("");
  const [monthRangeTo, setMonthRangeTo] = useState("");
  const [newPeriodFrom, setNewPeriodFrom] = useState("");
  const [newPeriodTo, setNewPeriodTo] = useState("");
  const [newPeriodLabel, setNewPeriodLabel] = useState("");

  /* ── report state ──────────────────────────────────── */
  const [showReport, setShowReport] = useState(false);
  const [reportType, setReportType] = useState("mom");
  const [reportPeriods, setReportPeriods] = useState([]);
  const [reportChans, setReportChans] = useState(new Set(["#health-ops"]));
  const [reportInsurers, setReportInsurers] = useState(new Set());
  const [reportSending, setReportSending] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const [reportResults, setReportResults] = useState([]);
  const [reportCustomFrom, setReportCustomFrom] = useState("");
  const [reportCustomTo, setReportCustomTo] = useState("");
  const [reportCustomLabel, setReportCustomLabel] = useState("");

  /* ── fetch data ─────────────────────────────────────── */
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/claims?dateField=${dateField}`);
      const json = await res.json();
      if (json.success) {
        setRawData(json.data);
        setLastUpdate(json.updated_at);
        const dates = [...new Set(json.data.map(r => r.date).filter(Boolean))].sort();
        if (dates.length) {
          const start = dates[Math.max(0, dates.length - 30)];
          const end = dates[dates.length - 1];
          console.log(`[Claims] ${json.data.length} records, ${dates.length} unique dates: ${dates[0]} → ${end}, showing from ${start}`);
          setStartDate(start);
          setEndDate(end);
        }
        const ins = new Set(json.data.map(r => r.insurer).filter(Boolean));
        setSelected(ins);
        setCompInsurers(new Set(ins));
      } else setError(json.error);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [dateField]);

  useEffect(() => { fetchData(); }, [dateField]);

  /* ── derived: main views ────────────────────────────── */
  const allInsurers = useMemo(() => [...new Set(rawData.map(r => r.insurer))].sort(), [rawData]);

  const filtered = useMemo(() =>
    rawData.filter(r => r.date >= startDate && r.date <= endDate && selected.has(r.insurer)),
  [rawData, startDate, endDate, selected]);

  const dailyTotals = useMemo(() => {
    const m = {};
    filtered.forEach(r => { m[r.date] = (m[r.date] || 0) + r.claims_count; });
    return Object.entries(m).sort(([a],[b]) => a.localeCompare(b)).map(([date,total]) => ({ date, total }));
  }, [filtered]);

  const insurerTotals = useMemo(() => {
    const m = {};
    filtered.forEach(r => {
      if (!m[r.insurer]) m[r.insurer] = { insurer: r.insurer, total: 0, days: 0 };
      m[r.insurer].total += r.claims_count;
      if (r.claims_count > 0) m[r.insurer].days++;
    });
    const arr = Object.values(m);
    arr.sort((a, b) => sortBy === "claims"
      ? (sortDir === "desc" ? b.total - a.total : a.total - b.total)
      : (sortDir === "desc" ? b.insurer.localeCompare(a.insurer) : a.insurer.localeCompare(b.insurer)));
    return arr;
  }, [filtered, sortBy, sortDir]);

  const total = useMemo(() => filtered.reduce((s, r) => s + r.claims_count, 0), [filtered]);
  const avg = dailyTotals.length ? Math.round(total / dailyTotals.length) : 0;
  const peak = dailyTotals.reduce((mx, d) => d.total > (mx?.total || 0) ? d : mx, null);

  const trendData = useMemo(() => {
    const m = {};
    filtered.forEach(r => { if (!m[r.date]) m[r.date] = { date: r.date }; m[r.date][r.insurer] = r.claims_count; });
    return Object.values(m).sort((a, b) => a.date.localeCompare(b.date));
  }, [filtered]);

  const pivot = useMemo(() => {
    const dates = [...new Set(filtered.map(r => r.date))].sort();
    const ins = [...selected].sort();
    const m = {};
    filtered.forEach(r => { m[`${r.date}_${r.insurer}`] = r.claims_count; });
    return { dates, insurers: ins, map: m };
  }, [filtered, selected]);

  /* ── derived: compare mode ──────────────────────────── */
  const availableMonths = useMemo(() => {
    const s = new Set(); rawData.forEach(r => { if (r.date && r.date.length >= 7) s.add(r.date.slice(0, 7)); }); return [...s].sort();
  }, [rawData]);

  const dateRange = useMemo(() => {
    const dates = rawData.map(r => r.date).filter(Boolean).sort();
    return { min: dates[0] || "", max: dates[dates.length - 1] || "" };
  }, [rawData]);

  useEffect(() => {
    if (compMonths.size === 0 && availableMonths.length > 0)
      setCompMonths(new Set(availableMonths.slice(-3)));
    if (customPeriods.length === 0 && dateRange.max) {
      try {
        const end = new Date(dateRange.max + "T00:00:00");
        if (isNaN(end.getTime())) return;
        const p2start = new Date(end); p2start.setDate(p2start.getDate() - 6);
        const p1end = new Date(p2start); p1end.setDate(p1end.getDate() - 1);
        const p1start = new Date(p1end); p1start.setDate(p1start.getDate() - 6);
        setCustomPeriods([
          { id: 1, from: safeDateStr(p1start), to: safeDateStr(p1end), label: "Previous Period" },
          { id: 2, from: safeDateStr(p2start), to: safeDateStr(end), label: "Current Period" },
        ]);
      } catch (e) { console.warn("[Claims] Compare date init error:", e); }
    }
  }, [availableMonths, dateRange]);

  const compFilteredData = useMemo(() =>
    rawData.filter(r => compInsurers.has(r.insurer)),
  [rawData, compInsurers]);

  const monthCompData = useMemo(() => {
    const months = [...compMonths].sort();
    return months.map((month, idx) => {
      const records = compFilteredData.filter(r => r.date.startsWith(month));
      const totalVal = records.reduce((s, r) => s + r.claims_count, 0);
      const days = [...new Set(records.map(r => r.date))].length;
      const avgVal = days ? Math.round(totalVal / days) : 0;
      const byInsurer = {};
      records.forEach(r => { byInsurer[r.insurer] = (byInsurer[r.insurer] || 0) + r.claims_count; });
      const daily = {};
      records.forEach(r => { const d = parseInt(r.date.split("-")[2]); daily[d] = (daily[d] || 0) + r.claims_count; });
      return { month, total: totalVal, avg: avgVal, days, byInsurer, daily, color: PERIODS[idx % PERIODS.length] };
    });
  }, [compFilteredData, compMonths]);

  const customCompData = useMemo(() => {
    const sorted = [...customPeriods].sort((a, b) => a.from.localeCompare(b.from));
    return sorted.map((p, idx) => {
      const records = compFilteredData.filter(r => r.date >= p.from && r.date <= p.to);
      const totalVal = records.reduce((s, r) => s + r.claims_count, 0);
      const days = [...new Set(records.map(r => r.date))].length;
      const avgVal = days ? Math.round(totalVal / days) : 0;
      const byInsurer = {};
      records.forEach(r => { byInsurer[r.insurer] = (byInsurer[r.insurer] || 0) + r.claims_count; });
      const daily = {};
      records.forEach(r => {
        const dayNum = Math.floor((new Date(r.date) - new Date(p.from)) / 86400000) + 1;
        daily[`Day ${dayNum}`] = (daily[`Day ${dayNum}`] || 0) + r.claims_count;
      });
      const label = p.label || `${new Date(p.from).toLocaleDateString("en",{month:"short",day:"numeric"})} → ${new Date(p.to).toLocaleDateString("en",{month:"short",day:"numeric"})}`;
      return { ...p, label, total: totalVal, avg: avgVal, days, byInsurer, daily, color: PERIODS[idx % PERIODS.length] };
    });
  }, [compFilteredData, customPeriods]);

  const compPeriods = compMode === "month" ? monthCompData : customCompData;
  const compWithDeltas = compPeriods.map((p, i) => ({
    ...p,
    delta: i > 0 ? pctChange(p.total, compPeriods[i-1].total) : null,
    avgDelta: i > 0 ? pctChange(p.avg, compPeriods[i-1].avg) : null,
  }));

  const compOverlayData = useMemo(() => {
    if (compMode === "month") {
      return Array.from({length:31},(_,i)=>i+1).map(day => {
        const pt = { day: `Day ${day}` };
        monthCompData.forEach(m => { pt[m.month] = m.daily[day] || 0; });
        return pt;
      }).filter(p => monthCompData.some(m => (p[m.month] || 0) > 0));
    } else {
      const maxDays = Math.max(...customCompData.map(p => p.days), 1);
      return Array.from({length: maxDays}, (_, i) => {
        const pt = { day: `Day ${i + 1}` };
        customCompData.forEach(p => { pt[p.label] = p.daily[`Day ${i + 1}`] || 0; });
        return pt;
      });
    }
  }, [compMode, monthCompData, customCompData]);

  const compInsurerTable = useMemo(() => {
    const activeIns = [...compInsurers].sort();
    return activeIns.map(ins => {
      const row = { insurer: ins };
      compPeriods.forEach((p, i) => {
        const key = compMode === "month" ? p.month : p.label;
        row[key] = p.byInsurer[ins] || 0;
        if (i > 0) {
          const prev = compPeriods[i-1].byInsurer[ins] || 0;
          row[`${key}_delta`] = pctChange(row[key], prev);
        }
      });
      return row;
    }).sort((a, b) => {
      const lk = compMode === "month" ? compPeriods[compPeriods.length-1]?.month : compPeriods[compPeriods.length-1]?.label;
      return (b[lk] || 0) - (a[lk] || 0);
    });
  }, [compInsurers, compPeriods, compMode]);

  /* ── actions ────────────────────────────────────────── */
  const toggle = (name) => { const n = new Set(selected); n.has(name) ? n.delete(name) : n.add(name); setSelected(n); };

  const toggleCompMonth = (m) => {
    const n = new Set(compMonths);
    n.has(m) ? n.delete(m) : n.add(m);
    if (n.size > 0) setCompMonths(n);
  };
  const addCustomPeriod = () => {
    if (!newPeriodFrom || !newPeriodTo) return;
    const [f, t] = [newPeriodFrom, newPeriodTo].sort();
    const label = newPeriodLabel || `${new Date(f).toLocaleDateString("en",{month:"short",day:"numeric"})} → ${new Date(t).toLocaleDateString("en",{month:"short",day:"numeric"})}`;
    setCustomPeriods(prev => [...prev, { id: Date.now(), from: f, to: t, label }]);
    setNewPeriodFrom(""); setNewPeriodTo(""); setNewPeriodLabel("");
  };
  const removeCustomPeriod = (id) => {
    setCustomPeriods(prev => prev.filter(p => p.id !== id));
  };

  const applyMonthRange = (from, to) => {
    if (!from || !to) return;
    const [f, t] = [from, to].sort();
    setCompMonths(new Set(availableMonths.filter(m => m >= f && m <= t)));
  };
  const toggleCompInsurer = (ins) => {
    const n = new Set(compInsurers); n.has(ins) ? n.delete(ins) : n.add(ins); setCompInsurers(n);
  };

  /* ── report helpers ────────────────────────────────── */
  const d = (s) => { const dt = new Date(s + "T00:00:00"); return isNaN(dt.getTime()) ? new Date() : dt; };
  const ds = (dt) => safeDateStr(dt);
  const addDays = (dt, n) => { const r = new Date(dt); r.setDate(r.getDate() + n); return r; };

  const getReportPresets = () => {
    if (!dateRange.max) return [];
    const today = d(dateRange.max);
    const thisMonday = addDays(today, -(today.getDay() === 0 ? 6 : today.getDay() - 1));
    const lastMonday = addDays(thisMonday, -7);
    const lastSunday = addDays(thisMonday, -1);
    const thisMonth = dateRange.max.slice(0, 7);
    const lastMonthDt = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDt.getFullYear()}-${String(lastMonthDt.getMonth()+1).padStart(2,"0")}`;
    const prevMonthDt = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    const prevMonth = `${prevMonthDt.getFullYear()}-${String(prevMonthDt.getMonth()+1).padStart(2,"0")}`;
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth() - 1, 0);
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 2, 1);

    return {
      weekly: [{ id: 1, from: ds(lastMonday), to: ds(lastSunday), label: "Last Week" }],
      wow: [
        { id: 1, from: ds(addDays(lastMonday, -7)), to: ds(addDays(lastMonday, -1)), label: "2 Weeks Ago" },
        { id: 2, from: ds(lastMonday), to: ds(lastSunday), label: "Last Week" },
      ],
      monthly: [{ id: 1, from: ds(lastMonthStart), to: ds(lastMonthEnd), label: new Date(lastMonth+"-15").toLocaleDateString("en",{month:"long",year:"numeric"}) }],
      mom: [
        { id: 1, from: ds(prevMonthStart), to: ds(prevMonthEnd), label: new Date(prevMonth+"-15").toLocaleDateString("en",{month:"long",year:"numeric"}) },
        { id: 2, from: ds(lastMonthStart), to: ds(lastMonthEnd), label: new Date(lastMonth+"-15").toLocaleDateString("en",{month:"long",year:"numeric"}) },
      ],
      monthweek: [
        { id: 1, from: ds(lastMonthStart), to: ds(lastMonthEnd), label: new Date(lastMonth+"-15").toLocaleDateString("en",{month:"long",year:"numeric"}) },
        { id: 2, from: ds(lastMonday), to: ds(lastSunday), label: "Last Week" },
      ],
    };
  };

  const openReport = () => {
    const presets = getReportPresets();
    setReportType("mom");
    setReportPeriods(presets.mom || []);
    setReportInsurers(new Set(allInsurers));
    setReportSent(false); setReportResults([]);
    setReportCustomFrom(""); setReportCustomTo(""); setReportCustomLabel("");
    setShowReport(true);
  };

  const applyReportPreset = (type) => {
    setReportType(type);
    const presets = getReportPresets();
    if (type !== "custom") setReportPeriods(presets[type] || []);
  };

  const addReportPeriod = () => {
    if (!reportCustomFrom || !reportCustomTo) return;
    const [f, t] = [reportCustomFrom, reportCustomTo].sort();
    const label = reportCustomLabel || `${new Date(f).toLocaleDateString("en",{month:"short",day:"numeric"})} → ${new Date(t).toLocaleDateString("en",{month:"short",day:"numeric"})}`;
    setReportPeriods(prev => [...prev, { id: Date.now(), from: f, to: t, label }]);
    setReportCustomFrom(""); setReportCustomTo(""); setReportCustomLabel("");
  };

  const reportComputed = useMemo(() => {
    const rFiltered = rawData.filter(r => reportInsurers.has(r.insurer));
    return [...reportPeriods].sort((a, b) => a.from.localeCompare(b.from)).map((p, idx) => {
      const records = rFiltered.filter(r => r.date >= p.from && r.date <= p.to);
      const totalVal = records.reduce((s, r) => s + r.claims_count, 0);
      const days = [...new Set(records.map(r => r.date))].length;
      const avgVal = days ? Math.round(totalVal / days) : 0;
      const byInsurer = {};
      records.forEach(r => { byInsurer[r.insurer] = (byInsurer[r.insurer] || 0) + r.claims_count; });
      return { ...p, total: totalVal, avg: avgVal, days, byInsurer };
    });
  }, [rawData, reportPeriods, reportInsurers]);

  const sendReport = async () => {
    setReportSending(true);
    const periods = reportComputed;
    const hasDelta = periods.length > 1;
    const lines = [`📋 *Claims Intelligence Report*`, ``];
    periods.forEach((p, i) => {
      lines.push(`*${p.label}* (${p.from} → ${p.to})`);
      lines.push(`  🏥 Total Claims: *${fmt(p.total)}*`);
      lines.push(`  📊 Daily Avg: *${fmt(p.avg)}* | ${p.days} days`);
      if (i > 0 && hasDelta) {
        const prev = periods[i-1];
        const delta = pctChange(p.total, prev.total);
        const arrow = delta > 0 ? "📈" : delta < 0 ? "📉" : "➡️";
        lines.push(`  ${arrow} Change: *${delta > 0 ? "+" : ""}${delta.toFixed(1)}%* vs ${prev.label}`);
      }
      lines.push(``);
    });
    const last = periods[periods.length - 1];
    if (last) {
      const sorted = Object.entries(last.byInsurer).sort((a,b) => b[1]-a[1]).slice(0, 10);
      lines.push(`*Top Insurers (${last.label}):*`);
      sorted.forEach(([name, count], i) => {
        let delta = "";
        if (hasDelta && periods.length > 1) {
          const prev = periods[periods.length - 2];
          const prevCount = prev.byInsurer[name] || 0;
          const change = pctChange(count, prevCount);
          delta = ` (${change > 0 ? "+" : ""}${change.toFixed(1)}%)`;
        }
        lines.push(`${i+1}. ${name}: *${fmt(count)}*${delta}`);
      });
    }
    lines.push(``, `_Sent from Claims Intelligence Dashboard_`);
    const message = lines.join("\n");
    try {
      const res = await fetch("/api/slack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: [...reportChans], message }),
      });
      const json = await res.json();
      setReportResults(json.results || []);
      setReportSent(true);
      setTimeout(() => { setShowReport(false); setReportSent(false); }, 3000);
    } catch (e) { console.error(e); }
    setReportSending(false);
  };

  const downloadCSV = () => {
    const { dates, insurers, map } = pivot;
    let csv = "Insurer," + dates.join(",") + ",Total\n";
    csv += "TOTAL," + dates.map(d => { let s=0; insurers.forEach(i => s += map[`${d}_${i}`]||0); return s; }).join(",") + "," + total + "\n";
    insurers.forEach(ins => {
      let rt=0; const vals = dates.map(d => { const v = map[`${d}_${ins}`]||0; rt+=v; return v; });
      csv += `"${ins}",${vals.join(",")},${rt}\n`;
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `claims_${startDate}_to_${endDate}.csv`;
    a.click();
  };

  const openSlackModal = () => {
    setSlackInsurers(new Set(selected)); setSlackSent(false); setSlackResults([]); setShowSlack(true);
  };

  const sendSlack = async () => {
    setSending(true);
    const slackData = filtered.filter(r => slackInsurers.has(r.insurer));
    const slackTotal = slackData.reduce((s, r) => s + r.claims_count, 0);
    const slackDays = [...new Set(slackData.map(r => r.date))].length;
    const slackAvg = slackDays ? Math.round(slackTotal / slackDays) : 0;
    const insBreakdown = {};
    slackData.forEach(r => { insBreakdown[r.insurer] = (insBreakdown[r.insurer]||0) + r.claims_count; });
    const sorted = Object.entries(insBreakdown).sort((a,b) => b[1]-a[1]);
    const message = [
      `📊 *Claims Intelligence Report*`,
      `📅 Period: ${startDate} → ${endDate}`,
      ``,
      `🏥 Total Claims: *${fmt(slackTotal)}*`,
      `📈 Daily Average: *${fmt(slackAvg)}*`,
      `🔥 Peak Day: *${peak ? `${fmt(peak.total)} (${peak.date})` : "—"}*`,
      `🏢 Insurers: *${slackInsurers.size}* selected`,
      ``, `*Breakdown:*`,
      ...sorted.map(([name, count], i) => `${i+1}. ${name}: *${fmt(count)}* (${(count/slackTotal*100).toFixed(1)}%)`),
      ``, `_Sent from Claims Intelligence Dashboard_`
    ].join("\n");
    try {
      const res = await fetch("/api/slack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: [...slackChans], message }),
      });
      const json = await res.json();
      setSlackResults(json.results || []);
      setSlackSent(true);
      setTimeout(() => { setShowSlack(false); setSlackSent(false); }, 3000);
    } catch (e) { console.error(e); }
    setSending(false);
  };

  /* ── styles ─────────────────────────────────────────── */
  const inp = { background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", fontFamily: "'JetBrains Mono',monospace" };
  const btn = (on) => ({ background: on ? C.accent : "transparent", color: on ? C.bg : C.sub, border: `1px solid ${on ? C.accent : C.border}`, borderRadius: 8, padding: "8px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .2s" });
  const abtn = (color = C.accent) => ({ background: "transparent", border: `1px solid ${color}`, color, borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, transition: "all .2s" });

  /* ── loading / error ────────────────────────────────── */
  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans',sans-serif" }}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 48, height: 48, margin: "0 auto 16px", position: "relative" }}>
          <div style={{ width: 48, height: 48, borderRadius: "50%", border: `3px solid ${C.border}`, borderTopColor: C.accent, animation: "spin 0.8s linear infinite" }}/>
        </div>
        <div style={{ color: C.sub, fontSize: 14 }}>Loading claims data...</div>
      </div>
    </div>
  );

  if (error) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ background: C.card, border: `1px solid ${C.danger}44`, borderRadius: 12, padding: 32, maxWidth: 400, textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <div style={{ color: C.danger, fontWeight: 600, marginBottom: 8 }}>Connection Error</div>
        <div style={{ color: C.sub, fontSize: 13, marginBottom: 16 }}>{error}</div>
        <button onClick={fetchData} style={{ ...abtn(C.accent), justifyContent: "center" }}>🔄 Retry</button>
      </div>
    </div>
  );

  const VIEWS = ["overview","table","trends","compare"];

  /* ════════════════ RENDER ════════════════════════════════ */
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans',sans-serif" }}>
      <style>{`
        @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
        input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(.7);cursor:pointer}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
        select{-webkit-appearance:auto;appearance:auto;cursor:pointer}
      `}</style>

      {/* ── HEADER ──────────────────────────────────────── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg,${C.accent},#00B4D8)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: C.bg }}>C</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -.3 }}>Claims Intelligence</div>
            <div style={{ fontSize: 10, color: C.muted }}>Curacel Health Ops • {rawData.length} records{lastUpdate && ` • Updated ${new Date(lastUpdate).toLocaleTimeString()}`}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fetchData} style={abtn(C.sub)} title="Refresh">🔄 Refresh</button>
          <button onClick={downloadCSV} style={abtn(C.accent)}>⬇ CSV</button>
          <button onClick={openReport} style={abtn("#A78BFA")}>📋 Report</button>
          <button onClick={openSlackModal} style={abtn("#5B8DEF")}>💬 Slack</button>
        </div>
      </div>

      <div style={{ padding: "20px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* ── GREETING ────────────────────────────────────── */}
        {memberName && (
          <div style={{ marginBottom: 20, animation: 'slideUp .4s ease both' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: -0.5 }}>
              {greeting} {memberName} 👋
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
              Live operational overview · {new Date().toLocaleDateString('en-GB', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              })}
            </div>
          </div>
        )}

        {/* ── FILTERS BAR ──────────────────────────────── */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 20px", marginBottom: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, animation: "slideUp .4s ease both" }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>◉ Filters</div>
          {view !== "compare" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: C.sub }}>Date By</span>
                <select value={dateField} onChange={e => setDateField(e.target.value)} style={{ ...inp, cursor: "pointer" }}>
                  <option value="submitted_at">Submitted</option>
                  <option value="created_at">Created</option>
                </select>
                <span style={{ fontSize: 11, color: C.sub }}>From</span>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inp}/>
                <span style={{ fontSize: 11, color: C.sub }}>To</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inp}/>
              </div>
              <div style={{ height: 24, width: 1, background: C.border }}/>
              <button onClick={() => setSelected(new Set(allInsurers))} style={{ ...btn(selected.size === allInsurers.length), fontSize: 11, padding: "6px 12px" }}>All ({allInsurers.length})</button>
              <button onClick={() => setSelected(new Set())} style={{ ...btn(selected.size === 0), fontSize: 11, padding: "6px 12px" }}>None</button>
            </>
          )}
          <div style={{ flex: 1 }}/>
          <div style={{ display: "flex", gap: 4 }}>
            {VIEWS.map(v => (
              <button key={v} onClick={() => setView(v)} style={btn(view === v)}>
                {v === "overview" ? "📊 Overview" : v === "table" ? "📋 Table" : v === "trends" ? "📈 Trends" : "🔄 Compare"}
              </button>
            ))}
          </div>
        </div>

        {/* ── INSURER CHIPS (non-compare views) ─────────── */}
        {view !== "compare" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18, animation: "slideUp .5s ease .1s both" }}>
            {allInsurers.map((ins, i) => {
              const on = selected.has(ins);
              return (
                <button key={ins} onClick={() => toggle(ins)} style={{
                  background: on ? `${CHART[i % CHART.length]}22` : "transparent",
                  border: `1px solid ${on ? CHART[i % CHART.length] : C.border}`,
                  color: on ? CHART[i % CHART.length] : C.muted,
                  borderRadius: 20, padding: "5px 14px", fontSize: 11, cursor: "pointer",
                  fontWeight: on ? 600 : 400, transition: "all .2s",
                }}>{on ? "✓ " : ""}{ins}</button>
              );
            })}
          </div>
        )}

        {/* ── STATS (non-compare views) ────────────────── */}
        {view !== "compare" && (
          <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
            <StatCard label="Total Claims" value={fmt(total)} sub={`${dailyTotals.length} days`} icon="🏥" delay={.1}/>
            <StatCard label="Daily Average" value={fmt(avg)} sub="per day" icon="📊" color="#5B8DEF" delay={.15}/>
            <StatCard label="Peak Day" value={peak ? fmt(peak.total) : "—"} sub={peak?.date||"—"} icon="🔥" color={C.warn} delay={.2}/>
            <StatCard label="Active Insurers" value={selected.size} sub={`of ${allInsurers.length}`} icon="🏢" color="#A78BFA" delay={.25}/>
          </div>
        )}

        {/* ═══════════ OVERVIEW VIEW ═══════════════════════ */}
        {view === "overview" && (
          <div style={{ animation: "fadeIn .4s ease" }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14, marginBottom: 14 }}>
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Daily Claims Volume</div>
                <ResponsiveContainer width="100%" height={270}>
                  <AreaChart data={dailyTotals}>
                    <defs><linearGradient id="aG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.accent} stopOpacity={.3}/><stop offset="95%" stopColor={C.accent} stopOpacity={0}/></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={d => d.slice(5)}/>
                    <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                    <Tooltip content={<Tip/>}/>
                    <Area type="monotone" dataKey="total" stroke={C.accent} fill="url(#aG)" strokeWidth={2} name="Total Claims"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Distribution</div>
                <ResponsiveContainer width="100%" height={270}>
                  <PieChart><Pie data={insurerTotals} dataKey="total" nameKey="insurer" cx="50%" cy="50%" outerRadius={85} innerRadius={48} paddingAngle={2}>
                    {insurerTotals.map((_,i) => <Cell key={i} fill={CHART[i%CHART.length]}/>)}
                  </Pie><Tooltip content={<Tip/>}/></PieChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
                <span>Insurer Rankings</span>
                <button onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")} style={{ ...btn(false), fontSize: 10, padding: "4px 10px" }}>{sortDir === "desc" ? "↓ Highest" : "↑ Lowest"}</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {insurerTotals.map((it, i) => (
                  <div key={it.insurer} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: C.muted, width: 20, textAlign: "right", fontFamily: "monospace" }}>{i+1}</span>
                    <span style={{ fontSize: 12, color: C.text, width: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.insurer}</span>
                    <div style={{ flex: 1, height: 22, background: C.elevated, borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct(it.total,total)}%`, background: `linear-gradient(90deg,${CHART[i%CHART.length]},${CHART[i%CHART.length]}88)`, borderRadius: 6, transition: "width .5s ease", display: "flex", alignItems: "center", paddingLeft: 8 }}>
                        {parseFloat(pct(it.total,total)) > 8 && <span style={{ fontSize: 9, fontWeight: 600, color: C.bg }}>{pct(it.total,total)}%</span>}
                      </div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: "monospace", width: 80, textAlign: "right" }}>{fmt(it.total)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════ TABLE VIEW ═══════════════════════════ */}
        {view === "table" && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", animation: "fadeIn .4s ease" }}>
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>📋 Pivot Table — Insurers × Dates</div>
              <input placeholder="Search insurer..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...inp, width: 200, fontSize: 12 }}/>
            </div>
            <div style={{ overflow: "auto", maxHeight: 520 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                <thead><tr>
                  <th style={{ position: "sticky", left: 0, top: 0, zIndex: 10, background: C.elevated, padding: "10px 14px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 600, minWidth: 180 }}>Insurer</th>
                  {pivot.dates.map(d => <th key={d} style={{ position: "sticky", top: 0, zIndex: 5, background: C.elevated, padding: "10px 10px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 500, whiteSpace: "nowrap", fontSize: 10 }}>{d.slice(5)}</th>)}
                  <th style={{ position: "sticky", top: 0, right: 0, zIndex: 10, background: C.elevated, padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.accent, fontWeight: 700 }}>Total</th>
                </tr></thead>
                <tbody>
                  <tr style={{ background: `${C.accent}11` }}>
                    <td style={{ position: "sticky", left: 0, background: `${C.accent}22`, padding: "10px 14px", fontWeight: 700, color: C.accent, borderBottom: `2px solid ${C.accent}44` }}>TOTAL</td>
                    {pivot.dates.map(d => { let s=0; pivot.insurers.forEach(ins => s += pivot.map[`${d}_${ins}`]||0); return <td key={d} style={{ padding: "10px 10px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: C.accent, borderBottom: `2px solid ${C.accent}44` }}>{fmt(s)}</td>; })}
                    <td style={{ position: "sticky", right: 0, background: `${C.accent}22`, padding: "10px 14px", textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: C.accent, fontSize: 13, borderBottom: `2px solid ${C.accent}44` }}>{fmt(total)}</td>
                  </tr>
                  {pivot.insurers.filter(ins => ins.toLowerCase().includes(search.toLowerCase())).map((ins, idx) => {
                    let rt = 0;
                    return (
                      <tr key={ins} style={{ background: idx%2 ? `${C.elevated}44` : "transparent" }}>
                        <td style={{ position: "sticky", left: 0, background: idx%2 ? C.elevated : C.card, padding: "8px 14px", fontWeight: 500, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: CHART[allInsurers.indexOf(ins)%CHART.length], marginRight: 8 }}/>{ins}
                        </td>
                        {pivot.dates.map(d => { const v = pivot.map[`${d}_${ins}`]||0; rt+=v; return <td key={d} style={{ padding: "8px 10px", textAlign: "right", fontFamily: "monospace", color: v===0 ? C.muted : C.text, fontSize: 10, borderBottom: `1px solid ${C.border}` }}>{fmt(v)}</td>; })}
                        <td style={{ position: "sticky", right: 0, background: idx%2 ? C.elevated : C.card, padding: "8px 14px", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>{fmt(rt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ═══════════ TRENDS VIEW ═════════════════════════ */}
        {view === "trends" && (
          <div style={{ animation: "fadeIn .4s ease" }}>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Claims Trend by Insurer</div>
              <ResponsiveContainer width="100%" height={380}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={d => d.slice(5)}/>
                  <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                  <Tooltip content={<Tip/>}/><Legend wrapperStyle={{ fontSize: 10 }}/>
                  {[...selected].sort().map(ins => <Line key={ins} type="monotone" dataKey={ins} stroke={CHART[allInsurers.indexOf(ins)%CHART.length]} strokeWidth={2} dot={false} name={ins}/>)}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Daily Total Trend</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={dailyTotals}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={d => d.slice(5)}/>
                  <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                  <Tooltip content={<Tip/>}/>
                  <Bar dataKey="total" fill={C.accent} radius={[3,3,0,0]} name="Total Claims"/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* ═══════════ COMPARE VIEW ══════════════════════ */}
        {view === "compare" && (
          <div style={{ animation: "fadeIn .4s ease" }}>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <button onClick={() => setCompMode("month")} style={btn(compMode === "month")}>📊 Month-over-Month</button>
                <button onClick={() => setCompMode("custom")} style={btn(compMode === "custom")}>📅 Custom Periods</button>
                <div style={{ flex: 1 }}/>
                <div style={{ display: "flex", gap: 4 }}>
                  {["overview","chart","table"].map(v => (
                    <button key={v} onClick={() => setCompView(v)} style={{ ...btn(compView === v), fontSize: 11, padding: "6px 12px" }}>
                      {v === "overview" ? "📊 Overview" : v === "chart" ? "📈 Overlay" : "📋 Table"}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
                    {compMode === "month" ? "Select Months" : "Define Periods"}
                  </div>
                  <span style={{ fontSize: 11, color: C.sub }}>{compMode === "month" ? compMonths.size : customPeriods.length} selected</span>
                  <div style={{ flex: 1 }}/>
                  {compMode === "month" && <>
                    <button onClick={() => setCompMonths(new Set(availableMonths))} style={{ ...btn(false), fontSize: 10, padding: "3px 10px" }}>All</button>
                    <button onClick={() => setCompMonths(new Set([availableMonths[availableMonths.length-1]]))} style={{ ...btn(false), fontSize: 10, padding: "3px 10px" }}>Reset</button>
                  </>}
                  {compMode === "custom" && <button onClick={() => setCustomPeriods([])} style={{ ...btn(false), fontSize: 10, padding: "3px 10px" }}>Clear All</button>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "10px 14px", background: C.elevated, borderRadius: 8, border: `1px solid ${C.border}`, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: C.accent, fontWeight: 600 }}>📅 Range:</span>
                  {compMode === "month" ? (<>
                    <select value={monthRangeFrom} onChange={e => setMonthRangeFrom(e.target.value)} style={{ ...inp, fontSize: 11, padding: "5px 8px", minWidth: 120 }}>
                      <option value="">From month...</option>
                      {availableMonths.map(m => <option key={m} value={m}>{new Date(m+"-15").toLocaleDateString("en",{month:"short",year:"numeric"})}</option>)}
                    </select>
                    <span style={{ color: C.muted }}>→</span>
                    <select value={monthRangeTo} onChange={e => setMonthRangeTo(e.target.value)} style={{ ...inp, fontSize: 11, padding: "5px 8px", minWidth: 120 }}>
                      <option value="">To month...</option>
                      {availableMonths.map(m => <option key={m} value={m}>{new Date(m+"-15").toLocaleDateString("en",{month:"short",year:"numeric"})}</option>)}
                    </select>
                    <button onClick={() => applyMonthRange(monthRangeFrom, monthRangeTo)} disabled={!monthRangeFrom || !monthRangeTo}
                      style={{ background: C.accent, color: C.bg, border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer", opacity: (!monthRangeFrom || !monthRangeTo) ? .4 : 1 }}>Apply Range</button>
                  </>) : (<>
                    <input type="date" value={newPeriodFrom} onChange={e => setNewPeriodFrom(e.target.value)} style={{ ...inp, fontSize: 11, padding: "5px 8px" }}/>
                    <span style={{ color: C.muted }}>→</span>
                    <input type="date" value={newPeriodTo} onChange={e => setNewPeriodTo(e.target.value)} style={{ ...inp, fontSize: 11, padding: "5px 8px" }}/>
                    <input value={newPeriodLabel} onChange={e => setNewPeriodLabel(e.target.value)} placeholder="Label (optional)" style={{ ...inp, fontSize: 11, padding: "5px 8px", width: 130 }}/>
                    <button onClick={addCustomPeriod} disabled={!newPeriodFrom || !newPeriodTo}
                      style={{ background: C.accent, color: C.bg, border: "none", borderRadius: 6, padding: "5px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer", opacity: (!newPeriodFrom || !newPeriodTo) ? .4 : 1 }}>+ Add Period</button>
                  </>)}
                  {compMode === "month" && <span style={{ fontSize: 10, color: C.muted, fontStyle: "italic" }}>or pick individually below</span>}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {compMode === "month" ? (
                    availableMonths.map(m => {
                      const on = compMonths.has(m);
                      const idx = [...compMonths].sort().indexOf(m);
                      const color = on ? PERIODS[idx%PERIODS.length] : C.muted;
                      return (
                        <button key={m} onClick={() => toggleCompMonth(m)} style={{
                          background: on ? `${color}22` : "transparent", border: `1px solid ${on ? color : C.border}`,
                          color: on ? color : C.muted, borderRadius: 20, padding: "6px 16px", fontSize: 11,
                          cursor: "pointer", fontWeight: on ? 600 : 400, transition: "all .2s",
                        }}>{on ? "✓ " : ""}{new Date(m+"-15").toLocaleDateString("en",{month:"short",year:"numeric"})}</button>
                      );
                    })
                  ) : (
                    customPeriods.length === 0 ? (
                      <div style={{ fontSize: 12, color: C.muted, padding: "8px 0" }}>No periods added yet. Use the date pickers above to add comparison periods.</div>
                    ) : [...customPeriods].sort((a,b) => a.from.localeCompare(b.from)).map((p, idx) => (
                      <div key={p.id} style={{ background: `${PERIODS[idx%PERIODS.length]}15`, border: `1px solid ${PERIODS[idx%PERIODS.length]}`, borderRadius: 10, padding: "8px 14px", fontSize: 11, display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ width: 10, height: 10, borderRadius: "50%", background: PERIODS[idx%PERIODS.length], flexShrink: 0 }}/>
                        <span style={{ fontWeight: 600, color: PERIODS[idx%PERIODS.length] }}>{p.label}</span>
                        <span style={{ color: C.sub, fontSize: 10 }}>{p.from} → {p.to}</span>
                        <span style={{ color: C.sub, fontSize: 10 }}>({Math.round((new Date(p.to) - new Date(p.from)) / 86400000) + 1} days)</span>
                        <button onClick={() => removeCustomPeriod(p.id)} style={{ background: "transparent", border: "none", color: C.danger, cursor: "pointer", fontSize: 14, padding: "0 4px", fontWeight: 700 }}>×</button>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Insurers</div>
                  <button onClick={() => setCompInsurers(new Set(allInsurers))} style={{ ...btn(compInsurers.size === allInsurers.length), fontSize: 10, padding: "3px 10px" }}>All</button>
                  <button onClick={() => setCompInsurers(new Set())} style={{ ...btn(compInsurers.size === 0), fontSize: 10, padding: "3px 10px" }}>None</button>
                  <span style={{ fontSize: 11, color: C.sub }}>{compInsurers.size} selected</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 4 }}>
                  {allInsurers.map((ins, i) => (
                    <Checkbox key={ins} checked={compInsurers.has(ins)} onChange={() => toggleCompInsurer(ins)} label={ins} color={CHART[i%CHART.length]}/>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              {compWithDeltas.map((p, i) => (
                <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 22px", flex: 1, minWidth: 200, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg,${p.color},transparent)` }}/>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: p.color }}>
                      {compMode === "month" ? new Date(p.month+"-15").toLocaleDateString("en",{month:"long",year:"numeric"}) : p.label}
                    </div>
                    <Delta value={p.delta}/>
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", letterSpacing: -1 }}>{fmt(p.total)}</div>
                  <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: C.sub }}>Avg: <span style={{ color: C.text, fontWeight: 600, fontFamily: "monospace" }}>{fmt(p.avg)}</span>/day</div>
                    <div style={{ fontSize: 11, color: C.sub }}>{p.days} days</div>
                  </div>
                </div>
              ))}
            </div>

            {compView === "overview" && (
              <div>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{compMode === "month" ? "Month-over-Month" : "Period-over-Period"} Total Claims</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={compWithDeltas.map(p => ({ name: compMode === "month" ? new Date(p.month+"-15").toLocaleDateString("en",{month:"short",year:"2-digit"}) : p.label, total: p.total, avg: p.avg }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: C.sub }}/>
                      <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                      <Tooltip content={<Tip/>}/>
                      <Bar dataKey="total" name="Total Claims" radius={[6,6,0,0]}>
                        {compWithDeltas.map((p,i) => <Cell key={i} fill={p.color}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Growth Summary</div>
                  <div style={{ overflow: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                      <thead><tr>
                        <th style={{ padding: "10px 14px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.sub }}>Period</th>
                        <th style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub }}>Total</th>
                        <th style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub }}>Daily Avg</th>
                        <th style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub }}>Days</th>
                        <th style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub }}>Δ Total</th>
                        <th style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.sub }}>Δ Avg</th>
                      </tr></thead>
                      <tbody>{compWithDeltas.map((p,i) => (
                        <tr key={i} style={{ background: i%2 ? `${C.elevated}44` : "transparent" }}>
                          <td style={{ padding: "10px 14px", fontWeight: 600, color: p.color, borderBottom: `1px solid ${C.border}` }}>
                            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: p.color, marginRight: 8 }}/>
                            {compMode === "month" ? new Date(p.month+"-15").toLocaleDateString("en",{month:"long",year:"numeric"}) : p.label}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontFamily: "monospace", fontWeight: 600, color: C.text, borderBottom: `1px solid ${C.border}` }}>{fmt(p.total)}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontFamily: "monospace", color: C.text, borderBottom: `1px solid ${C.border}` }}>{fmt(p.avg)}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right", fontFamily: "monospace", color: C.sub, borderBottom: `1px solid ${C.border}` }}>{p.days}</td>
                          <td style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}` }}><Delta value={p.delta}/></td>
                          <td style={{ padding: "10px 14px", textAlign: "right", borderBottom: `1px solid ${C.border}` }}><Delta value={p.avgDelta}/></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {compView === "chart" && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                  {compMode === "month" ? "Daily Pattern Overlay (by day of month)" : "Daily Pattern Overlay (by day in period)"}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>Compare patterns across selected {compMode === "month" ? "months" : "periods"}</div>
                <ResponsiveContainer width="100%" height={380}>
                  <LineChart data={compOverlayData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                    <XAxis dataKey="day" tick={{ fontSize: 10, fill: C.muted }}/>
                    <YAxis tick={{ fontSize: 10, fill: C.muted }}/>
                    <Tooltip content={<Tip/>}/><Legend wrapperStyle={{ fontSize: 11 }}/>
                    {compPeriods.map(p => {
                      const key = compMode === "month" ? p.month : p.label;
                      const label = compMode === "month" ? new Date(p.month+"-15").toLocaleDateString("en",{month:"short",year:"2-digit"}) : p.label;
                      return <Line key={key} type="monotone" dataKey={key} stroke={p.color} strokeWidth={2.5} dot={{ r: 3 }} name={label}/>;
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {compView === "table" && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, fontSize: 14, fontWeight: 600 }}>📋 Insurer Comparison Across Periods</div>
                <div style={{ overflow: "auto", maxHeight: 520 }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ position: "sticky", left: 0, top: 0, zIndex: 10, background: C.elevated, padding: "10px 14px", textAlign: "left", borderBottom: `1px solid ${C.border}`, color: C.sub, fontWeight: 600, minWidth: 180 }}>Insurer</th>
                        {compPeriods.map((p,i) => {
                          const label = compMode === "month" ? new Date(p.month+"-15").toLocaleDateString("en",{month:"short",year:"2-digit"}) : p.label;
                          return <th key={i} colSpan={i > 0 ? 2 : 1} style={{ position: "sticky", top: 0, zIndex: 5, background: C.elevated, padding: "10px 12px", textAlign: "center", borderBottom: `1px solid ${C.border}`, color: p.color, fontWeight: 600 }}>{label}</th>;
                        })}
                      </tr>
                      <tr>
                        <th style={{ position: "sticky", left: 0, zIndex: 10, background: C.elevated, padding: "4px 14px", borderBottom: `1px solid ${C.border}` }}/>
                        {compPeriods.map((p,i) => {
                          if (i === 0) return <th key={i} style={{ background: C.elevated, padding: "4px 12px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.muted, fontSize: 9 }}>Claims</th>;
                          return [
                            <th key={`${i}a`} style={{ background: C.elevated, padding: "4px 12px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.muted, fontSize: 9 }}>Claims</th>,
                            <th key={`${i}b`} style={{ background: C.elevated, padding: "4px 12px", textAlign: "right", borderBottom: `1px solid ${C.border}`, color: C.muted, fontSize: 9 }}>Δ</th>
                          ];
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {compInsurerTable.map((row, idx) => (
                        <tr key={row.insurer} style={{ background: idx%2 ? `${C.elevated}44` : "transparent" }}>
                          <td style={{ position: "sticky", left: 0, background: idx%2 ? C.elevated : C.card, padding: "8px 14px", fontWeight: 500, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: CHART[allInsurers.indexOf(row.insurer)%CHART.length], marginRight: 8 }}/>{row.insurer}
                          </td>
                          {compPeriods.map((p,i) => {
                            const key = compMode === "month" ? p.month : p.label;
                            const val = row[key] || 0;
                            const delta = row[`${key}_delta`];
                            if (i === 0) return <td key={i} style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: C.text, borderBottom: `1px solid ${C.border}` }}>{fmt(val)}</td>;
                            return [
                              <td key={`${i}a`} style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", color: C.text, borderBottom: `1px solid ${C.border}` }}>{fmt(val)}</td>,
                              <td key={`${i}b`} style={{ padding: "8px 12px", textAlign: "right", borderBottom: `1px solid ${C.border}` }}><Delta value={delta} small/></td>
                            ];
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══════════ SLACK MODAL ══════════════════════════ */}
      {showSlack && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s ease" }} onClick={() => setShowSlack(false)}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, width: 480, maxHeight: "85vh", overflowY: "auto", animation: "slideUp .3s ease" }} onClick={e => e.stopPropagation()}>
            {slackSent ? (
              <div style={{ textAlign: "center", padding: 20 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: C.accent }}>Sent to Slack!</div>
                <div style={{ fontSize: 13, color: C.sub, marginTop: 8 }}>
                  {slackResults.map((r,i) => <div key={i} style={{ color: r.success ? C.success : C.danger }}>{r.channel}: {r.success ? "✓ Delivered" : `✗ ${r.error}`}</div>)}
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>💬 Send to Slack</div>
                <div style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>Share this claims report with your team</div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, fontWeight: 600 }}>Channels</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {["#health-ops","#customer-success"].map(ch => (
                      <Checkbox key={ch} checked={slackChans.has(ch)} onChange={() => { const n = new Set(slackChans); n.has(ch) ? n.delete(ch) : n.add(ch); setSlackChans(n); }} label={ch} color="#5B8DEF"/>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Include Insurers</div>
                    <button onClick={() => setSlackInsurers(new Set(allInsurers))} style={{ ...btn(false), fontSize: 10, padding: "2px 8px" }}>All</button>
                    <button onClick={() => setSlackInsurers(new Set())} style={{ ...btn(false), fontSize: 10, padding: "2px 8px" }}>None</button>
                  </div>
                  <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                    {allInsurers.map((ins,i) => (
                      <Checkbox key={ins} checked={slackInsurers.has(ins)} onChange={() => { const n = new Set(slackInsurers); n.has(ins) ? n.delete(ins) : n.add(ins); setSlackInsurers(n); }} label={ins} color={CHART[i%CHART.length]}/>
                    ))}
                  </div>
                </div>
                <div style={{ background: C.elevated, borderRadius: 8, padding: 14, marginBottom: 16, border: `1px solid ${C.border}`, fontSize: 12, color: C.sub, lineHeight: 1.8 }}>
                  <div style={{ fontWeight: 600, color: C.text, marginBottom: 4 }}>Preview:</div>
                  📊 <strong style={{ color: C.accent }}>Claims Report</strong> ({startDate} → {endDate})<br/>
                  🏥 Total: <strong style={{ color: C.text }}>{fmt(total)}</strong> claims<br/>
                  📈 Daily Avg: <strong style={{ color: C.text }}>{fmt(avg)}</strong><br/>
                  🔥 Peak: <strong style={{ color: C.text }}>{peak ? `${fmt(peak.total)} (${peak.date})` : "—"}</strong><br/>
                  🏢 Insurers: <strong style={{ color: C.text }}>{slackInsurers.size}</strong> selected
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setShowSlack(false)} style={{ ...abtn(C.muted), padding: "10px 20px" }}>Cancel</button>
                  <button onClick={sendSlack} disabled={sending || slackChans.size === 0} style={{ background: C.accent, color: C.bg, border: "none", borderRadius: 8, padding: "10px 24px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: (sending || slackChans.size === 0) ? .5 : 1 }}>{sending ? "Sending..." : "Send Report"}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ REPORT MODAL ═════════════════════════ */}
      {showReport && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .2s ease" }} onClick={() => setShowReport(false)}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, width: 560, maxHeight: "90vh", overflowY: "auto", animation: "slideUp .3s ease" }} onClick={e => e.stopPropagation()}>
            {reportSent ? (
              <div style={{ textAlign: "center", padding: 20 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: "#A78BFA" }}>Report Sent!</div>
                <div style={{ fontSize: 13, color: C.sub, marginTop: 8 }}>
                  {reportResults.map((r,i) => <div key={i} style={{ color: r.success ? C.success : C.danger }}>{r.channel}: {r.success ? "✓ Delivered" : `✗ ${r.error}`}</div>)}
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>📋 Report Builder</div>
                <div style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>Build a comparison report and send to Slack</div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, fontWeight: 600 }}>Report Type</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {[
                      { key: "weekly", label: "📅 Last Week", desc: "Single week summary" },
                      { key: "wow", label: "📊 WoW", desc: "Week vs previous week" },
                      { key: "monthly", label: "🗓️ Last Month", desc: "Single month summary" },
                      { key: "mom", label: "📈 MoM", desc: "Month vs previous month" },
                      { key: "monthweek", label: "📋 Month + Week", desc: "Last month & last week" },
                      { key: "custom", label: "✏️ Custom", desc: "Pick your own periods" },
                    ].map(t => (
                      <button key={t.key} onClick={() => applyReportPreset(t.key)} style={{
                        background: reportType === t.key ? `#A78BFA22` : C.elevated,
                        border: `1px solid ${reportType === t.key ? "#A78BFA" : C.border}`,
                        color: reportType === t.key ? "#A78BFA" : C.sub,
                        borderRadius: 8, padding: "8px 14px", fontSize: 11, cursor: "pointer",
                        fontWeight: reportType === t.key ? 700 : 400, transition: "all .15s", textAlign: "left",
                      }}>
                        <div>{t.label}</div>
                        <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>{t.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
                {reportType === "custom" && (
                  <div style={{ marginBottom: 14, padding: 12, background: C.elevated, borderRadius: 8, border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 11, color: "#A78BFA", fontWeight: 600, marginBottom: 8 }}>Add Custom Period</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <input type="date" value={reportCustomFrom} onChange={e => setReportCustomFrom(e.target.value)} style={{ ...inp, fontSize: 11, padding: "5px 8px" }} min={dateRange.min} max={dateRange.max}/>
                      <span style={{ color: C.muted }}>→</span>
                      <input type="date" value={reportCustomTo} onChange={e => setReportCustomTo(e.target.value)} style={{ ...inp, fontSize: 11, padding: "5px 8px" }} min={dateRange.min} max={dateRange.max}/>
                      <input value={reportCustomLabel} onChange={e => setReportCustomLabel(e.target.value)} placeholder="Label" style={{ ...inp, fontSize: 11, padding: "5px 8px", width: 110 }}/>
                      <button onClick={addReportPeriod} disabled={!reportCustomFrom || !reportCustomTo}
                        style={{ background: "#A78BFA", color: C.bg, border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", opacity: (!reportCustomFrom || !reportCustomTo) ? .4 : 1 }}>+ Add</button>
                    </div>
                  </div>
                )}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, fontWeight: 600 }}>Periods ({reportPeriods.length})</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {reportPeriods.length === 0 ? (
                      <div style={{ fontSize: 12, color: C.muted, padding: 8 }}>No periods selected. Pick a report type above.</div>
                    ) : [...reportPeriods].sort((a,b) => a.from.localeCompare(b.from)).map((p, idx) => {
                      const comp = reportComputed[idx];
                      return (
                        <div key={p.id} style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, borderLeft: `3px solid ${PERIODS[idx % PERIODS.length]}` }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{p.label}</div>
                            <div style={{ fontSize: 10, color: C.muted }}>{p.from} → {p.to}</div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "monospace", color: C.text }}>{comp ? fmt(comp.total) : "—"}</div>
                            <div style={{ fontSize: 10, color: C.sub }}>{comp ? `${comp.days}d • avg ${fmt(comp.avg)}` : ""}</div>
                          </div>
                          {idx > 0 && comp && reportComputed[idx-1] && (
                            <Delta value={pctChange(comp.total, reportComputed[idx-1].total)}/>
                          )}
                          {reportType === "custom" && (
                            <button onClick={() => setReportPeriods(prev => prev.filter(x => x.id !== p.id))} style={{ background: "transparent", border: "none", color: C.danger, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>×</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 8, fontWeight: 600 }}>Send to Channels</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {["#health-ops","#customer-success"].map(ch => (
                      <Checkbox key={ch} checked={reportChans.has(ch)} onChange={() => { const n = new Set(reportChans); n.has(ch) ? n.delete(ch) : n.add(ch); setReportChans(n); }} label={ch} color="#5B8DEF"/>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Insurers</div>
                    <button onClick={() => setReportInsurers(new Set(allInsurers))} style={{ ...btn(false), fontSize: 10, padding: "2px 8px" }}>All</button>
                    <button onClick={() => setReportInsurers(new Set())} style={{ ...btn(false), fontSize: 10, padding: "2px 8px" }}>None</button>
                    <span style={{ fontSize: 10, color: C.sub }}>{reportInsurers.size} selected</span>
                  </div>
                  <div style={{ maxHeight: 120, overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
                    {allInsurers.map((ins,i) => (
                      <Checkbox key={ins} checked={reportInsurers.has(ins)} onChange={() => { const n = new Set(reportInsurers); n.has(ins) ? n.delete(ins) : n.add(ins); setReportInsurers(n); }} label={ins} color={CHART[i%CHART.length]}/>
                    ))}
                  </div>
                </div>
                <div style={{ background: C.elevated, borderRadius: 8, padding: 14, marginBottom: 16, border: `1px solid ${C.border}`, fontSize: 11, color: C.sub, lineHeight: 1.8, maxHeight: 180, overflowY: "auto" }}>
                  <div style={{ fontWeight: 600, color: C.text, marginBottom: 6, fontSize: 12 }}>Preview:</div>
                  📋 <strong style={{ color: "#A78BFA" }}>Claims Intelligence Report</strong><br/>
                  {[...reportPeriods].sort((a,b) => a.from.localeCompare(b.from)).map((p, idx) => {
                    const comp = reportComputed[idx];
                    return (
                      <div key={p.id} style={{ marginTop: 6, paddingLeft: 8, borderLeft: `2px solid ${PERIODS[idx % PERIODS.length]}` }}>
                        <strong style={{ color: C.text }}>{p.label}</strong> ({p.from} → {p.to})<br/>
                        🏥 Total: <strong style={{ color: C.text }}>{comp ? fmt(comp.total) : "—"}</strong> | Avg: <strong style={{ color: C.text }}>{comp ? fmt(comp.avg) : "—"}</strong>/day | {comp?.days || 0} days
                        {idx > 0 && comp && reportComputed[idx-1] && (() => {
                          const delta = pctChange(comp.total, reportComputed[idx-1].total);
                          return <span style={{ color: delta > 0 ? C.success : delta < 0 ? C.danger : C.muted, fontWeight: 600 }}> {delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} {Math.abs(delta).toFixed(1)}%</span>;
                        })()}
                      </div>
                    );
                  })}
                  {reportComputed.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <strong style={{ color: C.text }}>Top Insurers ({reportComputed[reportComputed.length-1]?.label}):</strong><br/>
                      {Object.entries(reportComputed[reportComputed.length-1]?.byInsurer || {}).sort((a,b) => b[1]-a[1]).slice(0,5).map(([name,count],i) => (
                        <div key={name}>{i+1}. {name}: <strong style={{ color: C.text }}>{fmt(count)}</strong></div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setShowReport(false)} style={{ ...abtn(C.muted), padding: "10px 20px" }}>Cancel</button>
                  <button onClick={sendReport} disabled={reportSending || reportChans.size === 0 || reportPeriods.length === 0} style={{ background: "#A78BFA", color: C.bg, border: "none", borderRadius: 8, padding: "10px 24px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: (reportSending || reportChans.size === 0 || reportPeriods.length === 0) ? .5 : 1 }}>{reportSending ? "Sending..." : `📨 Send to ${reportChans.size} channel${reportChans.size > 1 ? "s" : ""}`}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
