'use client';
import { useState, useEffect } from 'react';

const METRIC_LABELS = {
  providers_mapped: 'Providers Mapped',
  care_items_mapped: 'Care Items Mapped',
  care_items_grouped: 'Care Items Grouped',
  resolved_cares: 'Resolved Cares',
  claims_kenya: 'Kenya',
  claims_tanzania: 'Tanzania',
  claims_uganda: 'Uganda',
  claims_uap: 'UAP Old Mutual',
  claims_defmis: 'Defmis',
  claims_hadiel: 'Hadiel Tech',
  claims_axa: 'AXA',
  auto_pa_reviewed: 'Auto PA Reviewed',
  auto_pa_approved: 'Auto PA Approved',
  flagged_care_items: 'Flagged Care Items',
  icd10_adjusted: 'ICD10 Adjusted (Jubilee)',
  benefits_set_up: 'Benefits Set Up',
  providers_assigned: 'Providers Assigned',
};

// Get Monday and Sunday for a given date
function getWeekRange(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return [mon.toISOString().split('T')[0], sun.toISOString().split('T')[0]];
}

function fmt(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}

const MEDALS = ['🥇', '🥈', '🥉'];

export default function WeeklyPage() {
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const [from, to] = getWeekRange(selectedDate);
    setLoading(true);
    setError(null);
    fetch(`/api/reports/weekly?from=${from}&to=${to}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedDate]);

  const [from, to] = getWeekRange(selectedDate);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">Weekly Summary</h1>
          <p className="text-sm text-gray-500 mt-0.5">Team performance aggregated by week</p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">

        {/* Week selector */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex items-center gap-4">
          <label className="text-sm text-gray-600 font-medium">Pick any day in the week:</label>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-500 font-medium">
            Showing: {fmt(from)} – {fmt(to)}
          </span>
        </div>

        {loading && <div className="text-center py-16 text-gray-400">Loading weekly data…</div>}
        {error && <div className="text-center py-16 text-red-500">{error}</div>}

        {data && !loading && (
          <>
            {/* Team totals banner */}
            <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-5 mb-6 text-white">
              <h2 className="font-semibold text-lg mb-1">Team Total Output — Week of {fmt(from)}</h2>
              <p className="text-blue-100 text-sm mb-4">{data.total_reports} reports submitted by {data.by_person?.length} team members</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {Object.entries(data.team_totals || {}).filter(([, v]) => v > 0).map(([key, val]) => (
                  <div key={key} className="bg-white/15 rounded-lg px-3 py-2">
                    <div className="text-xl font-bold">{val.toLocaleString()}</div>
                    <div className="text-xs text-blue-100">{METRIC_LABELS[key] || key}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Leaderboard */}
            <div className="bg-white rounded-lg border border-gray-200 mb-6">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-semibold text-gray-800">🏆 Team Leaderboard</h3>
                <p className="text-xs text-gray-500 mt-0.5">Ranked by total numeric output this week</p>
              </div>
              <div className="divide-y divide-gray-50">
                {(data.by_person || []).map((person, i) => (
                  <div key={person.person?.id} className="px-5 py-4 flex items-center gap-4">
                    <span className="text-xl w-8 text-center">{MEDALS[i] || `${i + 1}`}</span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-800">{person.person?.name}</span>
                        <span className="text-xs text-gray-400">{person.person?.role}</span>
                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">
                          {person.days_reported} day{person.days_reported !== 1 ? 's' : ''} reported
                        </span>
                      </div>
                      {/* Top 4 metrics */}
                      <div className="flex flex-wrap gap-2 mt-2">
                        {Object.entries(person.totals)
                          .filter(([, v]) => v > 0)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 5)
                          .map(([key, val]) => (
                            <span key={key} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                              {METRIC_LABELS[key] || key}: <strong>{val}</strong>
                            </span>
                          ))}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-gray-800">{person.total_output.toLocaleString()}</div>
                      <div className="text-xs text-gray-400">total</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Per-person detail cards */}
            <h3 className="font-semibold text-gray-700 mb-3">Individual Breakdown</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {(data.by_person || []).map(person => (
                <div key={person.person?.id} className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-semibold text-gray-800">{person.person?.name}</span>
                    <span className="text-xs text-gray-500">{person.days_reported}d / 5d</span>
                  </div>
                  <div className="space-y-1.5">
                    {Object.entries(person.totals)
                      .filter(([, v]) => v > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, val]) => (
                        <div key={key} className="flex justify-between text-sm">
                          <span className="text-gray-600">{METRIC_LABELS[key] || key}</span>
                          <span className="font-semibold text-gray-800">{val.toLocaleString()}</span>
                        </div>
                      ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between text-sm font-semibold">
                    <span className="text-gray-600">Total output</span>
                    <span className="text-blue-600">{person.total_output.toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {data && data.total_reports === 0 && !loading && (
          <div className="text-center py-16 text-gray-400">
            No reports for the week of {fmt(from)} – {fmt(to)}.
          </div>
        )}
      </div>
    </div>
  );
}
