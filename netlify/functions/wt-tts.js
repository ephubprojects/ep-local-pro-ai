/* ============================================================
   EP Local Pro AI — wt-tts.js
   ElevenLabs TTS proxy for walkie talkie.
   POST { text, voiceId? } → { audio: base64, type: "audio/mpeg" }
   ============================================================ */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs Rachel

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { text, voiceId = DEFAULT_VOICE } = body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'text is required' }) };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY_EPLPA;
  if (!apiKey) {
    console.error('ELEVENLABS_API_KEY_EPLPA is not set');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'TTS not configured' }) };
  }

  try {
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text.trim().substring(0, 500),
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      console.error('ElevenLabs error:', ttsRes.status, errText);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'TTS service error' }) };
    }

    const arrayBuffer = await ttsRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ audio: base64, type: 'audio/mpeg' })
    };

  } catch (err) {
    console.error('wt-tts error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to generate audio' }) };
  }
};
