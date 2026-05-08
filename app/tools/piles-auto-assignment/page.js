'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { getMemberName } from '../../lib/auth';

const ROLE_OPTIONS = [
  { value: 'primary', label: 'Primary' },
  { value: 'support', label: 'Support' },
  { value: 'admin', label: 'Admin / All Insurers' },
];

const DISTRIBUTION_MODE_OPTIONS = [
  {
    value: 'balanced_finish',
    label: 'Balanced finish',
    description: 'Spread new piles across eligible bots so everyone is projected to finish around the same time based on speed and current load.',
  },
  {
    value: 'single_owner',
    label: 'Single owner',
    description: 'Keep new work with the primary owner for that insurer unless you manually move the ownership elsewhere.',
  },
  {
    value: 'manual_override',
    label: 'Manual override',
    description: 'Use your manual owner/availability changes as the main guide and avoid automatic balancing decisions for that insurer.',
  },
];

const DEFAULT_RULE_DRAFT = {
  id: '',
  master_account_id: '',
  insurer_name: '',
  minimum_claim_chunk: 25,
  reassignment_threshold_minutes: 120,
  stale_claim_threshold: 40,
  target_completion_gap_minutes: 30,
  distribution_mode: 'balanced_finish',
  notes: '',
};

const MONTH_OPTIONS = ['All', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OWNER_DISPLAY_ORDER = ['Muyiwa', 'Sophie', 'Morenike', 'Emmanuel', 'Daniel'];

const cardStyle = (C) => ({
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  padding: 20,
});

const inputStyle = (C) => ({
  background: C.inputBg,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  color: C.text,
  fontSize: 13,
  padding: '9px 12px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
});

function EmptyState({ C, title, text }) {
  return (
    <div style={{ padding: '24px 18px', borderRadius: 12, border: `1px dashed ${C.border}`, color: C.sub, fontSize: 13, textAlign: 'center' }}>
      <div style={{ color: C.text, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div>{text}</div>
    </div>
  );
}

function StatCard({ C, label, value, hint }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '18px 20px', minWidth: 160, flex: 1 }}>
      <div style={{ color: C.sub, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{label}</div>
      <div style={{ color: C.text, fontSize: 24, fontWeight: 700, marginBottom: 4 }}>{value}</div>
      <div style={{ color: C.muted, fontSize: 12 }}>{hint}</div>
    </div>
  );
}

function SectionHeader({ C, icon, title, text }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <div style={{ color: C.text, fontSize: 16, fontWeight: 700 }}>{title}</div>
      </div>
      <div style={{ color: C.sub, fontSize: 13 }}>{text}</div>
    </div>
  );
}

function toDateInputValue(date) {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sameDay(dateA, dateB) {
  if (!(dateA instanceof Date) || Number.isNaN(dateA.getTime())) return false;
  if (!(dateB instanceof Date) || Number.isNaN(dateB.getTime())) return false;
  return (
    dateA.getFullYear() === dateB.getFullYear()
    && dateA.getMonth() === dateB.getMonth()
    && dateA.getDate() === dateB.getDate()
  );
}

function buildActivityRange(scope, selectedDay) {
  if (scope === 'all') return null;
  const baseDate = scope === 'today'
    ? new Date()
    : scope === 'yesterday'
      ? new Date(Date.now() - (24 * 60 * 60 * 1000))
      : new Date(selectedDay);
  if (Number.isNaN(baseDate.getTime())) return null;
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function formatProjectedFinish(row) {
  const explicitMinutes = Number(row?.projected_finish_minutes);
  const minutes = Number.isFinite(explicitMinutes)
    ? explicitMinutes
    : Math.max(0, Math.ceil((Number(row?.projected_finish_hours) || 0) * 60));
  return `${minutes} mins`;
}

function formatDateTime(dateValue) {
  if (!dateValue) return '—';
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('en-GB');
}

function formatTrackedState(row) {
  if (!row) return 'unknown';
  if (row.completed_at || row.is_active === false) return 'completed';
  if (row.is_stale) return 'stale';
  return 'active';
}

function formatRunnerRunResult(run) {
  if (!run) return 'No run output yet.';
  const details = run.details || {};
  const isRunning = run.status === 'started' && !run.finished_at;
  const lines = [
    `Run scope: ${run.run_scope === 'all-active' ? 'All active insurers' : (run.insurer_name || 'One insurer')}`,
    `Portal: ${run.portal_environment || 'production'}`,
    `Mode: ${run.mode === 'execute' ? 'Execute' : 'Preview'}`,
    `Status: ${isRunning ? 'in progress' : (run.status || 'completed')}`,
  ];
  if (Array.isArray(run.months) && run.months.length) {
    lines.push(`Month(s): ${run.months.sort(compareMonthLabels).join(', ')}`);
  }
  if (run.year) {
    lines.push(`Year: ${run.year}`);
  }
  if (run.started_at) {
    lines.push(`Started: ${new Date(run.started_at).toLocaleString('en-GB')}`);
  }
  if (run.finished_at) {
    lines.push(`Finished: ${new Date(run.finished_at).toLocaleString('en-GB')}`);
  }
  if (details?.error) {
    lines.push(`Error: ${details.error}`);
  }
  if (run.stdout) return run.stdout;
  if (run.stderr) return run.stderr;
  return lines.join('\n');
}

function buildRunnerOutputFallback(logs) {
  const latest = (logs || []).find((log) => log.event_type === 'runner_complete');
  if (!latest) return '';
  const details = latest.details || {};
  const capturedAt = details.finished_at || details.captured_at || latest.created_at;
  const insurer = details.insurer_name || latest.insurer_name || 'Unknown insurer';
  const mode = details.mode === 'execute' ? 'EXECUTE' : 'DRY RUN';
  const months = Array.isArray(details.months) ? details.months.join(', ') : details.month || '—';
  const lines = [
    'Last recorded runner completion',
    `Insurer: ${insurer}`,
    `Mode: ${mode}`,
    `Month(s): ${months}`,
    `Time: ${capturedAt ? new Date(capturedAt).toLocaleString('en-GB') : '—'}`,
  ];
  if (details.no_work) {
    lines.push('Result: No unassigned piles found. Nothing to assign.');
  } else if (details.summary && typeof details.summary === 'object') {
    const summaryRows = Object.values(details.summary);
    const totalPiles = summaryRows.reduce((sum, row) => sum + Number(row?.assigned_piles || 0), 0);
    const totalClaims = summaryRows.reduce((sum, row) => sum + Number(row?.assigned_claims || 0), 0);
    lines.push(`Result: ${totalPiles} pile(s), ${totalClaims} claim(s) in the latest plan.`);
  }
  return lines.join('\n');
}

function formatRunnerStatus(run) {
  const isRunning = run?.status === 'started' && !run?.finished_at;
  if (isRunning) return 'in progress';
  return run?.status || 'completed';
}

function formatRunnerDuration(run, nowTs = Date.now()) {
  if (!run) return '—';
  if (run.finished_at && Number(run.duration_ms) > 0) {
    return `${Math.max(1, Math.round(Number(run.duration_ms) / 1000))}s`;
  }
  if (run.status === 'started' && run.started_at) {
    const elapsedMs = Math.max(0, nowTs - new Date(run.started_at).getTime());
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
    return `${elapsedSec}s live`;
  }
  if (Number(run.duration_ms) === 0) return '0s';
  return '—';
}

function formatBackendLabel(backend) {
  if (backend === 'remote') return 'remote worker';
  return 'server';
}

function normKeyClient(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ownerDisplayRank(name) {
  const index = OWNER_DISPLAY_ORDER.indexOf(String(name || '').trim());
  return index === -1 ? OWNER_DISPLAY_ORDER.length + 1 : index;
}

function compareBotRows(a, b) {
  const insurerCompare = String(a?.insurer_name || '').localeCompare(String(b?.insurer_name || ''));
  if (insurerCompare !== 0) return insurerCompare;
  const ownerRank = ownerDisplayRank(a?.owner_name) - ownerDisplayRank(b?.owner_name);
  if (ownerRank !== 0) return ownerRank;
  return String(a?.owner_name || '').localeCompare(String(b?.owner_name || ''));
}

function compareMonthLabels(a, b) {
  return MONTH_OPTIONS.indexOf(a) - MONTH_OPTIONS.indexOf(b);
}

function SaveBanner({ C, notice }) {
  if (!notice) return null;
  return (
    <div style={{ background: notice.type === 'error' ? '#EF444418' : '#00E5A012', border: `1px solid ${notice.type === 'error' ? '#EF444444' : '#00E5A040'}`, borderRadius: 10, padding: '12px 14px', color: notice.type === 'error' ? C.danger : C.accent, fontSize: 13, marginBottom: 18 }}>
      {notice.text}
    </div>
  );
}

function RunnerControlSection({ C, masterAccounts, onRefresh, onRunnerFinished, setNotice, runnerState, setRunnerState, runnerOutputFallback }) {
  const [running, setRunning] = useState(false);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const monthPickerRef = useRef(null);
  const currentMonthLabel = new Date().toLocaleString('en-US', { month: 'short' });
  const [draft, setDraft] = useState({
    portal_environment: 'production',
    target: 'single',
    insurer_name: masterAccounts[0]?.insurer_name || '',
    months: [currentMonthLabel],
    year: String(new Date().getFullYear()),
    finalize_assignments: false,
    visible_browser: false,
  });

  useEffect(() => {
    if (draft.target === 'single' && !draft.insurer_name && masterAccounts.length) {
      setDraft((prev) => ({ ...prev, insurer_name: masterAccounts[0].insurer_name }));
    }
  }, [draft.target, draft.insurer_name, masterAccounts]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (monthPickerRef.current && !monthPickerRef.current.contains(event.target)) {
        setMonthPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function runFlow() {
    if (draft.target === 'single' && !draft.insurer_name) {
      setNotice({ type: 'error', text: 'Choose an insurer before starting the runner.' });
      return;
    }
    setRunning(true);
    setRunnerState({ runOutput: '', runMeta: null });
    try {
      const payload = {
        portal_environment: draft.portal_environment,
        run_all: draft.target === 'all',
        insurer_name: draft.target === 'single' ? draft.insurer_name : '',
        months: draft.months,
        year: draft.year,
        finalize_assignments: draft.finalize_assignments,
        visible_browser: draft.visible_browser,
      };
      const res = await fetch('/api/tools/piles-auto-assignment/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      const combinedOutput = [json.stdout, json.stderr].filter(Boolean).join('\n').trim();
      setRunnerState({
        runMeta: json,
        runOutput: combinedOutput || `Run finished with status: ${json.success ? 'Completed' : 'Failed'}`,
      });
      if (!json.success) throw new Error(json.error || json.stderr || 'Runner failed.');
      setNotice({
        type: 'success',
        text: draft.finalize_assignments
          ? `Runner completed on the ${draft.portal_environment} portal with final assignment enabled.`
          : `Runner completed on the ${draft.portal_environment} portal in preview mode, so it stopped before the final Assign Claims click.`,
      });
      onRefresh();
      onRunnerFinished?.();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
      onRunnerFinished?.();
    } finally {
      setRunning(false);
    }
  }

  function updateMonths(selection) {
    const values = selection.length ? [...selection].sort(compareMonthLabels) : ['All'];
    if (values.includes('All')) {
      setDraft((prev) => ({ ...prev, months: ['All'] }));
      return;
    }
    setDraft((prev) => ({ ...prev, months: values }));
  }

  function toggleMonth(month) {
    if (month === 'All') {
      updateMonths(['All']);
      return;
    }
    const current = draft.months.includes('All') ? [] : draft.months;
    const next = current.includes(month)
      ? current.filter((item) => item !== month)
      : [...current, month];
    updateMonths(next);
  }

  const selectedMonthsLabel = draft.months.join(', ');

  return (
    <div style={cardStyle(C)}>
      <SectionHeader
        C={C}
        icon="▶️"
        title="Runner Control"
        text="Manually trigger one insurer or the full active-insurer loop. Safe mode goes through login, scan, planning, modal opening, and user selection, but stops before the final Assign Claims click."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 0.9fr 1.2fr 1fr 0.8fr', gap: 12, marginBottom: 12 }}>
        <select value={draft.portal_environment} onChange={(e) => setDraft((prev) => ({ ...prev, portal_environment: e.target.value }))} style={inputStyle(C)}>
          <option value="production">Production portal</option>
          <option value="test">Test portal</option>
        </select>
        <select value={draft.target} onChange={(e) => setDraft((prev) => ({ ...prev, target: e.target.value }))} style={inputStyle(C)}>
          <option value="single">One insurer</option>
          <option value="all">All active insurers</option>
        </select>
        <select value={draft.insurer_name} onChange={(e) => setDraft((prev) => ({ ...prev, insurer_name: e.target.value }))} style={inputStyle(C)} disabled={draft.target !== 'single'}>
          <option value="">Select insurer</option>
          {masterAccounts.map((account) => (
            <option key={account.id} value={account.insurer_name}>{account.insurer_name}</option>
          ))}
        </select>
        <div ref={monthPickerRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setMonthPickerOpen((prev) => !prev)}
            style={{
              ...inputStyle(C),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ color: selectedMonthsLabel ? C.text : C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selectedMonthsLabel || 'Select month(s)'}
            </span>
            <span style={{ color: C.sub, marginLeft: 12, flexShrink: 0 }}>{monthPickerOpen ? '▴' : '▾'}</span>
          </button>
          {monthPickerOpen && (
            <div style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              left: 0,
              right: 0,
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              padding: 8,
              boxShadow: '0 12px 30px rgba(0,0,0,0.22)',
              zIndex: 20,
              maxHeight: 260,
              overflowY: 'auto',
            }}>
              {MONTH_OPTIONS.map((month) => {
                const checked = draft.months.includes(month);
                return (
                  <label
                    key={month}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '9px 10px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      color: C.text,
                      fontSize: 13,
                      background: checked ? C.elevated : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMonth(month)}
                    />
                    <span>{month}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <input value={draft.year} onChange={(e) => setDraft((prev) => ({ ...prev, year: e.target.value }))} placeholder="Year" style={inputStyle(C)} />
      </div>
      <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', color: C.sub, fontSize: 12, marginBottom: 16 }}>
        Months selected: <span style={{ color: C.text, fontWeight: 700 }}>{selectedMonthsLabel}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
        <label style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', color: C.text, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={draft.finalize_assignments}
            onChange={(e) => setDraft((prev) => ({ ...prev, finalize_assignments: e.target.checked }))}
          />
          Finalize assignments
        </label>
        <label style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', color: C.text, fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={draft.visible_browser}
            onChange={(e) => setDraft((prev) => ({ ...prev, visible_browser: e.target.checked }))}
          />
          Visible browser
        </label>
        <button
          onClick={runFlow}
          disabled={running}
          style={{ background: running ? C.muted : C.accent, color: running ? C.sub : '#0B0F1A', border: 'none', borderRadius: 10, fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer' }}
        >
          {running ? 'Running...' : 'Start Runner'}
        </button>
      </div>
      <div style={{ background: draft.finalize_assignments ? '#FFB84D14' : '#00E5A012', border: `1px solid ${draft.finalize_assignments ? '#FFB84D44' : '#00E5A040'}`, borderRadius: 10, padding: '12px 14px', color: draft.finalize_assignments ? C.warn : C.accent, fontSize: 12, marginBottom: 16, lineHeight: 1.6 }}>
        {draft.finalize_assignments
          ? draft.portal_environment === 'production'
            ? 'Final assignment is enabled on the production portal. This still depends on the runner safety gate and should only be used intentionally.'
            : 'Final assignment is enabled on the test portal.'
          : `Preview mode is active on the ${draft.portal_environment} portal. The runner will stop before the final Assign Claims click.`}
      </div>
      {runnerState.runMeta && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 12, color: C.sub, fontSize: 12 }}>
          <div>Duration: <span style={{ color: C.text }}>{Math.round((runnerState.runMeta.duration_ms || 0) / 1000)}s</span></div>
          <div>Status: <span style={{ color: runnerState.runMeta.success ? C.accent : C.danger }}>{runnerState.runMeta.success ? 'Completed' : 'Failed'}</span></div>
          <div>Backend: <span style={{ color: C.text }}>{formatBackendLabel(runnerState.runMeta.backend)}</span></div>
        </div>
      )}
      <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ color: C.sub, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Runner Output</div>
        <pre style={{ margin: 0, color: C.text, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          {runnerState.runOutput || runnerOutputFallback || 'No run output yet.'}
        </pre>
      </div>
    </div>
  );
}

function RunnerHistorySection({ C, refreshToken }) {
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('today');
  const [selectedDay, setSelectedDay] = useState(toDateInputValue(new Date()));
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());

  useEffect(() => {
    let active = true;
    async function loadRuns() {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/tools/piles-auto-assignment/runner-runs?limit=150', { cache: 'no-store' });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed to load runner history.');
        if (!active) return;
        setRuns(json.runs || []);
      } catch (loadError) {
        if (!active) return;
        setError(loadError.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadRuns();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const hasActiveRun = useMemo(
    () => runs.some((run) => run.status === 'started' && !run.finished_at),
    [runs],
  );

  useEffect(() => {
    if (!hasActiveRun) return undefined;
    const interval = window.setInterval(() => {
      setNowTs(Date.now());
    }, 5000);
    return () => window.clearInterval(interval);
  }, [hasActiveRun]);

  const filteredRuns = useMemo(() => {
    const sorted = [...runs].sort((a, b) => new Date(b.finished_at || b.started_at || 0).getTime() - new Date(a.finished_at || a.started_at || 0).getTime());
    if (scope === 'all') return sorted;
    const baseDate = scope === 'today'
      ? new Date()
      : scope === 'yesterday'
        ? new Date(Date.now() - (24 * 60 * 60 * 1000))
        : new Date(selectedDay);
    return sorted.filter((run) => sameDay(new Date(run.finished_at || run.started_at), baseDate));
  }, [runs, scope, selectedDay]);

  return (
    <div style={cardStyle(C)}>
      <SectionHeader
        C={C}
        icon="📜"
        title="Runner History"
        text="Full runner history for manual and scheduled executions. Use this to inspect the exact output, timing, and outcome of previous runs."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr', gap: 12, marginBottom: 16 }}>
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={inputStyle(C)}>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="custom">Pick a day</option>
          <option value="all">All time</option>
        </select>
        {scope === 'custom' ? (
          <input type="date" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} style={inputStyle(C)} />
        ) : (
          <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', color: C.sub, fontSize: 12, display: 'flex', alignItems: 'center' }}>
            {scope === 'all' ? 'Showing all recorded runner executions.' : 'Showing the latest runner executions for the selected day.'}
          </div>
        )}
      </div>
      {loading ? (
        <div style={{ color: C.sub, fontSize: 13 }}>Loading runner history…</div>
      ) : error ? (
        <div style={{ color: C.danger, fontSize: 13 }}>{error}</div>
      ) : !filteredRuns.length ? (
        <EmptyState C={C} title="No runner executions for this filter" text="Once manual or scheduled runs happen, their full output will be available here for the selected day." />
      ) : (
        <div style={{ maxHeight: 540, overflowY: 'auto', display: 'grid', gap: 12 }}>
          {filteredRuns.map((run) => {
            const eventTime = run.finished_at || run.started_at;
            const months = Array.isArray(run.months) ? [...run.months].sort(compareMonthLabels).join(', ') : (run.months || '—');
            const stdout = String(run.stdout || '').trim();
            const stderr = String(run.stderr || '').trim();
            const fallbackText = formatRunnerRunResult(run);
            const isRunning = run.status === 'started' && !run.finished_at;
            const statusText = formatRunnerStatus(run);
            const durationText = formatRunnerDuration(run, nowTs);
            return (
              <details key={run.id} open={isRunning} style={{ background: C.elevated, border: `1px solid ${isRunning ? C.accent : C.border}`, boxShadow: isRunning ? `0 0 0 1px ${C.accent}33 inset` : 'none', borderRadius: 12, padding: '14px 16px' }}>
                <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.9fr 0.9fr 0.8fr 1fr', gap: 12, alignItems: 'center' }}>
                    <div>
                      <div style={{ color: C.text, fontSize: 14, fontWeight: 700 }}>
                        {run.run_scope === 'all-active' ? 'All active insurers' : (run.insurer_name || 'One insurer')}
                      </div>
                      <div style={{ color: C.sub, fontSize: 12 }}>
                        {run.portal_environment || 'production'} portal · {run.run_source || 'manual'} · {formatBackendLabel(run.backend)}
                      </div>
                    </div>
                    <div style={{ color: C.text, fontSize: 13 }}>{run.mode === 'execute' ? 'Execute' : 'Preview'}</div>
                    <div style={{ color: run.status === 'failed' ? C.danger : C.accent, fontSize: 13, fontWeight: 700 }}>{statusText}</div>
                    <div style={{ color: C.text, fontSize: 13 }}>{durationText}</div>
                    <div style={{ color: C.muted, fontSize: 12 }}>{eventTime ? new Date(eventTime).toLocaleString('en-GB') : '—'}</div>
                  </div>
                </summary>
                <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
                  {isRunning && (
                    <div style={{ background: '#14B8A61A', border: '1px solid #14B8A644', borderRadius: 10, padding: '10px 12px', color: C.text, fontSize: 12 }}>
                      This run is still active. Duration and output will update after it finalizes.
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
                    <div style={{ color: C.sub, fontSize: 12 }}>Month(s): <span style={{ color: C.text, fontWeight: 700 }}>{months}</span></div>
                    <div style={{ color: C.sub, fontSize: 12 }}>Year: <span style={{ color: C.text, fontWeight: 700 }}>{run.year || '—'}</span></div>
                    <div style={{ color: C.sub, fontSize: 12 }}>Started: <span style={{ color: C.text, fontWeight: 700 }}>{run.started_at ? new Date(run.started_at).toLocaleString('en-GB') : '—'}</span></div>
                    <div style={{ color: C.sub, fontSize: 12 }}>{isRunning ? 'Elapsed' : 'Finished'}: <span style={{ color: C.text, fontWeight: 700 }}>{isRunning ? durationText : (run.finished_at ? new Date(run.finished_at).toLocaleString('en-GB') : '—')}</span></div>
                  </div>
                  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ color: C.sub, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Run Output</div>
                    <pre style={{ margin: 0, color: C.text, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {stdout || stderr || fallbackText}
                    </pre>
                  </div>
                  {stderr && stdout && (
                    <div style={{ background: '#EF444412', border: '1px solid #EF444444', borderRadius: 10, padding: '12px 14px' }}>
                      <div style={{ color: C.danger, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>stderr</div>
                      <pre style={{ margin: 0, color: C.text, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                        {stderr}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeamSlackSection({ C, members, onRefresh, setNotice }) {
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: '', role: 'Claims Ops', slack_user_id: '' });
  const [edits, setEdits] = useState({});

  async function addMember() {
    if (!draft.name.trim()) {
      setNotice({ type: 'error', text: 'Member name is required.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (data.collision) throw new Error(`Member already exists: ${data.collision.existing?.name || draft.name}`);
      if (data.error) throw new Error(data.error);
      setDraft({ name: '', role: 'Claims Ops', slack_user_id: '' });
      setNotice({ type: 'success', text: `${data.data.name} added for assignment notifications.` });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  async function saveMember(member) {
    const edit = edits[member.id];
    if (!edit) return;
    setUpdatingId(member.id);
    try {
      const res = await fetch('/api/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: member.id, ...edit }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setNotice({ type: 'success', text: `${data.data.name} updated.` });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[member.id];
        return next;
      });
      setEditingId(null);
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setUpdatingId(null);
    }
  }

  function startEditing(member) {
    setEditingId(member.id);
    setEdits((prev) => ({
      ...prev,
      [member.id]: prev[member.id] || {
        name: member.name || '',
        role: member.role || '',
        slack_user_id: member.slack_user_id || '',
      },
    }));
  }

  function cancelEditing(memberId) {
    setEditingId((current) => (current === memberId ? null : current));
    setEdits((prev) => {
      const next = { ...prev };
      delete next[memberId];
      return next;
    });
  }

  const missingSlack = members.filter((member) => !member.slack_user_id);

  return (
    <div style={cardStyle(C)}>
      <SectionHeader
        C={C}
        icon="👥"
        title="People & Slack IDs"
        text="Add new people here and maintain their Slack member IDs so assignment notifications can mention the right person in Slack."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr 1fr 0.8fr', gap: 12, marginBottom: 16 }}>
        <input value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} placeholder="Member name" style={inputStyle(C)} />
        <input value={draft.role} onChange={(e) => setDraft((prev) => ({ ...prev, role: e.target.value }))} placeholder="Role" style={inputStyle(C)} />
        <input value={draft.slack_user_id} onChange={(e) => setDraft((prev) => ({ ...prev, slack_user_id: e.target.value }))} placeholder="Slack user ID e.g. U0123ABCDE" style={inputStyle(C)} />
        <button onClick={addMember} disabled={saving} style={{ background: saving ? C.muted : C.accent, color: saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Saving...' : 'Add Person'}
        </button>
      </div>
      {missingSlack.length > 0 && (
        <div style={{ background: '#FFB84D15', border: '1px solid #FFB84D44', borderRadius: 10, padding: '12px 14px', color: C.sub, fontSize: 12, marginBottom: 16 }}>
          Missing Slack IDs: <span style={{ color: C.warn, fontWeight: 700 }}>{missingSlack.map((member) => member.name).join(', ')}</span>
        </div>
      )}
      {!members.length ? (
        <EmptyState C={C} title="No members found" text="Add the people that own or support insurers so the runner can map assignments back to Slack mentions." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Name', 'Role', 'Slack User ID', 'Status', 'Action'].map((label) => (
                  <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isEditing = editingId === member.id;
                const edit = edits[member.id] || {
                  name: member.name || '',
                  role: member.role || '',
                  slack_user_id: member.slack_user_id || '',
                };
                return (
                  <tr key={member.id}>
                    <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                      {isEditing ? (
                        <input value={edit.name} onChange={(e) => setEdits((prev) => ({ ...prev, [member.id]: { ...edit, name: e.target.value } }))} style={inputStyle(C)} />
                      ) : (
                        <div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{member.name || '—'}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                      {isEditing ? (
                        <input value={edit.role} onChange={(e) => setEdits((prev) => ({ ...prev, [member.id]: { ...edit, role: e.target.value } }))} style={inputStyle(C)} />
                      ) : (
                        <div style={{ color: C.text, fontSize: 13 }}>{member.role || '—'}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                      {isEditing ? (
                        <input value={edit.slack_user_id} onChange={(e) => setEdits((prev) => ({ ...prev, [member.id]: { ...edit, slack_user_id: e.target.value } }))} style={inputStyle(C)} />
                      ) : (
                        <div style={{ color: member.slack_user_id ? C.text : C.sub, fontSize: 13 }}>{member.slack_user_id || 'Missing'}</div>
                      )}
                    </td>
                    <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: edit.slack_user_id ? C.accent : C.warn }}>
                        {(isEditing ? edit.slack_user_id : member.slack_user_id) ? 'Ready for tagging' : 'Missing Slack ID'}
                      </span>
                    </td>
                    <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                      {isEditing ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => saveMember(member)} disabled={updatingId === member.id} style={{ background: updatingId === member.id ? C.muted : C.accent, color: updatingId === member.id ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: updatingId === member.id ? 'not-allowed' : 'pointer' }}>
                            {updatingId === member.id ? 'Saving...' : 'Save'}
                          </button>
                          <button onClick={() => cancelEditing(member.id)} disabled={updatingId === member.id} style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: updatingId === member.id ? 'not-allowed' : 'pointer' }}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => startEditing(member)} style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MasterAccountsSection({ C, accounts, onRefresh, setNotice }) {
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState({ insurer_name: '', login_email: '', login_password: '', notes: '' });

  function resetDraft() {
    setDraft({ insurer_name: '', login_email: '', login_password: '', notes: '' });
    setEditingId('');
  }

  function startEdit(account) {
    setEditingId(account.id);
    setDraft({
      insurer_name: account.insurer_name || '',
      login_email: account.login_email || '',
      login_password: account.login_password || '',
      notes: account.notes || '',
      is_active: account.is_active !== false,
    });
  }

  async function submit() {
    if (!draft.insurer_name.trim() || !draft.login_email.trim()) {
      setNotice({ type: 'error', text: 'Master account needs an insurer name and login email.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/tools/piles-auto-assignment/master-accounts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { id: editingId, ...draft } : draft),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save master account.');
      resetDraft();
      setNotice({ type: 'success', text: `Master account ${editingId ? 'updated' : 'saved'} for ${data.item.insurer_name}.` });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={cardStyle(C)}>
      <SectionHeader C={C} icon="🔑" title="Master Insurer Credentials" text="These are the primary insurer logins the runner will use to sign in and reach the piles screens." />
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 0.8fr', gap: 12, marginBottom: 16 }}>
        <input value={draft.insurer_name} onChange={(e) => setDraft((prev) => ({ ...prev, insurer_name: e.target.value }))} placeholder="Insurer name" style={inputStyle(C)} />
        <input value={draft.login_email} onChange={(e) => setDraft((prev) => ({ ...prev, login_email: e.target.value }))} placeholder="Login email" style={inputStyle(C)} />
        <input value={draft.login_password} onChange={(e) => setDraft((prev) => ({ ...prev, login_password: e.target.value }))} placeholder="Login password" style={inputStyle(C)} />
        <button onClick={submit} disabled={saving} style={{ background: saving ? C.muted : C.accent, color: saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving...' : editingId ? 'Save Changes' : 'Add Account'}</button>
      </div>
      <textarea value={draft.notes} onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Notes, access caveats, MFA reminders, or portal quirks" style={{ ...inputStyle(C), minHeight: 72, marginBottom: 18, resize: 'vertical' }} />
      {editingId && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <button onClick={resetDraft} style={{ background: 'transparent', color: C.sub, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
            Cancel Edit
          </button>
        </div>
      )}
      {!accounts.length ? (
        <EmptyState C={C} title="No master insurer accounts yet" text="Start by saving one insurer login. The dashboard will use these rows as the source of truth instead of the spreadsheet." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Insurer', 'Email', 'Password', 'Status', 'Last Update', 'Action'].map((label) => <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.insurer_name}</td>
                  <td style={{ color: C.sub, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.login_email}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.login_password || '—'}</td>
                  <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}><span style={{ fontSize: 11, fontWeight: 700, color: account.is_active ? C.accent : C.sub }}>{account.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td style={{ color: C.muted, fontSize: 12, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.last_password_update ? new Date(account.last_password_update).toLocaleString('en-GB') : 'Not updated yet'}</td>
                  <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                    <button onClick={() => startEdit(account)} style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BotAccountsSection({ C, accounts, masterAccounts, metricsByBotId, onRefresh, setNotice }) {
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState('');
  const formRef = useRef(null);
  const [draft, setDraft] = useState({
    master_account_id: '',
    insurer_name: '',
    owner_name: '',
    bot_name: '',
    bot_email: '',
    bot_password: '',
    assignment_role: 'primary',
    support_capacity_ratio: 1,
    availability_status: 'available',
    availability_note: '',
    priority_order: 100,
    current_claim_load: 0,
    notes: '',
  });

  function resetDraft() {
    setDraft({
      master_account_id: '',
      insurer_name: '',
      owner_name: '',
      bot_name: '',
      bot_email: '',
      bot_password: '',
      assignment_role: 'primary',
      support_capacity_ratio: 1,
      availability_status: 'available',
      availability_note: '',
      priority_order: 100,
      current_claim_load: 0,
      notes: '',
    });
    setEditingId('');
  }

  function onMasterChange(id) {
    const account = masterAccounts.find((item) => item.id === id);
    setDraft((prev) => ({ ...prev, master_account_id: id, insurer_name: account?.insurer_name || prev.insurer_name }));
  }

  function startEdit(account) {
    setEditingId(account.id);
    setDraft({
      master_account_id: account.master_account_id || '',
      insurer_name: account.insurer_name || '',
      owner_name: account.owner_name || '',
      bot_name: account.bot_name || '',
      bot_email: account.bot_email || '',
      bot_password: account.bot_password || '',
      assignment_role: account.assignment_role || 'primary',
      support_capacity_ratio: account.support_capacity_ratio ?? 1,
      availability_status: account.availability_status || 'available',
      availability_note: account.availability_note || '',
      priority_order: account.priority_order ?? 100,
      current_claim_load: account.current_claim_load ?? 0,
      notes: account.notes || '',
      is_active: account.is_active !== false,
      is_available: account.is_available !== false,
    });
    setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  async function submit() {
    if (!draft.insurer_name.trim() || !draft.owner_name.trim()) {
      setNotice({ type: 'error', text: 'Bot account needs an insurer name and owner name.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/tools/piles-auto-assignment/bot-accounts', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { id: editingId, ...draft } : draft),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save bot account.');
      resetDraft();
      setNotice({ type: 'success', text: `Bot account ${editingId ? 'updated' : 'saved'} for ${data.item.owner_name}.` });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  const groupedAccounts = useMemo(() => {
    const grouped = new Map();
    for (const account of accounts) {
      const key = account.insurer_name || 'Unassigned';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(account);
    }
    for (const [key, insurerAccounts] of grouped.entries()) {
      grouped.set(key, [...insurerAccounts].sort(compareBotRows));
    }
    return Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [accounts]);

  return (
    <div style={cardStyle(C)}>
      <SectionHeader C={C} icon="🤖" title="Bot Accounts" text="Each sub-bot represents one person who can receive piles. Claims-per-hour metrics will later drive proration across these rows." />
      <div ref={formRef} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <select value={draft.master_account_id} onChange={(e) => onMasterChange(e.target.value)} style={inputStyle(C)}>
          <option value="">Select master insurer</option>
          {masterAccounts.map((account) => <option key={account.id} value={account.id}>{account.insurer_name}</option>)}
        </select>
        <input value={draft.owner_name} onChange={(e) => setDraft((prev) => ({ ...prev, owner_name: e.target.value }))} placeholder="Owner name" style={inputStyle(C)} />
        <input value={draft.bot_name} onChange={(e) => setDraft((prev) => ({ ...prev, bot_name: e.target.value }))} placeholder="Bot display name" style={inputStyle(C)} />
        <input value={draft.bot_email} onChange={(e) => setDraft((prev) => ({ ...prev, bot_email: e.target.value }))} placeholder="Bot email" style={inputStyle(C)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 0.8fr', gap: 12, marginBottom: 12 }}>
        <input value={draft.insurer_name} onChange={(e) => setDraft((prev) => ({ ...prev, insurer_name: e.target.value }))} placeholder="Insurer name" style={inputStyle(C)} />
        <input value={draft.bot_password} onChange={(e) => setDraft((prev) => ({ ...prev, bot_password: e.target.value }))} placeholder="Bot password" style={inputStyle(C)} />
        <select value={draft.assignment_role} onChange={(e) => setDraft((prev) => ({ ...prev, assignment_role: e.target.value }))} style={inputStyle(C)}>
          {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input type="number" step="0.1" value={draft.support_capacity_ratio} onChange={(e) => setDraft((prev) => ({ ...prev, support_capacity_ratio: e.target.value }))} placeholder="Role weight" style={inputStyle(C)} />
        <select value={draft.availability_status} onChange={(e) => setDraft((prev) => ({ ...prev, availability_status: e.target.value, is_available: e.target.value === 'available' }))} style={inputStyle(C)}>
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="leave">On leave</option>
          <option value="paused">Paused</option>
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '0.8fr 0.8fr 1.2fr 0.8fr', gap: 12, marginBottom: 16 }}>
        <input type="number" value={draft.priority_order} onChange={(e) => setDraft((prev) => ({ ...prev, priority_order: e.target.value }))} placeholder="Priority" style={inputStyle(C)} />
        <input type="number" value={draft.current_claim_load} onChange={(e) => setDraft((prev) => ({ ...prev, current_claim_load: e.target.value }))} placeholder="Claim load" style={inputStyle(C)} />
        <input value={draft.availability_note} onChange={(e) => setDraft((prev) => ({ ...prev, availability_note: e.target.value }))} placeholder="Availability note or reassignment note" style={inputStyle(C)} />
        <button onClick={submit} disabled={saving} style={{ background: saving ? C.muted : C.accent, color: saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving...' : editingId ? 'Save Changes' : 'Add Bot'}</button>
      </div>
      <textarea value={draft.notes} onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Notes for shift ownership, fallback usage, or password caveats" style={{ ...inputStyle(C), minHeight: 72, marginBottom: 18, resize: 'vertical' }} />
      {editingId && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.elevated }}>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 700 }}>
            Editing: {draft.owner_name || 'Selected bot row'} {draft.bot_name ? `· ${draft.bot_name}` : ''}
          </div>
          <button onClick={resetDraft} style={{ background: 'transparent', color: C.sub, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
            Cancel Edit
          </button>
        </div>
      )}
      <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', color: C.sub, fontSize: 12, marginBottom: 18, lineHeight: 1.6 }}>
        `Primary` rows are the main owners for an insurer. `Support` rows are helpers and should receive less work; use `Role weight` to limit that share. If someone is unavailable, set their availability away from `Available` and move the primary responsibility to another row before the runner starts.
      </div>
      {!accounts.length ? (
        <EmptyState C={C} title="No bot accounts yet" text="Add the sub-bots under each insurer so the runner has explicit assignee targets." />
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {groupedAccounts.map(([insurerName, insurerAccounts]) => (
            <div key={insurerName} style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ color: C.text, fontSize: 15, fontWeight: 700 }}>{insurerName}</div>
                  <div style={{ color: C.sub, fontSize: 12, marginTop: 4 }}>
                    {insurerAccounts.length} bot row{insurerAccounts.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div style={{ color: C.muted, fontSize: 11 }}>
                  Primary first, then support/admin rows
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>{['Owner', 'Role', 'Weight', 'Bot Name', 'Claims/Hr', 'Current Load', 'Availability', 'Action'].map((label) => <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {insurerAccounts.map((account) => {
                      const metric = metricsByBotId[account.id];
                      return (
                        <tr key={account.id} style={editingId === account.id ? { background: C.card } : undefined}>
                          <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.owner_name}</td>
                          <td style={{ color: account.assignment_role === 'support' ? C.warn : C.accent, fontSize: 12, fontWeight: 700, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.assignment_role || 'primary'}</td>
                          <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.support_capacity_ratio ?? 1}</td>
                          <td style={{ color: C.sub, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{account.bot_name || '—'}</td>
                          <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric?.claims_per_hour ?? '—'}</td>
                          <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric?.active_claim_load ?? account.current_claim_load ?? 0}</td>
                          <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: account.is_active && account.is_available ? C.accent : C.warn }}>
                              {account.availability_status || (account.is_active && account.is_available ? 'available' : 'paused')}
                            </span>
                          </td>
                          <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                            <button onClick={() => startEdit(account)} style={{ background: editingId === account.id ? C.accent : C.card, color: editingId === account.id ? '#0B0F1A' : C.text, border: `1px solid ${editingId === account.id ? C.accent : C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
                              {editingId === account.id ? 'Editing' : 'Edit'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BotRoleEditorSection({ C, accounts, onRefresh, setNotice }) {
  const orderedAccounts = useMemo(() => [...accounts].sort(compareBotRows), [accounts]);
  const [selectedId, setSelectedId] = useState('');
  const [saving, setSaving] = useState(false);
  const selected = accounts.find((item) => item.id === selectedId) || null;
  const [draft, setDraft] = useState({
    assignment_role: 'primary',
    support_capacity_ratio: 1,
    availability_status: 'available',
    availability_note: '',
    current_claim_load: 0,
    notes: '',
  });

  useEffect(() => {
    if (!selected) return;
    setDraft({
      assignment_role: selected.assignment_role || 'primary',
      support_capacity_ratio: selected.support_capacity_ratio ?? 1,
      availability_status: selected.availability_status || 'available',
      availability_note: selected.availability_note || '',
      current_claim_load: selected.current_claim_load ?? 0,
      notes: selected.notes || '',
    });
  }, [selectedId]);

  async function save() {
    if (!selected) {
      setNotice({ type: 'error', text: 'Choose a bot row to edit first.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/tools/piles-auto-assignment/bot-accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selected.id,
          ...draft,
          is_available: draft.availability_status === 'available',
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to update bot role.');
      setNotice({ type: 'success', text: `${data.item.owner_name} updated for ${data.item.insurer_name}.` });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={cardStyle(C)}>
      <SectionHeader C={C} icon="🛠️" title="Role & Availability Editor" text="Use this before each run to move primary responsibility, reduce support share, or pause someone who is unavailable." />
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={inputStyle(C)}>
          <option value="">Select insurer/person row</option>
          {orderedAccounts.map((account) => (
            <option key={account.id} value={account.id}>{account.insurer_name} · {account.owner_name}</option>
          ))}
        </select>
        <select value={draft.assignment_role} onChange={(e) => setDraft((prev) => ({ ...prev, assignment_role: e.target.value }))} style={inputStyle(C)} disabled={!selected}>
          {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input type="number" step="0.1" value={draft.support_capacity_ratio} onChange={(e) => setDraft((prev) => ({ ...prev, support_capacity_ratio: e.target.value }))} placeholder="Role weight" style={inputStyle(C)} disabled={!selected} />
        <select value={draft.availability_status} onChange={(e) => setDraft((prev) => ({ ...prev, availability_status: e.target.value }))} style={inputStyle(C)} disabled={!selected}>
          <option value="available">Available</option>
          <option value="busy">Busy</option>
          <option value="leave">On leave</option>
          <option value="paused">Paused</option>
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '0.8fr 1.4fr 1fr', gap: 12, marginBottom: 14 }}>
        <input type="number" value={draft.current_claim_load} onChange={(e) => setDraft((prev) => ({ ...prev, current_claim_load: e.target.value }))} placeholder="Current claim load" style={inputStyle(C)} disabled={!selected} />
        <input value={draft.availability_note} onChange={(e) => setDraft((prev) => ({ ...prev, availability_note: e.target.value }))} placeholder="Why this row was moved, reduced, or paused" style={inputStyle(C)} disabled={!selected} />
        <button onClick={save} disabled={!selected || saving} style={{ background: !selected || saving ? C.muted : C.accent, color: !selected || saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: !selected || saving ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Saving...' : 'Update Role'}
        </button>
      </div>
      <textarea value={draft.notes} onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Operational notes for this insurer/person row" style={{ ...inputStyle(C), minHeight: 72, resize: 'vertical' }} disabled={!selected} />
    </div>
  );
}

function RulesSection({ C, rules, masterAccounts, onRefresh, setNotice }) {
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_RULE_DRAFT);
  const sectionRef = useRef(null);
  const selectedMode = DISTRIBUTION_MODE_OPTIONS.find((option) => option.value === draft.distribution_mode) || DISTRIBUTION_MODE_OPTIONS[0];

  function onMasterChange(id) {
    const account = masterAccounts.find((item) => item.id === id);
    const existingRule = rules.find((rule) => rule.master_account_id === id || rule.insurer_name === account?.insurer_name);
    if (existingRule) {
      setDraft({
        id: existingRule.id,
        master_account_id: existingRule.master_account_id || id,
        insurer_name: existingRule.insurer_name || account?.insurer_name || '',
        minimum_claim_chunk: existingRule.minimum_claim_chunk ?? 25,
        reassignment_threshold_minutes: existingRule.reassignment_threshold_minutes ?? 120,
        stale_claim_threshold: existingRule.stale_claim_threshold ?? 40,
        target_completion_gap_minutes: existingRule.target_completion_gap_minutes ?? 30,
        distribution_mode: existingRule.distribution_mode || 'balanced_finish',
        notes: existingRule.notes || '',
      });
      return;
    }
    setDraft((prev) => ({ ...DEFAULT_RULE_DRAFT, master_account_id: id, insurer_name: account?.insurer_name || prev.insurer_name }));
  }

  function editRule(rule) {
    setDraft({
      id: rule.id,
      master_account_id: rule.master_account_id || '',
      insurer_name: rule.insurer_name || '',
      minimum_claim_chunk: rule.minimum_claim_chunk ?? 25,
      reassignment_threshold_minutes: rule.reassignment_threshold_minutes ?? 120,
      stale_claim_threshold: rule.stale_claim_threshold ?? 40,
      target_completion_gap_minutes: rule.target_completion_gap_minutes ?? 30,
      distribution_mode: rule.distribution_mode || 'balanced_finish',
      notes: rule.notes || '',
    });
    requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function resetDraft() {
    setDraft(DEFAULT_RULE_DRAFT);
  }

  async function submit() {
    if (!draft.master_account_id || !draft.insurer_name.trim()) {
      setNotice({ type: 'error', text: 'Assignment rule needs a linked master insurer account.' });
      return;
    }
    setSaving(true);
    try {
      const method = draft.id ? 'PATCH' : 'POST';
      const res = await fetch('/api/tools/piles-auto-assignment/assignment-rules', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save rule.');
      resetDraft();
      setNotice({ type: 'success', text: `${draft.id ? 'Rule updated' : 'Rule saved'} for ${data.item.insurer_name}.` });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={sectionRef} style={cardStyle(C)}>
      <SectionHeader C={C} icon="⚖️" title="Assignment Rules" text="These are insurer-level guardrails for how piles should be distributed. The main live assignment inputs still come from Bot Accounts, role/availability, and claims-per-hour." />
      <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>What this section does</div>
        <div style={{ color: C.sub, fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}>
          Use this when an insurer needs extra assignment behavior on top of the normal bot setup. If you leave it alone, the runner will still use the insurer&apos;s bot roles, availability, and speed metrics.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          {DISTRIBUTION_MODE_OPTIONS.map((option) => (
            <div key={option.value} style={{ border: `1px solid ${option.value === selectedMode.value ? C.accent : C.border}`, borderRadius: 10, padding: '10px 12px', background: option.value === selectedMode.value ? '#00E5A010' : 'transparent' }}>
              <div style={{ color: C.text, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{option.label}</div>
              <div style={{ color: C.sub, fontSize: 11, lineHeight: 1.6 }}>{option.description}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <select value={draft.master_account_id} onChange={(e) => onMasterChange(e.target.value)} style={inputStyle(C)}>
          <option value="">Select master insurer</option>
          {masterAccounts.map((account) => <option key={account.id} value={account.id}>{account.insurer_name}</option>)}
        </select>
        <input value={draft.insurer_name} onChange={(e) => setDraft((prev) => ({ ...prev, insurer_name: e.target.value }))} placeholder="Insurer name" style={inputStyle(C)} />
        <select value={draft.distribution_mode} onChange={(e) => setDraft((prev) => ({ ...prev, distribution_mode: e.target.value }))} style={inputStyle(C)}>
          {DISTRIBUTION_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={saving} style={{ flex: 1, background: saving ? C.muted : C.accent, color: saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
            {saving ? 'Saving...' : draft.id ? 'Update Rule' : 'Save Rule'}
          </button>
          {draft.id ? (
            <button onClick={resetDraft} disabled={saving} style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '0 12px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
      <div style={{ background: '#00E5A010', border: '1px solid #00E5A040', borderRadius: 10, padding: '10px 12px', color: C.sub, fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
        <span style={{ color: C.text, fontWeight: 700 }}>{selectedMode.label}:</span> {selectedMode.description}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <input type="number" value={draft.minimum_claim_chunk} onChange={(e) => setDraft((prev) => ({ ...prev, minimum_claim_chunk: e.target.value }))} placeholder="Minimum claims per batch" style={inputStyle(C)} />
        <input type="number" value={draft.reassignment_threshold_minutes} onChange={(e) => setDraft((prev) => ({ ...prev, reassignment_threshold_minutes: e.target.value }))} placeholder="Reassign after idle mins" style={inputStyle(C)} />
        <input type="number" value={draft.stale_claim_threshold} onChange={(e) => setDraft((prev) => ({ ...prev, stale_claim_threshold: e.target.value }))} placeholder="Stale claims threshold" style={inputStyle(C)} />
        <input type="number" value={draft.target_completion_gap_minutes} onChange={(e) => setDraft((prev) => ({ ...prev, target_completion_gap_minutes: e.target.value }))} placeholder="Target finish gap mins" style={inputStyle(C)} />
      </div>
      <textarea value={draft.notes} onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Any insurer-specific notes around load balancing or overrides" style={{ ...inputStyle(C), minHeight: 72, marginBottom: 18, resize: 'vertical' }} />
      {!rules.length ? (
        <EmptyState C={C} title="No assignment rules yet" text="Once rules are saved, the runner can use them to decide how to prorate incoming piles based on claims-per-hour performance." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Insurer', 'Mode', 'Min Chunk', 'Reassign', 'Stale Threshold'].map((label) => <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{rule.insurer_name}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{DISTRIBUTION_MODE_OPTIONS.find((option) => option.value === rule.distribution_mode)?.label || rule.distribution_mode}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{rule.minimum_claim_chunk}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{rule.reassignment_threshold_minutes} min</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{rule.stale_claim_threshold} claims</td>
                  <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                    <button onClick={() => editRule(rule)} style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MetricsSection({ C, metrics, botAccounts, onRefresh, setNotice }) {
  const [saving, setSaving] = useState(false);
  const [selectedInsurer, setSelectedInsurer] = useState('');
  const [draft, setDraft] = useState({ bot_account_id: '', claims_completed: 0, hours_logged: 0, claims_per_hour: 0, active_claim_load: 0 });

  const insurers = useMemo(() => Array.from(new Set(botAccounts.map((account) => account.insurer_name).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [botAccounts]);

  useEffect(() => {
    if (!selectedInsurer && insurers.length) {
      setSelectedInsurer(insurers[0]);
    } else if (selectedInsurer && !insurers.includes(selectedInsurer)) {
      setSelectedInsurer(insurers[0] || '');
    }
  }, [insurers, selectedInsurer]);

  const filteredMetrics = useMemo(() => {
    return metrics.filter((metric) => {
      const bot = botAccounts.find((item) => item.id === metric.bot_account_id);
      return selectedInsurer ? bot?.insurer_name === selectedInsurer : true;
    });
  }, [metrics, botAccounts, selectedInsurer]);

  const filteredBots = useMemo(() => {
    return botAccounts
      .filter((account) => selectedInsurer ? account.insurer_name === selectedInsurer : true)
      .sort(compareBotRows);
  }, [botAccounts, selectedInsurer]);

  async function submit() {
    if (!draft.bot_account_id) {
      setNotice({ type: 'error', text: 'Select a bot before saving a claims-per-hour metric.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/tools/piles-auto-assignment/bot-metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save metric.');
      setDraft({ bot_account_id: '', claims_completed: 0, hours_logged: 0, claims_per_hour: 0, active_claim_load: 0 });
      setNotice({ type: 'success', text: 'Claims-per-hour metric saved.' });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={cardStyle(C)}>
      <SectionHeader C={C} icon="📈" title="Bot Speed Metrics" text="These rows drive proration and completion balancing. View one insurer at a time so it is easier to compare who is moving faster inside that pool." />
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12, marginBottom: 12 }}>
        <select value={selectedInsurer} onChange={(e) => setSelectedInsurer(e.target.value)} style={inputStyle(C)}>
          {insurers.map((insurer) => <option key={insurer} value={insurer}>{insurer}</option>)}
        </select>
        <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', color: C.sub, fontSize: 12, display: 'flex', alignItems: 'center' }}>
          {selectedInsurer ? `Showing speed and completion rows for ${selectedInsurer}.` : 'Add bot rows first to view insurer metrics.'}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr repeat(4, 1fr) 0.9fr', gap: 12, marginBottom: 18 }}>
        <select value={draft.bot_account_id} onChange={(e) => setDraft((prev) => ({ ...prev, bot_account_id: e.target.value }))} style={inputStyle(C)}>
          <option value="">Select bot</option>
          {filteredBots.map((account) => <option key={account.id} value={account.id}>{account.insurer_name} · {account.owner_name}</option>)}
        </select>
        <input type="number" value={draft.claims_completed} onChange={(e) => setDraft((prev) => ({ ...prev, claims_completed: e.target.value }))} placeholder="Claims completed" style={inputStyle(C)} />
        <input type="number" value={draft.hours_logged} onChange={(e) => setDraft((prev) => ({ ...prev, hours_logged: e.target.value }))} placeholder="Hours logged" style={inputStyle(C)} />
        <input type="number" value={draft.claims_per_hour} onChange={(e) => setDraft((prev) => ({ ...prev, claims_per_hour: e.target.value }))} placeholder="Claims/hr" style={inputStyle(C)} />
        <input type="number" value={draft.active_claim_load} onChange={(e) => setDraft((prev) => ({ ...prev, active_claim_load: e.target.value }))} placeholder="Active load" style={inputStyle(C)} />
        <button onClick={submit} disabled={saving} style={{ background: saving ? C.muted : C.accent, color: saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      {!filteredMetrics.length ? (
        <EmptyState C={C} title="No speed metrics yet" text="Seed initial claims-per-hour values here, then the runner can take over and keep them current from observed work rate." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Bot', 'Claims Completed', 'Hours Logged', 'Claims/Hr', 'Active Load', 'Updated'].map((label) => <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {filteredMetrics.map((metric) => {
                const bot = botAccounts.find((item) => item.id === metric.bot_account_id);
                return (
                  <tr key={metric.id}>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{bot ? `${bot.insurer_name} · ${bot.owner_name}` : metric.bot_account_id}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric.claims_completed}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric.hours_logged}</td>
                    <td style={{ color: C.accent, fontSize: 13, fontWeight: 700, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric.claims_per_hour}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric.active_claim_load}</td>
                    <td style={{ color: C.muted, fontSize: 12, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{metric.updated_at ? new Date(metric.updated_at).toLocaleString('en-GB') : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrackedPileProgressSection({ C, trackedPiles, botAccounts }) {
  const [stateFilter, setStateFilter] = useState('active');
  const [insurerFilter, setInsurerFilter] = useState('all');

  const insurerOptions = useMemo(
    () => Array.from(new Set((trackedPiles || []).map((pile) => pile.insurer_name).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [trackedPiles],
  );

  const counts = useMemo(() => {
    const active = trackedPiles.filter((pile) => formatTrackedState(pile) === 'active').length;
    const stale = trackedPiles.filter((pile) => formatTrackedState(pile) === 'stale').length;
    const completed = trackedPiles.filter((pile) => formatTrackedState(pile) === 'completed').length;
    return { active, stale, completed };
  }, [trackedPiles]);

  const filteredRows = useMemo(() => {
    return [...trackedPiles]
      .filter((pile) => (insurerFilter === 'all' ? true : pile.insurer_name === insurerFilter))
      .filter((pile) => (stateFilter === 'all' ? true : formatTrackedState(pile) === stateFilter))
      .sort((a, b) => new Date(b.updated_at || b.last_seen_at || 0).getTime() - new Date(a.updated_at || a.last_seen_at || 0).getTime());
  }, [trackedPiles, insurerFilter, stateFilter]);

  return (
    <div style={cardStyle(C)}>
      <SectionHeader
        C={C}
        icon="🛰️"
        title="Tracked Pile Progress"
        text="This shows only the piles the runner has actually assigned and is now watching for progress, completion, staleness, and possible reassignment."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={inputStyle(C)}>
          <option value="active">Active tracked piles</option>
          <option value="stale">Stale / reassignment candidates</option>
          <option value="completed">Completed tracked piles</option>
          <option value="all">All tracked piles</option>
        </select>
        <select value={insurerFilter} onChange={(e) => setInsurerFilter(e.target.value)} style={inputStyle(C)}>
          <option value="all">All insurers</option>
          {insurerOptions.map((insurer) => <option key={insurer} value={insurer}>{insurer}</option>)}
        </select>
        <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', color: C.sub, fontSize: 12, display: 'flex', alignItems: 'center' }}>
          Active: <span style={{ color: C.text, fontWeight: 700, margin: '0 10px 0 6px' }}>{counts.active}</span>
          Stale: <span style={{ color: C.warn, fontWeight: 700, margin: '0 10px 0 6px' }}>{counts.stale}</span>
          Completed: <span style={{ color: C.accent, fontWeight: 700, marginLeft: 6 }}>{counts.completed}</span>
        </div>
      </div>
      {!filteredRows.length ? (
        <EmptyState
          C={C}
          title="No tracked piles for this filter"
          text="Once the runner completes real execute-mode assignments, those piles will appear here and start showing progress or stale signals over time."
        />
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 430, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: C.card, zIndex: 1 }}>
              <tr>
                {['Insurer', 'Bot Owner', 'Portal Assignee', 'Provider', 'Status', 'Claims', 'Remaining', 'Progress', 'Last Progress', 'State'].map((label) => (
                  <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => {
                const bot = botAccounts.find((item) => item.id === row.bot_account_id);
                const state = formatTrackedState(row);
                const claimsTotal = Number(row.claims_total || 0);
                const remainingClaims = Number(row.remaining_claims || 0);
                const completedClaims = Math.max(0, claimsTotal - remainingClaims);
                return (
                  <tr key={row.id}>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>
                      <div>{row.insurer_name}</div>
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{row.filter_month || row.claim_month || '—'}</div>
                    </td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>{bot?.owner_name || '—'}</td>
                    <td style={{ color: C.text, fontSize: 13, fontWeight: 700, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>{row.current_assigned || bot?.bot_name || '—'}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>{row.provider || '—'}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>
                      <div>{row.current_status_bucket || row.current_status || '—'}</div>
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{row.assignment_type || '—'}</div>
                    </td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>{claimsTotal}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>{remainingClaims}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>
                      <div>{completedClaims} done</div>
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{`${completedClaims}/${claimsTotal}`}</div>
                    </td>
                    <td style={{ color: C.muted, fontSize: 12, padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>
                      <div>{formatDateTime(row.completed_at || row.last_progress_at || row.last_seen_at)}</div>
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>
                        Assigned {formatDateTime(row.assigned_at)}
                      </div>
                    </td>
                    <td style={{ padding: '12px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' }}>
                      <div style={{ color: state === 'stale' ? C.warn : state === 'completed' ? C.accent : C.text, fontSize: 12, fontWeight: 700, textTransform: 'capitalize' }}>
                        {state}
                      </div>
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
                        {row.stale_reason || (state === 'completed' ? 'Finished and closed from active tracking.' : 'Still being monitored by the runner.')}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LiveAssignmentScoreboard({ C, logs, botAccounts, refreshToken }) {
  const [scope, setScope] = useState('today');
  const [selectedDay, setSelectedDay] = useState(toDateInputValue(new Date()));
  const [activityLogs, setActivityLogs] = useState(logs || []);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadActivityLogs() {
      setLoading(true);
      setLoadError('');
      try {
        const params = new URLSearchParams();
        const range = buildActivityRange(scope, selectedDay);
        if (range?.from) params.set('from', range.from);
        if (range?.to) params.set('to', range.to);
        params.set('limit', scope === 'all' ? '1000' : '500');
        const res = await fetch(`/api/tools/piles-auto-assignment/assignment-logs?${params.toString()}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load assignment activity.');
        if (!cancelled) setActivityLogs(json.items || []);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error.message || 'Failed to load assignment activity.');
          setActivityLogs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadActivityLogs();
    return () => {
      cancelled = true;
    };
  }, [scope, selectedDay, refreshToken]);

  const flattenedRows = useMemo(() => {
    return activityLogs
      .filter((log) => {
        const summary = log?.details?.summary;
        const noWork = Boolean(log?.details?.no_work);
        return (
          (
            (summary && typeof summary === 'object' && Object.keys(summary).length > 0)
            || noWork
          )
          && log.event_type === 'runner_complete'
        );
      })
      .flatMap((log) => {
        const summary = Object.values(log.details.summary || {});
        const eventTime = log?.details?.finished_at || log?.created_at || log?.details?.captured_at || null;
        const insurerName = log?.details?.insurer_name || log?.insurer_name || '—';
        const mode = log?.details?.mode || log?.status || 'runner';
        const timeLabel = mode === 'execute' ? 'Assigned At' : 'Planned At';

        if (!summary.length && log?.details?.no_work) {
          return [{
            id: `${log.id}-no-work`,
            insurer_name: insurerName,
            assignee_name: 'No unassigned piles',
            owner_name: '—',
            assignment_role: '—',
            effective_speed: '—',
            starting_claim_load: 0,
            starting_load: 0,
            assigned_piles: 0,
            assigned_claims: 0,
            projected_finish_hours: 0,
            projected_finish_minutes: 0,
            event_time: eventTime,
            time_label: timeLabel,
            event_type: log.event_type,
          }];
        }

        return summary.map((row, index) => {
          const resolvedInsurer = row.insurer_name || insurerName;
          const assigneeKey = normKeyClient(row.assignee_name);
          const matchedBot = botAccounts.find((bot) => (
            bot.insurer_name === resolvedInsurer
            && (
              normKeyClient(bot.bot_name) === assigneeKey
              || normKeyClient(bot.owner_name) === assigneeKey
            )
          ));

          return {
            id: `${log.id}-${row.assignee_name || 'assignee'}-${index}`,
            insurer_name: resolvedInsurer,
            assignee_name: row.assignee_name,
            owner_name: matchedBot?.owner_name || '—',
            assignment_role: row.assignment_role,
            effective_speed: row.effective_speed,
            starting_claim_load: row.starting_claim_load ?? row.starting_load ?? 0,
            starting_load: row.starting_claim_load ?? row.starting_load ?? 0,
            assigned_piles: row.assigned_piles ?? 0,
            assigned_claims: row.assigned_claims,
            projected_finish_hours: row.projected_finish_hours,
            projected_finish_minutes: row.projected_finish_minutes,
            event_time: eventTime,
            time_label: timeLabel,
            event_type: log.event_type,
          };
        });
      })
      .sort((a, b) => new Date(b.event_time || 0).getTime() - new Date(a.event_time || 0).getTime());
  }, [activityLogs, botAccounts]);

  const filteredRows = flattenedRows;

  const latestVisibleTimeLabel = filteredRows[0]?.time_label || 'Assigned At';
  const latestVisibleSource = filteredRows[0]
    ? `${filteredRows[0].event_type} for ${filteredRows[0].insurer_name} at ${new Date(filteredRows[0].event_time).toLocaleString('en-GB')}`
    : null;

  return (
    <div style={cardStyle(C)}>
      <SectionHeader
        C={C}
        icon="🧾"
        title="Recent Assignment Activity"
        text="This combines the latest runner assignment snapshots into one scrollable activity view, including insurer, bot owner, assignee, speed, load, and when the plan or assignment was captured."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr', gap: 12, marginBottom: 16 }}>
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={inputStyle(C)}>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="custom">Pick a day</option>
          <option value="all">All time</option>
        </select>
        {scope === 'custom' ? (
          <input type="date" value={selectedDay} onChange={(e) => setSelectedDay(e.target.value)} style={inputStyle(C)} />
        ) : (
          <div style={{ background: C.elevated, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', color: C.sub, fontSize: 12, display: 'flex', alignItems: 'center' }}>
            {loading
              ? 'Loading assignment history...'
              : scope === 'all'
                ? 'Showing stored assignment history across all recorded time.'
                : 'Showing stored assignment history for the selected day.'}
          </div>
        )}
      </div>
      {loadError && (
        <div style={{ background: '#FF5A6F15', border: '1px solid #FF5A6F44', borderRadius: 10, padding: '10px 12px', color: C.danger, fontSize: 12, marginBottom: 14 }}>
          {loadError}
        </div>
      )}
      {!filteredRows.length ? (
        <EmptyState
          C={C}
          title="No assignment snapshots for this filter"
          text="No stored assignment history matched this filter. If that is unexpected, the logs may exist outside the previous recent slice and should now appear once fetched for that day."
        />
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 430, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: C.card, zIndex: 1 }}>
              <tr>
                {['Insurer', 'Bot Owner', 'Assignee', 'Role', 'Effective Speed', 'Starting Claims', 'Assigned Piles', 'Assigned Claims', 'Projected Finish', latestVisibleTimeLabel].map((label) => (
                  <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.insurer_name}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.owner_name}</td>
                    <td style={{ color: C.text, fontSize: 13, fontWeight: 700, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.assignee_name}</td>
                    <td style={{ color: row.assignment_role === '—' ? C.sub : row.assignment_role === 'support' ? C.warn : C.accent, fontSize: 12, fontWeight: 700, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.assignment_role}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.effective_speed === '—' ? '—' : `${row.effective_speed}/hr`}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.starting_claim_load}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.assigned_piles}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.assigned_claims}</td>
                    <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.assignment_role === '—' ? '—' : formatProjectedFinish(row)}</td>
                    <td style={{ color: C.muted, fontSize: 12, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{row.event_time ? new Date(row.event_time).toLocaleString('en-GB') : '—'}</td>
                  </tr>
              ))}
            </tbody>
          </table>
        <div style={{ color: C.muted, fontSize: 11, marginTop: 10, padding: '10px 12px' }}>
          {latestVisibleSource ? `Latest visible source: ${latestVisibleSource}` : 'No visible runner source for this filter.'}
        </div>
      </div>
      )}
    </div>
  );
}

function LogsSection({ C, logs, botAccounts, onRefresh, setNotice }) {
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ insurer_name: '', event_type: 'assignment', pile_count: 0, claim_count: 0 });

  function describeAssignee(log) {
    const details = log.details || {};
    if (details.assignee_name) return details.assignee_name;
    if (details.owner_name) return details.owner_name;
    if (log.bot_account_id) {
      const bot = botAccounts.find((item) => item.id === log.bot_account_id);
      if (bot) return bot.owner_name || bot.bot_name || bot.bot_email || bot.id;
    }
    return '—';
  }

  function describePileSummary(log) {
    const details = log.details || {};
    if (Array.isArray(details.piles) && details.piles.length) {
      return `${details.piles.length} pile${details.piles.length === 1 ? '' : 's'} planned`;
    }
    if (details.provider) return details.provider;
    return '—';
  }

  async function submit() {
    if (!draft.insurer_name.trim()) {
      setNotice({ type: 'error', text: 'Insurer name is required to save an assignment log.' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/tools/piles-auto-assignment/assignment-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, assigned_by: getMemberName() || 'Dashboard User' }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to save log.');
      setDraft({ insurer_name: '', event_type: 'assignment', pile_count: 0, claim_count: 0 });
      setNotice({ type: 'success', text: 'Assignment event logged.' });
      onRefresh();
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={cardStyle(C)}>
      <SectionHeader C={C} icon="🧾" title="Recent Assignment Activity" text="This will become the operational timeline of who received new piles, how many claims moved, and when reassignments happened." />
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 0.8fr 0.8fr 0.8fr', gap: 12, marginBottom: 18 }}>
        <input value={draft.insurer_name} onChange={(e) => setDraft((prev) => ({ ...prev, insurer_name: e.target.value }))} placeholder="Insurer name" style={inputStyle(C)} />
        <select value={draft.event_type} onChange={(e) => setDraft((prev) => ({ ...prev, event_type: e.target.value }))} style={inputStyle(C)}>
          <option value="assignment">Assignment</option>
          <option value="reassignment">Reassignment</option>
          <option value="credential_update">Credential update</option>
          <option value="runner_check">Runner check</option>
        </select>
        <input type="number" value={draft.pile_count} onChange={(e) => setDraft((prev) => ({ ...prev, pile_count: e.target.value }))} placeholder="Piles" style={inputStyle(C)} />
        <input type="number" value={draft.claim_count} onChange={(e) => setDraft((prev) => ({ ...prev, claim_count: e.target.value }))} placeholder="Claims" style={inputStyle(C)} />
        <button onClick={submit} disabled={saving} style={{ background: saving ? C.muted : C.accent, color: saving ? C.sub : '#0B0F1A', border: 'none', borderRadius: 8, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving...' : 'Log Event'}</button>
      </div>
      {!logs.length ? (
        <EmptyState C={C} title="No assignment events yet" text="Once the runner starts assigning piles, this timeline will show who got work, when it was assigned, and how much moved." />
      ) : (
        <div style={{ overflowX: 'auto', maxHeight: 430, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: C.card, zIndex: 1 }}>
              <tr>{['Time', 'Insurer', 'Event', 'Assigned To', 'Piles / Context', 'Claims', 'By'].map((label) => <th key={label} style={{ textAlign: 'left', color: C.sub, fontSize: 11, fontWeight: 700, padding: '10px 12px', borderBottom: `1px solid ${C.border}` }}>{label}</th>)}</tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ color: C.muted, fontSize: 12, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{log.created_at ? new Date(log.created_at).toLocaleString('en-GB') : '—'}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{log.insurer_name}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{log.event_type}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{describeAssignee(log)}</td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>
                    <div>{log.pile_count}</div>
                    <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>{describePileSummary(log)}</div>
                  </td>
                  <td style={{ color: C.text, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{log.claim_count}</td>
                  <td style={{ color: C.sub, fontSize: 13, padding: '12px', borderBottom: `1px solid ${C.border}` }}>{log.assigned_by || log.source || 'system'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PilesAutoAssignmentPage() {
  const { C } = useTheme();
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [data, setData] = useState({ overview: null, masterAccounts: [], botAccounts: [], rules: [], botMetrics: [], recentLogs: [], trackedPiles: [] });
  const [teamMembers, setTeamMembers] = useState([]);
  const [runnerState, setRunnerState] = useState({ runOutput: '', runMeta: null });
  const [runnerHistoryRefreshToken, setRunnerHistoryRefreshToken] = useState(0);

  async function load() {
    setLoading(true);
    try {
      const [configRes, teamRes] = await Promise.all([
        fetch('/api/tools/piles-auto-assignment'),
        fetch('/api/team'),
      ]);
      const [json, teamJson] = await Promise.all([configRes.json(), teamRes.json()]);
      if (!json.success) throw new Error(json.error || 'Failed to load piles auto-assignment data.');
      if (teamJson.error) throw new Error(teamJson.error);
      setData({
        overview: json.overview,
        masterAccounts: json.masterAccounts || [],
        botAccounts: json.botAccounts || [],
        rules: json.rules || [],
        botMetrics: json.botMetrics || [],
        recentLogs: json.recentLogs || [],
        trackedPiles: json.trackedPiles || [],
      });
      setTeamMembers(teamJson.data || []);
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const metricsByBotId = useMemo(() => Object.fromEntries((data.botMetrics || []).map((metric) => [metric.bot_account_id, metric])), [data.botMetrics]);
  const runnerOutputFallback = useMemo(() => buildRunnerOutputFallback(data.recentLogs), [data.recentLogs]);

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '28px 32px 48px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ marginBottom: 24 }}>
        <a href="/tools" style={{ color: C.sub, fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 14 }}>← Back to Tools</a>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 24 }}>🧠</span>
              <h1 style={{ color: C.text, fontSize: 26, fontWeight: 700, margin: 0 }}>Piles Auto-Assignment</h1>
            </div>
            <p style={{ color: C.sub, fontSize: 14, margin: 0, maxWidth: 760 }}>
              Control master insurer logins, bot credentials, assignment rules, and the claims-per-hour data that will later drive prorated pile assignment.
            </p>
          </div>
          <button onClick={load} disabled={loading} style={{ background: loading ? C.muted : C.elevated, color: loading ? C.sub : C.text, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 16px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
            {loading ? 'Refreshing...' : 'Refresh Data'}
          </button>
        </div>
      </div>

      <SaveBanner C={C} notice={notice} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 24 }}>
        <StatCard C={C} label="Configured Insurers" value={data.overview?.insurersConfigured ?? '—'} hint="Master insurer records saved" />
        <StatCard C={C} label="Active Bots" value={data.overview?.activeBots ?? '—'} hint="Bots currently enabled" />
        <StatCard C={C} label="Available Bots" value={data.overview?.availableBots ?? '—'} hint="Ready for new pile allocation" />
        <StatCard C={C} label="Primary Rows" value={data.overview?.primaryBots ?? '—'} hint="Main insurer owners" />
        <StatCard C={C} label="Support Rows" value={data.overview?.supportBots ?? '—'} hint="Reduced-share helpers" />
        <StatCard C={C} label="Average Claims/Hr" value={data.overview?.averageClaimsPerHour ?? '—'} hint="Across saved bot metrics" />
        <StatCard C={C} label="Active Claim Load" value={data.overview?.activeClaimLoad ?? '—'} hint="Current open claims assigned" />
        <StatCard C={C} label="Tracked Piles" value={data.overview?.activeTrackedPiles ?? '—'} hint="Runner-managed active assignments" />
        <StatCard C={C} label="Stale Tracked" value={data.overview?.staleTrackedPiles ?? '—'} hint="Candidates for reassignment" />
      </div>

      {loading ? (
        <div style={cardStyle(C)}>
          <div style={{ color: C.sub, fontSize: 14 }}>Loading configuration and assignment data…</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 20 }}>
          <RunnerControlSection
            C={C}
            masterAccounts={data.masterAccounts}
            onRefresh={load}
            onRunnerFinished={() => setRunnerHistoryRefreshToken((value) => value + 1)}
            setNotice={setNotice}
            runnerState={runnerState}
            setRunnerState={setRunnerState}
            runnerOutputFallback={runnerOutputFallback}
          />
          <RunnerHistorySection C={C} refreshToken={runnerHistoryRefreshToken} />
          <LiveAssignmentScoreboard C={C} logs={data.recentLogs} botAccounts={data.botAccounts} refreshToken={runnerHistoryRefreshToken} />
          <TrackedPileProgressSection C={C} trackedPiles={data.trackedPiles} botAccounts={data.botAccounts} />
          <MasterAccountsSection C={C} accounts={data.masterAccounts} onRefresh={load} setNotice={setNotice} />
          <BotAccountsSection C={C} accounts={data.botAccounts} masterAccounts={data.masterAccounts} metricsByBotId={metricsByBotId} onRefresh={load} setNotice={setNotice} />
          <BotRoleEditorSection C={C} accounts={data.botAccounts} onRefresh={load} setNotice={setNotice} />
          <TeamSlackSection C={C} members={teamMembers} onRefresh={load} setNotice={setNotice} />
          <RulesSection C={C} rules={data.rules} masterAccounts={data.masterAccounts} onRefresh={load} setNotice={setNotice} />
          <MetricsSection C={C} metrics={data.botMetrics} botAccounts={data.botAccounts} onRefresh={load} setNotice={setNotice} />
        </div>
      )}
    </div>
  );
}
