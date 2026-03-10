'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

/* ─── helpers ───────────────────────────────────────────────── */
const todayISO = () => new Date().toISOString().split('T')[0];

const fmtDate = (iso) =>
  new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const daysLeft = (endISO) => {
  const end = new Date(endISO + 'T23:59:59');
  const now = new Date();
  const diff = Math.ceil((end - now) / 86400000);
  return Math.max(0, diff);
};

const weekStart = () => {
  const d = new Date();
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return mon.toISOString().split('T')[0];
};

const weekEnd = () => {
  const d = new Date(weekStart() + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return d.toISOString().split('T')[0];
};

/* ─── progress calculation per type ────────────────────────── */
const calcProgress = (target, logs) => {
  if (!logs || logs.length === 0) return { actual: null, pct: 0, display: '—' };
  const lastLog = logs[logs.length - 1];

  if (target.type === 'yesno') {
    const done = logs.some(l => l.value === 'yes');
    return { actual: done ? 'Yes' : 'No', pct: done ? 100 : 0, display: done ? '✅ Yes' : '❌ No' };
  }
  if (target.type === 'percentage') {
    const val = parseFloat(lastLog.value) || 0;
    const pct = Math.min((val / target.target_value) * 100, 100);
    return { actual: val, pct, display: `${val}%` };
  }
  // number
  const total = logs.reduce((s, l) => s + (parseFloat(l.value) || 0), 0);
  const pct = target.target_value > 0 ? Math.min((total / target.target_value) * 100, 100) : 0;
  return { actual: total, pct, display: total.toLocaleString() };
};

const statusColor = (pct, C) => {
  if (pct >= 100) return '#00E5A0';
  if (pct >= 70)  return C.warn;
  return C.danger;
};

const statusLabel = (pct) => {
  if (pct >= 100) return '✅ Hit';
  if (pct >= 70)  return '⚡ Close';
  return '❌ Off track';
};

/* ─── sub-components ────────────────────────────────────────── */
function ProgressRing({ pct, color, size = 56 }) {
  const r = (size / 2) - 5;
  const circ = 2 * Math.PI * r;
  const fill = (Math.min(pct, 100) / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1E2D45" strokeWidth="4" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.6s ease' }} />
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="middle"
        style={{ transform: `rotate(90deg) translate(0,0)`, transformOrigin: `${size/2}px ${size/2}px` }}
        fill={color} fontSize="10" fontWeight="700" fontFamily="monospace">
        {pct.toFixed(0)}%
      </text>
    </svg>
  );
}

function TypeBadge({ type, C }) {
  const map = {
    number:     { label: '123', bg: C.blue + '22',    color: C.blue    },
    yesno:      { label: 'Y/N', bg: C.purple + '22',  color: C.purple  },
    percentage: { label: '%',   bg: C.warn + '22',    color: C.warn    },
  };
  const m = map[type] || map.number;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
      background: m.bg, color: m.color, marginRight: 6 }}>
      {m.label}
    </span>
  );
}

function LogModal({ target, C, onSubmit, onClose }) {
  const [val, setVal] = useState('');
  const [note, setNote] = useState('');

  const S = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 },
    box: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14,
      padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' },
    label: { fontSize: 11, fontWeight: 600, color: C.sub, marginBottom: 5, display: 'block' },
    input: { width: '100%', background: C.inputBg, border: `1px solid ${C.accent}66`,
      borderRadius: 8, color: C.text, padding: '10px 13px', fontSize: 15,
      fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' },
    textInput: { width: '100%', background: C.inputBg, border: `1px solid ${C.border}`,
      borderRadius: 8, color: C.text, padding: '9px 12px', fontSize: 13,
      outline: 'none', boxSizing: 'border-box', marginBottom: 14 },
    btn: (primary) => ({
      flex: 1, padding: '10px', border: primary ? 'none' : `1px solid ${C.border}`,
      borderRadius: 8, fontWeight: primary ? 700 : 400, fontSize: 13, cursor: 'pointer',
      background: primary ? C.accent : C.elevated, color: primary ? '#0B0F1A' : C.sub,
    }),
  };

  return (
    <div style={S.overlay}>
      <div style={S.box}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 4 }}>
          📊 Log Progress
        </div>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 20 }}>{target.name}</div>

        <label style={S.label}>
          {target.type === 'yesno'
            ? 'Status'
            : target.type === 'percentage'
            ? 'Completion % (e.g. 72)'
            : 'Count / value for today'}
        </label>

        {target.type === 'yesno' ? (
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            {['yes', 'no'].map(v => (
              <button key={v} onClick={() => setVal(v)} style={{
                flex: 1, padding: '10px', borderRadius: 8, fontWeight: 700, fontSize: 14,
                cursor: 'pointer', border: `2px solid ${val === v ? C.accent : C.border}`,
                background: val === v ? `${C.accent}18` : C.elevated,
                color: val === v ? C.accent : C.sub,
              }}>
                {v === 'yes' ? '✅ Yes' : '❌ No'}
              </button>
            ))}
          </div>
        ) : (
          <input
            type="number" value={val}
            onChange={e => setVal(e.target.value)}
            placeholder={target.type === 'percentage' ? '0 – 100' : 'Enter count…'}
            style={{ ...S.input, marginBottom: 14 }}
          />
        )}

        <label style={S.label}>Note (optional)</label>
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="Any context…" style={S.textInput} />

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => val !== '' && onSubmit(val, note)} style={S.btn(true)}>Submit</button>
          <button onClick={onClose} style={S.btn(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function NewTargetModal({ C, onSave, onClose }) {
  const [form, setForm] = useState({
    name: '', type: 'number', target_value: '',
    start_date: weekStart(), end_date: weekEnd(), metric_key: '', description: '',
  });

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const S = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 },
    box: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14,
      padding: 28, width: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.5)', maxHeight: '90vh', overflowY: 'auto' },
    label: { fontSize: 11, fontWeight: 600, color: C.sub, marginBottom: 5, display: 'block', marginTop: 12 },
    input: { width: '100%', background: C.inputBg, border: `1px solid ${C.border}`,
      borderRadius: 8, color: C.text, padding: '9px 12px', fontSize: 13,
      outline: 'none', boxSizing: 'border-box' },
    btn: (primary) => ({
      flex: 1, padding: '10px', border: primary ? 'none' : `1px solid ${C.border}`,
      borderRadius: 8, fontWeight: primary ? 700 : 400, fontSize: 13, cursor: 'pointer',
      background: primary ? C.accent : C.elevated, color: primary ? '#0B0F1A' : C.sub,
    }),
  };

  const TYPES = [
    { key: 'number',     label: '🔢 Number',     desc: 'Count something (e.g. items mapped, claims checked)' },
    { key: 'yesno',      label: '✅ Yes / No',   desc: 'Did it happen? (e.g. training done, process updated)' },
    { key: 'percentage', label: '📊 Percentage', desc: 'Track % completion (e.g. 80% of backlog cleared)' },
  ];

  return (
    <div style={S.overlay}>
      <div style={S.box}>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 4 }}>🎯 New Target</div>
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 20 }}>
          Set a weekly goal the whole team can log progress on
        </div>

        <label style={S.label}>Target Name *</label>
        <input value={form.name} onChange={e => set('name', e.target.value)}
          placeholder="e.g. Care Items Mapped this week"
          style={S.input} />

        <label style={S.label}>Type *</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {TYPES.map(t => (
            <div key={t.key} onClick={() => set('type', t.key)} style={{
              padding: '10px 8px', borderRadius: 9, cursor: 'pointer', textAlign: 'center',
              border: `2px solid ${form.type === t.key ? C.accent : C.border}`,
              background: form.type === t.key ? `${C.accent}12` : C.elevated,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: form.type === t.key ? C.accent : C.text }}>{t.label}</div>
              <div style={{ fontSize: 9, color: C.muted, marginTop: 3, lineHeight: 1.3 }}>{t.desc}</div>
            </div>
          ))}
        </div>

        {form.type !== 'yesno' && (
          <>
            <label style={S.label}>
              Target Value * {form.type === 'percentage' ? '(%)' : ''}
            </label>
            <input type="number" value={form.target_value}
              onChange={e => set('target_value', e.target.value)}
              placeholder={form.type === 'percentage' ? '100' : 'e.g. 400000'}
              style={S.input} />
          </>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
          <div>
            <label style={S.label}>Start Date *</label>
            <input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label}>End Date *</label>
            <input type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} style={S.input} />
          </div>
        </div>

        <label style={S.label}>Description (optional)</label>
        <input value={form.description} onChange={e => set('description', e.target.value)}
          placeholder="What does success look like?"
          style={S.input} />

        <label style={S.label}>Linked Metric Key (optional)</label>
        <select value={form.metric_key} onChange={e => set('metric_key', e.target.value)}
          style={{ ...S.input, marginBottom: 4 }}>
          <option value="">— Not linked to a metric —</option>
          {['care_items_mapped','resolved_cares','care_items_grouped','providers_mapped',
            'claims_kenya','claims_tanzania','claims_uganda','claims_uap',
            'flagged_care_items','icd10_adjusted','benefits_set_up','providers_assigned',
          ].map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
        </select>
        <div style={{ fontSize: 10, color: C.muted, marginBottom: 16 }}>
          If linked, the target auto-populates from daily reports
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => {
              if (!form.name.trim()) return;
              if (form.type !== 'yesno' && !form.target_value) return;
              onSave({ ...form, target_value: parseFloat(form.target_value) || 100 });
            }}
            style={S.btn(true)}>
            Save Target
          </button>
          <button onClick={onClose} style={S.btn(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function TargetCard({ target, logs, C, onLog, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const prog = calcProgress(target, logs);
  const color = statusColor(prog.pct, C);
  const dl = daysLeft(target.end_date);
  const today = todayISO();
  const loggedToday = logs.some(l => l.date === today);

  // Daily needed alert (number type only)
  const dailyNeeded = target.type === 'number' && target.target_value > prog.actual && dl > 0
    ? Math.ceil((target.target_value - (prog.actual || 0)) / dl)
    : null;

  const atRisk = prog.pct < 50 && dl <= 3;
  const periodActive = today >= target.start_date && today <= target.end_date;

  // Build day-by-day chart data for number targets
  const chartBars = target.type === 'number' && logs.length > 0
    ? logs.slice(-7).map(l => ({ date: l.date.slice(5), val: parseFloat(l.value) || 0 }))
    : [];

  return (
    <div style={{
      background: C.card, border: `1.5px solid ${color}33`,
      borderRadius: 12, overflow: 'hidden', marginBottom: 12,
    }}>
      {/* Top bar */}
      <div style={{ height: 3, background: C.border }}>
        <div style={{
          height: '100%', width: `${prog.pct}%`,
          background: `linear-gradient(90deg, ${color}88, ${color})`,
          transition: 'width 0.6s ease',
        }} />
      </div>

      {/* Card header */}
      <div style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', gap: 14, alignItems: 'center' }}
        onClick={() => setExpanded(e => !e)}>

        <ProgressRing pct={prog.pct} color={color} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 5 }}>
            <TypeBadge type={target.type} C={C} />
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text, marginRight: 4 }}>{target.name}</span>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: color + '22', color, whiteSpace: 'nowrap' }}>
              {statusLabel(prog.pct)}
            </span>
            {loggedToday && (
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20,
                background: `${C.accent}20`, color: C.accent }}>✓ logged today</span>
            )}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: 'monospace' }}>
              {prog.display}
            </span>
            {target.type !== 'yesno' && (
              <span style={{ fontSize: 11, color: C.muted }}>
                of {target.type === 'percentage'
                  ? `${target.target_value}%`
                  : target.target_value.toLocaleString()} target
              </span>
            )}
            <span style={{ fontSize: 10, color: C.muted }}>
              📅 {fmtDate(target.start_date)} → {fmtDate(target.end_date)}
            </span>
            {dl > 0 && periodActive && (
              <span style={{ fontSize: 10, color: dl <= 2 ? C.danger : C.muted }}>
                {dl}d left
              </span>
            )}
            {!periodActive && today > target.end_date && (
              <span style={{ fontSize: 10, color: C.muted }}>Period ended</span>
            )}
          </div>

          {/* Alerts row */}
          {(atRisk || dailyNeeded) && periodActive && (
            <div style={{ display: 'flex', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
              {atRisk && (
                <span style={{ fontSize: 10, background: `${C.danger}18`, color: C.danger,
                  padding: '3px 10px', borderRadius: 6, border: `1px solid ${C.danger}44` }}>
                  🚨 At risk — pace too slow with {dl}d left
                </span>
              )}
              {dailyNeeded && !atRisk && (
                <span style={{ fontSize: 10, background: `${C.warn}18`, color: C.warn,
                  padding: '3px 10px', borderRadius: 6, border: `1px solid ${C.warn}44` }}>
                  ⚠ Need {dailyNeeded.toLocaleString()}/day to hit target
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          {periodActive && (
            <button onClick={e => { e.stopPropagation(); onLog(target); }} style={{
              fontSize: 11, padding: '5px 12px',
              background: loggedToday ? `${C.accent}10` : `${C.accent}18`,
              border: `1px solid ${C.accent}44`, borderRadius: 7,
              color: C.accent, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
            }}>
              + Log today
            </button>
          )}
          <button onClick={e => { e.stopPropagation(); onDelete(target.id); }} style={{
            fontSize: 10, padding: '4px 10px', background: 'transparent',
            border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, cursor: 'pointer',
          }}>✕</button>
        </div>

        <span style={{ color: C.muted, fontSize: 11 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Expanded: log history + mini chart */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.border}`, background: C.elevated, padding: '14px 18px' }}>
          {target.description && (
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 12, fontStyle: 'italic' }}>
              {target.description}
            </div>
          )}

          {logs.length === 0 ? (
            <div style={{ textAlign: 'center', fontSize: 12, color: C.muted, padding: '12px 0' }}>
              No logs yet — hit "+ Log today" to start tracking
            </div>
          ) : (
            <>
              {/* Mini bar chart for number targets */}
              {chartBars.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.sub, marginBottom: 8 }}>Daily Log</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 64 }}>
                    {chartBars.map((b, i) => {
                      const maxV = Math.max(...chartBars.map(x => x.val), 1);
                      const h = Math.max((b.val / maxV) * 100, b.val > 0 ? 6 : 2);
                      const prev = chartBars[i - 1];
                      const delta = prev && prev.val > 0
                        ? ((b.val - prev.val) / prev.val * 100).toFixed(0) : null;
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          {delta !== null && (
                            <span style={{ fontSize: 8, color: parseInt(delta) >= 0 ? C.accent : C.danger }}>
                              {parseInt(delta) >= 0 ? '▲' : '▼'}{Math.abs(delta)}%
                            </span>
                          )}
                          <div style={{
                            width: '70%', height: `${h}%`, minHeight: 3, borderRadius: '3px 3px 0 0',
                            background: b.val === 0
                              ? C.border
                              : `linear-gradient(180deg, ${color}, ${color}88)`,
                          }} title={b.val.toLocaleString()} />
                          <span style={{ fontSize: 8, color: C.muted }}>{b.date}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Log table */}
              <div style={{ fontSize: 11, fontWeight: 600, color: C.sub, marginBottom: 6 }}>History</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[...logs].reverse().slice(0, 7).map((l, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '5px 8px', borderRadius: 6,
                    background: l.date === today ? `${C.accent}10` : 'transparent',
                    border: `1px solid ${l.date === today ? C.accent + '33' : C.border}`,
                  }}>
                    <span style={{ fontSize: 11, color: C.sub }}>
                      {new Date(l.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      {l.note && <span style={{ fontSize: 10, color: C.muted, fontStyle: 'italic' }}>{l.note}</span>}
                      <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'monospace' }}>
                        {target.type === 'yesno'
                          ? (l.value === 'yes' ? '✅ Yes' : '❌ No')
                          : target.type === 'percentage'
                          ? `${l.value}%`
                          : parseFloat(l.value).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ─────────────────────────────────────────────── */
export default function TargetsPage() {
  const { C } = useTheme();
  const today = todayISO();

  const [targets, setTargets]       = useState([]);
  const [logs, setLogs]             = useState({}); // { [target_id]: [{date, value, note}] }
  const [loading, setLoading]       = useState(true);
  const [showNew, setShowNew]       = useState(false);
  const [logTarget, setLogTarget]   = useState(null);
  const [filter, setFilter]         = useState('active'); // active | all | past

  /* ─ Fetch from Supabase ─ */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, lRes] = await Promise.all([
        fetch('/api/targets'),
        fetch('/api/target-logs'),
      ]);
      const { data: tData } = await tRes.json();
      const { data: lData } = await lRes.json();
      setTargets(tData || []);
      // Group logs by target_id
      const grouped = {};
      (lData || []).forEach(l => {
        if (!grouped[l.target_id]) grouped[l.target_id] = [];
        grouped[l.target_id].push(l);
      });
      // Sort each group by date asc
      Object.keys(grouped).forEach(k => {
        grouped[k].sort((a, b) => a.date.localeCompare(b.date));
      });
      setLogs(grouped);
    } catch (e) {
      console.error('Targets load error', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ─ Filter targets ─ */
  const filteredTargets = targets.filter(t => {
    if (filter === 'active') return today >= t.start_date && today <= t.end_date;
    if (filter === 'past')   return today > t.end_date;
    return true; // all
  });

  /* ─ Summary counts ─ */
  const activeTargets = targets.filter(t => today >= t.start_date && today <= t.end_date);
  const hitCount      = activeTargets.filter(t => calcProgress(t, logs[t.id] || []).pct >= 100).length;
  const closeCount    = activeTargets.filter(t => {
    const p = calcProgress(t, logs[t.id] || []).pct;
    return p >= 70 && p < 100;
  }).length;
  const atRiskCount   = activeTargets.filter(t => calcProgress(t, logs[t.id] || []).pct < 70).length;

  /* ─ Save new target ─ */
  const handleSaveTarget = async (form) => {
    try {
      const res = await fetch('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const { data } = await res.json();
      if (data) {
        setTargets(p => [...p, data]);
        setShowNew(false);
      }
    } catch (e) { console.error(e); }
  };

  /* ─ Log progress ─ */
  const handleLogSubmit = async (value, note) => {
    if (!logTarget) return;
    try {
      const res = await fetch('/api/target-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: logTarget.id, date: today, value: String(value), note }),
      });
      const { data } = await res.json();
      if (data) {
        setLogs(p => {
          const existing = (p[logTarget.id] || []).filter(l => l.date !== today);
          const updated = [...existing, data].sort((a, b) => a.date.localeCompare(b.date));
          return { ...p, [logTarget.id]: updated };
        });
      }
    } catch (e) { console.error(e); }
    setLogTarget(null);
  };

  /* ─ Delete target ─ */
  const handleDelete = async (id) => {
    if (!confirm('Remove this target?')) return;
    try {
      await fetch(`/api/targets?id=${id}`, { method: 'DELETE' });
      setTargets(p => p.filter(t => t.id !== id));
    } catch (e) { console.error(e); }
  };

  /* ─ Styles ─ */
  const card = {
    background: C.card, border: `1px solid ${C.border}`,
    borderRadius: 12, padding: 20,
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>
      {/* Page header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '18px 28px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.text }}>🎯 Targets</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: C.sub }}>
            Weekly goals · Daily progress · Team alerts
          </p>
        </div>
        <button onClick={() => setShowNew(true)} style={{
          padding: '8px 18px', background: C.accent, color: '#0B0F1A',
          border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          ＋ New Target
        </button>
      </div>

      <div style={{ padding: '20px 28px', maxWidth: 1100, margin: '0 auto' }}>

        {/* Summary strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
          {[
            { label: 'Active this week', val: activeTargets.length,  color: C.text   },
            { label: '✅ Hit',           val: hitCount,               color: '#00E5A0'},
            { label: '⚡ On track',      val: closeCount,             color: C.warn   },
            { label: '❌ Off track',     val: atRiskCount,            color: C.danger },
          ].map(s => (
            <div key={s.label} style={{ ...card, padding: '14px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.val}</div>
              <div style={{ fontSize: 11, color: C.sub, marginTop: 3 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 18,
          background: C.card, borderRadius: 10, border: `1px solid ${C.border}`,
          padding: 4, width: 'fit-content' }}>
          {[
            { key: 'active', label: `Active (${activeTargets.length})` },
            { key: 'all',    label: 'All'  },
            { key: 'past',   label: 'Past' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: '7px 18px', borderRadius: 7, fontSize: 13, fontWeight: 500,
              cursor: 'pointer', border: 'none',
              background: filter === f.key ? C.accent : 'transparent',
              color:       filter === f.key ? '#0B0F1A' : C.sub,
              fontWeight:  filter === f.key ? 700 : 400,
            }}>{f.label}</button>
          ))}
        </div>

        {/* Target list */}
        {loading ? (
          <div style={{ textAlign: 'center', color: C.muted, padding: '40px 0', fontSize: 14 }}>
            Loading targets…
          </div>
        ) : filteredTargets.length === 0 ? (
          <div style={{ ...card, textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🎯</div>
            <div style={{ fontSize: 14, color: C.sub, marginBottom: 16 }}>
              {filter === 'active'
                ? 'No active targets this week'
                : filter === 'past'
                ? 'No past targets yet'
                : 'No targets yet'}
            </div>
            <button onClick={() => setShowNew(true)} style={{
              padding: '9px 22px', background: C.accent, color: '#0B0F1A',
              border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer',
            }}>＋ Add first target</button>
          </div>
        ) : (
          filteredTargets.map(t => (
            <TargetCard
              key={t.id}
              target={t}
              logs={logs[t.id] || []}
              C={C}
              onLog={setLogTarget}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>

      {/* Modals */}
      {showNew    && <NewTargetModal C={C} onSave={handleSaveTarget} onClose={() => setShowNew(false)} />}
      {logTarget  && <LogModal target={logTarget} C={C} onSubmit={handleLogSubmit} onClose={() => setLogTarget(null)} />}
    </div>
  );
}
