// app/api/claim-errors/route.js
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

    const limit      = parseInt(searchParams.get('limit')  || '100');
    const offset     = parseInt(searchParams.get('offset') || '0');
    const hmo        = searchParams.get('hmo');
    const env        = searchParams.get('env');
    const error_type = searchParams.get('error_type');
    const channel    = searchParams.get('channel');
    const from       = searchParams.get('from');
    const to         = searchParams.get('to');

    let query = supabase
      .from('claim_errors')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (offset > 0) query = query.range(offset, offset + limit - 1);
    if (hmo)        query = query.ilike('hmo', `%${hmo}%`);
    if (env)        query = query.eq('env', env);
    if (error_type) query = query.eq('error_type', error_type);
    if (channel)    query = query.eq('channel_name', channel);
    if (from)       query = query.gte('created_at', `${from}T00:00:00.000Z`);
    if (to)         query = query.lte('created_at', `${to}T23:59:59.999Z`);

    const { data, error } = await query;
    if (error) throw error;

    // Get total count separately
    let countQuery = supabase
      .from('claim_errors')
      .select('*', { count: 'exact', head: true });

    if (hmo)        countQuery = countQuery.ilike('hmo', `%${hmo}%`);
    if (env)        countQuery = countQuery.eq('env', env);
    if (error_type) countQuery = countQuery.eq('error_type', error_type);
    if (channel)    countQuery = countQuery.eq('channel_name', channel);
    if (from)       countQuery = countQuery.gte('created_at', `${from}T00:00:00.000Z`);
    if (to)         countQuery = countQuery.lte('created_at', `${to}T23:59:59.999Z`);

    const { count } = await countQuery;

    return Response.json({
      data:  data  || [],
      count: count || 0,
      stats: {},
    });
  } catch (err) {
    console.error('GET /api/claim-errors error:', err);
    return Response.json({ data: [], count: 0, error: err.message }, { status: 500 });
  }
}
