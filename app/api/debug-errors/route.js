import { createClient } from '@supabase/supabase-js';
export const dynamic = 'force-dynamic';
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(url, key);
  const { data, error, count } = await supabase
    .from('claim_errors')
    .select('*', { count: 'exact' });
  return Response.json({ url, keyLength: key?.length, data, error, count });
}
