'use client';
// app/okr/page.js — OKR Tracker (Q1 2026)

import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

// ── Color logic ─────────────────────────────────────────────────────────────
// Green ≥ 75% | Blue 60–74.9% | Orange 30–59.9% | Red < 30%

function gradeColor(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '#666';
  if (pct >= 75) return '#22C55E';   // green — good
  if (pct >= 60) return '#5B8DEF';   // blue — on track
  if (pct >= 30) return '#F97316';   // orange — at risk
  return '#EF4444';                   // red — critical
}

function gradeLabel(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '—';
  if (pct >= 75) return '🟢 Good';
  if (pct >= 60) return '🔵 On Track';
  if (pct >= 30) return '🟠 At Risk';
  return '🔴 Critical';
}

function computeGrade(target, actual) {
  if (!target || !actual || String(actual).trim() === '') return null;
  const t = parseFloat(String(target).replace(/[%,\s]/g, ''));
  const a = parseFloat(String(actual).replace(/[%,\s]/g, ''));
  if (isNaN(t) || isNaN(a) || t === 0) return null;
  return (a / t) * 100;
}

function formatVal(val) {
  if (!val && val !== 0) return '—';
  const s = String(val);
  const n = parseFloat(s.replace(/[%,\s]/g, ''));
  if (s.includes('%')) return s;
  if (!isNaN(n) && n >= 1000) return n.toLocaleString();
  return s;
}

// ── Grade Pill ────────────────────────────────────────────────────────────────

function GradePill({ pct }) {
  if (pct === null || pct === undefined || isNaN(pct)) {
    return <span style={{ fontSize: 12, color: '#666', fontStyle: 'italic' }}>No actual yet</span>;
  }
  const color = gradeColor(pct);
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: `${color}22`, border: `1px solid ${color}44`,
      borderRadius: 8, padding: '4px 12px',
    }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: 'monospace' }}>
        {pct > 200 ? '>200%' : `${pct.toFixed(1)}%`}
      </span>
    </div>
  );
}

// ── KR Row ────────────────────────────────────────────────────────────────────

function KRRow({ row, onSave, onDelete, C, inp, td }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [local, setLocal] = useState({ target: row.target || '', actual: row.actual || '', status: row.status || 'In Progress' });

  const pct = editing
    ? computeGrade(local.target, local.actual)
    : row.grade !== null && row.grade !== undefined ? row.grade * 100 : computeGrade(row.target, row.actual);

  const color = gradeColor(pct);

  const handleSave = async () => {
    setSaving(true);
    await onSave(row.id, local);
    setEditing(false);
    setSaving(false);
  };

  return (
    <tr style={{ borderLeft: `3px solid ${pct !== null ? color : C.border}` }}>
      {/* KR number */}
      <td style={{ ...td, textAlign: 'center', width: 50 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, color: C.accent,
          background: `${C.accent}18`, borderRadius: 4, padding: '2px 7px',
        }}>{row.kr_number}</span>
      </td>

      {/* Key Result */}
      <td style={{ ...td, maxWidth: 340 }}>
        <div style={{ fontSize: 12, color: C.text, lineHeight: 1.45 }}>{row.key_result}</div>
      </td>

      {/* Target */}
      <td style={{ ...td, textAlign: 'center', width: 110 }}>
        {editing ? (
          <input
            value={local.target}
            onChange={e => setLocal(l => ({ ...l, target: e.target.value }))}
            style={{ ...inp, width: 90, textAlign: 'center' }}
          />
        ) : (
          <span style={{ fontSize: 13, color: C.sub, fontWeight: 600 }}>{formatVal(row.target)}</span>
        )}
      </td>

      {/* Actual */}
      <td style={{ ...td, textAlign: 'center', width: 110 }}>
        {editing ? (
          <input
            value={local.actual}
            onChange={e => setLocal(l => ({ ...l, actual: e.target.value }))}
            style={{ ...inp, width: 90, textAlign: 'center' }}
            placeholder="Enter actual"
          />
        ) : (
          <span style={{ fontSize: 13, color: C.text, fontWeight: 700 }}>
            {row.actual ? formatVal(row.actual) : <span style={{ color: C.muted, fontStyle: 'italic', fontSize: 11 }}>–</span>}
          </span>
        )}
      </td>

      {/* Grade */}
      <td style={{ ...td, textAlign: 'center', width: 140 }}>
        <GradePill pct={pct} />
      </td>

      {/* Status */}
      <td style={{ ...td, textAlign: 'center', width: 110 }}>
        {editing ? (
          <select value={local.status} onChange={e => setLocal(l => ({ ...l, status: e.target.value }))} style={{ ...inp, width: 110 }}>
            <option>In Progress</option>
            <option>Done</option>
            <option>Pending</option>
            <option>Blocked</option>
          </select>
        ) : (
          <span style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 4, fontWeight: 600,
            background: row.status === 'Done' ? '#22C55E22' : row.status === 'Blocked' ? '#EF444422' : row.status === 'Pending' ? '#F9731622' : '#5B8DEF22',
            color: row.status === 'Done' ? '#22C55E' : row.status === 'Blocked' ? '#EF4444' : row.status === 'Pending' ? '#F97316' : '#5B8DEF',
          }}>{row.status || 'In Progress'}</span>
        )}
      </td>

      {/* Actions */}
      <td style={{ ...td, textAlign: 'center', width: 100 }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{ background: '#22C55E', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
            >{saving ? '…' : '✓ Save'}</button>
            <button
              onClick={() => { setLocal({ target: row.target || '', actual: row.actual || '', status: row.status || 'In Progress' }); setEditing(false); }}
              style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
            >✕</button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
          >✏️ Edit</button>
        )}
      </td>
    </tr>
  );
}

// ── Objective Block ───────────────────────────────────────────────────────────

function ObjectiveBlock({ objective, rows, onSave, onDelete, C, inp, td }) {
  const gradedRows = rows.filter(r => {
    const pct = r.grade !== null && r.grade !== undefined ? r.grade * 100 : computeGrade(r.target, r.actual);
    return pct !== null;
  });
  const avgPct = gradedRows.length
    ? gradedRows.reduce((s, r) => {
        const pct = r.grade !== null && r.grade !== undefined ? r.grade * 100 : computeGrade(r.target, r.actual);
        return s + pct;
      }, 0) / gradedRows.length
    : null;
  const color = gradeColor(avgPct);

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Objective header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px',
        background: avgPct !== null ? `${color}18` : `${C.elevated}`,
        borderLeft: `4px solid ${avgPct !== null ? color : C.border}`,
        borderRadius: '10px 10px 0 0',
      }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: avgPct !== null ? color : C.sub }}>
          {objective}
        </span>
        {avgPct !== null && (
          <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'monospace', background: `${color}22`, borderRadius: 6, padding: '2px 10px' }}>
            {avgPct.toFixed(0)}% avg
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <colgroup>
              <col style={{ width: 50 }} />
              <col />
              <col style={{ width: 110 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 100 }} />
            </colgroup>
            <tbody>
              {rows.map(row => (
                <KRRow key={row.id} row={row} onSave={onSave} onDelete={onDelete} C={C} inp={inp} td={td} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
const QUARTER_LABELS = { Q1: 'Jan – Mar 2026', Q2: 'Apr – Jun 2026', Q3: 'Jul – Sep 2026', Q4: 'Oct – Dec 2026' };

export default function OKRPage() {
  const { C } = useTheme();
  const [quarter, setQuarter] = useState('Q1');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/okr?quarter=${q}`);
      const d = await res.json();
      setRows(d.data || []);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(quarter); }, [quarter, load]);

  const handleSave = async (id, updates) => {
    const grade = computeGrade(updates.target, updates.actual);
    // Optimistic update
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...updates, grade: grade !== null ? grade / 100 : null } : r));
    try {
      const res = await fetch('/api/okr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsert', row: { id, ...updates, grade: grade !== null ? grade / 100 : null } }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      flashMsg('✅ Saved');
    } catch (err) {
      flashMsg('❌ Save failed: ' + err.message);
    }
  };

  const handleAddKR = async (objective) => {
    const kr_number = `KR${rows.filter(r => r.objective === objective).length + 1}`;
    try {
      const res = await fetch('/api/okr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'insert', row: { quarter, objective, kr_number, key_result: 'New Key Result', target: '', actual: '', status: 'In Progress', start_date: '', due_date: '' } }),
      });
      const d = await res.json();
      if (d.ok) { load(quarter); flashMsg('✅ KR added'); }
    } catch {}
  };

  const flashMsg = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 3000);
  };

  // Summary stats
  const gradedRows = rows.filter(r => {
    const pct = r.grade !== null && r.grade !== undefined ? r.grade * 100 : computeGrade(r.target, r.actual);
    return pct !== null;
  });
  const avgPct = gradedRows.length ? gradedRows.reduce((s, r) => {
    const pct = r.grade !== null && r.grade !== undefined ? r.grade * 100 : computeGrade(r.target, r.actual);
    return s + pct;
  }, 0) / gradedRows.length : null;

  const counts = {
    green: gradedRows.filter(r => { const p = r.grade !== null ? r.grade * 100 : computeGrade(r.target, r.actual); return p >= 75; }).length,
    blue: gradedRows.filter(r => { const p = r.grade !== null ? r.grade * 100 : computeGrade(r.target, r.actual); return p >= 60 && p < 75; }).length,
    orange: gradedRows.filter(r => { const p = r.grade !== null ? r.grade * 100 : computeGrade(r.target, r.actual); return p >= 30 && p < 60; }).length,
    red: gradedRows.filter(r => { const p = r.grade !== null ? r.grade * 100 : computeGrade(r.target, r.actual); return p < 30; }).length,
  };

  // Group by objective
  const objectives = [...new Set(rows.map(r => r.objective))];

  const inp = { background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px', color: C.text, fontSize: 12, outline: 'none' };
  const td = { fontSize: 12, padding: '10px 14px', borderBottom: `1px solid ${C.border}33`, verticalAlign: 'middle' };

  const statCard = (label, value, color) => (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 18px', flex: 1, minWidth: 110, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color }} />
      <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.text, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>🎯 OKR Tracker</h1>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: C.sub }}>Data Operations · 2026 · Click ✏️ Edit on any row to update Target or Actual</p>
        </div>
        {msg && (
          <div style={{ fontSize: 12, fontWeight: 600, color: msg.startsWith('✅') ? '#22C55E' : '#EF4444', background: msg.startsWith('✅') ? '#22C55E22' : '#EF444422', borderRadius: 8, padding: '6px 14px' }}>
            {msg}
          </div>
        )}
      </div>

      <div style={{ padding: '16px 24px' }}>

        {/* Quarter tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {QUARTERS.map(q => (
            <button
              key={q}
              onClick={() => { setQuarter(q); }}
              style={{
                flex: 1, minWidth: 140, padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                border: `2px solid ${quarter === q ? C.accent : C.border}`,
                background: quarter === q ? `${C.accent}18` : C.card,
                textAlign: 'left',
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: quarter === q ? C.accent : C.sub }}>{q}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{QUARTER_LABELS[q]}</div>
              {q !== 'Q1' && <div style={{ fontSize: 10, color: C.muted, marginTop: 4, fontStyle: 'italic' }}>Not started</div>}
            </button>
          ))}
        </div>

        {/* Q2-Q4 empty state */}
        {quarter !== 'Q1' && (
          <div style={{ textAlign: 'center', padding: '80px 0', background: C.card, borderRadius: 12, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
            <div style={{ fontSize: 16, color: C.sub, fontWeight: 600, marginBottom: 8 }}>{quarter} OKRs not set yet</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 24 }}>Set your {quarter} objectives and key results when the quarter begins.</div>
            <button
              onClick={() => handleAddKR('New Objective')}
              style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
            >+ Add First KR</button>
          </div>
        )}

        {/* Q1 content */}
        {quarter === 'Q1' && (
          <>
            {/* Legend */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.muted }}>Grade:</span>
              {[['≥ 75% — Good', '#22C55E'], ['60–74.9% — On Track', '#5B8DEF'], ['30–59.9% — At Risk', '#F97316'], ['< 30% — Critical', '#EF4444']].map(([label, color]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 9, height: 9, borderRadius: 3, background: color }} />
                  <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
                </div>
              ))}
            </div>

            {/* Stats */}
            {gradedRows.length > 0 && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                {statCard('Avg Grade', avgPct !== null ? `${avgPct.toFixed(0)}%` : '—', gradeColor(avgPct))}
                {statCard('Total KRs', rows.length, C.accent)}
                {statCard('Good (≥75%)', counts.green, '#22C55E')}
                {statCard('On Track', counts.blue, '#5B8DEF')}
                {statCard('At Risk', counts.orange, '#F97316')}
                {statCard('Critical', counts.red, '#EF4444')}
              </div>
            )}

            {/* Table header */}
            <div style={{ display: 'flex', gap: 0, background: C.elevated, borderRadius: '8px 8px 0 0', border: `1px solid ${C.border}`, borderBottom: 'none' }}>
              {[['KR', 50], ['Key Result', null], ['Target', 110], ['Actual', 110], ['Grade', 140], ['Status', 110], ['', 100]].map(([label, width]) => (
                <div key={label} style={{ padding: '8px 14px', fontSize: 11, fontWeight: 600, color: C.muted, width: width || 'auto', flex: width ? undefined : 1 }}>{label}</div>
              ))}
            </div>

            {loading ? (
              <div style={{ textAlign: 'center', padding: '60px 0', background: C.card, border: `1px solid ${C.border}`, borderTop: 'none', borderRadius: '0 0 10px 10px', color: C.muted, fontSize: 13 }}>Loading…</div>
            ) : (
              <>
                {objectives.map(obj => (
                  <ObjectiveBlock
                    key={obj}
                    objective={obj}
                    rows={rows.filter(r => r.objective === obj)}
                    onSave={handleSave}
                    onDelete={() => {}}
                    C={C}
                    inp={inp}
                    td={td}
                  />
                ))}

                <button
                  onClick={() => handleAddKR(objectives[0] || 'New Objective')}
                  style={{ width: '100%', background: 'transparent', border: `2px dashed ${C.border}`, borderRadius: 10, padding: '12px', color: C.muted, fontSize: 13, cursor: 'pointer', marginTop: 4 }}
                >
                  + Add Key Result
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
