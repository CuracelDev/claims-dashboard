'use client';
// app/okr/page.js — OKR Tracker

import { useState, useRef, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

// ── Helpers ────────────────────────────────────────────────────────────────

function gradeColor(grade) {
  if (grade === null || grade === undefined || isNaN(grade)) return '#888';
  const pct = grade * 100;
  if (pct >= 90) return '#5B8DEF';   // blue — on track / exceeded
  if (pct >= 75) return '#22C55E';   // green — progressing
  return '#F97316';                   // orange — at risk
}

function gradeLabel(grade) {
  if (grade === null || grade === undefined || isNaN(grade)) return '—';
  const pct = grade * 100;
  if (pct >= 90) return pct > 100 ? '🚀 Exceeded' : '✅ On Track';
  if (pct >= 75) return '🟡 Progressing';
  return '⚠️ At Risk';
}

function formatTarget(val) {
  if (val === null || val === undefined || val === '') return '—';
  const n = Number(val);
  if (isNaN(n)) return String(val);
  if (n > 0 && n <= 1 && String(val).includes('.')) return `${(n * 100).toFixed(0)}%`;
  if (n >= 1 && n <= 100 && String(val).includes('%')) return `${n}%`;
  return n >= 1000 ? n.toLocaleString() : String(n);
}

function computeGrade(target, actual) {
  const t = parseFloat(String(target).replace('%', ''));
  const a = parseFloat(String(actual).replace('%', ''));
  if (isNaN(t) || isNaN(a) || t === 0) return null;
  return a / t;
}

function parseExcelData(rows) {
  // Try to find rows that look like OKR data from Q3/Q4 sheet structure
  const parsed = [];
  rows.forEach(row => {
    const obj = row['Objective'] || row['objective'] || '';
    const kr  = row['Key Result (s)'] || row['Key Results'] || row['key_result'] || '';
    const target = row['Target'] || row['Targets'] || '';
    const actual = row['Actual'] || row['Actuals'] || '';
    const grade  = row['Grade'] || '';
    const status = row['Status'] || '';
    const startDate = row['Start Date'] || '';
    const dueDate   = row['Due Date'] || '';

    if (!kr || String(kr).trim() === '' || String(kr) === 'NaN') return;

    const computedGrade = grade ? parseFloat(grade) : computeGrade(target, actual);

    parsed.push({
      objective:  String(obj || '').trim(),
      keyResult:  String(kr).trim(),
      target:     target,
      actual:     actual,
      grade:      computedGrade,
      status:     String(status || '').trim(),
      startDate:  startDate,
      dueDate:    dueDate,
    });
  });
  return parsed;
}

// ── Seed data from Q3 sheet ────────────────────────────────────────────────

const SEED = {
  Q1: [
    { objective: 'Contribute to customer retention', keyResult: 'Drive 99% Accuracy on existing clinical rules', target: '99%', actual: '99%', grade: 1.0, status: 'In Progress', startDate: '1/1/2026', dueDate: '31/3/2026' },
    { objective: 'Contribute to customer retention', keyResult: '100% tracking on auto-vet result from clients', target: '100%', actual: '100%', grade: 1.0, status: 'In Progress', startDate: '1/1/2026', dueDate: '31/3/2026' },
    { objective: 'Contribute to customer retention', keyResult: 'Deliver claims results 100% in accordance with schedules agreed with clients', target: '100%', actual: '100%', grade: 1.0, status: 'In Progress', startDate: '1/1/2026', dueDate: '31/3/2026' },
    { objective: 'Improve deal conversion from POCs', keyResult: 'Deliver POC claims results not more than 72 hours after data is shared', target: '100%', actual: '100%', grade: 1.0, status: 'In Progress', startDate: '1/1/2026', dueDate: '31/3/2026' },
    { objective: 'Improve deal conversion from POCs', keyResult: 'Send a weekly reminder after 7 days of shared POC to get client feedback', target: '100%', actual: '100%', grade: 1.0, status: 'In Progress', startDate: '1/1/2026', dueDate: '31/3/2026' },
  ],
  Q2: [
    { objective: 'Improve CVE to become world class standard', keyResult: 'Improve average detection product accuracy to 98%', target: '98%', actual: '99%', grade: 1.01, status: 'In Progress', startDate: '1/4/2025', dueDate: '30/6/2025' },
    { objective: 'Improve CVE to become world class standard', keyResult: '2500 grouped care items', target: 2500, actual: 965, grade: 0.386, status: 'In Progress', startDate: '1/4/2025', dueDate: '30/6/2025' },
    { objective: 'Improve CVE to become world class standard', keyResult: '1000 provider mapping', target: 1000, actual: 433, grade: 0.433, status: 'In Progress', startDate: '1/4/2025', dueDate: '30/6/2025' },
    { objective: 'Improve CVE to become world class standard', keyResult: 'Improve process automation by 20%', target: '20%', actual: '75%', grade: 3.75, status: 'Done', startDate: '1/4/2025', dueDate: '30/6/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Ensure 100% of old and new client detection needs are met', target: '70%', actual: '95.3%', grade: 1.36, status: 'In Progress', startDate: '1/4/2025', dueDate: '30/6/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Improve average Detection TATs to 95% of client agreed timelines', target: '95%', actual: '99%', grade: 1.042, status: 'In Progress', startDate: '1/4/2025', dueDate: '30/6/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Achieve 90% customer satisfaction from internal QA', target: '90%', actual: '90%', grade: 1.0, status: 'In Progress', startDate: '1/4/2025', dueDate: '30/6/2025' },
  ],
  Q3: [
    { objective: 'Improve accuracy & efficiency of CVE system', keyResult: '800 Provider tariff mapping', target: 800, actual: 299, grade: 0.3738, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Improve accuracy & efficiency of CVE system', keyResult: '10,000 care mapping', target: 10000, actual: 17356, grade: 1.7356, status: 'Done', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Improve accuracy & efficiency of CVE system', keyResult: 'Group 2,000 care items', target: 2000, actual: 1380, grade: 0.69, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Improve accuracy & efficiency of CVE system', keyResult: 'Customize 200 diagnoses on CVE for KE and TZ', target: 200, actual: 0, grade: 0, status: 'Pending', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Improve accuracy & efficiency of CVE system', keyResult: 'Review 30,000 claims pile', target: 30000, actual: 30576, grade: 1.0192, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Improve accuracy & efficiency of CVE system', keyResult: 'Eliminate 4,000+ duplicate diagnoses', target: 4000, actual: 1250, grade: 0.3125, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: '100% population of clinical rules for newly added diagnoses (107)', target: 107, actual: 107, grade: 1.0, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Achieve 90% customer satisfaction from internal QA', target: '90%', actual: '90%', grade: 1.0, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Carry out 100% of Detection POCs from Sales team', target: '100%', actual: '0%', grade: 0, status: 'Pending', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Achieve TAT of 24 hours across all Jubilee entities', target: '100%', actual: '95%', grade: 0.95, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
    { objective: 'Contribute to Acquisition & Retention', keyResult: 'Maintain average CVE accuracy of 99%', target: '99%', actual: '98.96%', grade: 0.9996, status: 'In Progress', startDate: '1/7/2025', dueDate: '30/9/2025' },
  ],
  Q4: [
    { objective: 'Enhance efficiency of the Clinical Vetting Engine', keyResult: 'Map 600 providers tariffs', target: 600, actual: 0, grade: 0, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Enhance efficiency of the Clinical Vetting Engine', keyResult: '20,000 care mapping', target: 20000, actual: 0, grade: 0, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Enhance efficiency of the Clinical Vetting Engine', keyResult: 'Group 2,000 care items', target: 2000, actual: 380, grade: 0.19, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Enhance efficiency of the Clinical Vetting Engine', keyResult: 'Complete 50% Jubilee (KE & TZ) Customization', target: '50%', actual: '0%', grade: 0, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Strengthen Customer Acquisition & Retention', keyResult: 'Ensure client CVE result feedback/satisfaction is at >95%', target: '95%', actual: '89%', grade: 0.9368, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Strengthen Customer Acquisition & Retention', keyResult: 'Carry out 100% of Detection POCs from Sales team', target: 2, actual: 0, grade: 0, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Improve detection speed and output', keyResult: 'Achieve 100% TAT across all entities', target: '100%', actual: '95%', grade: 0.95, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Improve detection speed and output', keyResult: 'Maintain 99% CVE accuracy', target: '99%', actual: '99%', grade: 1.0, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Improve detection speed and output', keyResult: 'Clear 2,000+ controversial diagnoses', target: 2000, actual: 0, grade: 0, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
    { objective: 'Improve detection speed and output', keyResult: 'Review 20,000 claims pile', target: 20000, actual: 13067, grade: 0.65335, status: 'In Progress', startDate: '1/10/2025', dueDate: '31/12/2025' },
  ],
};

// ── Grade Pill ────────────────────────────────────────────────────────────

function GradePill({ grade, C }) {
  if (grade === null || grade === undefined || isNaN(grade)) {
    return <span style={{ fontSize: 12, color: C.muted }}>—</span>;
  }
  const pct = grade * 100;
  const color = gradeColor(grade);
  return (
    <div style={{
      background: color,
      color: '#fff',
      borderRadius: 8,
      padding: '5px 12px',
      fontSize: 13,
      fontWeight: 700,
      fontFamily: 'monospace',
      textAlign: 'center',
      minWidth: 72,
    }}>
      {pct > 200 ? '>200%' : `${pct.toFixed(1)}%`}
    </div>
  );
}

// ── Editable Row ──────────────────────────────────────────────────────────

function OKRRow({ row, idx, onUpdate, C, inp, td }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState({ target: row.target, actual: row.actual });

  const computedGrade = computeGrade(local.target, local.actual);

  const save = () => {
    onUpdate(idx, { ...row, target: local.target, actual: local.actual, grade: computedGrade });
    setEditing(false);
  };

  const color = gradeColor(row.grade);

  return (
    <tr
      style={{ borderLeft: `3px solid ${color}`, cursor: 'pointer' }}
      onClick={() => !editing && setEditing(true)}
    >
      <td style={{ ...td, color: C.muted, fontSize: 11, maxWidth: 160 }}>
        <div style={{ fontSize: 11, color: C.muted, fontStyle: 'italic', lineHeight: 1.3 }}>{row.objective || '—'}</div>
      </td>
      <td style={{ ...td, color: C.text, maxWidth: 280 }}>
        <div style={{ fontSize: 12, lineHeight: 1.4 }}>{row.keyResult}</div>
        <div style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
          {row.startDate && row.dueDate ? `${row.startDate} → ${row.dueDate}` : ''}
        </div>
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        {editing ? (
          <input
            value={local.target}
            onChange={e => setLocal(l => ({ ...l, target: e.target.value }))}
            style={{ ...inp, width: 80, textAlign: 'center' }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span style={{ fontSize: 13, color: C.sub, fontWeight: 600 }}>{formatTarget(row.target)}</span>
        )}
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        {editing ? (
          <input
            value={local.actual}
            onChange={e => setLocal(l => ({ ...l, actual: e.target.value }))}
            style={{ ...inp, width: 80, textAlign: 'center' }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span style={{ fontSize: 13, color: C.text, fontWeight: 700 }}>{formatTarget(row.actual)}</span>
        )}
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        <GradePill grade={editing ? computedGrade : row.grade} C={C} />
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        <span style={{
          fontSize: 11, padding: '3px 8px', borderRadius: 4,
          background: row.status === 'Done' ? '#22C55E22' : row.status === 'Pending' ? '#F9731622' : '#5B8DEF22',
          color: row.status === 'Done' ? '#22C55E' : row.status === 'Pending' ? '#F97316' : '#5B8DEF',
          fontWeight: 600,
        }}>
          {row.status || 'In Progress'}
        </span>
      </td>
      <td style={{ ...td, textAlign: 'center' }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
            <button onClick={save} style={{
              background: '#22C55E', color: '#fff', border: 'none',
              borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}>Save</button>
            <button onClick={() => { setLocal({ target: row.target, actual: row.actual }); setEditing(false); }} style={{
              background: 'transparent', color: C.muted, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}>Cancel</button>
          </div>
        ) : (
          <span style={{ fontSize: 11, color: C.muted }}>✏️ Edit</span>
        )}
      </td>
    </tr>
  );
}

// ── Summary Bar ───────────────────────────────────────────────────────────

function SummaryBar({ data, C }) {
  const valid = data.filter(r => r.grade !== null && !isNaN(r.grade));
  const avg = valid.length ? valid.reduce((s, r) => s + r.grade, 0) / valid.length : 0;
  const onTrack = valid.filter(r => r.grade >= 0.9).length;
  const progressing = valid.filter(r => r.grade >= 0.75 && r.grade < 0.9).length;
  const atRisk = valid.filter(r => r.grade < 0.75).length;

  const pill = (label, value, color) => (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: '12px 20px', flex: 1, minWidth: 120,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color }} />
      <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: C.text, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
      {pill('Avg Grade', `${(avg * 100).toFixed(1)}%`, gradeColor(avg))}
      {pill('Total KRs', valid.length, C.accent)}
      {pill('On Track', onTrack, '#5B8DEF')}
      {pill('Progressing', progressing, '#22C55E')}
      {pill('At Risk', atRisk, '#F97316')}
    </div>
  );
}

// ── Mini Quarter Card ─────────────────────────────────────────────────────

function QuarterCard({ quarter, data, active, onClick, C }) {
  const valid = data.filter(r => r.grade !== null && !isNaN(r.grade));
  const avg = valid.length ? valid.reduce((s, r) => s + r.grade, 0) / valid.length : 0;
  const color = gradeColor(avg);

  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, background: active ? color : C.card,
        border: `2px solid ${active ? color : C.border}`,
        borderRadius: 12, padding: '14px 20px', cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: active ? '#fff' : C.sub, marginBottom: 4 }}>{quarter}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: active ? '#fff' : C.text, fontFamily: 'monospace' }}>
        {(avg * 100).toFixed(0)}%
      </div>
      <div style={{ fontSize: 10, color: active ? '#ffffff99' : C.muted, marginTop: 2 }}>
        {valid.length} key results
      </div>
    </button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function OKRPage() {
  const { C } = useTheme();
  const [quarter, setQuarter] = useState('Q3');
  const [data, setData] = useState(SEED);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const fileRef = useRef();

  const currentData = data[quarter] || [];

  const handleUpdate = useCallback((idx, updated) => {
    setData(prev => ({
      ...prev,
      [quarter]: prev[quarter].map((r, i) => i === idx ? updated : r),
    }));
  }, [quarter]);

  const handleAddRow = () => {
    setData(prev => ({
      ...prev,
      [quarter]: [...prev[quarter], {
        objective: 'New Objective',
        keyResult: 'New Key Result',
        target: '',
        actual: '',
        grade: null,
        status: 'In Progress',
        startDate: '',
        dueDate: '',
      }],
    }));
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg('');
    try {
      const XLSX = await import('xlsx').catch(() => null);
      if (!XLSX) {
        setUploadMsg('⚠️ Upload requires SheetJS. Paste data manually.');
        setUploading(false);
        return;
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const newData = { ...data };
      const qSheets = { Q1: 'Q1', Q2: 'Q2', Q3: 'Q3', Q4: 'Q4' };
      let loaded = 0;
      Object.entries(qSheets).forEach(([q, sheet]) => {
        if (wb.SheetNames.includes(sheet)) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet]);
          const parsed = parseExcelData(rows);
          if (parsed.length > 0) {
            newData[q] = parsed;
            loaded++;
          }
        }
      });
      setData(newData);
      setUploadMsg(loaded > 0 ? `✅ Loaded ${loaded} quarter(s) from Excel` : '⚠️ No OKR data found — check sheet names (Q1, Q2, Q3, Q4)');
    } catch (err) {
      setUploadMsg('❌ Error reading file: ' + err.message);
    }
    setUploading(false);
    fileRef.current.value = '';
  };

  const exportCSV = () => {
    const headers = ['Quarter', 'Objective', 'Key Result', 'Target', 'Actual', 'Grade %', 'Status', 'Start Date', 'Due Date'];
    const rows = Object.entries(data).flatMap(([q, qdata]) =>
      qdata.map(r => [
        q, r.objective, r.keyResult, r.target, r.actual,
        r.grade !== null && !isNaN(r.grade) ? `${(r.grade * 100).toFixed(1)}%` : '',
        r.status, r.startDate, r.dueDate,
      ])
    );
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `okr-tracker-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const inp = {
    background: C.elevated, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '6px 10px', color: C.text, fontSize: 12, outline: 'none',
  };

  const th = {
    fontSize: 11, fontWeight: 600, color: C.muted,
    padding: '10px 14px', textAlign: 'left',
    borderBottom: `1px solid ${C.border}`,
    background: C.elevated, whiteSpace: 'nowrap',
  };

  const td = {
    fontSize: 12, padding: '10px 14px',
    borderBottom: `1px solid ${C.border}33`,
    verticalAlign: 'middle',
  };

  // Group by objective for better display
  const grouped = currentData.reduce((acc, row, idx) => {
    const key = row.objective || 'Other';
    if (!acc[key]) acc[key] = [];
    acc[key].push({ ...row, _idx: idx });
    return acc;
  }, {});

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>

      {/* Header */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '16px 24px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>🎯 OKR Tracker</h1>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: C.sub }}>
            Data Operations · 2026 · Click any row to edit Target or Actual
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={exportCSV} style={{
            background: C.elevated, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: '7px 14px', color: C.accent,
            fontSize: 12, cursor: 'pointer', fontWeight: 600,
          }}>⬇ Export CSV</button>
          <button onClick={() => fileRef.current.click()} disabled={uploading} style={{
            background: C.elevated, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: '7px 14px', color: C.sub,
            fontSize: 12, cursor: 'pointer',
          }}>📂 {uploading ? 'Reading…' : 'Upload Excel'}</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} style={{ display: 'none' }} />
        </div>
      </div>

      <div style={{ padding: '16px 24px' }}>

        {uploadMsg && (
          <div style={{
            marginBottom: 14, padding: '10px 16px', borderRadius: 8,
            background: uploadMsg.startsWith('✅') ? '#22C55E22' : '#F9731622',
            color: uploadMsg.startsWith('✅') ? '#22C55E' : '#F97316',
            fontSize: 12, fontWeight: 600,
          }}>{uploadMsg}</div>
        )}

        {/* Quarter selector */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {['Q1', 'Q2', 'Q3', 'Q4'].map(q => (
            <QuarterCard
              key={q}
              quarter={q}
              data={data[q] || []}
              active={quarter === q}
              onClick={() => setQuarter(q)}
              C={C}
            />
          ))}
        </div>

        {/* Summary stats */}
        <SummaryBar data={currentData} C={C} />

        {/* Grade legend */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: C.muted }}>Grade key:</span>
          {[
            { label: '≥ 90% — On Track', color: '#5B8DEF' },
            { label: '75–89% — Progressing', color: '#22C55E' },
            { label: '< 75% — At Risk', color: '#F97316' },
          ].map(({ label, color }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
              <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
            </div>
          ))}
        </div>

        {/* OKR Table — grouped by objective */}
        {Object.entries(grouped).map(([objective, rows]) => {
          const avgGrade = rows.filter(r => r.grade !== null && !isNaN(r.grade)).reduce((s, r) => s + r.grade, 0) / rows.filter(r => r.grade !== null && !isNaN(r.grade)).length;
          const color = gradeColor(avgGrade);
          return (
            <div key={objective} style={{ marginBottom: 20 }}>
              {/* Objective header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
                padding: '8px 14px', background: `${color}18`,
                borderRadius: '10px 10px 0 0', borderLeft: `4px solid ${color}`,
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color, flex: 1 }}>{objective}</span>
                <span style={{
                  fontSize: 11, background: color, color: '#fff',
                  borderRadius: 6, padding: '2px 10px', fontWeight: 700, fontFamily: 'monospace',
                }}>
                  {isNaN(avgGrade) ? '—' : `${(avgGrade * 100).toFixed(0)}% avg`}
                </span>
              </div>

              {/* KR table */}
              <div style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: '0 0 10px 10px', overflow: 'hidden',
              }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, width: 160 }}>Objective</th>
                        <th style={th}>Key Result</th>
                        <th style={{ ...th, textAlign: 'center', width: 100 }}>Target</th>
                        <th style={{ ...th, textAlign: 'center', width: 100 }}>Actual</th>
                        <th style={{ ...th, textAlign: 'center', width: 100 }}>Grade</th>
                        <th style={{ ...th, textAlign: 'center', width: 100 }}>Status</th>
                        <th style={{ ...th, textAlign: 'center', width: 90 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <OKRRow
                          key={row._idx}
                          row={row}
                          idx={row._idx}
                          onUpdate={handleUpdate}
                          C={C}
                          inp={inp}
                          td={td}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}

        {/* Add Row */}
        <button onClick={handleAddRow} style={{
          background: 'transparent', border: `2px dashed ${C.border}`,
          borderRadius: 10, padding: '12px 24px', color: C.muted,
          fontSize: 13, cursor: 'pointer', width: '100%', marginTop: 4,
        }}>
          + Add Key Result to {quarter}
        </button>
      </div>
    </div>
  );
}
