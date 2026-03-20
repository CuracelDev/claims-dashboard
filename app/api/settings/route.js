// PATH: app/api/settings/route.js
import { createClient } from '@supabase/supabase-js';
import { clearSettingsCache } from '../../lib/settings';

export const dynamic = 'force-dynamic';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// GET /api/settings — fetch all settings (optionally by category)
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

// PATCH /api/settings — update one or many settings
// Body: { updates: [{ key, value }] }
export async function PATCH(request) {
  const supabase = getSupabase();
  try {
    const { updates } = await request.json();
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
    // Bust the settings cache so next read gets fresh data immediately
    if (allOk) clearSettingsCache();
    return Response.json({ results, ok: allOk });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
