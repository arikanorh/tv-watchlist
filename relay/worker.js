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

// ---- Web Push (RFC 8030 / 8291 aes128gcm / 8292 VAPID), WebCrypto only ----
const enc = s => new TextEncoder().encode(s);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const VAPID_SUB = 'https://arikanorh.github.io/tv-watchlist/';
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function pushEncrypt(sub, text) {   // one aes128gcm record
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc(text), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function webPush(sub, text, vapid) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(enc(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: now + 12 * 3600, sub: VAPID_SUB })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(jwt)));
  return fetch(sub.endpoint, { method: 'POST', body: await pushEncrypt(sub, text),
    headers: { Authorization: `vapid t=${jwt}.${sig}, k=${vapid.pub}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' } });
}

// ---- Server-side alert check (the client's checkAlerts / followFire, for when no device is connected) ----
const CHECK_MS = 20000, LIVE_MS = 100000;
const US_EX = new Set(['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'ARCA', 'BATS']);
const NF2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPrice = p => { const a = Math.abs(p); return a >= 1e12 ? (p / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (p / 1e9).toFixed(2) + 'B' : a >= 1 || a === 0 ? NF2.format(p) : p.toFixed(Math.min(10, 3 - Math.floor(Math.log10(a)))); };
const fmtStep = v => String(+(+v).toPrecision(6));
const short = sym => sym.includes(':') ? sym.split(':')[1] : sym;
const etMin = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); return +p.hour * 60 + +p.minute; };
// Alerts are checked once per wall-clock minute (like the client).
const alertBucket = () => Math.floor(Date.now() / 60000);
function usPhase() {   // like the client's sessionPhase: closed / night / pre / open / post (New York time)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const m = +p.hour * 60 + +p.minute, wd = p.weekday;
  if (wd === 'Sat' || (wd === 'Sun' && m < 1200) || (wd === 'Fri' && m >= 1200)) return 'closed';
  return m < 240 || m >= 1200 ? 'night' : m < 570 ? 'pre' : m < 960 ? 'open' : 'post';
}
// Live prices from one short TradingView quote session (the same unauthorized feed the app uses: US stocks real-time
// via Cboe One, overnight via the BOATS twin), picked like the client's livePrice: regular session → last; pre / post →
// the extended price (rtc); overnight → BOATS last, else rtc; weekend → US stocks skipped. A price older than the start
// of the current session is skipped (at 04:00 / 09:30 the feed can still carry the previous session's value).
const NON_EQUITY = new Set(['index', 'cfd', 'futures', 'economic']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function livePrices(syms) {
  const ph = usPhase(), night = ph === 'night', boats = s => { const [ex, t] = s.split(':'); return t && US_EX.has(ex) ? 'BOATS:' + t : null; };
  const want = [...new Set([...syms, ...(night ? syms.map(boats).filter(Boolean) : [])])];
  const up = await fetch(UPSTREAM, { headers: { Upgrade: 'websocket', Origin: 'https://www.tradingview.com' } });
  const ws = up.webSocket; if (!ws) return null;
  ws.accept();
  const raw = {}, seen = new Set(), frame = o => { const j = JSON.stringify(o); return '~m~' + j.length + '~m~' + j; };
  await new Promise(res => {
    let grace = null; const end = setTimeout(res, 8000);
    const fin = () => { clearTimeout(end); clearTimeout(grace); res(); };
    ws.addEventListener('message', e => {
      for (const part of String(e.data).split(/~m~\d+~m~/).filter(Boolean)) {
        if (part.startsWith('~h~')) { try { ws.send('~m~' + part.length + '~m~' + part); } catch (_) {} continue; }
        let m; try { m = JSON.parse(part); } catch (_) { continue; }
        if (m.m !== 'qsd' || !m.p?.[1]?.n) continue;
        const q = m.p[1]; seen.add(q.n); if (q.s === 'ok') raw[q.n] = Object.assign(raw[q.n] || {}, q.v);
      }
      if (!grace && want.every(s => seen.has(s))) grace = setTimeout(fin, 600);   // the rest of the first snapshot
    });
    ws.addEventListener('close', fin); ws.addEventListener('error', fin);
    for (const o of [{ m: 'set_auth_token', p: ['unauthorized_user_token'] }, { m: 'quote_create_session', p: ['qs'] },
      { m: 'quote_set_fields', p: ['qs', 'lp', 'lp_time', 'rtc', 'rtc_time', 'current_session', 'type'] }, { m: 'quote_add_symbols', p: ['qs', ...want] }]) ws.send(frame(o));
  });
  try { ws.close(1000, 'done'); } catch (_) {}
  const out = {}, nowS = Date.now() / 1000, m = etMin(), since = start => nowS - (((m - start) % 1440 + 1440) % 1440) * 60 - 90;
  for (const s of syms) {
    const r = raw[s]; if (!r || r.lp == null) continue;
    if (!US_EX.has(s.split(':')[0])) { out[s] = r.lp; continue; }
    if (ph === 'closed') continue;
    const fresh = (t, start) => !t || t >= since(start);
    if (ph === 'open') { if (fresh(r.lp_time, 570)) out[s] = r.lp; continue; }
    if (night) { const b = raw[boats(s)]; if (b?.lp != null && !NON_EQUITY.has(r.type)) out[s] = b.lp; else if (r.rtc != null && fresh(r.rtc_time, 960)) out[s] = r.rtc; continue; }
    if (r.rtc != null && fresh(r.rtc_time, ph === 'pre' ? 240 : 960)) out[s] = r.rtc;
  }
  return out;
}
// Prices from TradingView's scanner (US stocks there are 15 min delayed; VIX, crypto, FX, yields are live) — fallback when
// the quote socket gives nothing. US stocks use
// the pre / post-market price outside regular hours and are skipped overnight / at the weekend (the client uses BOATS then).
async function scanPrices(syms) {
  const cols = ['close', 'premarket_close', 'postmarket_close', 'premarket_time', 'postmarket_time'];
  const r = await fetch('https://scanner.tradingview.com/global/scan', { method: 'POST', body: JSON.stringify({ symbols: { tickers: syms }, columns: cols }) });
  if (!r.ok) return null;
  const ph = usPhase(), out = {}, early = ph === 'open' && etMin() < 570 + 20, nowS = Date.now() / 1000;
  // premarket_time / postmarket_time are the start of that extended session (04:00 / 16:00 ET); a price counts only when
  // that start is today's (< 6 h ago): at 04:00 ET the delayed scanner still serves the previous day's pre-market close
  // (13 Nov 2026 04:00 ET: NVDA "crossed below 161.38 at 151.00" while it was ~166).
  const fresh = t => typeof t === 'number' && nowS - t < 6 * 3600;
  for (const row of (await r.json()).data || []) {
    const [close, pre, post, preT, postT] = row.d, us = US_EX.has(row.s.split(':')[0]);
    const preOk = fresh(preT) ? pre : null, postOk = fresh(postT) ? post : null;
    // 15 min delayed: in the first 20 min of the session `close` is still yesterday's close (12 Nov 2026: NVDA "crossed above"
    // at 173.73 while it traded at 158) — use a fresh pre-market price there, else skip.
    const p = !us ? close : ph === 'open' ? (early ? preOk : close) : ph === 'pre' ? preOk : ph === 'post' ? postOk ?? close : null;
    if (typeof p === 'number') out[row.s] = p;
  }
  return out;
}
// Notification text: the client's noteText (index.html), kept in step — iOS cuts titles short, numbers go in the body.
function pushText(e) {
  const s = short(e.sym), f = fmtPrice, cross = (dir, lvl) => `${s} ${dir > 0 ? '▲ above' : '▼ below'} ${lvl}`;
  if ((e.kind === 'follow' || e.kind === 'alert') && e.lvl != null)
    return { title: cross(e.dir, f(e.lvl)), body: [e.px != null ? `Now ${f(e.px)}` : '', e.kind === 'follow' ? (e.lo != null ? `next ${f(e.lo)} / ${f(e.hi)}` : '') : 'alert done'].filter(Boolean).join(' · ') };
  if ((e.kind === 'buy' || e.kind === 'sell') && e.lvl != null) {
    const d = e.px != null ? Math.abs(e.px - e.lvl) / e.lvl * 100 : null;
    return { title: `${s} hit ${e.kind} point ${f(e.lvl)}`, body: e.px == null ? '' : `Now ${f(e.px)}${d >= 0.05 ? ` · ${d.toFixed(1)}% ${e.px < e.lvl ? 'below' : 'above'}` : ''}` };
  }
  const m = /^(?:Follow ±[\d.]+|Alert): crossed (above|below) (\S+)$/.exec(e.msg || '');   // older entries
  if (m) { const n = /^at (\S+)(?: · now (.+))?/.exec(e.sub || ''); return { title: cross(m[1] === 'above' ? 1 : -1, m[2]), body: n ? [`Now ${n[1]}`, n[2] ? `next ${n[2]}` : 'alert done'].join(' · ') : e.sub || '' }; }
  const pt = /^(Buy|Sell) point reached (\S+)$/.exec(e.msg || '');
  if (pt) return { title: `${s} hit ${pt[1].toLowerCase()} point ${pt[2]}`, body: (e.sub || '').replace(/^at /, 'Now ').replace(/ · \d\d:\d\d$/, '') };
  if (/^Earnings /.test(e.msg || '')) return { title: `${s} earnings ${e.msg.slice(9)}`, body: e.sub || '' };
  return { title: `${s} · ${e.msg}`, body: e.sub || '' };
}
// mutates doc: hits, follow moves, notifLog entries (same keys as the client's). only: 'follow' (pairs + their quiet-period
// notes) or 'other' (alerts, buy / sell points). force: follow line ids crossed 5 s ago (debounce) that fire on this price
// even when it is back inside (re-centred on that level), unless their pair already fired here.
function checkLines(doc, prices, { only, force } = {}) {
  const now = Date.now(), log = doc.notifLog = Array.isArray(doc.notifLog) ? doc.notifLog : [];
  const note = e => { if (!log.some(x => x.key === e.key)) log.unshift(e); };
  let fired = 0;
  // A follow pair's own notify period (`n` minutes; the client's followFire / followNote): moves inside it stay quiet and
  // keep the latest trigger (`nt`), which is sent once the period is over.
  const fnote = (sym, pair, s, { lvl, dir, px, c }) => {
    const a = pair[0]; for (const x of pair) { x.na = now; delete x.nt; }
    note({ key: `f:${sym}:${a.g}:${Math.round(c / s)}:${Math.floor(now / 60000)}`, t: now, sym, kind: 'follow', note: true, dir, lvl, px, lo: +(c - s).toPrecision(10), hi: +(c + s).toPrecision(10), ...(a.snd ? { snd: a.snd } : {}),
      msg: `Follow ±${fmtStep(s)}: crossed ${dir > 0 ? 'above' : 'below'} ${fmtPrice(lvl)}`, sub: `at ${fmtPrice(px)} · now ${fmtPrice(c - s)} / ${fmtPrice(c + s)}` });
  };
  for (const [sym, lines] of Object.entries(only === 'other' ? {} : doc.lines || {})) {
    if (!Array.isArray(lines)) continue;
    for (const g of new Set(lines.filter(x => x.k === 'follow' && x.nt).map(x => x.g))) {
      const pair = lines.filter(x => x.k === 'follow' && x.g === g), a = pair.find(x => x.nt);
      if (now - (a.na || 0) >= (+a.n || 0) * 60000) { fnote(sym, pair, a.s, a.nt); fired++; }
    }
  }
  const movedG = new Set();
  for (const [sym, lines] of Object.entries(doc.lines || {})) {
    const p = prices[sym]; if (p == null || !Array.isArray(lines)) continue;
    const cand = [...lines.filter(ln => ln.k && !ln.hit && ln.d && (ln.d > 0 ? p >= ln.p : p <= ln.p))];
    for (const ln of lines) if (force?.has(ln.id) && ln.k === 'follow' && !cand.some(x => x.g === ln.g)) cand.push(ln);   // back inside: still the crossed line
    for (const ln of cand) {
      if (only && (only === 'follow') !== (ln.k === 'follow')) continue;
      if (ln.k === 'follow') { if (movedG.has(ln.g)) continue; movedG.add(ln.g); }
      fired++;
      if (ln.k === 'follow') {
        const s = ln.s, lvl = ln.p, up0 = ln.d > 0; let c = lvl;
        if (up0) while (p >= c + s) c += s; else while (p <= c - s) c -= s;
        const pair = lines.filter(x => x.k === 'follow' && x.g === ln.g);
        for (const x of pair) { const up = x === ln ? up0 : x.p > lvl; x.p = +(up ? c + s : c - s).toPrecision(10); x.d = up ? 1 : -1; }
        const trig = { lvl, dir: up0 ? 1 : -1, px: p, c };
        if (+ln.n && now - (ln.na || 0) < ln.n * 60000) { for (const x of pair) x.nt = trig; } else fnote(sym, pair, s, trig);
      } else {
        ln.hit = now; ln.at = p;
        const what = ln.k === 'buy' ? 'Buy point reached' : ln.k === 'sell' ? 'Sell point reached' : `Alert: crossed ${ln.d > 0 ? 'above' : 'below'}`;
        note({ key: 'l:' + sym + ':' + ln.id, t: now, sym, kind: ln.k, dir: ln.d, lvl: ln.p, px: p, msg: `${what} ${fmtPrice(ln.p)}`, sub: `at ${fmtPrice(p)}` });
      }
    }
  }
  if (log.length > 100) log.length = 100;
  return fired;
}

// One Durable Object per sync code (`SyncRoom`): it stores that code's lists and holds the websockets of the devices
// using the code, so a save on one device reaches the others at once.
//   GET  /state/<code>                → { updatedAt, lists } or 404
//   PUT  /state/<code> { updatedAt, base, lists, … } → stored when `base` is the stored version (else 409 + the stored copy:
//        the client merges and retries; without `base`, when not older — last edit wins), then pushed to the other
//        connected devices; answers the stored `updatedAt` (never lower than before).
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
    // Daily per-symbol analysis for this code (written by the cloud routine, read by the details panel):
    // GET → { [sym]: { t, tone: 'pos' | 'neg' | 'neu', text, earn? } }; PUT { items: { [sym]: { tone, text, earn? } }, drop?: [sym] } merges.
    // earn = the analysis of the latest earnings report { t, rt: report time (unix s), tone, text }: kept when an item comes
    // without it, replaced when given, removed with earn: null.
    if (url.pathname.startsWith('/analysis/')) {
      let a = (await this.ctx.storage.get('analysis')) || {};
      if (request.method === 'PUT') {
        const text = await request.text(); if (text.length > 256000) return json({ error: 'too large' }, 413, cors);
        let body; try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400, cors); }
        const now = Date.now();
        for (const [sym, v] of Object.entries(body.items || {})) {
          if (!/^[A-Z0-9_.!]+:[A-Z0-9_.!\-]+$/i.test(sym) || !v || typeof v.text !== 'string') continue;
          const tone = x => ['pos', 'neg', 'neu'].includes(x) ? x : 'neu', e = v.earn;
          const earn = e === null ? undefined : e && typeof e.text === 'string' ? { t: now, rt: +e.rt || 0, tone: tone(e.tone), text: e.text.slice(0, 800) } : a[sym]?.earn;
          a[sym] = { t: now, tone: tone(v.tone), text: v.text.slice(0, 600), ...(earn ? { earn } : {}) };
        }
        for (const sym of Array.isArray(body.drop) ? body.drop : []) delete a[sym];
        await this.ctx.storage.put('analysis', a);
        return json({ ok: true, n: Object.keys(a).length }, 200, cors);
      }
      return json(a, 200, cors);
    }
    // Web Push for this code: GET → { key } (the room's VAPID public key), POST { client, name, sub } subscribes a device,
    // DELETE ?client= drops it, POST …/test { client } sends that device a test push.
    if (url.pathname.startsWith('/push/')) {
      if (request.method === 'GET') return json({ key: (await this.vapid()).pub }, 200, cors);
      if (request.method === 'DELETE') {
        const subs = (await this.ctx.storage.get('subs')) || {}; delete subs[url.searchParams.get('client') || ''];
        await this.ctx.storage.put('subs', subs); return json({ ok: true }, 200, cors);
      }
      if (request.method !== 'POST') return json({ error: 'method' }, 405, cors);
      let body; try { body = JSON.parse(await request.text()); } catch (_) { return json({ error: 'bad json' }, 400, cors); }
      const id = String(body?.client || '').slice(0, 40); if (!id) return json({ error: 'no client' }, 400, cors);
      const subs = (await this.ctx.storage.get('subs')) || {};
      if (url.pathname.endsWith('/test')) {
        if (!subs[id]) return json({ error: 'not subscribed' }, 404, cors);
        const r = await webPush(subs[id].sub, JSON.stringify({ title: 'Test notification', body: 'Push from the relay works.', tag: 'test' }), await this.vapid());
        if (r.status === 404 || r.status === 410) { delete subs[id]; await this.ctx.storage.put('subs', subs); }
        return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502, cors);
      }
      const sub = body.sub;
      if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'bad subscription' }, 400, cors);
      subs[id] = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, name: String(body.name || '').slice(0, 40), at: Date.now() };
      await this.ctx.storage.put('subs', subs);
      await this.ensureAlarm();
      return json({ ok: true }, 200, cors);
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      const id = (url.searchParams.get('client') || '').slice(0, 40);
      this.ctx.acceptWebSocket(server, [id]);
      server.serializeAttachment({ at: Date.now() });   // liveness: connect time, then the auto ping/pong time
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
      // `base` = the stored version the client last saw: someone else wrote since → 409 + the stored copy, and the client
      // merges both sides' edits and retries. Clients without `base` (before v15.0): last edit wins by time.
      const hasBase = typeof body.base === 'number';
      if (cur && (hasBase ? body.base !== cur.updatedAt : cur.updatedAt > body.updatedAt)) return json(cur, 409, cors);
      // Extra fields (flags, and whatever later versions add) ride along; a client that doesn't know a field keeps what's stored.
      const extra = {};
      for (const src of [cur || {}, body]) for (const [k, v] of Object.entries(src)) if (!['updatedAt', 'lists', 'base'].includes(k) && v !== undefined) extra[k] = v;
      // versions only go up, whatever the device clocks say (clients match on equality)
      const d = { ...extra, updatedAt: cur ? Math.max(body.updatedAt, cur.updatedAt + 1) : body.updatedAt, lists: body.lists };
      await this.ctx.storage.put('doc', d);
      const from = request.headers.get('X-Client-Id') || '', msg = JSON.stringify({ type: 'state', doc: d });
      for (const ws of this.ctx.getWebSockets()) if (this.ctx.getTags(ws)[0] !== from) { try { ws.send(msg); } catch (_) {} }
      await this.touch(from, url.searchParams.get('name') || request.headers.get('X-Client-Name'));
      const sent = this.notify(cur, d, from).catch(() => {});   // new notes → push to the other devices
      if (this.ctx.waitUntil) this.ctx.waitUntil(sent); else await sent;
      await this.ensureAlarm();
      return json({ updatedAt: d.updatedAt }, 200, cors);
    }
    return json({ error: 'method' }, 405, cors);
  }
  async vapid() {   // this room's VAPID key pair, made on first use
    let v = await this.ctx.storage.get('vapid'); if (v) return v;
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await this.ctx.storage.put('vapid', v); return v;
  }
  // Notes that are new in this version of the doc (fired alerts, reached points, follow moves, earnings results — written by
  // a device or by the check below) go to every subscribed device except the one that wrote them (it notified itself).
  async notify(prev, d, from) {
    const subs = (await this.ctx.storage.get('subs')) || {}, ids = Object.keys(subs).filter(id => id !== from); if (!ids.length) return;
    const old = new Set((prev?.notifLog || []).map(e => e.key)), now = Date.now();
    // alert / point / follow notes are pushed only from the room's own check (from = ''); a device's PUT can't push them
    // (an old version or a device waking with stale quotes used to fire false ones)
    const ALERT_KINDS = new Set(['follow', 'alert', 'buy', 'sell']);
    const fresh = (d.notifLog || []).filter(e => e && e.key && e.sym && !old.has(e.key) && now - (e.t || 0) < 12 * 36e5 && (!from || !ALERT_KINDS.has(e.kind))).slice(0, 5).reverse();
    if (!fresh.length) return;
    const vapid = await this.vapid(); let gone = false;
    for (const e of fresh) {
      const text = JSON.stringify({ ...pushText(e), sym: e.sym, tag: e.key });
      for (const id of ids) {
        try { const r = await webPush(subs[id].sub, text, vapid); if (r.status === 404 || r.status === 410) { delete subs[id]; gone = true; } } catch (_) {}
      }
    }
    if (gone) await this.ctx.storage.put('subs', subs);
  }
  // Devices that are really there: connected and answering the 30 s keep-alive (a frozen iPhone app keeps its socket open).
  liveSockets() {
    const cut = Date.now() - LIVE_MS;
    return this.ctx.getWebSockets().filter(ws => ws.readyState === 1 && Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0, ws.deserializeAttachment()?.at || 0) > cut);
  }
  async ensureAlarm() {
    const d = await this.ctx.storage.get('doc'), lines = d?.lines || {};
    if (!Object.values(lines).some(L => Array.isArray(L) && L.some(l => l.k && !l.hit && l.d))) return;
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
  }
  // The single place alerts are checked (since v17.8 the app no longer fires them when it has a sync code): once a minute
  // while anything is armed, on live prices. Alerts / points fire at once; a crossed follow pair waits 5 s and fires on the
  // price then (the crossed line even if it's back inside). Notes go into the doc (devices show them) and out as push.
  async alarm() {
    const d0 = await this.ctx.storage.get('doc'), lines = d0?.lines || {};
    const syms = Object.keys(lines).filter(s => Array.isArray(lines[s]) && lines[s].some(l => l.k && !l.hit && l.d)); if (!syms.length) return;
    await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
    const bucket = alertBucket(); if (bucket === (await this.ctx.storage.get('checkBucket'))) return;   // once a minute
    await this.ctx.storage.put('checkBucket', bucket);
    const prices = async list => { try { const p = await livePrices(list); if (p && Object.keys(p).length) return p; } catch (_) {} try { return await scanPrices(list); } catch (_) { return null; } };
    const p1 = await prices(syms); if (!p1) return;
    // alerts / points now, and which follow lines are crossed
    let d = await this.ctx.storage.get('doc'); if (!d) return;
    let next = structuredClone(d);
    const crossed = new Set(), csyms = new Set();
    for (const [sym, L] of Object.entries(next.lines || {})) { const p = p1[sym]; if (p == null || !Array.isArray(L)) continue; for (const ln of L) if (ln.k === 'follow' && !ln.hit && ln.d && (ln.d > 0 ? p >= ln.p : p <= ln.p)) { crossed.add(ln.id); csyms.add(sym); } }
    if (checkLines(next, p1, { only: 'other' })) await this.commit(d, next);
    // follow: 5 s debounce on the crossed symbols, then the pairs (and notes whose quiet period ended)
    let p2 = p1;
    if (crossed.size) { await sleep(5000); const q = await prices([...csyms]); p2 = { ...p1, ...(q || {}) }; }
    d = await this.ctx.storage.get('doc'); if (!d) return;
    next = structuredClone(d);
    if (checkLines(next, p2, { only: 'follow', force: crossed })) await this.commit(d, next);
  }
  async commit(d, next) {   // store a checked doc, send it to the open devices, push its new notes
    next.updatedAt = Math.max(Date.now(), d.updatedAt + 1);
    await this.ctx.storage.put('doc', next);
    const msg = JSON.stringify({ type: 'state', doc: next });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch (_) {} }
    await this.notify(d, next, '');
  }
  async webSocketMessage(ws, msg) { if (msg === 'peers') await this.peers(); }   // a client asking who is here (ping/pong is automatic)
  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code); } catch (_) {}
    await this.touch(this.ctx.getTags(ws)[0], null, false);
    await this.peers(ws);
    await this.ensureAlarm();
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

    if (url.pathname.startsWith('/push/')) {
      if (!allowed(origin, env)) return new Response('forbidden', { status: 403 });
      const cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      return toRoom(request, env, url.pathname.split('/')[2] || '', cors);
    }

    if (url.pathname.startsWith('/log/')) {
      if (request.method !== 'GET' && !allowed(origin, env)) return new Response('forbidden', { status: 403 });   // anyone with the code may read
      const cors = { 'Access-Control-Allow-Origin': origin || '*', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      return toRoom(request, env, url.pathname.split('/')[2] || '', cors);
    }

    if (url.pathname.startsWith('/analysis/')) {
      if (request.method !== 'GET' && !allowed(origin, env)) return new Response('forbidden', { status: 403 });   // anyone with the code may read
      const cors = { 'Access-Control-Allow-Origin': origin || '*', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
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
      return new Response('tv-watchlist relay: websocket endpoint, GET /search?text=, GET/PUT /state/<code>, websocket /sync/<code>, GET/POST /log/<code>, GET/PUT /analysis/<code>, GET /news?symbol=, GET /news/story?id=', { status: 200 });
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
