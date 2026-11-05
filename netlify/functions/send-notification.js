const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const ok  = d        => ({ statusCode: 200, headers: CORS, body: JSON.stringify(d) });
const err = (m, c=400) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

// ─── Message templates ─────────────────────────────────────────────────────────
function buildMessage(type, bizName, data = {}) {
  switch (type) {
    case 'new_order':
      return `New order at ${bizName}! Total: $${Number(data.total || 0).toFixed(2)}. Check your dashboard at eplocalproai.com.`;

    case 'order_ready':
      return `Order #${data.orderNumber || 'N/A'} is READY for ${data.orderType || 'pickup'}!`;

    case 'booking_confirmed':
      return `New booking at ${bizName}: ${data.customerName || 'A customer'} on ${data.date || 'TBD'}.`;

    case 'account_activated':
      return `Welcome to EP Local Pro AI! Your ${bizName} AI page is live at eplocalproai.com/${data.slug || ''}.`;

    default:
      return `Notification from ${bizName}: ${data.message || type}`;
  }
}

function buildEmailHtml(type, bizName, message, data = {}) {
  const title = {
    new_order:         `New Order — ${bizName}`,
    order_ready:       `Order Ready — ${bizName}`,
    booking_confirmed: `New Booking — ${bizName}`,
    account_activated: `Your EP Local Pro AI Page is Live!`
  }[type] || `Notification from ${bizName}`;

  const accentColor = type === 'account_activated' ? '#16a34a' : '#1a1a2e';

  const extraBlock = (() => {
    if (type === 'new_order' && data.total) {
      return `<div style="text-align:center;margin:20px 0;">
        <span style="font-size:28px;font-weight:bold;color:${accentColor};">$${Number(data.total).toFixed(2)}</span>
        <p style="color:#999;margin:4px 0;font-size:13px;">Order Total</p>
      </div>`;
    }
    if (type === 'account_activated' && data.slug) {
      return `<div style="text-align:center;margin:20px 0;">
        <a href="https://eplocalproai.com/${data.slug}"
           style="display:inline-block;background:${accentColor};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
          View Your AI Page
        </a>
      </div>`;
    }
    return '';
  })();

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:${accentColor};padding:22px 28px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">${title}</h2>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;">${message}</p>
      ${extraBlock}
    </div>
    <div style="padding:14px 28px;background:#f8f8f8;border-top:1px solid #eee;text-align:center;font-size:11px;color:#aaa;">
      EP Local Pro AI &bull; eplocalproai.com
    </div>
  </div>
</body>
</html>`;
}

// ─── Twilio SMS ────────────────────────────────────────────────────────────────
async function sendSms(to, body) {
  const SID   = process.env.TWILIO_SID;
  const TOKEN = process.env.TWILIO_TOKEN;
  const FROM  = process.env.TWILIO_FROM;
  if (!SID || !TOKEN || !FROM) return false;

  const params = new URLSearchParams({ From: FROM, To: to, Body: body });
  try {
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
    return res.ok;
  } catch (e) {
    console.error('Twilio SMS error:', e.message);
    return false;
  }
}

// ─── Resend Email ──────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) return false;

  try {
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
    return res.ok;
  } catch (e) {
    console.error('Resend email error:', e.message);
    return false;
  }
}

// ─── Email subjects per type ───────────────────────────────────────────────────
function buildSubject(type, bizName) {
  switch (type) {
    case 'new_order':         return `New Order at ${bizName}`;
    case 'order_ready':       return `Your Order is Ready!`;
    case 'booking_confirmed': return `Booking Confirmed — ${bizName}`;
    case 'account_activated': return `Your EP Local Pro AI Page is Live!`;
    default:                  return `Notification from ${bizName}`;
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err('Invalid JSON'); }

  const { type, bizName, ownerEmail, ownerPhone, data = {} } = body;

  if (!type)    return err('type is required');
  if (!bizName) return err('bizName is required');

  const validTypes = ['new_order', 'order_ready', 'booking_confirmed', 'account_activated'];
  if (!validTypes.includes(type)) return err(`Unknown type. Must be one of: ${validTypes.join(', ')}`);

  const message = buildMessage(type, bizName, data);
  const subject = buildSubject(type, bizName);
  const html    = buildEmailHtml(type, bizName, message, data);

  const [smsSent, emailSent] = await Promise.all([
    ownerPhone ? sendSms(ownerPhone, message) : Promise.resolve(false),
    ownerEmail ? sendEmail(ownerEmail, subject, html) : Promise.resolve(false)
  ]);

  return ok({
    sent: { sms: smsSent, email: emailSent },
    type,
    bizName,
    message
  });
};
