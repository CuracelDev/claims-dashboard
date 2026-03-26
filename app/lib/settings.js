// app/lib/settings.js
import { createClient } from '@supabase/supabase-js';

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 10_000;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function getSettings() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) {
    return _cache;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('platform_settings')
    .select('key, value');

  if (error) {
    console.error('[settings] fetch error:', error.message);
    return _cache ?? {};
  }

  _cache = Object.fromEntries(data.map((row) => [row.key, row.value]));
  _cacheTime = now;
  return _cache;
}

export async function getSetting(key, fallback = null) {
  const settings = await getSettings();
  return settings[key] ?? fallback;
}

export function clearSettingsCache() {
  _cache = null;
  _cacheTime = 0;
}
