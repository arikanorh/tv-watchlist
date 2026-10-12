# Quote relay (Cloudflare Worker)

TradingView's quote websocket only accepts connections whose `Origin` is localhost or a tradingview.com domain.
This worker accepts the page's websocket, dials TradingView with a `https://www.tradingview.com` Origin and relays frames both ways.

Deploy (free plan is enough):

```bash
cd relay
npx wrangler login      # opens the browser once
npx wrangler deploy     # prints https://tv-watchlist-relay.<subdomain>.workers.dev
```

Then set `RELAY_WS` in `index.html` to `wss://tv-watchlist-relay.<subdomain>.workers.dev` and push.
Add any new page origin to `ALLOWED_ORIGINS` in `worker.js`.
