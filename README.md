# World Trader — autopilot paper-trading sandbox

An experimental, **local-only, paper-money** trading bot that turns
[worldmonitor.app](https://worldmonitor.app) world-event data into fully
specified trades — entry, stop-loss, profit target, position size, time exit —
and then **opens and manages the simulated positions itself**. You watch; it
trades. No real money, no broker connection — TradingView has no public order
API, so all fills are simulated locally.

The simulation is deliberately **honest**: US market-hours awareness (no
weekend fills at frozen prices), per-symbol spread + slippage on every ETF
fill, real ~10 bps/side Binance taker fees with spread-crossing fills on the
crypto scalper, limit-order semantics for targets, and stale quotes refused
throughout the money path. If a strategy wins here, it earned it.

## Autopilot

Every minute the engine:

1. **Prices queued signals into plans** — entry at the live quote; stop scaled
   to the symbol's 5-day average daily range; target at 1–2× the stop distance
   depending on variant; size risking 1% of equity at the stop (halved when
   VIX ≥ 30, scaled by signal confidence), capped at 15% of equity per position.
2. **Enters** long/short signals automatically (default max 10 open positions —
   configurable in Settings; one per symbol per strategy; signals fresher than
   24h; stocks/ETFs only while the US market is open — off-hours signals queue
   for the next session). `watch`-grade signals are never auto-traded.
3. **Exits** on stop hit, target hit, or the rule's time horizon — the regime
   is deliberately **short-term: hours to 2 days**. Exits are managed even
   while autopilot is paused; pause only stops new entries.

**Portfolio risk controls:** a 2% realized daily-loss **kill switch** halts all
new entries (including the scalper) until the next ET day; gross open notional
is capped at 1× equity; the energy/shipping cluster (USO, XLE, UNG, FRO, ZIM,
WEAT) is capped at 4 concurrent positions so four correlated rules can't stack
the whole book into one long-oil bet.

Everything it does is written to the activity feed on the Trades page. Paper
account starts at $100,000 (delete `data.db` to reset).

## Recursive learning

- The **crypto scalper evolves in generations**: every trade is tagged
  `g<gen>`; after 30 closed trades the engine diagnoses the exit mix (targets /
  stops / fee-bleeding time-outs), mutates its parameters directionally,
  retires the generation with its final record and a narrated lesson, and
  activates the next. Generations wait for open stragglers so every record is
  complete. Test-mode overrides can never contaminate the stored lineage.
- The **slow rules tune daily**: stop and target multipliers adjust from each
  rule's recent closed trades (append-only history in `rule_tuning_history`),
  with honest "holding steady" notes when a multiplier is pinned at a bound.
- Every trade records **MAE/MFE** (max excursion for/against) — the raw
  material for smarter stop tuning.
- Signals the autopilot *didn't* take (dismissed / expired / skipped) are
  scored hourly against what actually happened — the would-have-been P&L shows
  up in the signal History tab.

## Backtesting (`/backtest`)

- **Technical mode** replays `ma-cross`, `rsi-reversal`, and `breakout-20`
  over up to 2 years of daily bars for any symbol list: signal at the close,
  entry at the **next bar's open** (no look-ahead), gap-aware stop fills,
  limit-style target fills, stop-first when both sit inside one bar
  (conservative), live-identical sizing and friction. Each rule runs a $100k
  account; results show P&L, win rate (with n), profit factor, max drawdown,
  costs paid, average hold, an equity curve, and the trade log.
- **Signal replay mode** re-runs every recorded live signal against the bars
  that followed it — young today, more decisive every week the server runs.
- Runs persist to the `backtests` table and are reloadable from the History
  list. Daily bars persist to SQLite (`bars`), and the scalper records minute
  candles (`candles`, 30 days) for future tick-level replay.

## Strategy lab

Each auto trade is tagged with its signal rule **and** an exit-style variant,
assigned sample-balanced so every combination gets tested:

| Variant | Stop | Target | Typical hold |
|---|---|---|---|
| `tight` | 0.6× ADR | 1R | hours |
| `base` | 1.0× ADR | 1.5R | ~1 day |
| `runner` | 1.4× ADR | 2R | 1–2 days |

Sizing adapts to results: a combo that's net-negative after 5 closed trades
runs at half size; after 10 it is paused (`base` variants drop to quarter-size
probes instead, so a strategy can earn its way back).

## Run it

```
start.cmd
```

(starts the server under a watchdog loop that restarts it if it ever dies,
and opens the dashboard) — or run
`C:\Users\colin\tools\node\node.exe server.mjs` directly.

- Binds to **127.0.0.1 only** (the API is unauthenticated). Set
  `HOST=0.0.0.0` if you explicitly want LAN access.
- `autostart-install.cmd` registers a minimized start at every login.
- Tests: `node --test tests/money.test.mjs` (runs the real server against a
  throwaway DB and checks the P&L arithmetic, validation, and settings).

## Monitoring & ops

- **`/api/health`** — uptime, market state, kill-switch, feed errors, active
  scalper generation.
- **Today tile** — realized P&L for the current ET day, plus gross exposure
  and total fees paid.
- **Strategies page** — head-to-head %-return overlay, sortable leaderboard,
  SPY buy-and-hold benchmark line on every detail chart, generation markers on
  the curve, per-strategy daily P&L calendar, learning log.
- **Notifications** — paste a webhook URL (e.g. a free [ntfy.sh](https://ntfy.sh)
  topic) into Settings and get evolution lessons, kill-switch alerts, and a
  daily digest pushed to your phone.
- **Logs & backups** — rotating `logs/server.log`; nightly WAL checkpoint and
  DB backup to `backups/` (14 kept); equity snapshots are kept forever.
- Sleep/downtime is detected on wake: the gap is logged and time exits defer
  briefly so they fill on fresh quotes rather than pre-sleep marks.
- **Export** — trade blotter CSV, or the full dataset via `/api/export.json`.

## Pages

- **Map** (`/`) — Leaflet world map of live unrest, conflict, earthquake, and
  natural-disaster events, chokepoints with IMF PortWatch transit stats,
  military/civilian aircraft, live AIS ships, and signal ambience (glows and
  arcs are clickable → the signal and its trades). Event popups answer *"what
  did the engine do about this?"* with the linked signal and trades. Layer
  toggles and the event time-window (6h–7d) persist.
- **Trades** (`/trades`) — signal queue (+ History with undo and
  would-have-been outcomes) → TradingView chart with an open-position overlay →
  ticket with notional preview → blotter with filter/sort → live fill tape.
  Keyboard: `/` focus symbol, `t` ticket, `1/2/3` tabs.
- **Strategies** (`/strategies`) — every rule as its own virtual $100k account,
  grouped by family, with the comparison tools listed above.
- **Backtest** (`/backtest`) — the time machine.

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

A second, purely **technical family** (the control group) scans 12 liquid ETFs
hourly on daily bars:

| Rule | Trigger | Idea |
|---|---|---|
| `ma-cross` | fresh 5-day/20-day EMA cross | short-term trend following |
| `rsi-reversal` | RSI(2) < 10 or > 90 | 1–2 session mean reversion |
| `breakout-20` | close beyond prior 20-day high/low | range-expansion follow-through |

A third, **day-trading family** works intraday on delayed 5-minute bars
(SPY, QQQ, IWM, AAPL, NVDA, TSLA — always flat before the session ends):

| Rule | Trigger | Idea |
|---|---|---|
| `orb-15min` | break of the first 15 minutes' high/low | opening-range breakout, stop at range midpoint, 1.5× range target |
| `gap-fade` | opened 0.4–3% from yesterday's close, still stretched | moderate gaps tend to fill — target the prior close |
| `vwap-revert` | price stretched from session VWAP (volatility-scaled) | fade back to the institutional anchor |
| `fx-session` | break of London's first-hour range on EUR/GBP/AUD vs USD | session momentum on a non-US market, flat before NY lunch |

And the **hyperactive family**: `momo-scalper`, a 24/7 crypto momentum scalper
on real-time Binance prices whose parameters evolve in generations under real
taker costs.

Edit the rules in `server.mjs` — they are plain JS and meant to be tinkered with.

## Data sources

- Events/news: WorldMonitor public endpoints (no key; their middleware requires
  a ≥10-char non-bot User-Agent; limit 600 req/min — we make ~5 per 5 minutes).
  Optional `WM_API_KEY` unlocks keyed endpoints.
- Quotes: Yahoo Finance v8 chart endpoint (query1 → query2 mirror), Binance
  websocket + REST for `XXX-USD` crypto. Quotes cache for 60s; stale quotes are
  never traded on.
- Chokepoint transits: IMF PortWatch open ArcGIS API. Ships: aisstream.io
  (free key, Settings) or Finland's open Digitraffic feed. Aircraft: adsb.lol.

## Files

- `server.mjs` — zero-dependency Node 24 server: static hosting, feed
  aggregation, signal engine, autopilot, scalper, evolution engine, backtester,
  quote proxy, SQLite persistence (`data.db` — delete to reset).
- `public/` — four pages; no build step, plain ES modules.
- `tests/` — money-path regression suite (`node --test`).

**Not financial advice. Paper trading only.**
