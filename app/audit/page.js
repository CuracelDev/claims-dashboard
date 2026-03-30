'use client';
// app/audit/page.js — Audit Log
// Built by Fade & Moe ✦

import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

const PAGE_SIZE = 50;

const ACTION_COLORS = {
  'report.submit':   '#00E5A0',
  'report.edit':     '#5B8DEF',
  'target.create':   '#A78BFA',
  'target.delete':   '#FF4D4D',
  'target.log':      '#F59E0B',
  'task.create':     '#34D399',
  'task.update':     '#06B6D4',
  'auth.login':      '#00E5A0',
  'auth.logout':     '#6B7A99',
  'settings.update': '#F59E0B',
  'import.bulk':     '#A78BFA',
};

function actionColor(action) {
  for (const [key, color] of Object.entries(ACTION_COLORS)) {
    if (action?.startsWith(key.split('.')[0])) return color;
  }
  return '#6B7A99';
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function AuditPage() {
  const { C } = useTheme();

  const [logs,    setLogs]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [page,    setPage]    = useState(1);

  const [filters, setFilters] = useState({
    member_id: '', action: '', from: '', to: '',
  });
  const [members, setMembers] = useState([]);

  useEffect(() => {
    fetch('/api/team')
      .then(r => r.json())
      .then(d => setMembers(d.data || []));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({
      limit:  String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    });
    if (filters.member_id) p.set('member_id', filters.member_id);
    if (filters.action)    p.set('action',    filters.action);
    if (filters.from)      p.set('from',      filters.from);
    if (filters.to)        p.set('to',        filters.to);

    fetch(`/api/audit?${p}`)
      .then(r => r.json())
      .then(d => {
        setLogs(d.data || []);
        setTotal(d.count || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const inp = {
    background: C.elevated, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '7px 12px', color: C.text,
    fontSize: 12, outline: 'none',
  };

  const th = {
    fontSize: 11, fontWeight: 600, color: C.muted,
    padding: '10px 14px', textAlign: 'left',
    borderBottom: `1px solid ${C.border}`,
    background: C.elevated, whiteSpace: 'nowrap',
  };

  const td = {
    fontSize: 12, padding: '10px 14px',
    borderBottom: `1px solid ${C.border}33`,
    verticalAlign: 'middle',
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>

      {/* Header */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '16px 24px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>🗂️ Audit Log</h1>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: C.sub }}>
            Activity trail · {total.toLocaleString()} records
          </p>
        </div>
        <button
          onClick={load}
          style={{
            background: C.elevated, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: '7px 14px', color: C.sub,
            fontSize: 12, cursor: 'pointer',
          }}
        >🔄 Refresh</button>
      </div>

      <div style={{ padding: '16px 24px' }}>

        {/* Filters */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: '14px 20px', marginBottom: 16,
          display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end',
        }}>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Member</div>
            <select
              value={filters.member_id}
              onChange={e => { setFilters(f => ({ ...f, member_id: e.target.value })); setPage(1); }}
              style={inp}
            >
              <option value="">All members</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.display_name || m.name}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Action</div>
            <input
              value={filters.action}
              onChange={e => { setFilters(f => ({ ...f, action: e.target.value })); setPage(1); }}
              placeholder="e.g. report, auth, task"
              style={{ ...inp, width: 160 }}
            />
          </div>

          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>From</div>
            <input
              type="date" value={filters.from}
              onChange={e => { setFilters(f => ({ ...f, from: e.target.value })); setPage(1); }}
              style={inp}
            />
          </div>

          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>To</div>
            <input
              type="date" value={filters.to}
              onChange={e => { setFilters(f => ({ ...f, to: e.target.value })); setPage(1); }}
              style={inp}
            />
          </div>

          <button
            onClick={() => { setFilters({ member_id: '', action: '', from: '', to: '' }); setPage(1); }}
            style={{ ...inp, cursor: 'pointer', color: C.muted }}
          >Clear</button>
        </div>

        {/* Table */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, fontSize: 13 }}>
              Loading audit log...
            </div>
          ) : logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🗂️</div>
              <div style={{ fontSize: 14, color: C.sub, marginBottom: 6 }}>No activity logged yet</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                Actions like report submissions, logins, and task updates will appear here.
              </div>
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Time</th>
                      <th style={th}>Member</th>
                      <th style={th}>Action</th>
                      <th style={th}>Entity</th>
                      <th style={th}>Details</th>
                      <th style={th}>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, i) => {
                      const color = actionColor(log.action);
                      return (
                        <tr
                          key={log.id}
                          style={{ background: i % 2 === 0 ? 'transparent' : `${C.elevated}44` }}
                        >
                          <td style={{ ...td, color: C.muted, whiteSpace: 'nowrap' }}>
                            <div>{timeAgo(log.created_at)}</div>
                            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
                              {log.created_at
                                ? new Date(log.created_at).toLocaleDateString('en-GB', {
                                    day: 'numeric', month: 'short',
                                    hour: '2-digit', minute: '2-digit',
                                  })
                                : '—'}
                            </div>
                          </td>

                          <td style={{ ...td, whiteSpace: 'nowrap' }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                              {log.member_name || '—'}
                            </div>
                            {log.source === 'pre-auth' && (
                              <div style={{ fontSize: 9, color: C.muted }}>pre-auth</div>
                            )}
                          </td>

                          <td style={td}>
                            <span style={{
                              fontSize: 11, fontWeight: 700,
                              padding: '2px 8px', borderRadius: 20,
                              background: `${color}18`,
                              color, border: `1px solid ${color}33`,
                              whiteSpace: 'nowrap',
                            }}>
                              {log.action}
                            </span>
                          </td>

                          <td style={{ ...td, color: C.sub, fontSize: 11 }}>
                            {log.entity_type ? (
                              <span>
                                {log.entity_type}
                                {log.entity_id && (
                                  <span style={{ color: C.muted }}> #{log.entity_id}</span>
                                )}
                              </span>
                            ) : '—'}
                          </td>

                          <td style={{ ...td, color: C.sub, maxWidth: 280 }}>
                            {log.details ? (
                              <div style={{
                                fontSize: 11, background: C.elevated,
                                borderRadius: 6, padding: '4px 8px',
                                fontFamily: 'monospace',
                                overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap', maxWidth: 260,
                              }}>
                                {JSON.stringify(log.details)}
                              </div>
                            ) : '—'}
                          </td>

                          <td style={td}>
                            <span style={{
                              fontSize: 10, padding: '2px 7px', borderRadius: 4,
                              background: `${C.muted}22`, color: C.muted,
                            }}>
                              {log.source || 'app'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{
                  padding: '12px 20px', borderTop: `1px solid ${C.border}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      style={{ ...inp, cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
                    >← Prev</button>
                    <span style={{ fontSize: 12, color: C.sub, padding: '7px 12px' }}>
                      {page} / {totalPages}
                    </span>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      style={{ ...inp, cursor: page === totalPages ? 'not-allowed' : 'pointer', opacity: page === totalPages ? 0.4 : 1 }}
                    >Next →</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
