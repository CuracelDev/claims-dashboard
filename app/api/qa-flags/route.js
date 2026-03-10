import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// POST /api/qa-flags — called by n8n after each QA run
// Accepts single object OR array of flag objects
export async function POST(request) {
  try {
    const supabase = getSupabase();
    const body = await request.json();

    // n8n may send a single object or an array
    const flags = Array.isArray(body) ? body : [body];

    if (flags.length === 0) {
      return Response.json({ message: "No flags to insert" }, { status: 200 });
    }

    // Clean and map fields
    const rows = flags.map(f => ({
      claim_id:             f.claim_id             || null,
      full_name:            f.full_name             || null,
      insurance_number:     f.insurance_number      || null,
      item_description:     f.item_description      || null,
      qty_billed:           f.qty_billed            ?? null,
      qty_approved:         f.qty_approved          ?? null,
      unit_price_billed:    f.unit_price_billed     ?? null,
      unit_price_calculated:f.unit_price_calculated ?? null,
      bill_submitted:       f.bill_submitted        ?? null,
      bill_approved:        f.bill_approved         ?? null,
      vetting_comment:      f.vetting_comment       || null,
      item_status:          f.item_status           || null,
      issues:               f.issues               || null,
      encounter_date:       f.encounter_date        || null,
      created_at:           f.created_at            || null,
      flagged_at:           f.flagged_at            || new Date().toISOString(),
      provider_name:        f.provider_name         || null,
      insurer_name:         f.insurer_name          || null,
    }));

    const { data, error } = await supabase
      .from("qa_flags")
      .upsert(rows, {
        onConflict: "claim_id,item_description,issues,encounter_date",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) throw error;

    return Response.json({
      success: true,
      inserted: data.length,
      message: `${data.length} flag(s) logged`,
    }, { status: 201 });

  } catch (err) {
    console.error("POST /api/qa-flags error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/qa-flags — dashboard queries
// Query params: from, to, insurer, issue_type, provider, limit
export async function GET(request) {
  try {
    const supabase = getSupabase();
    const { searchParams } = new URL(request.url);

    const from      = searchParams.get("from");
    const to        = searchParams.get("to");
    const insurer   = searchParams.get("insurer");
    const issueType = searchParams.get("issue_type");
    const provider  = searchParams.get("provider");
    const limit     = parseInt(searchParams.get("limit") || "500");

    // Default: last 30 days
    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 30);

    // If date-only (YYYY-MM-DD), expand to full UTC day so single-day picks work
    // T23:59:59.999Z on "to" ensures the whole day is included
    const fromDate = from
      ? `${from}T00:00:00.000Z`
      : defaultFrom.toISOString();
    const toDate = to
      ? `${to}T23:59:59.999Z`
      : new Date().toISOString();

    let query = supabase
      .from("qa_flags")
      .select("*")
      .gte("flagged_at", fromDate)
      .lte("flagged_at", toDate)
      .order("flagged_at", { ascending: false })
      .limit(limit);

    if (insurer)   query = query.ilike("insurer_name", `%${insurer}%`);
    if (provider)  query = query.ilike("provider_name", `%${provider}%`);
    if (issueType) query = query.ilike("issues", `%${issueType}%`);

    const { data: flags, error } = await query;
    if (error) throw error;

    // ── Aggregations for dashboard ──────────────────────────────

    // Issue type breakdown
    const issueCounts = {};
    const insurerCounts = {};
    const providerCounts = {};
    const dailyCounts = {};

    for (const f of flags) {
      // Issue types (a flag can have multiple issues separated by ;)
      const issueList = (f.issues || "").split(";").map(i => i.trim()).filter(Boolean);
      for (const issue of issueList) {
        const key = categoriseIssue(issue);
        issueCounts[key] = (issueCounts[key] || 0) + 1;
      }

      // Insurer
      if (f.insurer_name) {
        insurerCounts[f.insurer_name] = (insurerCounts[f.insurer_name] || 0) + 1;
      }

      // Provider
      if (f.provider_name) {
        providerCounts[f.provider_name] = (providerCounts[f.provider_name] || 0) + 1;
      }

      // Daily
      if (f.flagged_at) {
        const day = f.flagged_at.slice(0, 10);
        if (!dailyCounts[day]) dailyCounts[day] = { date: day, total: 0 };
        dailyCounts[day].total++;
      }
    }

    // Top providers (top 10)
    const topProviders = Object.entries(providerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    // Daily trend sorted
    const dailyTrend = Object.values(dailyCounts)
      .sort((a, b) => a.date.localeCompare(b.date));

    return Response.json({
      flags,
      total: flags.length,
      aggregations: {
        by_issue:    Object.entries(issueCounts).map(([issue, count]) => ({ issue, count })).sort((a,b) => b.count - a.count),
        by_insurer:  Object.entries(insurerCounts).map(([insurer, count]) => ({ insurer, count })).sort((a,b) => b.count - a.count),
        top_providers: topProviders,
        daily_trend: dailyTrend,
      },
      date_range: { from: fromDate, to: toDate },
    });

  } catch (err) {
    console.error("GET /api/qa-flags error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Categorise raw issue string into clean label
function categoriseIssue(issue) {
  const s = issue.toLowerCase();
  if (s.includes("missing vetting"))          return "Missing Vetting Comment";
  if (s.includes("approved >") || s.includes("approved>")) return "Approved > Submitted";
  if (s.includes("unit price mismatch"))      return "Unit Price Mismatch";
  if (s.includes("submitted calc"))           return "Calculation Error";
  if (s.includes("approved unit price"))      return "Approved Price Mismatch";
  if (s.includes("high quantity"))            return "High Quantity Outlier";
  return "Other";
}
