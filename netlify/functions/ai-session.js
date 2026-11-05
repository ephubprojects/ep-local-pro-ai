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

  const { bizName, menuItems, lang, greeting } = body;
  const agentId = body.agentId || process.env.ELEVENLABS_DEFAULT_AGENT_ID;

  if (!agentId) return err('agentId is required (or set ELEVENLABS_DEFAULT_AGENT_ID)');

  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    // No API key — let client use unsigned session
    return ok({ agentId });
  }

  try {
    const response = await fetch(
      'https://api.elevenlabs.io/v1/convai/conversation/get_signed_url',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({ agent_id: agentId })
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return err(`ElevenLabs error ${response.status}: ${text}`, 502);
    }

    const data = await response.json();
    return ok({ signed_url: data.signed_url });
  } catch (e) {
    return err(`Failed to reach ElevenLabs: ${e.message}`, 500);
  }
};
