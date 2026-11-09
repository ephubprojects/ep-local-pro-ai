/* Runs daily via Netlify scheduler — deletes wt_messages older than 24 hours
   and their corresponding Firebase Storage audio files. */

const PROJECT_ID   = 'ep-local-pro-ai';
const API_KEY      = 'AIzaSyB4M24fLSHNKdWRHDDu9xj2sPGYCDZExiA';
const BASE         = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const STORAGE_BASE = `https://firebasestorage.googleapis.com/v0/b/${PROJECT_ID}.firebasestorage.app/o`;

exports.handler = async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Query documents where createdAt < 24 hours ago (up to 500 at a time)
  let queryRes;
  try {
    queryRes = await fetch(`${BASE}:runQuery?key=${API_KEY}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from:  [{ collectionId: 'wt_messages' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'createdAt' },
              op:    'LESS_THAN',
              value: { timestampValue: cutoff }
            }
          },
          limit: 500
        }
      })
    });
  } catch (e) {
    console.error('cleanup-wt-messages: query failed', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  const rows = await queryRes.json();

  // Each row is { document: { name: '…/wt_messages/DOCID', fields: { storagePath: { stringValue: '…' } } } }
  const docs = rows.filter(r => r.document?.name);

  if (!docs.length) {
    console.log('cleanup-wt-messages: nothing to delete');
    return { statusCode: 200, body: JSON.stringify({ deleted: 0 }) };
  }

  // Delete Storage files (best-effort — skip docs with no storagePath)
  const storagePaths = docs
    .map(r => r.document.fields?.storagePath?.stringValue)
    .filter(Boolean);

  if (storagePaths.length) {
    await Promise.allSettled(
      storagePaths.map(path => {
        const encoded = encodeURIComponent(path);
        return fetch(`${STORAGE_BASE}/${encoded}?key=${API_KEY}`, { method: 'DELETE' });
      })
    );
  }

  // Delete Firestore documents
  const results = await Promise.allSettled(
    docs.map(r => fetch(`${r.document.name}?key=${API_KEY}`, { method: 'DELETE' }))
  );

  const deleted = results.filter(r => r.status === 'fulfilled').length;
  const failed  = results.filter(r => r.status === 'rejected').length;

  console.log(`cleanup-wt-messages: deleted ${deleted}, failed ${failed}, storage paths ${storagePaths.length}`);
  return { statusCode: 200, body: JSON.stringify({ deleted, failed, storagePaths: storagePaths.length, cutoff }) };
};
