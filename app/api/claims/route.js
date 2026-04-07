import { NextResponse } from "next/server";
import { getDailyClaimsByInsurer } from "../../../lib/metabase";
import { getInsurerName, INSURER_MAP } from "../../../lib/insurerMapping";

export const dynamic = "force-dynamic";

// Map currency by insurer country (inferred from insurer names)
function getCurrency(insurerName) {
  if (!insurerName) return "NGN";
  const name = insurerName.toLowerCase();
  if (name.includes("uganda")) return "UGX";
  if (name.includes("kenya")) return "KES";
  if (name.includes("tanzania")) return "TZS";
  if (name.includes("egypt")) return "EGP";
  return "NGN"; // Default to Nigerian Naira
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const insurer = searchParams.get("insurer");
  const dateField = searchParams.get("dateField") || "submitted_at";

  try {
    // Default to last 90 days if no dates provided
    const endDate = to || new Date().toISOString().split("T")[0];
    const startDate = from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Fetch from Metabase
    const metabaseData = await getDailyClaimsByInsurer({ startDate, endDate, dateField });

    // Transform to match frontend expected format
    const transformed = metabaseData.map(row => {
      const insurerName = getInsurerName(row.hmo_id) || `Unknown Insurer (${row.hmo_id})`;
      const dateStr = row.date instanceof Date 
        ? row.date.toISOString().split("T")[0]
        : (row.date || "").split("T")[0];
      
      return {
        unique_key: `${dateStr}_${row.hmo_id}`,
        date: dateStr,
        insurer: insurerName,
        hmo_id: row.hmo_id,
        claims_count: parseInt(row.claims_count) || 0,
        submitted_count: parseInt(row.submitted_count) || 0,
        approved_count: parseInt(row.approved_count) || 0,
        rejected_count: parseInt(row.rejected_count) || 0,
        total_billed: parseFloat(row.total_billed) || 0,
        total_approved: parseFloat(row.total_approved) || 0,
        currency: getCurrency(insurerName),
      };
    });

    // Filter by insurer if specified
    let filtered = transformed;
    if (insurer) {
      filtered = transformed.filter(row => 
        row.insurer.toLowerCase() === insurer.toLowerCase()
      );
    }

    // Sort by date descending
    filtered.sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json(
      { 
        success: true, 
        data: filtered, 
        count: filtered.length, 
        updated_at: new Date().toISOString(),
        source: "metabase"
      },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } }
    );
  } catch (error) {
    console.error("Metabase API Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
