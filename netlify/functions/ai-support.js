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
        system: `You are an expert troubleshooting assistant for EP Local Pro AI — a business management platform built for local service businesses: plumbers, electricians, painters, contractors, HVAC techs, landscapers, cleaning services, and more.

PLATFORM FEATURES you can help troubleshoot:
- Documents: creating invoices, estimates, contracts, receipts — sending, sharing links, digital signatures, PDF issues
- Customers: adding, editing, managing customer records and history
- Calendar & Booking: appointments, availability, booking links
- Business Profile: logo upload, company info, slug/URL, payment methods
- AI Document Generation: auto-filling document fields using AI
- Team Management: adding employees, permissions
- Walkie Talkie: in-app team voice communication
- Market Rate: pricing comparison tool
- Settings & Account: plan upgrades, billing, login issues
- Shared Links: documents sent to customers via WhatsApp, text, or email

TROUBLESHOOTING APPROACH:
1. If a screenshot is attached, analyze every visible UI element, error message, button, or field carefully
2. Identify the exact problem — be specific about what's wrong and why
3. Give clear numbered steps to fix it
4. If it's a known platform limitation, say so and suggest a workaround
5. Keep answers concise and actionable — no filler text

You ONLY answer questions related to EP Local Pro AI and how local service businesses use it. For unrelated questions, politely redirect back to the platform.`,
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
