'use client';
// app/errors/page.js — Claim Error Tracker

import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

const PAGE_SIZE = 50;

const ERROR_TYPE_LABELS = {
  import_failure: 'Import Failure',
  ref_failure:    'Ref Failure',
};

const ERROR_TYPE_COLORS = {
  import_failure: '#FF4D4D',
  ref_failure:    '#FFB84D',
};

function timeAgo(iso) {
  if (!iso) return '—';
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function StatPill({ label, value, color }) {
  const { C } = useTheme();
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: '14px 20px', flex: 1, minWidth: 140,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color || C.accent }} />
      <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: C.text, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

export default function ErrorTrackerPage() {
  const { C } = useTheme();

  const [logs,    setLogs]    = useState([]);
  const [total,   setTotal]   = useState(0);
  const [stats,   setStats]   = useState({ byType: {}, byHmo: {}, byEnv: {}, byChannel: {} });
  const [loading, setLoading] = useState(true);
  const [page,    setPage]    = useState(1);
  const [expanded, setExpanded] = useState(null);

  const [filters, setFilters] = useState({
    hmo: '', env: '', error_type: '', channel: '', from: '', to: '',
  });

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({
      limit:  String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    });
    if (filters.hmo)        p.set('hmo',        filters.hmo);
    if (filters.env)        p.set('env',        filters.env);
    if (filters.error_type) p.set('error_type', filters.error_type);
    if (filters.channel)    p.set('channel',    filters.channel);
    if (filters.from)       p.set('from',       filters.from);
    if (filters.to)         p.set('to',         filters.to);

    fetch(`/api/claim-errors?${p}`)
      .then(r => r.json())
      .then(d => {
        setLogs(d.data || []);
        setTotal(d.count || 0);
        setStats(d.stats || { byType: {}, byHmo: {}, byEnv: {}, byChannel: {} });
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
    verticalAlign: 'top',
  };

  const importCount = stats.byType?.import_failure || 0;
  const refCount    = stats.byType?.ref_failure    || 0;
  const totalCount  = Object.values(stats.byType).reduce((s, v) => s + v, 0);
  const topHmo      = Object.entries(stats.byHmo).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>

      {/* Header */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        padding: '16px 24px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.text }}>⚠️ Claim Error Tracker</h1>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: C.sub }}>
            Errors captured from Slack · {total.toLocaleString()} total
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

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <StatPill label="Total Errors"     value={totalCount}   color="#FF4D4D" />
          <StatPill label="Import Failures"  value={importCount}  color="#FF4D4D" />
          <StatPill label="Ref Failures"     value={refCount}     color="#FFB84D" />
          <StatPill label="Top HMO"          value={topHmo}       color="#5B8DEF" />
          <StatPill label="Channels"         value={Object.keys(stats.byChannel).length} color="#A78BFA" />
        </div>

        {/* Filters */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: '14px 20px', marginBottom: 16,
          display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end',
        }}>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>HMO</div>
            <input
              value={filters.hmo}
              onChange={e => { setFilters(f => ({ ...f, hmo: e.target.value })); setPage(1); }}
              placeholder="e.g. Jubilee"
              style={{ ...inp, width: 150 }}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Env</div>
            <select
              value={filters.env}
              onChange={e => { setFilters(f => ({ ...f, env: e.target.value })); setPage(1); }}
              style={inp}
            >
              <option value="">All</option>
              <option value="prod">prod</option>
              <option value="staging">staging</option>
              <option value="dev">dev</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Error Type</div>
            <select
              value={filters.error_type}
              onChange={e => { setFilters(f => ({ ...f, error_type: e.target.value })); setPage(1); }}
              style={inp}
            >
              <option value="">All types</option>
              <option value="import_failure">Import Failure</option>
              <option value="ref_failure">Ref Failure</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Channel</div>
            <select
              value={filters.channel}
              onChange={e => { setFilters(f => ({ ...f, channel: e.target.value })); setPage(1); }}
              style={inp}
            >
              <option value="">All channels</option>
              {Object.keys(stats.byChannel).map(ch => (
                <option key={ch} value={ch}>#{ch} ({stats.byChannel[ch]})</option>
              ))}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>From</div>
            <input type="date" value={filters.from}
              onChange={e => { setFilters(f => ({ ...f, from: e.target.value })); setPage(1); }}
              style={inp}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>To</div>
            <input type="date" value={filters.to}
              onChange={e => { setFilters(f => ({ ...f, to: e.target.value })); setPage(1); }}
              style={inp}
            />
          </div>
          <button
            onClick={() => { setFilters({ hmo: '', env: '', error_type: '', channel: '', from: '', to: '' }); setPage(1); }}
            style={{ ...inp, cursor: 'pointer', color: C.muted }}
          >Clear</button>
        </div>

        {/* HMO breakdown chips */}
        {Object.keys(stats.byHmo).length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {Object.entries(stats.byHmo).sort((a, b) => b[1] - a[1]).map(([hmo, count]) => (
              <button
                key={hmo}
                onClick={() => { setFilters(f => ({ ...f, hmo: f.hmo === hmo ? '' : hmo })); setPage(1); }}
                style={{
                  background: filters.hmo === hmo ? '#FF4D4D22' : 'transparent',
                  border: `1px solid ${filters.hmo === hmo ? '#FF4D4D' : C.border}`,
                  color: filters.hmo === hmo ? '#FF4D4D' : C.muted,
                  borderRadius: 20, padding: '4px 12px', fontSize: 11,
                  cursor: 'pointer', fontWeight: filters.hmo === hmo ? 600 : 400,
                }}
              >
                {hmo} <span style={{ opacity: 0.7 }}>({count})</span>
              </button>
            ))}
          </div>
        )}

        {/* Table */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, fontSize: 13 }}>
              Loading errors...
            </div>
          ) : logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✅</div>
              <div style={{ fontSize: 14, color: C.sub, marginBottom: 6 }}>No errors logged yet</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                Invite the bot to your insurer channels and errors will appear here automatically.
              </div>
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Time</th>
                      <th style={th}>Type</th>
                      <th style={th}>HMO</th>
                      <th style={th}>Env</th>
                      <th style={th}>Channel</th>
                      <th style={th}>Error</th>
                      <th style={th}>Refs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, i) => {
                      const color = ERROR_TYPE_COLORS[log.error_type] || C.muted;
                      const isExp = expanded === log.id;
                      return (
                        <>
                          <tr
                            key={log.id}
                            onClick={() => setExpanded(isExp ? null : log.id)}
                            style={{
                              background: i % 2 === 0 ? 'transparent' : `${C.elevated}44`,
                              cursor: 'pointer',
                            }}
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

                            <td style={td}>
                              <span style={{
                                fontSize: 11, fontWeight: 700,
                                padding: '2px 8px', borderRadius: 20,
                                background: `${color}18`, color,
                                border: `1px solid ${color}33`,
                                whiteSpace: 'nowrap',
                              }}>
                                {ERROR_TYPE_LABELS[log.error_type] || log.error_type || '—'}
                              </span>
                            </td>

                            <td style={{ ...td, fontWeight: 600, color: C.text }}>
                              {log.hmo || '—'}
                            </td>

                            <td style={td}>
                              {log.env ? (
                                <span style={{
                                  fontSize: 10, padding: '2px 7px', borderRadius: 4,
                                  background: log.env === 'prod' ? '#FF4D4D22' : '#FFB84D22',
                                  color: log.env === 'prod' ? '#FF4D4D' : '#FFB84D',
                                  fontWeight: 600,
                                }}>
                                  {log.env}
                                </span>
                              ) : '—'}
                            </td>

                            <td style={{ ...td, color: C.muted, fontSize: 11 }}>
                              {log.channel_name ? `#${log.channel_name}` : log.channel_id || '—'}
                            </td>

                            <td style={{ ...td, color: C.sub, maxWidth: 320 }}>
                              <div style={{
                                fontSize: 11, overflow: 'hidden',
                                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                maxWidth: 300,
                              }}>
                                {log.error_message || '—'}
                              </div>
                              {log.inv_id && (
                                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
                                  Inv: {log.inv_id}
                                  {log.provider_code && ` · Provider: ${log.provider_code}`}
                                </div>
                              )}
                            </td>

                            <td style={{ ...td, color: C.muted, fontSize: 11 }}>
                              {log.refs ? (
                                <span style={{
                                  background: `${C.accent}18`, color: C.accent,
                                  borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 600,
                                }}>
                                  {Array.isArray(log.refs) ? log.refs.length : '—'} refs
                                </span>
                              ) : '—'}
                            </td>
                          </tr>

                          {/* Expanded row */}
                          {isExp && (
                            <tr key={`${log.id}-exp`}>
                              <td colSpan={7} style={{
                                padding: '12px 20px',
                                background: `${C.elevated}88`,
                                borderBottom: `1px solid ${C.border}`,
                              }}>
                                <div style={{ fontSize: 12, color: C.sub, marginBottom: 8, fontWeight: 600 }}>Raw message</div>
                                <pre style={{
                                  fontSize: 11, color: C.muted, background: C.elevated,
                                  borderRadius: 8, padding: '10px 14px',
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                  maxHeight: 200, overflowY: 'auto',
                                  fontFamily: 'monospace', margin: 0,
                                }}>
                                  {log.raw_message}
                                </pre>

                                {Array.isArray(log.refs) && log.refs.length > 0 && (
                                  <div style={{ marginTop: 12 }}>
                                    <div style={{ fontSize: 12, color: C.sub, marginBottom: 6, fontWeight: 600 }}>Ref breakdown</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                      {log.refs.map((r, ri) => (
                                        <div key={ri} style={{
                                          display: 'flex', gap: 12, fontSize: 11,
                                          background: C.elevated, borderRadius: 6,
                                          padding: '6px 10px', alignItems: 'flex-start',
                                        }}>
                                          <span style={{ color: C.accent, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{r.ref}</span>
                                          <span style={{ color: C.muted }}>{r.error}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
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
                    <span style={{ fontSize: 12, color: C.sub, padding: '7px 12px' }}>{page} / {totalPages}</span>
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
