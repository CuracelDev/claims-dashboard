'use client';
import { useState, useEffect, useCallback } from 'react';

const C = {
  accent: "#00E5A0", accentDim: "#00B87D",
  bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  danger: "#FF5C5C", warn: "#FFB84D", success: "#34D399",
  blue: "#5B8DEF", purple: "#A78BFA",
};

const METRIC_GROUPS = [
  {
    category: 'mapping_data',
    label: '📦 Mapping & Data',
    color: C.blue,
    metrics: [
      { key: 'providers_mapped',   label: 'Providers Mapped' },
      { key: 'care_items_mapped',  label: 'Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Care Items Grouped' },
      { key: 'resolved_cares',     label: 'Resolved Cares' },
    ],
  },
  {
    category: 'claims_piles',
    label: '📊 Claims Piles Checked',
    color: C.purple,
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
    category: 'quality_review',
    label: '✅ Quality & Review',
    color: C.accent,
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
const today = () => new Date().toISOString().split('T')[0];

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

function MetricGroup({ group, metrics, onChange }) {
  return (
    <div style={{ ...cardStyle, borderTop: `3px solid ${group.color}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: group.color, marginBottom: 16 }}>{group.label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {group.metrics.map(m => (
          <div key={m.key}>
            <label style={labelStyle}>{m.label}</label>
            <input
              type="number" min="0"
              value={metrics[m.key] ?? ''}
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

function ReportCard({ report, onSendSlack }) {
  const [sending, setSending] = useState(false);
  const date = new Date(report.report_date + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
  const allMetrics = Object.entries(report.metrics || {}).filter(([, v]) => v !== '' && v !== null && v !== '0' && v !== 0);

  const handleSend = async () => {
    setSending(true);
    await onSendSlack(report);
    setSending(false);
  };

  return (
    <div style={{ background: '#111827', border: '1px solid #1E2D3D', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 600, color: '#F0F4F8', fontSize: 14 }}>{report.team_members?.name}</div>
          <div style={{ fontSize: 12, color: '#8899AA', marginTop: 2 }}>{date}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {report.sent_to_slack && (
            <span style={{ fontSize: 11, background: '#00E5A022', color: '#00E5A0', padding: '2px 8px', borderRadius: 20 }}>✓ Sent</span>
          )}
          <span style={{ fontSize: 11, background: '#1A2332', color: '#8899AA', padding: '2px 8px', borderRadius: 20 }}>{report.status}</span>
        </div>
      </div>

      {allMetrics.length > 0 && (
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

      <button
        onClick={handleSend}
        disabled={sending || report.sent_to_slack}
        style={{
          fontSize: 12, padding: '6px 14px', borderRadius: 8, border: 'none', cursor: report.sent_to_slack ? 'not-allowed' : 'pointer',
          background: report.sent_to_slack ? '#1A2332' : '#4A154B',
          color: report.sent_to_slack ? '#556677' : '#fff', marginTop: 4,
        }}
      >
        {sending ? 'Sending…' : report.sent_to_slack ? 'Sent to Slack' : '📤 Send to Slack'}
      </button>
    </div>
  );
}

export default function ReportsPage() {
  const [tab, setTab] = useState('form');
  const [teamMembers, setTeamMembers] = useState([]);
  const [selectedMember, setSelectedMember] = useState('');
  const [reportDate, setReportDate] = useState(today());
  const [metrics, setMetrics] = useState({});
  const [tasksCompleted, setTasksCompleted] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [reports, setReports] = useState([]);
  const [historyFilter, setHistoryFilter] = useState({ person: '', date: '' });
  const [loadingReports, setLoadingReports] = useState(false);
  const [teamDate, setTeamDate] = useState(today());
  const [teamReports, setTeamReports] = useState([]);
  const [loadingTeam, setLoadingTeam] = useState(false);

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(({ data }) => setTeamMembers(data || []));
  }, []);

  useEffect(() => {
    if (!selectedMember || !reportDate) return;
    fetch(`/api/reports?person_id=${selectedMember}&date=${reportDate}`)
      .then(r => r.json())
      .then(({ data }) => {
        if (data && data.length > 0) {
          const r = data[0];
          setMetrics(r.metrics || {});
          setTasksCompleted(r.tasks_completed || '');
          setNotes(r.notes || '');
        } else {
          setMetrics({}); setTasksCompleted(''); setNotes('');
        }
      });
  }, [selectedMember, reportDate]);

  const loadHistory = useCallback(() => {
    setLoadingReports(true);
    const params = new URLSearchParams({ limit: '30' });
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

  const handleMetricChange = (key, val) => setMetrics(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    if (!selectedMember) { setSaveMsg({ type: 'error', text: 'Please select a team member.' }); return; }
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_member_id: selectedMember, report_date: reportDate, metrics, tasks_completed: tasksCompleted, notes }),
      });
      const { error } = await res.json();
      if (error) throw new Error(error);
      setSaveMsg({ type: 'success', text: 'Report saved successfully!' });
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  };

  const handleSendSlack = async (report) => {
    const member = teamMembers.find(m => m.id === report.team_member_id) || report.team_members;
    try {
      const slackRes = await fetch('/api/reports/send-slack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, teamMember: member, channel: 'health-ops' }),
      });
      const result = await slackRes.json();
      if (result.error) throw new Error(result.error);
      await fetch('/api/reports', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: report.id, sent_to_slack: true, slack_channel: result.channel, sent_at: result.sent_at }),
      });
      loadHistory();
      alert('Report sent to Slack!');
    } catch (err) { alert(`Slack send failed: ${err.message}`); }
  };

  const totalOutput = Object.values(metrics).map(v => parseInt(v)).filter(n => !isNaN(n)).reduce((a, b) => a + b, 0);

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: '10px 20px', fontSize: 14, fontWeight: 500, border: 'none', cursor: 'pointer',
      background: 'transparent', borderBottom: tab === key ? `2px solid ${C.accent}` : '2px solid transparent',
      color: tab === key ? C.accent : C.sub, transition: 'all .2s',
    }}>{label}</button>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: '0 0 60px 0' }}>
      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: C.text }}>Daily Reports</h1>
        <p style={{ margin: '4px 0 0', fontSize: 14, color: C.sub }}>Health Ops team reporting — replaces individual Google Sheets tabs</p>
      </div>

      {/* Tabs */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 32px', display: 'flex' }}>
        {tabBtn('form', '📝 Submit Report')}
        {tabBtn('history', '🕐 History')}
        {tabBtn('team', '👥 Team View')}
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 32px' }}>

        {/* FORM TAB */}
        {tab === 'form' && (
          <div style={{ maxWidth: 720 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 16 }}>Report Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={labelStyle}>Team Member</label>
                  <select value={selectedMember} onChange={e => setSelectedMember(e.target.value)} style={{ ...inputStyle }}>
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

            {METRIC_GROUPS.map(group => (
              <MetricGroup key={group.category} group={group} metrics={metrics} onChange={handleMetricChange} />
            ))}

            <div style={cardStyle}>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Tasks Completed</label>
                <textarea value={tasksCompleted} onChange={e => setTasksCompleted(e.target.value)} rows={3}
                  placeholder="List the tasks you completed today…"
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
              <div>
                <label style={labelStyle}>Notes / Blockers</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  placeholder="Any blockers, observations, or notes for the team…"
                  style={{ ...inputStyle, resize: 'vertical' }} />
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
                <button onClick={handleSave} disabled={saving || !selectedMember} style={{
                  padding: '10px 24px', background: C.accent, color: '#0B0F1A', border: 'none',
                  borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: saving || !selectedMember ? 'not-allowed' : 'pointer',
                  opacity: saving || !selectedMember ? 0.5 : 1,
                }}>
                  {saving ? 'Saving…' : '💾 Save Report'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* HISTORY TAB */}
        {tab === 'history' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={labelStyle}>Filter by person</label>
                <select value={historyFilter.person} onChange={e => setHistoryFilter(f => ({ ...f, person: e.target.value }))} style={{ ...inputStyle, width: 'auto' }}>
                  <option value="">All members</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Filter by date</label>
                <input type="date" value={historyFilter.date} onChange={e => setHistoryFilter(f => ({ ...f, date: e.target.value }))} style={{ ...inputStyle, width: 'auto' }} />
              </div>
              <button onClick={loadHistory} style={{ padding: '8px 20px', background: C.accent, color: '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Apply</button>
              <button onClick={() => setHistoryFilter({ person: '', date: '' })} style={{ padding: '8px 20px', background: C.elevated, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Clear</button>
            </div>

            {loadingReports ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading reports…</div>
            ) : reports.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports found. Try adjusting filters.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                {reports.map(r => <ReportCard key={r.id} report={r} onSendSlack={handleSendSlack} />)}
              </div>
            )}
          </div>
        )}

        {/* TEAM VIEW TAB */}
        {tab === 'team' && (
          <div>
            <div style={{ ...cardStyle, display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div>
                <label style={labelStyle}>View date</label>
                <input type="date" value={teamDate} onChange={e => setTeamDate(e.target.value)} style={{ ...inputStyle, width: 'auto' }} />
              </div>
            </div>

            {loadingTeam ? (
              <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading…</div>
            ) : (
              <>
                <div style={cardStyle}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>
                    Submitted for {new Date(teamDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {teamMembers.map(m => {
                      const submitted = teamReports.some(r => r.team_member_id === m.id);
                      return (
                        <span key={m.id} style={{
                          padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                          background: submitted ? '#00E5A022' : C.elevated,
                          color: submitted ? C.accent : C.muted,
                          border: `1px solid ${submitted ? C.accent + '44' : C.border}`,
                        }}>
                          {submitted ? '✓' : '○'} {m.name}
                        </span>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 13, color: C.sub, marginTop: 12 }}>
                    {teamReports.length} of {teamMembers.length} submitted
                  </div>
                </div>

                {teamReports.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                    {teamReports.map(r => <ReportCard key={r.id} report={r} onSendSlack={handleSendSlack} />)}
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
