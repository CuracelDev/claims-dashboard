'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import { getSession } from '../lib/auth';

const METRIC_GROUPS = [
  {
    category: 'claims_piles', label: 'Claims Piles Checked',
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
    category: 'mapping_data', label: 'Mapping & Data',
    metrics: [
      { key: 'providers_mapped',   label: 'Num of Providers Mapped' },
      { key: 'care_items_mapped',  label: 'Num of Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Num of Care Items Grouped' },
      { key: 'resolved_cares',     label: 'Resolved Cares' },
    ],
  },
  {
    category: 'quality_review', label: 'Quality & Review',
    metrics: [
      { key: 'auto_pa_reviewed',   label: 'Num of Auto P.A Reviewed/Approved' },
      { key: 'flagged_care_items', label: 'Num of Flagged Care Items' },
      { key: 'icd10_adjusted',     label: 'Number of ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up',    label: 'Num Benefits Set Up' },
      { key: 'providers_assigned', label: 'Providers Assigned' },
    ],
  },
];

const GROUP_COLORS = {
  claims_piles: '#A78BFA',
  mapping_data: '#5B8DEF',
  quality_review: '#00E5A0',
};

const todayStr = () => new Date().toISOString().split('T')[0];

function MetricGroup({ group, metrics, onChangeMetric }) {
  const { C } = useTheme();
  const color = GROUP_COLORS[group.category];
  const S = makeS(C);
  return (
    <div style={{ ...S.card, borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color, marginBottom: 16 }}>{group.label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {group.metrics.map(m => (
          <div key={m.key}>
            <label style={S.label}>{m.label}</label>
            <input
              type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
              value={metrics[m.key] !== undefined ? metrics[m.key] : ''}
              onChange={e => {
                const v = e.target.value;
                if (v === '' || /^\d+$/.test(v)) onChangeMetric(m.key, v);
              }}
              style={S.input}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function LeavePanel({ memberId, memberName, reportDate, onLeaveActive }) {
  const { C } = useTheme();
  const S = makeS(C);
  const [activeLeave, setActiveLeave] = useState(null);
  const [open, setOpen] = useState(false);
  const [leaveType, setLeaveType] = useState('off_today');
  const [startDate, setStartDate] = useState(reportDate);
  const [endDate, setEndDate] = useState(reportDate);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setStartDate(reportDate); setEndDate(reportDate); }, [reportDate]);

  useEffect(() => {
    if (!memberId || !reportDate) { setActiveLeave(null); onLeaveActive(null); return; }
    fetch(`/api/leave?member_id=${memberId}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data, on_leave }) => {
        const leave = on_leave && data ? data : null;
        setActiveLeave(leave); onLeaveActive(leave);
      })
      .catch(() => { setActiveLeave(null); onLeaveActive(null); });
  }, [memberId, reportDate]);

  const handleMark = async () => {
    setSaving(true);
    try {
      const isSingle = leaveType === 'off_today' || leaveType === 'public_holiday';
      const res = await fetch('/api/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: memberId, leave_type: leaveType,
          start_date: isSingle ? reportDate : startDate,
          end_date: isSingle ? reportDate : endDate,
          reason, marked_by: 'Admin',
        }),
      });
      const { data } = await res.json();
      setActiveLeave(data); onLeaveActive(data); setOpen(false); setReason('');
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const handleCancel = async () => {
    if (!activeLeave) return;
    await fetch(`/api/leave?id=${activeLeave.id}`, { method: 'DELETE' });
    setActiveLeave(null); onLeaveActive(null);
  };

  if (!memberId) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      {activeLeave ? (
        <div style={{ background: `${C.warn}10`, border: `1px solid ${C.warn}44`, borderRadius: 10, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
          <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.sub, fontSize: 13, padding: '8px 16px', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
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
                {(leaveType === 'leave_range' || leaveType === 'weekend_off') && (
                  <>
                    <div><label style={S.label}>Start Date</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={S.input} /></div>
                    <div><label style={S.label}>End Date</label><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={S.input} /></div>
                  </>
                )}
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

function PreviewModal({ report, teamMembers, onClose, onSendSlack }) {
  const { C } = useTheme();
  const member = teamMembers.find(m => String(m.id) === String(report.team_member_id));
  const total = Object.values(report.metrics || {}).reduce((a, b) => a + (parseInt(b) || 0), 0);
  const filled = Object.keys(report.metrics || {}).filter(k => parseInt(report.metrics[k]) > 0).length;
  const dateStr = report.report_date ? new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '';

  const copyText = () => {
    const lines = [`📊 Daily Report — ${member?.name || ''} | ${dateStr}`, ''];
    METRIC_GROUPS.forEach(g => {
      const items = g.metrics.filter(m => parseInt(report.metrics?.[m.key]) > 0);
      if (items.length > 0) {
        lines.push(`*${g.label}*`);
        items.forEach(m => lines.push(`  ${m.label}: ${report.metrics[m.key]}`));
        lines.push('');
      }
    });
    lines.push(`Total Output: ${total}`);
    if (report.tasks_completed) { lines.push(''); lines.push(`Tasks: ${report.tasks_completed}`); }
    if (report.notes) { lines.push(''); lines.push(`Notes: ${report.notes}`); }
    navigator.clipboard.writeText(lines.join('\n'));
    alert('Copied!');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 18, color: C.text }}>Report Preview</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.sub, fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 20 }}>{dateStr}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
          <div style={{ background: C.elevated, borderRadius: 10, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: C.accent }}>{total}</div>
            <div style={{ fontSize: 12, color: C.sub }}>Total Output</div>
          </div>
          <div style={{ background: C.elevated, borderRadius: 10, padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: C.blue }}>{filled}</div>
            <div style={{ fontSize: 12, color: C.sub }}>Metrics Filled</div>
          </div>
        </div>
        {METRIC_GROUPS.map(g => {
          const items = g.metrics.filter(m => parseInt(report.metrics?.[m.key]) > 0);
          if (!items.length) return null;
          return (
            <div key={g.category} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: GROUP_COLORS[g.category], marginBottom: 8 }}>{g.label}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {items.map(m => (
                  <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', background: C.elevated, borderRadius: 6, padding: '6px 10px', fontSize: 13 }}>
                    <span style={{ color: C.sub }}>{m.label}</span>
                    <span style={{ color: C.text, fontWeight: 600 }}>{report.metrics[m.key]}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {report.tasks_completed && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>Tasks Completed</div>
            <div style={{ fontSize: 13, color: C.text, background: C.elevated, borderRadius: 8, padding: '8px 12px' }}>{report.tasks_completed}</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button onClick={copyText} style={{ flex: 1, padding: 12, background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, cursor: 'pointer' }}>
            📋 Copy Text
          </button>
          <button onClick={onSendSlack} style={{ flex: 1, padding: 12, background: C.accentDim, border: 'none', borderRadius: 8, color: '#0B0F1A', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            📤 Send to Slack
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportCard({ report, teamMembers, onEdit }) {
  const { C } = useTheme();
  const S = makeS(C);
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

function DailySummary({ teamMembers, date }) {
  const { C } = useTheme();
  const S = makeS(C);
  const [data, setData] = useState({ reports: [], leave: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/reports?date=${date}`).then(r => r.json()),
      fetch(`/api/leave?date=${date}&all=true`).then(r => r.json()).catch(() => ({ data: [] })),
    ]).then(([r, l]) => {
      setData({ reports: r.data || [], leave: l.data || [] });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [date]);

  if (loading || !date) return null;

  const submitted = data.reports.map(r => r.team_member_id);
  const onLeave = data.leave.map(l => l.team_member_id);
  const pending = teamMembers.filter(m => !submitted.includes(m.id) && !onLeave.includes(m.id));

  return (
    <div style={{ ...S.card, borderTop: `3px solid ${C.accent}`, marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.accent, marginBottom: 14 }}>
        Today's Summary — {new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
      <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { val: data.reports.length, label: 'Submitted', color: C.accent },
          { val: onLeave.length, label: 'On Leave', color: C.warn },
          { val: pending.length, label: 'Pending', color: C.muted },
        ].map(s => (
          <div key={s.label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.val}</div>
            <div style={{ fontSize: 11, color: C.sub }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {teamMembers.map(m => {
          const done = submitted.includes(m.id);
          const off = onLeave.includes(m.id);
          return (
            <span key={m.id} style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 12,
              background: off ? `${C.warn}12` : done ? `${C.accent}12` : C.elevated,
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

// Helper to generate style objects from theme
function makeS(C) {
  return {
    input: {
      background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: 8,
      color: C.text, padding: '9px 12px', fontSize: 14, width: '100%',
      outline: 'none', boxSizing: 'border-box',
    },
    label: { fontSize: 12, color: C.sub, marginBottom: 4, display: 'block' },
    card: {
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: 20, marginBottom: 16,
    },
  };
}

// ── Report Form (shown after PIN auth) ────────────────────────────────────────

function MissedDaysBanner({ memberId, onSelectDate }) {
  const { C } = useTheme();
  const [missed, setMissed] = useState([]);

  useEffect(() => {
    if (!memberId) return;
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() + (dayOfWeek === 0 ? -6 : 1 - dayOfWeek));
    const days = [];
    const cursor = new Date(monday);
    while (cursor < today) {
      days.push(cursor.toISOString().split('T')[0]);
      cursor.setDate(cursor.getDate() + 1);
    }
    if (days.length === 0) { setMissed([]); return; }
    const from = days[0];
    const to = days[days.length - 1];
    Promise.all([
      fetch('/api/reports?member_id=' + memberId + '&from=' + from + '&to=' + to).then(r => r.json()),
      fetch('/api/leave?member_id=' + memberId + '&from=' + from + '&to=' + to).then(r => r.json()).catch(() => ({ data: [] })),
    ]).then(([rRes, lRes]) => {
      const submitted = (rRes.data || []).map(r => r.report_date);
      const onLeave = (lRes.data || []).flatMap(l => {
        const dates = [];
        const s = new Date(l.start_date + 'T12:00:00');
        const e = new Date(l.end_date + 'T12:00:00');
        const d = new Date(s);
        while (d <= e) { dates.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 1); }
        return dates;
      });
      setMissed(days.filter(d => !submitted.includes(d) && !onLeave.includes(d)));
    }).catch(() => setMissed([]));
  }, [memberId]);

  if (missed.length === 0) return null;

  return (
    <div style={{
      background: '#F59E0B10', border: '1px solid #F59E0B44',
      borderRadius: 10, padding: '12px 16px', marginBottom: 16,
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 13, color: '#F59E0B', fontWeight: 600 }}>
        ⚠️ Missing reports for:
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {missed.map(d => (
          <button
            key={d}
            onClick={() => onSelectDate(d)}
            style={{
              padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', background: '#F59E0B18',
              border: '1px solid #F59E0B66', color: '#F59E0B', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#F59E0B'; e.currentTarget.style.color = '#0B1929'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#F59E0B18'; e.currentTarget.style.color = '#F59E0B'; }}
          >
            {new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
          </button>
        ))}
      </div>
      <span style={{ fontSize: 11, color: '#6B7A99' }}>Click a date to fill in or mark leave</span>
    </div>
  );
}

function ReportForm({ teamMembers, authSession, editPreset, onPresetUsed }) {
  const { C } = useTheme();
  const S = makeS(C);
  const [selectedMember] = useState(String(authSession.memberId));
  const [reportDate, setReportDate] = useState(todayStr());

  // When editing a historical report, jump to that date
  useEffect(() => {
    if (editPreset?.date) {
      setReportDate(editPreset.date);
      if (onPresetUsed) onPresetUsed();
    }
  }, [editPreset]);
  const [metrics, setMetrics] = useState({});
  const [tasksCompleted, setTasksCompleted] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [isLeaveActive, setIsLeaveActive] = useState(false);
  const [editingReport, setEditingReport] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const selectedMemberName = teamMembers.find(m => String(m.id) === String(selectedMember))?.name || '';

  useEffect(() => {
    if (!selectedMember || !reportDate) {
      setMetrics({}); setTasksCompleted(''); setNotes(''); setEditingReport(null);
      return;
    }
    fetch(`/api/reports?person_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data }) => {
        if (data) {
          setMetrics(data.metrics || {});
          setTasksCompleted(data.tasks_completed || '');
          setNotes(data.notes || '');
          setEditingReport(data);
        } else {
          setMetrics({}); setTasksCompleted(''); setNotes(''); setEditingReport(null);
        }
      })
      .catch(() => { setMetrics({}); setTasksCompleted(''); setNotes(''); setEditingReport(null); });
  }, [selectedMember, reportDate]);

  const handleSave = async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: selectedMember, report_date: reportDate, metrics, tasks_completed: tasksCompleted, notes, status: 'submitted' }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setSaveMsg({ type: 'success', text: 'Saved!' });
      setEditingReport(json.data);
      setSaving(false);
      return json.data;
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message });
      setSaving(false);
      return null;
    }
  };

  const handleSaveAndPreview = async () => {
    const saved = await handleSave();
    if (saved) setShowPreview(true);
  };

  const handleSendSlack = async () => {
    if (!editingReport) return;
    const member = teamMembers.find(m => String(m.id) === String(editingReport.team_member_id));
    try {
      const res = await fetch('/api/reports/send-slack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: editingReport, teamMember: member, channel: 'health-ops' }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      alert('Sent to Slack!');
      setShowPreview(false);
    } catch (err) { alert('Failed: ' + err.message); }
  };

  const totalOutput = Object.values(metrics).reduce((a, b) => a + (parseInt(b) || 0), 0);

  return (
    <>
      <MissedDaysBanner memberId={selectedMember} onSelectDate={(d) => setReportDate(d)} />
      <DailySummary teamMembers={teamMembers} date={reportDate} />

      {editingReport && (
        <div style={{ background: `${C.blue}15`, border: `1px solid ${C.blue}44`, borderRadius: 10, padding: '10px 16px', marginBottom: 14, fontSize: 13, color: C.blue }}>
          ✏️ Editing existing report — changes will overwrite
        </div>
      )}

      <div style={S.card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: C.text }}>Report Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={S.label}>Team Member</label>
            <div style={{ ...S.input, background: C.elevated, color: C.accent, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              🔒 {authSession.memberName}
            </div>
          </div>
          <div>
            <label style={S.label}>Report Date</label>
            <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} style={S.input} autoComplete="off" />
          </div>
        </div>
      </div>

      <LeavePanel memberId={selectedMember} memberName={selectedMemberName} reportDate={reportDate} onLeaveActive={leave => setIsLeaveActive(!!leave)} />

      {!isLeaveActive && (
        <>
          {METRIC_GROUPS.map(group => (
            <MetricGroup key={group.category} group={group} metrics={metrics} onChangeMetric={(key, val) => setMetrics(prev => ({ ...prev, [key]: val }))} />
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {saveMsg && (
                <span style={{ fontSize: 13, color: saveMsg.type === 'success' ? C.accent : C.danger }}>
                  {saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}
                </span>
              )}
              <button onClick={handleSave} disabled={saving} style={{
                padding: '10px 24px', background: saving ? C.muted : C.elevated,
                color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontWeight: 600, fontSize: 14,
                cursor: saving ? 'not-allowed' : 'pointer',
              }}>
                {saving ? 'Saving…' : '💾 Save'}
              </button>
              <button onClick={handleSaveAndPreview} disabled={saving} style={{
                padding: '10px 24px', background: saving ? C.muted : C.accent,
                color: '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
                cursor: saving ? 'not-allowed' : 'pointer',
              }}>
                ✨ Save & Preview
              </button>
            </div>
          </div>
        </>
      )}

      {isLeaveActive && (
        <div style={{ background: `${C.warn}08`, border: `1px dashed ${C.warn}44`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🌙</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.warn, marginBottom: 4 }}>{selectedMemberName} is off today</div>
          <div style={{ fontSize: 13, color: C.sub }}>No report needed. Slack reminder will be skipped.</div>
        </div>
      )}

      {showPreview && editingReport && (
        <PreviewModal report={editingReport} teamMembers={teamMembers} onClose={() => setShowPreview(false)} onSendSlack={handleSendSlack} />
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const { C } = useTheme();
  const [tab, setTab] = useState('form');
  const [teamMembers, setTeamMembers] = useState([]);
  const [authSession, setAuthSession] = useState(null);
  const [reports, setReports] = useState([]);
  const [histFilter, setHistFilter] = useState({ person: '', date: '' });
  const [loadingHist, setLoadingHist] = useState(false);

  const S = makeS(C);

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers(data || []));
    const session = getSession();
    if (session && session.member_id) {
      setAuthSession({ memberId: session.member_id, memberName: session.member_name });
      setHistFilter(f => ({ ...f, person: String(session.member_id) }));
    }
  }, []);

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

  const [editPreset, setEditPreset] = useState(null);

  const handleEditReport = (report) => {
    setEditPreset({ date: report.report_date });
    setTab('form');
  };

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: '10px 20px', fontSize: 14, fontWeight: 500, border: 'none', cursor: 'pointer',
      background: 'transparent',
      borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent',
      color: tab === key ? C.accent : C.sub,
    }}>{label}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60, transition: 'background 0.2s' }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '18px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: C.text }}>Daily Reports</h1>
        <p style={{ margin: '4px 0 0', fontSize: 14, color: C.sub }}>Health Ops team reporting</p>
      </div>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('form', '📝 Submit Report')}
        {tabBtn('history', '🕐 History')}
        {tabBtn('team', '👥 Team View')}
      </div>

      <div style={{ padding: '20px 24px' }}>
        {tab === 'form' && (
          <div style={{ maxWidth: '100%' }}>
            {authSession && <ReportForm teamMembers={teamMembers} authSession={authSession} editPreset={editPreset} onPresetUsed={() => setEditPreset(null)} />}
          </div>
        )}

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
              <button onClick={() => setHistFilter({ person: '', date: '' })} style={{ padding: '9px 20px', background: C.elevated, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Clear</button>
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

        {tab === 'team' && <DailySummary teamMembers={teamMembers} date={todayStr()} />}
      </div>
    </div>
  );
}
