import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('target_logs')
    .select('*')
    .order('date', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req) {
  const supabase = getSupabase();
  const body = await req.json();
  const { target_id, date, value, note } = body;

  // Upsert — one entry per target per day (last write wins)
  const { data, error } = await supabase
    .from('target_logs')
    .upsert(
      [{ target_id, date, value: String(value), note: note || null }],
      { onConflict: 'target_id,date' }
    )
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
