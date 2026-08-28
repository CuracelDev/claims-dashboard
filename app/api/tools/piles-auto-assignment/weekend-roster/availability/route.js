import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getSupabase } from '../../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function normalize(value) {
  return String(value ?? '').trim();
}

const VALID_STATUSES = new Set(['available', 'paused']);

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

async function snapshotBotState(supabase, roster, bot, now, body, availabilityStatus) {
  const snapshotPayload = {
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
      source: 'weekend_roster_availability_editor',
      weekend_start: roster.weekend_start,
      weekend_end: roster.weekend_end,
      requested_availability_status: availabilityStatus,
      updated_by_name: normalize(body.updated_by_name) || null,
      updated_by_member_id: normalize(body.updated_by_member_id) || null,
    },
    created_at: now,
    updated_at: now,
  };

  const { error } = await supabase
    .from('piles_auto_assignment_weekend_bot_state_snapshots')
    .upsert(snapshotPayload, { onConflict: 'roster_id,bot_account_id', ignoreDuplicates: true });
  if (error) throw error;
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const rosterId = normalize(body.roster_id);
    const botAccountId = normalize(body.bot_account_id);
    const availabilityStatus = normalize(body.availability_status).toLowerCase();

    if (!rosterId || !botAccountId) {
      return NextResponse.json({ success: false, error: 'Roster id and bot account id are required.' }, { status: 400 });
    }
    if (!VALID_STATUSES.has(availabilityStatus)) {
      return NextResponse.json({ success: false, error: 'Availability status must be available or paused.' }, { status: 400 });
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

    const { data: bot, error: botError } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .select('*')
      .eq('id', botAccountId)
      .maybeSingle();
    if (botError) throw botError;
    if (!bot) {
      return NextResponse.json({ success: false, error: 'Bot account was not found.' }, { status: 404 });
    }
    if (bot.is_active === false) {
      return NextResponse.json({ success: false, error: 'Inactive bot accounts cannot receive weekend availability overrides.' }, { status: 400 });
    }

    const now = new Date().toISOString();
    await snapshotBotState(supabase, roster, bot, now, body, availabilityStatus);

    const isAvailable = availabilityStatus === 'available';
    let nextAvailabilityStatus = isAvailable ? 'available' : 'weekend_paused';
    if (isAvailable) {
      const { data: members, error: membersError } = await supabase
        .from('piles_auto_assignment_weekend_roster_members')
        .select('*')
        .eq('roster_id', rosterId);
      if (membersError) throw membersError;
      const onShiftKeys = (members || [])
        .filter((member) => normalize(member.duty_status).toLowerCase() === 'on_shift')
        .map((member) => ownerKey(member.owner_name))
        .filter(Boolean);
      const offDutyKeys = (members || [])
        .filter((member) => normalize(member.duty_status).toLowerCase() === 'off_duty')
        .map((member) => ownerKey(member.owner_name))
        .filter(Boolean);
      if (!ownerMatches(bot.owner_name, onShiftKeys) || ownerMatches(bot.owner_name, offDutyKeys) || bot.availability_status === 'weekend_added') {
        nextAvailabilityStatus = 'weekend_added';
      }
    }
    const { data: updatedBot, error: updateError } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .update({
        availability_status: nextAvailabilityStatus,
        availability_note: `Weekend roster ${roster.weekend_start} to ${roster.weekend_end}: ${isAvailable ? 'active' : 'paused'}`,
        is_available: isAvailable,
        updated_by_name: normalize(body.updated_by_name) || null,
        updated_by_member_id: normalize(body.updated_by_member_id) || null,
        updated_at: now,
      })
      .eq('id', botAccountId)
      .select('*')
      .single();
    if (updateError) throw updateError;

    return NextResponse.json({ success: true, item: updatedBot, roster });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
