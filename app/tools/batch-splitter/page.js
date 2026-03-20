'use client';
import { useTheme } from '../../context/ThemeContext';
import { useState, useRef } from 'react';


export default function BatchSplitterPage() {
  const { C } = useTheme();
  const [file, setFile] = useState(null);
  const [batchSize, setBatchSize] = useState(5000);
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState('');
  const fileRef = useRef();

  const handleFile = (f) => {
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) { setError('Only CSV and Excel files are supported.'); return; }
    setError(''); setFile(f); setResult(null);
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); };

  const rowsToCSV = (rows) => {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const row of rows) {
      const line = headers.map(h => {
        const val = row[h] === null || row[h] === undefined ? '' : String(row[h]);
        if (val.includes(',') || val.includes('"') || val.includes('\n')) return '"' + val.replace(/"/g, '""') + '"';
        return val;
      });
      lines.push(line.join(','));
    }
    return lines.join('\n');
  };

  const handleSplit = async () => {
    if (!file) return;
    setStatus('loading'); setError(''); setResult(null);
    try {
      setProgress('Reading file...');
      const XLSX = await import('xlsx');
      const JSZipModule = await import('jszip');
      const JSZip = JSZipModule.default || JSZipModule;
      const arrayBuffer = await file.arrayBuffer();
      setProgress('Parsing rows...');
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (!rows.length) throw new Error('File is empty or has no data rows.');
      const totalRows = rows.length;
      const batchCount = Math.ceil(totalRows / batchSize);
      const baseName = file.name.replace(/\.[^.]+$/, '');
      const zip = new JSZip();
      for (let i = 0; i < batchCount; i++) {
        setProgress('Creating batch ' + (i + 1) + ' of ' + batchCount + '...');
        const batchRows = rows.slice(i * batchSize, Math.min((i + 1) * batchSize, totalRows));
        zip.file(baseName + '_batch_' + String(i + 1).padStart(3, '0') + '.csv', rowsToCSV(batchRows));
        await new Promise(r => setTimeout(r, 0));
      }
      setProgress('Zipping files...');
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url = URL.createObjectURL(zipBlob);
      setResult({ url, totalRows, batchCount, fileName: file.name, baseName });
      setStatus('done'); setProgress('');
    } catch (err) { setError(err.message); setStatus('error'); setProgress(''); }
  };

  const reset = () => { setFile(null); setResult(null); setStatus('idle'); setError(''); setProgress(''); };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '32px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ marginBottom: '32px' }}>
        <a href="/tools" style={{ color: C.sub, fontSize: '13px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px', marginBottom: '16px' }}>← Back to Tools</a>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span style={{ fontSize: '22px' }}>⚡</span>
          <h1 style={{ color: C.text, fontSize: '24px', fontWeight: 700, margin: 0 }}>Batch File Splitter</h1>
        </div>
        <p style={{ color: C.sub, fontSize: '14px', margin: 0 }}>Split large CSV or Excel files into batches. Processed entirely in your browser — no upload limit.</p>
      </div>
      <div style={{ maxWidth: '640px' }}>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ color: C.sub, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' }}>Upload File</label>
          <div onClick={() => fileRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
            style={{ border: '2px dashed ' + (dragOver ? C.accent : file ? C.accentDim : C.border), borderRadius: '12px', padding: '32px', textAlign: 'center', cursor: 'pointer', background: dragOver ? '#00E5A008' : C.card, transition: 'all 0.2s' }}>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            {file ? (
              <><div style={{ fontSize: '28px', marginBottom: '8px' }}>📄</div>
              <div style={{ color: C.accent, fontWeight: 600, fontSize: '14px' }}>{file.name}</div>
              <div style={{ color: C.sub, fontSize: '12px', marginTop: '4px' }}>{(file.size/1024/1024).toFixed(2)} MB — click to change</div></>
            ) : (
              <><div style={{ fontSize: '28px', marginBottom: '8px' }}>📂</div>
              <div style={{ color: C.text, fontWeight: 600, fontSize: '14px' }}>Drop file here or click to browse</div>
              <div style={{ color: C.sub, fontSize: '12px', marginTop: '4px' }}>Supports .csv, .xlsx, .xls · No size limit</div></>
            )}
          </div>
        </div>
        <div style={{ marginBottom: '24px' }}>
          <label style={{ color: C.sub, fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' }}>Rows Per Batch</label>
          <input type="number" min="100" max="500000" value={batchSize} onChange={e => setBatchSize(Number(e.target.value))}
            style={{ background: C.inputBg, border: '1px solid ' + C.border, borderRadius: '8px', color: C.text, fontSize: '14px', padding: '10px 14px', width: '180px', outline: 'none' }} />
          <div style={{ color: C.sub, fontSize: '12px', marginTop: '6px' }}>A 40,000-row file at 5,000 rows/batch = 8 output files</div>
        </div>
        {error && <div style={{ background: '#EF444418', border: '1px solid #EF444440', borderRadius: '10px', padding: '12px 16px', color: C.danger, fontSize: '13px', marginBottom: '20px' }}>⚠️ {error}</div>}
        {status !== 'done' && (
          <button onClick={handleSplit} disabled={!file || status === 'loading'}
            style={{ background: !file || status === 'loading' ? C.muted : C.accent, color: !file || status === 'loading' ? C.sub : '#0B0F1A', border: 'none', borderRadius: '10px', padding: '12px 28px', fontSize: '14px', fontWeight: 700, cursor: !file || status === 'loading' ? 'not-allowed' : 'pointer' }}>
            {status === 'loading' ? '⏳ ' + (progress || 'Processing...') : '⚡ Split File'}
          </button>
        )}
        {status === 'done' && result && (
          <div style={{ background: '#00E5A010', border: '1px solid #00E5A040', borderRadius: '12px', padding: '24px' }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: '16px', marginBottom: '12px' }}>✅ Split Complete</div>
            <div style={{ color: C.sub, fontSize: '13px', marginBottom: '4px' }}>Total rows: <span style={{ color: C.text, fontWeight: 600 }}>{Number(result.totalRows).toLocaleString()}</span></div>
            <div style={{ color: C.sub, fontSize: '13px', marginBottom: '20px' }}>Batches created: <span style={{ color: C.text, fontWeight: 600 }}>{result.batchCount}</span></div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <a href={result.url} download={result.baseName + '_batches.zip'}
                style={{ background: C.accent, color: '#0B0F1A', border: 'none', borderRadius: '10px', padding: '10px 22px', fontSize: '14px', fontWeight: 700, textDecoration: 'none', display: 'inline-block' }}>
                ⬇️ Download ZIP
              </a>
              <button onClick={reset} style={{ background: C.elevated, color: C.sub, border: '1px solid ' + C.border, borderRadius: '10px', padding: '10px 22px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
                Split Another File
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
