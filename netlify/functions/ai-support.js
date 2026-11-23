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
        system: `You are an expert support assistant for EP Local Pro AI — a business management SaaS platform for service businesses (plumbers, contractors, painters, electricians, etc.).

The platform includes: document creation (invoices, estimates, contracts, receipts), customer management, digital signatures, calendar/booking, business profiles, AI document generation, payment methods, and team management.

When a user describes an issue or shares a screenshot:
1. Analyze what you see carefully and identify the specific problem
2. Provide clear, numbered steps to resolve it
3. Keep your response concise and actionable — no fluff
4. If you see a screenshot, reference specific UI elements you can see

Always be friendly, professional, and solution-focused.`,
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
