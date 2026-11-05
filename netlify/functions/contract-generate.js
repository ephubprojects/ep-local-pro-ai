const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const ok  = d        => ({ statusCode: 200, headers: CORS, body: JSON.stringify(d) });
const err = (m, c=400) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

// ─── OpenAI contract generator ─────────────────────────────────────────────────
async function generateContractWithAI({
  bizName, bizAddress, customerName, customerAddress,
  jobDescription, startDate, endDate, totalPrice, paymentTerms, contractTerms
}) {
  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) return null;

  const prompt = `Generate a professional service contract between ${bizName} (Contractor) and ${customerName} (Client).
Job: ${jobDescription}.
Total: $${totalPrice}.
Start: ${startDate}.
End: ${endDate || 'Upon completion'}.
Payment terms: ${paymentTerms || 'Due upon completion'}.
Additional terms: ${contractTerms || 'Standard workmanship warranty applies.'}.
Return ONLY a JSON object with these fields: { title, parties, scopeOfWork, timeline, payment, terms, signatures }`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000
      })
    });
    if (!res.ok) return null;
    const json    = await res.json();
    const raw     = json.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// ─── Fallback template ─────────────────────────────────────────────────────────
function buildTemplateSections({
  bizName, bizAddress, customerName, customerAddress,
  jobDescription, startDate, endDate, totalPrice, paymentTerms, contractTerms
}) {
  return {
    title:       'Service Contract',
    parties:     `This Service Contract ("Agreement") is entered into between ${bizName}${bizAddress ? ', ' + bizAddress : ''} ("Contractor") and ${customerName}${customerAddress ? ', ' + customerAddress : ''} ("Client").`,
    scopeOfWork: `Contractor agrees to perform the following services: ${jobDescription}.`,
    timeline:    `Work shall commence on ${startDate} and be completed by ${endDate || 'upon mutual agreement'}.`,
    payment:     `Total contract price: $${Number(totalPrice).toFixed(2)}. ${paymentTerms || 'Payment is due upon completion of work.'}`,
    terms:       contractTerms || 'Standard workmanship warranty applies. Any changes to scope of work must be agreed upon in writing by both parties.',
    signatures:  null // handled in HTML
  };
}

// ─── HTML builder ──────────────────────────────────────────────────────────────
function buildHtmlContract({
  contractNumber, generatedAt,
  bizName, bizAddress, customerName, customerAddress,
  sections, totalPrice
}) {
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  const sectionBlock = (label, content) => content ? `
    <div style="margin-bottom:24px;">
      <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#1a1a2e;border-bottom:1px solid #eee;padding-bottom:6px;">${label}</h3>
      <p style="margin:0;font-size:14px;color:#444;line-height:1.7;">${content}</p>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Service Contract ${contractNumber}</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:30px;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="padding:32px 36px;background:#1a1a2e;color:#fff;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;align-items:flex-start;">
        <div>
          <h1 style="margin:0 0 4px;font-size:26px;">${sections.title || 'Service Contract'}</h1>
          <p style="margin:0;opacity:0.7;font-size:14px;">${bizName}</p>
        </div>
        <div style="text-align:right;">
          <p style="margin:0;font-size:13px;opacity:0.7;">Contract #</p>
          <p style="margin:2px 0;font-size:15px;font-weight:bold;">${contractNumber}</p>
          <p style="margin:4px 0 0;font-size:13px;opacity:0.7;">${dateStr}</p>
        </div>
      </div>
    </div>

    <!-- Parties -->
    <div style="padding:28px 36px;background:#fafafa;border-bottom:1px solid #eee;display:flex;gap:32px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;color:#999;font-weight:bold;letter-spacing:1px;">Contractor</p>
        <p style="margin:0;font-weight:bold;color:#1a1a2e;">${bizName}</p>
        ${bizAddress ? `<p style="margin:2px 0;font-size:13px;color:#666;">${bizAddress}</p>` : ''}
      </div>
      <div style="flex:1;min-width:200px;">
        <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;color:#999;font-weight:bold;letter-spacing:1px;">Client</p>
        <p style="margin:0;font-weight:bold;color:#1a1a2e;">${customerName}</p>
        ${customerAddress ? `<p style="margin:2px 0;font-size:13px;color:#666;">${customerAddress}</p>` : ''}
      </div>
    </div>

    <!-- Contract Body -->
    <div style="padding:28px 36px;">
      ${sectionBlock('Parties', sections.parties)}
      ${sectionBlock('Scope of Work', sections.scopeOfWork)}
      ${sectionBlock('Timeline', sections.timeline)}
      ${sectionBlock('Payment', sections.payment)}
      ${sectionBlock('Terms & Conditions', sections.terms)}

      ${totalPrice ? `
      <div style="text-align:right;padding:16px 0;border-top:2px solid #1a1a2e;border-bottom:2px solid #1a1a2e;margin-bottom:28px;">
        <span style="font-size:13px;color:#666;text-transform:uppercase;letter-spacing:1px;">Contract Total: </span>
        <span style="font-size:22px;font-weight:bold;color:#1a1a2e;">$${Number(totalPrice).toFixed(2)}</span>
      </div>` : ''}

      <!-- Signatures -->
      <div style="margin-top:36px;">
        <h3 style="margin:0 0 20px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#1a1a2e;">Signatures</h3>
        <div style="display:flex;gap:40px;flex-wrap:wrap;">
          <div style="flex:1;min-width:220px;">
            <div style="border-bottom:1px solid #333;height:48px;margin-bottom:8px;"></div>
            <p style="margin:0;font-size:13px;font-weight:bold;color:#333;">Contractor: ${bizName}</p>
            <p style="margin:2px 0;font-size:12px;color:#999;">Signature &amp; Date</p>
          </div>
          <div style="flex:1;min-width:220px;">
            <div style="border-bottom:1px solid #333;height:48px;margin-bottom:8px;"></div>
            <p style="margin:0;font-size:13px;font-weight:bold;color:#333;">Client: ${customerName}</p>
            <p style="margin:2px 0;font-size:12px;color:#999;">Signature &amp; Date</p>
          </div>
        </div>
      </div>
    </div>

    <div style="padding:16px 36px;background:#f8f8f8;border-top:1px solid #eee;text-align:center;font-size:12px;color:#aaa;">
      Generated by EP Local Pro AI &bull; eplocalproai.com
    </div>

  </div>
</body>
</html>`;
}

// ─── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err('Invalid JSON'); }

  const {
    bizName, bizAddress = '', customerName, customerAddress = '',
    jobDescription = '', startDate = '', endDate = '',
    totalPrice = 0, paymentTerms = '', contractTerms = ''
  } = body;

  if (!bizName)      return err('bizName is required');
  if (!customerName) return err('customerName is required');

  const contractNumber = `CON-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const generatedAt    = new Date().toISOString();

  const aiSections = await generateContractWithAI({
    bizName, bizAddress, customerName, customerAddress,
    jobDescription, startDate, endDate, totalPrice, paymentTerms, contractTerms
  });

  const sections = aiSections || buildTemplateSections({
    bizName, bizAddress, customerName, customerAddress,
    jobDescription, startDate, endDate, totalPrice, paymentTerms, contractTerms
  });

  const htmlContent = buildHtmlContract({
    contractNumber, generatedAt,
    bizName, bizAddress, customerName, customerAddress,
    sections, totalPrice
  });

  return ok({
    contractNumber,
    type: 'contract',
    bizName, customerName,
    jobDescription, startDate,
    endDate: endDate || 'Upon completion',
    totalPrice: Number(totalPrice),
    paymentTerms: paymentTerms || 'Due upon completion',
    ...sections,
    generatedAt,
    htmlContent
  });
};
