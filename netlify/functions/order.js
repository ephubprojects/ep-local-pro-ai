const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const ok  = d        => ({ statusCode: 200, headers: CORS, body: JSON.stringify(d) });
const err = (m, c=400) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

// ─── Twilio SMS ────────────────────────────────────────────────────────────────
async function sendSms(to, body) {
  const SID   = process.env.TWILIO_SID;
  const TOKEN = process.env.TWILIO_TOKEN;
  const FROM  = process.env.TWILIO_FROM;
  if (!SID || !TOKEN || !FROM) return 'skipped';

  const params = new URLSearchParams({ From: FROM, To: to, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64')
      },
      body: params.toString()
    }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('Twilio error:', text);
    return 'error';
  }
  return 'sent';
}

// ─── Resend Email ──────────────────────────────────────────────────────────────
function buildOrderEmailHtml({ bizName, orderId, orderTotal, orderType, customerName, items }) {
  const rows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${i.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">$${(i.price || 0).toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#1a1a2e;padding:24px 28px;">
      <h2 style="color:#fff;margin:0;font-size:20px;">New Order — ${bizName}</h2>
      <p style="color:#aaa;margin:6px 0 0;">Order #${orderId.slice(-6).toUpperCase()} &bull; ${orderType}</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#333;">Customer: <strong>${customerName}</strong></p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#f8f8f8;">
            <th style="padding:8px 12px;text-align:left;font-size:13px;color:#666;">Item</th>
            <th style="padding:8px 12px;text-align:center;font-size:13px;color:#666;">Qty</th>
            <th style="padding:8px 12px;text-align:right;font-size:13px;color:#666;">Price</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="text-align:right;margin-top:16px;padding-top:16px;border-top:2px solid #1a1a2e;">
        <span style="font-size:18px;font-weight:bold;color:#1a1a2e;">Total: $${orderTotal.toFixed(2)}</span>
      </div>
    </div>
    <div style="background:#f8f8f8;padding:16px 28px;text-align:center;font-size:12px;color:#999;">
      EP Local Pro AI &bull; eplocalproai.com
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail({ to, subject, html }) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) return 'skipped';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`
    },
    body: JSON.stringify({
      from: 'EP Local Pro AI <noreply@eplocalproai.com>',
      to: [to],
      subject,
      html
    })
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Resend error:', text);
    return 'error';
  }
  return 'sent';
}

// ─── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err('Invalid JSON'); }

  const { action } = body;

  // ── notify ────────────────────────────────────────────────────────────────
  if (action === 'notify') {
    const { orderId, businessId, bizName, bizPhone, bizEmail, orderTotal, items, orderType, customerName } = body;
    if (!orderId || !bizName || !items || !orderTotal) return err('Missing required fields');

    const shortId = orderId.slice(-6).toUpperCase();
    const itemStr = items.map(i => `${i.qty}x ${i.name}`).join(', ');
    const smsMsg  = `New ${orderType || 'online'} order at ${bizName}! $${Number(orderTotal).toFixed(2)} — ${itemStr}. Order #${shortId}`;

    const [smsResult, emailResult] = await Promise.all([
      bizPhone ? sendSms(bizPhone, smsMsg) : Promise.resolve('skipped'),
      bizEmail ? sendEmail({
        to: bizEmail,
        subject: `New Order — ${bizName} — $${Number(orderTotal).toFixed(2)}`,
        html: buildOrderEmailHtml({ bizName, orderId, orderTotal: Number(orderTotal), orderType, customerName, items })
      }) : Promise.resolve('skipped')
    ]);

    return ok({ sms: smsResult, email: emailResult, orderId, shortId });
  }

  // ── get-status ────────────────────────────────────────────────────────────
  if (action === 'get-status') {
    const { orderId } = body;
    if (!orderId) return err('orderId required');
    // Frontend reads Firestore directly; this endpoint is for external integrations.
    // Return a lightweight acknowledgement — real status lives in Firestore.
    return ok({ orderId, status: 'check_firestore', message: 'Query Firestore orders collection for live status.' });
  }

  return err('Unknown action');
};
