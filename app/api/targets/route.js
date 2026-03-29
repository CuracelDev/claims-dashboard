// app/api/targets/route.js
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

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
  const { name, type, target_value, start_date, end_date, metric_key, description, created_by_name } = body;

  const { data, error } = await supabase
    .from('weekly_targets')
    .insert([{ name, type, target_value, start_date, end_date,
               metric_key: metric_key || null, description: description || null }])
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit log
  try {
    await supabase.from('audit_log').insert({
      member_id:   null,
      member_name: created_by_name || 'Admin',
      action:      'target.create',
      entity_type: 'weekly_target',
      entity_id:   data?.id || null,
      details:     { name, type, target_value, start_date, end_date },
      source:      'app',
    });
  } catch {}

  return NextResponse.json({ data });
}

export async function DELETE(req) {
  const supabase = getSupabase();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const deleted_by_name = searchParams.get('deleted_by_name');

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // Fetch name before deleting for audit context
  const { data: target } = await supabase
    .from('weekly_targets')
    .select('name, type')
    .eq('id', id)
    .maybeSingle();

  const { error } = await supabase.from('weekly_targets').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit log
  try {
    await supabase.from('audit_log').insert({
      member_id:   null,
      member_name: deleted_by_name || 'Admin',
      action:      'target.delete',
      entity_type: 'weekly_target',
      entity_id:   parseInt(id),
      details:     { name: target?.name, type: target?.type },
      source:      'app',
    });
  } catch {}

  return NextResponse.json({ success: true });
}
