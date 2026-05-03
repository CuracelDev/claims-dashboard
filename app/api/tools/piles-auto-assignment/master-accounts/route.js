import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';
import { decryptCredentialFields, encryptCredential } from '../../../../../lib/piles-auto-assignment-credentials.mjs';

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
      .from('piles_auto_assignment_master_accounts')
      .select('*')
      .order('insurer_name', { ascending: true });

    if (error) throw error;
    return NextResponse.json({
      success: true,
      items: (data || []).map((item) => decryptCredentialFields(item, ['login_email', 'login_password'])),
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
      insurer_name: body.insurer_name?.trim(),
      login_email: body.login_email ? encryptCredential(body.login_email.trim()) : '',
      login_password: body.login_password ? encryptCredential(body.login_password) : '',
      notes: body.notes?.trim() || null,
      is_active: toBool(body.is_active, true),
      last_password_update: body.login_password ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    if (!payload.insurer_name || !payload.login_email) {
      return NextResponse.json({ success: false, error: 'Insurer name and login email are required.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('piles_auto_assignment_master_accounts')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: decryptCredentialFields(data, ['login_email', 'login_password']) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body.id) {
      return NextResponse.json({ success: false, error: 'Account id is required.' }, { status: 400 });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (body.insurer_name !== undefined) updates.insurer_name = body.insurer_name.trim();
    if (body.login_email !== undefined) updates.login_email = body.login_email ? encryptCredential(body.login_email.trim()) : '';
    if (body.login_password !== undefined) {
      updates.login_password = body.login_password ? encryptCredential(body.login_password) : '';
      updates.last_password_update = new Date().toISOString();
    }
    if (body.notes !== undefined) updates.notes = body.notes?.trim() || null;
    if (body.is_active !== undefined) updates.is_active = toBool(body.is_active, true);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('piles_auto_assignment_master_accounts')
      .update(updates)
      .eq('id', body.id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: decryptCredentialFields(data, ['login_email', 'login_password']) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
