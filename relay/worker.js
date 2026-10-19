// Cloudflare Worker: relays the TradingView quote websocket to origins TradingView itself refuses
// (TradingView only accepts the handshake from localhost / tradingview.com Origins).
// Browser <-> this worker <-> data.tradingview.com. Messages pass through untouched.
// Also: GET /search (symbol search proxy), GET/PUT /state/<code> and the /sync/<code> websocket (watchlists synced across
// devices, one SyncRoom Durable Object per code).
import { DurableObject } from 'cloudflare:workers';

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

// `wrangler dev` with DEV=1 (scratch config only) also accepts any localhost port, for multi-origin sync tests.
const allowed = (o, env) => ALLOWED_ORIGINS.includes(o) || LAN_ORIGIN.test(o) || (env?.DEV === '1' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o));
// Sync code: 4–12 uppercase letters and digits (generated ones are 4 characters without I, O, 0, 1; users may pick their own).
const SYNC_CODE = /^[A-Z0-9]{4,12}$/;
const MAX_STATE = 100 * 1024;
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// One Durable Object per sync code (`SyncRoom`): it stores that code's lists and holds the websockets of the devices
// using the code, so a save on one device reaches the others at once.
//   GET  /state/<code>                → { updatedAt, lists } or 404
//   PUT  /state/<code> { updatedAt, lists } → stored when not older than what is there (last edit wins), then pushed to
//        the other connected devices; 409 + the stored copy when older (an old offline edit can't overwrite a newer one).
//   GET  /sync/<code>?client=<id> (websocket) → { type: 'state', doc } now and after every save from another device.
// Codes saved before the rooms existed live in KV (`SYNC`); a room copies its code's state from there the first time.
export class SyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // keep-alives don't wake the room
  }
  async doc(code) {
    let d = await this.ctx.storage.get('doc');
    if (!d && this.env.SYNC) {
      d = await this.env.SYNC.get('state:' + code, 'json');
      if (d) await this.ctx.storage.put('doc', d);
    }
    return d || null;
  }
  async fetch(request) {
    const url = new URL(request.url), code = url.pathname.split('/')[2], cors = JSON.parse(request.headers.get('X-Cors') || '{}');
    // Client logs for this code: POST appends a batch, GET returns the last LOG_MAX entries (oldest first). Kept 7 days.
    if (url.pathname.startsWith('/log/')) {
      const LOG_MAX = 1500, now = Date.now();
      let log = ((await this.ctx.storage.get('log')) || []).filter(e => now - (e.t || 0) < 7 * 864e5);
      if (request.method === 'POST') {
        const text = await request.text(); if (text.length > 64000) return json({ error: 'too large' }, 413, cors);
        let batch; try { batch = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400, cors); }
        if (!Array.isArray(batch)) return json({ error: 'bad log' }, 400, cors);
        log = [...log, ...batch.slice(0, 300).map(e => ({ ...e, at: now }))].slice(-LOG_MAX);
        await this.ctx.storage.put('log', log);
        return json({ ok: true, n: log.length }, 200, cors);
      }
      if (request.method === 'DELETE') { await this.ctx.storage.delete('log'); return json({ ok: true }, 200, cors); }
      const since = +url.searchParams.get('since') || 0;
      return json(log.filter(e => (e.t || 0) >= since), 200, cors);
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      const id = (url.searchParams.get('client') || '').slice(0, 40);
      this.ctx.acceptWebSocket(server, [id]);
      const d = await this.doc(code);
      if (d) server.send(JSON.stringify({ type: 'state', doc: d }));
      await this.touch(id, url.searchParams.get('name'));
      await this.peers();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === 'GET') {
      const d = await this.doc(code);
      return d ? json(d, 200, cors) : json({ error: 'not found' }, 404, cors);
    }
    if (request.method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_STATE) return json({ error: 'too large' }, 413, cors);
      let body; try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400, cors); }
      if (!body || !Array.isArray(body.lists) || !body.lists.length || typeof body.updatedAt !== 'number') return json({ error: 'bad state' }, 400, cors);
      const cur = await this.doc(code);
      if (cur && cur.updatedAt > body.updatedAt) return json(cur, 409, cors);
      // Extra fields (flags, and whatever later versions add) ride along; a client that doesn't know a field keeps what's stored.
      const extra = {};
      for (const src of [cur || {}, body]) for (const [k, v] of Object.entries(src)) if (!['updatedAt', 'lists'].includes(k) && v !== undefined) extra[k] = v;
      const d = { ...extra, updatedAt: body.updatedAt, lists: body.lists };
      await this.ctx.storage.put('doc', d);
      const from = request.headers.get('X-Client-Id') || '', msg = JSON.stringify({ type: 'state', doc: d });
      for (const ws of this.ctx.getWebSockets()) if (this.ctx.getTags(ws)[0] !== from) { try { ws.send(msg); } catch (_) {} }
      await this.touch(from, url.searchParams.get('name') || request.headers.get('X-Client-Name'));
      return json({ updatedAt: d.updatedAt }, 200, cors);
    }
    return json({ error: 'method' }, 405, cors);
  }
  async webSocketMessage(ws, msg) { if (msg === 'peers') await this.peers(); }   // a client asking who is here (ping/pong is automatic)
  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code); } catch (_) {}
    await this.touch(this.ctx.getTags(ws)[0], null, false);
    await this.peers(ws);
  }
  // Devices seen on this code: client id → { name, seen }, kept 90 days. Every client learns who is live and who was here.
  async touch(id, name, create = true) {
    if (!id) return;
    const devices = (await this.ctx.storage.get('devices')) || {}, now = Date.now();
    if (!create && !devices[id]) return;   // a socket from an older client (random id) just closing: don't record it
    for (const k of Object.keys(devices)) if (now - devices[k].seen > 90 * 864e5) delete devices[k];
    devices[id] = { name: (name || devices[id]?.name || '').slice(0, 40), seen: now };
    await this.ctx.storage.put('devices', devices);
  }
  async peers(closing) {
    const devices = (await this.ctx.storage.get('devices')) || {};
    const live = [...new Set(this.ctx.getWebSockets().filter(ws => ws !== closing).map(ws => this.ctx.getTags(ws)[0]))];
    const msg = JSON.stringify({ type: 'peers', live, devices });
    for (const ws of this.ctx.getWebSockets()) if (ws !== closing) { try { ws.send(msg); } catch (_) {} }
  }
}
function toRoom(request, env, code, cors) {
  if (!env.ROOMS) return json({ error: 'sync storage not configured' }, 503, cors);
  if (!SYNC_CODE.test(code)) return json({ error: 'bad code' }, 400, cors);
  const headers = new Headers(request.headers); headers.set('X-Cors', JSON.stringify(cors));
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request, { headers }));
}
const SEARCH = 'https://symbol-search.tradingview.com/symbol_search/v3/';
const NEWS = 'https://news-headlines.tradingview.com/v2/';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (url.pathname.startsWith('/state/')) {
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Client-Id, X-Client-Name' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      return toRoom(request, env, url.pathname.split('/')[2] || '', cors);
    }

    if (url.pathname.startsWith('/log/')) {
      if (request.method !== 'GET' && !allowed(origin, env)) return new Response('forbidden', { status: 403 });   // anyone with the code may read
      const cors = { 'Access-Control-Allow-Origin': origin || '*', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      return toRoom(request, env, url.pathname.split('/')[2] || '', cors);
    }

    if (url.pathname.startsWith('/sync/')) {
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      return toRoom(request, env, url.pathname.split('/')[2] || '', {});
    }

    // GET /search?text=…  → TradingView symbol search (origin-locked upstream, so proxied here).
    if (url.pathname === '/search') {
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const text = (url.searchParams.get('text') || '').slice(0, 40);
      if (!text) return new Response('[]', { headers: { ...cors, 'Content-Type': 'application/json' } });
      const q = new URLSearchParams({ text, hl: '0', exchange: '', lang: 'en', search_type: 'undefined', domain: 'production', sort_by_country: 'US' });
      const up = await fetch(SEARCH + '?' + q, { headers: { Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0' } });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
    }

    // GET /news?symbol=EX:SYM&lang=en → TradingView headlines; GET /news/story?id=…&lang=en → one story (summary, text).
    if (url.pathname === '/news' || url.pathname === '/news/story') {
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const lang = (url.searchParams.get('lang') || 'en').slice(0, 5);
      const target = url.pathname === '/news'
        ? NEWS + 'headlines?' + new URLSearchParams({ client: 'web', lang, symbol: (url.searchParams.get('symbol') || '').slice(0, 60) })
        : NEWS + 'story?' + new URLSearchParams({ id: (url.searchParams.get('id') || '').slice(0, 200), lang });
      const up = await fetch(target, { headers: { Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0' } });
      return new Response(await up.text(), { status: up.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' } });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('tv-watchlist relay: websocket endpoint, GET /search?text=, GET/PUT /state/<code>, websocket /sync/<code>, GET/POST /log/<code>, GET /news?symbol=, GET /news/story?id=', { status: 200 });
    }
    if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });

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
