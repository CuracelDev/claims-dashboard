'use client';
import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';

function timeAgo(isoStr) {
  if (!isoStr) return null;
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function AINarrative() {
  const { C } = useTheme();
  const [insight,    setInsight]    = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [sending,    setSending]    = useState(false);
  const [slackSent,  setSlackSent]  = useState(false);
  const [slackMeta,  setSlackMeta]  = useState(null);
  const [lastFetch,  setLastFetch]  = useState(null);
  const [collapsed,  setCollapsed]  = useState(false);
  const [rawData,    setRawData]    = useState(null);
  const [error,      setError]      = useState(null);
  const [detail,     setDetail]     = useState('short');

  const fetchData = useCallback(async () => {
    const res  = await fetch('/api/insights');
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json;
  }, []);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSlackSent(false);
    setSlackMeta(null);
    try {
      const data = await fetchData();
      setRawData(data);
      const res  = await fetch('/api/ops-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, detail }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setInsight(json.insight);
      setLastFetch(new Date().toISOString());
    } catch (e) {
      setError('Could not generate insight. Try again.');
    } finally {
      setLoading(false);
    }
  }, [fetchData]);

  const sendToSlack = useCallback(async () => {
    if (!insight) return;
    setSending(true);
    try {
      const res = await fetch('/api/ops-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rawData, send_to_slack: true, insight }),
      });
      const json = await res.json();
      if (json.slack_ts) {
        setSlackSent(true);
        setSlackMeta({ ts: json.slack_ts, channel: json.slack_channel });
      }
    } catch {}
    finally { setSending(false); }
  }, [insight, rawData]);

  const kpis = rawData?.kpis || {};

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, marginBottom: 20, overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(p => !p)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', cursor: 'pointer',
          background: C.elevated, borderBottom: collapsed ? 'none' : `1px solid ${C.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#00E5A0' }}>⚡ Operations Insights</span>
          {loading
            ? <span style={{ fontSize: 11, color: C.sub }}>generating…</span>
            : lastFetch && <span style={{ fontSize: 11, color: C.muted }}>Updated {timeAgo(lastFetch)}</span>
          }
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {kpis.submission_rate !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: kpis.submission_rate === 100 ? '#00E5A022' : '#F59E0B22',
              color: kpis.submission_rate === 100 ? '#00E5A0' : '#F59E0B',
              border: `1px solid ${kpis.submission_rate === 100 ? '#00E5A033' : '#F59E0B33'}`,
            }}>{kpis.submission_rate}% submitted</span>
          )}
          {kpis.target_attainment !== null && kpis.target_attainment !== undefined && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: kpis.target_attainment >= 80 ? '#00E5A022' : kpis.target_attainment >= 50 ? '#5B8DEF22' : '#FF4D4D22',
              color: kpis.target_attainment >= 80 ? '#00E5A0' : kpis.target_attainment >= 50 ? '#5B8DEF' : '#FF4D4D',
              border: `1px solid ${kpis.target_attainment >= 80 ? '#00E5A033' : kpis.target_attainment >= 50 ? '#5B8DEF33' : '#FF4D4D33'}`,
            }}>{kpis.target_attainment}% targets on track</span>
          )}
          <span style={{ color: C.sub, fontSize: 16 }}>{collapsed ? '▾' : '▴'}</span>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{ padding: '16px' }}>
          {/* No insight yet */}
          {!insight && !loading && !error && (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 16 }}>
                Click Generate to get an AI-powered analysis of current team performance.
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, justifyContent: 'center' }}>
                {[['short','Brief summary'],['detailed','Detailed report']].map(([val, label]) => (
                  <button key={val} onClick={e => { e.stopPropagation(); setDetail(val); }} style={{
                    padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', border: `1px solid ${detail === val ? '#00E5A0' : '#1E2D45'}`,
                    background: detail === val ? '#00E5A018' : 'transparent',
                    color: detail === val ? '#00E5A0' : '#6B7A99',
                  }}>{label}</button>
                ))}
              </div>
              <button
                onClick={e => { e.stopPropagation(); generate(); }}
                style={{
                  padding: '9px 20px',
                  background: `linear-gradient(135deg, #7B61FF, #00E5A0)`,
                  border: 'none', borderRadius: 8,
                  fontSize: 13, fontWeight: 700, color: '#0B1929', cursor: 'pointer',
                }}
              >✦ Generate Insight</button>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
              <div style={{
                width: 16, height: 16, borderRadius: '50%',
                border: `2px solid #00E5A0`, borderTopColor: 'transparent',
                animation: 'spin 0.8s linear infinite', flexShrink: 0,
              }} />
              <span style={{ fontSize: 13, color: C.sub }}>Analysing team performance…</span>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div style={{ fontSize: 12, color: C.danger, marginBottom: 12 }}>⚠️ {error}</div>
          )}

          {/* Insight */}
          {insight && !loading && (
            <>
              <div style={{
                fontSize: 14, color: C.text, lineHeight: 1.75,
                background: C.elevated, borderRadius: 10,
                padding: '14px 16px', border: `1px solid ${C.border}`,
                marginBottom: 14,
              }}>
                <span style={{ color: '#00E5A0', fontWeight: 700, marginRight: 6 }}>"</span>
                {insight}
                <span style={{ color: '#00E5A0', fontWeight: 700, marginLeft: 6 }}>"</span>
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[['short','Brief'],['detailed','Detailed']].map(([val, label]) => (
                  <button key={val} onClick={e => { e.stopPropagation(); setDetail(val); }} style={{
                    padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', border: `1px solid ${detail === val ? '#00E5A0' : C.border}`,
                    background: detail === val ? '#00E5A018' : 'transparent',
                    color: detail === val ? '#00E5A0' : C.sub,
                  }}>{label}</button>
                ))}
                <button
                  onClick={e => { e.stopPropagation(); generate(); }}
                  style={{
                    padding: '7px 14px', background: C.elevated,
                    border: `1px solid ${C.border}`, borderRadius: 8,
                    fontSize: 12, fontWeight: 600, color: C.sub, cursor: 'pointer',
                  }}
                >↺ Regenerate</button>

                <button
                  onClick={e => { e.stopPropagation(); sendToSlack(); }}
                  disabled={sending || slackSent}
                  style={{
                    padding: '7px 14px',
                    background: slackSent ? '#00E5A022' : C.elevated,
                    border: `1px solid ${slackSent ? '#00E5A044' : C.border}`,
                    borderRadius: 8, fontSize: 12, fontWeight: 600,
                    color: slackSent ? '#00E5A0' : C.sub,
                    cursor: sending || slackSent ? 'default' : 'pointer',
                  }}
                >
                  {sending ? 'Sending…' : slackSent ? '✓ Sent to Slack' : '📤 Send to Slack'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Footer */}
      {!collapsed && (rawData || loading) && (
        <div style={{
          padding: '6px 16px', borderTop: `1px solid ${C.border}`,
          background: C.elevated, display: 'flex', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 10, color: C.muted }}>
            AI-generated · {rawData?.submission?.total || 0} team members
          </span>
          {rawData?.freshness?.last_report_at && (
            <span style={{ fontSize: 10, color: C.muted }}>
              Last report: {timeAgo(rawData.freshness.last_report_at)}
            </span>
          )}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
