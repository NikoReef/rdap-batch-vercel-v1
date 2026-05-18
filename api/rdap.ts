export const config = { runtime: 'edge' };

const AUTH_KEY = 'rdap-batch-2026-secreto';
const MAX_DOMAINS = 45;
const CONSECUTIVE_ERRORS_LIMIT = 5;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const ACCEPT_LANGS = [
  'es-AR,es;q=0.9,en;q=0.8',
  'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
  'es,en;q=0.9',
  'es-419,es;q=0.9,en;q=0.8',
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (base: number) => base + Math.floor((Math.random() - 0.5) * base * 0.6);
const randomFrom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function parseRdap(json: any) {
  let fecha_registro = null, fecha_vencimiento = null, fecha_renovacion = null;
  let estado = 'unknown', registrant = null;
  if (Array.isArray(json.events)) {
    for (const evt of json.events) {
      const d = evt.eventDate ? evt.eventDate.substring(0, 10) : null;
      switch (evt.eventAction) {
        case 'registration': fecha_registro = d; break;
        case 'expiration': fecha_vencimiento = d; break;
        case 'last changed': fecha_renovacion = d; break;
      }
    }
  }
  if (Array.isArray(json.status)) estado = json.status.join(',');
  if (Array.isArray(json.entities)) {
    for (const ent of json.entities) {
      if (Array.isArray(ent.roles) && ent.roles.includes('registrant')) {
        registrant = ent.handle || null;
        break;
      }
    }
  }
  return { fecha_registro, fecha_vencimiento, fecha_renovacion, estado, registrant };
}

export default async function handler(req: Request) {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (url.searchParams.get('key') !== AUTH_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try { body = await req.json(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const domains: string[] = body.domains;
  const delayMs = Math.max(1000, Math.min(body.delay_ms || 2500, 10000));

  if (!Array.isArray(domains) || domains.length === 0) {
    return new Response(JSON.stringify({ error: 'domains array required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (domains.length > MAX_DOMAINS) {
    return new Response(JSON.stringify({ error: `Max ${MAX_DOMAINS} domains per request` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const results: any[] = [];
  let rateLimited = false;
  let consecutiveErrors = 0;

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    if (i > 0) await sleep(randomDelay(delayMs));

    try {
      const response = await fetch(`https://rdap.nic.ar/domain/${domain}`, {
        headers: {
          'Accept': 'application/rdap+json, application/json',
          'User-Agent': randomFrom(USER_AGENTS),
          'Accept-Language': randomFrom(ACCEPT_LANGS),
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
      const httpCode = response.status;
      const text = await response.text();
      if (httpCode === 429) { results.push({ domain, status: 'rate_limited', http_code: 429, data: null }); rateLimited = true; break; }
      const isHtml = text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().startsWith('<html');
      if (isHtml) { results.push({ domain, status: 'blocked', http_code: httpCode, data: null }); consecutiveErrors++; if (consecutiveErrors >= CONSECUTIVE_ERRORS_LIMIT) { rateLimited = true; break; } continue; }
      if (httpCode === 403) { results.push({ domain, status: 'forbidden', http_code: 403, data: null }); consecutiveErrors++; if (consecutiveErrors >= CONSECUTIVE_ERRORS_LIMIT) { rateLimited = true; break; } continue; }
      if (httpCode === 404) { results.push({ domain, status: 'not_found', http_code: 404, data: null }); consecutiveErrors = 0; continue; }
      if (httpCode !== 200) { results.push({ domain, status: 'error', http_code: httpCode, data: null }); consecutiveErrors++; if (consecutiveErrors >= CONSECUTIVE_ERRORS_LIMIT) { rateLimited = true; break; } continue; }
      let json;
      try { json = JSON.parse(text); }
      catch (e) { results.push({ domain, status: 'parse_error', http_code: 200, data: null }); consecutiveErrors = 0; continue; }
      if (!json.events) { results.push({ domain, status: 'no_data', http_code: 200, data: null }); consecutiveErrors = 0; continue; }
      results.push({ domain, status: 'ok', http_code: 200, data: parseRdap(json) });
      consecutiveErrors = 0;
    } catch (err: any) {
      results.push({ domain, status: 'error', http_code: 0, data: null, error: err.message });
      consecutiveErrors++;
      if (consecutiveErrors >= CONSECUTIVE_ERRORS_LIMIT) { rateLimited = true; break; }
    }
  }

  return new Response(JSON.stringify({
    success: true,
    processed: results.length,
    total_requested: domains.length,
    rate_limited: rateLimited,
    delay_ms: delayMs,
    results,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
