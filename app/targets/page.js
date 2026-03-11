'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import InsightBanner from '../components/InsightBanner';

const toLocalYMD = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const parseYMD = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};

const todayISO = () => toLocalYMD(new Date());

const fmtDate = (iso) =>
  parseYMD(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const daysLeft = (endISO) => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const end = parseYMD(endISO);
  end.setHours(23, 59, 59, 999);
  return Math.max(0, Math.ceil((end - now) / 86400000));
};

const weekStart = () => {
  const d = parseYMD(todayISO());
  const mon = new Date(d);
  mon.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
  return toLocalYMD(mon);
};

const weekEnd = () => {
  const d = parseYMD(weekStart());
  d.setDate(d.getDate() + 6);
  return toLocalYMD(d);
};

const calcProgress = (target, logs, autoValue) => {
  const manualTotal = logs.reduce((s, l) => s + (parseFloat(l.value) || 0), 0);
  const actual =
    target.metric_key && autoValue != null ? Math.max(manualTotal, autoValue) : manualTotal;

  if (target.type === 'yesno') {
    const done = logs.some((l) => l.value === 'yes');
    return { actual: done ? 'Yes' : 'No', pct: done ? 100 : 0, raw: done ? 1 : 0 };
  }

  if (target.type === 'percentage') {
    const val = parseFloat(logs[logs.length - 1]?.value) || 0;
    return { actual: val, pct: Math.min((val / target.target_value) * 100, 100), raw: val };
  }

  const pct = target.target_value > 0 ? Math.min((actual / target.target_value) * 100, 100) : 0;
  return { actual, pct, raw: actual };
};

const statusColor = (pct, C) => (pct >= 100 ? '#00E5A0' : pct >= 60 ? C.warn : C.danger);
const statusLabel = (pct) => (pct >= 100 ? '✅ Hit' : pct >= 60 ? '⚡ Close' : '❌ Off track');

function Bar({ pct, color }) {
  return (
    <div
      style={{
        flex: 1,
        height: 6,
        background: '#1E2D45',
        borderRadius: 3,
        overflow: 'hidden',
        minWidth: 80,
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${Math.min(pct, 100)}%`,
          background: `linear-gradient(90deg, ${color}88, ${color})`,
          borderRadius: 3,
          transition: 'width 0.5s ease',
        }}
      />
    </div>
  );
}

function LogModal({ target, C, onSubmit, onClose }) {
  const [val, setVal] = useState('');
  const [note, setNote] = useState('');
  const S = {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999,
    },
    box: {
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: 24,
      width: 360,
      boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
    },
    input: {
      width: '100%',
      background: C.inputBg,
      border: `1px solid ${C.accent}66`,
      borderRadius: 8,
      color: C.text,
      padding: '9px 12px',
      fontSize: 14,
      fontFamily: 'monospace',
      outline: 'none',
      boxSizing: 'border-box',
      marginBottom: 12,
    },
    label: {
      fontSize: 11,
      fontWeight: 600,
      color: C.sub,
      marginBottom: 4,
      display: 'block',
    },
    btn: (p) => ({
      flex: 1,
      padding: '9px',
      border: p ? 'none' : `1px solid ${C.border}`,
      borderRadius: 8,
      fontWeight: p ? 700 : 400,
      fontSize: 13,
      cursor: 'pointer',
      background: p ? C.accent : C.elevated,
      color: p ? '#0B0F1A' : C.sub,
    }),
  };

  return (
    <div style={S.overlay}>
      <div style={S.box}>
        <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 2 }}>
          📊 Log Progress
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 16 }}>{target.name}</div>
        <label style={S.label}>
          {target.type === 'yesno'
            ? 'Status'
            : target.type === 'percentage'
            ? '% complete'
            : 'Count for today'}
        </label>

        {target.type === 'yesno' ? (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {['yes', 'no'].map((v) => (
              <button
                key={v}
                onClick={() => setVal(v)}
                style={{
                  flex: 1,
                  padding: '9px',
                  borderRadius: 8,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: `2px solid ${val === v ? C.accent : C.border}`,
                  background: val === v ? `${C.accent}18` : C.elevated,
                  color: val === v ? C.accent : C.sub,
                }}
              >
                {v === 'yes' ? '✅ Yes' : '❌ No'}
              </button>
            ))}
          </div>
        ) : (
          <input
            type="number"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={target.type === 'percentage' ? '0–100' : 'Enter count…'}
            style={S.input}
          />
        )}

        <label style={S.label}>Note (optional)</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Any context…"
          style={{ ...S.input, fontFamily: 'inherit', marginBottom: 16 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => val !== '' && onSubmit(val, note)} style={S.btn(true)}>
            Submit
          </button>
          <button onClick={onClose} style={S.btn(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function NewTargetModal({ C, onSave, onClose }) {
  const [form, setForm] = useState({
    name: '',
    type: 'number',
    target_value: '',
    start_date: weekStart(),
    end_date: weekEnd(),
    metric_key: '',
    description: '',
  });

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const S = {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 999,
    },
    box: {
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      padding: 24,
      width: 440,
      boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      maxHeight: '90vh',
      overflowY: 'auto',
    },
    label: {
      fontSize: 11,
      fontWeight: 600,
      color: C.sub,
      marginBottom: 4,
      display: 'block',
      marginTop: 10,
    },
    input: {
      width: '100%',
      background: C.inputBg,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      padding: '8px 12px',
      fontSize: 13,
      outline: 'none',
      boxSizing: 'border-box',
    },
    btn: (p) => ({
      flex: 1,
      padding: '9px',
      border: p ? 'none' : `1px solid ${C.border}`,
      borderRadius: 8,
      fontWeight: p ? 700 : 400,
      fontSize: 13,
      cursor: 'pointer',
      background: p ? C.accent : C.elevated,
      color: p ? '#0B0F1A' : C.sub,
    }),
  };

  const TYPES = [
    { key: 'number', label: '🔢 Number', desc: 'Daily count' },
    { key: 'yesno', label: '✅ Yes/No', desc: 'Done or not' },
    { key: 'percentage', label: '📊 %', desc: 'Completion %' },
  ];

  return (
    <div style={S.overlay}>
      <div style={S.box}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 16 }}>
          🎯 New Target
        </div>

        <label style={S.label}>Name *</label>
        <input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Care Items Mapped"
          style={S.input}
        />

        <label style={S.label}>Type *</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 4 }}>
          {TYPES.map((t) => (
            <div
              key={t.key}
              onClick={() => set('type', t.key)}
              style={{
                padding: '8px',
                borderRadius: 8,
                cursor: 'pointer',
                textAlign: 'center',
                border: `2px solid ${form.type === t.key ? C.accent : C.border}`,
                background: form.type === t.key ? `${C.accent}12` : C.elevated,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: form.type === t.key ? C.accent : C.text }}>
                {t.label}
              </div>
              <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>{t.desc}</div>
            </div>
          ))}
        </div>

        {form.type !== 'yesno' && (
          <>
            <label style={S.label}>Target Value *</label>
            <input
              type="number"
              value={form.target_value}
              onChange={(e) => set('target_value', e.target.value)}
              placeholder="e.g. 400000"
              style={S.input}
            />
          </>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={S.label}>Start *</label>
            <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label}>End *</label>
            <input type="date" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} style={S.input} />
          </div>
        </div>

        <label style={S.label}>Linked Metric (auto-pulls from daily reports)</label>
        <select
          value={form.metric_key}
          onChange={(e) => set('metric_key', e.target.value)}
          style={{ ...S.input, marginBottom: 4 }}
        >
          <option value="">— None —</option>
          {[
            'care_items_mapped',
            'resolved_cares',
            'care_items_grouped',
            'providers_mapped',
            'claims_kenya',
            'claims_tanzania',
            'claims_uganda',
            'claims_uap',
            'flagged_care_items',
            'icd10_adjusted',
            'benefits_set_up',
            'providers_assigned',
          ].map((m) => (
            <option key={m} value={m}>
              {m.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <label style={{ ...S.label, marginTop: 8 }}>Description</label>
        <input
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="What does success look like?"
          style={{ ...S.input, marginBottom: 16 }}
        />

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              if (!form.name.trim()) return;
              if (form.type !== 'yesno' && !form.target_value) return;
              onSave({ ...form, target_value: parseFloat(form.target_value) || 100 });
            }}
            style={S.btn(true)}
          >
            Save Target
          </button>
          <button onClick={onClose} style={S.btn(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ExpandedDetail({ target, logs, C, today }) {
  const chartBars =
    target.type === 'number' && logs.length > 0
      ? logs.slice(-7).map((l) => ({ date: l.date.slice(5), val: parseFloat(l.value) || 0 }))
      : [];

  return (
    <tr>
      <td colSpan={8} style={{ background: C.elevated, padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
        {target.description && (
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, fontStyle: 'italic' }}>
            {target.description}
          </div>
        )}

        {logs.length === 0 ? (
          <div style={{ fontSize: 11, color: C.muted }}>
            No logs yet — use "+ Log" to start tracking manually
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {chartBars.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.sub, marginBottom: 6 }}>
                  Daily log (last 7)
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 48 }}>
                  {chartBars.map((b, i) => {
                    const maxV = Math.max(...chartBars.map((x) => x.val), 1);
                    const h = Math.max((b.val / maxV) * 100, b.val > 0 ? 8 : 2);
                    const prev = chartBars[i - 1];
                    const delta =
                      prev && prev.val > 0 ? (((b.val - prev.val) / prev.val) * 100).toFixed(0) : null;

                    return (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 2,
                          width: 28,
                        }}
                      >
                        {delta !== null && (
                          <span style={{ fontSize: 8, color: parseInt(delta) >= 0 ? '#00E5A0' : C.danger }}>
                            {parseInt(delta) >= 0 ? '▲' : '▼'}
                            {Math.abs(delta)}%
                          </span>
                        )}
                        <div
                          style={{
                            width: '70%',
                            height: `${h}%`,
                            minHeight: 3,
                            borderRadius: '2px 2px 0 0',
                            background: b.val === 0 ? C.border : '#00E5A0',
                          }}
                          title={b.val.toLocaleString()}
                        />
                        <span style={{ fontSize: 8, color: C.muted }}>{b.date}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.sub, marginBottom: 6 }}>
                Log history
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {[...logs]
                  .reverse()
                  .slice(0, 5)
                  .map((l, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 16,
                        alignItems: 'center',
                        fontSize: 11,
                        padding: '3px 8px',
                        borderRadius: 5,
                        background: l.date === today ? `${'#00E5A0'}10` : 'transparent',
                        border: `1px solid ${l.date === today ? '#00E5A033' : C.border}`,
                      }}
                    >
                      <span style={{ color: C.muted, minWidth: 70 }}>
                        {new Date(l.date + 'T12:00:00').toLocaleDateString('en-GB', {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                      <span style={{ fontWeight: 700, color: '#00E5A0', fontFamily: 'monospace' }}>
                        {target.type === 'yesno'
                          ? l.value === 'yes'
                            ? '✅ Yes'
                            : '❌ No'
                          : target.type === 'percentage'
                          ? `${l.value}%`
                          : parseFloat(l.value).toLocaleString()}
                      </span>
                      {l.note && <span style={{ color: C.muted, fontStyle: 'italic' }}>{l.note}</span>}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

export default function TargetsPage() {
  const { C } = useTheme();
  const today = todayISO();

  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState({});
  const [autoValues, setAutoValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [logTarget, setLogTarget] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState('active');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, lRes] = await Promise.all([fetch('/api/targets'), fetch('/api/target-logs')]);
      const { data: tData } = await tRes.json();
      const { data: lData } = await lRes.json();
      const tArr = tData || [];
      setTargets(tArr);

      const grouped = {};
      (lData || []).forEach((l) => {
        if (!grouped[l.target_id]) grouped[l.target_id] = [];
        grouped[l.target_id].push(l);
      });
      Object.keys(grouped).forEach((k) => grouped[k].sort((a, b) => a.date.localeCompare(b.date)));
      setLogs(grouped);

      const linkedTargets = tArr.filter(
        (t) => t.metric_key && today >= t.start_date && today <= t.end_date
      );

      if (linkedTargets.length > 0) {
        const minStart = [...linkedTargets].sort((a, b) => a.start_date.localeCompare(b.start_date))[0].start_date;
        const maxEnd = [...linkedTargets].sort((a, b) => b.end_date.localeCompare(a.end_date))[0].end_date;

        const rRes = await fetch(`/api/reports?from=${encodeURIComponent(minStart)}&to=${encodeURIComponent(maxEnd)}`);
        const rData = await rRes.json();
        const reports = rData.data || [];
        const autos = {};

        linkedTargets.forEach((t) => {
          const scopedReports = reports.filter((r) => r.report_date >= t.start_date && r.report_date <= t.end_date);
          const sum = scopedReports.reduce(
            (s, r) => s + (parseInt(r.metrics?.[t.metric_key]) || 0),
            0
          );
          autos[t.id] = sum;
        });

        setAutoValues(autos);
      } else {
        setAutoValues({});
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [today]);

  useEffect(() => {
    load();
  }, [load]);

  const activeTargets = targets.filter((t) => today >= t.start_date && today <= t.end_date);
  const filteredTargets = targets.filter((t) => {
    if (filter === 'active') return today >= t.start_date && today <= t.end_date;
    if (filter === 'past') return today > t.end_date;
    return true;
  });

  const hitCount = activeTargets.filter(
    (t) => calcProgress(t, logs[t.id] || [], autoValues[t.id]).pct >= 100
  ).length;
  const closeCount = activeTargets.filter((t) => {
    const p = calcProgress(t, logs[t.id] || [], autoValues[t.id]).pct;
    return p >= 60 && p < 100;
  }).length;
  const offCount = activeTargets.filter(
    (t) => calcProgress(t, logs[t.id] || [], autoValues[t.id]).pct < 60
  ).length;

  const handleSaveTarget = async (form) => {
    try {
      const res = await fetch('/api/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const { data } = await res.json();
      if (data) {
        setTargets((p) => [...p, data]);
        setShowNew(false);
      }
    } catch (e) {
      console.error(e);
    }
  };

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
        setLogs((p) => {
          const existing = (p[logTarget.id] || []).filter((l) => l.date !== today);
          return {
            ...p,
            [logTarget.id]: [...existing, data].sort((a, b) => a.date.localeCompare(b.date)),
          };
        });
      }
    } catch (e) {
      console.error(e);
    }
    setLogTarget(null);
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this target?')) return;
    try {
      await fetch(`/api/targets?id=${id}`, { method: 'DELETE' });
      setTargets((p) => p.filter((t) => t.id !== id));
    } catch (e) {
      console.error(e);
    }
  };

  const th = {
    fontSize: 11,
    fontWeight: 600,
    color: C.muted,
    padding: '8px 12px',
    textAlign: 'left',
    borderBottom: `1px solid ${C.border}`,
    whiteSpace: 'nowrap',
  };

  const td = (extra = {}) => ({
    fontSize: 13,
    padding: '10px 12px',
    borderBottom: `1px solid ${C.border}33`,
    verticalAlign: 'middle',
    ...extra,
  });

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>
      <div
        style={{
          background: C.card,
          borderBottom: `1px solid ${C.border}`,
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>🎯 Targets</h1>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: C.sub }}>
            Weekly goals · Daily progress · Team alerts
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          style={{
            padding: '7px 16px',
            background: C.accent,
            color: '#0B0F1A',
            border: 'none',
            borderRadius: 8,
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          ＋ New Target
        </button>
      </div>

      <div style={{ padding: '16px 24px' }}>
        <InsightBanner />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 16 }}>
          {[
            { label: 'Active this week', val: activeTargets.length, color: C.text },
            { label: '✅ Hit', val: hitCount, color: '#00E5A0' },
            { label: '⚡ On track', val: closeCount, color: C.warn },
            { label: '❌ Off track', val: offCount, color: C.danger },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>
                {s.val}
              </span>
              <span style={{ fontSize: 11, color: C.sub }}>{s.label}</span>
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 0,
            marginBottom: 12,
            background: C.card,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            padding: 3,
            width: 'fit-content',
          }}
        >
          {[
            { key: 'active', label: `Active (${activeTargets.length})` },
            { key: 'all', label: 'All' },
            { key: 'past', label: 'Past' },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '6px 16px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: filter === f.key ? 700 : 400,
                cursor: 'pointer',
                border: 'none',
                background: filter === f.key ? C.accent : 'transparent',
                color: filter === f.key ? '#0B0F1A' : C.sub,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', color: C.muted, padding: '32px 0' }}>Loading targets…</div>
        ) : filteredTargets.length === 0 ? (
          <div
            style={{
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              textAlign: 'center',
              padding: '40px 0',
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>🎯</div>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 12 }}>No targets yet</div>
            <button
              onClick={() => setShowNew(true)}
              style={{
                padding: '8px 20px',
                background: C.accent,
                color: '#0B0F1A',
                border: 'none',
                borderRadius: 8,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ＋ Add first target
            </button>
          </div>
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: C.elevated }}>
                  <th style={th}>Target</th>
                  <th style={th}>Type</th>
                  <th style={th}>Actual</th>
                  <th style={th}>Target</th>
                  <th style={{ ...th, minWidth: 120 }}>Progress</th>
                  <th style={th}>Period</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTargets.map((t) => {
                  const prog = calcProgress(t, logs[t.id] || [], autoValues[t.id]);
                  const color = statusColor(prog.pct, C);
                  const dl = daysLeft(t.end_date);
                  const isActive = today >= t.start_date && today <= t.end_date;
                  const loggedToday = (logs[t.id] || []).some((l) => l.date === today);
                  const dailyNeeded =
                    t.type === 'number' && t.target_value > prog.raw && dl > 0
                      ? Math.ceil((t.target_value - prog.raw) / dl)
                      : null;
                  const isExpanded = expanded === t.id;

                  return [
                    <tr
                      key={t.id}
                      onClick={() => setExpanded(isExpanded ? null : t.id)}
                      style={{ cursor: 'pointer', background: isExpanded ? `${C.accent}05` : 'transparent' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = `${C.accent}08`)}
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = isExpanded ? `${C.accent}05` : 'transparent')
                      }
                    >
                      <td style={td()}>
                        <div style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{t.name}</div>
                        {dailyNeeded && isActive && (
                          <div style={{ fontSize: 10, color: prog.pct < 50 && dl <= 3 ? C.danger : C.warn, marginTop: 2 }}>
                            ⚠ {dailyNeeded.toLocaleString()}/day needed
                          </div>
                        )}
                        {loggedToday && <div style={{ fontSize: 9, color: '#00E5A0', marginTop: 1 }}>✓ logged today</div>}
                      </td>

                      <td style={td()}>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 7px',
                            borderRadius: 5,
                            background:
                              t.type === 'number'
                                ? `${C.blue}22`
                                : t.type === 'yesno'
                                ? `${C.purple}22`
                                : `${C.warn}22`,
                            color: t.type === 'number' ? C.blue : t.type === 'yesno' ? C.purple : C.warn,
                          }}
                        >
                          {t.type === 'number' ? '123' : t.type === 'yesno' ? 'Y/N' : '%'}
                        </span>
                      </td>

                      <td style={td({ fontFamily: 'monospace', fontWeight: 700, color, fontSize: 14 })}>
                        {t.type === 'yesno'
                          ? prog.actual === 'Yes'
                            ? '✅ Yes'
                            : '❌ No'
                          : t.type === 'percentage'
                          ? `${prog.actual}%`
                          : typeof prog.actual === 'number'
                          ? prog.actual.toLocaleString()
                          : '—'}
                      </td>

                      <td style={td({ color: C.sub, fontFamily: 'monospace', fontSize: 12 })}>
                        {t.type === 'yesno'
                          ? '—'
                          : t.type === 'percentage'
                          ? `${t.target_value}%`
                          : t.target_value.toLocaleString()}
                      </td>

                      <td style={td({ minWidth: 140 })}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Bar pct={prog.pct} color={color} />
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color,
                              fontFamily: 'monospace',
                              minWidth: 34,
                            }}
                          >
                            {prog.pct.toFixed(0)}%
                          </span>
                        </div>
                      </td>

                      <td style={td({ fontSize: 11, color: C.muted })}>
                        <div>
                          {fmtDate(t.start_date)} → {fmtDate(t.end_date)}
                        </div>
                        {isActive && dl > 0 && <div style={{ color: dl <= 2 ? C.danger : C.muted }}>{dl}d left</div>}
                        {!isActive && today > t.end_date && <div style={{ color: C.muted }}>Ended</div>}
                      </td>

                      <td style={td()}>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            padding: '3px 9px',
                            borderRadius: 20,
                            background: `${color}18`,
                            color,
                          }}
                        >
                          {statusLabel(prog.pct)}
                        </span>
                      </td>

                      <td style={td({ textAlign: 'right' })} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                          {isActive && (
                            <button
                              onClick={() => setLogTarget(t)}
                              style={{
                                fontSize: 11,
                                padding: '4px 10px',
                                background: `${C.accent}18`,
                                border: `1px solid ${C.accent}44`,
                                borderRadius: 6,
                                color: C.accent,
                                cursor: 'pointer',
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              + Log
                            </button>
                          )}
                          <button
                            onClick={() => handleDelete(t.id)}
                            style={{
                              fontSize: 10,
                              padding: '3px 8px',
                              background: 'transparent',
                              border: `1px solid ${C.border}`,
                              borderRadius: 5,
                              color: C.muted,
                              cursor: 'pointer',
                            }}
                          >
                            ✕
                          </button>
                          <span style={{ color: C.muted, fontSize: 11 }}>{isExpanded ? '▲' : '▼'}</span>
                        </div>
                      </td>
                    </tr>,

                    isExpanded && (
                      <ExpandedDetail
                        key={`${t.id}-detail`}
                        target={t}
                        logs={logs[t.id] || []}
                        C={C}
                        today={today}
                      />
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && <NewTargetModal C={C} onSave={handleSaveTarget} onClose={() => setShowNew(false)} />}
      {logTarget && <LogModal target={logTarget} C={C} onSubmit={handleLogSubmit} onClose={() => setLogTarget(null)} />}
    </div>
  );
}
