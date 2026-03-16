// PATH: app/lib/settings.js
// Server-side helper — import in API routes to read settings from DB
// Usage: const cfg = await getSettings(); then cfg('slack_channel_qa_insight', 'C03TBH0RL76')

import { createClient } from '@supabase/supabase-js';

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 60s — settings don't change often

export async function getSettings() {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data } = await supabase.from('platform_settings').select('key, value');
  const map = {};
  for (const row of (data || [])) map[row.key] = row.value;

  // Return a getter function with fallback
  _cache = (key, fallback = '') => map[key] ?? fallback;
  _cacheTime = now;
  return _cache;
}
