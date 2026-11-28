/* hub-flyer-scheduler.js
 * Runs every 5 minutes via Netlify scheduler.
 * Finds hub_scheduled_flyers whose scheduledAt has passed and posts
 * them to hub_messages as image messages so they appear in the channel.
 */

const PROJECT_ID = 'ep-local-pro-ai';
const API_KEY    = 'AIzaSyB4M24fLSHNKdWRHDDu9xj2sPGYCDZExiA';
const BASE       = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

exports.handler = async () => {
  const now    = new Date();
  const nowIso = now.toISOString();

  // ── 1. Query unsent flyers ────────────────────────────────────
  let queryRes;
  try {
    queryRes = await fetch(`${BASE}:runQuery?key=${API_KEY}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from:  [{ collectionId: 'hub_scheduled_flyers' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'sent' },
              op:    'EQUAL',
              value: { booleanValue: false }
            }
          },
          limit: 100
        }
      })
    });
  } catch (e) {
    console.error('hub-flyer-scheduler: query failed', e.message);
    return { statusCode: 500, body: e.message };
  }

  const rows = await queryRes.json();
  const due  = rows.filter(r => {
    if (!r.document?.name) return false;
    const ts = r.document.fields?.scheduledAt?.timestampValue;
    return ts && new Date(ts) <= now;
  });

  if (!due.length) {
    console.log('hub-flyer-scheduler: no flyers due');
    return { statusCode: 200, body: JSON.stringify({ posted: 0 }) };
  }

  // ── 2. Post each due flyer as a hub_message ───────────────────
  const results = await Promise.allSettled(due.map(async r => {
    const fields  = r.document.fields;
    const docName = r.document.name; // …/hub_scheduled_flyers/DOC_ID
    const docId   = docName.split('/').pop();

    const channelId = fields.channelId?.stringValue;
    const imageUrl  = fields.imageUrl?.stringValue;
    const fromName  = fields.fromName?.stringValue || 'Organizer';
    const caption   = fields.caption?.stringValue  || '';

    if (!channelId || !imageUrl) return;

    // Write hub_messages document
    await fetch(`${BASE}/hub_messages?key=${API_KEY}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          channelId:      { stringValue: channelId },
          type:           { stringValue: 'image' },
          from:           { stringValue: 'org' },
          fromName:       { stringValue: fromName },
          imageUrl:       { stringValue: imageUrl },
          ...(caption ? { caption: { stringValue: caption } } : {}),
          scheduledFlyer: { booleanValue: true },
          createdAt:      { timestampValue: nowIso }
        }
      })
    });

    // Mark flyer as sent
    await fetch(
      `${BASE}/hub_scheduled_flyers/${docId}?updateMask.fieldPaths=sent&updateMask.fieldPaths=sentAt&key=${API_KEY}`,
      {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            sent:   { booleanValue: true },
            sentAt: { timestampValue: nowIso }
          }
        })
      }
    );
  }));

  const posted = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`hub-flyer-scheduler: posted ${posted}, failed ${failed}`);
  return { statusCode: 200, body: JSON.stringify({ posted, failed }) };
};
