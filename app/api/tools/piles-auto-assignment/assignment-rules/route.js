import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function toBool(value, fallback = true) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_rules')
      .select('*')
      .order('insurer_name', { ascending: true });

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
      master_account_id: body.master_account_id || null,
      insurer_name: body.insurer_name?.trim(),
      distribution_mode: body.distribution_mode?.trim() || 'balanced_finish',
      minimum_claim_chunk: toInt(body.minimum_claim_chunk, 25),
      reassignment_threshold_minutes: toInt(body.reassignment_threshold_minutes, 120),
      stale_claim_threshold: toInt(body.stale_claim_threshold, 40),
      target_completion_gap_minutes: toInt(body.target_completion_gap_minutes, 30),
      is_active: toBool(body.is_active, true),
      notes: body.notes?.trim() || null,
      updated_at: new Date().toISOString(),
    };

    if (!payload.master_account_id || !payload.insurer_name) {
      return NextResponse.json({ success: false, error: 'Master account and insurer name are required.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('piles_auto_assignment_rules')
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
      return NextResponse.json({ success: false, error: 'Rule id is required.' }, { status: 400 });
    }

    const updates = { updated_at: new Date().toISOString() };
    const textFields = ['master_account_id', 'insurer_name', 'distribution_mode', 'notes'];
    for (const field of textFields) {
      if (body[field] !== undefined) {
        updates[field] = typeof body[field] === 'string' ? body[field].trim() || null : body[field];
      }
    }
    if (body.minimum_claim_chunk !== undefined) updates.minimum_claim_chunk = toInt(body.minimum_claim_chunk, 25);
    if (body.reassignment_threshold_minutes !== undefined) updates.reassignment_threshold_minutes = toInt(body.reassignment_threshold_minutes, 120);
    if (body.stale_claim_threshold !== undefined) updates.stale_claim_threshold = toInt(body.stale_claim_threshold, 40);
    if (body.target_completion_gap_minutes !== undefined) updates.target_completion_gap_minutes = toInt(body.target_completion_gap_minutes, 30);
    if (body.is_active !== undefined) updates.is_active = toBool(body.is_active, true);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_rules')
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
