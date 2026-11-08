// EP HUB — Business Website Scanner
// POST { url } → fetches the page, strips HTML, uses Claude Haiku to extract
// structured business info → returns { extracted: { bizName, category, phone,
// services, location, bio, aiPrompt } }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { url } = JSON.parse(event.body || '{}');
    if (!url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing url' }) };

    // Normalise and validate
    let href;
    try {
      href = new URL(url.startsWith('http') ? url : 'https://' + url).href;
    } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid URL — include the full address, e.g. https://theirbusiness.com' }) };
    }

    // Fetch the page (8 s hard timeout)
    let html;
    try {
      const pageResp = await Promise.race([
        fetch(href, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; EPHubBot/1.0; +https://ephub.ai)',
            'Accept': 'text/html,application/xhtml+xml,*/*'
          },
          redirect: 'follow'
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
      ]);
      if (!pageResp.ok) {
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Could not load that website (HTTP ${pageResp.status}). Try a different URL.` }) };
      }
      html = await pageResp.text();
    } catch (e) {
      const msg = e.message === 'timeout'
        ? 'Website took too long to respond. Try again.'
        : 'Could not reach that website. Check the URL and try again.';
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: msg }) };
    }

    // ── Extract contact info before stripping tags ──────────────────────────
    // 1) JSON-LD structured data (SEO schema — present even on JS-rendered sites)
    const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    let jsonLdText = '';
    for (const block of jsonLdBlocks) {
      try { jsonLdText += JSON.stringify(JSON.parse(block)) + ' '; } catch {}
    }

    // 2) Relevant meta tags (og:phone_number, description, etc.)
    const metaTags = [...html.matchAll(/<meta[^>]+>/gi)].map(m => m[0]);
    const metaText = metaTags
      .filter(t => /name=["'](description|keywords|og:phone|og:email)/i.test(t) || /property=["']og:(description|phone_number|email)/i.test(t))
      .map(t => { const c = t.match(/content=["']([^"']+)/i); return c ? c[1] : ''; })
      .join(' ');

    // 3) tel:/mailto: hrefs
    const telRaw  = [...html.matchAll(/href=["']tel:([^"'?\s]+)/gi)].map(m => m[1].trim());
    const mailRaw = [...html.matchAll(/href=["']mailto:([^"'?\s]+)/gi)].map(m => m[1].trim());

    // 4) Phone/email patterns anywhere in the full HTML (catches inline text, data-attrs, JSON props)
    const combinedSrc = jsonLdText + ' ' + html;
    const phonePat = combinedSrc.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g) || [];
    const emailPat = combinedSrc.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) || [];

    let allPhones = [...new Set([...telRaw, ...phonePat.map(p => p.replace(/\s+/g, ' ').trim())])].slice(0, 3).join(', ');
    let allEmails = [...new Set([...mailRaw, ...emailPat])]
      .filter(e => !/(example|sentry|w3\.org|schema\.org|domain|pixel|facebook|google|wix\.com)/i.test(e))
      .slice(0, 3).join(', ');

    // ── /contact fallback if main page had no contact info ─────────────────
    // Many sites are JS-rendered; their /contact page often has plain-HTML contact details
    if (!allPhones && !allEmails) {
      const origin = new URL(href).origin;
      const contactUrls = [origin + '/contact', origin + '/contacto', origin + '/contact-us'];
      for (const cUrl of contactUrls) {
        try {
          const cResp = await Promise.race([
            fetch(cUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; EPHubBot/1.0; +https://ephub.ai)',
                'Accept': 'text/html,application/xhtml+xml,*/*'
              },
              redirect: 'follow'
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
          ]);
          if (!cResp.ok) continue;
          const cHtml = await cResp.text();

          const cJsonLdBlocks = [...cHtml.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
          let cJsonLdText = '';
          for (const block of cJsonLdBlocks) {
            try { cJsonLdText += JSON.stringify(JSON.parse(block)) + ' '; } catch {}
          }
          const cTelRaw  = [...cHtml.matchAll(/href=["']tel:([^"'?\s]+)/gi)].map(m => m[1].trim());
          const cMailRaw = [...cHtml.matchAll(/href=["']mailto:([^"'?\s]+)/gi)].map(m => m[1].trim());
          const cCombined = cJsonLdText + ' ' + cHtml;
          const cPhonePat = cCombined.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g) || [];
          const cEmailPat = cCombined.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) || [];

          const cPhones = [...new Set([...cTelRaw, ...cPhonePat.map(p => p.replace(/\s+/g, ' ').trim())])].slice(0, 3).join(', ');
          const cEmails = [...new Set([...cMailRaw, ...cEmailPat])]
            .filter(e => !/(example|sentry|w3\.org|schema\.org|domain|pixel|facebook|google|wix\.com)/i.test(e))
            .slice(0, 3).join(', ');

          if (cPhones || cEmails) {
            if (cPhones) allPhones = cPhones;
            if (cEmails) allEmails = cEmails;
            break;
          }
        } catch {}
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    const contactHint = (allPhones || allEmails)
      ? `[Contact info extracted]${allPhones ? ' Phone: ' + allPhones : ''}${allEmails ? ' Email: ' + allEmails : ''}\n`
      : '';

    // ── Strip HTML → plain text, keep first 5 000 chars for Claude ──────────
    const strippedBody = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const text = (contactHint + (metaText ? metaText + ' ' : '') + (jsonLdText ? jsonLdText.slice(0, 1000) + ' ' : '') + strippedBody)
      .slice(0, 5000);

    if (text.length < 30) {
      return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: 'Could not read enough text from that page. Try the business\'s About or Contact page.' }) };
    }

    // Claude Haiku — extract structured info
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 450,
        system: `You extract business details from website text and return ONLY a JSON object — no markdown, no explanation.
Return exactly these keys:
{
  "bizName": "official business name",
  "category": "pick one: Financial Services | Local Business | Health & Wellness | Real Estate | Restaurant / Food | Retail | Network Marketing | Other",
  "phone": "phone number as shown, or empty string",
  "services": "comma-separated main services or products, max 120 chars total",
  "location": "city and state/country, or empty string",
  "bio": "1–2 sentences describing what the business does and who it serves, max 160 chars",
  "aiPrompt": "2–3 sentence instruction for an AI receptionist: state who the AI is, what the business does, and what info to collect from callers (name + phone at minimum)"
}`,
        messages: [{ role: 'user', content: `Website text:\n${text}` }]
      })
    });

    if (!aiResp.ok) {
      const err = await aiResp.text();
      console.error('[ls-scan-biz] AI error:', aiResp.status, err.slice(0, 200));
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'AI extraction failed. Try again.' }) };
    }

    const aiData = await aiResp.json();
    const raw = (aiData.content && aiData.content[0] && aiData.content[0].text) || '{}';

    let extracted;
    try {
      extracted = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      try { extracted = m ? JSON.parse(m[0]) : {}; } catch { extracted = {}; }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ extracted }) };

  } catch (err) {
    console.error('[ls-scan-biz] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Scan failed. Try again.' }) };
  }
};
