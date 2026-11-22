// EP HUB — returns caller's IP address
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers['x-real-ip']
    || event.requestContext?.identity?.sourceIp
    || '—';

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ip }) };
};
