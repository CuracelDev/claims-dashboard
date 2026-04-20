import { getSupabase } from '../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function normalizeDate(value) {
  if (!value) return null;

  const raw = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, dd, mm, yyyy] = slashMatch;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function sumMetricValues(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return 0;
  return Object.values(metrics).reduce((sum, val) => {
    const num = Number(val);
    return Number.isFinite(num) ? sum + num : sum;
  }, 0);
}

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);

    const rawFrom = searchParams.get('from');
    const rawTo = searchParams.get('to');

    const from = normalizeDate(rawFrom);
    const to = normalizeDate(rawTo);

    if (!from || !to) {
      return Response.json(
        {
          error: 'Valid from and to date params are required',
          received: { from: rawFrom, to: rawTo },
        },
        { status: 400 }
      );
    }

    const { data: allMembersRaw, error: membersError } = await supabase
      .from('team_members')
      .select('id, name, display_name, active, is_active');

    if (membersError) throw membersError;

    const allMembers = (allMembersRaw || []).filter(
      (m) => m.active !== false && m.is_active !== false
    );

    const { data: rawReports, error: reportsError } = await supabase
      .from('daily_reports')
      .select('id, team_member_id, report_date, metrics, tasks_completed, notes, status, created_at')
      .gte('report_date', from)
      .lte('report_date', to)
      .order('report_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(10000);

    if (reportsError) throw reportsError;

    const memberMap = {};
    for (const m of allMembers || []) {
      memberMap[String(m.id)] = m;
    }

    const dedupeMap = new Map();

    for (const report of rawReports || []) {
      const normalizedReportDate = normalizeDate(report.report_date);
      if (!normalizedReportDate) continue;
      if (normalizedReportDate < from || normalizedReportDate > to) continue;

      const pid = String(report.team_member_id);
      const key = `${pid}__${normalizedReportDate}`;

      if (!dedupeMap.has(key)) {
        dedupeMap.set(key, {
          ...report,
          report_date: normalizedReportDate,
        });
      }
    }

    const reports = Array.from(dedupeMap.values());
    const byPerson = {};

    for (const report of reports) {
      const pid = String(report.team_member_id);
      const member =
        memberMap[pid] || {
          id: report.team_member_id,
          name: 'Unknown',
          display_name: null,
        };

      if (!byPerson[pid]) {
        byPerson[pid] = {
          person: {
            id: member.id,
            name: member.display_name || member.name || 'Unknown',
            display_name: member.display_name,
          },
          days_reported: 0,
          totals: {},
          daily: [],
        };
      }

      byPerson[pid].days_reported += 1;
      byPerson[pid].daily.push({
        date: report.report_date,
        metrics: report.metrics || {},
        status: report.status || 'submitted',
        tasks_completed: report.tasks_completed || null,
        notes: report.notes || null,
      });

      const metrics = report.metrics || {};
      for (const [key, val] of Object.entries(metrics)) {
        const num = Number(val);
        if (Number.isFinite(num)) {
          byPerson[pid].totals[key] = (byPerson[pid].totals[key] || 0) + num;
        }
      }
    }

    const leaderboard = Object.values(byPerson)
      .map((p) => ({
        ...p,
        total_output: sumMetricValues(p.totals),
      }))
      .sort((a, b) => b.total_output - a.total_output);

    const teamTotals = {};
    for (const p of leaderboard) {
      for (const [key, val] of Object.entries(p.totals)) {
        const num = Number(val);
        if (Number.isFinite(num)) {
          teamTotals[key] = (teamTotals[key] || 0) + num;
        }
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
    console.error('[weekly route error]', err);
    return Response.json(
      { error: err?.message || 'Unknown server error' },
      { status: 500 }
    );
  }
}
