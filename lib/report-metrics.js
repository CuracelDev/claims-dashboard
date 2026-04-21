export const DAILY_REPORT_METRIC_KEYS = new Set([
  'claims_kenya',
  'claims_tanzania',
  'claims_uganda',
  'claims_uap',
  'claims_defmis',
  'claims_hadiel',
  'claims_axa',
  'providers_mapped',
  'care_items_mapped',
  'care_items_grouped',
  'resolved_cares',
  'auto_pa_reviewed',
  'flagged_care_items',
  'icd10_adjusted',
  'benefits_set_up',
  'providers_assigned',
]);

export function parseReportMetrics(value) {
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
  for (const [key, raw] of Object.entries(source)) {
    if (!DAILY_REPORT_METRIC_KEYS.has(key)) continue;
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
