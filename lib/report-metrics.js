export const DAILY_REPORT_METRIC_KEYS = new Set([
  'claims_kenya',
  'claims_tanzania',
  'claims_uganda',
  'claims_uap',
  'claims_defmis',
  'claims_hadiel',
  'claims_axa',
  'providers_mapped',
  'claims_processed',
  'care_items_mapped',
  'care_items_grouped',
  'resolved_cares',
  'auto_pa_reviewed',
  'flagged_care_items',
  'icd10_adjusted',
  'benefits_set_up',
  'providers_assigned',
]);

export const DEFAULT_REPORT_METRIC_GROUPS = [
  {
    category: 'claims_piles',
    label: 'Claims Piles Checked',
    metrics: [
      { key: 'claims_kenya', label: 'Kenya' },
      { key: 'claims_tanzania', label: 'Tanzania' },
      { key: 'claims_uganda', label: 'Uganda' },
      { key: 'claims_uap', label: 'UAP Old Mutual' },
      { key: 'claims_defmis', label: 'Defmis' },
      { key: 'claims_hadiel', label: 'Hadiel Tech' },
      { key: 'claims_axa', label: 'AXA' },
    ],
  },
  {
    category: 'mapping_data',
    label: 'Mapping & Data',
    metrics: [
      { key: 'providers_mapped', label: 'Num of Providers Mapped' },
      { key: 'claims_processed', label: 'Num of Claims Processed' },
      { key: 'care_items_mapped', label: 'Num of Care Items Mapped' },
      { key: 'care_items_grouped', label: 'Num of Care Items Grouped' },
      { key: 'resolved_cares', label: 'Resolved Cares' },
    ],
  },
  {
    category: 'quality_review',
    label: 'Quality & Review',
    metrics: [
      { key: 'auto_pa_reviewed', label: 'Num of Auto P.A Reviewed/Approved' },
      { key: 'flagged_care_items', label: 'Num of Flagged Care Items' },
      { key: 'icd10_adjusted', label: 'Number of ICD10 Adjusted (Jubilee)' },
      { key: 'benefits_set_up', label: 'Num Benefits Set Up' },
      { key: 'providers_assigned', label: 'Providers Assigned' },
    ],
  },
];

export const REPORT_METRIC_CATEGORY_LABELS = {
  claims_piles: 'Claims Piles Checked',
  mapping_data: 'Mapping & Data',
  quality_review: 'Quality & Review',
};

const LEGACY_METRIC_KEY_ALIASES = {
  piles_kenya: 'claims_kenya',
  piles_tanzania: 'claims_tanzania',
  piles_uganda: 'claims_uganda',
  piles_uap: 'claims_uap',
  piles_defmis: 'claims_defmis',
  piles_hadiel: 'claims_hadiel',
  piles_axa: 'claims_axa',
  benefits_setup: 'benefits_set_up',
};

export function normalizeMetricCategory(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (normalized === 'mapping_data' || normalized === 'mapping_and_data') return 'mapping_data';
  if (normalized === 'claims_piles' || normalized === 'claims_piles_checked') return 'claims_piles';
  if (normalized === 'quality_review' || normalized === 'quality_and_review') return 'quality_review';
  return normalized || 'mapping_data';
}

export function canonicalMetricKey(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return LEGACY_METRIC_KEY_ALIASES[key] || key;
}

export function metricDefinitionKey(metric) {
  return canonicalMetricKey(metric?.key || metric?.metric_key || '');
}

export function isMetricDefinitionActive(metric) {
  return metric?.active !== false && metric?.is_active !== false;
}

export function groupReportMetricDefinitions(metricDefinitions, { includeInactive = false } = {}) {
  const source = Array.isArray(metricDefinitions) && metricDefinitions.length > 0
    ? metricDefinitions
    : DEFAULT_REPORT_METRIC_GROUPS.flatMap((group, groupIndex) => (
        group.metrics.map((metric, metricIndex) => ({
          ...metric,
          category: group.category,
          display_order: groupIndex * 100 + metricIndex,
          active: true,
          is_active: true,
          applies_to_all: true,
        }))
      ));

  const grouped = new Map();
  for (const metric of source) {
    const key = metricDefinitionKey(metric);
    if (!key) continue;
    if (!includeInactive && !isMetricDefinitionActive(metric)) continue;
    const category = normalizeMetricCategory(metric.category);
    if (!grouped.has(category)) {
      grouped.set(category, {
        category,
        label: REPORT_METRIC_CATEGORY_LABELS[category] || category.replace(/_/g, ' '),
        metrics: [],
      });
    }
    grouped.get(category).metrics.push({
      ...metric,
      key,
      label: metric.label || key.replace(/_/g, ' '),
      display_order: Number(metric.display_order || 99),
    });
  }

  return Array.from(grouped.values()).map((group) => ({
    ...group,
    metrics: group.metrics.sort((a, b) => (
      Number(a.display_order || 99) - Number(b.display_order || 99)
      || String(a.label).localeCompare(String(b.label))
    )),
  }));
}

export function metricKeySetFromDefinitions(metricDefinitions, { includeInactive = true } = {}) {
  return new Set(
    groupReportMetricDefinitions(metricDefinitions, { includeInactive })
      .flatMap((group) => group.metrics.map((metric) => metric.key))
  );
}

export function parseReportMetrics(value, allowedKeys = null) {
  if (!value) return {};

  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      return {};
    }
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

  const metrics = {};
  const allowed = allowedKeys ? new Set(allowedKeys) : null;
  for (const [key, raw] of Object.entries(source)) {
    if (allowed && !allowed.has(key)) continue;
    if (!allowed && !/^[a-z0-9_]+$/.test(key)) continue;
    const num = Number(raw);
    if (Number.isFinite(num)) metrics[key] = num;
  }
  return metrics;
}

export function normalizeDailyReport(report) {
  if (!report) return report;
  return {
    ...report,
    metrics: parseReportMetrics(report.metrics),
  };
}

export function normalizeDailyReports(reports) {
  return (reports || []).map(normalizeDailyReport);
}
