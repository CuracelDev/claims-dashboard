import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNum(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_bot_metrics')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return NextResponse.json({ success: true, items: data || [] });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const supabase = getSupabase();
    const payload = {
      bot_account_id: body.bot_account_id || null,
      metric_window: body.metric_window?.trim() || 'rolling_24h',
      claims_completed: toInt(body.claims_completed, 0),
      hours_logged: toNum(body.hours_logged, 0),
      claims_per_hour: toNum(body.claims_per_hour, 0),
      active_claim_load: toInt(body.active_claim_load, 0),
      projected_finish_at: body.projected_finish_at || null,
      details: body.details && typeof body.details === 'object' ? body.details : {},
      observed_at: body.observed_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!payload.bot_account_id) {
      return NextResponse.json({ success: false, error: 'Bot account is required.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('piles_auto_assignment_bot_metrics')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ success: false, error: 'Metric id is required.' }, { status: 400 });
    }

    const updates = {
      updated_at: new Date().toISOString(),
    };

    const textFields = ['bot_account_id', 'metric_window'];
    for (const field of textFields) {
      if (body[field] !== undefined) updates[field] = body[field] || null;
    }
    if (body.projected_finish_at !== undefined) updates.projected_finish_at = body.projected_finish_at || null;
    if (body.claims_completed !== undefined) updates.claims_completed = toInt(body.claims_completed, 0);
    if (body.hours_logged !== undefined) updates.hours_logged = toNum(body.hours_logged, 0);
    if (body.claims_per_hour !== undefined) updates.claims_per_hour = toNum(body.claims_per_hour, 0);
    if (body.active_claim_load !== undefined) updates.active_claim_load = toInt(body.active_claim_load, 0);
    if (body.details !== undefined) updates.details = body.details && typeof body.details === 'object' ? body.details : {};
    if (body.observed_at !== undefined) updates.observed_at = body.observed_at || null;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_bot_metrics')
      .update(updates)
      .eq('id', body.id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
