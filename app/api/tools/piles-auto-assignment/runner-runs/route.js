import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../../lib/supabase';

export const dynamic = 'force-dynamic';

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 250);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = normalizeLimit(searchParams.get('limit'));

    const supabase = getSupabase();
    const res = await supabase
      .from('piles_auto_assignment_runner_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (res.error) throw res.error;

    return NextResponse.json({
      success: true,
      runs: res.data || [],
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to load runner history.' }, { status: 500 });
  }
}
