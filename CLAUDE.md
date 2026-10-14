# tv-watchlist

Personal TradingView-style watchlist: one static `index.html` (vanilla JS, no build, no backend) with live quotes, a TradingView chart widget and multiple watchlists. Goal: reach several lists quickly, see how each is doing (sentiment %), open a symbol's chart when needed. Live at https://arikanorh.github.io/tv-watchlist/ and https://tv-watchlist.pages.dev (both serve `main`). Owner: arikanorh (personal GitHub, not the work GHE).

Read `DATA-SOURCES.md` for the exact protocols (websocket framing, scanner payloads, widget postMessage API, BOATS overnight, field catalog).

## Files

| Path | Role |
|---|---|
| `index.html` | The whole app: CSS, markup, JS (~1100 lines). Only deliverable. |
| `manifest.webmanifest`, `icons/` | PWA (iOS home screen, standalone). `background_color` = nav color. |
| `relay/worker.js` | Cloudflare Worker: relays the TradingView quote websocket for non-localhost origins and proxies `/search`. |
| `relay/wrangler.toml`, `relay/README.md` | Worker config + deploy notes. |
| `.github/workflows/deploy-relay.yml` | Deploys the worker on push to `main` when `relay/**` changes (secret `CLOUDFLARE_API_TOKEN`). |
| `DATA-SOURCES.md` | Reverse-engineered TradingView endpoints and their quirks. |
| `reference/` | Git-ignored. Field catalog dump and the user's real TradingView watchlist snapshot. |

## Runtime architecture (index.html)

**State** — `state` in `localStorage` key `tvwl.state.v2`: `{ activeListId, interval, symbol, view, sort, chartHidden, migrated[], lists:[{id, name, summary, groups:[{name, collapsed, symbols[]}]}] }`. `summary` is `true` (average of the list's equities), a symbol string (TR → `BIST:XU100`) or `false`. `seed()` builds the default lists; `load()` runs `SYMBOL_FIXES` / `REMOVED`, one-time migrations recorded in `migrated`, and drops keys of the previous design (pinned, details, history). Bumping `KEY` would reset everyone's lists.

**Layout** — mobile first. Phone: one pane at a time (`body[data-view]` = `list` / `chart`) behind a two-tab nav (Liste / Grafik). What you read is at the top, what you tap at the bottom:
- Header `.top` (session-tinted: pre amber, open green, post blue, overnight purple): list name + sentiment % on the list pane, symbol + last + chg% on the chart pane (tap → search); session label; last tick time + status dot (tap → reconnect).
- List pane: table (Symbol / Last / Chg% / Ext; Ext hidden during the regular session via `body.regular`), collapsible groups, then the dock: one chip per list with its sentiment % (tap → switch) and `+` (search/add), `⇅` (sort by Chg%), `⋯` (list manager).
- Chart pane: TradingView widget, the interval segmented control (`#seg`, under the chart on phones), then the chart bar: `Search` and `ⓘ` details.
- Details (`detailsHtml`): today range, open, prev close, volume vs average; 52-week range, 1W / 52W / from-ATH; valuation (market cap, P/E, EPS, P/S, P/B, dividend yield, beta); company (sector, industry, country, revenue, net margin, next earnings, analyst target). Phones: a bottom sheet (`toggleDetails`), also from the row menu. Desktop: a 300px column between list and chart (`state.detailsOpen`). Re-rendered on every quote batch.
- ≥768px: header shows both list and symbol status; list pane (420px, with the sentiment chart `#sent` above the table) | details (optional) | chart; the interval control moves above the chart; nav hidden; header button hides the chart (`state.chartHidden`).
- Sentiment chart (desktop only, `renderSentiment`): the active list's sentiment % over time from `hist` (`tvwl.hist.v1`; `sampleHistory` every 15 s while open, 2 h at full rate, thinned to 1/min, 24 h kept). Range button cycles Today/Overnight (current session from `sessionOpenTs`: 04:00 or 20:00 ET) → 1h → 4h → 24h; opens on the session every load; hover shows time and value.

**Interactions** — one delegated `click` handler on `document` dispatches on `data-act`. Rows: tap → `selectSymbol()` (chart; phones switch to the chart pane). Press and hold 420 ms → the row lifts: release in place → actions sheet (`openRowMenu`: show on chart, move to group, copy to list, move to top, remove with undo toast); drag → reorder within/between groups (pointer events on `#rows`, a non-passive `touchmove` stops scrolling once lifted). Desktop also has a hover `⋯` button and right-click. Sorted view (`state.sort = 'chg'`): non-equities stay on top as "Index", the rest is one "By change" group by Chg%; drag is off. Sheets (`openSheet`/`closeSheet`) are bottom sheets on phones and centered dialogs on desktop: row actions, move/copy, interval, search (`openSearch`, input at the bottom on phones), list manager (`openListManager`: rename, ↑/↓, Σ sentiment on/off, delete with a second tap, new list).

**Chart** — `CHART_ALIAS` charts an equivalent feed for symbols the embed won't chart (`TVC:US10Y` → `PYTH:US10Y`; `TVC:TNX`, `FRED:*`, CME/CBOT futures show "only available on TradingView"). TradingView Advanced Chart free widget (`mountChart()`), toolbars/legend/volume off, `sessionId: '24h'`. Symbol and interval changes go through the undocumented iframe postMessage API (`send('set-symbol'|'set-interval')`), so the chart never reloads; messages queue until the iframe's first message (`chart.ready`). A widget mounted while its pane has no size stays blank, so `chart.hiddenAtMount` triggers a remount when the pane shows (`setView`, resize). Free widget cannot chart BIST or plain indices (`noChart()`): those rows are quote-only.

**Quotes** — `raw[sym]` holds merged websocket fields; `quotes[sym] = {p, c, e, ep, ss}` (last, chg%, extended chg%, extended price, session dot). Sources:
1. Websocket: direct on localhost, `RELAY_WS` elsewhere (TradingView accepts the handshake only from allow-listed origins). Subscribed set = every symbol of every list (`allSymbols()`), so all chips show live sentiment. Watchdog: 30 s without any `qsd` while the socket is open → reconnect (the session can go silent while heartbeats continue).
2. Overnight (20:00–04:00 ET): `wsSync()` also subscribes each US stock's `BOATS:<ticker>` twin; `onQuote` takes the overnight price from it and computes the change against the regular close. Dropped when the phase ends (`renderSession`).
3. If the socket never opens → `quoteSource = 'poll'`: scanner REST every 10 s, hidden mini widgets (`syncFeeders`, max 4) for symbols the scanner lacks. `?quotes=poll` forces it.
`renderQuotes()` (throttled 250 ms) patches cells in place with flash, refreshes chips and header; in sorted view it re-orders at most every 3 s and never under a finger or an open sheet. Outside regular hours Last shows the extended price and Ext the extended change with a colored dot (amber pre, blue post, purple overnight). Prices: 2 decimals ≥ 1, T/B above a billion, 4 significant digits below 1 (`fmtPrice`). Earnings within 7 days show a tag next to the ticker.

**PWA / iOS** — `fitStandalone()` drops the nav's home-indicator padding when iOS stops the web view short of the screen (`body.ios-gap`); `unshift()` snaps the document back after keyboard use (otherwise taps land off target); `trackKeyboard()` keeps bottom sheets above the keyboard (`--kb`).

**Versioning** — `APP_VERSION` shows in the nav (phones) and header (desktop); bump it on every push to `main`. Off localhost the page re-fetches itself on load and on resume and reloads when the live version differs. On localhost/LAN it live-reloads on file change.

## Vocabulary

The owner calls a watchlist's aggregate move **sentiment**: *sentiment yüzdesi* = the list's day % (`listValue`, from `summarySymbols`: equities only, TR → XU100, Krip → USDT pairs only; outside regular hours it uses the extended move); *sentiment grafiği* = its history chart (`renderSentiment`, desktop only). The per-symbol *sentiment bar'ı* of earlier versions is not in 1.0.

## Development workflow

- Dev server: `.claude/launch.json` in `~/workspace/comeon` has `tv-watchlist` → `python3 -m http.server 8787 --directory ~/workspace/orhan/tv-watchlist`; open http://localhost:8787/ (LAN: http://192.168.1.89:8787/). Any static server works.
- Work on `main` (push only when the owner says so). No `gh` CLI; PRs via the GitHub API with the token in macOS Keychain (`github.com`, user `arikanorh`). Repo-local git identity `arikanorh@users.noreply.github.com`.
- Relay deploy is automatic from Actions; manual: `cd relay && CLOUDFLARE_API_TOKEN=… npx wrangler@4 deploy`. Add new page origins to `ALLOWED_ORIGINS` in `worker.js`.
- Verify in the browser after UI changes, at phone width too (an iframe harness works when the pane can't be resized); check `quoteSource`, `ws.readyState`, `Object.keys(quotes).length`, console errors.

## Constraints and decisions

- Single file, no framework, no backend, no build step.
- Mobile first; information at the top, interaction at the bottom.
- Nothing may depend on the user's logged-in TradingView account. Only on an explicit "listeleri güncelle" request: read `GET /api/v1/symbols_list/custom/` from a TradingView tab the user opened, snapshot to `reference/`, update `seed()`.
- The chart widget is official; the websocket, scanner, symbol search and iframe postMessage API are reverse-engineered and may break without notice. Keep the polling fallback working.
- Replies to the user in Turkish with English technical terms; terse progress updates.

## Known gaps / ideas

- Groups can be collapsed and symbols moved between them, but groups themselves can't be created, renamed or deleted in the app (not requested in the 1.0 redesign).
- `OANDA:XAUEUR`, `FX_IDC:XAUTRYG`, `INDEX:S5FI` have no scanner data (websocket covers them).
