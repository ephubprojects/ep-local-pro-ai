const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function ok(data)      { return { statusCode: 200, headers, body: JSON.stringify(data) }; }
function err(msg, code = 400) { return { statusCode: code, headers, body: JSON.stringify({ error: msg }) }; }

function normalizeSlug(input) {
  return input.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

function isValidSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  if (slug.length < 3 || slug.length > 50) return false;
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z0-9]{3,50}$/.test(slug);
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

  switch (action) {
    case 'check-slug': {
      const { slug } = body;
      if (!slug) return err('slug is required');
      const normalized = normalizeSlug(slug);
      const valid = isValidSlug(normalized);
      return ok({ valid, slug: normalized });
    }

    case 'generate-slug': {
      const { name } = body;
      if (!name || typeof name !== 'string') return err('name is required');
      const slug = normalizeSlug(name);
      if (!isValidSlug(slug)) {
        return err('Could not generate a valid slug from the provided name. Use at least 3 alphanumeric characters.');
      }
      return ok({ slug });
    }

    default:
      return err(`Unknown action: ${action}`);
  }
};
