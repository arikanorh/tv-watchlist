# tv-watchlist

Personal TradingView-style watchlist: one static `index.html` (vanilla JS, no build, no backend) with live quotes, a TradingView chart widget, multiple watchlists and a details panel. Live at https://arikanorh.github.io/tv-watchlist/ (GitHub Pages, `main`). Owner: arikanorh (personal GitHub, not the work GHE).

Read `DATA-SOURCES.md` for the exact protocols (websocket framing, scanner payloads, widget postMessage API, field catalog).

## Files

| Path | Role |
|---|---|
| `index.html` | The whole app: CSS, markup, JS (~900 lines). Only deliverable. |
| `relay/worker.js` | Cloudflare Worker that relays the TradingView quote websocket for non-localhost origins. |
| `relay/wrangler.toml`, `relay/README.md` | Worker config + deploy notes. |
| `.github/workflows/deploy-relay.yml` | Deploys the worker on push to `main` when `relay/**` changes (secret `CLOUDFLARE_API_TOKEN`). |
| `DATA-SOURCES.md` | Reverse-engineered TradingView endpoints and their quirks. |
| `reference/` | Git-ignored. Field catalog dump and the user's real TradingView watchlist snapshot. |

## Runtime architecture (index.html)

**State** — `state` object persisted in `localStorage` key `tvwl.state.v2`:
`{ activeListId, interval, symbol, pinned[], chartHidden, detailsOpen, panelWidth, lists:[{id,name,groups:[{name,collapsed,symbols[]}]}] }`.
`seed()` builds the default lists; `load()` migrates stored symbols through `SYMBOL_FIXES` / `REMOVED` and fills `pinned` with `DEFAULT_PINS`. Bumping `KEY` resets everyone's state (last bump: v1→v2).

**Rendering** — `render()` rebuilds tabs, pinned ticker tape (`#pins`, chips) and the list (`#list`) from state; `update(switchSymbol)` = save + render (+ `showSymbol()`). One delegated `click` handler on `document` dispatches on `data-action` (select, remove, interval, toggle-group, add/rename/delete-group, list, pin/unpin, manage-lists, dlg-*, toggle-details, toggle-chart, toggle-panel). List rows use HTML5 drag & drop (reorder within/between groups; no touch support). List management lives in a `<dialog id="listDlg">`.

**Chart** — TradingView Advanced Chart free widget (`tv.js`, `mountChart()`), mounted once. Symbol and interval changes go through the undocumented iframe postMessage API (`send('set-symbol'|'set-interval', …)`), so the chart never reloads; messages queue until the iframe's first message (`chart.ready`). The widget's `quoteUpdate` stream tells us which symbol the user picked inside the widget (`onChartSymbol`): if it is in the active list it gets highlighted, otherwise the add box is prefilled (`resolveSymbol()` maps the Cboe feed name `BATS_DLY:X` to the listing exchange via the scanner). `hide_side_toolbar: true`; top toolbar kept for symbol search.

**Quotes pipeline** — `quotes[sym] = {p,c,e,ep,es,ss}` (last, chg%, ext chg%, ext price, session label, session dot) rendered by `quoteHtml()`; `raw[sym]` keeps every merged field for the details panel. Sources, in order:
1. Websocket `WS_DIRECT` (direct) when on localhost, else `RELAY_WS` (Cloudflare relay). TradingView only accepts the handshake from localhost/tradingview.com origins, hence the relay. `wsConnect()/wsSync()/onQuote()`; partial `qsd` updates are merged. Subscribed set = pinned ∪ active list.
2. If the socket never opens (`wsEverOpen` false after a retry) → `quoteSource='poll'`: `pollNow()` hits the scanner REST every `POLL_MS` (10 s); symbols the scanner lacks (broker CFDs like `SKILLING:US100`) get hidden mini chart widgets (`syncFeeders()`, max 4) that stream `quoteUpdate` after a `quoteSubscribe` postMessage. `?quotes=poll` forces this mode for testing.
`renderQuotes()` is throttled (250 ms), patches cells in place and flashes changed ones (`.flash.f-up/f-down/f-same`). `onQuote` also stamps the top-bar tick time and pulses it (max every 1.5 s). Status dot: green live, red reconnecting, amber polling.

**Sessions** — `isRegularSession()` (09:30–16:00 ET Mon–Fri) hides the Ext column; `sessionPhase()` drives the top-bar badge (pre/open/post/overnight/closed). Outside regular hours Last shows the extended price (`rtc`), Ext shows `rchp` with a colored dot (amber pre, blue post, purple overnight). Overnight behaviour is inferred, not yet observed live.

**Details panel** — `renderDetails()` builds a quote sheet for `state.symbol` from `raw`; same-symbol updates are patched per `[data-k]` cell with flash; range bars for day and 52 weeks; stock-only "Company" block. Toggle persisted in `state.detailsOpen`.

**Layout** — top bar (tabs, intervals, status, tick time, session badge, ⋯ lists, details, chart toggles) → ticker tape → body: list panel | resizer | details | chart. Mobile (<768px): stacked, intervals hidden (widget has its own), session badge collapses to a dot, chart toggle gives the list the full screen. Panel width is draggable and persisted.

**Dev conveniences** — on localhost the page polls its own `Last-Modified` every second and reloads itself (live reload); off localhost this is inert.

## Development workflow

- Dev server: `.claude/launch.json` in `~/workspace/comeon` has `tv-watchlist` → `python3 -m http.server 8787 --directory ~/workspace/orhan/tv-watchlist`; open http://localhost:8787/. Any static server works.
- Branching: work on `dev`, open a PR `dev → main`; `main` is what Pages serves. No `gh` CLI on this machine; PRs via the GitHub API with the token in macOS Keychain (`github.com`, user `arikanorh`). The repo-local git identity is `arikanorh@users.noreply.github.com` (work GHE identity is global, keep them separate).
- Relay deploy is automatic from Actions; manual: `cd relay && CLOUDFLARE_API_TOKEN=… npx wrangler@4 deploy`. Add new page origins to `ALLOWED_ORIGINS` in `worker.js`.
- Verify in the browser after UI changes (desktop + mobile preset); check `quoteSource`, `ws.readyState`, `Object.keys(quotes).length`, console errors.

## Constraints and decisions

- Single file, no framework, no backend, no build step. Keep it that way.
- Mobile-first: small-screen usability wins.
- Nothing may depend on the user's logged-in TradingView account. Only on an explicit "listeleri güncelle" request: read `GET /api/v1/symbols_list/custom/` from a TradingView tab the user opened, snapshot to `reference/`, update `seed()`.
- The chart widget is official; the websocket, scanner and iframe postMessage API are reverse-engineered and may break without notice. Keep the polling fallback working.
- Free widget cannot chart BIST symbols or plain indices like `NASDAQ:NDX` / `SP:SPX` (removed; the pinned CFDs `SKILLING:US100` / `SKILLING:SPX500` cover them).
- Replies to the user in Turkish with English technical terms; terse progress updates.

## Known gaps / ideas

- Symbol search endpoint is origin-locked to tradingview.com (403 elsewhere); the scanner `name match` filter could power an autocomplete.
- `OANDA:XAUEUR`, `FX_IDC:XAUTRYG`, `INDEX:S5FI` have no scanner data (websocket covers them).
- Overnight (BOATS) session labelling unverified between 20:00–04:00 ET.
- Touch drag & drop for reordering on phones.
- Column picker for extra fields (volume, 1W, 52W, market cap) is a natural next step; the websocket already delivers them.
