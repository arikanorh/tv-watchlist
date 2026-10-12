# TradingView data sources used by tv-watchlist

All of these are **unofficial** (reverse-engineered from TradingView's own frontend / widget bundles). They can change without notice. Verified 2026-10-12.

## 1. Quote WebSocket (primary quote source)

`wss://data.tradingview.com/socket.io/websocket?from=chart%2F&type=chart`

Opens from a browser page on any origin (tested from `http://localhost:8787`). One connection serves any number of symbols.

### Framing
Every message is `~m~<length>~m~<json>`; several frames can be concatenated in one WebSocket message.
Heartbeat: server sends `~m~4~m~~h~1` (payload `~h~N`); reply with the identical frame.

```js
const frame = o => { const j = JSON.stringify(o); return '~m~' + j.length + '~m~' + j; };
```

### Handshake (client → server, in order)
```json
{"m":"set_auth_token","p":["unauthorized_user_token"]}
{"m":"quote_create_session","p":["qs"]}
{"m":"quote_set_fields","p":["qs","lp","ch","chp","rtc","rch","rchp","current_session"]}
{"m":"quote_add_symbols","p":["qs","NASDAQ:NBIS","SKILLING:US100","BINANCE:BTCUSDT"]}
{"m":"quote_remove_symbols","p":["qs","NASDAQ:NBIS"]}
```
Skip `quote_set_fields` to receive **every** field (~1400 per symbol, see `reference/quote-fields-NBIS.txt`). Session name (`qs`) is arbitrary.

### Server → client
First frame is a session info object (`session_id`, `release`, …). Then:
```json
{"m":"qsd","p":["qs",{"n":"NASDAQ:NBIS","s":"ok","v":{"lp":221.07,"ch":1.36,"chp":0.62,"rtc":219.21,"rch":-1.86,"rchp":-0.84,"current_session":"pre_market"}}]}
{"m":"quote_completed","p":["qs","NASDAQ:NBIS"]}
```
- First `qsd` for a symbol carries all requested fields; later ones are **partial** (only changed fields) → merge into a per-symbol object.
- `s:"error"` when the symbol does not exist.
- `quote_completed` = initial snapshot done.

### Key fields
| Field | Meaning |
|---|---|
| `lp`, `lp_time` | last price (regular session), unix time |
| `ch`, `chp` | daily change abs / % |
| `rtc`, `rch`, `rchp`, `rtc_time` | extended-session (pre/post-market) price, change abs / % |
| `current_session` | `pre_market` · `market` · `post_market` · `out_of_session` |
| `market-status` | `{"phase":"pre-market","tradingday":"20261012"}` |
| `open_price`, `high_price`, `low_price`, `prev_close_price`, `regular_close`, `volume`, `average_volume` | OHLC / volume |
| `bid`, `ask`, `bid_size`, `ask_size` | top of book |
| `update_mode` | `streaming` · `delayed_streaming_900` (BIST = 15 min delay) |
| `pro_name`, `short_name`, `description`, `exchange`, `listed_exchange`, `type`, `currency`, `logoid` | identity |
| `session-regular`, `session-premarket`, `session-postmarket`, `session-extended`, `timezone` | session hours ("0930-1600") |
| `exchange_traded_night_name` | `BOATS` for US stocks with overnight trading (overnight price field not yet identified) |
| `price_52_week_high/low`, `all_time_high/low`, `price_percent_change_1_week`, `price_percent_change_52_week` | performance |
| `market_cap_basic`, `total_revenue`, `net_income`, `earnings_release_next_date`, `price_target_*`, `recommendation_*` | fundamentals / analyst |

Coverage: US stocks, BIST, FX, metals, crypto, indices, **broker CFDs** (SKILLING, CAPITALCOM…), futures (`CME_MINI:NQ1!`).

## 2. Scanner REST (bulk snapshot, no streaming)

`POST https://scanner.tradingview.com/global/scan`

```json
{"symbols":{"tickers":["NASDAQ:NBIS","BIST:XU100"]},"columns":["close","change","premarket_close","premarket_change","postmarket_close","postmarket_change","premarket_time","postmarket_time","description","update_mode"]}
```
Response: `{"totalCount":2,"data":[{"s":"NASDAQ:NBIS","d":[221.07,0.62,...]}]}` — `d` follows `columns` order. Unknown column → `null` (not an error).

Search instead of explicit tickers:
```json
{"filter":[{"left":"name","operation":"match","right":"US100"}],"columns":["name","close","exchange","description"],"range":[0,30]}
```

- CORS: allowed for any origin, but **only `Referer` / `Accept` headers** — do not set `Content-Type` (preflight fails). Send the JSON as a plain POST body.
- Not covered: broker CFDs (SKILLING/CAPITALCOM/PEPPERSTONE…), `OANDA:XAUEUR`, `FX_IDC:XAUTRYG`, `INDEX:S5FI`, overnight (BOATS) session.
- `premarket_*` / `postmarket_*` are the **last completed** session (stale over the weekend); websocket `rtc` is live.
- Currently used only by `resolveSymbol()` to find the listing exchange of a widget symbol.

Other scanner markets (`/america/scan`, `/turkey/scan`, …) exist; `/global/scan` covered everything tested.

## 3. Advanced Chart widget (`https://s3.tradingview.com/tv.js`)

`new TradingView.widget({ container_id, symbol, interval, autosize, theme, hide_side_toolbar, hide_top_toolbar, hide_legend, hide_volume, details, watchlist:[...], support_host })`

Iframe origin `https://s.tradingview.com/widgetembed/`. Config is passed in the URL hash (changing it does **not** update the chart).

### Inbound postMessage (page → iframe) — undocumented, found in `embed_advanced_chart.*.js`
```js
iframe.contentWindow.postMessage({ name: 'set-symbol',   data: { symbol: 'NASDAQ:AAPL' } }, '*');
iframe.contentWindow.postMessage({ name: 'set-interval', data: { interval: '240' } }, '*');   // 1,5,15,60,240,D,W
```
Changes the chart in place, no reload. Messages sent before the widget is ready are lost → queue until the first message arrives from the iframe.

Second protocol (`provider:"TradingView"`, JSON **string**): handlers `widgetReady`, `symbolInfo`, `quoteSubscribe`, `imageCanvas`.
```js
iframe.contentWindow.postMessage(JSON.stringify({ provider:'TradingView', type:'get', name:'quoteSubscribe', id:1, client_id:'x', data:{} }), '*');
```
`quoteSubscribe` (re)starts the quote stream for the chart's current symbol.

### Outbound postMessage (iframe → page)
JSON string:
```json
{"id":22,"type":"post","name":"quoteUpdate","client_id":"","provider":"TradingView",
 "data":{"change":-3.78,"change_percent":-1.11,"last_price":336.64,"original_name":"BATS_DLY:AAPL","short_name":"AAPL","exchange":"Cboe One","description":"Apple Inc.","volume":37881199}}
```
- Emitted after symbol change and after `quoteSubscribe`; `original_name` is the data feed symbol (`BATS_DLY:` for free delayed US stocks), not the listing exchange → resolve via scanner or websocket `pro_name`.
- Also emitted (object form): `tv-widget-ready`, `tv-widget-load`, `tv-widget-symbol-click`, `tv-widget-resize-iframe`, `tv-widget-no-data`.

Limits: free widget does not show BIST symbols on the chart ("only available on TradingView"); quotes for them still come via websocket.

## 4. Symbol search

`GET https://symbol-search.tradingview.com/symbol_search/v3/?text=NQ1&hl=1&exchange=&lang=en&search_type=undefined&domain=production&enable_grouping=true&sort_by_country=US&promo=true`

Response: `{"symbols_remaining":0,"symbols":[{"symbol":"NQ","description":"E-mini Nasdaq-100 Futures","type":"futures","exchange":"CME","source_id":"CME_MINI","prefix":…,"contracts":[{"symbol":"NQ1!","prefix":"CME_MINI"}]}, …]}` (`<em>` tags mark the match when `hl=1`).

- Works only from a `https://www.tradingview.com` page (CORS `access-control-allow-origin: https://www.tradingview.com`); every other origin and curl get **403** even with Origin/Referer headers. Needs a proxy to use from our page → not used.
- Alternative that works from any origin: scanner search `{"filter":[{"left":"name","operation":"match","right":"NQ1"}],"columns":["name","exchange","description","type"],"range":[0,20]}` (see §2). Good enough for an autocomplete.

## 4b. User watchlists (logged-in only)

`GET https://www.tradingview.com/api/v1/symbols_list/custom/?source=web` (cookie auth, same-origin). Also `/colored/`, `/all/`, `/custom/<id>`.

```json
[{"id":121347359,"type":"custom","name":"ABD","active":false,"modified":"2026-09-25T18:43:47Z",
  "symbols":["SKILLING:US100","CAPITALCOM:SPX500","###SPOT","NASDAQ:NBIS","…","###MOON SH","NASDAQ:ONDS"]}]
```
Groups are inline markers: an entry starting with `###` begins a section; symbols before the first marker are ungrouped. Snapshot of the user's lists on 2026-10-12: `reference/tradingview-watchlists-2026-10-12.json` (ABD 20, İnci 13, Krip 12, Özet 20, TR 16, Z-Örning 28). Not reachable from our page (cookies), import by pasting the JSON.

## 4c. Overnight (BOATS) session

Websocket fields: `exchange_traded_night_name: "BOATS"`, `session-id: "us_stocks_overnight"`, `subsessions: [{id:"night", session:"2000-0400", private:true}, {id:"24h", …}, …]`. Outside regular hours `rtc/rch/rchp` carry the current extended price; `current_session` reported `pre_market` at 04:4x ET. Whether the night window reports a distinct phase is still unverified (observe `market-status.phase` between 20:00 and 04:00 ET). TradingView's own watchlist "Ext" column = `rchp`.

## 5. Useful ticker notes
- 24h Nasdaq 100 / S&P 500 proxies with quotes: `SKILLING:US100`, `SKILLING:SPX500` (CFD), `OKX:US100USDT.P`, `OKX:US500USDT.P` (perp), `CME_MINI:NQ1!`, `CME_MINI:ES1!` (futures, ~23h, 10-min delay).
- Skilling S&P symbol is `SPX500`, not `US500`.
- Exchange fixes applied in `SYMBOL_FIXES` (index.html): `CAPITALCOM:US100→NASDAQ:NDX`, `TVC:DJI→DJ:DJI`, `TVC:UKOIL→FX:UKOIL`, `OANDA:XAGUSD→TVC:SILVER`, `AMEX:LEU→NYSE:LEU`, `NASDAQ:EUV→CBOE:EUV`, `NASDAQ:DXYZ→NYSE:DXYZ`, `NASDAQ:NASA→AMEX:NASA`, `NASDAQ:TE→NYSE:TE`, `NYSE:QS→NASDAQ:QS`.
