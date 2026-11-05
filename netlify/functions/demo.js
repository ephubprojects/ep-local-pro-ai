const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function ok(data)      { return { statusCode: 200, headers, body: JSON.stringify(data) }; }
function err(msg, code = 400) { return { statusCode: code, headers, body: JSON.stringify({ error: msg }) }; }

// Fields that are safe to expose publicly
const PUBLIC_FIELDS = ['name', 'category', 'greeting', 'menuItems', 'paymentOptions', 'slug', 'description', 'logoUrl', 'accentColor'];

function extractPublicFields(firestoreDoc) {
  // Firestore REST API returns fields in { fieldName: { stringValue/integerValue/etc } } format
  const fields = firestoreDoc.fields || {};
  const result = {};

  for (const key of PUBLIC_FIELDS) {
    if (!(key in fields)) continue;
    const val = fields[key];
    if (val.stringValue !== undefined)  result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = Number(val.integerValue);
    else if (val.doubleValue !== undefined)  result[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.arrayValue !== undefined) {
      result[key] = (val.arrayValue.values || []).map(item => {
        if (item.stringValue !== undefined) return item.stringValue;
        if (item.mapValue !== undefined) return decodeMap(item.mapValue.fields || {});
        return null;
      });
    } else if (val.mapValue !== undefined) {
      result[key] = decodeMap(val.mapValue.fields || {});
    }
  }
  return result;
}

function decodeMap(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined)  out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined)  out[k] = v.doubleValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
  }
  return out;
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

  const { action } = body;

  if (!action) return err('action is required');

  if (action === 'get-public') {
    const { slug } = body;
    if (!slug || typeof slug !== 'string') return err('slug is required');

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const apiKey    = process.env.FIREBASE_API_KEY;

    if (!projectId) return err('Server configuration error: FIREBASE_PROJECT_ID not set', 500);

    const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery${apiKey ? `?key=${apiKey}` : ''}`;

    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'demos' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'slug' },
            op: 'EQUAL',
            value: { stringValue: slug }
          }
        },
        limit: 1
      }
    };

    try {
      const response = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody)
      });

      if (!response.ok) {
        const text = await response.text();
        return err(`Firestore error ${response.status}: ${text}`, 502);
      }

      const results = await response.json();

      // runQuery returns an array; first item may be a no-match sentinel ({ readTime } only)
      const hit = results.find(r => r.document);
      if (!hit) return err('Demo not found', 404);

      const publicData = extractPublicFields(hit.document);
      return ok({ demo: publicData });
    } catch (e) {
      return err(`Failed to query Firestore: ${e.message}`, 500);
    }
  }

  return err(`Unknown action: ${action}`);
};
