'use client';
import { useState, useEffect, useCallback } from 'react';

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", success: "#34D399", blue: "#5B8DEF", purple: "#A78BFA",
};

const DEFAULT_METRIC_GROUPS = [
  {
    category: 'mapping_data', label: '📦 Mapping & Data', color: C.blue,
    metrics: [
      { key: 'providers_mapped', label: 'Providers Mapped' },
      { key: 'care_items_mapped', label: 'Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Care Items Grouped' },
      { key: 'resolved_cares', label: 'Resolved Cares' },
    ],
  },
  {
    category: 'claims_piles', label: '📊 Claims Piles Checked', color: C.purple,
    metrics: [
      { key: 'claims_kenya', label: 'Kenya' },
      { key: 'claims_tanzania', label: 'Tanzania' },
      { key: 'claims_uganda', label: 'Uganda' },
      { key: 'claims_uap', label: 'UAP Old Mutual' },
      { key: 'claims_defmis', label: 'Defmis' },
      { key: 'claims_hadiel', label: 'Hadiel Tech' },
      { key: 'claims_axa', label: 'AXA' },
    ],
  },
  {
    category: 'quality_review', label: '✅ Quality & Review', color: C.accent,
    metrics: [
      { key: 'auto_pa_reviewed', label: 'Auto PA Reviewed' },
      { key: 'auto_pa_approved', label: 'Auto PA Approved' },
      { key: 'flagged_care_items', label: 'Flagged Care Items' },
      { key: 'icd10_adjusted', label: 'ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up', label: 'Benefits Set Up' },
      { key: 'providers_assigned', label: 'Providers Assigned' },
    ],
  },
];

const inputStyle = {
  background: '#0B0F1A', border: '1px solid #1E2D3D', borderRadius: 8,
  color: '#F0F4F8', padding: '8px 12px', fontSize: 13, width: '100%',
  outline: 'none', boxSizing: 'border-box',
};
const cardStyle = { background: '#111827', border: '1px solid #1E2D3D', borderRadius: 12, padding: 20, marginBottom: 16 };
const labelStyle = { fontSize: 11, color: '#8899AA', marginBottom: 4, display: 'block' };
const btnStyle = (bg, color, disabled) => ({
  padding: '9px 20px', background: disabled ? '#1A2332' : bg, color: disabled ? '#556677' : color,
  border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13,
  cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all .15s',
});

const today = () => new Date().toISOString().split('T')[0];

// ── CSV Export Helper ────────────────────────────────────────────────────────
function exportToCSV(reports, filename) {
  if (!reports.length) return;
  const allMetricKeys = [...new Set(reports.flatMap(r => Object.keys(r.metrics || {})))];
  const headers = ['Date', 'Team Member', 'Role', 'Status', 'Sent to Slack', ...allMetricKeys.map(k => k.replace(/_/g, ' ')), 'Tasks Completed', 'Notes'];
  const rows = reports.map(r => [
    r.report_date,
    r.team_members?.name || '',
    r.team_members?.role || '',
    r.status || '',
    r.sent_to_slack ? 'Yes' : 'No',
    ...allMetricKeys.map(k => r.metrics?.[k] || ''),
    `"${(r.tasks_completed || '').replace(/"/g, '""')}"`,
    `"${(r.notes || '').replace(/"/g, '""')}"`,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Preview Modal ────────────────────────────────────────────────────────────
function PreviewModal({ report, member, metricGroups, onClose, onSendSlack }) {
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const date = new Date((report.report_date || today()) + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const formatText = () => {
    let lines = [`📋 Daily Report — ${member?.name || 'Team Member'}`, `${date} | ${member?.role || ''}`, ''];
    for (const group of metricGroups) {
      const groupMetrics = group.metrics.filter(m => {
        const v = report.metrics?.[m.key];
        return v !== undefined && v !== '' && v !== '0' && parseInt(v) > 0;
      });
      if (groupMetrics.length > 0) {
        lines.push(group.label.replace(/[📦📊✅]/g, '').trim());
        groupMetrics.forEach(m => lines.push(`  • ${m.label}: ${report.metrics[m.key]}`));
        lines.push('');
      }
    }
    if (report.tasks_completed) { lines.push('🗒 Tasks Completed'); lines.push(report.tasks_completed); lines.push(''); }
    if (report.notes) { lines.push('💬 Notes'); lines.push(report.notes); }
    return lines.join('\n');
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(formatText());
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const handleSend = async () => {
    setSending(true);
    await onSendSlack(report, member);
    setSending(false);
  };

  const totalOutput = Object.values(report.metrics || {}).map(v => parseInt(v)).filter(n => !isNaN(n)).reduce((a, b) => a + b, 0);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#00000088', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: C.card, borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', border: `1px solid ${C.border}` }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: C.text }}>Report Preview</div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{member?.name} · {date}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.sub, fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {/* Stats */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            <div style={{ flex: 1, background: C.elevated, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.accent }}>{totalOutput}</div>
              <div style={{ fontSize: 11, color: C.sub }}>Total Output</div>
            </div>
            <div style={{ flex: 1, background: C.elevated, borderRadius: 10, padding: '12px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.blue }}>{Object.values(report.metrics || {}).filter(v => v && parseInt(v) > 0).length}</div>
              <div style={{ fontSize: 11, color: C.sub }}>Metrics Filled</div>
            </div>
          </div>

          {/* Metric Groups */}
          {metricGroups.map(group => {
            const filled = group.metrics.filter(m => {
              const v = report.metrics?.[m.key];
              return v !== undefined && v !== '' && parseInt(v) > 0;
            });
            if (!filled.length) return null;
            return (
              <div key={group.category} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: group.color, marginBottom: 8 }}>{group.label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {filled.map(m => (
                    <div key={m.key} style={{ background: C.elevated, borderRadius: 8, padding: '8px 12px', display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: C.sub }}>{m.label}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{report.metrics[m.key]}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {report.tasks_completed && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6 }}>🗒 Tasks Completed</div>
              <div style={{ background: C.elevated, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.text, whiteSpace: 'pre-wrap' }}>{report.tasks_completed}</div>
            </div>
          )}
          {report.notes && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 6 }}>💬 Notes</div>
              <div style={{ background: C.elevated, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.text, whiteSpace: 'pre-wrap' }}>{report.notes}</div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10 }}>
          <button onClick={handleCopy} style={{ ...btnStyle(C.elevated, C.text, false), flex: 1, border: `1px solid ${C.border}` }}>
            {copied ? '✓ Copied!' : '📋 Copy Text'}
          </button>
          <button onClick={handleSend} disabled={sending || report.sent_to_slack} style={{ ...btnStyle('#4A154B', '#fff', report.sent_to_slack), flex: 1 }}>
            {sending ? 'Sending…' : report.sent_to_slack ? '✓ Sent to Slack' : '📤 Send to Slack'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Metric Group Input ───────────────────────────────────────────────────────
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

// ── Report Card ──────────────────────────────────────────────────────────────
function ReportCard({ report, metricGroups, onPreview, onSendSlack }) {
  const allMetrics = Object.entries(report.metrics || {}).filter(([, v]) => v && parseInt(v) > 0);
  const allMetricDefs = metricGroups.flatMap(g => g.metrics);
  const date = new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div style={{ background: '#111827', border: '1px solid #1E2D3D', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, color: C.text, fontSize: 14 }}>{report.team_members?.name}</div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{date}</div>
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          {report.sent_to_slack && <span style={{ fontSize: 10, background: '#00E5A022', color: C.accent, padding: '2px 8px', borderRadius: 20 }}>✓ Slack</span>}
          <span style={{ fontSize: 10, background: '#1A2332', color: C.sub, padding: '2px 8px', borderRadius: 20 }}>{report.status}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
        {allMetrics.slice(0, 6).map(([key, val]) => {
          const label = allMetricDefs.find(m => m.key === key)?.label || key;
          return (
            <span key={key} style={{ fontSize: 10, background: '#1A2332', color: C.sub, padding: '2px 8px', borderRadius: 6 }}>
              {label}: <strong style={{ color: C.text }}>{val}</strong>
            </span>
          );
        })}
        {allMetrics.length > 6 && <span style={{ fontSize: 10, color: C.muted }}>+{allMetrics.length - 6} more</span>}
      </div>

      {report.tasks_completed && (
        <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, borderTop: '1px solid #1E2D3D', paddingTop: 8 }}>
          {report.tasks_completed.slice(0, 80)}{report.tasks_completed.length > 80 ? '…' : ''}
        </div>
      )}

      <button onClick={() => onPreview(report)} style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.elevated, color: C.text, cursor: 'pointer' }}>
        👁 Preview & Share
      </button>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [tab, setTab] = useState('form');
  const [teamMembers, setTeamMembers] = useState([]);
  const [metricGroups, setMetricGroups] = useState(DEFAULT_METRIC_GROUPS);
  const [selectedMember, setSelectedMember] = useState('');
  const [reportDate, setReportDate] = useState(today());
  const [metrics, setMetrics] = useState({});
  const [tasksCompleted, setTasksCompleted] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [currentReport, setCurrentReport] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [reports, setReports] = useState([]);
  const [historyFilter, setHistoryFilter] = useState({ person: '', date: '' });
  const [loadingReports, setLoadingReports] = useState(false);
  const [teamDate, setTeamDate] = useState(today());
  const [teamReports, setTeamReports] = useState([]);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [previewReport, setPreviewReport] = useState(null);
  const [previewMember, setPreviewMember] = useState(null);

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers((data || []).filter(m => m.active !== false)));
    fetch('/api/metrics').then(r => r.json()).then(({ data }) => {
      if (!data) return;
      const active = data.filter(m => m.active !== false);
      const grouped = {};
      for (const m of active) {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push({ key: m.key, label: m.label });
      }
      const categoryMeta = {
        mapping_data: { label: '📦 Mapping & Data', color: C.blue },
        claims_piles: { label: '📊 Claims Piles Checked', color: C.purple },
        quality_review: { label: '✅ Quality & Review', color: C.accent },
      };
      const built = Object.entries(grouped).map(([cat, metrics]) => ({
        category: cat, metrics,
        label: categoryMeta[cat]?.label || cat,
        color: categoryMeta[cat]?.color || C.accent,
      }));
      if (built.length > 0) setMetricGroups(built);
    });
  }, []);

  useEffect(() => {
    if (!selectedMember || !reportDate) return;
    fetch(`/api/reports?person_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const r = data[0];
          setMetrics(r.metrics || {}); setTasksCompleted(r.tasks_completed || ''); setNotes(r.notes || '');
          setCurrentReport(r);
        } else {
          setMetrics({}); setTasksCompleted(''); setNotes(''); setCurrentReport(null);
        }
      });
  }, [selectedMember, reportDate]);

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
    setLoadingTeam(true);
    fetch(`/api/reports?date=${teamDate}&limit=20`).then(r => r.json()).then(({ data }) => { setTeamReports(data || []); setLoadingTeam(false); });
  }, [tab, teamDate]);

  const handleSave = async (andPreview = false) => {
    if (!selectedMember) { setSaveMsg({ type: 'error', text: 'Please select a team member.' }); return; }
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: selectedMember, report_date: reportDate, metrics, tasks_completed: tasksCompleted, notes }),
      });
      const { data, error } = await res.json();
      if (error) throw new Error(error);
      setCurrentReport(data);
      setSaveMsg({ type: 'success', text: 'Report saved!' });
      if (andPreview) {
        const member = teamMembers.find(m => m.id === selectedMember);
        setPreviewReport({ ...data, metrics, tasks_completed: tasksCompleted, notes, report_date: reportDate });
        setPreviewMember(member);
        setShowPreview(true);
      }
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  };

  const handleSendSlack = async (report, memberOverride) => {
    const member = memberOverride || teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
    try {
      const slackRes = await fetch('/api/reports/send-slack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, teamMember: member, channel: 'health-ops' }),
      });
      const result = await slackRes.json();
      if (result.error) throw new Error(result.error);
      if (report.id) {
        await fetch('/api/reports', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: report.id, sent_to_slack: true, slack_channel: result.channel, sent_at: result.sent_at }),
        });
      }
      if (previewReport) setPreviewReport(p => ({ ...p, sent_to_slack: true }));
      loadHistory();
      return true;
    } catch (err) { alert(`Slack send failed: ${err.message}`); return false; }
  };

  const handlePreview = (report) => {
    const member = teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
    setPreviewReport(report); setPreviewMember(member); setShowPreview(true);
  };

  const totalOutput = Object.values(metrics).map(v => parseInt(v)).filter(n => !isNaN(n)).reduce((a, b) => a + b, 0);

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: '10px 20px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
      background: 'transparent', borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent',
      color: tab === key ? C.accent : C.sub,
    }}>{label}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      {showPreview && previewReport && (
        <PreviewModal
          report={previewReport} member={previewMember} metricGroups={metricGroups}
          onClose={() => setShowPreview(false)}
          onSendSlack={handleSendSlack}
        />
      )}

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Daily Reports</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.sub }}>Health Ops team reporting — replaces individual Google Sheets tabs</p>
      </div>

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('form', '📝 Submit Report')}
        {tabBtn('history', '🕐 History')}
        {tabBtn('team', '👥 Team View')}
      </div>

      <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 32px' }}>

        {/* ── FORM TAB ─────────────────────── */}
        {tab === 'form' && (
          <div style={{ maxWidth: 740 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>Report Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={labelStyle}>Team Member</label>
                  <select value={selectedMember} onChange={e => setSelectedMember(e.target.value)} style={inputStyle}>
                    <option value="">Select member…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Report Date</label>
                  <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} style={inputStyle} />
                </div>
              </div>
            </div>

            {metricGroups.map(group => (
              <MetricGroup key={group.category} group={group} metrics={metrics} onChange={(k, v) => setMetrics(p => ({ ...p, [k]: v }))} />
            ))}

            <div style={cardStyle}>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Tasks Completed</label>
                <textarea value={tasksCompleted} onChange={e => setTasksCompleted(e.target.value)} rows={3}
                  placeholder="List the tasks you completed today…" style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              <div>
                <label style={labelStyle}>Notes / Blockers</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  placeholder="Any blockers, observations, or notes for the team…" style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, color: C.sub }}>
                Total output: <span style={{ color: C.accent, fontWeight: 700, fontSize: 22 }}>{totalOutput}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {saveMsg && (
                  <span style={{ fontSize: 12, color: saveMsg.type === 'success' ? C.success : C.danger }}>
                    {saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}
                  </span>
                )}
                <button onClick={() => handleSave(false)} disabled={saving || !selectedMember}
                  style={btnStyle(C.elevated, C.text, saving || !selectedMember)}>
                  💾 Save
                </button>
                <button onClick={() => handleSave(true)} disabled={saving || !selectedMember}
                  style={btnStyle(C.accent, '#0B0F1A', saving || !selectedMember)}>
                  👁 Save & Preview
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── HISTORY TAB ──────────────────── */}
        {tab === 'history' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={labelStyle}>Filter by person</label>
                <select value={historyFilter.person} onChange={e => setHistoryFilter(f => ({ ...f, person: e.target.value }))}
                  style={{ ...inputStyle, width: 'auto' }}>
                  <option value="">All members</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Filter by date</label>
                <input type="date" value={historyFilter.date} onChange={e => setHistoryFilter(f => ({ ...f, date: e.target.value }))}
                  style={{ ...inputStyle, width: 'auto' }} />
              </div>
              <button onClick={loadHistory} style={btnStyle(C.accent, '#0B0F1A', false)}>Apply</button>
              <button onClick={() => setHistoryFilter({ person: '', date: '' })}
                style={{ ...btnStyle(C.elevated, C.sub, false), border: `1px solid ${C.border}` }}>Clear</button>
              <button onClick={() => exportToCSV(reports, `health-ops-reports-${today()}.csv`)}
                disabled={!reports.length}
                style={{ ...btnStyle('#1A2332', C.accent, !reports.length), border: `1px solid #00E5A030`, marginLeft: 'auto' }}>
                ⬇ Export CSV
              </button>
            </div>

            {loadingReports ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading reports…</div>
            ) : reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports found.</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>{reports.length} reports found</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                  {reports.map(r => <ReportCard key={r.id} report={r} metricGroups={metricGroups} onPreview={handlePreview} onSendSlack={handleSendSlack} />)}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── TEAM VIEW TAB ─────────────────── */}
        {tab === 'team' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div>
                <label style={labelStyle}>View date</label>
                <input type="date" value={teamDate} onChange={e => setTeamDate(e.target.value)} style={{ ...inputStyle, width: 'auto' }} />
              </div>
              <button onClick={() => exportToCSV(teamReports, `team-reports-${teamDate}.csv`)}
                disabled={!teamReports.length}
                style={{ ...btnStyle('#1A2332', C.accent, !teamReports.length), border: `1px solid #00E5A030` }}>
                ⬇ Export CSV
              </button>
            </div>

            {loadingTeam ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>
            ) : (
              <>
                <div style={cardStyle}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>
                    Submitted for {new Date(teamDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {teamMembers.map(m => {
                      const sub = teamReports.some(r => r.team_member_id === m.id);
                      return (
                        <span key={m.id} style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500, background: sub ? '#00E5A015' : C.elevated, color: sub ? C.accent : C.muted, border: `1px solid ${sub ? C.accent + '44' : C.border}` }}>
                          {sub ? '✓' : '○'} {m.name}
                        </span>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 10 }}>{teamReports.length} of {teamMembers.length} submitted</div>
                </div>

                {teamReports.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
                    {teamReports.map(r => <ReportCard key={r.id} report={r} metricGroups={metricGroups} onPreview={handlePreview} onSendSlack={handleSendSlack} />)}
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports for this date yet.</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
