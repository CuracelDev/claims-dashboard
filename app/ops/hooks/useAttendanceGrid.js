// app/ops/hooks/useAttendanceGrid.js
import { useState, useEffect, useCallback, useMemo } from 'react';

// ── Pure helpers ──────────────────────────────────────────────────────────────

function getTodayISO() {
  return new Date().toISOString().split('T')[0];
}

function getWeekStartISO() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return mon.toISOString().split('T')[0];
}

function getDateRange(from, to) {
  const result = [];
  const cursor = new Date(from + 'T12:00:00');
  const end    = new Date(to   + 'T12:00:00');
  while (cursor <= end) {
    result.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function buildLeaveMap(leaves) {
  const map = {};
  for (const l of leaves) {
    const mid = String(l.team_member_id);
    if (!map[mid]) map[mid] = new Set();
    const s = new Date(l.start_date + 'T12:00:00');
    const e = new Date(l.end_date   + 'T12:00:00');
    const d = new Date(s);
    while (d <= e) {
      map[mid].add(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
  }
  return map;
}

function resolveStatus({ memberId, date, submittedSet, leaveMap, today }) {
  const key = `${memberId}|${date}`;
  if (submittedSet.has(key))              return 'submitted';
  if (leaveMap[String(memberId)]?.has(date)) return 'leave';
  if (date >= today)                      return 'future';
  return 'missing';
}

export function buildGrid({ teamMembers, dayList, reports, leaves }) {
  const leaveMap    = buildLeaveMap(leaves);
  const submittedSet = new Set(reports.map(r => `${r.team_member_id}|${r.report_date}`));
  const today       = getTodayISO();
  const grid        = {};
  for (const m of teamMembers) {
    grid[m.id] = {};
    for (const day of dayList) {
      grid[m.id][day] = resolveStatus({ memberId: m.id, date: day, submittedSet, leaveMap, today });
    }
  }
  return grid;
}

export function getMemberScore(memberGrid) {
  const vals      = Object.values(memberGrid || {});
  const submitted = vals.filter(s => s === 'submitted').length;
  const total     = vals.filter(s => s !== 'future').length;
  return total > 0 ? Math.round((submitted / total) * 100) : null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAttendanceGrid(teamMembers) {
  const [from, setFrom] = useState(getWeekStartISO);
  const [to,   setTo]   = useState(getTodayISO);
  const [grid,    setGrid]    = useState({});
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [modal,   setModal]   = useState(null);
  const [taskDone,  setTaskDone]  = useState({});
  const [leaveDone, setLeaveDone] = useState({});
  const [acting,    setActing]    = useState(false);

  const days = useMemo(() => getDateRange(from, to), [from, to]);

  const load = useCallback(() => {
    if (!from || !to || teamMembers.length === 0) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`/api/reports?from=${from}&to=${to}&limit=500`, { signal: controller.signal }).then(r => r.json()),
      fetch(`/api/leave?from=${from}&to=${to}&all=true`,    { signal: controller.signal }).then(r => r.json()).catch(() => ({ data: [] })),
    ])
      .then(([rRes, lRes]) => {
        setGrid(buildGrid({
          teamMembers,
          dayList: getDateRange(from, to),
          reports: rRes.data  || [],
          leaves:  lRes.data  || [],
        }));
        setLoading(false);
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          setError('Failed to load attendance data. Try again.');
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [from, to, teamMembers]);

  useEffect(() => {
    const cleanup = load();
    return () => { if (typeof cleanup === 'function') cleanup(); };
  }, [load]);

  const createTask = useCallback(async () => {
    if (!modal) return;
    setActing(true);
    const actionKey  = `${modal.member.id}|${modal.date}`;
    const dateLabel  = new Date(modal.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:       `Submit daily report for ${dateLabel}`,
          description: `Your daily report for ${dateLabel} is missing. Please submit it as soon as possible.`,
          assigned_to: modal.member.id,
          assigned_by: 'Team Lead',
          priority:    'medium',
          category:    'reporting',
          due_date:    getTodayISO(),
        }),
      });
      setTaskDone(p => ({ ...p, [actionKey]: true }));
    } catch (e) {
      setError('Failed to create task. Try again.');
    } finally {
      setActing(false);
    }
  }, [modal]);

  const markLeave = useCallback(async () => {
    if (!modal) return;
    setActing(true);
    const actionKey = `${modal.member.id}|${modal.date}`;
    try {
      await fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: modal.member.id,
          leave_type:     'off_today',
          start_date:     modal.date,
          end_date:       modal.date,
          reason:         'Marked by team lead',
        }),
      });
      setLeaveDone(p => ({ ...p, [actionKey]: true }));
      setGrid(g => ({
        ...g,
        [modal.member.id]: { ...g[modal.member.id], [modal.date]: 'leave' },
      }));
    } catch (e) {
      setError('Failed to mark leave. Try again.');
    } finally {
      setActing(false);
    }
  }, [modal]);

  return {
    from, to, setFrom, setTo,
    days, grid, loading, error,
    reload: load,
    modal, setModal,
    taskDone, leaveDone,
    acting, createTask, markLeave,
  };
}
