// Required env var in Vercel dashboard (Settings → Environment Variables):
//   ANTHROPIC_API_KEY = sk-ant-...  (get from console.anthropic.com)
//
// Optional: If you want to use OpenAI instead:
//   OPENAI_API_KEY = sk-...
//   AI_PROVIDER = "openai"  (defaults to "anthropic")

import { NextRequest, NextResponse } from "next/server";

// ─── Schema context (same as frontend, keeps AI accurate) ───
const SCHEMA_CONTEXT = `You are a MySQL query generator for Curacel's health insurance platform. Generate ONLY the SQL query, no explanation.

DATABASE SCHEMA:
1. claims (5.3M rows) - Core claims table
   - id (PK), hmo_id (FK→hmos), provider_id (FK→providers), enrollee_id (FK→enrollees)
   - encounter_id, hmo_pile_id (FK→hmos_piles), child_hmo_id, vetted_by_user_id
   - encounter_date (date), admission_start, admission_end
   - total_amount (decimal), approved_amount (decimal), auto_vet_amount (decimal)
   - provider_status (tinyint): 0=Pending, 1=Submitted, -1=Draft
   - hmo_status (int): 0=Pending, 1=Approved, -1=Rejected
   - approval_code, hmo_erp_id, entry_point, breached_sla_status
   - has_unmatched_tariff (tinyint), is_duplicate_of_id, auto_vet_confidence_score
   - created_at, updated_at, submitted_at, vetted_at, paid_at, synced_at, returned_at
   - enrollee_info (JSON), meta (JSON), attachments (JSON), checks_performed (JSON)
   - professional_fee_percent, professional_fee_submitted, professional_fee_approved
   - co_payment_fee, provider_ref, autovet_result_auto_implemented

2. claim_items (24.7M rows) - Line items per claim
   - id (PK), claim_id (FK→claims), care_id (FK→cares), tariff_id (FK→provider_tariffs)
   - description, qty, amount (billed), unit_price_billed, unit_price_approved
   - approved_amount, approved_qty, hmo_approved (tinyint)
   - comment_id (FK→claim_item_comments), provider_comment (mediumtext)
   - drug_unit_qty, drug_frequency, drug_duration
   - auto_vet_amount, auto_vet_qty, auto_vet_comments (JSON)
   - co_payment_amount, co_payment_value, prescription_id, hmo_erp_id
   - meta (JSON), dispute (longtext)

3. provider_tariffs (18.9M rows) - Pricing/tariff data
   - id (PK), hmo_id (FK→hmos), provider_id (FK→providers), care_id (FK→cares)
   - care_variation_id (FK→care_variations), tariff_band_id, drug_unit_id
   - desc (varchar), desc_synonym, code, amount, amount_max, fixed_quantity
   - pack_size_value, pack_size_unit
   - is_approved, is_auto_generated, require_pa
   - flagged_as_correct_at (timestamp - NULL=unflagged)
   - active_date, expiry_date, overrides_id
   - created_at, updated_at, meta (JSON)

4. cares (398K rows) - Master care/service catalog
   - id (PK), name (unique), base_name, type (varchar: drug/service/investigation/diagnosis/procedure)
   - type_id (int: 1=medications), active (tinyint), parent_id (self-ref)
   - drug_generic_id, cve_version (int: 2=V2), gender_limit, age_min, age_max
   - nlp_result, resolution_picked_at, meta (JSON)

5. care_variations (30K rows) - Variations of care items
   - id (PK), care_id (FK→cares), age_min, age_max
   - meta (JSON: contains $.strength, $.drug_form_id)

6. enrollees (2M rows) - Members/patients
   - id (PK), hmo_id (FK→hmos), insurance_no, alternate_insurance_no
   - firstname, lastname, middle_name, sex, birthdate
   - status (char(2)), hmo_plan_id, hmo_client_id, primary_provider_id
   - parent_id (for dependants), parent_relationship
   - is_capitated, hospital_state, hospital_lga, state, lga
   - blood_group, genotype, allergies, staff_number
   - created_at, updated_at, deleted_at, meta (JSON)

7. providers (9.8K rows) - Healthcare facilities
   - id (PK), name (unique), email, phone, address, state, state_id
   - nhis_code, category_id, parent_id, branch_code
   - location_lat, location_lng, exempt_diagnoses

8. hmos (167 rows) - HMO/Insurance partners
   - id (PK), name, code, email, currency, country_id, parent_id
   - is_active, can_receive_claims, is_floating, poc_insurer
   - credits, sms_balance, meta (JSON)

RELATED TABLES:
- claim_item_comments: id, name (the comment text), hmo_id
- claim_diagnoses: claim_id, diagnosis_id
- diagnoses: id, name
- hmo_plans: id, name, hmo_id
- hmo_clients: id, name, hmo_id
- hmos_piles: id, hmo_id, provider_id, child_hmo_id
- drug_forms: id, name
- drug_generics: id, name

COMMON JOIN PATTERNS:
- claims → providers: claims.provider_id = providers.id
- claims → enrollees: claims.enrollee_id = enrollees.id
- claims → claim_items: claims.id = claim_items.claim_id
- claim_items → claim_item_comments: claim_items.comment_id = claim_item_comments.id
- claim_items → cares: claim_items.care_id = cares.id
- provider_tariffs → cares: provider_tariffs.care_id = cares.id
- provider_tariffs → care_variations: provider_tariffs.care_variation_id = care_variations.id
- provider_tariffs → hmos: provider_tariffs.hmo_id = hmos.id
- enrollees → hmo_plans: enrollees.hmo_plan_id = hmo_plans.id
- care_variations → drug_forms: drug_forms.id = CAST(JSON_EXTRACT(care_variations.meta, '$.drug_form_id') AS UNSIGNED)

RULES:
- Always use backticks for reserved words and column names
- Use LEFT JOINs unless inner join is explicitly needed
- Do NOT add LIMIT unless the user explicitly asks for a limit or says "top N" or "first N". Let the user decide how many rows they want.
- Use aliases for readability
- Date filters: use >= start AND < end pattern (never BETWEEN, never 23:59:59)
- For all datetime/timestamp columns in SELECT, wrap them in DATE_FORMAT(column, '%Y-%m-%d %H:%i:%s') to produce clean readable output (e.g. '2026-01-16 07:06:19' instead of '2026-01-16T07:06:19'). Apply this to columns like created_at, updated_at, submitted_at, vetted_at, paid_at, synced_at, returned_at, encounter_date, admission_start, admission_end, etc.
- For medications: cares.type_id = 1
- For V2 cares: cares.cve_version = 2
- Unflagged tariffs: provider_tariffs.flagged_as_correct_at IS NULL
- Enrollee age: TIMESTAMPDIFF(YEAR, enrollees.birthdate, CURDATE())
- ERP IDs for Uganda: hmo_erp_id LIKE 'UG%', sort by CAST(SUBSTRING(hmo_erp_id, 3) AS UNSIGNED)
- Always include a sensible ORDER BY (newest first by default)
- For JSON extraction: JSON_UNQUOTE(JSON_EXTRACT(column, '$.path'))

COMMENT FIELD RULES (CRITICAL — read carefully before generating any comment-related query):
- "vetting comments", "auto-vet comments", "AI comments" → use claim_items.auto_vet_comments (JSON column)
  To search text inside this JSON field: LOWER(CAST(ci.auto_vet_comments AS CHAR)) LIKE '%keyword%'
  Always also add: ci.auto_vet_comments IS NOT NULL
- "provider comment", "provider's note" → use claim_items.provider_comment (mediumtext)
  Search: LOWER(ci.provider_comment) LIKE '%keyword%'
- "dispute", "appeal" → use claim_items.dispute (longtext)
  Search: LOWER(ci.dispute) LIKE '%keyword%'
- "HMO comment", "reviewer comment", "item comment" → use claim_item_comments.name (text)
  Requires JOIN: claim_items.comment_id = claim_item_comments.id
  Search: LOWER(cic.name) LIKE '%keyword%'
- If the user just says "comments" without specifying which field, DEFAULT to claim_items.auto_vet_comments

HMO FILTERING RULES (CRITICAL):
- ALWAYS filter HMO via claims.hmo_id (the claims table), even when the base table is claim_items or another child table. Join to claims first, then filter c.hmo_id.
- NEVER filter HMO via claim_item_comments.hmo_id or any other related table's hmo_id column.
- hmo_id values are ALWAYS positive integers. If the user provides a negative number like -73, use the absolute value (73). HMO IDs are never negative.

DYNAMIC DATE RULES (CRITICAL):
- "beginning of this year" or "start of this year" or "since January" → DATE_FORMAT(CURDATE(), '%Y-01-01')
- "this month" or "start of this month" → DATE_FORMAT(CURDATE(), '%Y-%m-01')
- "today" → CURDATE()
- "last 30 days" → DATE_SUB(CURDATE(), INTERVAL 30 DAY)
- "last N days" → DATE_SUB(CURDATE(), INTERVAL N DAY)
- "yesterday" → DATE_SUB(CURDATE(), INTERVAL 1 DAY)
- NEVER hardcode a specific year like '2024-01-01' or '2026-01-01'. Always use CURDATE()-based expressions so the query stays correct as time passes.

IMPORTANT: Return ONLY the SQL query. No markdown, no explanation, no backtick fences.`;

// ─── Azure OpenAI API call (primary) ─────────────────────────
async function callAzureOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const baseUrl = process.env.AZURE_OPENAI_BASE_URL;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2025-01-01-preview";
  
  if (!apiKey || !baseUrl) throw new Error("Azure OpenAI credentials not set");

  const url = `${baseUrl}openai/deployments/gpt-4.1-mini/chat/completions?api-version=${apiVersion}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      max_tokens: 2000,
      temperature: 0.3,
      messages: [
        { role: "system", content: SCHEMA_CONTEXT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Azure OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const sql = (data.choices?.[0]?.message?.content || "")
    .trim()
    .replace(/^```sql\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();

  return sql || "";
}

// ─── Anthropic API call (fallback) ───────────────────────────
async function callAnthropic(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: SCHEMA_CONTEXT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const sql = data.content
    ?.map((block: any) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim()
    .replace(/^```sql\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();

  return sql || "";
}

// ─── OpenAI API call (alternative) ───────────────────────────
async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 2000,
      messages: [
        { role: "system", content: SCHEMA_CONTEXT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const sql = (data.choices?.[0]?.message?.content || "")
    .trim()
    .replace(/^```sql\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();

  return sql || "";
}

// ─── Route handler ───────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt } = body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json(
        { error: "Missing or empty 'prompt' field" },
        { status: 400 }
      );
    }

    // Limit prompt length to prevent abuse
    if (prompt.length > 2000) {
      return NextResponse.json(
        { error: "Prompt too long (max 2000 characters)" },
        { status: 400 }
      );
    }

    // Choose provider (default: azure)
    const provider = process.env.AI_PROVIDER || "azure";
    let sql: string;

    if (provider === "openai") {
      sql = await callOpenAI(prompt.trim());
    } else if (provider === "anthropic") {
      sql = await callAnthropic(prompt.trim());
    } else {
      sql = await callAzureOpenAI(prompt.trim());
    }

    if (!sql) {
      return NextResponse.json(
        { error: "No SQL generated. Try being more specific." },
        { status: 422 }
      );
    }

    return NextResponse.json({ sql, provider });
  } catch (err: any) {
    console.error("[generate-sql] Error:", err.message);
    return NextResponse.json(
      { error: "Failed to generate SQL. Please try again." },
      { status: 500 }
    );
  }
}
