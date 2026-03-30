'use client';
// app/tools/report-converter/page.js
// Converts weekly Health Ops Excel reports → bulk import CSV
// Built by Fade & Moe ✦

import { useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import * as XLSX from 'xlsx';

const METRIC_MAP = {
  'Num of Providers Mapped':            'providers_mapped',
  'Num of Care items Mapped':           'care_items_mapped',
  'Num of Care Items Mapped':           'care_items_mapped',
  'Num of care items Mapped':           'care_items_mapped',
  'Num of Care items Grouped':          'care_items_grouped',
  'Num of Care Items Grouped':          'care_items_grouped',
  'Kenya':                              'claims_kenya',
  'Tanzania':                           'claims_tanzania',
  'Uganda':                             'claims_uganda',
  'UAP Old Mutual':                     'claims_uap',
  'UAP Old Mutual ':                    'claims_uap',
  'Defmis':                             'claims_defmis',
  'Hadiel Tech':                        'claims_hadiel',
  'AXA':                                'claims_axa',
  'Num of Auto P.A Reviewed/Approved':  'auto_pa_reviewed',
  'Num of Flagged Care Items':          'flagged_care_items',
  'Number of ICD10 Adjusted (Jubilee)': 'icd10_adjusted',
  'Num Benefits set up':                'benefits_set_up',
  'Num Benefits Set up':                'benefits_set_up',
  'Providers assigned':                 'providers_assigned',
  'Providers Assigned':                 'providers_assigned',
  'Resolved Cares':                     'resolved_cares',
};

const CSV_COLS = [
  'member_name','report_date','claims_kenya','claims_tanzania','claims_uganda',
  'claims_uap','claims_defmis','claims_hadiel','claims_axa','providers_mapped',
  'care_items_mapped','care_items_grouped','resolved_cares','auto_pa_reviewed',
  'flagged_care_items','icd10_adjusted','benefits_set_up','providers_assigned',
  'tasks_completed','notes',
];

const TEAM_MEMBERS = ['Emmanuel','Morenike','Muyiwa','Daniel','Sophie','Intern'];

function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const date = new Date((serial - 25569) * 86400 * 1000);
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const y = date.getUTCFullYear();
  return `${d}/${m}/${y}`;
}

function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? 0 : n;
}

function convertRows(data, memberName) {
  const rows = data;
  const dateRowIndices = rows.reduce((acc, r, i) => {
    if (r[0] === 'Daily Metrics') acc.push(i);
    return acc;
  }, []);

  const csvRows = [];
  const errors  = [];

  for (const blockStart of dateRowIndices) {
    const dateRow = rows[blockStart];
    const dates   = Array.from({ length: 7 }, (_, i) => excelDateToISO(dateRow[i + 1]));
    const blockEnd = dateRowIndices.find(i => i > blockStart) ?? rows.length;

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const d = dates[dayIdx];
      if (!d) continue;
      const col = dayIdx + 1;
      const metrics = {};
      CSV_COLS.forEach(k => {
        if (!['member_name','report_date','tasks_completed','notes'].includes(k)) metrics[k] = 0;
      });

      for (let ri = blockStart + 1; ri < blockEnd; ri++) {
        const label = String(rows[ri][0] || '').trim();
        if (METRIC_MAP[label]) {
          const val = rows[ri][col];
          metrics[METRIC_MAP[label]] = toInt(val);
        }
      }

      if (Object.values(metrics).some(v => v > 0)) {
        csvRows.push({ member_name: memberName, report_date: d, ...metrics, tasks_completed: '', notes: '' });
      }
    }
  }

  return { csvRows, errors };
}

function toCSV(rows) {
  const header = CSV_COLS.join(',');
  const lines  = rows.map(r => CSV_COLS.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
  return [header, ...lines].join('\n');
}

export default function ReportConverterPage() {
  const { C } = useTheme();
  const [memberName, setMemberName] = useState('');
  const [file,       setFile]       = useState(null);
  const [result,     setResult]     = useState(null);
  const [error,      setError]      = useState('');
  const [converting, setConverting] = useState(false);

  async function handleConvert() {
    if (!file || !memberName) {
      setError('Please select your name and upload a file.');
      return;
    }
    setConverting(true);
    setError('');
    setResult(null);

    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

      const { csvRows, errors } = convertRows(data, memberName);

      if (csvRows.length === 0) {
        setError('No data rows found. Make sure this is a valid Health Ops report file.');
        setConverting(false);
        return;
      }

      setResult({ csvRows, errors, csv: toCSV(csvRows) });
    } catch (e) {
      setError(`Failed to parse file: ${e.message}`);
    } finally {
      setConverting(false);
    }
  }

  function handleDownload() {
    if (!result) return;
    const blob = new Blob([result.csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${memberName}_reports_import.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleReset() {
    setFile(null); setResult(null); setError(''); setMemberName('');
  }

  const inp = {
    background: C.inputBg, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '9px 12px', color: C.text,
    fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>
      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '16px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>🔄 Health Ops Report Converter</h1>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: C.sub }}>
          Convert your weekly Excel report → bulk import CSV
        </p>
      </div>

      <div style={{ padding: '24px', maxWidth: 680, margin: '0 auto' }}>

        {!result ? (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28 }}>

            {/* Step 1 — Name */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Step 1 — Who are you?
              </div>
              <select value={memberName} onChange={e => setMemberName(e.target.value)} style={inp}>
                <option value="">Select your name</option>
                {TEAM_MEMBERS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>

            {/* Step 2 — Upload */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Step 2 — Upload your Excel report
              </div>
              <label style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: 10, padding: '20px',
                border: `2px dashed ${file ? C.accent : C.border}`,
                borderRadius: 12, cursor: 'pointer',
                background: file ? `${C.accent}08` : C.elevated,
                transition: 'all 0.15s',
              }}>
                <span style={{ fontSize: 22 }}>{file ? '✅' : '📂'}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: file ? C.accent : C.text }}>
                    {file ? file.name : 'Choose Excel file (.xlsx)'}
                  </div>
                  {file && (
                    <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
                      {(file.size / 1024).toFixed(1)} KB
                    </div>
                  )}
                </div>
                <input
                  type="file" accept=".xlsx,.xls"
                  style={{ display: 'none' }}
                  onChange={e => { if (e.target.files[0]) { setFile(e.target.files[0]); setError(''); } }}
                />
              </label>
            </div>

            {/* Error */}
            {error && (
              <div style={{ marginBottom: 16, fontSize: 12, color: C.danger, background: `${C.danger}10`, border: `1px solid ${C.danger}33`, borderRadius: 8, padding: '10px 14px' }}>
                ⚠️ {error}
              </div>
            )}

            {/* Convert button */}
            <button
              onClick={handleConvert}
              disabled={converting || !file || !memberName}
              style={{
                width: '100%', padding: '13px',
                background: file && memberName && !converting
                  ? `linear-gradient(135deg, ${C.accent}, #00C48C)`
                  : C.elevated,
                border: 'none', borderRadius: 10,
                fontSize: 14, fontWeight: 700,
                color: file && memberName && !converting ? C.bg : C.sub,
                cursor: file && memberName && !converting ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              {converting ? '⏳ Converting...' : '🔄 Convert to Import CSV'}
            </button>
          </div>
        ) : (
          /* Result */
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 28 }}>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>✅</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.accent, marginBottom: 6 }}>
                Conversion Complete
              </div>
              <div style={{ fontSize: 13, color: C.sub }}>
                {result.csvRows.length} days converted for <strong style={{ color: C.text }}>{memberName}</strong>
              </div>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 24 }}>
              <div style={{ background: `${C.accent}12`, border: `1px solid ${C.accent}33`, borderRadius: 10, padding: '14px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: C.accent }}>{result.csvRows.length}</div>
                <div style={{ fontSize: 11, color: C.sub }}>Days converted</div>
              </div>
              {result.errors.length > 0 && (
                <div style={{ background: `${C.warn}12`, border: `1px solid ${C.warn}33`, borderRadius: 10, padding: '14px 24px', textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: C.warn }}>{result.errors.length}</div>
                  <div style={{ fontSize: 11, color: C.sub }}>Warnings</div>
                </div>
              )}
            </div>

            {/* Preview */}
            <div style={{ background: C.elevated, borderRadius: 10, padding: 14, marginBottom: 20, fontSize: 11, color: C.sub, fontFamily: 'monospace', maxHeight: 120, overflowY: 'auto' }}>
              <div style={{ color: C.muted, marginBottom: 6 }}>Preview (first 3 rows):</div>
              {result.csvRows.slice(0, 3).map((r, i) => (
                <div key={i} style={{ marginBottom: 3 }}>
                  {r.member_name} · {r.report_date} · cares: {r.care_items_mapped} · uganda: {r.claims_uganda} · resolved: {r.resolved_cares}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleDownload}
                style={{
                  flex: 1, padding: '12px',
                  background: `linear-gradient(135deg, ${C.accent}, #00C48C)`,
                  border: 'none', borderRadius: 10,
                  fontSize: 14, fontWeight: 700, color: C.bg, cursor: 'pointer',
                }}
              >
                ⬇ Download CSV
              </button>
              <button
                onClick={handleReset}
                style={{
                  padding: '12px 20px', background: C.elevated,
                  border: `1px solid ${C.border}`, borderRadius: 10,
                  fontSize: 13, color: C.sub, cursor: 'pointer',
                }}
              >
                Convert another
              </button>
            </div>
          </div>
        )}

        {/* Instructions */}
        <div style={{ marginTop: 20, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            How it works
          </div>
          {[
            ['1', 'Select your name from the dropdown'],
            ['2', 'Upload your weekly Health Ops Excel report (.xlsx)'],
            ['3', 'Click Convert — rows with no data are skipped automatically'],
            ['4', 'Download the CSV'],
            ['5', 'Go to Daily Reports → History → Import Past Reports → upload the CSV'],
          ].map(([num, text]) => (
            <div key={num} style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'flex-start' }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${C.accent}20`, color: C.accent, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {num}
              </div>
              <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5 }}>{text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
