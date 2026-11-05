# Quote relay (Cloudflare Worker)

TradingView's quote websocket only accepts connections whose `Origin` is localhost or a tradingview.com domain.
This worker accepts the page's websocket, dials TradingView with a `https://www.tradingview.com` Origin and relays frames both ways.
It also proxies `GET /search?text=…` to TradingView's symbol search (same origin lock) for the add-box autocomplete,
and keeps the synced watchlists: one `SyncRoom` Durable Object per sync code (SQLite-backed, free plan). `GET/PUT /state/<code>` read and write
the code's lists; the `/sync/<code>?client=<id>` websocket delivers the room's copy on connect and after every save from another device, so
devices update at once. A PUT whose `base` isn't the stored version (`updatedAt`) — or, from clients before v15.0 without `base`, one older than it — gets `409` with the stored copy (the client merges and retries), so an old offline edit can't overwrite
a newer one. Codes saved before the rooms existed live in the KV namespace `tv-watchlist-sync` (binding `SYNC`); a room copies its code from there once.

The deploy workflow finds that namespace, creates it on the first run, and appends the binding to `wrangler.toml` inside the job
(the repo keeps no namespace id). For a manual deploy, append the binding yourself first:
`npx wrangler@4 kv namespace list` → `[[kv_namespaces]] binding = "SYNC" id = "<id>"`.

Deploys automatically from GitHub Actions (`.github/workflows/deploy-relay.yml`) whenever `relay/**` changes on `main`; the repo secret `CLOUDFLARE_API_TOKEN` must hold a token made from the "Edit Cloudflare Workers" template. Manual deploy, if ever needed:

```bash
cd relay
CLOUDFLARE_API_TOKEN=... npx wrangler@4 deploy   # prints https://tv-watchlist-relay.<subdomain>.workers.dev
```

Then set `RELAY_WS` in `index.html` to `wss://tv-watchlist-relay.<subdomain>.workers.dev` and push.
Add any new page origin to `ALLOWED_ORIGINS` in `worker.js`.

- `GET /analysis/<code>` → `{ [sym]: { t, tone: 'pos'|'neg'|'neu', text, earn? } }`; `PUT /analysis/<code>` `{ items: { [sym]: { tone, text, earn? } }, drop?: [sym] }` merges (allowed Origin only). `earn` = `{ rt, tone, text }`, the analysis of the latest earnings report (`rt` = report time, unix s; text ≤ 800 chars): kept when an item comes without it, replaced when given, removed with `earn: null`. Stored in the code's SyncRoom; written daily by the cloud routine.

## Web Push

`GET /push/<code>` → `{ key }` (the room's VAPID public key, generated on first use and kept in the room), `POST /push/<code>`
`{ client, name, sub }` registers a device's PushSubscription, `DELETE /push/<code>?client=` drops it, `POST /push/<code>/test`
`{ client }` sends that device a test push. Every note that is new in an accepted PUT is pushed to the other subscribed devices.
While no device is connected, a 20 s alarm checks the room's alerts against TradingView's scanner and pushes what fires.
No secrets needed (keys live in Durable Object storage); encryption is RFC 8291 aes128gcm, auth RFC 8292 VAPID.
