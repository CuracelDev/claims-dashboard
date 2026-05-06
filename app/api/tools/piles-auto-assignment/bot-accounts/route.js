import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';
import { decryptCredentialFields, encryptCredential } from '../../../../../lib/piles-auto-assignment-credentials.mjs';

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

function toNum(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .select('*')
      .order('insurer_name', { ascending: true })
      .order('priority_order', { ascending: true });

    if (error) throw error;
    return NextResponse.json({
      success: true,
      items: (data || []).map((item) => decryptCredentialFields(item, ['bot_email', 'bot_password'])),
    });
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
      owner_name: body.owner_name?.trim(),
      bot_name: body.bot_name?.trim() || null,
      bot_email: body.bot_email ? encryptCredential(body.bot_email.trim()) : null,
      bot_password: body.bot_password ? encryptCredential(body.bot_password) : '',
      assignment_role: body.assignment_role?.trim() || 'primary',
      support_capacity_ratio: toNum(body.support_capacity_ratio, 1),
      availability_status: body.availability_status?.trim() || 'available',
      availability_note: body.availability_note?.trim() || null,
      notes: body.notes?.trim() || null,
      is_active: toBool(body.is_active, true),
      is_available: toBool(body.is_available, true),
      priority_order: toInt(body.priority_order, 100),
      current_claim_load: toInt(body.current_claim_load, 0),
      updated_at: new Date().toISOString(),
    };

    if (!payload.insurer_name || !payload.owner_name) {
      return NextResponse.json({ success: false, error: 'Insurer name and owner name are required.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: decryptCredentialFields(data, ['bot_email', 'bot_password']) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ success: false, error: 'Bot account id is required.' }, { status: 400 });
    }

    const updates = { updated_at: new Date().toISOString() };
    const textFields = ['master_account_id', 'insurer_name', 'owner_name', 'bot_name', 'bot_email', 'bot_password', 'assignment_role', 'availability_status', 'availability_note', 'notes'];
    for (const field of textFields) {
      if (body[field] !== undefined) {
        updates[field] = typeof body[field] === 'string' ? body[field].trim() || null : body[field];
      }
    }
    if (body.bot_email !== undefined) updates.bot_email = body.bot_email ? encryptCredential(body.bot_email.trim()) : null;
    if (body.bot_password !== undefined) updates.bot_password = body.bot_password ? encryptCredential(body.bot_password) : '';
    if (body.is_active !== undefined) updates.is_active = toBool(body.is_active, true);
    if (body.is_available !== undefined) updates.is_available = toBool(body.is_available, true);
    if (body.support_capacity_ratio !== undefined) updates.support_capacity_ratio = toNum(body.support_capacity_ratio, 1);
    if (body.priority_order !== undefined) updates.priority_order = toInt(body.priority_order, 100);
    if (body.current_claim_load !== undefined) updates.current_claim_load = toInt(body.current_claim_load, 0);
    if (body.last_assigned_at !== undefined) updates.last_assigned_at = body.last_assigned_at || null;
    if (body.last_completed_at !== undefined) updates.last_completed_at = body.last_completed_at || null;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_bot_accounts')
      .update(updates)
      .eq('id', body.id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: decryptCredentialFields(data, ['bot_email', 'bot_password']) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
