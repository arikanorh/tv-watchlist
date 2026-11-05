// Service worker: open the app instantly from cache, refresh in the background (stale-while-revalidate).
// Shell = the app page (scope root or index.html, query ignored), tv.js, icons, manifest; the pinned Lightweight Charts
// build is cache-first (versioned URL). Everything else (quotes, sync, news, relay) goes straight to the network.
// The page's version check (index.html) writes a newer page into this cache before it reloads, so a reload never
// serves the old one. ?nosw on the page unregisters this worker.
const CACHE = 'tvw-shell-v1';
const ROOT = new URL('./', self.registration.scope).href;
const TVJS = 'https://s3.tradingview.com/tv.js';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url), same = u.origin === location.origin, path = u.origin + u.pathname;
  const page = r.mode === 'navigate' && same && (path === ROOT || path === ROOT + 'index.html');
  const lib = u.href.startsWith('https://unpkg.com/lightweight-charts@');
  const asset = u.href === TVJS || (same && (u.pathname.startsWith(new URL(ROOT).pathname + 'icons/') || path === ROOT + 'manifest.webmanifest'));
  if (!page && !lib && !asset) return;
  const key = page ? ROOT : u.href;
  e.respondWith((async () => {
    const c = await caches.open(CACHE), hit = await c.match(key);
    if (hit && lib) return hit;   // versioned: never changes
    const net = fetch(page ? new Request(ROOT, { cache: 'no-store' }) : r).then(res => {
      if (res.ok || res.type === 'opaque') c.put(key, res.clone());
      return res;
    });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  })());
});

// A tap on an alert notification: focus the open app and show that symbol, or open the app on it.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const sym = e.notification.data?.sym;
  e.waitUntil((async () => {
    const [c] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (c) { await c.focus().catch(() => {}); if (sym) c.postMessage({ type: 'open-symbol', sym }); return; }
    await self.clients.openWindow(ROOT + (sym ? '#sym=' + encodeURIComponent(sym) : ''));
  })());
});

// A push from the relay (sync room): a fired alert / reached point / follow move / earnings note from another device or
// from the room's own check. Always shown (iOS revokes push for silent ones).
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'tv-watchlist', { body: d.body || '', icon: ROOT + 'icons/icon-192.png', tag: d.tag, data: { sym: d.sym } }));
});
