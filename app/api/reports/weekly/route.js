// PATH: app/api/insights/route.js
// Single intelligence endpoint — powers InsightBanner across all pages

import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function localDateStr(offsetDays = 0) {
  const d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
const todayStr = () => localDateStr();
const yesterdayStr = () => localDateStr(-1);
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return mon.toISOString().split('T')[0];
}
function lastWeekRange() {
  const d = new Date(); d.setDate(d.getDate() - 7);
  const ds = d.toISOString().split('T')[0];
  const start = weekStart(ds);
  const end = new Date(start + 'T12:00:00');
  end.setDate(end.getDate() + 6);
  return { from: start, to: end.toISOString().split('T')[0] };
}
function pct(a, b) {
  if (!b) return null;
  return Math.round(((a - b) / b) * 100);
}

export async function GET() {
  const supabase = getSupabase();
  const TODAY     = todayStr();
  const YESTERDAY = yesterdayStr();
  const WEEK_FROM = weekStart(TODAY);
  const lw        = lastWeekRange();

  try {
    // ── Parallel fetches ──────────────────────────────────────────────
    const [membersRes, reportsRes, targetsRes, logsRes, leaveRes] = await Promise.all([
      supabase.from('team_members').select('id, name, display_name, is_active').eq('is_active', true),
      supabase.from('daily_reports').select('team_member_id, report_date, metrics, created_at').order('report_date', { ascending: false }).limit(200),
      supabase.from('weekly_targets').select('*').lte('start_date', TODAY).gte('end_date', TODAY),
      supabase.from('target_logs').select('target_id, date, value').gte('date', WEEK_FROM),
      supabase.from('leave_records').select('team_member_id').lte('start_date', TODAY).gte('end_date', TODAY),
    ]);

    const members  = membersRes.data  || [];
    const reports  = reportsRes.data  || [];
    const targets  = targetsRes.data  || [];
    const logs     = logsRes.data     || [];
    const onLeave  = (leaveRes.data   || []).map(l => String(l.team_member_id));

    const memberMap = {};
    for (const m of members) memberMap[String(m.id)] = m;

    // ── 1. Submission status ──────────────────────────────────────────
    const submittedToday = reports
      .filter(r => r.report_date?.slice(0, 10) === TODAY)
      .map(r => String(r.team_member_id));

    const pendingMembers = members
      .filter(m => !submittedToday.includes(String(m.id)) && !onLeave.includes(String(m.id)))
      .map(m => m.display_name || m.name);

    const submission = {
      submitted:  submittedToday.length,
      total:      members.length,
      on_leave:   onLeave.length,
      pending:    pendingMembers,
    };

    // ── 2. Today vs Yesterday metric deltas ───────────────────────────
    const sumMetrics = (dateStr) => {
      const dayReports = reports.filter(r => r.report_date?.slice(0, 10) === dateStr);
      const totals = {};
      for (const r of dayReports) {
        const m = r.metrics || {};
        for (const [k, v] of Object.entries(m)) {
          const n = parseInt(v); if (!isNaN(n)) totals[k] = (totals[k] || 0) + n;
        }
      }
      return totals;
    };

    const todayTotals     = sumMetrics(TODAY);
    const yesterdayTotals = sumMetrics(YESTERDAY);

    const KEY_METRICS = [
      { key: 'care_items_mapped',  label: 'Care Items Mapped' },
      { key: 'resolved_cares',     label: 'Resolved Cares' },
      { key: 'providers_mapped',   label: 'Providers Mapped' },
      { key: 'care_items_grouped', label: 'Care Items Grouped' },
      { key: 'flagged_care_items', label: 'QA Flags' },
    ];

    const today_vs_yesterday = KEY_METRICS.map(m => ({
      key:       m.key,
      label:     m.label,
      today:     todayTotals[m.key] || 0,
      yesterday: yesterdayTotals[m.key] || 0,
      pct_change: pct(todayTotals[m.key] || 0, yesterdayTotals[m.key] || 0),
    }));

    // ── 3. This week vs Last week ─────────────────────────────────────
    const sumRange = (from, to) => {
      const rangeReports = reports.filter(r => {
        const d = r.report_date?.slice(0, 10);
        return d >= from && d <= to;
      });
      const totals = {};
      for (const r of rangeReports) {
        const m = r.metrics || {};
        for (const [k, v] of Object.entries(m)) {
          const n = parseInt(v); if (!isNaN(n)) totals[k] = (totals[k] || 0) + n;
        }
      }
      return totals;
    };

    const thisWeekTotals = sumRange(WEEK_FROM, TODAY);
    const lastWeekTotals = sumRange(lw.from, lw.to);

    const week_vs_lastweek = KEY_METRICS.map(m => ({
      key:        m.key,
      label:      m.label,
      this_week:  thisWeekTotals[m.key] || 0,
      last_week:  lastWeekTotals[m.key] || 0,
      pct_change: pct(thisWeekTotals[m.key] || 0, lastWeekTotals[m.key] || 0),
    }));

    // ── 4. Targets pace ───────────────────────────────────────────────
    const targetInsights = targets.map(t => {
      const tLogs = logs.filter(l => l.target_id === t.id);
      let actual = 0;

      if (t.metric_key && todayTotals[t.metric_key] !== undefined) {
        // Auto-pull from daily reports for current week
        actual = thisWeekTotals[t.metric_key] || 0;
      } else if (t.type === 'number') {
        actual = tLogs.reduce((sum, l) => sum + (parseFloat(l.value) || 0), 0);
      } else if (t.type === 'yesno') {
        actual = tLogs.some(l => l.value === 'yes' || l.value === 'true') ? 1 : 0;
      } else if (t.type === 'percentage') {
        const latest = tLogs.sort((a, b) => b.date > a.date ? 1 : -1)[0];
        actual = latest ? parseFloat(latest.value) || 0 : 0;
      }

      const target_value = parseFloat(t.target_value) || 0;
      const pct_complete = target_value > 0 ? Math.min(100, Math.round((actual / target_value) * 100)) : null;

      // Days remaining
      const end = new Date(t.end_date + 'T12:00:00');
      const now = new Date();
      const days_left = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));

      // Pace: needed per day vs achieved per day
      const start = new Date(t.start_date + 'T12:00:00');
      const total_days = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
      const days_elapsed = Math.max(1, total_days - days_left);
      const needed_per_day = target_value / total_days;
      const achieved_per_day = actual / days_elapsed;
      const pace_ratio = needed_per_day > 0 ? achieved_per_day / needed_per_day : 1;

      const pace = pct_complete >= 100 ? 'hit'
        : pace_ratio >= 0.8 ? 'on_track'
        : pace_ratio >= 0.5 ? 'at_risk'
        : 'behind';

      return {
        id:           t.id,
        name:         t.name,
        type:         t.type,
        target_value,
        actual,
        pct_complete,
        pace,
        days_left,
      };
    });

    // ── 5. QA flag spike ──────────────────────────────────────────────
    let qa_flags = null;
    try {
      const { data: qaToday }     = await supabase.from('qa_flags').select('id', { count: 'exact' }).eq('created_at::date', TODAY);
      const { data: qaYesterday } = await supabase.from('qa_flags').select('id', { count: 'exact' }).eq('created_at::date', YESTERDAY);
      const todayCount     = qaToday?.length     || 0;
      const yesterdayCount = qaYesterday?.length || 0;
      qa_flags = {
        today:      todayCount,
        yesterday:  yesterdayCount,
        pct_change: pct(todayCount, yesterdayCount),
        spike:      todayCount > 0 && yesterdayCount > 0 && todayCount > yesterdayCount * 1.3,
      };
    } catch (_) {
      qa_flags = null; // qa_flags table may not have date cast support — safe fallback
    }

    // ── 6. Freshness ──────────────────────────────────────────────────
    const recentReport = reports[0];
    const freshness = {
      last_report_at: recentReport?.created_at || null,
      last_report_date: recentReport?.report_date?.slice(0, 10) || null,
    };

    // ── 7. Derived KPIs ───────────────────────────────────────────────
    const activeMembers = members.filter(m => !onLeave.includes(String(m.id))).length;
    const submission_rate = activeMembers > 0 ? Math.round((submission.submitted / activeMembers) * 100) : 0;
    const targets_hit = targetInsights.filter(t => t.pace === 'hit' || t.pct_complete >= 100).length;
    const target_attainment = targets.length > 0 ? Math.round((targets_hit / targets.length) * 100) : null;

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
    console.error('[insights route error]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
