/* audio-proxy.js
 * Fetches a Firebase Storage audio file server-side and streams it back
 * to the browser with same-origin headers. This lets the browser use
 * fetch() + AudioContext.decodeAudioData() without CORS restrictions,
 * which fixes premature cutoff caused by missing WebM duration metadata
 * in browser-recorded blobs.
 *
 * Usage: GET /.netlify/functions/audio-proxy?url=<encodedFirebaseStorageUrl>
 */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, body: 'Missing url parameter' };
  }

  // Security: only proxy Firebase Storage URLs for this project
  const decoded = decodeURIComponent(url);
  if (
    !decoded.startsWith('https://firebasestorage.googleapis.com/') ||
    !decoded.includes('ep-local-pro-ai')
  ) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  try {
    const resp = await fetch(decoded);
    if (!resp.ok) {
      return { statusCode: resp.status, body: 'Upstream error' };
    }

    const contentType = resp.headers.get('Content-Type') || 'audio/webm';
    const buffer = Buffer.from(await resp.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        'Content-Type':                contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'private, max-age=300'
      },
      body:            buffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    console.error('audio-proxy error:', err);
    return { statusCode: 500, body: 'Proxy error' };
  }
};
