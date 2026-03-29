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
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (hmo)        query = query.ilike('hmo', `%${hmo}%`);
    if (env)        query = query.eq('env', env);
    if (error_type) query = query.eq('error_type', error_type);
    if (channel)    query = query.eq('channel_name', channel);
    if (from)       query = query.gte('created_at', `${from}T00:00:00.000Z`);
    if (to)         query = query.lte('created_at', `${to}T23:59:59.999Z`);

    const { data, error, count } = await query;
    if (error) throw error;

    // Summary stats
    const { data: stats } = await supabase
      .from('claim_errors')
      .select('error_type, hmo, env, channel_name');

    const byType    = {};
    const byHmo     = {};
    const byEnv     = {};
    const byChannel = {};

    (stats || []).forEach(r => {
      if (r.error_type) byType[r.error_type]       = (byType[r.error_type]       || 0) + 1;
      if (r.hmo)        byHmo[r.hmo]               = (byHmo[r.hmo]               || 0) + 1;
      if (r.env)        byEnv[r.env]               = (byEnv[r.env]               || 0) + 1;
      if (r.channel_name) byChannel[r.channel_name] = (byChannel[r.channel_name] || 0) + 1;
    });

    return Response.json({
      data: data || [],
      count: count || 0,
      stats: { byType, byHmo, byEnv, byChannel },
    });
  } catch (err) {
    console.error('GET /api/claim-errors error:', err);
    return Response.json({ data: [], count: 0, error: err.message }, { status: 500 });
  }
}
