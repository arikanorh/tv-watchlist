// Cloudflare Worker: relays the TradingView quote websocket to origins TradingView itself refuses
// (TradingView only accepts the handshake from localhost / tradingview.com Origins).
// Browser <-> this worker <-> data.tradingview.com. Messages pass through untouched.
// Also: GET /search (symbol search proxy) and GET/PUT /state/<code> (watchlists synced across devices, in KV `SYNC`).

const UPSTREAM = 'https://data.tradingview.com/socket.io/websocket?from=chart%2F&type=chart';
// Only these page origins may use the relay (plus private-LAN dev servers, e.g. a phone on the same Wi-Fi).
const LAN_ORIGIN = /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+(:\d+)?$/;
const ALLOWED_ORIGINS = [
  'https://arikanorh.github.io',
  'https://tv-watchlist.pages.dev',
  'https://dev.tv-watchlist.pages.dev',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

const allowed = o => ALLOWED_ORIGINS.includes(o) || LAN_ORIGIN.test(o);
// Sync code: 12 characters from an unambiguous alphabet (the app shows it as XXXX-XXXX-XXXX).
const SYNC_CODE = /^[A-HJ-NP-Z2-9]{12}$/;
const MAX_STATE = 100 * 1024;
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// GET  /state/<code> → { updatedAt, lists } or 404
// PUT  /state/<code> { updatedAt, lists } → stored when newer than what is there; 409 + the stored copy when not
// (last edit wins; an older offline edit can't overwrite a newer one).
async function handleState(request, env, code, cors) {
  if (!env.SYNC) return json({ error: 'sync storage not configured' }, 503, cors);
  if (!SYNC_CODE.test(code)) return json({ error: 'bad code' }, 400, cors);
  const key = 'state:' + code;
  if (request.method === 'GET') {
    const v = await env.SYNC.get(key);
    return v ? new Response(v, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'not found' }, 404, cors);
  }
  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_STATE) return json({ error: 'too large' }, 413, cors);
    let body; try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400, cors); }
    if (!body || !Array.isArray(body.lists) || !body.lists.length || typeof body.updatedAt !== 'number') return json({ error: 'bad state' }, 400, cors);
    const cur = await env.SYNC.get(key, 'json');
    if (cur && cur.updatedAt > body.updatedAt) return json(cur, 409, cors);
    const doc = { updatedAt: body.updatedAt, lists: body.lists };
    await env.SYNC.put(key, JSON.stringify(doc));
    return json({ updatedAt: doc.updatedAt }, 200, cors);
  }
  return json({ error: 'method' }, 405, cors);
}
const SEARCH = 'https://symbol-search.tradingview.com/symbol_search/v3/';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (url.pathname.startsWith('/state/')) {
      if (!allowed(origin)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      return handleState(request, env, url.pathname.slice(7), cors);
    }

    // GET /search?text=…  → TradingView symbol search (origin-locked upstream, so proxied here).
    if (url.pathname === '/search') {
      if (!allowed(origin)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const text = (url.searchParams.get('text') || '').slice(0, 40);
      if (!text) return new Response('[]', { headers: { ...cors, 'Content-Type': 'application/json' } });
      const q = new URLSearchParams({ text, hl: '0', exchange: '', lang: 'en', search_type: 'undefined', domain: 'production', sort_by_country: 'US' });
      const up = await fetch(SEARCH + '?' + q, { headers: { Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0' } });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('tv-watchlist relay: websocket endpoint, GET /search?text=, GET/PUT /state/<code>', { status: 200 });
    }
    if (!allowed(origin)) return new Response('forbidden', { status: 403 });

    const up = await fetch(UPSTREAM, { headers: { Upgrade: 'websocket', Origin: 'https://www.tradingview.com' } });
    const upstream = up.webSocket;
    if (!upstream) return new Response('upstream refused: ' + up.status, { status: 502 });
    upstream.accept();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const closeBoth = () => { try { upstream.close(); } catch (_) {} try { server.close(); } catch (_) {} };
    server.addEventListener('message', e => { try { upstream.send(e.data); } catch (_) { closeBoth(); } });
    upstream.addEventListener('message', e => { try { server.send(e.data); } catch (_) { closeBoth(); } });
    for (const ws of [server, upstream]) { ws.addEventListener('close', closeBoth); ws.addEventListener('error', closeBoth); }

    return new Response(null, { status: 101, webSocket: client });
  },
};
