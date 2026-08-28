import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function normalize(value) {
  return String(value ?? '').trim();
}

function canonicalInsurerKey(value) {
  const label = normalize(value).toLowerCase().replace(/\s+/g, ' ');
  return label === 'uapom' || label === 'old mutual' ? 'old mutual' : label;
}

function ownerKey(value) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ownerMatches(owner, keys) {
  const key = ownerKey(owner);
  if (!key) return false;
  if (keys.includes(key)) return true;
  const ownerFirst = key.split(' ')[0] || key;
  return keys.some((candidate) => candidate === ownerFirst || candidate.startsWith(`${ownerFirst} `));
}

function sortWeekendBots(bots) {
  return [...bots].sort((a, b) => {
    const aRole = a.assignment_role === 'primary' ? 0 : 1;
    const bRole = b.assignment_role === 'primary' ? 0 : 1;
    if (aRole !== bRole) return aRole - bRole;
    return (a.priority_order || 0) - (b.priority_order || 0);
  });
}

async function updateBot(supabase, botId, patch) {
  const { data, error } = await supabase
    .from('piles_auto_assignment_bot_accounts')
    .update(patch)
    .eq('id', botId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const rosterId = normalize(body.roster_id);
    const botAccountId = normalize(body.bot_account_id);

    if (!rosterId || !botAccountId) {
      return NextResponse.json({ success: false, error: 'Roster id and bot account id are required.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: roster, error: rosterError } = await supabase
      .from('piles_auto_assignment_weekend_rosters')
      .select('*')
      .eq('id', rosterId)
      .maybeSingle();
    if (rosterError) throw rosterError;
    if (!roster) {
      return NextResponse.json({ success: false, error: 'Weekend roster was not found.' }, { status: 404 });
    }

    const { data: removedBot, error: botError } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .select('*')
      .eq('id', botAccountId)
      .maybeSingle();
    if (botError) throw botError;
    if (!removedBot) {
      return NextResponse.json({ success: false, error: 'Bot account was not found.' }, { status: 404 });
    }
    if (normalize(removedBot.availability_status).toLowerCase() !== 'weekend_added') {
      return NextResponse.json({ success: false, error: 'Only extra weekend bots can be removed from this section.' }, { status: 400 });
    }

    const [{ data: members, error: membersError }, { data: insurerBots, error: botsError }, { data: snapshots, error: snapshotsError }] = await Promise.all([
      supabase
        .from('piles_auto_assignment_weekend_roster_members')
        .select('*')
        .eq('roster_id', rosterId),
      supabase
        .from('piles_auto_assignment_bot_accounts')
        .select('*'),
      supabase
        .from('piles_auto_assignment_weekend_bot_state_snapshots')
        .select('*')
        .eq('roster_id', rosterId),
    ]);
    if (membersError) throw membersError;
    if (botsError) throw botsError;
    if (snapshotsError) throw snapshotsError;

    const snapshotByBotId = new Map((snapshots || []).map((snapshot) => [String(snapshot.bot_account_id), snapshot]));
    const onShiftKeys = (members || [])
      .filter((member) => normalize(member.duty_status).toLowerCase() === 'on_shift')
      .map((member) => ownerKey(member.owner_name))
      .filter(Boolean);
    const offDutyKeys = (members || [])
      .filter((member) => normalize(member.duty_status).toLowerCase() === 'off_duty')
      .map((member) => ownerKey(member.owner_name))
      .filter(Boolean);

    const now = new Date().toISOString();
    const updater = {
      updated_by_name: normalize(body.updated_by_name) || null,
      updated_by_member_id: normalize(body.updated_by_member_id) || null,
      updated_at: now,
    };
    const noteBase = `Weekend roster ${roster.weekend_start} to ${roster.weekend_end}`;
    const items = [];

    const removedSnapshot = snapshotByBotId.get(removedBot.id);
    const restoredRemovedBot = await updateBot(supabase, removedBot.id, {
      assignment_role: removedSnapshot?.previous_assignment_role || removedBot.assignment_role || 'support',
      availability_status: removedSnapshot?.previous_availability_status || 'weekend_off',
      availability_note: removedSnapshot?.previous_availability_note || `${noteBase}: extra weekend bot removed`,
      is_available: removedSnapshot?.previous_is_available ?? false,
      ...updater,
    });
    items.push(restoredRemovedBot);

    const removedInsurerKey = canonicalInsurerKey(removedBot.insurer_name);
    const rosterEligibleBots = (insurerBots || [])
      .filter((bot) => canonicalInsurerKey(bot.insurer_name) === removedInsurerKey && bot.id !== removedBot.id && bot.is_active !== false)
      .filter((bot) => ownerMatches(bot.owner_name, onShiftKeys) && !ownerMatches(bot.owner_name, offDutyKeys))
      .map((bot) => {
        const snapshot = snapshotByBotId.get(bot.id);
        return {
          ...bot,
          assignment_role: snapshot?.previous_assignment_role || bot.assignment_role || 'support',
        };
      });

    const sortedEligibleBots = sortWeekendBots(rosterEligibleBots);
    const primaryBotId = sortedEligibleBots[0]?.id || '';
    for (const bot of sortedEligibleBots) {
      const snapshot = snapshotByBotId.get(bot.id);
      const updatedBot = await updateBot(supabase, bot.id, {
        assignment_role: bot.id === primaryBotId ? 'primary' : 'support',
        availability_status: snapshot?.previous_availability_status === 'weekend_added' ? 'weekend_added' : 'available',
        availability_note: `${noteBase}: restored after extra weekend bot was removed`,
        is_available: true,
        ...updater,
      });
      items.push(updatedBot);
    }

    return NextResponse.json({
      success: true,
      removedItem: restoredRemovedBot,
      items,
      roster,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
