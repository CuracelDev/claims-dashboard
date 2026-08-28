import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';
import { decryptCredentialFields, encryptCredential } from '../../../../../lib/piles-auto-assignment-credentials.mjs';

export const dynamic = 'force-dynamic';

function toBool(value, fallback = true) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function presentAccount(item) {
  return {
    ...decryptCredentialFields(item, ['login_email']),
    login_password: '',
    has_login_password: Boolean(item?.login_password),
  };
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
      items: (data || []).map(presentAccount),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const insurerName = body.insurer_name?.trim();
    const loginEmail = body.login_email?.trim();
    const loginPassword = String(body.login_password || '');
    if (!insurerName || !loginEmail || !loginPassword) {
      return NextResponse.json({ success: false, error: 'Insurer name, login email, and login password are required.' }, { status: 400 });
    }

    const supabase = getSupabase();
    const payload = {
      insurer_name: insurerName,
      login_email: encryptCredential(loginEmail),
      login_password: encryptCredential(loginPassword),
      notes: body.notes?.trim() || null,
      is_active: toBool(body.is_active, true),
      last_password_update: body.login_password ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('piles_auto_assignment_master_accounts')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: presentAccount(data) });
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
    if (body.insurer_name !== undefined) {
      const insurerName = String(body.insurer_name || '').trim();
      if (!insurerName) {
        return NextResponse.json({ success: false, error: 'Insurer name cannot be empty.' }, { status: 400 });
      }
      updates.insurer_name = insurerName;
    }
    if (body.login_email !== undefined) {
      const loginEmail = String(body.login_email || '').trim();
      if (!loginEmail) {
        return NextResponse.json({ success: false, error: 'Login email cannot be empty.' }, { status: 400 });
      }
      updates.login_email = encryptCredential(loginEmail);
    }
    if (typeof body.login_password === 'string' && body.login_password.length > 0) {
      updates.login_password = encryptCredential(body.login_password);
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
    return NextResponse.json({ success: true, item: presentAccount(data) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
