import { getSupabase } from "../../../lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Canonical insurer name map — add any bad variants here
const CANONICAL_INSURERS = {
  "uap old mutual uganda":       "UAP Old Mutual Uganda",
  "uap old mutual ug":           "UAP Old Mutual Uganda",
  "uap old mutual uganda ltd":   "UAP Old Mutual Uganda",
  "uap old mutual kenya":        "UAP Old Mutual Kenya",
  "jubilee health uganda":       "Jubilee Health Uganda",
  "jubilee health kenya":        "Jubilee Health Kenya",
  "jubilee health tanzania":     "Jubilee Health Tanzania",
};

function normaliseInsurer(name) {
  if (!name) return name;
  const key = name.toLowerCase().trim();
  return CANONICAL_INSURERS[key] || name;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const insurer = searchParams.get("insurer");

  try {
    const supabase = getSupabase();
    let query = supabase
      .from("claims_daily")
      .select("unique_key, date, insurer, claims_count, submitted_count, approved_count, rejected_count, total_billed, total_approved, currency")
      .order("date", { ascending: false });

    if (from) query = query.gte("date", from);
    if (to)   query = query.lte("date", to);
    if (insurer) query = query.eq("insurer", insurer);

    const { data, error } = await query;
    if (error) throw error;

    // Normalise insurer names before returning
    const normalised = data.map(row => ({
      ...row,
      insurer: normaliseInsurer(row.insurer),
    }));

    return NextResponse.json(
      { success: true, data: normalised, count: normalised.length, updated_at: new Date().toISOString() },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } }
    );
  } catch (error) {
    console.error("Supabase API Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
