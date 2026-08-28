import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { decryptCredentialFields } from '../../../../lib/piles-auto-assignment-credentials.mjs';

export const dynamic = 'force-dynamic';

function isMissingTableError(error) {
  return /does not exist|relation .* not found|42P01/i.test(String(error?.message || error || ''));
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const [masterRes, botsRes, rulesRes, metricsRes, logsRes, trackedRes, externalRes, weekendRostersRes, weekendMembersRes] = await Promise.all([
      supabase.from('piles_auto_assignment_master_accounts').select('*').order('insurer_name', { ascending: true }),
      supabase.from('piles_auto_assignment_bot_accounts').select('*').order('insurer_name', { ascending: true }),
      supabase.from('piles_auto_assignment_rules').select('*').order('insurer_name', { ascending: true }),
      supabase.from('piles_auto_assignment_bot_metrics').select('*').order('updated_at', { ascending: false }),
      supabase.from('piles_auto_assignment_logs').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('piles_auto_assignment_tracked_piles').select('*').order('updated_at', { ascending: false }).limit(250),
      supabase.from('piles_auto_assignment_external_assignments').select('*').order('last_seen_at', { ascending: false }).limit(250),
      supabase.from('piles_auto_assignment_weekend_rosters').select('*').order('weekend_start', { ascending: false }).limit(20),
      supabase.from('piles_auto_assignment_weekend_roster_members').select('*').order('updated_at', { ascending: false }).limit(200),
    ]);

    const coreResponses = [masterRes, botsRes, rulesRes, metricsRes, logsRes, trackedRes, externalRes];
    const weekendResponses = [weekendRostersRes, weekendMembersRes];
    const firstCoreError = coreResponses.find((res) => res.error);
    if (firstCoreError?.error) throw firstCoreError.error;
    const weekendSchemaReady = weekendResponses.every((res) => !res.error);
    if (!weekendSchemaReady && !weekendResponses.every((res) => !res.error || isMissingTableError(res.error))) {
      throw weekendResponses.find((res) => res.error)?.error;
    }

    const masterAccounts = (masterRes.data || []).map((item) => ({
      ...decryptCredentialFields(item, ['login_email']),
      login_password: '',
      has_login_password: Boolean(item.login_password),
    }));
    const botAccounts = (botsRes.data || []).map((item) => ({
      ...decryptCredentialFields(item, ['bot_email']),
      bot_password: '',
      has_bot_password: Boolean(item.bot_password),
    }));
    const rules = rulesRes.data || [];
    const botMetrics = metricsRes.data || [];
    const recentLogs = logsRes.data || [];
    const trackedPiles = trackedRes.data || [];
    const knownBotIds = new Set(botAccounts.map((bot) => String(bot.id)).filter(Boolean));
    const externalAssignments = (externalRes.data || []).filter((item) => (
      item.bot_account_id && knownBotIds.has(String(item.bot_account_id))
    ));
    const weekendRosters = weekendSchemaReady ? (weekendRostersRes.data || []) : [];
    const weekendRosterMembers = weekendSchemaReady ? (weekendMembersRes.data || []) : [];

    const activeMasterKeys = new Set(
      masterAccounts
        .filter((account) => account.is_active !== false)
        .map((account) => {
          const key = String(account.insurer_name || '').trim().toLowerCase();
          return key === 'uapom' ? 'old mutual' : key;
        })
    );
    const runnerEligibleBots = botAccounts.filter((bot) => {
      const key = String(bot.insurer_name || '').trim().toLowerCase();
      return activeMasterKeys.has(key === 'uapom' ? 'old mutual' : key);
    });
    const activeBots = runnerEligibleBots.filter((bot) => bot.is_active);
    const availableBots = runnerEligibleBots.filter((bot) => bot.is_active && bot.is_available);
    const primaryBots = activeBots.filter((bot) => bot.assignment_role === 'primary');
    const supportBots = activeBots.filter((bot) => bot.assignment_role === 'support');
    const activeTrackedPiles = trackedPiles.filter((pile) => pile.is_active);
    const staleTrackedPiles = trackedPiles.filter((pile) => pile.is_active && pile.is_stale);
    const completedTrackedPiles = trackedPiles.filter((pile) => !pile.is_active && pile.completed_at);
    const activeExternalAssignments = externalAssignments.filter((item) => item.is_active);
    const lateArrivalPileDetections = recentLogs
      .filter((row) => row.event_type === 'late_arrival_detected')
      .reduce((sum, row) => sum + Number(row.pile_count || 0), 0);
    const avgClaimsPerHour = botMetrics.length
      ? botMetrics.reduce((sum, row) => sum + Number(row.claims_per_hour || 0), 0) / botMetrics.length
      : 0;

    return NextResponse.json({
      success: true,
      overview: {
        insurersConfigured: masterAccounts.length,
        activeMasterAccounts: masterAccounts.filter((account) => account.is_active !== false).length,
        activeBots: activeBots.length,
        availableBots: availableBots.length,
        primaryBots: primaryBots.length,
        supportBots: supportBots.length,
        activeRules: rules.filter((rule) => rule.is_active).length,
        averageClaimsPerHour: Number(avgClaimsPerHour.toFixed(2)),
        activeClaimLoad: botMetrics.reduce((sum, row) => sum + Number(row.active_claim_load || 0), 0),
        recentAssignmentEvents: recentLogs.filter((row) => row.event_type === 'assignment').length,
        activeTrackedPiles: activeTrackedPiles.length,
        staleTrackedPiles: staleTrackedPiles.length,
        completedTrackedPiles: completedTrackedPiles.length,
        activeExternalAssignments: activeExternalAssignments.length,
        lateArrivalPileDetections,
        weekendRostersConfigured: weekendRosters.length,
      },
      masterAccounts,
      botAccounts,
      rules,
      botMetrics,
      recentLogs,
      trackedPiles,
      externalAssignments,
      weekendRosters,
      weekendRosterMembers,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
