import { supabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const insurer = searchParams.get("insurer");

    let query = supabase
      .from("claims_daily")
      .select("unique_key, date, insurer, claims_count, submitted_count, approved_count, rejected_count, total_billed, total_approved, currency")
      .order("date", { ascending: false });

    if (from) query = query.gte("date", from);
    if (to) query = query.lte("date", to);
    if (insurer) query = query.eq("insurer", insurer);

    const { data, error } = await query;

    if (error) throw error;

    return NextResponse.json(
      { success: true, data, count: data.length, updated_at: new Date().toISOString() },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } }
    );
  } catch (error) {
    console.error("Supabase API Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
