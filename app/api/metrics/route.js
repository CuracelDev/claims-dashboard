import { getSupabase } from '../../../lib/supabase';
import {
  canonicalMetricKey,
  metricDefinitionKey,
  normalizeMetricCategory,
} from '../../../lib/report-metrics';

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
    return Response.json({ data: (data || []).map(normalizeMetricDefinition) });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const { key, label, category, applies_to_all, applicable_members, display_order } = body;
    const metricKey = sanitizeMetricKey(key);
    const metricCategory = normalizeMetricCategory(category);
    if (!metricKey || !label || !metricCategory) {
      return Response.json({ error: 'key, label, and category are required' }, { status: 400 });
    }

    // Keep this Postgres-adapter compatible; supabase-compat does not implement `.or()`.
    const { data: existingMetricKeys, error: existingMetricKeysError } = await supabase
      .from('metric_definitions')
      .select('id, key, metric_key, is_active');
    if (existingMetricKeysError) throw existingMetricKeysError;

    const existingByKey = (existingMetricKeys || []).find((metric) => {
      const keys = [metric.key, metric.metric_key].map((value) => canonicalMetricKey(value));
      return keys.includes(metricKey);
    });

    if (existingByKey?.is_active === false) {
      const { data, error } = await supabase
        .from('metric_definitions')
        .update({
          key: metricKey,
          metric_key: metricKey,
          label,
          category: metricCategory,
          data_type: 'number',
          applies_to_all: applies_to_all !== false,
          applicable_members: applicable_members || [],
          display_order: display_order || 99,
          is_active: true,
          active: true,
        })
        .eq('id', existingByKey.id)
        .select()
        .single();

      if (error) throw error;
      return Response.json({ data: normalizeMetricDefinition(data), restored: true });
    }

    if (existingByKey) {
      return Response.json({ error: `Metric key "${metricKey}" already exists` }, { status: 409 });
    }

    const { data: categoryMetrics } = await supabase
      .from('metric_definitions')
      .select('id, label, category, active, is_active');
    const duplicateLabel = (categoryMetrics || []).find((metric) => (
      metric.active !== false
      && metric.is_active !== false
      && normalizeMetricCategory(metric.category) === metricCategory
      && normalizeLabel(metric.label) === normalizeLabel(label)
    ));
    if (duplicateLabel) {
      return Response.json({ error: `Metric label "${label}" already exists in this category` }, { status: 409 });
    }

    const { data, error } = await supabase
      .from('metric_definitions')
      .insert({
        key: metricKey,
        metric_key: metricKey,
        label,
        category: metricCategory,
        data_type: 'number',
        applies_to_all: applies_to_all !== false,
        applicable_members: applicable_members || [],
        display_order: display_order || 99,
        is_active: true,
        active: true,
      })
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data: normalizeMetricDefinition(data) });
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
    if (active !== undefined) {
      updates.active = active;
    }
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
    return Response.json({ data: normalizeMetricDefinition(data) });
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

    // Soft remove from management/report forms while preserving historical report data.
    const { data, error } = await supabase
      .from('metric_definitions')
      .update({ active: false, is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return Response.json({ data: normalizeMetricDefinition(data) });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

function sanitizeMetricKey(value) {
  return canonicalMetricKey(value);
}

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeMetricDefinition(metric) {
  if (!metric) return metric;
  const key = sanitizeMetricKey(metricDefinitionKey(metric));
  return {
    ...metric,
    key,
    metric_key: key,
    category: normalizeMetricCategory(metric.category),
    active: metric.active !== false,
    is_active: metric.is_active !== false,
    removed: metric.is_active === false,
  };
}
