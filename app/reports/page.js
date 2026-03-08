'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

const C = {
  accent: '#00E5A0', accentDim: '#00B87D',
  bg: '#0B0F1A', card: '#111827', elevated: '#1A2332',
  border: '#1E2D3D', text: '#F0F4F8', sub: '#8899AA', muted: '#556677',
  danger: '#FF5C5C', warn: '#FFB84D', success: '#34D399',
  blue: '#5B8DEF', purple: '#A78BFA', orange: '#FB923C',
};

const METRIC_GROUPS = [
  {
    category: 'claims_piles', label: 'Claims Piles Checked', color: C.purple,
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
    category: 'mapping_data', label: 'Mapping & Data', color: C.blue,
    metrics: [
      { key: 'providers_mapped',   label: 'Num of Providers Mapped' },
      { key: 'care_items_mapped',  label: 'Num of Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Num of Care Items Grouped' },
      { key: 'resolved_cares',     label: 'Resolved Cares' },
    ],
  },
  {
    category: 'quality_review', label: 'Quality & Review', color: C.accent,
    metrics: [
      { key: 'auto_pa_reviewed',   label: 'Num of Auto P.A Reviewed/Approved' },
      { key: 'flagged_care_items', label: 'Num of Flagged Care Items' },
      { key: 'icd10_adjusted',     label: 'Number of ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up',    label: 'Num Benefits Set Up' },
      { key: 'providers_assigned', label: 'Providers Assigned' },
    ],
  },
];

const todayStr = () => new Date().toISOString().split('T')[0];

const S = {
  input: {
    background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8,
    color: C.text, padding: '9px 12px', fontSize: 14, width: '100%',
    outline: 'none', boxSizing: 'border-box',
  },
  label: { fontSize: 12, color: C.sub, marginBottom: 4, display: 'block' },
  card: {
    background: C.card, border: `1px solid ${C.border}`,
    borderRadius: 12, padding: 20, marginBottom: 16,
  },
};

// ── MetricGroup ───────────────────────────────────────────────────────────────
function MetricGroup({ group, metrics, onChange, randKey }) {
  return (
    <div style={{ ...S.card, borderTop: `3px solid ${group.color}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: group.color, marginBottom: 16 }}>{group.label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {group.metrics.map(m => (
          <div key={m.key}>
            <label style={S.label}>{m.label}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              value={metrics[m.key] ?? ''}
              onChange={e => {
                const v = e.target.value;
                if (v === '' || /^\d+$/.test(v)) onChange(m.key, v);
              }}
              placeholder=""
              style={S.input}
            />
          </div>
        ))}
      </div>

      {showPreview && editingReport && (
        <div style={{ position: 'fixed', inset: 0, background: '#000A', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, width: '100%', maxWidth: 560, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 18 }}>Report Preview</div>
              <button onClick={() => setShowPreview(false)} style={{ background: 'none', border: 'none', color: C.sub, fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <div style={{ background: C.elevated, borderRadius: 10, padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: C.accent }}>{Object.values(editingReport.metrics || {}).reduce((a,b) => a+(parseInt(b)||0), 0)}</div>
                <div style={{ fontSize: 12, color: C.sub }}>Total Output</div>
              </div>
              <div style={{ background: C.elevated, borderRadius: 10, padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: C.blue }}>{Object.keys(editingReport.metrics || {}).length}</div>
                <div style={{ fontSize: 12, color: C.sub }}>Metrics Filled</div>
              </div>
            </div>
            {METRIC_GROUPS.map(g => (
              <div key={g.category} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: g.color, marginBottom: 8 }}>{g.label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {g.metrics.filter(m => editingReport.metrics?.[m.key]).map(m => (
                    <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', background: C.elevated, borderRadius: 6, padding: '6px 10px', fontSize: 13 }}>
                      <span style={{ color: C.sub }}>{m.label}</span>
                      <span style={{ color: C.text, fontWeight: 600 }}>{editingReport.metrics[m.key]}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button onClick={() => {
                const text = METRIC_GROUPS.flatMap(g => g.metrics.filter(m => editingReport.metrics?.[m.key]).map(m => `${m.label}: ${editingReport.metrics[m.key]}`)).join('\n');
                navigator.clipboard.writeText(text);
                alert('Copied!');
              }} style={{ flex: 1, padding: '10px', background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, cursor: 'pointer' }}>
                📋 Copy Text
              </button>
              <button onClick={async () => {
                const member = teamMembers.find(m => String(m.id) === String(editingReport.team_member_id));
                const res = await fetch('/api/reports/send-slack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: editingReport, teamMember: member, channel: 'health-ops' }) });
                const result = await res.json();
                if (result.error) alert('Failed: ' + result.error);
                else alert('Sent to Slack!');
              }} style={{ flex: 1, padding: '10px', background: C.accentDim, border: 'none', borderRadius: 8, color: '#0B0F1A', fontWeight: 700, cursor: 'pointer' }}>
                📤 Send to Slack
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── LeavePanel ────────────────────────────────────────────────────────────────
function LeavePanel({ memberId, memberName, reportDate, onLeaveActive }) {
  const [activeLeave, setActiveLeave] = useState(null);
  const [open, setOpen] = useState(false);
  const [leaveType, setLeaveType] = useState('off_today');
  const [startDate, setStartDate] = useState(reportDate);
  const [endDate, setEndDate] = useState(reportDate);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStartDate(reportDate);
    setEndDate(reportDate);
  }, [reportDate]);

  useEffect(() => {
    if (!memberId || !reportDate) { setActiveLeave(null); onLeaveActive(null); return; }
    fetch(`/api/leave?member_id=${memberId}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data, on_leave }) => {
        const leave = on_leave && data ? data : null;
        setActiveLeave(leave);
        onLeaveActive(leave);
      })
      .catch(() => { setActiveLeave(null); onLeaveActive(null); });
  }, [memberId, reportDate]);

  const handleMark = async () => {
    if (!memberId) return;
    setSaving(true);
    try {
      const isSingle = leaveType === 'off_today' || leaveType === 'public_holiday';
      const res = await fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: memberId,
          leave_type: leaveType,
          start_date: isSingle ? reportDate : startDate,
          end_date: isSingle ? reportDate : endDate,
          reason,
          marked_by: 'Admin',
        }),
      });
      const { data } = await res.json();
      setActiveLeave(data);
      onLeaveActive(data);
      setOpen(false);
      setReason('');
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleCancel = async () => {
    if (!activeLeave) return;
    await fetch(`/api/leave?id=${activeLeave.id}`, { method: 'DELETE' });
    setActiveLeave(null);
    onLeaveActive(null);
  };

  if (!memberId) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      {activeLeave ? (
        <div style={{ background: '#FFB84D10', border: `1px solid ${C.warn}44`, borderRadius: 10, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: C.warn }}>
            🌙 {memberName} is on leave — {activeLeave.leave_type.replace(/_/g, ' ')}
            {activeLeave.reason ? ` · "${activeLeave.reason}"` : ''}
          </span>
          <button onClick={handleCancel} style={{ background: 'none', border: `1px solid ${C.warn}44`, borderRadius: 6, color: C.warn, fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}>
            ✕ Cancel leave
          </button>
        </div>
      ) : (
        <div>
          <button
            onClick={() => setOpen(o => !o)}
            style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.sub, fontSize: 13, padding: '8px 16px', cursor: 'pointer', width: '100%', textAlign: 'left' }}
          >
            🌙 Mark {memberName} as off / on leave
          </button>
          {open && (
            <div style={{ ...S.card, marginTop: 8, marginBottom: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={S.label}>Leave Type</label>
                  <select value={leaveType} onChange={e => setLeaveType(e.target.value)} style={S.input}>
                    <option value="off_today">🌙 Off Today</option>
                    <option value="leave_range">📅 On Leave (date range)</option>
                    <option value="weekend_off">🏖 Weekend Off</option>
                    <option value="public_holiday">🎉 Public Holiday</option>
                  </select>
                </div>
                {(leaveType === 'leave_range' || leaveType === 'weekend_off') ? (
                  <>
                    <div>
                      <label style={S.label}>Start Date</label>
                      <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={S.input} />
                    </div>
                    <div>
                      <label style={S.label}>End Date</label>
                      <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={S.input} />
                    </div>
                  </>
                ) : null}
                <div>
                  <label style={S.label}>Reason (optional)</label>
                  <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Annual leave" style={S.input} autoComplete="off" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleMark} disabled={saving} style={{ padding: '8px 20px', background: C.warn, color: '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                  {saving ? 'Saving…' : 'Confirm'}
                </button>
                <button onClick={() => setOpen(false)} style={{ padding: '8px 20px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.sub, fontSize: 13, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ReportCard ────────────────────────────────────────────────────────────────
function ReportCard({ report, teamMembers, onEdit }) {
  const member = teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
  const name = member?.display_name || member?.name || 'Unknown';
  const total = Object.values(report.metrics || {}).reduce((a, b) => a + (parseInt(b) || 0), 0);
  const dateStr = report.report_date ? new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

  return (
    <div style={{ ...S.card, marginBottom: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{name}</div>
          <div style={{ fontSize: 12, color: C.sub }}>{dateStr}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.accent }}>{total}</div>
          <div style={{ fontSize: 11, color: C.muted }}>total output</div>
        </div>
      </div>
      {report.tasks_completed && (
        <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
          {report.tasks_completed.slice(0, 100)}{report.tasks_completed.length > 100 ? '…' : ''}
        </div>
      )}
      <button onClick={() => onEdit(report)} style={{ fontSize: 12, padding: '5px 12px', background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 6, color: C.sub, cursor: 'pointer' }}>
        ✏️ Edit
      </button>
    </div>
  );
}

// ── DailySummary ──────────────────────────────────────────────────────────────
function DailySummary({ teamMembers, date }) {
  const [data, setData] = useState({ reports: [], leave: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/reports?date=${date}`).then(r => r.json()),
      fetch(`/api/leave?date=${date}&all=true`).then(r => r.json()),
    ]).then(([r, l]) => {
      setData({ reports: r.data || [], leave: l.data || [] });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [date]);

  if (loading) return null;

  const submitted = data.reports.map(r => r.team_member_id);
  const onLeave = data.leave.map(l => l.team_member_id);
  const pending = teamMembers.filter(m => !submitted.includes(m.id) && !onLeave.includes(m.id));
  const totalOutput = data.reports.reduce((sum, r) => sum + Object.values(r.metrics || {}).reduce((a, b) => a + (parseInt(b) || 0), 0), 0);

  return (
    <div style={{ ...S.card, borderTop: `3px solid ${C.accent}`, marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.accent, marginBottom: 14 }}>
        Today's Summary — {new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
      <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: C.accent }}>{data.reports.length}</div>
          <div style={{ fontSize: 11, color: C.sub }}>Submitted</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: C.warn }}>{onLeave.length}</div>
          <div style={{ fontSize: 11, color: C.sub }}>On Leave</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: C.muted }}>{pending.length}</div>
          <div style={{ fontSize: 11, color: C.sub }}>Pending</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: C.blue }}>{totalOutput}</div>
          <div style={{ fontSize: 11, color: C.sub }}>Total Output</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {teamMembers.map(m => {
          const done = submitted.includes(m.id);
          const off = onLeave.includes(m.id);
          return (
            <span key={m.id} style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 12,
              background: off ? '#FFB84D12' : done ? '#00E5A012' : C.elevated,
              color: off ? C.warn : done ? C.accent : C.muted,
              border: `1px solid ${off ? C.warn + '33' : done ? C.accent + '33' : C.border}`,
            }}>
              {off ? '🌙' : done ? '✓' : '○'} {m.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
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
  const [isLeaveActive, setIsLeaveActive] = useState(false);
  const [editingReport, setEditingReport] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [reports, setReports] = useState([]);
  const [histFilter, setHistFilter] = useState({ person: '', date: '' });
  const [loadingHist, setLoadingHist] = useState(false);
  const randKey = useRef(Math.random().toString(36).slice(2));

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers(data || []));
  }, []);

  // Load report when member+date changes
  useEffect(() => {
    if (!selectedMember || !reportDate) {
      setMetrics({}); setTasksCompleted(''); setNotes(''); setEditingReport(null);
      return;
    }
    fetch(`/api/reports?person_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data }) => {
        if (data) {
          const m = data.metrics || {};
          // Only load if values are not all identical (corrupted data guard)
          const vals = Object.values(m).map(v => parseInt(v)).filter(n => !isNaN(n));
          const allSame = vals.length > 1 && vals.every(v => v === vals[0]);
          setMetrics(allSame ? {} : m);
          setTasksCompleted(data.tasks_completed || '');
          setNotes(data.notes || '');
          setEditingReport(data);
        } else {
          setMetrics({}); setTasksCompleted(''); setNotes(''); setEditingReport(null);
        }
      })
      .catch(() => {
        setMetrics({}); setTasksCompleted(''); setNotes(''); setEditingReport(null);
      });
  }, [selectedMember, reportDate]);

  const handleMetricChange = (key, val) => setMetrics(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    if (!selectedMember) { setSaveMsg({ type: 'error', text: 'Select a team member first.' }); return; }
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: selectedMember, report_date: reportDate, metrics, tasks_completed: tasksCompleted, notes, status: 'submitted' }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setSaveMsg({ type: 'success', text: 'Saved!' });
      setEditingReport(json.data);
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  };

  const handleEditReport = (report) => {
    setSelectedMember(String(report.team_member_id));
    setReportDate(report.report_date);
    setMetrics(report.metrics || {});
    setTasksCompleted(report.tasks_completed || '');
    setNotes(report.notes || '');
    setEditingReport(report);
    setTab('form');
  };

  const loadHistory = useCallback(() => {
    setLoadingHist(true);
    const p = new URLSearchParams({ limit: '30' });
    if (histFilter.person) p.set('member_id', histFilter.person);
    if (histFilter.date) p.set('date', histFilter.date);
    fetch(`/api/reports?${p}`).then(r => r.json()).then(({ data }) => {
      setReports(data || []); setLoadingHist(false);
    });
  }, [histFilter]);

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  const totalOutput = Object.values(metrics).reduce((a, b) => a + (parseInt(b) || 0), 0);
  const selectedMemberName = teamMembers.find(m => String(m.id) === String(selectedMember))?.name || '';

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: '10px 20px', fontSize: 14, fontWeight: 500, border: 'none', cursor: 'pointer',
      background: 'transparent',
      borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent',
      color: tab === key ? C.accent : C.sub,
    }}>{label}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>Daily Reports</h1>
        <p style={{ margin: '4px 0 0', fontSize: 14, color: C.sub }}>Health Ops team reporting</p>
      </div>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('form', '📝 Submit Report')}
        {tabBtn('history', '🕐 History')}
        {tabBtn('team', '👥 Team View')}
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 32px' }}>

        {/* ── FORM TAB ── */}
        {tab === 'form' && (
          <div style={{ maxWidth: 720 }} autoComplete="off">

            {/* Today's summary */}
            <DailySummary teamMembers={teamMembers} date={reportDate} />

            {editingReport && (
              <div style={{ background: '#5B8DEF15', border: `1px solid ${C.blue}44`, borderRadius: 10, padding: '10px 16px', marginBottom: 14, fontSize: 13, color: C.blue }}>
                ✏️ Editing existing report — changes will overwrite
              </div>
            )}

            {/* Person + Date */}
            <div style={S.card}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Report Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={S.label}>Team Member</label>
                  <select value={selectedMember} onChange={e => { setSelectedMember(e.target.value); setIsLeaveActive(false); }} style={S.input}>
                    <option value="">Select member…</option>
                    {teamMembers.map(m => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={S.label}>Report Date</label>
                  <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} style={S.input} autoComplete="off" />
                </div>
              </div>
            </div>

            {/* Leave panel */}
            {selectedMember && (
              <LeavePanel
                memberId={selectedMember}
                memberName={selectedMemberName}
                reportDate={reportDate}
                onLeaveActive={(leave) => setIsLeaveActive(!!leave)}
              />
            )}

            {/* Metrics — hidden if on leave */}
            {!isLeaveActive && (
              <>
                {METRIC_GROUPS.map(group => (
                  <MetricGroup key={group.category} group={group} metrics={metrics} onChange={handleMetricChange} randKey={randKey.current} />
                ))}

                <div style={S.card}>
                  <div style={{ marginBottom: 16 }}>
                    <label style={S.label}>Tasks Completed</label>
                    <textarea value={tasksCompleted} onChange={e => setTasksCompleted(e.target.value)} rows={3} placeholder="List tasks you completed today…" style={{ ...S.input, resize: 'vertical' }} />
                  </div>
                  <div>
                    <label style={S.label}>Notes / Blockers</label>
                    <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Any blockers, observations, or notes…" style={{ ...S.input, resize: 'vertical' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
                  <div style={{ fontSize: 14, color: C.sub }}>
                    Total output: <span style={{ color: C.accent, fontWeight: 700, fontSize: 22 }}>{totalOutput}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {saveMsg && (
                      <span style={{ fontSize: 13, color: saveMsg.type === 'success' ? C.success : C.danger }}>
                        {saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}
                      </span>
                    )}
                    <button onClick={handleSave} disabled={saving || !selectedMember} style={{
                      padding: '10px 28px', background: saving || !selectedMember ? C.muted : C.accent,
                      color: '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
                      cursor: saving || !selectedMember ? 'not-allowed' : 'pointer',
                    }}>
                      {saving ? 'Saving…' : '💾 Save'}
                    </button>
                    <button onClick={async () => { await handleSave(); setShowPreview(true); }} disabled={saving || !selectedMember} style={{
                      padding: '10px 28px', background: C.accent, color: '#0B0F1A',
                      border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
                      cursor: saving || !selectedMember ? 'not-allowed' : 'pointer',
                    }}>
                      ✨ Save & Preview
                    </button>
                  </div>
                </div>
              </>
            )}

            {isLeaveActive && (
              <div style={{ background: '#FFB84D08', border: `1px dashed ${C.warn}44`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🌙</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.warn, marginBottom: 4 }}>{selectedMemberName} is off today</div>
                <div style={{ fontSize: 13, color: C.sub }}>No report needed. Slack reminder will be skipped.</div>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === 'history' && (
          <div>
            <div style={{ ...S.card, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={S.label}>Filter by person</label>
                <select value={histFilter.person} onChange={e => setHistFilter(f => ({ ...f, person: e.target.value }))} style={{ ...S.input, width: 'auto' }}>
                  <option value="">All members</option>
                  {teamMembers.map(m => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Filter by date</label>
                <input type="date" value={histFilter.date} onChange={e => setHistFilter(f => ({ ...f, date: e.target.value }))} style={{ ...S.input, width: 'auto' }} autoComplete="off" />
              </div>
              <button onClick={loadHistory} style={{ padding: '9px 20px', background: C.accent, color: '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Apply</button>
              <button onClick={() => { setHistFilter({ person: '', date: '' }); }} style={{ padding: '9px 20px', background: C.elevated, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Clear</button>
            </div>
            {loadingHist ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>
            ) : reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports found.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                {reports.map(r => <ReportCard key={r.id} report={r} teamMembers={teamMembers} onEdit={handleEditReport} />)}
              </div>
            )}
          </div>
        )}

        {/* ── TEAM VIEW TAB ── */}
        {tab === 'team' && <DailySummary teamMembers={teamMembers} date={todayStr()} />}

      </div>
    </div>
  );
}
