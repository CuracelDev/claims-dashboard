import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { decryptCredentialFields } from '../../../../lib/piles-auto-assignment-credentials.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = getSupabase();
    const [masterRes, botsRes, rulesRes, metricsRes, logsRes] = await Promise.all([
      supabase.from('piles_auto_assignment_master_accounts').select('*').order('insurer_name', { ascending: true }),
      supabase.from('piles_auto_assignment_bot_accounts').select('*').order('insurer_name', { ascending: true }),
      supabase.from('piles_auto_assignment_rules').select('*').order('insurer_name', { ascending: true }),
      supabase.from('piles_auto_assignment_bot_metrics').select('*').order('updated_at', { ascending: false }),
      supabase.from('piles_auto_assignment_logs').select('*').order('created_at', { ascending: false }).limit(25),
    ]);

    const responses = [masterRes, botsRes, rulesRes, metricsRes, logsRes];
    const firstError = responses.find((res) => res.error);
    if (firstError?.error) throw firstError.error;

    const masterAccounts = (masterRes.data || []).map((item) => decryptCredentialFields(item, ['login_email', 'login_password']));
    const botAccounts = (botsRes.data || []).map((item) => decryptCredentialFields(item, ['bot_email', 'bot_password']));
    const rules = rulesRes.data || [];
    const botMetrics = metricsRes.data || [];
    const recentLogs = logsRes.data || [];

    const activeBots = botAccounts.filter((bot) => bot.is_active);
    const availableBots = botAccounts.filter((bot) => bot.is_active && bot.is_available);
    const primaryBots = activeBots.filter((bot) => bot.assignment_role === 'primary');
    const supportBots = activeBots.filter((bot) => bot.assignment_role === 'support');
    const avgClaimsPerHour = botMetrics.length
      ? botMetrics.reduce((sum, row) => sum + Number(row.claims_per_hour || 0), 0) / botMetrics.length
      : 0;

    return NextResponse.json({
      success: true,
      overview: {
        insurersConfigured: masterAccounts.length,
        activeMasterAccounts: masterAccounts.filter((account) => account.is_active).length,
        activeBots: activeBots.length,
        availableBots: availableBots.length,
        primaryBots: primaryBots.length,
        supportBots: supportBots.length,
        activeRules: rules.filter((rule) => rule.is_active).length,
        averageClaimsPerHour: Number(avgClaimsPerHour.toFixed(2)),
        activeClaimLoad: botMetrics.reduce((sum, row) => sum + Number(row.active_claim_load || 0), 0),
        recentAssignmentEvents: recentLogs.filter((row) => row.event_type === 'assignment').length,
      },
      masterAccounts,
      botAccounts,
      rules,
      botMetrics,
      recentLogs,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
