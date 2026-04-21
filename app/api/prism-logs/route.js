// PATH: app/api/prism-logs/route.js
import { getSupabase } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('prism_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    return Response.json({ data: data || [] });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
