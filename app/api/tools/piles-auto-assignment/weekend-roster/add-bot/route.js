import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
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

function isWeekendAvailable(bot) {
  return normalize(bot.availability_status || 'available').toLowerCase() !== 'weekend_paused';
}

function isWeekendEligible(bot, onShiftKeys, offDutyKeys) {
  const status = normalize(bot.availability_status || 'available').toLowerCase();
  if (bot.is_active === false || status === 'weekend_paused') return false;
  if (status === 'weekend_added') return true;
  return ownerMatches(bot.owner_name, onShiftKeys) && !ownerMatches(bot.owner_name, offDutyKeys);
}

function sortWeekendBots(bots) {
  return [...bots].sort((a, b) => {
    const aRole = a.assignment_role === 'primary' ? 0 : 1;
    const bRole = b.assignment_role === 'primary' ? 0 : 1;
    if (aRole !== bRole) return aRole - bRole;
    return (a.priority_order || 0) - (b.priority_order || 0);
  });
}

async function snapshotBotState(supabase, roster, bot, now, body, source) {
  const { error } = await supabase
    .from('piles_auto_assignment_weekend_bot_state_snapshots')
    .upsert({
      id: randomUUID(),
      roster_id: roster.id,
      bot_account_id: bot.id,
      insurer_name: bot.insurer_name,
      owner_name: bot.owner_name,
      previous_assignment_role: bot.assignment_role || 'primary',
      previous_availability_status: bot.availability_status || 'available',
      previous_availability_note: bot.availability_note || null,
      previous_is_available: bot.is_available !== false,
      previous_is_active: bot.is_active !== false,
      details: {
        source,
        weekend_start: roster.weekend_start,
        weekend_end: roster.weekend_end,
        updated_by_name: normalize(body.updated_by_name) || null,
        updated_by_member_id: normalize(body.updated_by_member_id) || null,
      },
      created_at: now,
      updated_at: now,
    }, { onConflict: 'roster_id,bot_account_id', ignoreDuplicates: true });
  if (error) throw error;
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

    const { data: addedBot, error: botError } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .select('*')
      .eq('id', botAccountId)
      .maybeSingle();
    if (botError) throw botError;
    if (!addedBot) {
      return NextResponse.json({ success: false, error: 'Bot account was not found.' }, { status: 404 });
    }
    if (addedBot.is_active === false) {
      return NextResponse.json({ success: false, error: 'Inactive bot accounts cannot be added to a weekend roster.' }, { status: 400 });
    }

    const [{ data: members, error: membersError }, { data: insurerBots, error: botsError }] = await Promise.all([
      supabase
        .from('piles_auto_assignment_weekend_roster_members')
        .select('*')
        .eq('roster_id', rosterId),
      supabase
        .from('piles_auto_assignment_bot_accounts')
        .select('*'),
    ]);
    if (membersError) throw membersError;
    if (botsError) throw botsError;

    const onShiftKeys = (members || [])
      .filter((member) => normalize(member.duty_status).toLowerCase() === 'on_shift')
      .map((member) => ownerKey(member.owner_name))
      .filter(Boolean);
    const offDutyKeys = (members || [])
      .filter((member) => normalize(member.duty_status).toLowerCase() === 'off_duty')
      .map((member) => ownerKey(member.owner_name))
      .filter(Boolean);

    const addedInsurerKey = canonicalInsurerKey(addedBot.insurer_name);
    const currentlyEligible = sortWeekendBots((insurerBots || []).filter((bot) => (
      canonicalInsurerKey(bot.insurer_name) === addedInsurerKey
      && bot.id !== botAccountId
      && isWeekendEligible(bot, onShiftKeys, offDutyKeys)
      && isWeekendAvailable(bot)
    )));
    const previousPrimary = currentlyEligible[0] || null;
    const previousSupportRows = currentlyEligible.filter((bot) => bot.id !== previousPrimary?.id);

    const now = new Date().toISOString();
    const updater = {
      updated_by_name: normalize(body.updated_by_name) || null,
      updated_by_member_id: normalize(body.updated_by_member_id) || null,
      updated_at: now,
    };
    const noteBase = `Weekend roster ${roster.weekend_start} to ${roster.weekend_end}`;
    const items = [];

    await snapshotBotState(supabase, roster, addedBot, now, body, 'weekend_roster_add_bot');
    const updatedAddedBot = await updateBot(supabase, addedBot.id, {
      assignment_role: 'primary',
      availability_status: 'weekend_added',
      availability_note: `${noteBase}: added as weekend primary`,
      is_available: true,
      ...updater,
    });
    items.push(updatedAddedBot);

    if (previousPrimary) {
      await snapshotBotState(supabase, roster, previousPrimary, now, body, 'weekend_roster_add_bot_previous_primary');
      const updatedPreviousPrimary = await updateBot(supabase, previousPrimary.id, {
        assignment_role: 'support',
        availability_status: previousPrimary.availability_status === 'weekend_added' ? 'weekend_added' : 'available',
        availability_note: `${noteBase}: moved to support after extra weekend bot was added`,
        is_available: true,
        ...updater,
      });
      items.push(updatedPreviousPrimary);
    }

    for (const supportBot of previousSupportRows) {
      await snapshotBotState(supabase, roster, supportBot, now, body, 'weekend_roster_add_bot_previous_support');
      const updatedSupportBot = await updateBot(supabase, supportBot.id, {
        assignment_role: 'support',
        availability_status: 'weekend_paused',
        availability_note: `${noteBase}: paused after extra weekend primary was added`,
        is_available: false,
        ...updater,
      });
      items.push(updatedSupportBot);
    }

    return NextResponse.json({
      success: true,
      addedItem: updatedAddedBot,
      previousPrimaryItem: items.find((item) => previousPrimary && item.id === previousPrimary.id) || null,
      pausedItems: items.filter((item) => previousSupportRows.some((bot) => bot.id === item.id)),
      items,
      roster,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
