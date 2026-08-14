# World Trader — autopilot paper-trading sandbox

An experimental, **local-only, paper-money** trading bot that turns
[worldmonitor.app](https://worldmonitor.app) world-event data into fully
specified trades — entry, stop-loss, profit target, position size, time exit —
and then **opens and manages the simulated positions itself**. You watch; it
trades. No real money, no broker connection — TradingView has no public order
API, so all fills are simulated locally.

## Autopilot

Every minute the engine:

1. **Prices queued signals into plans** — entry at the live quote; stop scaled
   to the symbol's 5-day average daily range (clamped 1–6%); target at 1–2×
   the stop distance depending on variant; size risking 1% of equity at the
   stop (halved when VIX ≥ 30), capped at 15% of equity per position.
2. **Enters** long/short signals automatically (max 8 open positions, one per
   symbol, signals fresher than 24h). `watch`-grade signals are suggestions
   only and are never auto-traded.
3. **Exits** on stop hit, target hit, or the rule's time horizon — the regime
   is deliberately **short-term: hours to 2 days**.

Everything it does is written to the activity feed on the Trades page, and the
Pause button stops entries/exits at any time. Paper account starts at $100,000
(delete `data.db` to reset).

## Strategy lab

Each auto trade is tagged with its signal rule **and** an exit-style variant,
assigned sample-balanced so every combination gets tested:

| Variant | Stop | Target | Typical hold |
|---|---|---|---|
| `tight` | 0.6× ADR | 1R | hours |
| `base` | 1.0× ADR | 1.5R | ~1 day |
| `runner` | 1.4× ADR | 2R | 1–2 days |

The **Strategy performance** tab on the Trades page shows win rate, realized
P&L, and profit factor per combination. Sizing adapts to results: a combo
that's net-negative after 5 closed trades runs at half size; after 10 it is
paused (`base` variants drop to quarter-size probes instead of pausing, so a
strategy can earn its way back). Winners keep full size. Over time the book
concentrates in whatever actually works.

## Run it

```
start.cmd
```

(or `C:\Users\colin\tools\node\node.exe server.mjs`) then open <http://localhost:3555>.

To have it start automatically (minimized) at every login, run
`autostart-install.cmd` once (`autostart-remove.cmd` undoes it — edit the
Node path inside if yours differs).

## Monitoring

- **Equity sparkline** on the Account equity tile (snapshotted every 10 min).
- **Strategy performance tab** — win rate / realized P&L / profit factor per
  strategy×variant, plus a combined row for the whole autopilot book.
- **Autopilot activity feed** — every plan, entry, exit, skip, and sizing
  adjustment, with reasons.
- **Export CSV** button on the blotter for analysis elsewhere.
- **Live air & sea layers** (toggles in the map legend):
  - **✈ Aircraft** — worldwide military flights via adsb.lol's open API; zoom
    in (level 5+) and the layer switches to *all* air traffic around your
    viewport, civilian planes in grey, military in violet.
  - **⚓ Ships** — live AIS positions. Works out of the box with Finland's
    open Digitraffic feed (Baltic Sea). For live coverage of the world's
    shipping chokepoints (Hormuz, Suez/Red Sea, Malacca, Panama, Bosporus,
    Taiwan Strait, Gibraltar, Dover), grab a free API key at
    [aisstream.io](https://aisstream.io) and start the server with
    `set AISSTREAM_KEY=your_key` — the map switches automatically.

## Pages

- **Map** (`/`) — Leaflet world map of live unrest, conflict, earthquake, and
  natural-disaster events from the WorldMonitor public API, plus their scored
  news digest and the current signal queue. worldmonitor.app itself refuses
  iframe embedding, so the map renders their API data directly (button in the
  sidebar opens the real site).
- **Trades** (`/trades`) — signal queue → TradingView chart (free embed
  widget) → one-click paper trade ticket → blotter with live unrealized /
  realized P&L (Yahoo Finance quotes, Binance fallback for crypto).

## How signals work (`server.mjs`, `deriveSignals` / `deriveNewsSignals`)

Transparent heuristics, deduped per situation per day, stored in SQLite:

| Rule | Trigger | Idea |
|---|---|---|
| `quake-country-etf` | M≥5.5 quake in a country with a liquid ETF | short-term weakness in the country ETF |
| `oil-producer-unrest` | severe unrest in an oil-producing country | long USO / XLE |
| `chokepoint-disruption` | severe unrest near a shipping chokepoint | long FRO / ZIM / USO |
| `hurricane-energy` | hurricane-strength Atlantic/EP storm | long UNG / USO, watch insurers |
| `global-risk-off` | ≥10 severe unrest events in 24h | long GLD, watch VIXY |
| `headline-risk` | high-threat news, importance ≥55 | watch the story's tickers or sector proxies |
| `chokepoint-transit-drop` | IMF PortWatch daily transits ≥30% below 28-day avg | long shipping/oil per chokepoint |

Edit the rules in `server.mjs` — they are ~80 lines of plain JS and meant to be
tinkered with.

## Data sources

- Events/news: WorldMonitor public endpoints (no key; their middleware requires
  a ≥10-char non-bot User-Agent; limit 600 req/min — we make ~5 per 5 minutes).
  Optional: set `WM_API_KEY` env var to unlock keyed endpoints (paid tiers).
- Quotes: Yahoo Finance v8 chart endpoint (query1 → query2 mirror), Binance for
  `XXX-USD` crypto. Quotes cache for 60s; last-good is served stale if all fail.

## Files

- `server.mjs` — zero-dependency Node 24 server: static hosting, feed
  aggregation + normalization, signal engine, quote proxy, SQLite paper blotter
  (`data.db`, created on first run — delete it to reset the account).
- `public/` — the two pages; no build step, plain ES modules.

**Not financial advice. Paper trading only.**
