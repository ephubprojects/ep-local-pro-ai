// No external dependencies — uses native fetch (Node 18+)

// ── Per-instance rate limiter (best-effort for serverless) ──────────────────
const _rl = new Map();
function _rateLimit(ip, max, windowMs){
  const now = Date.now(), k = ip || 'x';
  let r = _rl.get(k);
  if(!r || now > r.reset){ r = { n:0, reset: now + (windowMs||60000) }; _rl.set(k, r); }
  if(_rl.size > 5000) _rl.clear();
  r.n++;
  return r.n > (max||10);
}
function _getIp(event){
  return ((event.headers||{})['x-forwarded-for']||'').split(',')[0].trim() || 'x';
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if(_rateLimit(_getIp(event), 10, 60000)){
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Too many requests. Please wait a moment.' }) };
  }

  if((event.body || '').length > 30000){
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Request too large' }) };
  }

  try {
    const { messages, bizContext, takenSlots, lang } = JSON.parse(event.body || '{}');
    if (!messages || !Array.isArray(messages) || !bizContext) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const safeMessages = messages.slice(-12).map(m => ({
      role:    String(m.role    || 'user').slice(0, 10),
      content: String(m.content || ''   ).slice(0, 2000)
    })).filter(m => m.role === 'user' || m.role === 'assistant');

    const isES = lang === 'es-MX';
    const biz  = bizContext || {};
    const prof = biz.profile || {};

    const DAY_EN = { sun:'Sunday', mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday', sat:'Saturday' };
    const DAY_ES = { sun:'Domingo', mon:'Lunes', tue:'Martes', wed:'Miércoles', thu:'Jueves', fri:'Viernes', sat:'Sábado' };
    const avEntries = Object.entries(biz.availability || {}).filter(([,v]) => v && v.length > 0);
    const avText = avEntries.map(([d,[s,e]]) => `${isES ? DAY_ES[d] : DAY_EN[d]}: ${s}–${e}`).join(', ')
      || (isES ? 'Lunes–Viernes 9:00–17:00' : 'Mon–Fri 9:00am–5:00pm');
    const slotMin = biz.slotDuration || 30;
    const takenText = (takenSlots || []).slice(0, 50).length
      ? takenSlots.slice(0, 50).map(s => `${s.date} ${isES ? 'a las' : 'at'} ${s.time}`).join(', ')
      : (isES ? 'Ninguna aún' : 'None yet');

    const systemPrompt = isES ? `
Eres un asistente de reservas cálido, natural y profesional que habla español de México.
Negocio: ${String(biz.name || 'este negocio').slice(0,100)}
${biz.description ? `Descripción: ${String(biz.description).slice(0,200)}` : ''}
${prof.displayName ? `Atendido por: ${String(prof.displayName).slice(0,60)}${prof.title ? ', ' + String(prof.title).slice(0,60) : ''}` : ''}
${prof.phone ? `Teléfono: ${String(prof.phone).slice(0,20)}` : ''}

Horarios disponibles: ${avText}
Duración de cita: ${slotMin} minutos por cita
Citas ya ocupadas (NO disponibles): ${takenText}

Flujo de conversación:
1. Da la bienvenida al visitante y pregunta si desea ayuda para agendar una cita.
2. Pide su nombre completo.
3. Pregunta qué día y hora prefiere (ejemplo: "lunes por la mañana" o "jueves a las 3pm").
4. Verifica disponibilidad contra la lista de citas ocupadas. Si el horario está ocupado, ofrece 2 alternativas diferentes con opción de mañana o tarde cada una.
5. Confirma nombre, fecha y hora con el visitante.
6. Pide número de teléfono y correo electrónico.
7. Cuando tengas todos los datos, incluye al final de tu mensaje EXACTAMENTE este bloque (sin saltos de línea dentro):
   BOOKING_DATA:{"clientName":"nombre","clientPhone":"telefono","clientEmail":"correo","date":"YYYY-MM-DD","time":"HH:MM","notes":"Agendado por asistente IA"}
8. Confirma diciendo: "Su cita ha sido confirmada para [nombre] el [día] a las [hora]. ¡Hasta pronto!"

Reglas:
- Responde SOLO en español de México, de forma cálida y natural.
- Respuestas cortas y directas (máximo 3 oraciones por turno).
- Nunca inventes disponibilidad que no esté en los horarios.
- Si una fecha está ocupada, siempre ofrece alternativas concretas.
`.trim() : `
You are a warm, natural and professional booking assistant.
Business: ${String(biz.name || 'this business').slice(0,100)}
${biz.description ? `About: ${String(biz.description).slice(0,200)}` : ''}
${prof.displayName ? `With: ${String(prof.displayName).slice(0,60)}${prof.title ? ', ' + String(prof.title).slice(0,60) : ''}` : ''}
${prof.phone ? `Phone: ${String(prof.phone).slice(0,20)}` : ''}

Available hours: ${avText}
Appointment duration: ${slotMin} minutes per appointment
Already booked slots (NOT available): ${takenText}

Conversation flow:
1. Welcome the visitor and ask if they would like help scheduling an appointment.
2. Ask for their full name.
3. Ask what day and time they prefer (e.g. "Monday morning" or "Thursday at 3pm").
4. Check availability against the booked slots list. If that slot is taken, offer 2 different alternative days each with a morning or afternoon option.
5. Confirm name, date and time with the visitor.
6. Ask for their phone number and email address.
7. Once you have all details, include at the end of your message EXACTLY this block (no line breaks inside):
   BOOKING_DATA:{"clientName":"name","clientPhone":"phone","clientEmail":"email","date":"YYYY-MM-DD","time":"HH:MM","notes":"Booked via AI assistant"}
8. Confirm by saying: "Your appointment is set for [name] on [day] at [time]. See you soon!"

Rules:
- Reply ONLY in English, warm and natural.
- Keep replies short and direct (max 3 sentences per turn).
- Never invent availability outside the listed hours.
- If a slot is taken, always offer concrete alternatives.
`.trim();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system: systemPrompt,
        messages: safeMessages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ reply: data.content[0].text })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message })
    };
  }
};
