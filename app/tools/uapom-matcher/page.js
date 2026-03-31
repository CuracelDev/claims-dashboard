'use client';
import { useState, useRef } from 'react';
import { useTheme } from '../../context/ThemeContext';

const CURACEL_EXPECTED = {
  'Insurance No':     'Member ID — matched against UAPOM Member Number',
  'Encounter Date':   'Date — matched against UAPOM Transaction',
  'Amount Submitted': 'Claim total — matched against UAPOM Amount',
  'Enrollee Name':    'Patient name — used for fuzzy matching',
  'Provider Name':    'Provider — used for grouping',
  'Item Billed':      'Line item billed — difference analysis',
  'Approved Amount':  'Line item approved — difference analysis',
  'Claim Status':     'Current claim status',
  'Item Name':        'Treatment/service name',
  'id':               'Unique claim ID',
};

const UAPOM_EXPECTED = {
  'MEMBER NUMBER': 'Member ID — matched against Curacel Insurance No',
  'TRANSACTION':   'Date — matched against Curacel Encounter Date',
  'AMOUNT':        'Amount — matched against Curacel Amount Submitted',
  'PATIENT NAME':  'Name — used for fuzzy matching',
  'PROVIDER NAME': 'Provider name',
  'CLAIM ID':      'UAPOM claim reference',
  'SCHEME':        'Insurance scheme',
  'CLAIM TYPE':    'Type of claim',
};

const SC = {
  found:   { bg: '#C6EFCE', text: '#276221', border: '#82C887' },
  missing: { bg: '#FFC7CE', text: '#9C0006', border: '#FF8080' },
  extra:   { bg: '#FFEB9C', text: '#9C6500', border: '#FFD966' },
};

function FileDrop({ label, icon, file, onChange, accept, C }) {
  const ref = useRef();
  const [drag, setDrag] = useState(false);
  return (
    <div onClick={() => ref.current.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onChange(f); }}
      style={{ border: `2px dashed ${drag ? '#7B61FF' : file ? '#00E5A0' : C.border}`, borderRadius: 12, padding: '24px 20px', textAlign: 'center', cursor: 'pointer', background: drag ? '#7B61FF08' : file ? '#00E5A008' : C.elevated, transition: 'all 0.2s' }}>
      <input ref={ref} type="file" accept={accept} style={{ display: 'none' }} onChange={e => e.target.files[0] && onChange(e.target.files[0])} />
      <div style={{ fontSize: 26, marginBottom: 6 }}>{file ? '✅' : icon}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: file ? '#00E5A0' : C.text, marginBottom: 3 }}>{file ? file.name : label}</div>
      <div style={{ fontSize: 11, color: C.muted }}>{file ? `${(file.size / 1024).toFixed(1)} KB · Click to change` : 'Click or drag & drop'}</div>
    </div>
  );
}

function HeaderChecker({ title, detected, expected, C }) {
  const up = detected.map(h => h.trim().toUpperCase());
  const found = Object.keys(expected).filter(k => up.includes(k.toUpperCase()));
  const missing = Object.keys(expected).filter(k => !up.includes(k.toUpperCase()));
  const extra = detected.filter(h => !Object.keys(expected).map(k => k.toUpperCase()).includes(h.trim().toUpperCase()));
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>{detected.length} columns · {found.length}/{Object.keys(expected).length} required found</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {Object.keys(expected).map(key => {
          const ok = up.includes(key.toUpperCase());
          const s = ok ? SC.found : SC.missing;
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 10px', borderRadius: 6, background: s.bg, border: `1px solid ${s.border}` }}>
              <span style={{ fontSize: 11 }}>{ok ? '✓' : '✗'}</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: s.text }}>{key}</div>
                <div style={{ fontSize: 10, color: s.text, opacity: 0.8 }}>{expected[key]}</div>
              </div>
            </div>
          );
        })}
      </div>
      {extra.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', marginBottom: 4 }}>Extra ({extra.length}) — not used</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {extra.map(h => <span key={h} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: SC.extra.bg, color: SC.extra.text, border: `1px solid ${SC.extra.border}` }}>{h}</span>)}
          </div>
        </div>
      )}
      <div style={{ padding: '7px 12px', borderRadius: 7, background: missing.length === 0 ? SC.found.bg : SC.missing.bg, border: `1px solid ${missing.length === 0 ? SC.found.border : SC.missing.border}`, fontSize: 11, fontWeight: 700, color: missing.length === 0 ? SC.found.text : SC.missing.text }}>
        {missing.length === 0 ? '✅ Ready to run' : `⚠️ Missing: ${missing.join(', ')}`}
      </div>
    </div>
  );
}

function StatCard({ label, value, color, bg }) {
  return (
    <div style={{ background: bg, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div style={{ fontSize: 11, color, opacity: 0.8, marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function UAPOMMatcherPage() {
  const { C } = useTheme();
  const [mode, setMode] = useState('single'); // 'single' | 'batch'

  // Single mode
  const [curacalFile, setCuracalFile] = useState(null);
  const [uapomFile, setUapomFile] = useState(null);
  const [curacalHeaders, setCuracalHeaders] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Batch session mode
  const [sessionToken, setSessionToken] = useState(null);
  const [sessionUapom, setSessionUapom] = useState(null);
  const [batchFile, setBatchFile] = useState(null);
  const [batchHeaders, setBatchHeaders] = useState([]);
  const [batches, setBatches] = useState([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalResult, setFinalResult] = useState(null);
  const [sessionError, setSessionError] = useState(null);

  async function readCSVHeaders(file, setter) {
    try {
      const text = await file.text();
      const first = text.split('\n')[0];
      setter(first.split(',').map(h => h.replace(/"/g, '').trim()));
    } catch { setter([]); }
  }

  async function handleCuracel(file) {
    setCuracalFile(file); setResult(null); setError(null);
    await readCSVHeaders(file, setCuracalHeaders);
  }

  async function handleSingleRun() {
    if (!curacalFile || !uapomFile) return;
    setRunning(true); setResult(null); setError(null);
    try {
      // Step 1: Upload files through our API route to Vercel Blob
      setProgress('Uploading Curacel file...');
      const uploadFile = async (file) => {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('filename', file.name);
        const res = await fetch('/api/tools/uapom-matcher/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.url;
      };

      const curacalUrl = await uploadFile(curacalFile);
      setProgress('Uploading UAPOM file...');
      const uapomUrl = await uploadFile(uapomFile);
      setProgress('Files uploaded. Running matching analysis... this may take 1-2 minutes');

      // Step 2: Trigger analysis with blob URLs
      const res = await fetch('/api/tools/uapom-matcher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curacalUrl, uapomUrl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || 'Analysis failed'); setRunning(false); return; }
      setResult(data); setProgress('');
    } catch (err) { setError(err.message); }
    setRunning(false);
  }

  async function createSession() {
    if (!sessionUapom) return;
    setBatchRunning(true); setSessionError(null);
    const fd = new FormData();
    fd.append('uapom', sessionUapom);
    const res = await fetch('/api/tools/uapom-matcher/session', { method: 'POST', body: fd });
    const data = await res.json();
    setBatchRunning(false);
    if (!data.success) { setSessionError(data.error); return; }
    setSessionToken(data.token);
    setBatches([]);
  }

  async function runBatch() {
    if (!batchFile || !sessionToken) return;
    setBatchRunning(true); setSessionError(null);
    const fd = new FormData();
    fd.append('session_token', sessionToken);
    fd.append('curacel', batchFile);
    const res = await fetch('/api/tools/uapom-matcher/batch', { method: 'POST', body: fd });
    const data = await res.json();
    setBatchRunning(false);
    if (!data.success) { setSessionError(data.error); return; }
    setBatches(prev => [...prev, data]);
    setBatchFile(null); setBatchHeaders([]);
  }

  async function finalizeBatches() {
    if (!sessionToken) return;
    setFinalizing(true); setSessionError(null);
    const fd = new FormData();
    fd.append('session_token', sessionToken);
    fd.append('finalize', 'true');
    const res = await fetch('/api/tools/uapom-matcher/batch', { method: 'POST', body: fd });
    const data = await res.json();
    setFinalizing(false);
    if (!data.success) { setSessionError(data.error); return; }
    setFinalResult(data);
  }

  function resetSession() {
    setSessionToken(null); setSessionUapom(null);
    setBatches([]); setBatchFile(null); setBatchHeaders([]);
    setFinalResult(null); setSessionError(null);
  }

  const downloadUrl = (type, tok) =>
    `/api/tools/uapom-matcher/download?file=${type}&token=${tok}`;

  const legendItems = [
    { bg: '#C6EFCE', border: '#82C887', label: 'Perfect match' },
    { bg: '#FFEB9C', border: '#FFD966', label: 'Tolerance match (≤2)' },
    { bg: '#FFC7CE', border: '#FF8080', label: 'Not found' },
    { bg: '#DDEBF7', border: '#9DC3E6', label: 'Name match only' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: '32px', fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>🔀</span>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>UAPOM Claims Matcher</h1>
        </div>
        <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>Match Curacel extracted claims against UAPOM insurer data. Upload limit: 200MB per file.</p>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, background: C.elevated, borderRadius: 10, padding: 4, width: 'fit-content', border: `1px solid ${C.border}` }}>
        {[['single', '⚡ Single Run'], ['batch', '📦 Batch Session (Multi-Upload)']].map(([m, label]) => (
          <button key={m} onClick={() => setMode(m)} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: mode === m ? C.accent : 'transparent', color: mode === m ? '#0B0F1A' : C.muted, transition: 'all 0.15s' }}>{label}</button>
        ))}
      </div>

      {/* ── SINGLE MODE ── */}
      {mode === 'single' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>1. Curacel Extract (CSV)</div>
              <FileDrop label="Drop Curacel CSV here" icon="📄" file={curacalFile} onChange={handleCuracel} accept=".csv" C={C} />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>2. UAPOM Insurer Data (Excel)</div>
              <FileDrop label="Drop UAPOM Excel here" icon="📊" file={uapomFile} onChange={f => { setUapomFile(f); setResult(null); }} accept=".xlsx,.xls" C={C} />
            </div>
          </div>

          {curacalHeaders.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 10 }}>📋 Column Mapping Preview</div>
              <div style={{ display: 'flex', gap: 14 }}>
                <HeaderChecker title="Curacel Extract" detected={curacalHeaders} expected={CURACEL_EXPECTED} C={C} />
                <div style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3 }}>UAPOM Data</div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>Excel — headers validated on run</div>
                  {Object.keys(UAPOM_EXPECTED).map(k => (
                    <div key={k} style={{ fontSize: 11, padding: '4px 8px', marginBottom: 3, borderRadius: 5, background: C.elevated, color: C.muted }}>
                      <strong style={{ color: C.text }}>{k}</strong> — {UAPOM_EXPECTED[k]}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
            {legendItems.map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 11, height: 11, borderRadius: 3, background: l.bg, border: `1px solid ${l.border}` }} />
                <span style={{ fontSize: 11, color: C.muted }}>{l.label}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            <button onClick={handleSingleRun} disabled={running || !curacalFile || !uapomFile} style={{ padding: '11px 28px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 700, cursor: running || !curacalFile || !uapomFile ? 'not-allowed' : 'pointer', background: running || !curacalFile || !uapomFile ? C.elevated : 'linear-gradient(135deg, #7B61FF, #00E5A0)', color: running || !curacalFile || !uapomFile ? C.muted : '#0B0F1A', transition: 'all 0.2s' }}>
              {running ? '⏳ Running...' : '🚀 Run Analysis'}
            </button>
            {progress && <span style={{ fontSize: 12, color: C.muted }}>{progress}</span>}
          </div>

          {error && <div style={{ background: '#FFC7CE', border: '1px solid #FF8080', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#9C0006' }}>⚠️ {error}</div>}

          {result && (
            <>
              {result.date_label && <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>📅 Period: <strong style={{ color: C.text }}>{result.date_label}</strong></div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
                <StatCard label="Perfect Matches" value={result.perfect_matches} color="#276221" bg="#C6EFCE" />
                <StatCard label="Tolerance Matches" value={result.tolerance_matches} color="#9C6500" bg="#FFEB9C" />
                <StatCard label="Unmatched Curacel" value={result.unmatched_curacel} color="#9C0006" bg="#FFC7CE" />
                <StatCard label="Unmatched UAPOM" value={result.unmatched_uapom} color="#9C0006" bg="#FFC7CE" />
                <StatCard label="Name Matches" value={result.name_matches} color="#1F4E79" bg="#DDEBF7" />
                <StatCard label="Providers" value={result.providers} color={C.text} bg={C.elevated} />
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <a href={downloadUrl('zip', result.token)} style={{ padding: '10px 24px', borderRadius: 9, textDecoration: 'none', background: 'linear-gradient(135deg, #7B61FF, #00E5A0)', color: '#0B0F1A', fontSize: 13, fontWeight: 700 }}>
                  📦 Download ZIP — {result.zip_name}
                </a>
                <a href={downloadUrl('master', result.token)} style={{ padding: '10px 24px', borderRadius: 9, textDecoration: 'none', background: C.elevated, border: `1px solid ${C.border}`, color: C.text, fontSize: 13, fontWeight: 700 }}>
                  📊 Master Excel — {result.master_name}
                </a>
              </div>
            </>
          )}
        </>
      )}

      {/* ── BATCH SESSION MODE ── */}
      {mode === 'batch' && (
        <>
          {!sessionToken ? (
            <>
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>Step 1 — Upload UAPOM File Once</div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>This stays loaded for the entire session. You'll add Curacel batches next.</div>
                <FileDrop label="Drop UAPOM Excel here" icon="📊" file={sessionUapom} onChange={setSessionUapom} accept=".xlsx,.xls" C={C} />
                <button onClick={createSession} disabled={batchRunning || !sessionUapom} style={{ marginTop: 14, padding: '10px 24px', borderRadius: 9, border: 'none', fontSize: 13, fontWeight: 700, cursor: batchRunning || !sessionUapom ? 'not-allowed' : 'pointer', background: batchRunning || !sessionUapom ? C.elevated : 'linear-gradient(135deg, #7B61FF, #00E5A0)', color: batchRunning || !sessionUapom ? C.muted : '#0B0F1A' }}>
                  {batchRunning ? '⏳ Creating session...' : '✅ Start Session'}
                </button>
              </div>
              {sessionError && <div style={{ background: '#FFC7CE', border: '1px solid #FF8080', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#9C0006' }}>⚠️ {sessionError}</div>}
            </>
          ) : !finalResult ? (
            <>
              {/* Session active */}
              <div style={{ background: '#C6EFCE', border: '1px solid #82C887', borderRadius: 10, padding: '10px 16px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#276221' }}>✅ Session Active — UAPOM loaded</div>
                  <div style={{ fontSize: 11, color: '#276221', opacity: 0.8 }}>Token: {sessionToken} · {batches.length} batch{batches.length !== 1 ? 'es' : ''} run so far</div>
                </div>
                <button onClick={resetSession} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 7, border: '1px solid #82C887', background: 'none', color: '#276221', cursor: 'pointer' }}>Reset Session</button>
              </div>

              {/* Batch history */}
              {batches.length > 0 && (
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 10 }}>Completed Batches</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {batches.map((b, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: C.elevated, borderRadius: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>Batch {b.batch}</span>
                        <span style={{ fontSize: 11, color: C.muted }}>📅 {b.date_label}</span>
                        <span style={{ fontSize: 11, color: '#276221' }}>✓ {b.perfect_matches} perfect</span>
                        <span style={{ fontSize: 11, color: '#9C6500' }}>~ {b.tolerance_matches} tolerance</span>
                        <span style={{ fontSize: 11, color: '#9C0006' }}>✗ {b.unmatched_curacel} unmatched</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add batch */}
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>Step 2 — Upload Curacel Batch {batches.length + 1}</div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>Upload the next Curacel CSV. Headers are locked — columns will align automatically.</div>
                <FileDrop label={`Drop Curacel Batch ${batches.length + 1} CSV`} icon="📄" file={batchFile}
                  onChange={async f => { setBatchFile(f); await readCSVHeaders(f, setBatchHeaders); }} accept=".csv" C={C} />
                {batchHeaders.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <HeaderChecker title={`Batch ${batches.length + 1} Columns`} detected={batchHeaders} expected={CURACEL_EXPECTED} C={C} />
                  </div>
                )}
                <button onClick={runBatch} disabled={batchRunning || !batchFile} style={{ marginTop: 14, padding: '10px 24px', borderRadius: 9, border: 'none', fontSize: 13, fontWeight: 700, cursor: batchRunning || !batchFile ? 'not-allowed' : 'pointer', background: batchRunning || !batchFile ? C.elevated : '#7B61FF', color: batchRunning || !batchFile ? C.muted : '#fff' }}>
                  {batchRunning ? '⏳ Running batch...' : `▶ Run Batch ${batches.length + 1}`}
                </button>
              </div>

              {sessionError && <div style={{ background: '#FFC7CE', border: '1px solid #FF8080', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#9C0006' }}>⚠️ {sessionError}</div>}

              {/* Finalize */}
              {batches.length > 0 && (
                <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Done uploading batches?</div>
                    <div style={{ fontSize: 12, color: C.muted }}>Merge all {batches.length} batch{batches.length !== 1 ? 'es' : ''} into one master file with aligned headers.</div>
                  </div>
                  <button onClick={finalizeBatches} disabled={finalizing} style={{ padding: '10px 24px', borderRadius: 9, border: 'none', fontSize: 13, fontWeight: 700, cursor: finalizing ? 'not-allowed' : 'pointer', background: finalizing ? C.elevated : 'linear-gradient(135deg, #7B61FF, #00E5A0)', color: finalizing ? C.muted : '#0B0F1A' }}>
                    {finalizing ? '⏳ Finalizing...' : '🏁 Finish & Build Final Report'}
                  </button>
                </div>
              )}
            </>
          ) : (
            /* Final result */
            <>
              <div style={{ background: '#C6EFCE', border: '1px solid #82C887', borderRadius: 12, padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#276221', marginBottom: 4 }}>🎉 Analysis Complete!</div>
                <div style={{ fontSize: 12, color: '#276221' }}>Period: {finalResult.date_label} · {batches.length} batches merged with aligned headers</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 18 }}>
                <StatCard label="Perfect Matches" value={finalResult.perfect_matches} color="#276221" bg="#C6EFCE" />
                <StatCard label="Tolerance Matches" value={finalResult.tolerance_matches} color="#9C6500" bg="#FFEB9C" />
                <StatCard label="Unmatched Curacel" value={finalResult.unmatched_curacel} color="#9C0006" bg="#FFC7CE" />
                <StatCard label="Unmatched UAPOM" value={finalResult.unmatched_uapom} color="#9C0006" bg="#FFC7CE" />
                <StatCard label="Name Matches" value={finalResult.name_matches} color="#1F4E79" bg="#DDEBF7" />
                <StatCard label="Providers" value={finalResult.providers} color={C.text} bg={C.elevated} />
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <a href={`/api/tools/uapom-matcher/download?file=zip&token=session_${sessionToken}`}
                  style={{ padding: '10px 24px', borderRadius: 9, textDecoration: 'none', background: 'linear-gradient(135deg, #7B61FF, #00E5A0)', color: '#0B0F1A', fontSize: 13, fontWeight: 700 }}>
                  📦 Download ZIP — {finalResult.zip_name}
                </a>
                <a href={`/api/tools/uapom-matcher/download?file=master&token=session_${sessionToken}`}
                  style={{ padding: '10px 24px', borderRadius: 9, textDecoration: 'none', background: C.elevated, border: `1px solid ${C.border}`, color: C.text, fontSize: 13, fontWeight: 700 }}>
                  📊 Master Excel — {finalResult.master_name}
                </a>
              </div>
              <button onClick={resetSession} style={{ fontSize: 12, padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'none', color: C.muted, cursor: 'pointer' }}>
                Start New Session
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
