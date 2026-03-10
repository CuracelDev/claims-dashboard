import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('weekly_targets')
    .select('*')
    .order('start_date', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req) {
  const supabase = getSupabase();
  const body = await req.json();
  const { name, type, target_value, start_date, end_date, metric_key, description } = body;
  const { data, error } = await supabase
    .from('weekly_targets')
    .insert([{ name, type, target_value, start_date, end_date,
               metric_key: metric_key || null, description: description || null }])
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(req) {
  const supabase = getSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await supabase.from('weekly_targets').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
