const webpush = require('web-push');

const CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT  || 'https://ep-local-pro-ai.netlify.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // items: [{ subscription: {...}, url: '...' }]
  const { items = [], title = '📻 Staff Radio', body: notifBody = 'New voice message', tag = 'wt-call' } = body;

  if (!items.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0 }) };

  const results = await Promise.allSettled(
    items.map(({ subscription, url }) =>
      webpush.sendNotification(subscription, JSON.stringify({ title, body: notifBody, url: url || '/', tag }))
    )
  );

  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent, failed }) };
};
