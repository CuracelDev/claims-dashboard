import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const insurer = searchParams.get('insurer');
    const status = searchParams.get('status');
    const supabase = getSupabase();
    let query = supabase.from('insurer_feedback_items').select('*').order('created_at', { ascending: false });
    if (insurer) query = query.eq('insurer', insurer);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ success: true, items: data, count: data.length });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { items } = await req.json();
    if (!items || !items.length) return NextResponse.json({ success: false, error: 'No items provided.' }, { status: 400 });
    const rows = items.map(item => ({
      insurer: item.insurer || 'JBL Uganda',
      claim_id: item.claim_id || null,
      insurance_number: item.insurance_number || null,
      diagnosis: item.diagnosis || null,
      care_item: item.care_item || null,
      issue_category: item.issue_category || null,
      issue_description: item.issue_description || null,
      recommendation: item.recommendation || null,
      action_taken: item.action_taken || null,
      status: item.status || 'Open',
      owner: item.owner || null,
      feedback_date: item.feedback_date || null,
      resolution_date: item.resolution_date || null,
      notes: item.notes || null,
      updated_at: new Date().toISOString(),
    }));
    const supabase = getSupabase();
    const { data, error } = await supabase.from('insurer_feedback_items').insert(rows).select();
    if (error) throw error;
    return NextResponse.json({ success: true, count: data.length, items: data });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const body = await req.json();
    const { id, status, owner, notes, action_taken, resolution_date } = body;
    if (!id) return NextResponse.json({ success: false, error: 'Missing id.' }, { status: 400 });
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (owner !== undefined) updates.owner = owner;
    if (notes !== undefined) updates.notes = notes;
    if (action_taken !== undefined) updates.action_taken = action_taken;
    if (resolution_date !== undefined) updates.resolution_date = resolution_date;
    const supabase = getSupabase();
    const { data, error } = await supabase.from('insurer_feedback_items').update(updates).eq('id', id).select().single();
    if (error) throw error;
    return NextResponse.json({ success: true, item: data });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: 'Missing id.' }, { status: 400 });
    const supabase = getSupabase();
    const { error } = await supabase.from('insurer_feedback_items').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
