'use client';
import { useState, useEffect } from 'react';

const C = {
  accent: "#00E5A0", bg: "#0B0F1A", card: "#111827", elevated: "#1A2332",
  border: "#1E2D3D", text: "#F0F4F8", sub: "#8899AA", muted: "#556677",
  blue: "#5B8DEF",
};
const cardStyle = { background: '#111827', border: '1px solid #1E2D3D', borderRadius: 12, padding: 20, marginBottom: 16 };
const inputStyle = { background: '#0B0F1A', border: '1px solid #1E2D3D', borderRadius: 8, color: '#F0F4F8', padding: '8px 12px', fontSize: 13, outline: 'none' };
const btn = (bg, color, disabled) => ({ padding: '8px 18px', background: disabled ? '#1A2332' : bg, color: disabled ? '#556677' : color, border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer' });

const METRIC_LABELS = {
  providers_mapped: 'Providers Mapped', care_items_mapped: 'Care Items Mapped',
  care_items_grouped: 'Care Items Grouped', resolved_cares: 'Resolved Cares',
  claims_kenya: 'Kenya', claims_tanzania: 'Tanzania', claims_uganda: 'Uganda',
  claims_uap: 'UAP Old Mutual', claims_defmis: 'Defmis', claims_hadiel: 'Hadiel Tech', claims_axa: 'AXA',
  auto_pa_reviewed: 'Auto PA Reviewed', auto_pa_approved: 'Auto PA Approved',
  flagged_care_items: 'Flagged Care Items', icd10_adjusted: 'ICD10 Adjusted',
  benefits_set_up: 'Benefits Set Up', providers_assigned: 'Providers Assigned',
};
const MEDALS = ['🥇', '🥈', '🥉'];

function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [mon.toISOString().split('T')[0], sun.toISOString().split('T')[0]];
}
const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });

function exportWeeklyCSV(data, from, to) {
  if (!data?.by_person?.length) return;
  const allKeys = [...new Set(data.by_person.flatMap(p => Object.keys(p.totals)))];
  const headers = ['Name', 'Role', 'Days Reported', 'Total Output', ...allKeys.map(k => METRIC_LABELS[k] || k)];
  const rows = data.by_person.map(p => [
    p.person?.name || '', p.person?.role || '', p.days_reported, p.total_output,
    ...allKeys.map(k => p.totals[k] || 0),
  ]);
  // Team totals row
  rows.push(['TEAM TOTAL', '', data.by_person.reduce((a, p) => a + p.days_reported, 0),
    data.by_person.reduce((a, p) => a + p.total_output, 0),
    ...allKeys.map(k => data.team_totals[k] || 0)]);

  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `weekly-summary-${from}-${to}.csv`; a.click();
  URL.revokeObjectURL(url);
}

export default function WeeklyPage() {
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const [from, to] = getWeekRange(selectedDate);
    setLoading(true); setError(null);
    fetch(`/api/reports/weekly?from=${from}&to=${to}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedDate]);

  const [from, to] = getWeekRange(selectedDate);

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, paddingBottom: 60 }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '20px 32px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Weekly Summary</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: C.sub }}>Team performance aggregated by week</p>
      </div>

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 32px' }}>
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: C.sub }}>Pick any day in the week:</span>
          <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} style={inputStyle} />
          <span style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>{fmt(from)} – {fmt(to)}</span>
          <button onClick={() => exportWeeklyCSV(data, from, to)} disabled={!data?.by_person?.length}
            style={{ ...btn('#1A2332', C.accent, !data?.by_person?.length), border: '1px solid #00E5A030', marginLeft: 'auto' }}>
            ⬇ Export CSV
          </button>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>Loading weekly data…</div>}
        {error && <div style={{ textAlign: 'center', padding: 60, color: '#FF5C5C' }}>{error}</div>}

        {data && !loading && data.total_reports > 0 && (
          <>
            <div style={{ background: 'linear-gradient(135deg, #00B87D, #00E5A0)', borderRadius: 12, padding: 24, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 18, color: '#0B0F1A', marginBottom: 3 }}>
                Team Total Output — Week of {fmt(from)}
              </div>
              <div style={{ fontSize: 12, color: '#0B0F1A99', marginBottom: 14 }}>{data.total_reports} reports by {data.by_person?.length} members</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {Object.entries(data.team_totals || {}).filter(([, v]) => v > 0).map(([key, val]) => (
                  <div key={key} style={{ background: '#00000022', borderRadius: 8, padding: '8px 14px' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#0B0F1A' }}>{val.toLocaleString()}</div>
                    <div style={{ fontSize: 11, color: '#0B0F1A99' }}>{METRIC_LABELS[key] || key}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>🏆 Team Leaderboard</div>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 14 }}>Ranked by total numeric output this week</div>
              {(data.by_person || []).map((person, i) => (
                <div key={person.person?.id || i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 22, width: 32, textAlign: 'center' }}>{MEDALS[i] || `${i + 1}`}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontWeight: 600 }}>{person.person?.name}</span>
                      <span style={{ fontSize: 11, color: C.muted }}>{person.person?.role}</span>
                      <span style={{ fontSize: 10, background: '#5B8DEF22', color: C.blue, padding: '2px 8px', borderRadius: 20 }}>{person.days_reported}d</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {Object.entries(person.totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, val]) => (
                        <span key={key} style={{ fontSize: 10, background: C.elevated, color: C.sub, padding: '2px 7px', borderRadius: 5 }}>
                          {METRIC_LABELS[key] || key}: <strong style={{ color: C.text }}>{val}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 26, fontWeight: 700, color: C.accent }}>{person.total_output.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: C.muted }}>total</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginBottom: 12 }}>Individual Breakdown</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {(data.by_person || []).map((person, i) => (
                <div key={i} style={cardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                    <span style={{ fontWeight: 600 }}>{person.person?.name}</span>
                    <span style={{ fontSize: 11, color: C.sub }}>{person.days_reported}d / 5d</span>
                  </div>
                  {Object.entries(person.totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([key, val]) => (
                    <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ color: C.sub }}>{METRIC_LABELS[key] || key}</span>
                      <span style={{ fontWeight: 600 }}>{val.toLocaleString()}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 12, color: C.sub, fontWeight: 600 }}>Total</span>
                    <span style={{ fontSize: 16, fontWeight: 700, color: C.accent }}>{person.total_output.toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {data && data.total_reports === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: 60, color: C.sub }}>No reports for {fmt(from)} – {fmt(to)}.</div>
        )}
      </div>
    </div>
  );
}
