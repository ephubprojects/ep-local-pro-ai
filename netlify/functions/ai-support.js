const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/ep-local-pro-ai/databases/(default)/documents';
const FB_KEY    = 'AIzaSyB4M24fLSHNKdWRHDDu9xj2sPGYCDZExiA'; // public client key — already in JS bundle

const H = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const ok   = d       => ({ statusCode: 200, headers: H, body: JSON.stringify(d) });
const fail = (msg, c = 400) => ({ statusCode: c, headers: H, body: JSON.stringify({ error: msg }) });

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (event.httpMethod !== 'POST')    return fail('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail('Invalid JSON'); }

  const { uid, messages } = body;
  if (!uid)             return fail('uid required');
  if (!messages?.length) return fail('messages required');

  // ── Verify access via config/aiAccess (public-readable collection) ──
  try {
    const r = await fetch(`${FIRESTORE}/config/aiAccess?key=${FB_KEY}`);
    if (r.status === 404) return fail('AI support is not configured. Contact your administrator.', 403);
    if (!r.ok)            return fail('Could not verify access', 500);
    const d  = await r.json();
    const enabled = (d.fields?.enabledUids?.arrayValue?.values || []).map(v => v.stringValue);
    if (!enabled.includes(uid)) return fail('AI support is not enabled for your account. Contact your administrator.', 403);
  } catch (e) {
    console.error('aiAccess check error:', e);
    return fail('Could not verify access', 500);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail('AI service not configured', 500);

  // ── Call Claude ──
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: `You are an expert assistant for EP Local Pro AI users — local service business owners and their teams: plumbers, electricians, painters, contractors, HVAC techs, landscapers, cleaning services, roofers, and more.

You help with TWO types of questions:

── 1. PLATFORM HELP (EP Local Pro AI software) ──
- Documents: invoices, estimates, contracts, receipts — creating, sending, sharing links, digital signatures
- Customers: adding, editing, managing customer records
- Calendar & Booking: appointments, availability, booking links
- Business Profile: logo, company info, payment methods
- AI Document Generation, Team Management, Walkie Talkie, Market Rate tool
- Shared Links: sending documents via WhatsApp, text, or email
- Account: login issues, plan upgrades, settings

── 2. TRADE KNOWLEDGE (real field questions) ──
Answer practical questions from tradespeople like:
- Plumbing: pipe sizing, trench depths, water pressure, code requirements, rough-in dimensions, fixture installation
- Electrical: wire gauges, breaker sizing, NEC code, outlet spacing, panel work
- HVAC: duct sizing, refrigerant types, BTU calculations, efficiency ratings
- Painting: surface prep, primer selection, paint coverage, finish types
- Contracting/Construction: framing, concrete mix ratios, load calculations, permits
- Landscaping, roofing, and other trades — answer based on best practices and common codes

RESPONSE STYLE:
1. If a screenshot is attached, analyze visible UI elements and errors carefully
2. Give specific, numbered steps or direct answers — no filler
3. For code/depth/sizing questions, cite the typical standard (e.g. IRC, NEC, local norms) and note that local codes may vary
4. Be concise and practical — these are working professionals in the field`,
        messages
      })
    });

    if (!r.ok) {
      const t = await r.text();
      console.error('Anthropic error:', r.status, t);
      return fail('AI service error', 502);
    }

    const d = await r.json();
    return ok({ text: d.content?.[0]?.text || '' });
  } catch (e) {
    console.error('AI call failed:', e);
    return fail('AI service error', 500);
  }
};
