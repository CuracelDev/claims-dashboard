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

const VALID_ROLES = new Set(['primary', 'support']);

function uniqueValues(values) {
  return [...new Set((values || []).map((value) => normalize(value)).filter(Boolean))];
}

async function snapshotBotState(supabase, roster, bot, now, body, assignmentRole) {
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
      source: 'weekend_roster_role_editor',
      weekend_start: roster.weekend_start,
      weekend_end: roster.weekend_end,
      requested_assignment_role: assignmentRole,
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
    const assignmentRole = normalize(body.assignment_role).toLowerCase();

    if (!rosterId || !botAccountId) {
      return NextResponse.json({ success: false, error: 'Roster id and bot account id are required.' }, { status: 400 });
    }
    if (!VALID_ROLES.has(assignmentRole)) {
      return NextResponse.json({ success: false, error: 'Assignment role must be primary or support.' }, { status: 400 });
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
      return NextResponse.json({ success: false, error: 'Inactive bot accounts cannot receive weekend roles.' }, { status: 400 });
    }

    const now = new Date().toISOString();
    await snapshotBotState(supabase, roster, bot, now, body, assignmentRole);

    const { data: updatedBot, error: updateError } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .update({
        assignment_role: assignmentRole,
        availability_note: `Weekend roster ${roster.weekend_start} to ${roster.weekend_end}: role override`,
        updated_by_name: normalize(body.updated_by_name) || null,
        updated_by_member_id: normalize(body.updated_by_member_id) || null,
        updated_at: now,
      })
      .eq('id', botAccountId)
      .select('*')
      .single();
    if (updateError) throw updateError;

    const demotedItems = [];
    const supportBotIds = assignmentRole === 'primary' ? uniqueValues(body.support_bot_account_ids).filter((id) => id !== botAccountId) : [];
    for (const supportBotId of supportBotIds) {
      const { data: supportBot, error: supportFetchError } = await supabase
        .from('piles_auto_assignment_bot_accounts')
        .select('*')
        .eq('id', supportBotId)
        .maybeSingle();
      if (supportFetchError) throw supportFetchError;
      if (!supportBot) continue;
      if (supportBot.is_active === false || canonicalInsurerKey(supportBot.insurer_name) !== canonicalInsurerKey(bot.insurer_name)) {
        continue;
      }
      await snapshotBotState(supabase, roster, supportBot, now, body, 'support');
      const { data: demotedBot, error: demoteError } = await supabase
        .from('piles_auto_assignment_bot_accounts')
        .update({
          assignment_role: 'support',
          availability_note: `Weekend roster ${roster.weekend_start} to ${roster.weekend_end}: role override`,
          updated_by_name: normalize(body.updated_by_name) || null,
          updated_by_member_id: normalize(body.updated_by_member_id) || null,
          updated_at: now,
        })
        .eq('id', supportBotId)
        .select('*')
        .single();
      if (demoteError) throw demoteError;
      demotedItems.push(demotedBot);
    }

    return NextResponse.json({ success: true, item: updatedBot, demotedItems, roster });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
