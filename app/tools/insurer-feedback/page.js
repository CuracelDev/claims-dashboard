'use client';
import { useState, useEffect, useRef } from 'react';
import { useTheme } from '../../context/ThemeContext';

const STATUS_META = {
  'Open':            { bg: '#EF444422', color: '#EF4444', dot: '#EF4444' },
  'In Review':       { bg: '#F59E0B22', color: '#F59E0B', dot: '#F59E0B' },
  'Fixed':           { bg: '#00E5A022', color: '#00E5A0', dot: '#00E5A0' },
  'Pending Insurer': { bg: '#5B8DEF22', color: '#5B8DEF', dot: '#5B8DEF' },
  'Closed':          { bg: '#4A556822', color: '#7A8FA6', dot: '#7A8FA6' },
};
const STATUSES = ['Open', 'In Review', 'Fixed', 'Pending Insurer', 'Closed'];

function StatusBadge({ status }) {
  const s = STATUS_META[status] || STATUS_META['Open'];
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
      {status}
    </span>
  );
}

function normalizeRow(raw, feedbackDate, insurerOverride) {
  const get = (keys) => {
    for (const k of keys) {
      const found = Object.keys(raw).find(r => r.trim().toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (found && raw[found] !== undefined && String(raw[found]).trim() !== '') return String(raw[found]).trim();
    }
    return '';
  };

  // Handle Excel serial dates (e.g. 46044 -> real date)
  const parseDate = (val) => {
    if (!val) return feedbackDate || '';
    const n = Number(val);
    if (!isNaN(n) && n > 40000 && n < 60000) {
      const date = new Date((n - 25569) * 86400 * 1000);
      return date.toISOString().split('T')[0];
    }
    return String(val).trim();
  };

  return {
    insurer: get(['insurer']) || insurerOverride || 'JBL Uganda',
    claim_id: get(['invoicenumber','invoice_number','claimid','claim_id','claimno','claim_no']),
    insurance_number: get(['insuranceno','insurance_no','memberno','member_no','enrolleeno','enrollee_no']),
    diagnosis: get(['diagnoses','diagnosis','icd','dx','condition']),
    care_item: get(['items','item','careitem','care_item','service','procedure','treatment']),
    issue_category: get(['adjudication','issuecategory','issue_category','category','errortype','error_type','adjudicationtype']),
    issue_description: get(['qacomment','qa_comment','issuedescription','issue_description','issue','comment','remarks','feedback','observation']),
    recommendation: get(['resolution','resolution2','recommendation','suggestedaction','action_required']),
    action_taken: get(['claimitemcomment','claim_item_comment','actiontaken','action_taken','our_response']),
    status: 'Open',
    owner: get(['name','owner','assignee','resolvedby']),
    feedback_date: parseDate(get(['encounterdate','encounter_date','feedbackdate','feedback_date','date'])),
    notes: get(['signsandsymptoms','signs_and_symptoms','notes','note','iterror','it_error']),
  };
}

export default function InsurerFeedbackPage() {
  const { C } = useTheme();
  const fileRef = useRef();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [uploadResult, setUploadResult] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterDiagnosis, setFilterDiagnosis] = useState('');
  const [filterCareItem, setFilterCareItem] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [feedbackDate, setFeedbackDate] = useState('');
  const [insurer, setInsurer] = useState('JBL Uganda');
  const [updatingId, setUpdatingId] = useState(null);

  useEffect(() => { fetchItems(); }, []);

  async function fetchItems() {
    setLoading(true);
    try {
      const res = await fetch('/api/tools/insurer-feedback');
      const data = await res.json();
      if (data.success) setItems(data.items || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handleFile(f) {
    if (!f) return;
    const ext = f.name.split('.').pop().toLowerCase();
    if (!['csv','xlsx','xls'].includes(ext)) { setError('Only CSV and Excel files are supported.'); return; }
    setError(''); setUploading(true); setUploadResult(null);
    try {
      setUploadProgress('Reading file...');
      const XLSX = await import('xlsx');
      const ab = await f.arrayBuffer();
      setUploadProgress('Parsing sheet...');
      const wb = XLSX.read(ab, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (!rows.length) throw new Error('File appears to be empty.');
      setUploadProgress('Saving ' + rows.length + ' records...');
      const normalized = rows.map(r => normalizeRow(r, feedbackDate, insurer));
      const res = await fetch('/api/tools/insurer-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: normalized }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save');
      setUploadResult({ count: data.count, fileName: f.name });
      setUploadProgress('');
      fetchItems();
    } catch (e) { setError(e.message); setUploadProgress(''); }
    setUploading(false);
  }

  async function updateStatus(id, status) {
    setUpdatingId(id);
    try {
      await fetch('/api/tools/insurer-feedback', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      setItems(prev => prev.map(i => i.id === id ? { ...i, status } : i));
      if (selectedItem?.id === id) setSelectedItem(prev => ({ ...prev, status }));
    } catch (e) { console.error(e); }
    setUpdatingId(null);
  }

  const total = items.length;
  const open = items.filter(i => i.status === 'Open').length;
  const fixed = items.filter(i => i.status === 'Fixed').length;
  const pending = items.filter(i => i.status === 'Pending Insurer').length;
  const inReview = items.filter(i => i.status === 'In Review').length;
  const diagnoses = [...new Set(items.map(i => i.diagnosis).filter(Boolean))].sort();
  const careItems = [...new Set(items.map(i => i.care_item).filter(Boolean))].sort();

  const filtered = items.filter(i => {
    const q = search.toLowerCase();
    const matchSearch = !q || [i.claim_id,i.insurance_number,i.issue_description,i.diagnosis,i.care_item].some(v => v?.toLowerCase().includes(q));
    return matchSearch && (!filterStatus || i.status === filterStatus) && (!filterDiagnosis || i.diagnosis === filterDiagnosis) && (!filterCareItem || i.care_item === filterCareItem);
  });

  const inp = { background: C.inputBg, border: '1px solid ' + C.border, borderRadius: '8px', color: C.text, fontSize: '13px', padding: '8px 12px', outline: 'none', width: '100%' };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ padding: '28px 32px' }}>
        <div style={{ marginBottom: '24px' }}>
          <a href="/tools" style={{ color: C.sub, fontSize: '13px', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px', marginBottom: '14px' }}>← Back to Tools</a>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
            <span style={{ fontSize: '22px' }}>🔍</span>
            <h1 style={{ color: C.text, fontSize: '24px', fontWeight: 700, margin: 0 }}>Insurer Feedback Intelligence</h1>
          </div>
          <p style={{ color: C.sub, fontSize: '14px', margin: 0 }}>Track, manage and resolve insurer feedback — starting with JBL Uganda.</p>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
          {[{label:'Total Items',value:total,color:C.text},{label:'Open',value:open,color:'#EF4444'},{label:'In Review',value:inReview,color:'#F59E0B'},{label:'Fixed',value:fixed,color:C.accent},{label:'Pending Insurer',value:pending,color:C.blue}].map(m => (
            <div key={m.label} style={{ background: C.card, border: '1px solid ' + C.border, borderRadius: '12px', padding: '16px 20px', flex: 1, minWidth: 110 }}>
              <div style={{ color: C.sub, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>{m.label}</div>
              <div style={{ color: m.color, fontSize: '26px', fontWeight: 700 }}>{m.value}</div>
            </div>
          ))}
        </div>

        <div style={{ background: C.card, border: '1px solid ' + C.border, borderRadius: '14px', padding: '24px', marginBottom: '24px' }}>
          <div style={{ color: C.text, fontSize: '15px', fontWeight: 700, marginBottom: '16px' }}>📤 Upload Feedback Sheet</div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={{ color: C.sub, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>Insurer</label>
              <input value={insurer} onChange={e => setInsurer(e.target.value)} style={inp} placeholder="JBL Uganda" />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={{ color: C.sub, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>Feedback Date</label>
              <input type="date" value={feedbackDate} onChange={e => setFeedbackDate(e.target.value)} style={inp} />
            </div>
          </div>
          <div onClick={() => fileRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
            style={{ border: '2px dashed ' + (dragOver ? C.accent : C.border), borderRadius: '10px', padding: '24px', textAlign: 'center', cursor: 'pointer', background: dragOver ? C.accent + '08' : C.elevated, transition: 'all 0.2s' }}>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            {uploading ? (
              <div style={{ color: C.accent, fontSize: '14px', fontWeight: 600 }}>⏳ {uploadProgress || 'Processing...'}</div>
            ) : uploadResult ? (
              <><div style={{ color: C.accent, fontWeight: 700, fontSize: '14px', marginBottom: '4px' }}>✅ {uploadResult.count} records imported from {uploadResult.fileName}</div><div style={{ color: C.sub, fontSize: '12px' }}>Click to upload another file</div></>
            ) : (
              <><div style={{ fontSize: '24px', marginBottom: '8px' }}>📂</div><div style={{ color: C.text, fontWeight: 600, fontSize: '14px' }}>Drop feedback sheet here or click to browse</div><div style={{ color: C.sub, fontSize: '12px', marginTop: '4px' }}>Supports .csv, .xlsx, .xls · No size limit</div></>
            )}
          </div>
          {error && <div style={{ background: C.danger + '18', border: '1px solid ' + C.danger + '40', borderRadius: '8px', padding: '10px 14px', color: C.danger, fontSize: '13px', marginTop: '12px' }}>⚠️ {error}</div>}
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search claim, member, issue..." style={{ ...inp, maxWidth: 260 }} />
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inp, maxWidth: 160 }}>
            <option value="">All Statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterDiagnosis} onChange={e => setFilterDiagnosis(e.target.value)} style={{ ...inp, maxWidth: 200 }}>
            <option value="">All Diagnoses</option>
            {diagnoses.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={filterCareItem} onChange={e => setFilterCareItem(e.target.value)} style={{ ...inp, maxWidth: 200 }}>
            <option value="">All Care Items</option>
            {careItems.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {(search || filterStatus || filterDiagnosis || filterCareItem) && (
            <button onClick={() => { setSearch(''); setFilterStatus(''); setFilterDiagnosis(''); setFilterCareItem(''); }} style={{ background: C.elevated, border: '1px solid ' + C.border, borderRadius: '8px', color: C.sub, fontSize: '13px', padding: '8px 14px', cursor: 'pointer' }}>Clear</button>
          )}
        </div>

        <div style={{ color: C.sub, fontSize: '13px', marginBottom: '12px' }}>
          {loading ? 'Loading...' : filtered.length + ' item' + (filtered.length !== 1 ? 's' : '') + (filtered.length !== items.length ? ' (filtered from ' + items.length + ')' : '')}
        </div>

        <div style={{ background: C.card, border: '1px solid ' + C.border, borderRadius: '14px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid ' + C.border }}>
                  {['Claim ID','Member No','Diagnosis','Care Item','Issue','Status','Date',''].map(h => (
                    <th key={h} style={{ color: C.sub, fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '12px 14px', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={{ color: C.sub, padding: '32px', textAlign: 'center' }}>Loading feedback items...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8} style={{ color: C.sub, padding: '32px', textAlign: 'center' }}>{items.length === 0 ? 'No feedback uploaded yet. Upload a sheet to get started.' : 'No items match your filters.'}</td></tr>
                ) : filtered.map((item, idx) => (
                  <tr key={item.id} style={{ borderBottom: '1px solid ' + C.border, background: idx % 2 === 0 ? 'transparent' : C.elevated + '50', cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = C.accent + '08'}
                    onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : C.elevated + '50'}
                    onClick={() => setSelectedItem(item)}>
                    <td style={{ padding: '11px 14px', color: C.accent, fontWeight: 600, whiteSpace: 'nowrap' }}>{item.claim_id || '—'}</td>
                    <td style={{ padding: '11px 14px', color: C.sub, whiteSpace: 'nowrap' }}>{item.insurance_number || '—'}</td>
                    <td style={{ padding: '11px 14px', color: C.text, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.diagnosis || '—'}</td>
                    <td style={{ padding: '11px 14px', color: C.text, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.care_item || '—'}</td>
                    <td style={{ padding: '11px 14px', color: C.sub, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.issue_description || item.issue_category || '—'}</td>
                    <td style={{ padding: '11px 14px' }}><StatusBadge status={item.status} /></td>
                    <td style={{ padding: '11px 14px', color: C.sub, whiteSpace: 'nowrap' }}>{item.feedback_date || '—'}</td>
                    <td style={{ padding: '11px 14px' }} onClick={e => e.stopPropagation()}>
                      <select value={item.status} onChange={e => updateStatus(item.id, e.target.value)} disabled={updatingId === item.id}
                        style={{ background: C.elevated, border: '1px solid ' + C.border, borderRadius: '6px', color: C.sub, fontSize: '11px', padding: '4px 8px', cursor: 'pointer', outline: 'none' }}>
                        {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selectedItem && (
        <div style={{ position: 'fixed', top: 0, right: 0, width: 400, height: '100vh', background: C.card, borderLeft: '1px solid ' + C.border, zIndex: 200, overflowY: 'auto', boxShadow: '-8px 0 32px rgba(0,0,0,0.3)' }}>
          <div style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div style={{ color: C.text, fontSize: '16px', fontWeight: 700 }}>Issue Detail</div>
              <button onClick={() => setSelectedItem(null)} style={{ background: C.elevated, border: '1px solid ' + C.border, borderRadius: '8px', color: C.sub, padding: '6px 12px', cursor: 'pointer', fontSize: '13px' }}>✕ Close</button>
            </div>
            <StatusBadge status={selectedItem.status} />
            <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {[{label:'Insurer',value:selectedItem.insurer},{label:'Claim ID',value:selectedItem.claim_id},{label:'Member / Insurance No',value:selectedItem.insurance_number},{label:'Feedback Date',value:selectedItem.feedback_date},{label:'Diagnosis',value:selectedItem.diagnosis},{label:'Care Item',value:selectedItem.care_item},{label:'Issue Category',value:selectedItem.issue_category},{label:'Issue Description',value:selectedItem.issue_description},{label:'Recommendation',value:selectedItem.recommendation},{label:'Action Taken',value:selectedItem.action_taken},{label:'Notes',value:selectedItem.notes}].map(f => f.value ? (
                <div key={f.label}>
                  <div style={{ color: C.sub, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>{f.label}</div>
                  <div style={{ color: C.text, fontSize: '13px', lineHeight: '1.5' }}>{f.value}</div>
                </div>
              ) : null)}
            </div>
            <div style={{ marginTop: '24px', borderTop: '1px solid ' + C.border, paddingTop: '20px' }}>
              <div style={{ color: C.sub, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Update Status</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {STATUSES.map(s => (
                  <button key={s} onClick={() => updateStatus(selectedItem.id, s)}
                    style={{ background: selectedItem.status === s ? STATUS_META[s].bg : C.elevated, border: '1px solid ' + (selectedItem.status === s ? STATUS_META[s].color + '60' : C.border), borderRadius: '8px', color: selectedItem.status === s ? STATUS_META[s].color : C.sub, padding: '9px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: selectedItem.status === s ? 700 : 400, textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META[s].dot, flexShrink: 0 }} />
                    {s}
                    {selectedItem.status === s && <span style={{ marginLeft: 'auto', fontSize: '11px' }}>✓ Current</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
