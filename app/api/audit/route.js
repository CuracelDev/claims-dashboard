// app/api/audit/route.js — Audit Log Reader
// Reads from audit_log table with filters: member_id, action, from, to
// Supports pagination via limit + offset

import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);

    const limit     = parseInt(searchParams.get('limit')  || '50');
    const offset    = parseInt(searchParams.get('offset') || '0');
    const memberId  = searchParams.get('member_id');
    const action    = searchParams.get('action');
    const from      = searchParams.get('from');
    const to        = searchParams.get('to');

    let query = supabase
      .from('audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (memberId) query = query.eq('member_id', memberId);
    if (action)   query = query.ilike('action', `%${action}%`);
    if (from)     query = query.gte('created_at', `${from}T00:00:00.000Z`);
    if (to)       query = query.lte('created_at', `${to}T23:59:59.999Z`);

    const { data, error, count } = await query;
    if (error) throw error;

    return Response.json({ data: data || [], count: count || 0 });
  } catch (err) {
    console.error('GET /api/audit error:', err);
    return Response.json({ data: [], count: 0, error: err.message }, { status: 500 });
  }
}
