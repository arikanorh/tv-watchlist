// Cloudflare Worker: relays the TradingView quote websocket to origins TradingView itself refuses
// (TradingView only accepts the handshake from localhost / tradingview.com Origins).
// Browser <-> this worker <-> data.tradingview.com. Messages pass through untouched.

const UPSTREAM = 'https://data.tradingview.com/socket.io/websocket?from=chart%2F&type=chart';
// Only these page origins may use the relay.
const ALLOWED_ORIGINS = [
  'https://arikanorh.github.io',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

const SEARCH = 'https://symbol-search.tradingview.com/symbol_search/v3/';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // GET /search?text=…  → TradingView symbol search (origin-locked upstream, so proxied here).
    if (url.pathname === '/search') {
      if (!ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const text = (url.searchParams.get('text') || '').slice(0, 40);
      if (!text) return new Response('[]', { headers: { ...cors, 'Content-Type': 'application/json' } });
      const q = new URLSearchParams({ text, hl: '0', exchange: '', lang: 'en', search_type: 'undefined', domain: 'production', sort_by_country: 'US' });
      const up = await fetch(SEARCH + '?' + q, { headers: { Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0' } });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('tv-watchlist relay: websocket endpoint, GET /search?text=', { status: 200 });
    }
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });

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
