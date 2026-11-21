// EP HUB — Market Rate Calculator
// POST { service, city } → Claude Haiku pricing research
// Returns { min, max, average, suggestion, unit, breakdown, factors, references, disclaimer }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function ok(data)         { return { statusCode: 200, headers: CORS, body: JSON.stringify(data) }; }
function fail(msg, code = 400) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return fail('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail('Invalid JSON'); }

  const service = (body.service || '').trim();
  const city    = (body.city    || '').trim();
  if (!service || !city) return fail('service and city are required');
  if (service.length > 200 || city.length > 100) return fail('Input too long');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail('Service not configured', 503);

  const prompt = `You are an expert in local contractor and service provider pricing across all US regions and industries. A local business owner wants to know what to charge for the following:

Service/Job: "${service}"
Location: "${city}"

Provide realistic market pricing based on:
- Regional cost of living and labor costs for that specific area
- Typical contractor/service provider rates for this type of work
- Material costs if applicable
- Market competition in that region

Respond ONLY with a valid JSON object — no markdown, no explanation, no extra text:
{
  "min": <lowest typical price as a number>,
  "max": <highest typical price as a number>,
  "average": <market average as a number>,
  "suggestion": <recommended competitive starting price as a number>,
  "unit": "<per job | per hour | per sq ft | per month | etc.>",
  "breakdown": "<brief breakdown e.g. Labor 60% · Materials 30% · Overhead 10%>",
  "factors": ["<factor 1>", "<factor 2>", "<factor 3>"],
  "references": [
    { "source": "<known pricing source or platform>", "range": "<price range as string>" },
    { "source": "<another source>", "range": "<price range as string>" },
    { "source": "<another source>", "range": "<price range as string>" }
  ],
  "disclaimer": "Estimates based on regional market data. Actual prices vary by scope, materials, and contractor."
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
        max_tokens: 700,
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
      return fail('Could not generate a pricing estimate. Try a more specific service description.', 422);
    }

    return ok(result);
  } catch (e) {
    console.error('[market-rate] error:', e.message);
    return fail('Failed to get market rates. Please try again.', 500);
  }
};
