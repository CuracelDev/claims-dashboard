// API route for generating AI insights from insurer feedback data
import { chatCompletion, MODELS } from '../../../../lib/azure-openai';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { total, open, fixed, pending, topCats, topItems, topDx } = await request.json();

    if (!total) {
      return Response.json({ error: 'No data provided' }, { status: 400 });
    }

    const prompt = `You are a health insurance claims operations analyst. Analyze this insurer feedback data and give sharp operational intelligence.

SUMMARY:
- Total items: ${total}
- Open: ${open} (${Math.round(open/total*100)}%)
- Fixed: ${fixed} (${Math.round(fixed/total*100)}%)
- Pending Insurer: ${pending}
- Resolution Rate: ${Math.round(fixed/total*100)}%

TOP ISSUE CATEGORIES:
${topCats?.length ? topCats.map(([k,v]) => `- ${k}: ${v} cases`).join('\n') : '- No categories mapped'}

MOST FLAGGED CARE ITEMS:
${topItems?.length ? topItems.map(([k,v]) => `- ${k}: ${v} flags`).join('\n') : '- No care items mapped'}

TOP DIAGNOSES:
${topDx?.length ? topDx.map(([k,v]) => `- ${k}: ${v} cases`).join('\n') : '- No diagnoses mapped'}

Provide these sections:
1. SITUATION SUMMARY (2 sentences)
2. TOP 3 CRITICAL PATTERNS
3. RECURRING PROBLEMS
4. THIS WEEKS RECOMMENDATION
5. RESOLUTION RATE ASSESSMENT

Be direct and operational. Plain text only, no symbols.`;

    const insight = await chatCompletion({
      model: MODELS.GPT_41_MINI,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1000,
      temperature: 0.7,
    });

    return Response.json({ insight: insight || 'Unable to generate insight.' });
  } catch (e) {
    console.error('[Insurer Feedback Insight]', e);
    return Response.json({ error: 'Failed to generate insight' }, { status: 500 });
  }
}
