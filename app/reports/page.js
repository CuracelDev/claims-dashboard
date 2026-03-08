'use client';
import { useState, useEffect, useCallback } from 'react';

// ─── Metric config (mirrors metric_definitions table) ───────────────────────
const METRIC_GROUPS = [
  {
    category: 'mapping_data',
    label: '📦 Mapping & Data',
    color: 'blue',
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
    color: 'purple',
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
    color: 'green',
    metrics: [
      { key: 'auto_pa_reviewed',    label: 'Auto PA Reviewed' },
      { key: 'auto_pa_approved',    label: 'Auto PA Approved' },
      { key: 'flagged_care_items',  label: 'Flagged Care Items' },
      { key: 'icd10_adjusted',      label: 'ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up',     label: 'Benefits Set Up' },
      { key: 'providers_assigned',  label: 'Providers Assigned' },
    ],
  },
];

const COLOR = {
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-200',   header: 'bg-blue-100 text-blue-800'   },
  purple: { bg: 'bg-purple-50', border: 'border-purple-200', header: 'bg-purple-100 text-purple-800' },
  green:  { bg: 'bg-green-50',  border: 'border-green-200',  header: 'bg-green-100 text-green-800'  },
};

const today = () => new Date().toISOString().split('T')[0];

// ─── Helpers ────────────────────────────────────────────────────────────────
function MetricGroup({ group, metrics, onChange }) {
  const c = COLOR[group.color];
  return (
    <div className={`rounded-lg border ${c.border} overflow-hidden mb-4`}>
      <div className={`px-4 py-2 font-semibold text-sm ${c.header}`}>{group.label}</div>
      <div className={`${c.bg} p-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4`}>
        {group.metrics.map(m => (
          <div key={m.key}>
            <label className="block text-xs text-gray-500 mb-1">{m.label}</label>
            <input
              type="number"
              min="0"
              value={metrics[m.key] ?? ''}
              onChange={e => onChange(m.key, e.target.value)}
              placeholder="0"
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
  const allMetrics = Object.entries(report.metrics || {}).filter(([, v]) => v !== '' && v !== null);

  const handleSend = async () => {
    setSending(true);
    await onSendSlack(report);
    setSending(false);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="font-semibold text-gray-800">{report.team_members?.name}</span>
          <span className="ml-2 text-xs text-gray-500">{date}</span>
        </div>
        <div className="flex items-center gap-2">
          {report.sent_to_slack && (
            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">✓ Sent</span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            report.status === 'submitted' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
          }`}>{report.status}</span>
        </div>
      </div>

      {allMetrics.length > 0 && (
        <div className="grid grid-cols-3 gap-1 mb-3">
          {allMetrics.slice(0, 9).map(([key, val]) => {
            const label = METRIC_GROUPS.flatMap(g => g.metrics).find(m => m.key === key)?.label || key;
            return (
              <div key={key} className="text-xs bg-gray-50 rounded px-2 py-1">
                <span className="text-gray-500">{label}: </span>
                <span className="font-semibold text-gray-800">{val}</span>
              </div>
            );
          })}
          {allMetrics.length > 9 && (
            <div className="text-xs text-gray-400 px-2 py-1">+{allMetrics.length - 9} more</div>
          )}
        </div>
      )}

      {report.tasks_completed && (
        <p className="text-xs text-gray-600 mb-2 line-clamp-2">
          <span className="font-medium">Tasks: </span>{report.tasks_completed}
        </p>
      )}

      <button
        onClick={handleSend}
        disabled={sending || report.sent_to_slack}
        className={`text-xs px-3 py-1 rounded transition-colors ${
          report.sent_to_slack
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-[#4A154B] text-white hover:bg-[#3a0f3b] cursor-pointer'
        }`}
      >
        {sending ? 'Sending…' : report.sent_to_slack ? 'Sent to Slack' : '📤 Send to Slack'}
      </button>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const [tab, setTab] = useState('form'); // 'form' | 'history' | 'team'

  // Form state
  const [teamMembers, setTeamMembers] = useState([]);
  const [selectedMember, setSelectedMember] = useState('');
  const [reportDate, setReportDate] = useState(today());
  const [metrics, setMetrics] = useState({});
  const [tasksCompleted, setTasksCompleted] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  // History state
  const [reports, setReports] = useState([]);
  const [historyFilter, setHistoryFilter] = useState({ person: '', date: '' });
  const [loadingReports, setLoadingReports] = useState(false);

  // Team view state
  const [teamDate, setTeamDate] = useState(today());
  const [teamReports, setTeamReports] = useState([]);
  const [loadingTeam, setLoadingTeam] = useState(false);

  // Load team members
  useEffect(() => {
    fetch('/api/team')
      .then(r => r.json())
      .then(({ data }) => setTeamMembers(data || []));
  }, []);

  // Load report for selected member+date (to prefill form if editing)
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
          setMetrics({});
          setTasksCompleted('');
          setNotes('');
        }
      });
  }, [selectedMember, reportDate]);

  // Load history
  const loadHistory = useCallback(() => {
    setLoadingReports(true);
    const params = new URLSearchParams({ limit: '30' });
    if (historyFilter.person) params.set('person_id', historyFilter.person);
    if (historyFilter.date) params.set('date', historyFilter.date);
    fetch(`/api/reports?${params}`)
      .then(r => r.json())
      .then(({ data }) => { setReports(data || []); setLoadingReports(false); });
  }, [historyFilter]);

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  // Load team-day view
  useEffect(() => {
    if (tab !== 'team') return;
    setLoadingTeam(true);
    fetch(`/api/reports?date=${teamDate}&limit=20`)
      .then(r => r.json())
      .then(({ data }) => { setTeamReports(data || []); setLoadingTeam(false); });
  }, [tab, teamDate]);

  const handleMetricChange = (key, val) => {
    setMetrics(prev => ({ ...prev, [key]: val }));
  };

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
        }),
      });
      const { data, error } = await res.json();
      if (error) throw new Error(error);
      setSaveMsg({ type: 'success', text: `Report saved for ${new Date(reportDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}` });
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

      // Update sent status in DB
      await fetch('/api/reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: report.id,
          sent_to_slack: true,
          slack_channel: result.channel,
          sent_at: result.sent_at,
        }),
      });

      // Refresh
      loadHistory();
      alert('Report sent to Slack!');
    } catch (err) {
      alert(`Slack send failed: ${err.message}`);
    }
  };

  const totalOutput = Object.values(metrics)
    .map(v => parseInt(v))
    .filter(n => !isNaN(n))
    .reduce((a, b) => a + b, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">Daily Reports</h1>
          <p className="text-sm text-gray-500 mt-0.5">Health Ops team reporting — replaces individual Google Sheets tabs</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-6xl mx-auto flex gap-0">
          {[
            { key: 'form',    label: '📝 Submit Report' },
            { key: 'history', label: '🕐 History' },
            { key: 'team',    label: '👥 Team View' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">

        {/* ── FORM TAB ─────────────────────────────────────────────── */}
        {tab === 'form' && (
          <div className="max-w-3xl">
            {/* Person + Date */}
            <div className="bg-white rounded-lg border border-gray-200 p-5 mb-5">
              <h2 className="font-semibold text-gray-800 mb-4">Report Details</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Team Member</label>
                  <select
                    value={selectedMember}
                    onChange={e => setSelectedMember(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select member…</option>
                    {teamMembers.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Report Date</label>
                  <input
                    type="date"
                    value={reportDate}
                    onChange={e => setReportDate(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            {/* Metric Groups */}
            {METRIC_GROUPS.map(group => (
              <MetricGroup key={group.category} group={group} metrics={metrics} onChange={handleMetricChange} />
            ))}

            {/* Tasks + Notes */}
            <div className="bg-white rounded-lg border border-gray-200 p-5 mb-5">
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Tasks Completed</label>
                <textarea
                  value={tasksCompleted}
                  onChange={e => setTasksCompleted(e.target.value)}
                  rows={3}
                  placeholder="List the tasks you completed today…"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes / Blockers</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Any blockers, observations, or notes for the team…"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>
            </div>

            {/* Footer: total + save */}
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Total output today: <span className="font-bold text-gray-800 text-base">{totalOutput}</span>
              </div>
              <div className="flex items-center gap-3">
                {saveMsg && (
                  <span className={`text-sm ${saveMsg.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                    {saveMsg.type === 'success' ? '✓' : '✗'} {saveMsg.text}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !selectedMember}
                  className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? 'Saving…' : '💾 Save Report'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── HISTORY TAB ──────────────────────────────────────────── */}
        {tab === 'history' && (
          <div>
            {/* Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-5 flex gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Filter by person</label>
                <select
                  value={historyFilter.person}
                  onChange={e => setHistoryFilter(f => ({ ...f, person: e.target.value }))}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All members</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Filter by date</label>
                <input
                  type="date"
                  value={historyFilter.date}
                  onChange={e => setHistoryFilter(f => ({ ...f, date: e.target.value }))}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                onClick={loadHistory}
                className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-900"
              >
                Apply
              </button>
              <button
                onClick={() => { setHistoryFilter({ person: '', date: '' }); }}
                className="px-4 py-2 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50"
              >
                Clear
              </button>
            </div>

            {loadingReports ? (
              <div className="text-center py-12 text-gray-400">Loading reports…</div>
            ) : reports.length === 0 ? (
              <div className="text-center py-12 text-gray-400">No reports found. Try adjusting filters.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {reports.map(r => (
                  <ReportCard key={r.id} report={r} onSendSlack={handleSendSlack} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TEAM VIEW TAB ─────────────────────────────────────────── */}
        {tab === 'team' && (
          <div>
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-5 flex gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">View date</label>
                <input
                  type="date"
                  value={teamDate}
                  onChange={e => setTeamDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {loadingTeam ? (
              <div className="text-center py-12 text-gray-400">Loading…</div>
            ) : (
              <>
                {/* Who has reported */}
                <div className="bg-white rounded-lg border border-gray-200 p-5 mb-5">
                  <h3 className="font-semibold text-gray-800 mb-3">
                    Submitted for {new Date(teamDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {teamMembers.map(m => {
                      const submitted = teamReports.some(r => r.team_member_id === m.id);
                      return (
                        <span key={m.id} className={`px-3 py-1 rounded-full text-sm font-medium ${
                          submitted ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {submitted ? '✓' : '○'} {m.name}
                        </span>
                      );
                    })}
                  </div>
                  <p className="text-sm text-gray-500 mt-3">
                    {teamReports.length} of {teamMembers.length} submitted
                  </p>
                </div>

                {/* Report cards */}
                {teamReports.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {teamReports.map(r => (
                      <ReportCard key={r.id} report={r} onSendSlack={handleSendSlack} />
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-400">No reports for this date yet.</div>
                )}
              </>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
