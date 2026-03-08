import { getSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = getSupabase();
  try {
    const { data, error } = await supabase
      .from('metric_definitions')
      .select('*')
      .order('category')
      .order('display_order');
    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const { key, label, category, applies_to_all, applicable_members, display_order } = body;
    if (!key || !label || !category) {
      return Response.json({ error: 'key, label, and category are required' }, { status: 400 });
    }

    // Check for duplicate key
    const { data: existing } = await supabase
      .from('metric_definitions')
      .select('id')
      .eq('key', key)
      .single();

    if (existing) {
      return Response.json({ error: `Metric key "${key}" already exists` }, { status: 409 });
    }

    const { data, error } = await supabase
      .from('metric_definitions')
      .insert({
        key, label, category,
        applies_to_all: applies_to_all !== false,
        applicable_members: applicable_members || [],
        display_order: display_order || 99,
        active: true,
      })
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const { id, label, active, applies_to_all, applicable_members, display_order } = body;
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const updates = {};
    if (label !== undefined) updates.label = label;
    if (active !== undefined) updates.active = active;
    if (applies_to_all !== undefined) updates.applies_to_all = applies_to_all;
    if (applicable_members !== undefined) updates.applicable_members = applicable_members;
    if (display_order !== undefined) updates.display_order = display_order;

    const { data, error } = await supabase
      .from('metric_definitions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  const supabase = getSupabase();
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    // Soft delete — set active: false to preserve historical data
    const { data, error } = await supabase
      .from('metric_definitions')
      .update({ active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
