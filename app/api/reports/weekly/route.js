import { getSupabase } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const supabase = getSupabase();
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!from || !to) {
    return Response.json({ error: 'from and to date params required' }, { status: 400 });
  }

  try {
    // Fetch recent reports and filter in JS — avoids Supabase date-type comparison issues
    const { data: allReports, error } = await supabase
      .from('daily_reports')
      .select('*, team_members (id, name, role)')
      .order('report_date', { ascending: false })
      .limit(500);

    if (error) throw error;

    // Client-side date filter (robust against column type variations)
    const reports = (allReports || []).filter(r => {
      const d = (r.report_date || '').slice(0, 10);
      return d >= from && d <= to;
    });

    const byPerson = {};
    for (const report of reports) {
      const personId = report.team_member_id;
      if (!byPerson[personId]) {
        byPerson[personId] = { person: report.team_members, days_reported: 0, totals: {}, daily: [] };
      }
      byPerson[personId].days_reported += 1;
      byPerson[personId].daily.push({ date: report.report_date, metrics: report.metrics });
      const m = report.metrics || {};
      for (const [key, val] of Object.entries(m)) {
        const num = parseInt(val);
        if (!isNaN(num)) byPerson[personId].totals[key] = (byPerson[personId].totals[key] || 0) + num;
      }
    }

    const leaderboard = Object.values(byPerson).map(p => ({
      ...p,
      total_output: Object.values(p.totals).reduce((a, b) => a + b, 0)
    })).sort((a, b) => b.total_output - a.total_output);

    const teamTotals = {};
    for (const p of leaderboard) {
      for (const [key, val] of Object.entries(p.totals)) {
        teamTotals[key] = (teamTotals[key] || 0) + val;
      }
    }

    return Response.json({ from, to, total_reports: reports.length, by_person: leaderboard, team_totals: teamTotals });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
