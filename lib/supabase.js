import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient as createPostgresClient } from './supabase-compat';

export function getSupabase() {
  if (process.env.DATABASE_URL) {
    return createPostgresClient();
  }
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
