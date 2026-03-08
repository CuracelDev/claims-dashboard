'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

const C = {
  accent: "#00E5A0", bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", success: "#34D399", blue: "#5B8DEF", purple: "#A78BFA", warn: "#FFB84D",
};
const DEFAULT_METRIC_GROUPS = [
  { category: 'mapping_data', label: '📦 Mapping & Data', color: C.blue, metrics: [{ key: 'providers_mapped', label: 'Providers Mapped' }, { key: 'care_items_mapped', label: 'Care Items Mapped' }, { key: 'care_items_grouped', label: 'Care Items Grouped' }, { key: 'resolved_cares', label: 'Resolved Cares' }] },
  { category: 'claims_piles', label: '📊 Claims Piles Checked', color: C.purple, metrics: [{ key: 'claims_kenya', label: 'Kenya' }, { key: 'claims_tanzania', label: 'Tanzania' }, { key: 'claims_uganda', label: 'Uganda' }, { key: 'claims_uap', label: 'UAP Old Mutual' }, { key: 'claims_defmis', label: 'Defmis' }, { key: 'claims_hadiel', label: 'Hadiel Tech' }, { key: 'claims_axa', label: 'AXA' }] },
  { category: 'quality_review', label: '✅ Quality & Review', color: C.accent, metrics: [{ key: 'auto_pa_reviewed', label: 'Auto PA Reviewed' }, { key: 'auto_pa_approved', label: 'Auto PA Approved' }, { key: 'flagged_care_items', label: 'Flagged Care Items' }, { key: 'icd10_adjusted', label: 'ICD10 Adjusted (Jubilee)' }, { key: 'benefits_set_up', label: 'Benefits Set Up' }, { key: 'providers_assigned', label: 'Providers Assigned' }] },
];
const inputStyle = { background: '#0B0F1A', border: '1px solid #1E2D3D', borderRadius: 8, color: '#F0F4F8', padding: '8px 12px', fontSize: 13, width: '100%', outline: 'none', boxSizing: 'border-box' };
const cardStyle = { background: '#111827', border: '1px solid #1E2D3D', borderRadius: 12, padding: 20, marginBottom: 16 };
const labelStyle = { fontSize: 11, color: '#8899AA', marginBottom: 4, display: 'block' };
const btn = (bg, color, disabled) => ({ padding: '9px 20px', background: disabled ? '#1A2332' : bg, color: disabled ? '#556677' : color, border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer' });

const todayStr = () => new Date().toISOString().split('T')[0];
const DRAFT_TTL = 48 * 60 * 60 * 1000;
const draftKey = (memberId, date) => `ho_draft_${memberId}_${date}`;

function saveDraft(memberId, date, data) {
  try { localStorage.setItem(draftKey(memberId, date), JSON.stringify({ ...data, _savedAt: Date.now() })); } catch {}
}
function loadDraft(memberId, date) {
  try {
    const raw = localStorage.getItem(draftKey(memberId, date));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (Date.now() - d._savedAt > DRAFT_TTL) { localStorage.removeItem(draftKey(memberId, date)); return null; }
    return d;
  } catch { return null; }
}
function clearDraft(memberId, date) {
  try { localStorage.removeItem(draftKey(memberId, date)); } catch {}
}

function exportToCSV(reports, filename) {
  if (!reports.length) return;
  const keys = [...new Set(reports.flatMap(r => Object.keys(r.metrics || {})))];
  const headers = ['Date', 'Team Member', 'Role', 'Status', 'Sent to Slack', ...keys.map(k => k.replace(/_/g, ' ')), 'Tasks Completed', 'Notes'];
  const rows = reports.map(r => [r.report_date, r.team_members?.name || '', r.team_members?.role || '', r.status || '', r.sent_to_slack ? 'Yes' : 'No', ...keys.map(k => r.metrics?.[k] || ''), `"${(r.tasks_completed || '').replace(/"/g, '""')}"`, `"${(r.notes || '').replace(/"/g, '""')}"`]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Draft Banner ───────────────────────────────────────────────────────────
function DraftBanner({ savedAt, onRestore, onDiscard }) {
  const timeAgo = () => {
    const mins = Math.floor((Date.now() - savedAt) / 60000);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) return `${hrs}h ${mins % 60}m ago`;
    return mins < 1 ? 'just now' : `${mins}m ago`;
  };
  return (
    <div style={{ background: '#FFB84D18', border: '1px solid #FFB84D55', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ fontSize: 20 }}>📋</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.warn }}>Unsaved draft found</div>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>You started a report {timeAgo()} — tab was closed before saving. Restore it?</div>
      </div>
      <button onClick={onRestore} style={{ padding: '6px 16px', background: C.warn, color: '#0B0F1A', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Restore</button>
      <button onClick={onDiscard} style={{ padding: '6px 12px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, color: C.sub, fontSize: 12, cursor: 'pointer' }}>Discard</button>
    </div>
  );
}

// ── Edit Mode Banner ───────────────────────────────────────────────────────
function EditBanner({ reportDate }) {
  const date = new Date(reportDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div style={{ background: '#5B8DEF18', border: '1px solid #5B8DEF44', borderRadius: 10, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 18 }}>✏️</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.blue }}>Editing existing report</div>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 1 }}>Report for {date} already saved — any changes will update it.</div>
      </div>
    </div>
  );
}

// ── Preview Modal ──────────────────────────────────────────────────────────
function PreviewModal({ report, member, metricGroups, onClose, onSendSlack }) {
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(report.sent_to_slack);
  const date = new Date((report.report_date || todayStr()) + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const formatText = () => {
    const lines = [`📋 Daily Report — ${member?.name || ''}`, `${date} | ${member?.role || ''}`, ''];
    for (const g of metricGroups) {
      const filled = g.metrics.filter(m => { const v = report.metrics?.[m.key]; return v && parseInt(v) > 0; });
      if (filled.length) { lines.push(g.label.replace(/[📦📊✅]/g, '').trim()); filled.forEach(m => lines.push(`  • ${m.label}: ${report.metrics[m.key]}`)); lines.push(''); }
    }
    if (report.tasks_completed) { lines.push('🗒 Tasks Completed'); lines.push(report.tasks_completed); lines.push(''); }
    if (report.notes) { lines.push('💬 Notes'); lines.push(report.notes); }
    return lines.join('\n');
  };

  const total = Object.values(report.metrics || {}).map(v => parseInt(v)).filter(n => !isNaN(n)).reduce((a, b) => a + b, 0);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000090', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: C.card, borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: `1px solid ${C.border}` }}>
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Report Preview</div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{member?.name} · {date}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.sub, fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            <div style={{ flex: 1, background: C.elevated, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: C.accent }}>{total}</div>
              <div style={{ fontSize: 11, color: C.sub }}>Total Output</div>
            </div>
            <div style={{ flex: 1, background: C.elevated, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: C.blue }}>{Object.values(report.metrics || {}).filter(v => v && parseInt(v) > 0).length}</div>
              <div style={{ fontSize: 11, color: C.sub }}>Metrics Filled</div>
            </div>
          </div>
          {metricGroups.map(g => {
            const filled = g.metrics.filter(m => { const v = report.metrics?.[m.key]; return v && parseInt(v) > 0; });
            if (!filled.length) return null;
            return (
              <div key={g.category} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: g.color, marginBottom: 8 }}>{g.label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {filled.map(m => (
                    <div key={m.key} style={{ background: C.elevated, borderRadius: 8, padding: '8px 12px', display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: C.sub }}>{m.label}</span>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{report.metrics[m.key]}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {report.tasks_completed && <div style={{ marginBottom: 12 }}><div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6 }}>🗒 Tasks Completed</div><div style={{ background: C.elevated, borderRadius: 8, padding: '10px 14px', fontSize: 13, whiteSpace: 'pre-wrap' }}>{report.tasks_completed}</div></div>}
          {report.notes && <div><div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6 }}>💬 Notes</div><div style={{ background: C.elevated, borderRadius: 8, padding: '10px 14px', fontSize: 13, whiteSpace: 'pre-wrap' }}>{report.notes}</div></div>}
        </div>
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10 }}>
          <button onClick={() => { navigator.clipboard.writeText(formatText()); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={{ ...btn(C.elevated, C.text, false), flex: 1, border: `1px solid ${C.border}` }}>
            {copied ? '✓ Copied!' : '📋 Copy Text'}
          </button>
          <button onClick={async () => { setSending(true); const ok = await onSendSlack(report, member); if (ok) setSent(true); setSending(false); }} disabled={sending || sent} style={{ ...btn('#4A154B', '#fff', sent), flex: 1 }}>
            {sending ? 'Sending…' : sent ? '✓ Sent to Slack' : '📤 Send to Slack'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Metric Group ──────────────────────────────────────────────────────────
function MetricGroup({ group, metrics, onChange }) {
  return (
    <div style={{ ...cardStyle, borderTop: `3px solid ${group.color}` }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: group.color, marginBottom: 14 }}>{group.label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
        {group.metrics.map(m => (
          <div key={m.key}>
            <label style={labelStyle}>{m.label}</label>
            <input type="number" min="0" value={metrics[m.key] ?? ''} onChange={e => onChange(m.key, e.target.value)} placeholder="0" style={inputStyle} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Report Card ───────────────────────────────────────────────────────────
function ReportCard({ report, metricGroups, onPreview, onEdit }) {
  const allDefs = metricGroups.flatMap(g => g.metrics);
  const filled = Object.entries(report.metrics || {}).filter(([, v]) => v && parseInt(v) > 0);
  const date = new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{report.team_members?.name}</div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{date}</div>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          {report.sent_to_slack && <span style={{ fontSize: 10, background: '#00E5A022', color: C.accent, padding: '2px 8px', borderRadius: 20 }}>✓ Slack</span>}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
        {filled.slice(0, 6).map(([key, val]) => {
          const label = allDefs.find(m => m.key === key)?.label || key;
          return <span key={key} style={{ fontSize: 10, background: C.elevated, color: C.sub, padding: '2px 8px', borderRadius: 6 }}>{label}: <strong style={{ color: C.text }}>{val}</strong></span>;
        })}
        {filled.length > 6 && <span style={{ fontSize: 10, color: C.muted }}>+{filled.length - 6} more</span>}
      </div>
      {report.tasks_completed && <div style={{ fontSize: 11, color: C.sub, marginBottom: 12, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>{report.tasks_completed.slice(0, 80)}{report.tasks_completed.length > 80 ? '…' : ''}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onPreview(report)} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.elevated, color: C.text, cursor: 'pointer' }}>👁 Preview</button>
        <button onClick={() => onEdit(report)} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `1px solid ${C.blue}44`, background: '#5B8DEF15', color: C.blue, cursor: 'pointer' }}>✏️ Edit</button>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [tab, setTab] = useState('form');
  const [teamMembers, setTeamMembers] = useState([]);
  const [metricGroups, setMetricGroups] = useState(DEFAULT_METRIC_GROUPS);
  const [selectedMember, setSelectedMember] = useState('');
  const [reportDate, setReportDate] = useState(todayStr());
  const [metrics, setMetrics] = useState({});
  const [tasks, setTasks] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [currentReport, setCurrentReport] = useState(null); // existing saved report for this slot
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(null); // { savedAt, data }
  const [showPreview, setShowPreview] = useState(false);
  const [previewReport, setPreviewReport] = useState(null);
  const [previewMember, setPreviewMember] = useState(null);
  const [reports, setReports] = useState([]);
  const [historyFilter, setHistoryFilter] = useState({ person: '', date: '' });
  const [loadingReports, setLoadingReports] = useState(false);
  const [teamDate, setTeamDate] = useState(todayStr());
  const [teamReports, setTeamReports] = useState([]);
  const autoSaveRef = useRef(null);

  // Load team members + metrics
  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers((data || []).filter(m => m.active !== false)));
    fetch('/api/metrics').then(r => r.json()).then(({ data }) => {
      if (!data) return;
      const active = data.filter(m => m.active !== false);
      const grouped = {};
      for (const m of active) { if (!grouped[m.category]) grouped[m.category] = []; grouped[m.category].push({ key: m.key, label: m.label }); }
      const meta = { mapping_data: { label: '📦 Mapping & Data', color: C.blue }, claims_piles: { label: '📊 Claims Piles Checked', color: C.purple }, quality_review: { label: '✅ Quality & Review', color: C.accent } };
      const built = Object.entries(grouped).map(([cat, ms]) => ({ category: cat, metrics: ms, label: meta[cat]?.label || cat, color: meta[cat]?.color || C.accent }));
      if (built.length > 0) setMetricGroups(built);
    });
  }, []);

  // When member or date changes: check for existing report + draft
  useEffect(() => {
    if (!selectedMember || !reportDate) return;

    // Check for saved draft first
    const d = loadDraft(selectedMember, reportDate);
    if (d) setDraft({ savedAt: d._savedAt, data: d });
    else setDraft(null);

    // Check for existing saved report
    fetch(`/api/reports?person_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const r = data[0];
          setCurrentReport(r);
          setIsEditing(true);
          // Only populate form if no draft
          if (!loadDraft(selectedMember, reportDate)) {
            setMetrics(r.metrics || {}); setTasks(r.tasks_completed || ''); setNotes(r.notes || '');
          }
        } else {
          setCurrentReport(null); setIsEditing(false);
          if (!loadDraft(selectedMember, reportDate)) {
            setMetrics({}); setTasks(''); setNotes('');
          }
        }
      });
  }, [selectedMember, reportDate]);

  // Auto-save draft every 10 seconds if form has data
  useEffect(() => {
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    if (!selectedMember) return;
    autoSaveRef.current = setInterval(() => {
      const hasData = Object.values(metrics).some(v => v && parseInt(v) > 0) || tasks.trim() || notes.trim();
      if (hasData) saveDraft(selectedMember, reportDate, { metrics, tasks, notes });
    }, 10000);
    return () => clearInterval(autoSaveRef.current);
  }, [selectedMember, reportDate, metrics, tasks, notes]);

  const restoreDraft = () => {
    if (!draft) return;
    setMetrics(draft.data.metrics || {}); setTasks(draft.data.tasks || ''); setNotes(draft.data.notes || '');
    setDraft(null);
  };
  const discardDraft = () => { clearDraft(selectedMember, reportDate); setDraft(null); };

  const handleSave = async (andPreview = false) => {
    if (!selectedMember) { setSaveMsg({ type: 'error', text: 'Select a team member first.' }); return; }
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: selectedMember, report_date: reportDate, metrics, tasks_completed: tasks, notes }),
      });
      const { data, error } = await res.json();
      if (error) throw new Error(error);
      setCurrentReport(data); setIsEditing(true);
      clearDraft(selectedMember, reportDate); setDraft(null);
      setSaveMsg({ type: 'success', text: isEditing ? 'Report updated!' : 'Report saved!' });
      if (andPreview) {
        const member = teamMembers.find(m => m.id === selectedMember);
        setPreviewReport({ ...data, metrics, tasks_completed: tasks, notes, report_date: reportDate });
        setPreviewMember(member); setShowPreview(true);
      }
    } catch (err) { setSaveMsg({ type: 'error', text: err.message }); }
    finally { setSaving(false); }
  };

  const handleSendSlack = async (report, memberOverride) => {
    const member = memberOverride || teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
    try {
      const r = await fetch('/api/reports/send-slack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report, teamMember: member }) });
      const result = await r.json();
      if (result.error) throw new Error(result.error);
      if (report.id) await fetch('/api/reports', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: report.id, sent_to_slack: true }) });
      return true;
    } catch (err) { alert(`Slack error: ${err.message}`); return false; }
  };

  const handleEditFromHistory = (report) => {
    setSelectedMember(report.team_member_id); setReportDate(report.report_date);
    setMetrics(report.metrics || {}); setTasks(report.tasks_completed || ''); setNotes(report.notes || '');
    setCurrentReport(report); setIsEditing(true); setTab('form');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePreview = (report) => {
    const member = teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
    setPreviewReport(report); setPreviewMember(member); setShowPreview(true);
  };

  const loadHistory = useCallback(() => {
    setLoadingReports(true);
    const params = new URLSearchParams({ limit: '40' });
    if (historyFilter.person) params.set('person_id', historyFilter.person);
    if (historyFilter.date) params.set('date', historyFilter.date);
    fetch(`/api/reports?${params}`).then(r => r.json()).then(({ data }) => { setReports(data || []); setLoadingReports(false); });
  }, [historyFilter]);

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  useEffect(() => {
    if (tab !== 'team') return;
    fetch(`/api/reports?date=${teamDate}&limit=30`).then(r => r.json()).then(({ data }) => setTeamReports(data || []));
  }, [tab, teamDate]);

  const total = Object.values(metrics).map(v => parseInt(v)).filter(n => !isNaN(n)).reduce((a, b) => a + b, 0);
  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{ padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', background: 'transparent', borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent', color: tab === key ? C.accent : C.sub }}>
      {label}
    </button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      {showPreview && previewReport && (
        <PreviewModal report={previewReport} member={previewMember} metricGroups={metricGroups} onClose={() => setShowPreview(false)} onSendSlack={handleSendSlack} />
      )}

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Daily Reports</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.sub }}>Health Ops team reporting</p>
      </div>

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('form', '📝 Submit Report')}
        {tabBtn('history', '🕐 History')}
        {tabBtn('team', '👥 Team View')}
      </div>

      <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 32px' }}>

        {/* ── FORM TAB ── */}
        {tab === 'form' && (
          <div style={{ maxWidth: 740 }}>
            {draft && !isEditing && <DraftBanner savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} />}
            {isEditing && !draft && <EditBanner reportDate={reportDate} />}
            {draft && isEditing && <DraftBanner savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} />}

            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 14 }}>Report Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={labelStyle}>Team Member</label>
                  <select value={selectedMember} onChange={e => setSelectedMember(e.target.value)} style={inputStyle}>
                    <option value="">Select member…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.display_name || m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Report Date</label>
                  <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} style={inputStyle} />
                </div>
              </div>
            </div>

            {metricGroups.map(g => <MetricGroup key={g.category} group={g} metrics={metrics} onChange={(k, v) => setMetrics(p => ({ ...p, [k]: v }))} />)}

            <div style={cardStyle}>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Tasks Completed</label>
                <textarea value={tasks} onChange={e => setTasks(e.target.value)} rows={3} placeholder="List tasks you completed today…" style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              <div>
                <label style={labelStyle}>Notes / Blockers</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Any blockers, observations, or notes…" style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, color: C.sub }}>Total output: <span style={{ color: C.accent, fontWeight: 700, fontSize: 24 }}>{total}</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {saveMsg && <span style={{ fontSize: 12, color: saveMsg.type === 'success' ? C.success : C.danger }}>{saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}</span>}
                <button onClick={() => handleSave(false)} disabled={saving || !selectedMember} style={btn(C.elevated, C.text, saving || !selectedMember)}>
                  {saving ? 'Saving…' : isEditing ? '💾 Update' : '💾 Save'}
                </button>
                <button onClick={() => handleSave(true)} disabled={saving || !selectedMember} style={btn(C.accent, '#0B0F1A', saving || !selectedMember)}>
                  👁 Save & Preview
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === 'history' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={labelStyle}>Person</label>
                <select value={historyFilter.person} onChange={e => setHistoryFilter(f => ({ ...f, person: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
                  <option value="">All</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.display_name || m.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Date</label>
                <input type="date" value={historyFilter.date} onChange={e => setHistoryFilter(f => ({ ...f, date: e.target.value }))} style={{ ...inputStyle, width: 'auto' }} />
              </div>
              <button onClick={loadHistory} style={btn(C.accent, '#0B0F1A', false)}>Apply</button>
              <button onClick={() => setHistoryFilter({ person: '', date: '' })} style={{ ...btn(C.elevated, C.sub, false), border: `1px solid ${C.border}` }}>Clear</button>
              <button onClick={() => exportToCSV(reports, `reports-${todayStr()}.csv`)} disabled={!reports.length} style={{ ...btn('#1A2332', C.accent, !reports.length), border: '1px solid #00E5A030', marginLeft: 'auto' }}>⬇ Export CSV</button>
            </div>
            {loadingReports ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>
            ) : reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports found.</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>{reports.length} reports</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                  {reports.map(r => <ReportCard key={r.id} report={r} metricGroups={metricGroups} onPreview={handlePreview} onEdit={handleEditFromHistory} />)}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── TEAM VIEW TAB ── */}
        {tab === 'team' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={labelStyle}>Date</label>
                <input type="date" value={teamDate} onChange={e => setTeamDate(e.target.value)} style={{ ...inputStyle, width: 'auto' }} />
              </div>
              <button onClick={() => exportToCSV(teamReports, `team-${teamDate}.csv`)} disabled={!teamReports.length} style={{ ...btn('#1A2332', C.accent, !teamReports.length), border: '1px solid #00E5A030', marginLeft: 'auto' }}>⬇ Export CSV</button>
            </div>
            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
                {new Date(teamDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {teamMembers.map(m => {
                  const sub = teamReports.some(r => r.team_member_id === m.id);
                  return (
                    <span key={m.id} style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500, background: sub ? '#00E5A015' : C.elevated, color: sub ? C.accent : C.muted, border: `1px solid ${sub ? C.accent + '44' : C.border}` }}>
                      {sub ? '✓' : '○'} {m.display_name || m.name}
                    </span>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, color: C.sub }}>{teamReports.length} of {teamMembers.length} submitted</div>
            </div>
            {teamReports.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                {teamReports.map(r => <ReportCard key={r.id} report={r} metricGroups={metricGroups} onPreview={handlePreview} onEdit={handleEditFromHistory} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
