# tv-watchlist

A personal, TradingView-style watchlist in a single `index.html`: several lists, live quotes, a chart, cross-device sync. No framework, no build step, no backend of its own — just a small Cloudflare Worker that relays and stores.

Live: https://arikanorh.github.io/tv-watchlist/ · https://tv-watchlist.pages.dev (both serve `main`). Installable on iOS as a home-screen app.

This file is the map: what the app does, where each piece of data comes from, and **which parts depend on undocumented TradingView behaviour** — so that when something stops working we know what broke and what to replace it with. Protocol details (framing, payloads, fields) live in [DATA-SOURCES.md](DATA-SOURCES.md); the code map for working on it is in [CLAUDE.md](CLAUDE.md); the relay in [relay/README.md](relay/README.md).

## Features

**Lists**
- Any number of watchlists, each with sections (groups). Lists show as small icons or two-letter tags with their day move (flags for US / TR, Bitcoin for crypto, a calendar for Earnings; a name starting with an emoji uses it); on desktop they sit as a compact tab row on top of the list. Sections are dividers: drag a section header between rows to re-cut the list, drag rows to reorder or move between sections (hold on touch, immediate with a mouse), rename/delete from the section menu, "Add section above" from a row.
- Row actions: details, flag, add to another list, move, remove (asks for a second tap; stacked undo).
- Flags: six colors, drawn as the row's left border; click the border strip to cycle (desktop), picker on phones. Shared across lists and synced.
- Sorting by Chg% or Ext (extended-hours change) from the column headers; indices stay on top.
- "Earnings" list, always last: its "Upcoming" section fills itself with every symbol of your other lists whose earnings are within 7 days; "Manual" is yours; "Reported" keeps the ones that reported in the last 2 days, with a green (beat) / red (miss) badge.
- Pinned quick symbols (US100, SPX, US10Y, VIX, BTC, ETH) in the toolbar / phone header.

**Quotes**
- Live last / change / extended-hours change for every symbol of every list, with session awareness: pre-market, regular, post-market and overnight (Blue Ocean, 20:00–04:00 ET) — the header is tinted by session.
- Sentiment: each list's average day move (equities only; TR → XU100, crypto → USDT pairs), shown on every list chip and charted over time (Today / 1h / 4h / 24h) with a zero line.
- Details panel: day range, open, prev close, volume vs average, 52-week range, 1W / 52W / from-ATH moves, valuation, company, next earnings, analyst target.
- Browser tab title = symbol, day change and extended change.

**Chart**
- Two chart engines, switchable with the icon at the chart's bottom-left:
  1. TradingView's free Advanced Chart widget (official embed).
  2. Our own chart (Lightweight Charts) fed by TradingView's chart websocket — used automatically for symbols the free widget refuses (BIST, plain indices), or for everything with the "Own chart for all symbols" setting. It has a TradingView-style price label (price, day %, bar-close countdown), session shading, volume, a Session choice (regular / extended / 24 hours incl. overnight), and TradingView's wheel behaviour (zoom keeps the latest bar fixed).
- Horizontal rays on our own chart (desktop tool column): a line from the clicked bar to the right, draggable, kept per symbol across intervals and devices.
- Alerts on those lines or from a row's "Alerts" sheet: a plain **Alert** fires once when the price crosses it (sound, a note under the top bar, a bell on the row) and then goes passive; a **Buy point** / **Sell point** keeps a B / S icon next to the ticker — plain, turning green / red while the price is below the buy / above the sell point (reaching one also rings once). Fresh earnings results also show as a note until dismissed. Checked against live quotes by whichever device has the app open.
- Interval buttons, search box and chart settings float over the chart on desktop; phones put them under the chart.
- Keyboard (desktop): ↑/↓ rows, ←/→ lists, any letter opens search, 1–8 picks an interval.

**Sync**
- Turn on sync in Settings with a short code (4 letters/digits, or your own); every device with the code shares the lists and flags, live (websocket push, usually under half a second). The settings box lists the devices on the code and which are online.
- Per-device things stay local: active list, chart symbol, interval, view, collapsed sections, chart options.

## Where the data comes from

Everything comes from TradingView. Only one of the five channels below is an official, documented product (the chart widget); the rest were worked out by reading network traffic and the embed's JavaScript, and TradingView may change or block them at any time. Each entry says what it is for and what to do if it dies.

| # | Channel | Used for | Official? | If it breaks |
|---|---|---|---|---|
| 1 | **Quote websocket** `wss://data.tradingview.com/socket.io/websocket` (`~m~len~m~` framing, `quote_create_session`, `quote_add_symbols`, `qsd` updates) | All live quotes, session state, extended-hours and overnight prices (`BOATS:` twins), details fields | No | Fall back to the scanner (#2) — it already runs automatically when the socket can't open (`?quotes=poll` forces it). Slower (10 s polls), no overnight data. |
| 2 | **Scanner REST** `POST https://scanner.tradingview.com/global/scan` | Bulk snapshot fallback, symbol search fallback | No (public but undocumented) | Nothing left for quotes except the widget's own display; the app would become a list manager. |
| 3 | **Advanced Chart widget** `https://s3.tradingview.com/tv.js` + its iframe `postMessage` API (`set-symbol`, `set-interval`) | Chart engine 1. The postMessage calls are undocumented; they let us change symbol/interval without reloading the iframe. | Widget yes, postMessage no | If postMessage stops working the widget still shows a chart — we go back to re-creating it on every symbol change (slower, flickers). If the widget itself is withdrawn, engine 2 covers every symbol. |
| 4 | **Chart websocket** (same host as #1: `chart_create_session`, `resolve_symbol`, `create_series`, `timescale_update` / `du`) | Chart engine 2: history (300 bars) and live bars for any symbol, any interval, session `regular` / `extended` / `24h` (overnight), volume. Works with `unauthorized_user_token`; BIST is delayed. | No | Engine 2 dies; the widget still charts everything except BIST / plain indices. Those go back to quote-only. |
| 6 | **News** `news-headlines.tradingview.com/v2/headlines`, `/v2/story` (via the relay off localhost) | Headlines and summaries in the details panel | No | The News section shows "Couldn't load news"; nothing else depends on it. |
| 5 | **Symbol search** `symbol-search.tradingview.com` (via the relay) | The search box | No | Fall back to the scanner's name filter (already wired) — worse ranking, fewer markets. |

Also: the quote and chart websockets accept the handshake only from TradingView's own origins, so off `localhost` they go through the relay worker (`relay/worker.js`), which just forwards bytes to `data.tradingview.com`. The worker also proxies symbol search and hosts the sync rooms.

Nothing depends on a TradingView login. The one logged-in trick (reading the user's real watchlists from `GET /api/v1/symbols_list/custom/`) is a manual, one-off seed step and never runs from the app.

## Tricks worth knowing

- **Overnight prices**: TradingView carries Blue Ocean overnight trading as separate `BOATS:<ticker>` symbols. During 20:00–04:00 ET the app subscribes to each US stock's twin and shows its price as the extended price, change measured against the regular close. On the chart, `resolve_symbol` with `session: "24h"` returns a single 24-hour bar stream (pre + regular + post + overnight) for US stocks; `extended` gives 04:00–20:00; other symbols only know `regular`/`extended`.
- **New bar = `timescale_update`**: the chart socket sends the history as `timescale_update`, incremental updates as `du` — but when a new bar opens it sends another `timescale_update` carrying *only the new bar*. Treat only the first one as the full series.
- **Reconnects keep the view**: through the relay the sockets drop now and then (code 1006, often at second :02 of a minute). The chart re-requests the same series on reconnect; `ownRequest` then keeps the bars on screen and restores the view counted back from the last bar (`own.keep`) instead of re-fitting — otherwise every drop reset the zoom and threw away the loaded history.
- **New bars don't scroll by themselves**: the future-axis whitespace already holds the next bar's slot, so the library doesn't shift the view when a bar opens; the client shifts it while the last bar is in view.
- **Chart sessions are per socket**: `chart_delete_session` for an id the current socket never created is a `protocol_error` and the server closes the connection. After a reconnect, never clean up sessions from the old socket.
- **Stalled sockets**: the quote socket can keep answering heartbeats while delivering no data; a 30 s "no `qsd`" watchdog reconnects.
- **Free widget refusals**: BIST and bare index symbols (`NASDAQ:NDX`, `SP:SPX`, `INDEX:*`, `TVC:VIX`) show "only available on TradingView" in the free embed. Some have a chartable alias (`TVC:US10Y` → `PYTH:US10Y`, `TVC:VIX` → `CAPITALCOM:VIX`); the rest use engine 2.
- **Widget blank when hidden**: a widget created while its container has no size stays blank forever; the app remounts it when the pane first becomes visible.
- **Sync conflicts**: last edit wins by timestamp; the worker answers 409 with its copy to an older PUT, the client merges by adopting it. Unknown fields are preserved by the worker so old and new app versions can share a code.
- **iOS PWA quirks**: the standalone web view sometimes stops short of the screen bottom (`fitStandalone`), the document shifts after keyboard use (`unshift`), and bottom sheets must dodge the keyboard (`--kb`).

## Running it

Any static server works: `python3 -m http.server 8787` in the repo and open http://localhost:8787/. On localhost the websockets go direct; elsewhere set `RELAY_WS` to your deployed worker. The worker deploys from GitHub Actions on changes under `relay/` (needs the `CLOUDFLARE_API_TOKEN` secret). `APP_VERSION` in `index.html` is bumped on every push; the page reloads itself when the live version changes.
