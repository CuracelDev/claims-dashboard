'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  blue: "#5B8DEF", purple: "#A78BFA", orange: "#FB923C",
};

const METRIC_GROUPS = [
  {
    category: 'mapping_data', label: '📦 Mapping & Data', color: C.blue,
    metrics: [
      { key: 'providers_mapped',   label: 'Providers Mapped' },
      { key: 'care_items_mapped',  label: 'Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Care Items Grouped' },
      { key: 'resolved_cares',     label: 'Resolved Cares' },
    ],
  },
  {
    category: 'claims_piles', label: '📊 Claims Piles Checked', color: C.purple,
    metrics: [
      { key: 'claims_kenya',    label: 'Kenya' },
      { key: 'claims_tanzania', label: 'Tanzania' },
      { key: 'claims_uganda',   label: 'Uganda' },
      { key: 'claims_uap',      label: 'UAP Old Mutual' },
      { key: 'claims_defmis',   label: 'Defmis' },
      { key: 'claims_hadiel',   label: 'Hadiel Tech' },
      { key: 'claims_axa',      label: 'AXA' },
    ],
  },
  {
    category: 'quality_review', label: '✅ Quality & Review', color: C.accent,
    metrics: [
      { key: 'auto_pa_reviewed',   label: 'Auto PA Reviewed' },
      { key: 'auto_pa_approved',   label: 'Auto PA Approved' },
      { key: 'flagged_care_items', label: 'Flagged Care Items' },
      { key: 'icd10_adjusted',     label: 'ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up',    label: 'Benefits Set Up' },
      { key: 'providers_assigned', label: 'Providers Assigned' },
    ],
  },
];

const ALL_METRICS = METRIC_GROUPS.flatMap(g => g.metrics);
const todayStr = () => new Date().toISOString().split('T')[0];

const LEAVE_TYPES = [
  { value: 'off_today',       label: '🌙 Off Today',           single: true  },
  { value: 'leave_range',     label: '📅 On Leave (date range)', single: false },
  { value: 'weekend_off',     label: '🏖 Weekend Off',          single: false },
  { value: 'public_holiday',  label: '🎉 Public Holiday',       single: true  },
];

const inputStyle = {
  background: '#0B0F1A', border: `1px solid #1E2D3D`, borderRadius: 8,
  color: '#F0F4F8', padding: '8px 12px', fontSize: 14, width: '100%',
  outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { fontSize: 12, color: '#8899AA', marginBottom: 4, display: 'block' };
const cardStyle = {
  background: '#111827', border: `1px solid #1E2D3D`,
  borderRadius: 12, padding: 20, marginBottom: 16,
};

// ─── MetricGroup ─────────────────────────────────────────────────────────────
// Fix: each input gets a unique name to prevent browser autofill cross-pollution
function MetricGroup({ group, metrics, onChange }) {
  return (
    <div style={{ ...cardStyle, borderTop: `3px solid ${group.color}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: group.color, marginBottom: 16 }}>{group.label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {group.metrics.map(m => (
          <div key={m.key}>
            <label style={labelStyle}>{m.label}</label>
            <input
              type="number" autoComplete="new-password"
              min="0"
              name={`metric_${m.key}`}
              autoComplete="off"
              value={metrics[m.key] ?? ''}
              name={`metric_${m.key}`}
              autoComplete="off"
              onChange={e => onChange(m.key, e.target.value)}
              placeholder="0"
              style={inputStyle}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LeavePanel ───────────────────────────────────────────────────────────────
function LeavePanel({ selectedMember, reportDate, teamMembers, onLeaveSet, onLeaveCleared }) {
  const [open, setOpen] = useState(false);
  const [leaveType, setLeaveType] = useState('off_today');
  const [startDate, setStartDate] = useState(reportDate || todayStr());
  const [endDate, setEndDate] = useState(reportDate || todayStr());
  const [reason, setReason] = useState('');
  const [markedBy, setMarkedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeLeave, setActiveLeave] = useState(null);
  const [loadingLeave, setLoadingLeave] = useState(false);

  const isSingleDay = LEAVE_TYPES.find(t => t.value === leaveType)?.single;

  // Check if selected member is on leave for the report date
  useEffect(() => {
    if (!selectedMember || !reportDate) { setActiveLeave(null); return; }
    setLoadingLeave(true);
    fetch(`/api/leave?member_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data, on_leave }) => {
        setActiveLeave(on_leave && data?.length > 0 ? data[0] : null);
        setLoadingLeave(false);
        if (on_leave) onLeaveSet?.(data[0]);
        else onLeaveCleared?.();
      })
      .catch(() => setLoadingLeave(false));
  }, [selectedMember, reportDate]);

  // Sync start date when type changes to single-day
  useEffect(() => {
    if (isSingleDay) setEndDate(startDate);
  }, [leaveType, startDate, isSingleDay]);

  const handleMarkLeave = async () => {
    if (!selectedMember) return;
    setSaving(true);
    const finalEnd = isSingleDay ? startDate : endDate;
    const by = markedBy || teamMembers.find(m => m.id === selectedMember)?.name || 'Team';
    const res = await fetch('/api/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_member_id: selectedMember,
        leave_type: leaveType,
        start_date: startDate,
        end_date: finalEnd,
        reason,
        marked_by: by,
      }),
    });
    const { data, error } = await res.json();
    setSaving(false);
    if (error) { alert(`Error: ${error}`); return; }
    setActiveLeave(data);
    setOpen(false);
    onLeaveSet?.(data);
  };

  const handleCancel = async () => {
    if (!activeLeave) return;
    await fetch(`/api/leave?id=${activeLeave.id}`, { method: 'DELETE' });
    setActiveLeave(null);
    onLeaveCleared?.();
  };

  const memberName = teamMembers.find(m => m.id === selectedMember)?.name;

  if (!selectedMember) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Active leave banner */}
      {activeLeave && (
        <div style={{
          background: '#FFB84D15', border: `1px solid ${C.warn}44`,
          borderRadius: 10, padding: '12px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <span style={{ fontSize: 14, color: C.warn, fontWeight: 600 }}>
              🌙 {memberName} is marked off
            </span>
            <span style={{ fontSize: 12, color: C.sub, marginLeft: 10 }}>
              {activeLeave.leave_type.replace(/_/g, ' ')}
              {activeLeave.start_date !== activeLeave.end_date
                ? ` · ${activeLeave.start_date} → ${activeLeave.end_date}`
                : ` · ${activeLeave.start_date}`}
              {activeLeave.reason && ` · "${activeLeave.reason}"`}
            </span>
          </div>
          <button
            onClick={handleCancel}
            style={{ fontSize: 12, color: C.danger, background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
          >
            ✕ Cancel leave
          </button>
        </div>
      )}

      {/* Mark as off button / form */}
      {!activeLeave && (
        <div>
          {!open ? (
            <button
              onClick={() => setOpen(true)}
              style={{
                fontSize: 13, padding: '7px 16px', borderRadius: 8,
                border: `1px dashed ${C.border}`, background: 'transparent',
                color: C.sub, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              🌙 Mark {memberName} as off / on leave
            </button>
          ) : (
            <div style={{ ...cardStyle, border: `1px solid ${C.warn}44`, background: '#FFB84D08' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.warn, marginBottom: 14 }}>
                🌙 Mark as Off / On Leave
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                {/* Leave type */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Leave Type</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {LEAVE_TYPES.map(t => (
                      <button
                        key={t.value}
                        onClick={() => setLeaveType(t.value)}
                        style={{
                          fontSize: 12, padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                          background: leaveType === t.value ? C.warn : C.elevated,
                          color: leaveType === t.value ? '#0B0F1A' : C.sub,
                          fontWeight: leaveType === t.value ? 600 : 400,
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Date(s) */}
                <div>
                  <label style={labelStyle}>{isSingleDay ? 'Date' : 'Start Date'}</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => { setStartDate(e.target.value); if (isSingleDay) setEndDate(e.target.value); }}
                    style={inputStyle}
                  />
                </div>
                {!isSingleDay && (
                  <div>
                    <label style={labelStyle}>End Date</label>
                    <input
                      type="date"
                      value={endDate}
                      min={startDate}
                      onChange={e => setEndDate(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                )}

                {/* Reason (optional) */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle}>Reason (optional)</label>
                  <input
                    type="text"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    placeholder="e.g. Medical leave, family travel…"
                    style={inputStyle}
                    autoComplete="off"
                  />
                </div>

                {/* Who is marking */}
                <div>
                  <label style={labelStyle}>Marked by</label>
                  <select
                    value={markedBy}
                    onChange={e => setMarkedBy(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Select your name…</option>
                    {teamMembers.map(m => (
                      <option key={m.id} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setOpen(false)}
                  style={{ fontSize: 13, padding: '8px 18px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleMarkLeave}
                  disabled={saving}
                  style={{ fontSize: 13, padding: '8px 20px', borderRadius: 8, border: 'none', background: C.warn, color: '#0B0F1A', fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? 'Saving…' : '🌙 Confirm Leave'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ReportCard ───────────────────────────────────────────────────────────────
function ReportCard({ report, onSendSlack, onEdit }) {
  const [sending, setSending] = useState(false);
  const date = new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  const isOff = report.status === 'off_duty';
  const allMetrics = Object.entries(report.metrics || {}).filter(([, v]) => v !== '' && v !== null && v !== '0' && v !== 0);

  const handleSend = async () => {
    setSending(true);
    await onSendSlack(report);
    setSending(false);
  };

  return (
    <div style={{ background: '#111827', border: `1px solid ${isOff ? C.warn + '44' : '#1E2D3D'}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600, color: C.text, fontSize: 14 }}>{report.team_members?.name}</div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{date}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {isOff && <span style={{ fontSize: 11, background: '#FFB84D22', color: C.warn, padding: '2px 8px', borderRadius: 20 }}>🌙 Off Duty</span>}
          {report.sent_to_slack && !isOff && <span style={{ fontSize: 11, background: '#00E5A022', color: C.accent, padding: '2px 8px', borderRadius: 20 }}>✓ Sent</span>}
          <span style={{ fontSize: 11, background: '#1A2332', color: '#8899AA', padding: '2px 8px', borderRadius: 20 }}>{report.status}</span>
        </div>
      </div>

      {!isOff && allMetrics.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {allMetrics.slice(0, 8).map(([key, val]) => {
            const label = ALL_METRICS.find(m => m.key === key)?.label || key;
            return (
              <span key={key} style={{ fontSize: 11, background: '#1A2332', color: '#8899AA', padding: '3px 8px', borderRadius: 6 }}>
                {label}: <span style={{ color: '#F0F4F8', fontWeight: 600 }}>{val}</span>
              </span>
            );
          })}
          {allMetrics.length > 8 && <span style={{ fontSize: 11, color: '#556677' }}>+{allMetrics.length - 8} more</span>}
        </div>
      )}

      {report.tasks_completed && (
        <div style={{ fontSize: 12, color: '#8899AA', marginBottom: 8, borderTop: '1px solid #1E2D3D', paddingTop: 8 }}>
          <span style={{ color: '#556677' }}>Tasks: </span>{report.tasks_completed.slice(0, 100)}{report.tasks_completed.length > 100 ? '…' : ''}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {onEdit && (
          <button
            onClick={() => onEdit(report)}
            style={{ fontSize: 12, padding: '5px 12px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.sub, cursor: 'pointer' }}
          >
            ✏️ Edit
          </button>
        )}
        {!isOff && (
          <button
            onClick={handleSend}
            disabled={sending || report.sent_to_slack}
            style={{
              fontSize: 12, padding: '6px 14px', borderRadius: 8, border: 'none',
              cursor: report.sent_to_slack ? 'not-allowed' : 'pointer',
              background: report.sent_to_slack ? '#1A2332' : '#4A154B',
              color: report.sent_to_slack ? '#556677' : '#fff',
            }}
          >
            {sending ? 'Sending…' : report.sent_to_slack ? 'Sent to Slack' : '📤 Send to Slack'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [tab, setTab] = useState('form');
  const [teamMembers, setTeamMembers] = useState([]);
  const [selectedMember, setSelectedMember] = useState('');
  const [reportDate, setReportDate] = useState(todayStr());
  const [metrics, setMetrics] = useState({});
  const [tasksCompleted, setTasksCompleted] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [activeLeave, setActiveLeave] = useState(null);
  const [editingReport, setEditingReport] = useState(null);

  const [reports, setReports] = useState([]);
  const [historyFilter, setHistoryFilter] = useState({ person: '', date: '' });
  const [loadingReports, setLoadingReports] = useState(false);

  const [teamDate, setTeamDate] = useState(todayStr());
  const [teamReports, setTeamReports] = useState([]);
  const [teamLeave, setTeamLeave] = useState([]);
  const [loadingTeam, setLoadingTeam] = useState(false);

  // Draft persistence
  const DRAFT_KEY = selectedMember && reportDate ? `ho_draft_${selectedMember}_${reportDate}` : null;
  const draftRestored = useRef(false);

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers(data || []));
  }, []);

  // Load existing report when member+date changes
  useEffect(() => {
    if (!selectedMember || !reportDate) return;
    draftRestored.current = false;
    fetch(`/api/reports?person_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const r = data[0];
          const m = r.metrics || {};
          const vals = Object.values(m).filter(v => v !== '' && v !== null);
          const allSame = vals.length > 1 && vals.every(v => v === vals[0]);
          const cleaned = Object.fromEntries(Object.entries(m).filter(([,v]) => v !== 0 && v !== '0' && v !== '' && v !== null));
          setMetrics(cleaned);
          setTasksCompleted(r.tasks_completed || '');
          setNotes(r.notes || '');
          setEditingReport(r);
        } else {
          setEditingReport(null);
          // Try restoring draft
          if (DRAFT_KEY) {
            try {
              const raw = localStorage.getItem(DRAFT_KEY);
              if (raw) {
                const { data: draft, ts } = JSON.parse(raw);
                if (Date.now() - ts < 48 * 3600 * 1000) {
                  setMetrics(draft.metrics || {});
                  setTasksCompleted(draft.tasksCompleted || '');
                  setNotes(draft.notes || '');
                  draftRestored.current = true;
                  return;
                }
              }
            } catch {}
          }
          setMetrics({});
          setTasksCompleted('');
          setNotes('');
        }
      });
  }, [selectedMember, reportDate]);

  // Auto-save draft every 10s
  useEffect(() => {
    if (!DRAFT_KEY || editingReport) return;
    const t = setInterval(() => {
      const payload = { metrics, tasksCompleted, notes };
      if (Object.keys(metrics).length > 0 || tasksCompleted || notes) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: payload, ts: Date.now() }));
      }
    }, 10000);
    return () => clearInterval(t);
  }, [DRAFT_KEY, metrics, tasksCompleted, notes, editingReport]);

  const loadHistory = useCallback(() => {
    setLoadingReports(true);
    const params = new URLSearchParams({ limit: '30' });
    if (historyFilter.person) params.set('person_id', historyFilter.person);
    if (historyFilter.date) params.set('date', historyFilter.date);
    fetch(`/api/reports?${params}`).then(r => r.json()).then(({ data }) => {
      setReports(data || []);
      setLoadingReports(false);
    });
  }, [historyFilter]);

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  useEffect(() => {
    if (tab !== 'team') return;
    setLoadingTeam(true);
    Promise.all([
      fetch(`/api/reports?date=${teamDate}&limit=20`).then(r => r.json()),
      fetch(`/api/leave?date=${teamDate}&all=true`).then(r => r.json()),
    ]).then(([rData, lData]) => {
      setTeamReports(rData.data || []);
      setTeamLeave(lData.data || []);
      setLoadingTeam(false);
    });
  }, [tab, teamDate]);

  const handleMetricChange = (key, val) => setMetrics(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    if (!selectedMember) { setSaveMsg({ type: 'error', text: 'Please select a team member.' }); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: selectedMember,
          report_date: reportDate,
          metrics,
          tasks_completed: tasksCompleted,
          notes,
          status: 'submitted',
        }),
      });
      const { error } = await res.json();
      if (error) throw new Error(error);
      // Clear draft on successful save
      if (DRAFT_KEY) localStorage.removeItem(DRAFT_KEY);
      setSaveMsg({ type: 'success', text: 'Report saved!' });
      setEditingReport({ metrics, tasks_completed: tasksCompleted, notes });
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleSendSlack = async (report) => {
    const member = teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
    try {
      const slackRes = await fetch('/api/reports/send-slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, teamMember: member, channel: 'health-ops' }),
      });
      const result = await slackRes.json();
      if (result.error) throw new Error(result.error);
      await fetch('/api/reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: report.id, sent_to_slack: true, slack_channel: result.channel, sent_at: result.sent_at }),
      });
      loadHistory();
      alert('Report sent to Slack!');
    } catch (err) {
      alert(`Slack send failed: ${err.message}`);
    }
  };

  const handleEditReport = (report) => {
    setSelectedMember(report.team_member_id);
    setReportDate(report.report_date);
    setMetrics(report.metrics || {});
    setTasksCompleted(report.tasks_completed || '');
    setNotes(report.notes || '');
    setEditingReport(report);
    setTab('form');
  };

  const totalOutput = Object.values(metrics)
    .map(v => parseInt(v))
    .filter(n => !isNaN(n))
    .reduce((a, b) => a + b, 0);

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: '10px 20px', fontSize: 14, fontWeight: 500, border: 'none', cursor: 'pointer',
      background: 'transparent',
      borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent',
      color: tab === key ? C.accent : C.sub, transition: 'all .2s',
    }}>{label}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: C.text }}>Daily Reports</h1>
        <p style={{ margin: '4px 0 0', fontSize: 14, color: C.sub }}>Health Ops team reporting</p>
      </div>

      {/* Tabs */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('form', '📝 Submit Report')}
        {tabBtn('history', '🕐 History')}
        {tabBtn('team', '👥 Team View')}
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 32px' }}>

        {/* ── FORM TAB ─────────────────────────────────────────────────────── */}
        {tab === 'form' && (
          <div style={{ maxWidth: 720 }}>

            {/* Edit mode banner */}
            {editingReport && (
              <div style={{ background: '#5B8DEF15', border: `1px solid ${C.blue}44`, borderRadius: 10, padding: '10px 16px', marginBottom: 14, fontSize: 13, color: C.blue }}>
                ✏️ Editing existing report — changes will overwrite the saved version
              </div>
            )}

            {/* Draft restored banner */}
            {draftRestored.current && !editingReport && (
              <div style={{ background: '#FB923C15', border: `1px solid ${C.orange}44`, borderRadius: 10, padding: '10px 16px', marginBottom: 14, fontSize: 13, color: C.orange }}>
                📋 Draft restored from your last session
              </div>
            )}

            {/* Person + Date */}
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 16 }}>Report Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={labelStyle}>Team Member</label>
                  <select
                    value={selectedMember}
                    onChange={e => { setSelectedMember(e.target.value); setActiveLeave(null); }}
                    style={inputStyle}
                  >
                    <option value="">Select member…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Report Date</label>
                  <input
                    type="date"
                    value={reportDate}
                    onChange={e => setReportDate(e.target.value)}
                    style={inputStyle}
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>

            {/* Leave panel — shown as soon as member is selected */}
            <LeavePanel
              selectedMember={selectedMember}
              reportDate={reportDate}
              teamMembers={teamMembers}
              onLeaveSet={setActiveLeave}
              onLeaveCleared={() => setActiveLeave(null)}
            />

            {/* Metric groups — hidden if on leave */}
            {!activeLeave && (
              <>
                {METRIC_GROUPS.map(group => (
                  <MetricGroup key={group.category} group={group} metrics={metrics} onChange={handleMetricChange} />
                ))}

                <div style={cardStyle}>
                  <div style={{ marginBottom: 16 }}>
                    <label style={labelStyle}>Tasks Completed</label>
                    <textarea
                      value={tasksCompleted}
                      onChange={e => setTasksCompleted(e.target.value)}
                      rows={3}
                      placeholder="List the tasks you completed today…"
                      style={{ ...inputStyle, resize: 'vertical' }}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Notes / Blockers</label>
                    <textarea
                      value={notes}
                      onChange={e => setNotes(e.target.value)}
                      rows={2}
                      placeholder="Any blockers, observations, or notes…"
                      style={{ ...inputStyle, resize: 'vertical' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 14, color: C.sub }}>
                    Total output: <span style={{ color: C.accent, fontWeight: 700, fontSize: 20 }}>{totalOutput}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {saveMsg && (
                      <span style={{ fontSize: 13, color: saveMsg.type === 'success' ? C.success : C.danger }}>
                        {saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}
                      </span>
                    )}
                    <button
                      onClick={handleSave}
                      disabled={saving || !selectedMember}
                      style={{
                        padding: '10px 24px', background: C.accent, color: '#0B0F1A',
                        border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
                        cursor: saving || !selectedMember ? 'not-allowed' : 'pointer',
                        opacity: saving || !selectedMember ? 0.5 : 1,
                      }}
                    >
                      {saving ? 'Saving…' : '💾 Save Report'}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* If on leave — off duty notice instead of form */}
            {activeLeave && (
              <div style={{
                background: '#FFB84D08', border: `1px dashed ${C.warn}44`,
                borderRadius: 12, padding: 32, textAlign: 'center',
              }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🌙</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: C.warn, marginBottom: 6 }}>
                  {teamMembers.find(m => m.id === selectedMember)?.name} is off today
                </div>
                <div style={{ fontSize: 13, color: C.sub }}>
                  No report needed. No Slack reminder will be sent.
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Cancel leave above if this was entered in error.
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY TAB ─────────────────────────────────────────────────── */}
        {tab === 'history' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={labelStyle}>Filter by person</label>
                <select
                  value={historyFilter.person}
                  onChange={e => setHistoryFilter(f => ({ ...f, person: e.target.value }))}
                  style={{ ...inputStyle, width: 'auto' }}
                >
                  <option value="">All members</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Filter by date</label>
                <input
                  type="date"
                  value={historyFilter.date}
                  onChange={e => setHistoryFilter(f => ({ ...f, date: e.target.value }))}
                  style={{ ...inputStyle, width: 'auto' }}
                  autoComplete="off"
                />
              </div>
              <button onClick={loadHistory} style={{ padding: '8px 20px', background: C.accent, color: '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Apply</button>
              <button onClick={() => setHistoryFilter({ person: '', date: '' })} style={{ padding: '8px 20px', background: C.elevated, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Clear</button>
            </div>

            {loadingReports ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>
            ) : reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports found.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                {reports.map(r => (
                  <ReportCard key={r.id} report={r} onSendSlack={handleSendSlack} onEdit={handleEditReport} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TEAM VIEW TAB ────────────────────────────────────────────────── */}
        {tab === 'team' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div>
                <label style={labelStyle}>View date</label>
                <input
                  type="date"
                  value={teamDate}
                  onChange={e => setTeamDate(e.target.value)}
                  style={{ ...inputStyle, width: 'auto' }}
                  autoComplete="off"
                />
              </div>
            </div>

            {loadingTeam ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>
            ) : (
              <>
                <div style={cardStyle}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>
                    {new Date(teamDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {teamMembers.map(m => {
                      const submitted = teamReports.some(r => r.team_member_id === m.id);
                      const onLeave = teamLeave.some(l => l.team_member_id === m.id);
                      return (
                        <span key={m.id} style={{
                          padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                          background: onLeave ? '#FFB84D15' : submitted ? '#00E5A022' : C.elevated,
                          color: onLeave ? C.warn : submitted ? C.accent : C.muted,
                          border: `1px solid ${onLeave ? C.warn + '44' : submitted ? C.accent + '44' : C.border}`,
                        }}>
                          {onLeave ? '🌙' : submitted ? '✓' : '○'} {m.name}
                          {onLeave && <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.7 }}>off</span>}
                        </span>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 13, color: C.sub, marginTop: 12 }}>
                    {teamReports.length} submitted · {teamLeave.length} on leave · {teamMembers.length - teamReports.length - teamLeave.length} pending
                  </div>
                </div>

                {teamReports.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                    {teamReports.map(r => (
                      <ReportCard key={r.id} report={r} onSendSlack={handleSendSlack} onEdit={handleEditReport} />
                    ))}
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
