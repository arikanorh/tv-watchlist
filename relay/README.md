# Quote relay (Cloudflare Worker)

TradingView's quote websocket only accepts connections whose `Origin` is localhost or a tradingview.com domain.
This worker accepts the page's websocket, dials TradingView with a `https://www.tradingview.com` Origin and relays frames both ways.

Deploys automatically from GitHub Actions (`.github/workflows/deploy-relay.yml`) whenever `relay/**` changes on `main`; the repo secret `CLOUDFLARE_API_TOKEN` must hold a token made from the "Edit Cloudflare Workers" template. Manual deploy, if ever needed:

```bash
cd relay
CLOUDFLARE_API_TOKEN=... npx wrangler@4 deploy   # prints https://tv-watchlist-relay.<subdomain>.workers.dev
```

Then set `RELAY_WS` in `index.html` to `wss://tv-watchlist-relay.<subdomain>.workers.dev` and push.
Add any new page origin to `ALLOWED_ORIGINS` in `worker.js`.
