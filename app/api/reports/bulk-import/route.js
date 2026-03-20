// app/api/reports/bulk-import/route.js
// Bulk import historical daily reports from CSV.
// ─── Guards ──────────────────────────────────────────────────
// - Max 500 rows per upload (reject above this)
// - Batch inserts of 100 rows to avoid Supabase timeouts
// - Duplicate check: skip rows where (member_id, report_date) exists
// - Date format: DD/MM/YYYY (as per team spreadsheet convention)
// ─────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const MAX_ROWS   = 500;
const BATCH_SIZE = 100;

// DD/MM/YYYY → YYYY-MM-DD (ISO) or null if invalid
function parseDate(raw) {
  if (!raw) return null;
  const parts = String(raw).trim().split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  if (!day || !month || !year) return null;
  const iso = `${year.padStart(4,'0')}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
  if (isNaN(Date.parse(iso))) return null;
  return iso;
}

// Empty or whitespace → 0
function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? 0 : n;
}

export async function POST(request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { rows } = body; // Array of row objects from parsed CSV

  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: 'No rows provided' }, { status: 400 });
  }

  // ── Row cap ──────────────────────────────────────────────────
  if (rows.length > MAX_ROWS) {
    return Response.json({
      error: `Too many rows. Maximum is ${MAX_ROWS} per upload. You sent ${rows.length}.`,
    }, { status: 400 });
  }

  // ── Load member name → id map ────────────────────────────────
  const { data: members, error: memberErr } = await supabase
    .from('team_members')
    .select('id, name, display_name');

  if (memberErr) {
    return Response.json({ error: 'Could not load team members' }, { status: 500 });
  }

  const memberMap = {};
  members.forEach((m) => {
    const key = (m.display_name || m.name).toLowerCase().trim();
    memberMap[key] = parseInt(m.id);
  });

  // ── Load existing (member_id, report_date) pairs ─────────────
  const { data: existing } = await supabase
    .from('daily_reports')
    .select('team_member_id, report_date');

  const existingSet = new Set(
    (existing || []).map((r) => `${r.team_member_id}|${r.report_date}`)
  );

  // ── Validate and build insert rows ───────────────────────────
  const toInsert = [];
  const skipped  = [];
  const failed   = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed, +1 for header

    // Resolve member
    const nameKey  = String(row.member_name || '').toLowerCase().trim();
    const memberId = memberMap[nameKey];
    if (!memberId) {
      failed.push({ row: rowNum, reason: `Unknown member: "${row.member_name}"` });
      continue;
    }

    // Parse date
    const reportDate = parseDate(row.report_date);
    if (!reportDate) {
      failed.push({ row: rowNum, reason: `Invalid date: "${row.report_date}" (use DD/MM/YYYY)` });
      continue;
    }

    // Duplicate check
    const dupKey = `${memberId}|${reportDate}`;
    if (existingSet.has(dupKey)) {
      skipped.push({ row: rowNum, reason: 'Already exists', member: row.member_name, date: reportDate });
      continue;
    }

    // Mark as seen so duplicate rows within the same upload are also caught
    existingSet.add(dupKey);

    toInsert.push({
      team_member_id: memberId,
      report_date:    reportDate,
      status:         'imported',
      metrics: {
        claims_kenya:          toInt(row.claims_kenya),
        claims_tanzania:       toInt(row.claims_tanzania),
        claims_uganda:         toInt(row.claims_uganda),
        claims_uap:            toInt(row.claims_uap),
        claims_defmis:         toInt(row.claims_defmis),
        claims_hadiel:         toInt(row.claims_hadiel),
        claims_axa:            toInt(row.claims_axa),
        providers_mapped:      toInt(row.providers_mapped),
        care_items_mapped:     toInt(row.care_items_mapped),
        care_items_grouped:    toInt(row.care_items_grouped),
        resolved_cares:        toInt(row.resolved_cares),
        auto_pa_reviewed:      toInt(row.auto_pa_reviewed),
        flagged_care_items:    toInt(row.flagged_care_items),
        icd10_adjusted:        toInt(row.icd10_adjusted),
        benefits_set_up:       toInt(row.benefits_set_up),
        providers_assigned:    toInt(row.providers_assigned),
        tasks_completed:       toInt(row.tasks_completed),
      },
      notes: row.notes || null,
    });
  }

  // ── Batch insert ─────────────────────────────────────────────
  let imported = 0;
  const insertErrors = [];

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const { error: insertErr } = await supabase
      .from('daily_reports')
      .insert(batch);

    if (insertErr) {
      insertErrors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${insertErr.message}`);
    } else {
      imported += batch.length;
    }
  }

  return Response.json({
    imported,
    skipped: skipped.length,
    failed:  failed.length + insertErrors.length,
    skipped_rows: skipped,
    failed_rows:  failed,
    insert_errors: insertErrors,
    summary: `${imported} imported · ${skipped.length} skipped (duplicates) · ${failed.length} failed (invalid)`,
  });
}
