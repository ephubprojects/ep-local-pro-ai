const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const ok  = d        => ({ statusCode: 200, headers: CORS, body: JSON.stringify(d) });
const err = (m, c=400) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

// ─── Reuse core logic from invoice-generate ────────────────────────────────────
// (Duplicated here because Netlify functions cannot require() each other at runtime.
//  Keeping the shared code minimal and in sync.)

function genDocNumber() {
  return `EST-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function calcTotals(items, taxRate = 0) {
  const subtotal = items.reduce((s, i) => s + (Number(i.qty || 1) * Number(i.price || 0)), 0);
  const tax      = subtotal * (Number(taxRate) / 100);
  const total    = subtotal + tax;
  return { subtotal, tax, total };
}

function buildHtmlDoc(data) {
  const { docNumber, bizName, bizAddress, bizPhone, bizEmail,
          customerName, customerEmail, customerAddress,
          items, subtotal, tax, total, notes, terms, footer,
          generatedAt } = data;

  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  const rows = (items || []).map(i => {
    const qty      = Number(i.qty || 1);
    const price    = Number(i.price || 0);
    const lineTotal = qty * price;
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;">
          <strong>${i.name || ''}</strong>${i.desc ? `<br><span style="font-size:12px;color:#888;">${i.desc}</span>` : ''}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">${qty}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">$${price.toFixed(2)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">$${lineTotal.toFixed(2)}</td>
      </tr>`;
  }).join('');

  const taxRow = Number(tax) > 0 ? `
    <tr>
      <td colspan="3" style="padding:6px 12px;text-align:right;color:#666;">Tax</td>
      <td style="padding:6px 12px;text-align:right;color:#666;">$${Number(tax).toFixed(2)}</td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Estimate ${docNumber}</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:30px;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="padding:32px 36px;border-bottom:3px solid #2563eb;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;">
      <div>
        <h1 style="margin:0 0 6px;font-size:24px;color:#1a1a2e;">${bizName}</h1>
        ${bizAddress ? `<p style="margin:2px 0;color:#555;font-size:14px;">${bizAddress}</p>` : ''}
        ${bizPhone   ? `<p style="margin:2px 0;color:#555;font-size:14px;">${bizPhone}</p>`   : ''}
        ${bizEmail   ? `<p style="margin:2px 0;color:#555;font-size:14px;">${bizEmail}</p>`   : ''}
      </div>
      <div style="text-align:right;">
        <div style="display:inline-block;background:#2563eb;color:#fff;padding:4px 14px;border-radius:4px;font-size:13px;font-weight:bold;text-transform:uppercase;margin-bottom:8px;">Estimate</div>
        <p style="margin:4px 0;font-size:14px;color:#555;"># ${docNumber}</p>
        <p style="margin:4px 0;font-size:14px;color:#555;">Date: ${dateStr}</p>
      </div>
    </div>

    <!-- Bill To -->
    <div style="padding:24px 36px;background:#fafafa;border-bottom:1px solid #eee;">
      <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;color:#999;font-weight:bold;letter-spacing:1px;">Prepared For</p>
      <p style="margin:2px 0;font-size:16px;font-weight:bold;color:#1a1a2e;">${customerName}</p>
      ${customerEmail   ? `<p style="margin:2px 0;font-size:14px;color:#555;">${customerEmail}</p>`   : ''}
      ${customerAddress ? `<p style="margin:2px 0;font-size:14px;color:#555;">${customerAddress}</p>` : ''}
    </div>

    <!-- Items Table -->
    <div style="padding:24px 36px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#eff6ff;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#444;">Description</th>
            <th style="padding:10px 12px;text-align:center;font-size:13px;color:#444;">Qty</th>
            <th style="padding:10px 12px;text-align:right;font-size:13px;color:#444;">Unit Price</th>
            <th style="padding:10px 12px;text-align:right;font-size:13px;color:#444;">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="padding:10px 12px;text-align:right;color:#666;border-top:1px solid #eee;">Subtotal</td>
            <td style="padding:10px 12px;text-align:right;border-top:1px solid #eee;">$${Number(subtotal).toFixed(2)}</td>
          </tr>
          ${taxRow}
          <tr>
            <td colspan="3" style="padding:12px 12px;text-align:right;font-size:16px;font-weight:bold;color:#2563eb;border-top:2px solid #2563eb;">Estimated Total</td>
            <td style="padding:12px 12px;text-align:right;font-size:18px;font-weight:bold;color:#2563eb;border-top:2px solid #2563eb;">$${Number(total).toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    ${notes ? `
    <div style="padding:0 36px 20px;">
      <p style="font-size:12px;text-transform:uppercase;color:#999;font-weight:bold;letter-spacing:1px;margin-bottom:6px;">Notes</p>
      <p style="font-size:14px;color:#555;margin:0;">${notes}</p>
    </div>` : ''}

    <div style="padding:0 36px 20px;">
      <p style="font-size:12px;text-transform:uppercase;color:#999;font-weight:bold;letter-spacing:1px;margin-bottom:6px;">Terms</p>
      <p style="font-size:14px;color:#555;margin:0;">${terms}</p>
    </div>

    <div style="padding:16px 36px;background:#f8f8f8;border-top:1px solid #eee;text-align:center;font-size:12px;color:#aaa;">
      ${footer || 'Generated by EP Local Pro AI &bull; eplocalproai.com'}
    </div>

  </div>
</body>
</html>`;
}

async function generateWithAI({ bizName, customerName, items, jobDescription }) {
  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) return null;

  const prompt = `Generate a professional estimate document for a local business.
Business: ${bizName}
Customer: ${customerName}
Items/Services: ${JSON.stringify(items)}
${jobDescription ? 'Job: ' + jobDescription : ''}
Return ONLY a JSON object with these fields: { title, intro, lineItems, terms, footer }`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 600
      })
    });
    if (!res.ok) return null;
    const json    = await res.json();
    const raw     = json.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// ─── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err('Invalid JSON'); }

  const {
    bizName, bizAddress = '', bizPhone = '', bizEmail = '',
    customerName, customerEmail = '', customerAddress = '',
    items = [], notes = '', taxRate = 0,
    jobDescription = ''
  } = body;

  if (!bizName)      return err('bizName is required');
  if (!customerName) return err('customerName is required');
  if (!items.length) return err('items array is required and must not be empty');

  const type        = 'estimate';
  const docNumber   = genDocNumber();
  const { subtotal, tax, total } = calcTotals(items, taxRate);
  const generatedAt = new Date().toISOString();

  // Estimate-specific default terms
  const defaultTerms = 'This estimate is valid for 30 days from the date issued. Prices are subject to change after this period. Final invoice may vary based on actual work performed.';

  const aiData = await generateWithAI({ bizName, customerName, items, jobDescription });

  const lineItems = aiData?.lineItems || items;
  const terms     = aiData?.terms     || defaultTerms;
  const footer    = aiData?.footer    || 'Generated by EP Local Pro AI · eplocalproai.com';

  const docData = {
    docNumber, type, bizName, bizAddress, bizPhone, bizEmail,
    customerName, customerEmail, customerAddress,
    items: lineItems, subtotal, tax, total,
    notes, terms, footer, generatedAt
  };

  const htmlContent = buildHtmlDoc(docData);

  return ok({ ...docData, htmlContent });
};
