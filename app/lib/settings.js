// app/lib/settings.js
// ─────────────────────────────────────────────────────────────
// Settings helper with in-memory cache.
// IMPORTANT: Call clearSettingsCache() from the settings PATCH
// route immediately after saving, so the next read gets fresh data.
// ─────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 10_000; // 10 seconds — short enough to feel instant after save

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Returns all platform_settings as a flat key→value object.
 * Uses in-memory cache to avoid hammering Supabase on every request.
 */
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
    return _cache ?? {}; // return stale cache on error rather than crashing
  }

  _cache = Object.fromEntries(data.map((row) => [row.key, row.value]));
  _cacheTime = now;
  return _cache;
}

/**
 * Call this from the settings PATCH route after a successful save.
 * Forces the next getSettings() call to hit Supabase for fresh data.
 *
 * Example usage in app/api/settings/route.js:
 *   import { clearSettingsCache } from '../../lib/settings';
 *   // after successful supabase upsert:
 *   clearSettingsCache();
 */
export function clearSettingsCache() {
  _cache = null;
  _cacheTime = 0;
}
