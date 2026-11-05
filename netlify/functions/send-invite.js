const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function ok(data)      { return { statusCode: 200, headers, body: JSON.stringify(data) }; }
function err(msg, code = 400) { return { statusCode: code, headers, body: JSON.stringify({ error: msg }) }; }

function buildHtml({ toName, bizName, inviteUrl, referrerUsername }) {
  return `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h1 style="color:#4f46e5">Welcome to EP Local Pro AI!</h1>
  <p>Hi ${toName},</p>
  <p>Your AI-powered business page for <strong>${bizName}</strong> is ready. Click below to set up your account and go live.</p>
  <a href="${inviteUrl}" style="display:inline-block;background:#4f46e5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Set Up My Account &rarr;</a>
  <p style="margin-top:24px;color:#475569;font-size:14px">This invite link expires in 7 days. Questions? Reply to this email.</p>
  ${referrerUsername ? `<p style="color:#475569;font-size:12px">Referred by EP HUB member: ${referrerUsername}</p>` : ''}
</div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return err('Invalid JSON body');
  }

  const { toEmail, toName, bizName, inviteUrl, referrerUsername } = body;

  // Validate required fields
  if (!toEmail)   return err('toEmail is required');
  if (!toName)    return err('toName is required');
  if (!bizName)   return err('bizName is required');
  if (!inviteUrl) return err('inviteUrl is required');

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return err('Server configuration error: RESEND_API_KEY not set', 500);

  const emailPayload = {
    from: 'EP Local Pro AI <noreply@eplocalproai.com>',
    to: toEmail,
    subject: `Your AI Business Page is Ready — ${bizName}`,
    html: buildHtml({ toName, bizName, inviteUrl, referrerUsername })
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`
      },
      body: JSON.stringify(emailPayload)
    });

    if (!response.ok) {
      const text = await response.text();
      return err(`Resend error ${response.status}: ${text}`, 500);
    }

    const data = await response.json();
    return ok({ success: true, emailId: data.id });
  } catch (e) {
    return err(`Failed to send email: ${e.message}`, 500);
  }
};
