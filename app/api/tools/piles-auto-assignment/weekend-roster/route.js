import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getSupabase } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function normalize(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toIsoDate(value) {
  const text = normalize(value);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function nextWeekendRange(today = new Date()) {
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const day = date.getUTCDay();
  const daysUntilSaturday = (6 - day + 7) % 7;
  const saturday = new Date(date);
  saturday.setUTCDate(date.getUTCDate() + daysUntilSaturday);
  const sunday = new Date(saturday);
  sunday.setUTCDate(saturday.getUTCDate() + 1);
  return {
    weekend_start: saturday.toISOString().slice(0, 10),
    weekend_end: sunday.toISOString().slice(0, 10),
  };
}

function parseRosterText(rawMessage) {
  const lines = normalize(rawMessage).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const onShift = [];
  const offDuty = [];
  let section = '';

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('on shift')) {
      section = 'on_shift';
      continue;
    }
    if (lower.includes('off duty')) {
      section = 'off_duty';
      continue;
    }
    const mentionMatch = line.match(/<@([A-Z0-9]+)>|@([A-Za-z0-9._-]+)/);
    if (!mentionMatch || !section) continue;
    const slackUserId = mentionMatch[1] || '';
    const mention = mentionMatch[0];
    const name = mentionMatch[2] || mention.replace(/[<@>]/g, '');
    const item = { name, slack_mention: mention, slack_user_id: slackUserId };
    if (section === 'on_shift') onShift.push(item);
    if (section === 'off_duty') offDuty.push(item);
  }

  return { on_shift: onShift, off_duty: offDuty };
}

function requireRosterToken(request) {
  // n8n posts weekend rosters with this shared Bearer token after the Friday roster workflow.
  const configuredToken = normalize(process.env.PILES_WEEKEND_ROSTER_TOKEN);
  if (!configuredToken && process.env.NODE_ENV !== 'production') return null;
  if (!configuredToken) return 'PILES_WEEKEND_ROSTER_TOKEN is not configured.';
  const header = normalize(request.headers.get('authorization'));
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  return token === configuredToken ? null : 'Invalid weekend roster token.';
}

function buildMemberLookup(teamMembers) {
  const bySlack = new Map();
  const byName = new Map();
  for (const member of teamMembers || []) {
    if (member.slack_user_id) bySlack.set(normalize(member.slack_user_id), member);
    for (const key of [member.name, member.display_name].map(normalizeKey).filter(Boolean)) {
      byName.set(key, member);
    }
  }
  return { bySlack, byName };
}

function enrichRosterMember(item, dutyStatus, lookup) {
  const slackUserId = normalize(item.slack_user_id);
  const name = normalize(item.name || item.owner_name || item.slack_mention);
  const member = (slackUserId && lookup.bySlack.get(slackUserId)) || lookup.byName.get(normalizeKey(name));
  const preferredName = slackUserId && normalizeKey(name) === normalizeKey(slackUserId)
    ? normalize(member?.display_name || member?.name || name)
    : normalize(name || member?.display_name || member?.name);
  return {
    id: randomUUID(),
    team_member_id: member?.id != null ? String(member.id) : null,
    owner_name: preferredName.replace(/^@+/, ''),
    slack_user_id: slackUserId || normalize(member?.slack_user_id) || null,
    slack_mention: normalize(item.slack_mention) || (slackUserId ? `<@${slackUserId}>` : null),
    duty_status: dutyStatus,
    raw_payload: item,
    updated_at: new Date().toISOString(),
  };
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const [rostersRes, membersRes] = await Promise.all([
      supabase.from('piles_auto_assignment_weekend_rosters').select('*').order('weekend_start', { ascending: false }).limit(20),
      supabase.from('piles_auto_assignment_weekend_roster_members').select('*').order('updated_at', { ascending: false }).limit(200),
    ]);

    const firstError = [rostersRes, membersRes].find((res) => res.error);
    if (firstError?.error) throw firstError.error;

    return NextResponse.json({
      success: true,
      rosters: rostersRes.data || [],
      members: membersRes.data || [],
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const tokenError = requireRosterToken(request);
    if (tokenError) return NextResponse.json({ success: false, error: tokenError }, { status: 401 });

    const body = await request.json();
    const rawMessage = normalize(body.raw_message || body.text || body.message);
    const parsed = parseRosterText(rawMessage);
    const onShift = Array.isArray(body.on_shift) && body.on_shift.length ? body.on_shift : parsed.on_shift;
    const offDuty = Array.isArray(body.off_duty) && body.off_duty.length ? body.off_duty : parsed.off_duty;
    const fallbackWeekend = nextWeekendRange();
    const weekendStart = toIsoDate(body.weekend_start || body.start_date) || fallbackWeekend.weekend_start;
    const weekendEnd = toIsoDate(body.weekend_end || body.end_date) || fallbackWeekend.weekend_end;
    const source = normalize(body.source) || 'n8n_weekend_shift_roster';

    if (!onShift.length) {
      return NextResponse.json({ success: false, error: 'At least one on-shift roster member is required.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: teamMembers, error: teamError } = await supabase
      .from('team_members')
      .select('id, name, display_name, slack_user_id')
      .order('name', { ascending: true });
    if (teamError) throw teamError;

    const lookup = buildMemberLookup(teamMembers || []);
    const rosterPayload = {
      weekend_start: weekendStart,
      weekend_end: weekendEnd,
      timezone: normalize(body.timezone) || 'Africa/Lagos',
      source,
      status: 'received',
      raw_message: rawMessage || null,
      raw_payload: body,
      updated_at: new Date().toISOString(),
    };
    const { data: roster, error: rosterError } = await supabase
      .from('piles_auto_assignment_weekend_rosters')
      .upsert(rosterPayload, { onConflict: 'weekend_start,weekend_end,source' })
      .select('*')
      .single();
    if (rosterError) throw rosterError;

    const { error: deleteError } = await supabase
      .from('piles_auto_assignment_weekend_roster_members')
      .delete()
      .eq('roster_id', roster.id);
    if (deleteError) throw deleteError;

    const members = [
      ...onShift.map((item) => enrichRosterMember(item, 'on_shift', lookup)),
      ...offDuty.map((item) => enrichRosterMember(item, 'off_duty', lookup)),
    ].map((item) => ({ ...item, roster_id: roster.id }));

    const { data: savedMembers, error: membersError } = await supabase
      .from('piles_auto_assignment_weekend_roster_members')
      .insert(members)
      .select('*');
    if (membersError) throw membersError;

    await supabase.from('piles_auto_assignment_logs').insert({
      insurer_name: 'All active insurers',
      event_type: 'weekend_roster_received',
      source: source,
      status: 'received',
      assigned_by: 'n8n_weekend_roster',
      pile_count: 0,
      claim_count: 0,
      details: {
        roster_id: roster.id,
        weekend_start: weekendStart,
        weekend_end: weekendEnd,
        on_shift_count: onShift.length,
        off_duty_count: offDuty.length,
      },
    });

    return NextResponse.json({ success: true, roster, members: savedMembers || [] });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
