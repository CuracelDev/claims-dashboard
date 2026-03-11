import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function toLocalYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseYMD(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function localDateStr(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return toLocalYMD(d);
}

const todayStr = () => localDateStr(0);
const yesterdayStr = () => localDateStr(-1);

function weekStart(dateStr) {
  const d = parseYMD(dateStr);
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return toLocalYMD(mon);
}

function lastWeekRange() {
  const d = parseYMD(todayStr());
  d.setDate(d.getDate() - 7);
  const ds = toLocalYMD(d);
  const start = weekStart(ds);
  const end = parseYMD(start);
  end.setDate(end.getDate() + 6);
  return { from: start, to: toLocalYMD(end) };
}

function pct(a, b) {
  if (!b) return null;
  return Math.round(((a - b) / b) * 100);
}

function normalizeDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return toLocalYMD(parsed);

  return null;
}

export async function GET() {
  const supabase = getSupabase();
  const TODAY = todayStr();
  const YESTERDAY = yesterdayStr();
  const WEEK_FROM = weekStart(TODAY);
  const lw = lastWeekRange();

  try {
    const [membersRes, reportsRes, targetsRes, logsRes, leaveRes] = await Promise.all([
      supabase
        .from('team_members')
        .select('id, name, display_name, is_active')
        .eq('is_active', true),

      supabase
        .from('daily_reports')
        .select('id, team_member_id, report_date, metrics, created_at, status')
        .gte('report_date', lw.from)
        .lte('report_date', TODAY)
        .order('report_date', { ascending: false })
        .order('created_at', { ascending: false }),

      supabase
        .from('weekly_targets')
        .select('*')
        .lte('start_date', TODAY)
        .gte('end_date', TODAY),

      supabase
        .from('target_logs')
        .select('target_id, date, value')
        .gte('date', lw.from),

      supabase
        .from('leave_records')
        .select('team_member_id')
        .lte('start_date', TODAY)
        .gte('end_date', TODAY),
    ]);

    if (membersRes.error) throw membersRes.error;
    if (reportsRes.error) throw reportsRes.error;
    if (targetsRes.error) throw targetsRes.error;
    if (logsRes.error) throw logsRes.error;
    if (leaveRes.error) throw leaveRes.error;

    const members = membersRes.data || [];
    const rawReports = reportsRes.data || [];
    const targets = targetsRes.data || [];
    const logs = logsRes.data || [];
    const onLeave = (leaveRes.data || []).map((l) => String(l.team_member_id));

    const dedupeMap = new Map();
    for (const r of rawReports) {
      const rd = normalizeDate(r.report_date);
      if (!rd) continue;
      const key = `${r.team_member_id}__${rd}`;
      if (!dedupeMap.has(key)) {
        dedupeMap.set(key, { ...r, report_date: rd });
      }
    }
    const reports = Array.from(dedupeMap.values());

    const submittedTodayIds = [
      ...new Set(
        reports
          .filter((r) => r.report_date === TODAY)
          .map((r) => String(r.team_member_id))
      ),
    ];

    const pendingMembers = members
      .filter(
        (m) =>
          !submittedTodayIds.includes(String(m.id)) &&
          !onLeave.includes(String(m.id))
      )
      .map((m) => m.display_name || m.name);

    const submission = {
      submitted: submittedTodayIds.length,
      total: members.length,
      on_leave: onLeave.length,
      pending: pendingMembers,
    };

    const sumMetricsForReports = (rows) => {
      const totals = {};
      for (const r of rows) {
        const m = r.metrics || {};
        for (const [k, v] of Object.entries(m)) {
          const n = Number(v);
          if (Number.isFinite(n)) totals[k] = (totals[k] || 0) + n;
        }
      }
      return totals;
    };

    const todayTotals = sumMetricsForReports(
      reports.filter((r) => r.report_date === TODAY)
    );

    const yesterdayTotals = sumMetricsForReports(
      reports.filter((r) => r.report_date === YESTERDAY)
    );

    const KEY_METRICS = [
      { key: 'care_items_mapped', label: 'Care Items Mapped' },
      { key: 'resolved_cares', label: 'Resolved Cares' },
      { key: 'providers_mapped', label: 'Providers Mapped' },
      { key: 'care_items_grouped', label: 'Care Items Grouped' },
      { key: 'flagged_care_items', label: 'QA Flags' },
    ];

    const today_vs_yesterday = KEY_METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      today: todayTotals[m.key] || 0,
      yesterday: yesterdayTotals[m.key] || 0,
      pct_change: pct(todayTotals[m.key] || 0, yesterdayTotals[m.key] || 0),
    }));

    const inRange = (d, from, to) => d >= from && d <= to;

    const thisWeekTotals = sumMetricsForReports(
      reports.filter((r) => inRange(r.report_date, WEEK_FROM, TODAY))
    );

    const lastWeekTotals = sumMetricsForReports(
      reports.filter((r) => inRange(r.report_date, lw.from, lw.to))
    );

    const week_vs_lastweek = KEY_METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      this_week: thisWeekTotals[m.key] || 0,
      last_week: lastWeekTotals[m.key] || 0,
      pct_change: pct(thisWeekTotals[m.key] || 0, lastWeekTotals[m.key] || 0),
    }));

    const targetInsights = targets.map((t) => {
      const tLogs = logs.filter((l) => l.target_id === t.id);
      let actual = 0;

      if (t.metric_key) {
        const scopedReports = reports.filter(
          (r) => r.report_date >= t.start_date && r.report_date <= t.end_date
        );
        actual = scopedReports.reduce(
          (sum, r) => sum + (Number(r.metrics?.[t.metric_key]) || 0),
          0
        );
      } else if (t.type === 'number') {
        actual = tLogs.reduce((sum, l) => sum + (parseFloat(l.value) || 0), 0);
      } else if (t.type === 'yesno') {
        actual = tLogs.some((l) => l.value === 'yes' || l.value === 'true') ? 1 : 0;
      } else if (t.type === 'percentage') {
        const latest = [...tLogs].sort((a, b) => (b.date > a.date ? 1 : -1))[0];
        actual = latest ? parseFloat(latest.value) || 0 : 0;
      }

      const target_value = parseFloat(t.target_value) || 0;
      const pct_complete =
        target_value > 0 ? Math.min(100, Math.round((actual / target_value) * 100)) : null;

      const end = parseYMD(t.end_date);
      const now = new Date();
      now.setHours(12, 0, 0, 0);
      const days_left = Math.max(0, Math.ceil((end - now) / 86400000));

      const start = parseYMD(t.start_date);
      const total_days = Math.max(1, Math.ceil((end - start) / 86400000) + 1);
      const days_elapsed = Math.max(1, total_days - days_left);
      const needed_per_day = target_value / total_days;
      const achieved_per_day = actual / days_elapsed;
      const pace_ratio = needed_per_day > 0 ? achieved_per_day / needed_per_day : 1;

      const pace =
        pct_complete >= 100
          ? 'hit'
          : pace_ratio >= 0.8
          ? 'on_track'
          : pace_ratio >= 0.5
          ? 'at_risk'
          : 'behind';

      return {
        id: t.id,
        name: t.name,
        type: t.type,
        target_value,
        actual,
        pct_complete,
        pace,
        days_left,
      };
    });

    let qa_flags = null;
    try {
      const { data: qaRows } = await supabase
        .from('qa_flags')
        .select('created_at');

      const qaAll = qaRows || [];
      const qaTodayCount = qaAll.filter((r) => normalizeDate(r.created_at) === TODAY).length;
      const qaYesterdayCount = qaAll.filter((r) => normalizeDate(r.created_at) === YESTERDAY).length;

      qa_flags = {
        today: qaTodayCount,
        yesterday: qaYesterdayCount,
        pct_change: pct(qaTodayCount, qaYesterdayCount),
        spike:
          qaTodayCount > 0 &&
          qaYesterdayCount > 0 &&
          qaTodayCount > qaYesterdayCount * 1.3,
      };
    } catch (_) {
      qa_flags = null;
    }

    const newestReport = [...reports].sort((a, b) => {
      const av = new Date(a.created_at).getTime();
      const bv = new Date(b.created_at).getTime();
      return bv - av;
    })[0];

    const freshness = {
      last_report_at: newestReport?.created_at || null,
      last_report_date: newestReport?.report_date || null,
    };

    const activeMembers = members.filter((m) => !onLeave.includes(String(m.id))).length;
    const submission_rate =
      activeMembers > 0 ? Math.round((submission.submitted / activeMembers) * 100) : 0;

    const targets_hit = targetInsights.filter(
      (t) => t.pace === 'hit' || (t.pct_complete ?? 0) >= 100
    ).length;

    const target_attainment =
      targets.length > 0 ? Math.round((targets_hit / targets.length) * 100) : null;

    const kpis = {
      submission_rate,
      active_members: activeMembers,
      target_attainment,
      targets_total: targets.length,
      targets_hit,
    };

    return Response.json({
      generated_at: new Date().toISOString(),
      today: TODAY,
      submission,
      today_vs_yesterday,
      week_vs_lastweek,
      targets: targetInsights,
      qa_flags,
      freshness,
      kpis,
    });
  } catch (err) {
    console.error('[insights route error]', err);
    return Response.json({ error: err?.message || 'Unknown server error' }, { status: 500 });
  }
}
