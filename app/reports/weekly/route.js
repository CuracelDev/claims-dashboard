import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET(request) {
  const supabase = getSupabase();
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to   = searchParams.get('to');

  if (!from || !to) {
    return Response.json({ error: 'from and to date params required' }, { status: 400 });
  }

  try {
    // 1. Fetch all active team members independently — no FK join
    const { data: allMembers, error: membersError } = await supabase
      .from('team_members')
      .select('id, name, display_name, is_active')
      .eq('is_active', true);

    if (membersError) throw membersError;

    // Build lookup: stringified id → member
    const memberMap = {};
    for (const m of (allMembers || [])) {
      memberMap[String(m.id)] = m;
    }

    // 2. Fetch reports — NO FK join
    const { data: allReports, error: reportsError } = await supabase
      .from('daily_reports')
      .select('id, team_member_id, report_date, metrics, tasks_completed, notes, status')
      .order('report_date', { ascending: false })
      .limit(500);

    if (reportsError) throw reportsError;

    // 3. Client-side date filter
    const reports = (allReports || []).filter(r => {
      const d = (r.report_date || '').slice(0, 10);
      return d >= from && d <= to;
    });

    // 4. Aggregate by person — always stringify team_member_id for consistent key
    const byPerson = {};

    for (const report of reports) {
      const pid = String(report.team_member_id);
      const member = memberMap[pid] || { id: report.team_member_id, name: 'Unknown', display_name: null };

      if (!byPerson[pid]) {
        byPerson[pid] = {
          person: {
            id:           member.id,
            name:         member.display_name || member.name || 'Unknown',
            display_name: member.display_name,
          },
          days_reported: 0,
          totals: {},
          daily: [],
        };
      }

      byPerson[pid].days_reported += 1;
      byPerson[pid].daily.push({ date: report.report_date, metrics: report.metrics });

      const m = report.metrics || {};
      for (const [key, val] of Object.entries(m)) {
        const num = parseInt(val);
        if (!isNaN(num)) byPerson[pid].totals[key] = (byPerson[pid].totals[key] || 0) + num;
      }
    }

    // 5. Sort by total output descending
    const leaderboard = Object.values(byPerson).map(p => ({
      ...p,
      total_output: Object.values(p.totals).reduce((a, b) => a + b, 0),
    })).sort((a, b) => b.total_output - a.total_output);

    // 6. Team totals
    const teamTotals = {};
    for (const p of leaderboard) {
      for (const [key, val] of Object.entries(p.totals)) {
        teamTotals[key] = (teamTotals[key] || 0) + val;
      }
    }

    return Response.json({
      from,
      to,
      total_reports: reports.length,
      by_person: leaderboard,
      team_totals: teamTotals,
    });

  } catch (err) {
    console.error('[weekly route error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
