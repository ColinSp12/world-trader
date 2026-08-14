// world-trader — local paper-trading sandbox driven by WorldMonitor event data.
// Zero npm dependencies: node:http + node:sqlite (Node 24+). NO REAL MONEY.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = import.meta.dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3555);
const WM_BASE = 'https://api.worldmonitor.app';
let wmKey = process.env.WM_API_KEY || ''; // may be overridden from the settings table after db init
const UA = 'world-trader/0.1 (local paper-trading experiment)';
const EVENT_REFRESH_MS = 5 * 60 * 1000;
const QUOTE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(ROOT, 'data.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('long','short')),
    qty REAL NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    stop_price REAL,
    target_price REAL,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    auto INTEGER NOT NULL DEFAULT 0,
    signal_id TEXT,
    thesis TEXT,
    exit_reason TEXT,
    strategy TEXT,
    variant TEXT
  );
  CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    rule TEXT NOT NULL,
    headline TEXT NOT NULL,
    thesis TEXT NOT NULL,
    direction TEXT NOT NULL,
    symbols TEXT NOT NULL,
    tv_symbol TEXT NOT NULL,
    confidence TEXT NOT NULL,
    event_json TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    plan_entry REAL,
    plan_stop REAL,
    plan_target REAL,
    plan_qty REAL,
    horizon_days REAL
  );
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS equity_snapshots (ts INTEGER PRIMARY KEY, equity REAL NOT NULL);
`);

// Migrate databases created before the strategy columns existed.
for (const col of ['strategy TEXT', 'variant TEXT']) {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch { /* column already exists */ }
}
db.prepare(`UPDATE trades SET
  strategy = COALESCE(strategy, (SELECT rule FROM signals WHERE signals.id = trades.signal_id), 'manual'),
  variant = COALESCE(variant, 'base')`).run();

const STARTING_EQUITY = 100000;

function getSetting(k, dflt) {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return row ? row.v : dflt;
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
wmKey = getSetting('wm_api_key', wmKey);

function logActivity(kind, message) {
  db.prepare('INSERT INTO activity (ts, kind, message) VALUES (?, ?, ?)').run(Date.now(), kind, message);
  db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 500)').run();
  console.log(`[${kind}] ${message}`);
}

// ---------------------------------------------------------------- helpers
function json(res, status, body) {
  const buf = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...extraHeaders },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

function wmHeaders() {
  return wmKey ? { 'X-API-Key': wmKey } : {};
}

// ---------------------------------------------------------------- events
// Normalized event: { id, kind, title, detail, lat, lon, ts, severity 0-3, country, url }
const eventCache = { events: [], fetchedAt: 0, errors: [] };

function quakeSeverity(mag) {
  if (mag >= 6.5) return 3;
  if (mag >= 5.5) return 2;
  return 1;
}

function unrestSeverity(s, fatalities) {
  const base = { SEVERITY_LEVEL_CRITICAL: 3, SEVERITY_LEVEL_HIGH: 2, SEVERITY_LEVEL_MEDIUM: 1, SEVERITY_LEVEL_MODERATE: 1 }[s] ?? 0;
  return fatalities > 0 ? Math.min(3, base + 1) : base;
}

function stormSeverity(e) {
  if (e.category === 'severeStorms') {
    const wind = e.windKt || e.magnitude || 0;
    if (wind >= 96) return 3;
    if (wind >= 64) return 2;
    return 1;
  }
  if (e.category === 'volcanoes') return 2;
  return 1;
}

async function refreshEvents() {
  const errors = [];
  const events = [];

  const jobs = [
    ['unrest', `${WM_BASE}/api/unrest/v1/list-unrest-events`, (data) => {
      for (const e of data.events || []) {
        events.push({
          id: `unrest:${e.id}`, kind: 'unrest',
          title: e.title || 'Unrest event',
          detail: [e.eventType?.replace('UNREST_EVENT_TYPE_', ''), e.fatalities ? `${e.fatalities} fatalities` : null].filter(Boolean).join(' · '),
          lat: e.location?.latitude, lon: e.location?.longitude,
          ts: e.occurredAt, severity: unrestSeverity(e.severity, e.fatalities),
          country: e.country || '', url: (e.sourceUrls || [])[0] || '',
        });
      }
    }],
    ['quakes', `${WM_BASE}/api/seismology/v1/list-earthquakes`, (data) => {
      for (const e of data.earthquakes || []) {
        events.push({
          id: `quake:${e.id}`, kind: 'quake',
          title: `M${e.magnitude} — ${e.place}`,
          detail: `depth ${Math.round(e.depthKm)} km`,
          lat: e.location?.latitude, lon: e.location?.longitude,
          ts: e.occurredAt, severity: quakeSeverity(e.magnitude),
          country: countryFromPlace(e.place), url: e.sourceUrl || '', magnitude: e.magnitude,
        });
      }
    }],
    ['natural', `${WM_BASE}/api/natural/v1/list-natural-events`, (data) => {
      for (const e of data.events || []) {
        if (e.closed) continue;
        events.push({
          id: `natural:${e.id}`, kind: 'natural',
          title: e.title || e.categoryTitle || 'Natural event',
          detail: e.description || e.categoryTitle || '',
          lat: e.lat, lon: e.lon,
          ts: e.date, severity: stormSeverity(e),
          country: '', url: e.sourceUrl || '',
          category: e.category, basin: e.basin, windKt: e.windKt, stormCategory: e.stormCategory,
        });
      }
    }],
    // ACLED returns [] without an explicit start/end window (epoch ms).
    ['conflict', `${WM_BASE}/api/conflict/v1/list-acled-events?start=${Date.now() - 48 * 3600 * 1000}&end=${Date.now()}&page_size=500`, (data) => {
      for (const e of data.events || []) {
        events.push({
          id: `conflict:${e.id}`, kind: 'conflict',
          title: e.title || e.eventType || 'Conflict event',
          detail: e.summary || '',
          lat: e.location?.latitude, lon: e.location?.longitude,
          ts: e.occurredAt, severity: unrestSeverity(e.severity, e.fatalities),
          country: e.country || '', url: (e.sourceUrls || [])[0] || '',
        });
      }
    }],
  ];

  const JOB_KINDS = { unrest: ['unrest'], quakes: ['quake'], natural: ['natural'], conflict: ['conflict'] };
  const failedKinds = new Set();
  await Promise.all(jobs.map(async ([name, url, handle]) => {
    try {
      handle(await fetchJson(url, wmHeaders()));
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      for (const k of JOB_KINDS[name] || []) failedKinds.add(k);
    }
  }));

  let news = [];
  try { news = await refreshNews(); } catch (err) { errors.push(`news: ${err.message}`); }

  const valid = events.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon) && e.ts);
  // Retain last-known-good events for any feed that failed this cycle, so a
  // transient outage doesn't present as a quiet world.
  for (const old of eventCache.events) {
    if (failedKinds.has(old.kind)) valid.push(old);
  }
  valid.sort((a, b) => b.ts - a.ts);
  eventCache.events = valid;
  eventCache.fetchedAt = Date.now();
  eventCache.errors = errors;
  try { deriveSignals(valid); } catch (err) { errors.push(`signals: ${err.message}`); }
  try { deriveNewsSignals(news); } catch (err) { errors.push(`news-signals: ${err.message}`); }
  console.log(`[events] ${valid.length} events, ${news.length} news items (${errors.length ? 'errors: ' + errors.join('; ') : 'ok'})`);
}

// ---------------------------------------------------------------- news digest
// Free WorldMonitor news feed. The public=1 query shape must match exactly.
const NEWS_URL = 'https://worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1';
const newsCache = { items: [], fetchedAt: 0 };

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function refreshNews() {
  const data = await fetchJson(NEWS_URL);
  const items = [];
  for (const [category, group] of Object.entries(data.categories || {})) {
    for (const n of group.items || []) {
      items.push({
        id: `news:${hashId(n.link || n.title || '')}`,
        category,
        source: n.source || '',
        title: n.title || '',
        url: n.link || '',
        ts: n.publishedAt || 0,
        importance: n.importanceScore || 0,
        isAlert: Boolean(n.isAlert),
        threatLevel: (n.threat?.level || '').replace('THREAT_LEVEL_', ''),
        threatCategory: n.threat?.category || '',
        mentions: n.storyMeta?.mentionCount || 0,
        phase: (n.storyMeta?.phase || '').replace('STORY_PHASE_', ''),
        snippet: (n.snippet || '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
        tickers: Array.isArray(n.tickers) ? n.tickers.slice(0, 6) : [],
      });
    }
  }
  items.sort((a, b) => (b.importance - a.importance) || (b.ts - a.ts));
  newsCache.items = items;
  newsCache.fetchedAt = Date.now();
  return items;
}

// Sector proxies when a threatening headline names no tickers itself.
const THREAT_SECTOR = {
  military: ['ITA', 'LMT'], energy: ['XLE', 'USO'], cyber: ['BUG', 'PANW'],
  economy: ['SPY', 'GLD'], nuclear: ['URA', 'GLD'],
};

function deriveNewsSignals(items) {
  const now = Date.now();
  let made = 0;
  for (const n of items) {
    if (made >= 5) break;
    if (!n.ts || now - n.ts > 36 * 3600 * 1000) continue;
    const severe = ['HIGH', 'SEVERE', 'CRITICAL'].includes(n.threatLevel);
    if (!severe || n.importance < 55) continue;
    const symbols = n.tickers.length ? n.tickers.slice(0, 4) : THREAT_SECTOR[n.threatCategory];
    if (!symbols?.length) continue;
    // One headline-risk suggestion per symbol per day — related stories about
    // the same situation otherwise fill the queue with near-duplicates.
    const dupe = db.prepare("SELECT COUNT(*) AS c FROM signals WHERE rule = 'headline-risk' AND tv_symbol = ? AND created_at > ?")
      .get(symbols[0], now - 24 * 3600 * 1000).c;
    if (dupe) continue;
    const info = makeSignal({
      id: n.id, rule: 'headline-risk',
      headline: `Headline risk — ${n.title.slice(0, 90)}`,
      thesis: `${n.snippet || n.title} (${n.source}; threat: ${n.threatCategory || 'general'} ${n.threatLevel.toLowerCase()}, importance ${n.importance}, ${n.mentions} mentions). Watch ${symbols.join(', ')} for a reaction.`,
      direction: 'watch', symbols, tvSymbol: symbols[0],
      confidence: n.importance >= 70 ? 'medium' : 'low',
      event: { title: n.title, url: n.url, kind: 'news' },
    });
    // INSERT OR IGNORE: only count rows actually inserted, or already-seen
    // headlines burn the whole per-refresh budget and starve new ones.
    if (Number(info.changes) > 0) made++;
  }
}

function countryFromPlace(place) {
  if (!place) return '';
  const tail = place.split(',').pop().trim();
  return tail;
}

// ---------------------------------------------------------------- signal engine
// Transparent heuristics mapping world events to liquid, TradingView-chartable
// instruments. These are EXPERIMENTAL hypotheses for paper trading, not advice.
const COUNTRY_ETF = {
  Japan: 'EWJ', China: 'FXI', Taiwan: 'EWT', 'South Korea': 'EWY', India: 'INDA',
  Brazil: 'EWZ', Mexico: 'EWW', Germany: 'EWG', 'United Kingdom': 'EWU', UK: 'EWU',
  France: 'EWQ', Italy: 'EWI', Spain: 'EWP', Turkey: 'TUR', Israel: 'EIS',
  'Saudi Arabia': 'KSA', 'South Africa': 'EZA', Chile: 'ECH', Indonesia: 'EIDO',
  Philippines: 'EPHE', Vietnam: 'VNM', Poland: 'EPOL', Nigeria: 'NGE',
  Argentina: 'ARGT', Australia: 'EWA', Canada: 'EWC', Greece: 'GREK', Egypt: 'EGPT',
  Pakistan: 'PAK', Thailand: 'THD', Malaysia: 'EWM', Peru: 'EPU', Colombia: 'GXG',
};
const OIL_COUNTRIES = new Set([
  'Iraq', 'Iran', 'Saudi Arabia', 'Libya', 'Nigeria', 'Venezuela', 'Russia',
  'Kuwait', 'United Arab Emirates', 'Algeria', 'Azerbaijan', 'Kazakhstan', 'Qatar', 'Oman',
]);
const CHOKEPOINT_RE = /red sea|suez|hormuz|bab[- ]el[- ]mandeb|yemen|panama canal|strait of|bosporus|bosphorus|malacca/i;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function makeSignal(sig) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO signals
    (id, created_at, rule, headline, thesis, direction, symbols, tv_symbol, confidence, event_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return stmt.run(sig.id, Date.now(), sig.rule, sig.headline, sig.thesis, sig.direction,
    JSON.stringify(sig.symbols), sig.tvSymbol, sig.confidence, JSON.stringify(sig.event || null));
}

function deriveSignals(events) {
  const now = Date.now();
  const recent = events.filter((e) => now - e.ts < 48 * 3600 * 1000);

  for (const e of recent) {
    // Rule 1: significant earthquake in a country with a liquid single-country ETF.
    if (e.kind === 'quake' && e.severity >= 2) {
      const etf = COUNTRY_ETF[e.country];
      if (etf) {
        makeSignal({
          id: `quake-etf:${e.id}`, rule: 'quake-country-etf',
          headline: `M${e.magnitude} earthquake — ${e.country}`,
          thesis: `Major earthquake (${e.title}). Historically large quakes pressure the local equity market short-term; insurers and local industrials most exposed. Hypothesis: short-term weakness in ${etf}.`,
          direction: 'short', symbols: [etf, 'GLD'], tvSymbol: etf,
          confidence: e.severity === 3 ? 'medium' : 'low', event: e,
        });
      }
    }
    // Rule 2: high-severity unrest/conflict in an oil-producing country.
    // Deduped by country+day, not event id — GDELT re-buckets the same situation
    // every 30 minutes under a fresh id, which would otherwise spam signals.
    if ((e.kind === 'unrest' || e.kind === 'conflict') && e.severity >= 2 && OIL_COUNTRIES.has(e.country)) {
      makeSignal({
        id: `oil-unrest:${e.country}:${dayKey(e.ts)}`, rule: 'oil-producer-unrest',
        headline: `Unrest in oil producer — ${e.country}`,
        thesis: `${e.title}. Supply-disruption risk in a major oil producer tends to lift crude and energy equities. Hypothesis: long USO / XLE while the situation is live.`,
        direction: 'long', symbols: ['USO', 'XLE', 'ITA'], tvSymbol: 'USO',
        confidence: e.severity === 3 ? 'high' : 'medium', event: e,
      });
    }
    // Rule 3: unrest near a shipping chokepoint.
    if ((e.kind === 'unrest' || e.kind === 'conflict') && e.severity >= 2 && CHOKEPOINT_RE.test(`${e.title} ${e.country} ${e.detail}`)) {
      makeSignal({
        id: `chokepoint:${(e.country || e.title).toLowerCase().slice(0, 24)}:${dayKey(e.ts)}`, rule: 'chokepoint-disruption',
        headline: `Chokepoint risk — ${e.title}`,
        thesis: `${e.title}. Disruption near a maritime chokepoint raises freight rates and crude. Hypothesis: long tankers/shipping (FRO, ZIM) and crude (USO).`,
        direction: 'long', symbols: ['FRO', 'ZIM', 'USO'], tvSymbol: 'FRO',
        confidence: 'medium', event: e,
      });
    }
    // Rule 4: hurricane-strength Atlantic storm (US energy/insurance exposure).
    if (e.kind === 'natural' && e.category === 'severeStorms' && (e.windKt || 0) >= 64 && (e.basin === 'AL' || e.basin === 'EP')) {
      makeSignal({
        id: `hurricane:${e.id}`, rule: 'hurricane-energy',
        headline: `Hurricane-strength storm — ${e.title}`,
        thesis: `${e.detail}. Gulf/Atlantic hurricanes threaten offshore production and refining, and pressure insurers. Hypothesis: long natural gas (UNG) / crude (USO); watch insurers (TRV) short.`,
        direction: 'long', symbols: ['UNG', 'USO', 'TRV'], tvSymbol: 'UNG',
        confidence: (e.windKt || 0) >= 96 ? 'high' : 'medium', event: e,
      });
    }
  }

  // Rule 5: global risk-off — a spike of severe unrest events in the last 24h.
  const severe24 = recent.filter((e) => (e.kind === 'unrest' || e.kind === 'conflict') && e.severity >= 2 && now - e.ts < 24 * 3600 * 1000);
  if (severe24.length >= 10) {
    makeSignal({
      id: `riskoff:${dayKey(now)}`, rule: 'global-risk-off',
      headline: `Global unrest spike — ${severe24.length} severe events in 24h`,
      thesis: `${severe24.length} high-severity unrest/conflict events in the last 24 hours (hotspots: ${[...new Set(severe24.map((e) => e.country).filter(Boolean))].slice(0, 5).join(', ')}). Broad risk-off hypothesis: long gold (GLD), watch volatility (VIXY).`,
      direction: 'long', symbols: ['GLD', 'VIXY'], tvSymbol: 'GLD',
      confidence: 'low', event: null,
    });
  }
}

// ---------------------------------------------------------------- quotes
// Primary: Yahoo Finance v8 chart (no key needed). Fallbacks: query2 mirror,
// Binance for crypto pairs, then last-known-good cache served stale.
// (Stooq's no-key CSV API is dead to server-side clients as of Aug 2026.)
const quoteCache = new Map(); // symbol -> { price, prevClose, ts, source }

async function yahooQuote(symbol, host = 'query1') {
  const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const data = await fetchJson(url, { Accept: 'application/json' });
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice)) throw new Error('no price in yahoo response');
  // Average daily range (as a fraction of close) over the last 5 sessions —
  // used to place volatility-scaled stops and targets.
  let adrPct = null;
  const q0 = data.chart.result[0].indicators?.quote?.[0];
  if (q0?.high && q0?.low && q0?.close) {
    const ranges = [];
    for (let i = 0; i < q0.close.length; i++) {
      if (Number.isFinite(q0.high[i]) && Number.isFinite(q0.low[i]) && Number.isFinite(q0.close[i]) && q0.close[i] > 0) {
        ranges.push((q0.high[i] - q0.low[i]) / q0.close[i]);
      }
    }
    if (ranges.length) adrPct = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  }
  return { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null, adrPct, source: `yahoo:${host}` };
}

async function binanceQuote(symbol) {
  const pair = symbol.endsWith('-USD') ? symbol.replace('-USD', 'USDT') : null;
  if (!pair) throw new Error('not a crypto symbol');
  const data = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`);
  const price = parseFloat(data.price);
  if (!Number.isFinite(price)) throw new Error('binance no price');
  return { price, prevClose: null, source: 'binance' };
}

async function getQuote(symbol) {
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) return cached;
  let q = null;
  for (const attempt of [() => yahooQuote(symbol, 'query1'), () => yahooQuote(symbol, 'query2'), () => binanceQuote(symbol)]) {
    try { q = await attempt(); break; } catch { /* try next source */ }
  }
  if (!q) {
    if (cached) return { ...cached, stale: true };
    throw new Error(`no quote available for ${symbol}`);
  }
  const entry = { ...q, ts: Date.now() };
  quoteCache.set(symbol, entry);
  return entry;
}

async function getQuotes(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    try { out[s] = await getQuote(s); } catch (err) { out[s] = { error: err.message }; }
  }));
  return out;
}

// ---------------------------------------------------------------- trades
function tradePnl(t, price) {
  const dir = t.side === 'long' ? 1 : -1;
  const mark = t.status === 'closed' ? t.exit_price : price;
  if (!Number.isFinite(mark)) return null;
  return (mark - t.entry_price) * t.qty * dir;
}

function realizedTotal() {
  const closed = db.prepare("SELECT * FROM trades WHERE status = 'closed'").all();
  return closed.reduce((s, t) => s + (tradePnl(t) ?? 0), 0);
}

function closeTrade(t, exitPrice, reason) {
  // Guarded + idempotent: concurrent closers (manual close vs the 500ms
  // scalper tick vs the manage loop) race across awaits — only one wins.
  const info = db.prepare("UPDATE trades SET status = 'closed', closed_at = ?, exit_price = ?, exit_reason = ? WHERE id = ? AND status = 'open'")
    .run(Date.now(), exitPrice, reason, t.id);
  if (Number(info.changes) === 0) return null; // already closed elsewhere
  const pnl = tradePnl({ ...t, status: 'closed', exit_price: exitPrice });
  // Scalper fills log as 'scalp' so the toast layer (open/close only) stays quiet.
  logActivity(t.strategy === SCALP_RULE ? 'scalp' : 'close',
    `Closed ${t.side} ${t.qty} ${t.symbol} @ ${exitPrice.toFixed(2)} — ${reason} (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)})`);
  broadcast('fill', { action: 'close', symbol: t.symbol });
  return pnl;
}

// Human-readable identity for each strategy, shown on the Strategies page.
// family: 'event' = driven by world data; 'tech' = classic price-action rules.
const STRATEGY_META = {
  'oil-producer-unrest': { family: 'event', title: 'Oil Producer Unrest', desc: 'Severe unrest or conflict inside a major oil-producing country → long crude and energy equities (USO, XLE). Bets on a supply-disruption risk premium appearing while the situation is live.' },
  'chokepoint-disruption': { family: 'event', title: 'Chokepoint Unrest', desc: 'Severe unrest near a maritime chokepoint (Red Sea, Hormuz, Suez, Panama…) → long tankers/shipping and crude (FRO, ZIM, USO). Disruption raises freight rates and oil.' },
  'chokepoint-transit-drop': { family: 'event', title: 'Transit Drop (PortWatch)', desc: 'IMF PortWatch daily transit counts fall ≥30% below the 28-day average at a major chokepoint → long the mapped shipping/oil names. Counts actual ships, not headlines — the most objective rule in the book.' },
  'quake-country-etf': { family: 'event', title: 'Earthquake Fade', desc: 'M5.5+ earthquake in a country with a liquid single-country ETF → short that ETF for about a day. Bets on short-term local risk-off pressure.' },
  'hurricane-energy': { family: 'event', title: 'Hurricane Energy', desc: 'Hurricane-strength Atlantic/East-Pacific storm → long natural gas and crude (UNG, USO). Bets on Gulf production and refining threats.' },
  'global-risk-off': { family: 'event', title: 'Global Risk-Off', desc: 'Ten or more severe unrest events worldwide within 24 hours → long gold (GLD), watch volatility. A broad fear hedge for days when the whole map lights up.' },
  'headline-risk': { family: 'event', title: 'Headline Risk', desc: 'High-threat news with importance ≥55 → watch-grade suggestions on the story’s tickers or sector proxies. Never auto-traded; informational only.' },
  'ma-cross': { family: 'tech', title: 'EMA 5/20 Momentum', desc: 'The 5-day EMA crossing the 20-day EMA on a liquid ETF → trade in the direction of the cross. Classic short-term trend following: ride fresh momentum shifts for a day or two.' },
  'rsi-reversal': { family: 'tech', title: 'RSI(2) Mean Reversion', desc: '2-period RSI under 10 → long the snap-back; over 90 → short. Connors-style: extreme short-term readings on index/sector ETFs tend to revert within 1–2 sessions.' },
  'breakout-20': { family: 'tech', title: '20-Day Breakout', desc: 'Close beyond the prior 20-day high or low (Donchian channel) → trade the direction of the break. Range expansion tends to carry short-term follow-through.' },
  'momo-scalper': { family: 'hyper', title: '1-Minute Momentum Scalper', desc: '24/7 crypto scalper on real-time Binance prices (BTC, ETH, SOL, XRP, DOGE, LTC): enters when 1-minute momentum exceeds ~6 bps, exits at +12 bps target / −9 bps stop / 5-minute time-out, $5k notional per position. A 2 bps per-side fee is baked into every fill — the honest scalping question is whether the edge beats costs. Executes dozens to hundreds of round trips a day.' },
};

// ---------------------------------------------------------------- autopilot
// The engine does the trading: it prices every queued signal into a full plan
// (entry, volatility-scaled stop, 2R target, risk-based size, time exit), then
// opens and manages the paper positions itself. PAPER MONEY ONLY.
let autopilotOn = getSetting('autopilot', '1') === '1';
const MAX_OPEN_POSITIONS = 10; // event+tech book (scalper positions tracked separately)
const SCALP_RULE = 'momo-scalper';
const RISK_PER_TRADE = 0.01;         // 1% of equity at the stop
const MAX_POSITION_FRACTION = 0.15;  // notional cap per position
// Short-term regime: horizons of hours to 2 days, targets sized to be
// reachable within that window (≤ ~3× a day's range).
const RULE_HORIZON_DAYS = {
  'quake-country-etf': 1, 'oil-producer-unrest': 2, 'chokepoint-disruption': 2,
  'hurricane-energy': 1.5, 'global-risk-off': 2, 'headline-risk': 1,
  'chokepoint-transit-drop': 2,
  'ma-cross': 2, 'rsi-reversal': 1, 'breakout-20': 2,
};

// Exit-style variants — each auto trade is tagged (strategy rule × variant) so
// performance can be compared per combination and sizing adapted over time.
// tight ≈ hours, base ≈ a day, runner ≈ 1–2 days.
const STRATEGY_VARIANTS = {
  tight:  { stopAdr: 0.6, targetR: 1.0, horizonMult: 0.3 },
  base:   { stopAdr: 1.0, targetR: 1.5, horizonMult: 0.6 },
  runner: { stopAdr: 1.4, targetR: 2.0, horizonMult: 1.0 },
};

async function buildPlan(direction, rule, symbol, v = STRATEGY_VARIANTS.base, sizeFactor = 1) {
  const q = await getQuote(symbol);
  const adr = Math.min(Math.max(q.adrPct ?? 0.02, 0.008), 0.06);
  const entry = q.price;
  const stopDist = entry * Math.min(Math.max(v.stopAdr * adr, 0.01), 0.06);
  const dir = direction === 'short' ? -1 : 1; // 'watch' plans as a long suggestion
  const stop = entry - dir * stopDist;
  const target = entry + dir * v.targetR * stopDist;
  const horizon = (RULE_HORIZON_DAYS[rule] ?? 4) * v.horizonMult;

  const equity = STARTING_EQUITY + realizedTotal();
  let riskFrac = RISK_PER_TRADE;
  try {
    const vix = await getQuote('^VIX');
    if (vix.price >= 30) riskFrac = RISK_PER_TRADE / 2; // defensive sizing in panicky tape
  } catch { /* VIX unavailable — keep normal sizing */ }
  let qty = Math.floor((equity * riskFrac * sizeFactor) / stopDist);
  if (qty * entry > equity * MAX_POSITION_FRACTION) qty = Math.floor((equity * MAX_POSITION_FRACTION) / entry);
  qty = Math.max(qty, 1);
  return { entry, stop, target, qty, horizon };
}

async function planSignal(row) {
  const plan = await buildPlan(row.direction, row.rule, row.tv_symbol);
  db.prepare('UPDATE signals SET plan_entry = ?, plan_stop = ?, plan_target = ?, plan_qty = ?, horizon_days = ? WHERE id = ?')
    .run(plan.entry, plan.stop, plan.target, plan.qty, plan.horizon, row.id);
  return plan;
}

// ---- strategy scorecard: sample-balanced variant picking + adaptive sizing ----
const AUTO_PNL_SQL = `(exit_price - entry_price) * (CASE side WHEN 'long' THEN 1 ELSE -1 END) * qty`;

// Least-sampled variant that is still allowed to trade (factor > 0). A paused
// variant must be excluded here, not just at entry: its count freezes at the
// minimum, so a pause-blind pick would select it forever and deadlock the
// whole rule. base is always eligible (0.25 probe floor), so a rule can never
// have every variant paused.
function pickVariant(rule) {
  let best = null;
  for (const name of Object.keys(STRATEGY_VARIANTS)) {
    const adj = sizeAdjustment(rule, name);
    if (adj.factor === 0) continue;
    const c = db.prepare('SELECT COUNT(*) AS c FROM trades WHERE auto = 1 AND strategy = ? AND variant = ?').get(rule, name).c;
    if (!best || c < best.c) best = { name, c, adj };
  }
  return best;
}

// Losing combos get sized down after 5 closed trades and paused after 10;
// the base variant is never fully paused (quarter-size probe) so a strategy
// can still earn its way back. Winners keep full size.
function sizeAdjustment(rule, variant) {
  const s = db.prepare(`SELECT COUNT(*) AS closed, COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl
    FROM trades WHERE status = 'closed' AND auto = 1 AND strategy = ? AND variant = ?`).get(rule, variant);
  if (s.closed >= 10 && s.pnl < 0) {
    return variant === 'base'
      ? { factor: 0.25, why: `${rule}/base negative after ${s.closed} closed — probing at quarter size` }
      : { factor: 0, why: `${rule}/${variant} paused — negative P&L after ${s.closed} closed trades` };
  }
  if (s.closed >= 5 && s.pnl < 0) return { factor: 0.5, why: `${rule}/${variant} negative after ${s.closed} closed — half size` };
  return { factor: 1, why: null };
}

let autopilotRunning = false;
async function autopilotTick() {
  if (autopilotRunning) return; // quote fetches can outlast the interval
  autopilotRunning = true;
  try {
    const now = Date.now();
    db.prepare("UPDATE signals SET status = 'expired' WHERE status = 'new' AND created_at < ?").run(now - 48 * 3600 * 1000);

    // 1. Price every unplanned queued signal into a concrete plan.
    const unplanned = db.prepare("SELECT * FROM signals WHERE status = 'new' AND plan_entry IS NULL ORDER BY created_at DESC LIMIT 10").all();
    for (const s of unplanned) {
      try {
        const plan = await planSignal(s);
        logActivity('plan', `Planned ${s.direction} ${s.tv_symbol}: entry ${plan.entry.toFixed(2)}, stop ${plan.stop.toFixed(2)}, target ${plan.target.toFixed(2)}, qty ${plan.qty} (${s.rule})`);
      } catch (err) {
        logActivity('info', `Could not plan ${s.tv_symbol}: ${err.message}`);
      }
    }

    if (autopilotOn) {
      // 2. Enter: take planned long/short signals (watch = info only).
      const actionable = db.prepare(`SELECT * FROM signals WHERE status = 'new' AND plan_entry IS NOT NULL
        AND direction IN ('long','short') AND created_at > ? ORDER BY created_at DESC`).all(now - 24 * 3600 * 1000);
      for (const s of actionable) {
        const openCount = db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'open' AND COALESCE(strategy, '') != ?").get(SCALP_RULE).c;
        if (openCount >= MAX_OPEN_POSITIONS) { logActivity('skip', `Max ${MAX_OPEN_POSITIONS} open positions — ${s.tv_symbol} stays queued`); break; }
        // One position per symbol PER STRATEGY: each strategy runs its own
        // virtual account, so e.g. breakout can be long SPY while RSI is
        // short SPY — the accounts page compares them honestly.
        const dupe = db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'open' AND symbol = ? AND strategy = ?").get(s.tv_symbol, s.rule).c;
        if (dupe) {
          db.prepare("UPDATE signals SET status = 'skipped' WHERE id = ?").run(s.id);
          logActivity('skip', `${s.rule} already holds ${s.tv_symbol} — skipped duplicate signal`);
          continue;
        }
        try {
          const pick = pickVariant(s.rule);
          if (!pick) { // defensive — base always has factor > 0
            db.prepare("UPDATE signals SET status = 'skipped' WHERE id = ?").run(s.id);
            logActivity('skip', `All ${s.rule} variants paused — ${s.tv_symbol} not traded`);
            continue;
          }
          const { name: variant, adj } = pick;
          if (adj.why) logActivity('info', adj.why);
          const plan = await buildPlan(s.direction, s.rule, s.tv_symbol, STRATEGY_VARIANTS[variant], adj.factor);
          // Write the executed plan back so the signal card and history show
          // the trade the autopilot actually took, not the baseline sketch.
          db.prepare('UPDATE signals SET plan_entry = ?, plan_stop = ?, plan_target = ?, plan_qty = ?, horizon_days = ? WHERE id = ?')
            .run(plan.entry, plan.stop, plan.target, plan.qty, plan.horizon, s.id);
          db.prepare(`INSERT INTO trades (opened_at, symbol, side, qty, entry_price, stop_price, target_price, expires_at, auto, signal_id, thesis, strategy, variant)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(now, s.tv_symbol, s.direction, plan.qty, plan.entry, plan.stop, plan.target,
              now + plan.horizon * 24 * 3600 * 1000, s.id, s.headline, s.rule, variant);
          db.prepare("UPDATE signals SET status = 'taken' WHERE id = ?").run(s.id);
          logActivity('open', `AUTO opened ${s.direction} ${plan.qty} ${s.tv_symbol} @ ${plan.entry.toFixed(2)} · stop ${plan.stop.toFixed(2)} · target ${plan.target.toFixed(2)} · ${s.rule}/${variant} · exit by ${new Date(now + plan.horizon * 86400000).toISOString().slice(0, 10)} — ${s.headline}`);
          broadcast('fill', { action: 'open', symbol: s.tv_symbol });
        } catch (err) {
          logActivity('info', `Entry failed for ${s.tv_symbol}: ${err.message}`);
        }
      }

      // 3. Manage: stop / target / time exits on open positions.
      // The scalper manages its own book on real-time prices — excluded here.
      // COALESCE: NULL-strategy rows must NOT be excluded (SQLite 3VL trap).
      const open = db.prepare("SELECT * FROM trades WHERE status = 'open' AND COALESCE(strategy, '') != ?").all(SCALP_RULE);
      if (open.length) {
        const quotes = await getQuotes([...new Set(open.map((t) => t.symbol))]);
        for (const t of open) {
          const q = quotes[t.symbol];
          if (!Number.isFinite(q?.price)) continue;
          const dir = t.side === 'long' ? 1 : -1;
          let reason = null;
          if (Number.isFinite(t.stop_price) && (q.price - t.stop_price) * dir <= 0) reason = 'stop hit';
          else if (Number.isFinite(t.target_price) && (q.price - t.target_price) * dir >= 0) reason = 'target hit';
          else if (t.expires_at && now >= t.expires_at) reason = 'time exit';
          if (reason) closeTrade(t, q.price, reason);
        }
      }
    }
    await snapshotEquity();
  } catch (err) {
    console.error('[autopilot] tick failed:', err.message);
  } finally {
    autopilotRunning = false;
  }
}

// ---------------------------------------------------------------- technical strategies
// Classic price-action rules scanned hourly over a fixed liquid ETF universe —
// the control group against the event-driven strategies. Signals flow into the
// same autopilot machinery (variants, sizing, per-strategy accounts).
const TECH_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'USO', 'XLE', 'GLD', 'SLV', 'UNG', 'TLT', 'FXI', 'EWT', 'ITA'];
const barsCache = new Map(); // symbol -> { bars, fetchedAt }

async function getDailyBars(symbol) {
  const hit = barsCache.get(symbol);
  if (hit && Date.now() - hit.fetchedAt < 30 * 60 * 1000) return hit.bars;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  const data = await fetchJson(url, { Accept: 'application/json' });
  const r = data?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!q?.close) throw new Error('no daily bars');
  const bars = [];
  for (let i = 0; i < q.close.length; i++) {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(Number.isFinite)) {
      bars.push({ ts: r.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    }
  }
  barsCache.set(symbol, { bars, fetchedAt: Date.now() });
  return bars;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsiLast(closes, period = 2) {
  if (closes.length <= period + 1) return null;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    avgG += Math.max(d, 0);
    avgL += Math.max(-d, 0);
  }
  avgG /= period; avgL /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

async function scanTechnicals() {
  for (const sym of TECH_UNIVERSE) {
    try {
      const bars = await getDailyBars(sym);
      if (bars.length < 30) continue;
      const closes = bars.map((b) => b.c);
      const n = closes.length - 1;
      const last = closes[n];
      const day = new Date(bars[n].ts).toISOString().slice(0, 10);

      // 1. EMA 5/20 cross — fires only on a fresh cross.
      const e5 = emaSeries(closes, 5);
      const e20 = emaSeries(closes, 20);
      const nowAbove = e5[n] > e20[n];
      if (nowAbove !== (e5[n - 1] > e20[n - 1])) {
        const dir = nowAbove ? 'long' : 'short';
        makeSignal({
          id: `ma-cross:${sym}:${day}`, rule: 'ma-cross',
          headline: `${sym}: 5-day EMA crossed ${nowAbove ? 'above' : 'below'} 20-day`,
          thesis: `Momentum shift on ${sym}: EMA5 ${e5[n].toFixed(2)} vs EMA20 ${e20[n].toFixed(2)}, price ${last.toFixed(2)}. Fresh cross — classic short-term trend entry ${dir}.`,
          direction: dir, symbols: [sym], tvSymbol: sym, confidence: 'medium', event: null,
        });
      }

      // 2. RSI(2) extremes — short-term mean reversion.
      const r2 = rsiLast(closes, 2);
      if (r2 != null && (r2 < 10 || r2 > 90)) {
        const dir = r2 < 10 ? 'long' : 'short';
        makeSignal({
          id: `rsi-reversal:${sym}:${day}`, rule: 'rsi-reversal',
          headline: `${sym}: RSI(2) at ${r2.toFixed(0)} — ${r2 < 10 ? 'oversold' : 'overbought'}`,
          thesis: `2-period RSI on ${sym} is ${r2.toFixed(1)} at price ${last.toFixed(2)}. Extreme short-term readings tend to snap back within 1–2 sessions. Entry ${dir}.`,
          direction: dir, symbols: [sym], tvSymbol: sym,
          confidence: r2 < 5 || r2 > 95 ? 'medium' : 'low', event: null,
        });
      }

      // 3. 20-day Donchian breakout.
      const prior = bars.slice(-21, -1);
      const hi = Math.max(...prior.map((b) => b.h));
      const lo = Math.min(...prior.map((b) => b.l));
      if (last > hi || last < lo) {
        const dir = last > hi ? 'long' : 'short';
        makeSignal({
          id: `breakout-20:${sym}:${day}`, rule: 'breakout-20',
          headline: `${sym}: 20-day ${last > hi ? 'high' : 'low'} break at ${last.toFixed(2)}`,
          thesis: `${sym} closed at ${last.toFixed(2)}, beyond its prior 20-day ${last > hi ? `high of ${hi.toFixed(2)}` : `low of ${lo.toFixed(2)}`}. Range expansion tends to carry short-term follow-through. Entry ${dir}.`,
          direction: dir, symbols: [sym], tvSymbol: sym, confidence: 'medium', event: null,
        });
      }
    } catch (err) {
      console.error(`[tech] ${sym}: ${err.message}`);
    }
  }
  console.log('[tech] scan complete');
}

// ---------------------------------------------------------------- hyper scalper
// 24/7 crypto momentum scalper on real-time Binance prices — the hyperactive
// day-trading account. Enters on short-burst momentum, exits at tight bps
// targets/stops or a minutes-scale time-out. A per-side fee is baked into
// every fill so the P&L answers the real scalping question: does the edge
// beat costs? Runs its own book, independent of the signal-driven autopilot.
const SCALP_PAIRS = {
  'BTC-USD': 'BTCUSDT', 'ETH-USD': 'ETHUSDT', 'SOL-USD': 'SOLUSDT',
  'XRP-USD': 'XRPUSDT', 'DOGE-USD': 'DOGEUSDT', 'LTC-USD': 'LTCUSDT',
};
const SCALP_TEST = process.env.SCALP_TEST === '1';
const SCALP = {
  tickMs: 500,                            // decision cadence
  lookbackMs: 60 * 1000,                  // momentum window
  histLen: 160,                           // ~80s of 500ms snapshots
  enterBps: SCALP_TEST ? 0.5 : 6,
  targetBps: 12,
  stopBps: 9,
  maxHoldMs: SCALP_TEST ? 45 * 1000 : 5 * 60 * 1000,
  feeBps: 2,                              // per side, baked into fill prices
  notional: 5000,                         // per position, virtual dollars
};
const PAIR_TO_SYM = new Map(Object.entries(SCALP_PAIRS).map(([s, p]) => [p, s]));
const scalpHist = new Map(); // symbol -> [{ts, price}]
const livePrices = new Map(); // symbol -> { price, ts } — fed by Binance websocket
let scalperOn = getSetting('scalper', '1') === '1';
let scalperRunning = false;
let lastRestFallback = 0;

// ---- SSE: stream live prices + fill events to the browser ----
const sseClients = new Set();
function broadcast(type, payload) {
  if (!sseClients.size) return;
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ---- Binance websocket: true push feed, mid of best bid/ask ----
let binGen = 0;
let binWs = null;
function startBinanceStream() {
  const gen = ++binGen;
  let backoff = 3000;
  const retry = () => { if (gen !== binGen) return; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); };
  const connect = () => {
    if (gen !== binGen) return;
    const streams = Object.values(SCALP_PAIRS).map((p) => `${p.toLowerCase()}@bookTicker`).join('/');
    let ws;
    try { ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`); } catch { retry(); return; }
    binWs = ws;
    ws.onopen = () => { backoff = 3000; console.log('[scalper] binance stream connected'); };
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data)?.data;
        if (!d?.s) return;
        const bid = parseFloat(d.b), ask = parseFloat(d.a);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
        const sym = PAIR_TO_SYM.get(d.s);
        if (sym) livePrices.set(sym, { price: (bid + ask) / 2, ts: Date.now() });
      } catch { /* malformed frame */ }
    };
    ws.onclose = retry;
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  };
  connect();
}

async function scalperTick() {
  if (scalperRunning) return;
  scalperRunning = true;
  try {
    const now = Date.now();
    // REST fallback if the websocket goes quiet (e.g. geo-blocked or dropped).
    const allStale = livePrices.size === 0 || [...livePrices.values()].every((p) => now - p.ts > 10000);
    if (allStale && now - lastRestFallback > 15000) {
      lastRestFallback = now;
      try {
        const symsParam = encodeURIComponent(JSON.stringify(Object.values(SCALP_PAIRS)));
        const data = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbols=${symsParam}`);
        for (const d of data) {
          const sym = PAIR_TO_SYM.get(d.symbol);
          const px = parseFloat(d.price);
          if (sym && Number.isFinite(px)) livePrices.set(sym, { price: px, ts: now });
        }
      } catch { /* next fallback window retries */ }
    }

    {
      for (const sym of Object.keys(SCALP_PAIRS)) {
        const live = livePrices.get(sym);
        if (!live || now - live.ts > 10000) continue;
        const px = live.price;
        const hist = scalpHist.get(sym) || [];
        hist.push({ ts: now, price: px });
        while (hist.length > SCALP.histLen) hist.shift();
        while (hist.length && now - hist[0].ts > SCALP.lookbackMs * 2) hist.shift(); // drop pre-gap snapshots
        scalpHist.set(sym, hist);

        // Manage open positions on EVERY tick — a paused scalper must still
        // honor its stops/targets/time-outs, never abandon a live position.
        const open = db.prepare("SELECT * FROM trades WHERE status = 'open' AND symbol = ? AND strategy = ?").get(sym, SCALP_RULE);
        if (open) {
          const dir = open.side === 'long' ? 1 : -1;
          const exitFill = px * (1 - dir * SCALP.feeBps / 10000);
          const movedBps = ((exitFill - open.entry_price) / open.entry_price) * 10000 * dir;
          let reason = null;
          if (movedBps >= SCALP.targetBps) reason = 'scalp target';
          else if (movedBps <= -SCALP.stopBps) reason = 'scalp stop';
          else if (now - open.opened_at >= SCALP.maxHoldMs) reason = 'scalp time';
          if (reason) closeTrade(open, exitFill, reason); // closeTrade broadcasts the fill
          continue;
        }

        if (!autopilotOn || !scalperOn) continue; // entries only while enabled

        // momentum vs the snapshot ~lookbackMs ago; the baseline must itself
        // be fresh — after a sleep/outage gap, price drift would fake momentum.
        const cutoff = now - SCALP.lookbackMs;
        let back = null;
        for (const h of hist) { if (h.ts <= cutoff) back = h; else break; }
        if (!back || now - back.ts > SCALP.lookbackMs * 1.5) continue;
        const momBps = ((px - back.price) / back.price) * 10000;
        if (Math.abs(momBps) < SCALP.enterBps) continue;
        const side = momBps > 0 ? 'long' : 'short';
        const dir = side === 'long' ? 1 : -1;
        const fill = px * (1 + dir * SCALP.feeBps / 10000); // adverse fee on entry
        const qty = +(SCALP.notional / fill).toFixed(6);
        db.prepare(`INSERT INTO trades (opened_at, symbol, side, qty, entry_price, stop_price, target_price, expires_at, auto, signal_id, thesis, strategy, variant)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, 'scalp')`)
          .run(now, sym, side, qty, fill,
            fill * (1 - dir * SCALP.stopBps / 10000),
            fill * (1 + dir * SCALP.targetBps / 10000),
            now + SCALP.maxHoldMs,
            `1-min momentum ${momBps.toFixed(1)} bps`, SCALP_RULE);
        logActivity('scalp', `SCALP ${side} ${qty} ${sym} @ ${fill.toFixed(2)} (momentum ${momBps > 0 ? '+' : ''}${momBps.toFixed(1)} bps)`);
        broadcast('fill', { action: 'open', symbol: sym });
      }
    }

    broadcast('prices', {
      ts: now,
      prices: Object.fromEntries([...livePrices].map(([s, v]) => [s, v.price])),
    });
  } catch (err) {
    console.error('[scalper] tick failed:', err.message);
  } finally {
    scalperRunning = false;
  }
}

// ---------------------------------------------------------------- flights
// Live aircraft from adsb.lol's open API — fetched on demand (only while
// someone is watching the map). Global military feed, plus area queries for
// all traffic (civilian included) when the map is zoomed in.
const flightCache = { items: [], fetchedAt: 0 };
const FLIGHT_TTL_MS = 45 * 1000;
const areaFlightCache = new Map(); // "lat,lon,r" -> { items, fetchedAt }

function normalizeAircraft(ac) {
  const items = [];
  for (const a of ac || []) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    items.push({
      hex: a.hex,
      callsign: (a.flight || '').trim() || (a.r || '').trim() || a.hex,
      reg: a.r || '',
      type: a.t || '',
      alt: Number.isFinite(a.alt_baro) ? a.alt_baro : (a.alt_baro === 'ground' ? 0 : null),
      speed: Number.isFinite(a.gs) ? Math.round(a.gs) : null,
      track: Number.isFinite(a.track) ? a.track : 0,
      mil: Boolean((a.dbFlags || 0) & 1),
      lat: a.lat, lon: a.lon,
    });
  }
  return items;
}

async function getFlights() {
  if (Date.now() - flightCache.fetchedAt < FLIGHT_TTL_MS) return flightCache.items;
  const data = await fetchJson('https://api.adsb.lol/v2/mil');
  flightCache.items = normalizeAircraft(data.ac).map((f) => ({ ...f, mil: true }));
  flightCache.fetchedAt = Date.now();
  return flightCache.items;
}

async function getAreaFlights(lat, lon, radiusNm) {
  const r = Math.min(Math.max(Math.round(radiusNm), 10), 250);
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${r}`;
  const hit = areaFlightCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < 30 * 1000) return hit.items;
  const data = await fetchJson(`https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`);
  const items = normalizeAircraft(data.ac);
  areaFlightCache.set(key, { items, fetchedAt: Date.now() });
  if (areaFlightCache.size > 24) {
    const oldest = [...areaFlightCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0][0];
    areaFlightCache.delete(oldest);
  }
  return items;
}

// ---------------------------------------------------------------- ships (AIS)
// Two sources: with a free aisstream.io key (env AISSTREAM_KEY) we stream
// live positions for the world's shipping chokepoints; without one we poll
// Finland's open Digitraffic feed (Baltic Sea) so the layer works with zero
// setup. Vessels are kept in memory keyed by MMSI and aged out after 20 min.
let aisKey = getSetting('aisstream_key', process.env.AISSTREAM_KEY || '');
const ships = new Map();
const SHIP_MAX_AGE_MS = 20 * 60 * 1000;
const CHOKEPOINT_BOXES = [
  [[23.5, 54.0], [27.5, 58.5]],   // Strait of Hormuz
  [[11.0, 32.0], [31.0, 44.5]],   // Red Sea + Bab el-Mandeb + Suez approaches
  [[-1.5, 98.0], [6.5, 105.5]],   // Malacca + Singapore Strait
  [[7.5, -81.5], [10.5, -77.5]],  // Panama Canal
  [[40.0, 26.0], [42.0, 30.5]],   // Bosporus
  [[22.0, 117.0], [26.5, 122.5]], // Taiwan Strait
  [[35.0, -7.0], [37.0, -4.0]],   // Gibraltar
  [[49.5, -2.0], [51.5, 3.0]],    // Dover Strait / Channel
];

const digiState = { fetchedAt: 0, namesFetchedAt: 0, names: new Map() };
async function refreshDigitraffic() {
  if (Date.now() - digiState.fetchedAt < 75 * 1000) return;
  digiState.fetchedAt = Date.now(); // set first so concurrent requests don't stampede
  const dtHeaders = { 'Digitraffic-User': 'world-trader-experiment' };
  const data = await fetchJson('https://meri.digitraffic.fi/api/ais/v1/locations', dtHeaders);
  for (const f of data.features || []) {
    const [lon, lat] = f.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = f.properties || {};
    ships.set(f.mmsi, {
      mmsi: f.mmsi,
      name: digiState.names.get(f.mmsi) || String(f.mmsi),
      lat, lon,
      speed: Number.isFinite(p.sog) ? p.sog : null,
      course: Number.isFinite(p.cog) ? p.cog : null,
      ts: p.timestampExternal || Date.now(),
    });
  }
  if (Date.now() - digiState.namesFetchedAt > 15 * 60 * 1000) {
    digiState.namesFetchedAt = Date.now();
    try {
      const meta = await fetchJson('https://meri.digitraffic.fi/api/ais/v1/vessels', dtHeaders);
      for (const v of meta) if (v.name) digiState.names.set(v.mmsi, v.name);
      for (const s of ships.values()) {
        const n = digiState.names.get(s.mmsi);
        if (n) s.name = n;
      }
    } catch { /* names are cosmetic */ }
  }
}

// Generation counter lets a settings change abandon the old connection (and
// its pending reconnect timers) cleanly before starting a new one.
let aisGen = 0;
let aisWs = null;

function stopAisStream() {
  aisGen++;
  if (aisWs) { try { aisWs.close(); } catch { /* already closed */ } aisWs = null; }
}

function startAisStream() {
  const gen = ++aisGen;
  let backoff = 5000;
  const retry = () => { if (gen !== aisGen) return; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 120000); };
  const connect = () => {
    if (gen !== aisGen || !aisKey) return;
    let ws;
    try { ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); } catch { retry(); return; }
    aisWs = ws;
    ws.onopen = () => {
      if (gen !== aisGen) { try { ws.close(); } catch { /* noop */ } return; }
      backoff = 5000;
      ws.send(JSON.stringify({
        APIKey: aisKey,
        BoundingBoxes: CHOKEPOINT_BOXES,
        FilterMessageTypes: ['PositionReport'],
      }));
      console.log('[ships] aisstream connected (chokepoint coverage)');
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.MessageType !== 'PositionReport') return;
        const md = m.MetaData || {};
        const pr = m.Message?.PositionReport || {};
        if (!md.MMSI || !Number.isFinite(pr.Latitude)) return;
        ships.set(md.MMSI, {
          mmsi: md.MMSI,
          name: (md.ShipName || '').trim() || String(md.MMSI),
          lat: pr.Latitude, lon: pr.Longitude,
          speed: Number.isFinite(pr.Sog) ? pr.Sog : null,
          course: Number.isFinite(pr.Cog) ? pr.Cog : null,
          ts: Date.now(),
        });
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = retry;
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  };
  connect();
}

// ---------------------------------------------------------------- chokepoint transits (IMF PortWatch)
// Zero-auth open data: daily transit calls per chokepoint, satellite-AIS based,
// updated weekly with a few days' lag. A collapse in transits vs the trailing
// average is a real disruption indicator. Attribution: IMF PortWatch.
const PW_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const PW_CHOKEPOINTS = {
  chokepoint1: { name: 'Suez Canal', symbols: ['FRO', 'ZIM', 'USO'] },
  chokepoint2: { name: 'Panama Canal', symbols: ['ZIM'] },
  chokepoint3: { name: 'Bosporus', symbols: ['WEAT', 'USO'] },
  chokepoint4: { name: 'Bab el-Mandeb', symbols: ['FRO', 'USO'] },
  chokepoint5: { name: 'Malacca Strait', symbols: ['FXI', 'EWS'] },
  chokepoint6: { name: 'Strait of Hormuz', symbols: ['USO', 'XLE'] },
  chokepoint8: { name: 'Gibraltar Strait', symbols: ['ZIM'] },
  chokepoint9: { name: 'Dover Strait', symbols: ['ZIM'] },
  chokepoint11: { name: 'Taiwan Strait', symbols: ['EWT', 'SMH'] },
};
const portwatchCache = { rows: [], fetchedAt: 0 };

async function refreshPortwatch() {
  const rows = [];
  for (const [id, info] of Object.entries(PW_CHOKEPOINTS)) {
    try {
      const url = `${PW_BASE}?where=portid%3D%27${id}%27&outFields=date,n_total,capacity&orderByFields=date%20DESC&resultRecordCount=33&f=json`;
      const d = await fetchJson(url);
      const rowsRaw = (d.features || []).map((f) => f.attributes).filter((a) => Number.isFinite(a.n_total));
      if (rowsRaw.length < 10) continue;
      const [latest, ...rest] = rowsRaw;
      const win = rest.slice(0, 28);
      const avg28 = win.reduce((s, a) => s + a.n_total, 0) / win.length;
      rows.push({
        id, name: info.name, symbols: info.symbols,
        date: latest.date, transits: latest.n_total, dwt: latest.capacity,
        avg28, ratio: avg28 > 0 ? latest.n_total / avg28 : null,
      });
    } catch (err) {
      console.error(`[portwatch] ${id} failed: ${err.message}`);
    }
  }
  if (rows.length) {
    portwatchCache.rows = rows;
    portwatchCache.fetchedAt = Date.now();
    try { deriveChokepointSignals(rows); } catch (err) { console.error('[portwatch] signals:', err.message); }
  }
  console.log(`[portwatch] ${rows.length} chokepoints refreshed`);
}

function deriveChokepointSignals(rows) {
  for (const r of rows) {
    if (r.ratio == null || r.avg28 < 5 || r.ratio > 0.7) continue;
    const day = new Date(r.date).toISOString().slice(0, 10);
    const pct = Math.round((1 - r.ratio) * 100);
    makeSignal({
      id: `cptransit:${r.id}:${day}`,
      rule: 'chokepoint-transit-drop',
      headline: `${r.name} transits down ${pct}% vs 28-day average`,
      thesis: `IMF PortWatch daily data: ${r.transits} transit calls on ${day} vs a 28-day average of ${r.avg28.toFixed(1)} (−${pct}%). Sustained drops at this chokepoint mean rerouting, longer voyages, and tighter effective supply. Hypothesis: long ${r.symbols.join(', ')}.`,
      direction: 'long', symbols: r.symbols, tvSymbol: r.symbols[0],
      confidence: r.ratio <= 0.5 ? 'high' : 'medium',
      event: { title: `${r.name} transit drop`, url: 'https://portwatch.imf.org', kind: 'chokepoint' },
    });
  }
}

// ---------------------------------------------------------------- equity history
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

async function snapshotEquity() {
  const now = Date.now();
  const last = db.prepare('SELECT MAX(ts) AS ts FROM equity_snapshots').get().ts || 0;
  if (now - last < SNAPSHOT_INTERVAL_MS) return;
  const open = db.prepare("SELECT * FROM trades WHERE status = 'open'").all();
  let unrealized = 0;
  if (open.length) {
    const quotes = await getQuotes([...new Set(open.map((t) => t.symbol))]);
    for (const t of open) {
      const pnl = tradePnl(t, quotes[t.symbol]?.price);
      if (pnl != null) unrealized += pnl;
    }
  }
  db.prepare('INSERT OR REPLACE INTO equity_snapshots (ts, equity) VALUES (?, ?)')
    .run(now, STARTING_EQUITY + realizedTotal() + unrealized);
  db.prepare('DELETE FROM equity_snapshots WHERE ts < ?').run(now - 90 * 24 * 3600 * 1000);
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel === 'trades') rel = 'trades.html';
  if (rel === 'strategies') rel = 'strategies.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  let url, p;
  try {
    // Inside try: Node passes malformed request-targets through, and an
    // uncaught throw here would kill the whole process.
    url = new URL(req.url, `http://localhost:${PORT}`);
    p = url.pathname;
    if (p === '/api/events' && req.method === 'GET') {
      const hoursRaw = Number(url.searchParams.get('hours'));
      const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 48;
      const cutoff = Date.now() - hours * 3600 * 1000;
      return json(res, 200, {
        fetchedAt: eventCache.fetchedAt,
        errors: eventCache.errors,
        events: eventCache.events.filter((e) => e.ts >= cutoff),
      });
    }
    if (p === '/api/refresh' && req.method === 'POST') {
      await refreshEvents();
      return json(res, 200, { ok: true, count: eventCache.events.length, errors: eventCache.errors });
    }
    if (p === '/api/news' && req.method === 'GET') {
      return json(res, 200, { fetchedAt: newsCache.fetchedAt, items: newsCache.items.slice(0, 100) });
    }
    if (p === '/api/signals' && req.method === 'GET') {
      const status = url.searchParams.get('status');
      const rows = status
        ? db.prepare('SELECT * FROM signals WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status)
        : db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT 200').all();
      return json(res, 200, { signals: rows.map((r) => ({ ...r, symbols: JSON.parse(r.symbols), event: r.event_json ? JSON.parse(r.event_json) : null })) });
    }
    if (p === '/api/signals/dismiss' && req.method === 'POST') {
      const { id } = await readBody(req);
      db.prepare("UPDATE signals SET status = 'dismissed' WHERE id = ?").run(String(id));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/quotes' && req.method === 'GET') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
      if (!symbols.length) return json(res, 400, { error: 'symbols required' });
      return json(res, 200, { quotes: await getQuotes(symbols) });
    }
    if (p === '/api/trades' && req.method === 'GET') {
      // Summary spans ALL trades; the returned list is capped — scalper volume
      // would otherwise grow this payload without bound (CSV has everything).
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 400;
      const trades = db.prepare('SELECT * FROM trades ORDER BY opened_at DESC').all();
      const openSymbols = [...new Set(trades.filter((t) => t.status === 'open').map((t) => t.symbol))];
      const quotes = openSymbols.length ? await getQuotes(openSymbols) : {};
      const enriched = trades.map((t) => {
        const q = quotes[t.symbol];
        const pnl = tradePnl(t, q?.price);
        return { ...t, mark: t.status === 'closed' ? t.exit_price : q?.price ?? null, pnl };
      });
      const open = enriched.filter((t) => t.status === 'open');
      const closed = enriched.filter((t) => t.status === 'closed');
      const realized = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const unrealized = open.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
      const autoTrades = enriched.filter((t) => t.auto);
      return json(res, 200, {
        trades: enriched.slice(0, limit),
        total: enriched.length,
        summary: {
          openCount: open.length, closedCount: closed.length,
          realized, unrealized,
          equity: STARTING_EQUITY + realized + unrealized,
          startingEquity: STARTING_EQUITY,
          winRate: closed.length ? wins / closed.length : null,
          autopilot: autopilotOn,
          claudePnl: autoTrades.reduce((s, t) => s + (t.pnl ?? 0), 0),
          claudeCount: autoTrades.length,
        },
      });
    }
    if (p === '/api/flights' && req.method === 'GET') {
      // Note: Number(null) === 0, so missing params must stay NaN explicitly.
      const num = (name) => { const v = url.searchParams.get(name); return v === null || v === '' ? NaN : Number(v); };
      const lat = num('lat');
      const lon = num('lon');
      const radius = num('radius');
      try {
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          return json(res, 200, { flights: await getAreaFlights(lat, lon, Number.isFinite(radius) ? radius : 250) });
        }
        return json(res, 200, { fetchedAt: flightCache.fetchedAt, flights: await getFlights() });
      } catch (err) {
        // serve last-known flights rather than failing the map
        return json(res, 200, { fetchedAt: flightCache.fetchedAt, flights: flightCache.items, error: err.message });
      }
    }
    if (p === '/api/ships' && req.method === 'GET') {
      if (!aisKey) {
        try { await refreshDigitraffic(); } catch (err) { /* serve what we have */ }
      }
      const now = Date.now();
      for (const [k, s] of ships) if (now - s.ts > SHIP_MAX_AGE_MS) ships.delete(k);
      let list = [...ships.values()];
      if (list.length > 2000) list = list.sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0)).slice(0, 2000);
      return json(res, 200, {
        source: aisKey
          ? 'aisstream.io — live chokepoints (Hormuz, Suez, Malacca, Panama, Bosporus, Taiwan, Gibraltar, Dover)'
          : 'Digitraffic open AIS — Baltic Sea demo. Add a free aisstream.io key in Settings for global chokepoint coverage.',
        count: list.length,
        ships: list,
      });
    }
    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/strategy-accounts' && req.method === 'GET') {
      // Each strategy presented as its own virtual $100k account: balance =
      // base + its own realized P&L + unrealized on its open positions.
      const VIRTUAL_BASE = 100000;
      const auto = db.prepare('SELECT * FROM trades WHERE auto = 1 ORDER BY opened_at').all();
      const openSymbols = [...new Set(auto.filter((t) => t.status === 'open').map((t) => t.symbol))];
      const quotes = openSymbols.length ? await getQuotes(openSymbols) : {};
      const accounts = [];
      for (const [rule, meta] of Object.entries(STRATEGY_META)) {
        const mine = auto.filter((t) => t.strategy === rule);
        const closed = mine.filter((t) => t.status === 'closed').sort((a, b) => a.closed_at - b.closed_at);
        const open = mine.filter((t) => t.status === 'open');
        const firstTs = mine.length ? mine[0].opened_at : Date.now();
        const curve = [{ ts: firstTs, balance: VIRTUAL_BASE }];
        let bal = VIRTUAL_BASE;
        for (const t of closed) {
          bal += tradePnl(t) ?? 0;
          curve.push({ ts: t.closed_at, balance: bal });
        }
        let unrealized = 0;
        for (const t of open) {
          const pnl = tradePnl(t, quotes[t.symbol]?.price);
          if (pnl != null) unrealized += pnl;
        }
        curve.push({ ts: Date.now(), balance: bal + unrealized });
        // Hyperactive strategies produce thousands of curve points — downsample.
        if (curve.length > 400) {
          const step = Math.ceil(curve.length / 400);
          const sampled = curve.filter((_, i) => i % step === 0);
          if (sampled[sampled.length - 1] !== curve[curve.length - 1]) sampled.push(curve[curve.length - 1]);
          curve.length = 0;
          curve.push(...sampled);
        }
        const wins = closed.filter((t) => (tradePnl(t) ?? 0) > 0).length;
        accounts.push({
          rule, family: meta.family, title: meta.title, description: meta.desc,
          watchOnly: rule === 'headline-risk',
          balance: bal + unrealized,
          realized: bal - VIRTUAL_BASE, unrealized,
          openCount: open.length, closedCount: closed.length,
          winRate: closed.length ? wins / closed.length : null,
          curve,
        });
      }
      accounts.sort((a, b) => (a.watchOnly ? 1 : 0) - (b.watchOnly ? 1 : 0) || b.balance - a.balance);
      return json(res, 200, { base: VIRTUAL_BASE, accounts });
    }
    if (p === '/api/chokepoints' && req.method === 'GET') {
      return json(res, 200, { fetchedAt: portwatchCache.fetchedAt, attribution: 'IMF PortWatch', chokepoints: portwatchCache.rows });
    }
    if (p === '/api/settings' && req.method === 'GET') {
      const mask = (k) => (k ? `••••••••${k.slice(-4)}` : '');
      return json(res, 200, { aisstream_key: mask(aisKey), wm_api_key: mask(wmKey), scalper: scalperOn });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      // Non-empty string sets a key; explicit null clears it; absent = unchanged.
      if (typeof b.aisstream_key === 'string' && b.aisstream_key.trim()) {
        aisKey = b.aisstream_key.trim();
        setSetting('aisstream_key', aisKey);
        ships.clear();
        stopAisStream();
        startAisStream();
        logActivity('info', 'aisstream.io key saved — ships switching to global chokepoint coverage');
      } else if (b.aisstream_key === null) {
        aisKey = '';
        setSetting('aisstream_key', '');
        stopAisStream();
        ships.clear();
        logActivity('info', 'aisstream.io key removed — ships back to Baltic demo feed');
      }
      if (typeof b.scalper === 'boolean') {
        scalperOn = b.scalper;
        setSetting('scalper', scalperOn ? '1' : '0');
        logActivity('info', `Scalper ${scalperOn ? 'ENABLED' : 'PAUSED'} by user`);
      }
      if (typeof b.wm_api_key === 'string' && b.wm_api_key.trim()) {
        wmKey = b.wm_api_key.trim();
        setSetting('wm_api_key', wmKey);
        logActivity('info', 'WorldMonitor API key saved — keyed endpoints available on next refresh');
      } else if (b.wm_api_key === null) {
        wmKey = '';
        setSetting('wm_api_key', '');
        logActivity('info', 'WorldMonitor API key removed');
      }
      const mask = (k) => (k ? `••••••••${k.slice(-4)}` : '');
      return json(res, 200, { ok: true, aisstream_key: mask(aisKey), wm_api_key: mask(wmKey) });
    }
    if (p === '/api/equity-history' && req.method === 'GET') {
      return json(res, 200, {
        startingEquity: STARTING_EQUITY,
        history: db.prepare('SELECT ts, equity FROM equity_snapshots ORDER BY ts').all(),
      });
    }
    if (p === '/api/trades.csv' && req.method === 'GET') {
      const all = db.prepare('SELECT * FROM trades ORDER BY opened_at').all();
      const cols = ['id', 'opened_at', 'closed_at', 'symbol', 'side', 'qty', 'entry_price', 'exit_price', 'stop_price', 'target_price', 'status', 'auto', 'strategy', 'variant', 'exit_reason', 'thesis'];
      const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const lines = [cols.join(',')];
      for (const t of all) {
        lines.push(cols.map((c) => (c === 'opened_at' || c === 'closed_at') ? (t[c] ? new Date(t[c]).toISOString() : '') : esc(t[c])).join(','));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="world-trader-trades.csv"' });
      return res.end(lines.join('\r\n'));
    }
    if (p === '/api/performance' && req.method === 'GET') {
      const rows = db.prepare(`SELECT strategy, variant,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed,
          SUM(CASE WHEN status = 'closed' AND ${AUTO_PNL_SQL} > 0 THEN 1 ELSE 0 END) AS wins,
          COALESCE(SUM(CASE WHEN status = 'closed' THEN ${AUTO_PNL_SQL} END), 0) AS realized,
          COALESCE(SUM(CASE WHEN status = 'closed' AND ${AUTO_PNL_SQL} > 0 THEN ${AUTO_PNL_SQL} END), 0) AS grossWin,
          COALESCE(SUM(CASE WHEN status = 'closed' AND ${AUTO_PNL_SQL} < 0 THEN ${AUTO_PNL_SQL} END), 0) AS grossLoss
        FROM trades WHERE auto = 1 GROUP BY strategy, variant ORDER BY realized DESC`).all();
      return json(res, 200, { performance: rows });
    }
    if (p === '/api/activity' && req.method === 'GET') {
      return json(res, 200, { activity: db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 100').all() });
    }
    if (p === '/api/autopilot' && req.method === 'POST') {
      const b = await readBody(req);
      autopilotOn = Boolean(b.on);
      setSetting('autopilot', autopilotOn ? '1' : '0');
      logActivity('info', `Autopilot ${autopilotOn ? 'ENABLED' : 'PAUSED'} by user`);
      if (autopilotOn) autopilotTick();
      return json(res, 200, { autopilot: autopilotOn });
    }
    if (p === '/api/trades' && req.method === 'POST') {
      const b = await readBody(req);
      const symbol = String(b.symbol || '').toUpperCase().trim();
      const side = b.side === 'short' ? 'short' : 'long';
      const qty = Number(b.qty);
      if (!symbol || !Number.isFinite(qty) || qty <= 0) return json(res, 400, { error: 'symbol and positive qty required' });
      let entry = Number(b.entry_price);
      if (!Number.isFinite(entry) || entry <= 0) {
        const q = await getQuote(symbol);
        entry = q.price;
      }
      const stop = Number.isFinite(Number(b.stop_price)) && Number(b.stop_price) > 0 ? Number(b.stop_price) : null;
      const target = Number.isFinite(Number(b.target_price)) && Number(b.target_price) > 0 ? Number(b.target_price) : null;
      const info = db.prepare(`INSERT INTO trades (opened_at, symbol, side, qty, entry_price, stop_price, target_price, expires_at, auto, signal_id, thesis, strategy, variant)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'manual', 'base')`)
        .run(Date.now(), symbol, side, qty, entry, stop, target, null, b.signal_id || null, b.thesis || null);
      if (b.signal_id) db.prepare("UPDATE signals SET status = 'taken' WHERE id = ?").run(String(b.signal_id));
      logActivity('open', `MANUAL opened ${side} ${qty} ${symbol} @ ${entry.toFixed(2)}${stop ? ` · stop ${stop.toFixed(2)}` : ''}${target ? ` · target ${target.toFixed(2)}` : ''}`);
      return json(res, 200, { ok: true, id: Number(info.lastInsertRowid), entry_price: entry });
    }
    if (p === '/api/trades/close' && req.method === 'POST') {
      const b = await readBody(req);
      const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(Number(b.id));
      if (!t) return json(res, 404, { error: 'trade not found' });
      if (t.status === 'closed') return json(res, 400, { error: 'already closed' });
      let exit = Number(b.exit_price);
      if (!Number.isFinite(exit) || exit <= 0) {
        const q = await getQuote(t.symbol);
        exit = q.price;
      }
      closeTrade(t, exit, 'manual close');
      return json(res, 200, { ok: true, exit_price: exit });
    }
    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, { wmKeyPresent: Boolean(wmKey), port: PORT, refreshMs: EVENT_REFRESH_MS, autopilot: autopilotOn });
    }
    if (req.method === 'GET') return serveStatic(res, p);
    res.writeHead(405); res.end();
  } catch (err) {
    console.error(`[error] ${req.method} ${p || req.url}: ${err.message}`);
    json(res, url ? 500 : 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`world-trader listening on http://localhost:${PORT}  (paper trading only — no real money · autopilot ${autopilotOn ? 'ON' : 'OFF'})`);
  refreshEvents()
    .then(() => autopilotTick())
    .catch((e) => console.error('[events] initial refresh failed:', e.message));
  setInterval(() => refreshEvents().catch((e) => console.error('[events] refresh failed:', e.message)), EVENT_REFRESH_MS);
  setInterval(() => autopilotTick(), 60 * 1000);
  refreshPortwatch().catch((e) => console.error('[portwatch] initial fetch failed:', e.message));
  setInterval(() => refreshPortwatch().catch((e) => console.error('[portwatch] refresh failed:', e.message)), 12 * 3600 * 1000);
  scanTechnicals().catch((e) => console.error('[tech] initial scan failed:', e.message));
  setInterval(() => scanTechnicals().catch((e) => console.error('[tech] scan failed:', e.message)), 60 * 60 * 1000);
  startBinanceStream();
  setInterval(() => scalperTick(), SCALP.tickMs);
  console.log(`[scalper] ${scalperOn ? 'active' : 'paused'} — ${Object.keys(SCALP_PAIRS).length} pairs streaming, decisions every ${SCALP.tickMs}ms${SCALP_TEST ? ' (TEST MODE)' : ''}`);
  if (aisKey) startAisStream();
});
