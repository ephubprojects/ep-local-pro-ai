const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function ok(data)      { return { statusCode: 200, headers, body: JSON.stringify(data) }; }
function err(msg, code = 400) { return { statusCode: code, headers, body: JSON.stringify({ error: msg }) }; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return err('Invalid JSON body');
  }

  const { demoId, ownerUid, ownerEmail, ownerName, plan } = body;

  // Validate required fields
  if (!demoId)     return err('demoId is required');
  if (!ownerEmail) return err('ownerEmail is required');
  if (!ownerName)  return err('ownerName is required');

  // Build a base64url invite token (stateless — no Firestore write here)
  const tokenPayload = { demoId, ownerEmail, ts: Date.now() };
  if (ownerUid) tokenPayload.ownerUid = ownerUid;
  if (plan)     tokenPayload.plan     = plan;

  const inviteToken = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  const inviteUrl   = `https://eplocalproai.com/auth.html?token=${inviteToken}`;

  return ok({
    inviteToken,
    inviteUrl,
    message: 'Invite token generated'
  });
};
