// app/api/settings/route.js
import { createClient } from '@supabase/supabase-js';
import { clearSettingsCache } from '../../lib/settings';
export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET(request) {
  const supabase = getSupabase();
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  let query = supabase.from('platform_settings').select('*').order('category').order('key');
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const map = {};
  for (const row of (data || [])) map[row.key] = row.value;
  return Response.json({ settings: data || [], map });
}

export async function PATCH(request) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const { updates, updated_by_name } = body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    const results = [];
    for (const { key, value } of updates) {
      const { data, error } = await supabase
        .from('platform_settings')
        .update({ value: String(value), updated_at: new Date().toISOString() })
        .eq('key', key)
        .select()
        .single();
      if (error) results.push({ key, success: false, error: error.message });
      else results.push({ key, success: true, data });
    }

    const allOk = results.every(r => r.success);
    if (allOk) clearSettingsCache();

    // Audit log
    try {
      await supabase.from('audit_log').insert({
        member_id:   null,
        member_name: updated_by_name || 'Admin',
        action:      'settings.update',
        entity_type: 'platform_settings',
        entity_id:   null,
        details:     { keys: updates.map(u => u.key) },
        source:      'app',
      });
    } catch {}

    return Response.json({ results, ok: allOk });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
