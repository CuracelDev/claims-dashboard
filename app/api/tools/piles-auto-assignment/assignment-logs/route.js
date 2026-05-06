import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);
    const insurer = searchParams.get('insurer');

    let query = supabase
      .from('piles_auto_assignment_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (insurer) query = query.eq('insurer_name', insurer);

    const { data, error } = await query;
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
      bot_account_id: body.bot_account_id || null,
      insurer_name: body.insurer_name?.trim(),
      event_type: body.event_type?.trim() || 'assignment',
      source: body.source?.trim() || 'dashboard',
      status: body.status?.trim() || 'logged',
      assigned_by: body.assigned_by?.trim() || null,
      pile_count: toInt(body.pile_count, 0),
      claim_count: toInt(body.claim_count, 0),
      details: body.details && typeof body.details === 'object' ? body.details : {},
    };

    if (!payload.insurer_name) {
      return NextResponse.json({ success: false, error: 'Insurer name is required.' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('piles_auto_assignment_logs')
      .insert(payload)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ success: true, item: data });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
