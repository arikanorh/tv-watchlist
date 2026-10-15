# Quote relay (Cloudflare Worker)

TradingView's quote websocket only accepts connections whose `Origin` is localhost or a tradingview.com domain.
This worker accepts the page's websocket, dials TradingView with a `https://www.tradingview.com` Origin and relays frames both ways.
It also proxies `GET /search?text=…` to TradingView's symbol search (same origin lock) for the add-box autocomplete,
and keeps the synced watchlists: one `SyncRoom` Durable Object per sync code (SQLite-backed, free plan). `GET/PUT /state/<code>` read and write
the code's lists; the `/sync/<code>?client=<id>` websocket delivers the room's copy on connect and after every save from another device, so
devices update at once. A PUT older than the stored copy (`updatedAt`) gets `409` with the stored copy, so an old offline edit can't overwrite
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
