// EP HUB — Market Rate Calculator
// POST { service, city, lang? } → Claude Haiku pricing research
// Returns { min, max, average, suggestion, unit, breakdown, factors, references, disclaimer }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function ok(data)              { return { statusCode: 200, headers: CORS, body: JSON.stringify(data) }; }
function fail(msg, code = 400) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return fail('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail('Invalid JSON'); }

  const service = (body.service || '').trim();
  const city    = (body.city    || '').trim();
  const lang    = (body.lang    || 'en-US').trim();
  if (!service || !city) return fail('service and city are required');
  if (service.length > 300 || city.length > 100) return fail('Input too long');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail('Service not configured', 503);

  const isSpanish = lang === 'es-MX';

  const langInstruction = isSpanish
    ? 'El usuario habla español (México). Responde COMPLETAMENTE en español: breakdown, factors, unit, disclaimer y source deben estar en español.'
    : 'Respond in English.';

  const prompt = `You are an expert in local contractor, restaurant, and service provider pricing across all US and Mexico regions and industries. You help ANY type of local business — plumbers, roofers, electricians, landscapers, restaurants, caterers, event planners, cleaners, auto shops, salons, and more.

${langInstruction}

A local business owner wants to know what to charge:
Service/Job: "${service}"
Location: "${city}"

PRICING RULES — read carefully:
1. RESTAURANT / FOOD SERVICE / EVENTS: If the query mentions number of people, guests, event catering, food service, reservations, or banquets — provide per-person pricing AND estimate the total. Set "unit" to "per person" and include the total estimate in breakdown.
2. CONTRACTORS / TRADES: Include labor %, materials %, permit fees, overhead.
3. HOURLY SERVICES (cleaning, tutoring, consulting): Set "unit" to "per hour" or "per session".
4. REGIONAL ADJUSTMENT: Use cost-of-living and labor market data specific to "${city}".
5. BASE PRICES on what real local businesses in that area charge today — be realistic, not theoretical.

Respond ONLY with a valid JSON object — no markdown, no explanation:
{
  "min": <lowest typical price as integer>,
  "max": <highest typical price as integer>,
  "average": <market average as integer>,
  "suggestion": <recommended competitive starting price as integer>,
  "unit": "<per person | per job | per hour | per sq ft | per month | per event | etc.>",
  "breakdown": "<cost breakdown e.g. Food cost 35% · Labor 30% · Venue/Overhead 25% · Profit 10%>",
  "factors": ["<key pricing factor 1>", "<factor 2>", "<factor 3>", "<factor 4>"],
  "references": [
    { "source": "<known source, platform, or industry average>", "range": "<price range string>" },
    { "source": "<another source>", "range": "<price range string>" },
    { "source": "<another source>", "range": "<price range string>" }
  ],
  "disclaimer": "<one sentence disclaimer about estimate accuracy>"
}`;

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error('[market-rate] Claude error:', aiResp.status, errText.slice(0, 300));
      return fail('AI service temporarily unavailable', 502);
    }

    const aiData = await aiResp.json();
    const raw = aiData.content?.[0]?.text || '{}';

    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      try { result = m ? JSON.parse(m[0]) : null; } catch { result = null; }
    }

    if (!result || typeof result.min !== 'number' || typeof result.max !== 'number') {
      return fail('Could not generate a pricing estimate. Try a more specific description.', 422);
    }

    return ok(result);
  } catch (e) {
    console.error('[market-rate] error:', e.message);
    return fail('Failed to get market rates. Please try again.', 500);
  }
};
