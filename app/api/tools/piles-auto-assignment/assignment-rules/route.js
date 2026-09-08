import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';
import {
  AssignmentRuleValidationError,
  validateAssignmentRule,
} from '../../../../../lib/piles-auto-assignment-rules.mjs';

export const dynamic = 'force-dynamic';

function toBool(value, fallback = true) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
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
    const validated = validateAssignmentRule(body);
    const supabase = getSupabase();
    const payload = {
      master_account_id: body.master_account_id || null,
      insurer_name: body.insurer_name?.trim(),
      ...validated,
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
    const status = error instanceof AssignmentRuleValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ success: false, error: 'Rule id is required.' }, { status: 400 });
    }

    const validated = validateAssignmentRule(body, { partial: true });
    const updates = { ...validated, updated_at: new Date().toISOString() };
    const textFields = ['master_account_id', 'insurer_name', 'distribution_mode', 'notes'];
    for (const field of textFields) {
      if (body[field] !== undefined) {
        updates[field] = typeof body[field] === 'string' ? body[field].trim() || null : body[field];
      }
    }
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
    const status = error instanceof AssignmentRuleValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }
}
