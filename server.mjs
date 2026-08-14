// world-trader — local paper-trading sandbox driven by WorldMonitor event data.
// Zero npm dependencies: node:http + node:sqlite (Node 24+). NO REAL MONEY.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = import.meta.dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3555);
// Bound to loopback by default: the API is unauthenticated, so LAN exposure
// would let any device on the network trade or overwrite API keys.
// Set HOST=0.0.0.0 explicitly to accept LAN connections.
const HOST = process.env.HOST || '127.0.0.1';

// ---- persistent log file (console is invisible under the minimized autostart) ----
const LOG_DIR = path.join(ROOT, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* exists */ }
const LOG_FILE = path.join(LOG_DIR, 'server.log');
function logToFile(line) {
  try {
    try { if (fs.statSync(LOG_FILE).size > 5e6) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never crash the engine */ }
}
const _clog = console.log.bind(console);
const _cerr = console.error.bind(console);
console.log = (...a) => { _clog(...a); logToFile(`${new Date().toISOString()} ${a.join(' ')}`); };
console.error = (...a) => { _cerr(...a); logToFile(`${new Date().toISOString()} ERROR ${a.join(' ')}`); };

// One unguarded throw must not silently kill the trading engine; log and keep
// running (start.cmd adds a watchdog restart for genuinely fatal states).
const bootTs = Date.now();
process.on('uncaughtException', (e) => console.error('[fatal] uncaughtException:', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', e?.stack || e));
const WM_BASE = 'https://api.worldmonitor.app';
let wmKey = process.env.WM_API_KEY || ''; // may be overridden from the settings table after db init
const UA = 'world-trader/0.1 (local paper-trading experiment)';
const EVENT_REFRESH_MS = 5 * 60 * 1000;
const QUOTE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------- database
// DB_PATH override lets the test suite run against a throwaway database.
const db = new DatabaseSync(process.env.DB_PATH || path.join(ROOT, 'data.db'));
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
  CREATE TABLE IF NOT EXISTS strategy_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule TEXT NOT NULL,
    gen INTEGER NOT NULL,
    params TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    retired_at INTEGER,
    trades INTEGER NOT NULL DEFAULT 0,
    pnl REAL NOT NULL DEFAULT 0,
    win_rate REAL,
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS rule_tuning (
    rule TEXT PRIMARY KEY,
    stop_mult REAL NOT NULL DEFAULT 1,
    target_mult REAL NOT NULL DEFAULT 1,
    horizon_mult REAL NOT NULL DEFAULT 1,
    updated_at INTEGER,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS rule_tuning_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule TEXT NOT NULL,
    ts INTEGER NOT NULL,
    stop_mult REAL NOT NULL,
    target_mult REAL NOT NULL,
    horizon_mult REAL NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS bars (
    symbol TEXT NOT NULL,
    ts INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    PRIMARY KEY (symbol, ts)
  );
  CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    ts INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    PRIMARY KEY (symbol, ts)
  );
  CREATE TABLE IF NOT EXISTS backtests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    label TEXT,
    params TEXT NOT NULL,
    results TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status, strategy);
  CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades (status, closed_at);
`);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Migrate databases created before newer columns existed.
for (const col of ['strategy TEXT', 'variant TEXT', 'fees REAL DEFAULT 0', 'mae REAL', 'mfe REAL']) {
  try { db.exec(`ALTER TABLE trades ADD COLUMN ${col}`); } catch { /* column already exists */ }
}
try { db.exec('ALTER TABLE signals ADD COLUMN outcome_pnl REAL'); } catch { /* exists */ }
try { db.exec('ALTER TABLE signals ADD COLUMN outcome_note TEXT'); } catch { /* exists */ }
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
  db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 2000)').run();
  console.log(`[${kind}] ${message}`);
}

// ---- optional push notifications (ntfy.sh topic URL or any webhook that accepts a text POST) ----
let webhookUrl = '';
function notify(title, text) {
  if (!webhookUrl) return;
  fetch(webhookUrl, {
    method: 'POST',
    headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), 'User-Agent': UA },
    body: text,
    signal: AbortSignal.timeout(10000),
  }).catch((e) => console.error('[notify] failed:', e.message));
}

// ---------------------------------------------------------------- market hours
// US equity session awareness — without it, ETF fills execute 24/7 against
// frozen out-of-hours quotes and event strategies book untradeable gaps.
const US_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
// NYSE 13:00 ET early closes — without these the afternoon reads as open and
// fills would book against the frozen 13:00 print for three hours.
const US_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const etMemo = { min: 0, val: null };
function etNow(ts = Date.now()) {
  const minKey = Math.floor(ts / 60000);
  if (etMemo.min === minKey && etMemo.val) return etMemo.val;
  const parts = Object.fromEntries(ET_FMT.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const val = {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    dow: parts.weekday,
    weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun',
    minutes: Number(parts.hour) % 24 * 60 + Number(parts.minute),
  };
  etMemo.min = minKey; etMemo.val = val;
  return val;
}
function usMarketOpen(ts = Date.now()) {
  const p = etNow(ts);
  if (p.weekend || US_HOLIDAYS.has(p.day)) return false;
  const close = US_EARLY_CLOSE.has(p.day) ? 13 * 60 : 16 * 60;
  return p.minutes >= 9 * 60 + 30 && p.minutes < close;
}
const isCrypto = (sym) => sym.endsWith('-USD');
const isFx = (sym) => sym.endsWith('=X');
// FX runs continuously from Sunday 17:00 ET to Friday 17:00 ET.
function fxMarketOpen(ts = Date.now()) {
  const p = etNow(ts);
  if (p.dow === 'Sat') return false;
  if (p.dow === 'Fri' && p.minutes >= 17 * 60) return false;
  if (p.dow === 'Sun' && p.minutes < 17 * 60) return false;
  return true;
}
// Crypto trades around the clock, FX nearly so; equities only in the US session.
const marketOpenFor = (sym, ts) => isCrypto(sym) || (isFx(sym) ? fxMarketOpen(ts) : usMarketOpen(ts));

// ---------------------------------------------------------------- friction
// Honest fills for the ETF book: half the typical bid/ask spread plus a
// slippage allowance, applied adversely on entry AND exit. Thin single-country
// funds pay much more than SPY — that difference is real and matters.
const SPREAD_BPS = {
  SPY: 1, QQQ: 1, IWM: 2, GLD: 1, SLV: 2, TLT: 1, USO: 3, XLE: 2, UNG: 6,
  FXI: 3, EWT: 4, ITA: 3, FRO: 10, ZIM: 12, WEAT: 10, VIXY: 5, TRV: 3,
  EWS: 5, INDA: 3, EWJ: 2, EWY: 3, EWZ: 3, EWW: 4, EWG: 3, EWU: 3, EWQ: 4,
  EWI: 5, EWP: 5, TUR: 8, EIS: 6, KSA: 6, EZA: 5, ECH: 6, EIDO: 6, EPHE: 8,
  VNM: 6, EPOL: 6, NGE: 15, ARGT: 5, EWA: 3, EWC: 3, GREK: 8, EGPT: 15,
  PAK: 15, THD: 6, EWM: 6, EPU: 10, GXG: 12, URA: 4, LMT: 2, PANW: 2, BUG: 6, SMH: 2,
  AAPL: 1, NVDA: 2, TSLA: 3,
  'EURUSD=X': 1, 'GBPUSD=X': 1.5, 'AUDUSD=X': 1.5, // retail FX majors: ~1 pip
};
const SLIPPAGE_BPS = 2;
const frictionBps = (sym) => (SPREAD_BPS[sym] ?? 12) / 2 + SLIPPAGE_BPS;
// Buying (long entry / short exit) pays up; selling receives less.
function applyFriction(sym, side, price, isEntry) {
  const buying = (side === 'long') === isEntry;
  return price * (1 + (buying ? 1 : -1) * frictionBps(sym) / 10000);
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
  // sig.plan lets a rule set its OWN levels at creation (day-trade rules use
  // range/VWAP-derived stops, not ADR ones); a preset plan_entry also stops
  // the autopilot's generic planner from overwriting it.
  const p = sig.plan || {};
  const stmt = db.prepare(`INSERT OR IGNORE INTO signals
    (id, created_at, rule, headline, thesis, direction, symbols, tv_symbol, confidence, event_json,
     plan_entry, plan_stop, plan_target, plan_qty, horizon_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return stmt.run(sig.id, Date.now(), sig.rule, sig.headline, sig.thesis, sig.direction,
    JSON.stringify(sig.symbols), sig.tvSymbol, sig.confidence, JSON.stringify(sig.event || null),
    p.entry ?? null, p.stop ?? null, p.target ?? null, p.qty ?? null, p.horizonDays ?? null);
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
  // Prior-session close = second-to-last daily close in the 5d window.
  // (meta.chartPreviousClose is the close before the WHOLE window — wrong day.)
  let prevClose = null;
  if (q0?.close) {
    const closes = q0.close.filter(Number.isFinite);
    if (closes.length >= 2) prevClose = closes[closes.length - 2];
  }
  return { price: meta.regularMarketPrice, prevClose: prevClose ?? meta.previousClose ?? null, adrPct, source: `yahoo:${host}` };
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
  return db.prepare(`SELECT COALESCE(SUM((exit_price - entry_price) * (CASE side WHEN 'long' THEN 1 ELSE -1 END) * qty), 0) AS s
    FROM trades WHERE status = 'closed'`).get().s;
}

// Marked equity for sizing: prefer the latest mark-to-market snapshot (so a
// book deep in unrealized drawdown sizes smaller), fall back to realized-only.
let lastMarkedEquity = { ts: 0, equity: null };
function sizingEquity() {
  const realizedEq = STARTING_EQUITY + realizedTotal();
  if (lastMarkedEquity.equity != null && Date.now() - lastMarkedEquity.ts < 30 * 60 * 1000) {
    return Math.min(realizedEq, lastMarkedEquity.equity);
  }
  return realizedEq;
}

function closeTrade(t, exitPrice, reason, frictionDollars = 0) {
  // Guarded + idempotent: concurrent closers (manual close vs the 500ms
  // scalper tick vs the manage loop) race across awaits — only one wins.
  const info = db.prepare(`UPDATE trades SET status = 'closed', closed_at = ?, exit_price = ?, exit_reason = ?,
      fees = COALESCE(fees, 0) + ? WHERE id = ? AND status = 'open'`)
    .run(Date.now(), exitPrice, reason, frictionDollars, t.id);
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
  'orb-15min': { family: 'day', title: '15-Min Opening Range Breakout', desc: 'Records the high and low of the first 15 minutes after the US open, then trades the first clean break of that range — long above the high, short below the low — with the stop at the range midpoint and the target at 1.5× the range beyond the break. Always flat before the close. The classic day-trading setup, run on SPY, QQQ, IWM, AAPL, NVDA, TSLA.' },
  'gap-fade': { family: 'day', title: 'Overnight Gap Fade', desc: 'When a symbol opens 0.4–3% away from yesterday’s close and is still stretched mid-morning, fade the gap back toward the prior close (short a gap-up, long a gap-down). Target = yesterday’s close (the fill), stop at 60% of the gap beyond entry, flat by the close. Bets on the well-documented tendency of moderate gaps to fill.' },
  'vwap-revert': { family: 'day', title: 'VWAP Reversion', desc: 'Volume-weighted average price is the institutional anchor of the session. When price stretches far from VWAP (threshold scaled to each symbol’s volatility), fade back toward it — target at VWAP, stop at 60% of the stretch beyond entry, flat by the close.' },
  'fx-session': { family: 'day', title: 'London FX Breakout', desc: 'The non-US-market account: trades EUR/USD, GBP/USD, and AUD/USD during the London session. Records the first hour of London trading (3–4am ET), then trades the break of that range with the stop at the midpoint and a 1.5× range target, flat before the New York lunch. Unleveraged, so positions are small — the point is whether the edge exists at all.' },
  'momo-scalper': { family: 'hyper', title: 'Momentum Scalper', desc: '24/7 crypto scalper on real-time Binance prices (BTC, ETH, SOL, XRP, DOGE, LTC): enters on short-burst momentum, exits at bps-scale targets/stops or a minutes-scale time-out, $5k notional per position. Costs are modeled honestly — ~10 bps per-side taker fee and spread-crossing fills baked into every trade — and the parameters evolve in generations, so the open question the account answers is whether any momentum edge survives real costs.' },
};

// ---------------------------------------------------------------- autopilot
// The engine does the trading: it prices every queued signal into a full plan
// (entry, volatility-scaled stop, 2R target, risk-based size, time exit), then
// opens and manages the paper positions itself. PAPER MONEY ONLY.
let autopilotOn = getSetting('autopilot', '1') === '1';
const SCALP_RULE = 'momo-scalper';
// Risk knobs are user-tunable from Settings (persisted; sane clamps applied).
let MAX_OPEN_POSITIONS = clamp(Number(getSetting('max_positions', '10')) || 10, 1, 30); // event+tech book
let RISK_PER_TRADE = clamp(Number(getSetting('risk_per_trade', '1')) / 100 || 0.01, 0.001, 0.05); // % of equity at the stop
const MAX_POSITION_FRACTION = 0.15;  // notional cap per position
webhookUrl = getSetting('webhook_url', '');
// Short-term regime: horizons of hours to 2 days, targets sized to be
// reachable within that window (≤ ~3× a day's range).
const RULE_HORIZON_DAYS = {
  'quake-country-etf': 1, 'oil-producer-unrest': 2, 'chokepoint-disruption': 2,
  'hurricane-energy': 1.5, 'global-risk-off': 2, 'headline-risk': 1,
  'chokepoint-transit-drop': 2,
  'ma-cross': 2, 'rsi-reversal': 1, 'breakout-20': 2,
  'orb-15min': 0.3, 'gap-fade': 0.3, 'vwap-revert': 0.3, 'fx-session': 0.3,
};

// Intraday rules: they carry their own levels (set at signal creation), enter
// only while fresh, and are always flat before their session ends.
const DAY_RULES = new Set(['orb-15min', 'gap-fade', 'vwap-revert', 'fx-session']);

async function buildDayPlan(s, sizeFactor = 1) {
  const q = await getQuote(s.tv_symbol);
  if (q.stale) throw new Error(`quote for ${s.tv_symbol} is stale — not trading on it`);
  const dir = s.direction === 'short' ? -1 : 1;
  const entry = q.price;
  const stop = s.plan_stop;
  const target = s.plan_target;
  if (!Number.isFinite(stop) || !Number.isFinite(target)) throw new Error('day signal missing its levels');
  if ((entry - stop) * dir <= 0) throw new Error('price already through the stop — setup invalidated');
  if ((target - entry) * dir <= 0) throw new Error('price already at the target — move missed');
  const stopDist = Math.abs(entry - stop);
  const equity = sizingEquity();
  let riskFrac = RISK_PER_TRADE;
  if (await vixHalvesRisk()) riskFrac /= 2;
  let qty = Math.floor((equity * riskFrac * sizeFactor) / stopDist);
  if (qty * entry > equity * MAX_POSITION_FRACTION) qty = Math.floor((equity * MAX_POSITION_FRACTION) / entry);
  if (qty < 1) {
    if (stopDist <= equity * riskFrac * Math.max(sizeFactor, 0.1) * 2) qty = 1;
    else throw new Error(`sizing: one share of ${s.tv_symbol} exceeds the risk budget`);
  }
  // Flat before the session ends: US day trades by 15:55 ET, FX by 11:45 ET.
  const sessEndMin = s.rule === 'fx-session' ? 11 * 60 + 45 : 15 * 60 + 55;
  return { entry, stop, target, qty, horizon: 0, expiresAt: etDayStart(Date.now()) + sessEndMin * 60000 };
}

// Exit-style variants — each auto trade is tagged (strategy rule × variant) so
// performance can be compared per combination and sizing adapted over time.
// tight ≈ hours, base ≈ a day, runner ≈ 1–2 days.
const STRATEGY_VARIANTS = {
  tight:  { stopAdr: 0.6, targetR: 1.0, horizonMult: 0.3 },
  base:   { stopAdr: 1.0, targetR: 1.5, horizonMult: 0.6 },
  runner: { stopAdr: 1.4, targetR: 2.0, horizonMult: 1.0 },
};

// Per-rule learned overrides (rule_tuning table) — evolved daily from each
// rule's recent closed trades; buildPlan applies them on top of the variant.
const ruleTuning = new Map();
for (const r of db.prepare('SELECT * FROM rule_tuning').all()) ruleTuning.set(r.rule, r);

// VIX regime cached for 5 min — buildPlan used to fetch ^VIX on every call.
const vixRegime = { ts: 0, halved: false };
async function vixHalvesRisk() {
  if (Date.now() - vixRegime.ts < 5 * 60 * 1000) return vixRegime.halved;
  try {
    const vix = await getQuote('^VIX');
    vixRegime.halved = vix.price >= 30;
  } catch { /* VIX unavailable — keep last known regime */ }
  vixRegime.ts = Date.now();
  return vixRegime.halved;
}

// Signal confidence scales size — computed by every rule, it should matter.
const CONFIDENCE_SIZE = { high: 1.25, medium: 1, low: 0.6 };

async function buildPlan(direction, rule, symbol, v = STRATEGY_VARIANTS.base, sizeFactor = 1) {
  const q = await getQuote(symbol);
  // Never plan or fill on a stale last-known-good quote — after an outage that
  // would price trades at hours-old marks.
  if (q.stale) throw new Error(`quote for ${symbol} is stale — not trading on it`);
  const adr = Math.min(Math.max(q.adrPct ?? 0.02, 0.008), 0.06);
  const entry = q.price;
  const tune = ruleTuning.get(rule);
  // Sanity-clamp the base stop first, then apply the learned multiplier with
  // wider bounds — inside one clamp, tuning saturates silently on high-ADR symbols.
  const baseStop = clamp(v.stopAdr * adr, 0.01, 0.08);
  const stopDist = entry * clamp(baseStop * (tune?.stop_mult ?? 1), 0.008, 0.15);
  const dir = direction === 'short' ? -1 : 1; // 'watch' plans as a long suggestion
  const stop = entry - dir * stopDist;
  const target = entry + dir * v.targetR * stopDist * (tune?.target_mult ?? 1);
  const horizon = (RULE_HORIZON_DAYS[rule] ?? 4) * v.horizonMult * (tune?.horizon_mult ?? 1);

  const equity = sizingEquity();
  let riskFrac = RISK_PER_TRADE;
  if (await vixHalvesRisk()) riskFrac = RISK_PER_TRADE / 2; // defensive sizing in panicky tape
  let qty = Math.floor((equity * riskFrac * sizeFactor) / stopDist);
  if (qty * entry > equity * MAX_POSITION_FRACTION) qty = Math.floor((equity * MAX_POSITION_FRACTION) / entry);
  if (qty < 1) {
    // A single share is allowed only when its stop-risk stays inside ~2× the
    // budget; the old unconditional 1-share floor forced trades the risk math rejected.
    if (stopDist <= equity * riskFrac * Math.max(sizeFactor, 0.1) * 2) qty = 1;
    else throw new Error(`sizing: one share of ${symbol} exceeds the risk budget`);
  }
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

// ---- portfolio-level risk controls ----
const GROSS_EXPOSURE_CAP = 1.0; // event/tech open notional ≤ 1× equity
const KILL_DAILY_LOSS_FRAC = 0.02; // realized daily loss that halts new entries
const CLUSTER_LIMITS = [
  { name: 'energy/shipping', symbols: new Set(['USO', 'XLE', 'UNG', 'FRO', 'ZIM', 'WEAT']), maxOpen: 4 },
];
let killSwitchLoggedDay = '';
function etDayStart(now) {
  // Wall-clock minute arithmetic is one hour off when a DST transition sits
  // between midnight and now — correct iteratively until the boundary really
  // is 00:00 of today's ET calendar day.
  const today = etNow(now).day;
  let start = now - etNow(now).minutes * 60000 - (now % 60000);
  for (let i = 0; i < 3; i++) {
    const p = etNow(start);
    if (p.day === today && p.minutes === 0) break;
    start -= (p.day === today ? p.minutes : p.minutes - 24 * 60) * 60000;
  }
  return start;
}
// Daily-loss kill switch: a bad enough realized day stops ALL new entries
// (event, tech, and scalper) until the next ET trading day.
function killSwitchActive(now = Date.now()) {
  const dayPnl = db.prepare(`SELECT COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS s FROM trades WHERE status = 'closed' AND closed_at >= ?`)
    .get(etDayStart(now)).s;
  const limit = (lastMarkedEquity.equity ?? STARTING_EQUITY) * KILL_DAILY_LOSS_FRAC;
  const active = dayPnl <= -limit;
  const day = etNow(now).day;
  if (active && killSwitchLoggedDay !== day) {
    killSwitchLoggedDay = day;
    logActivity('risk', `KILL SWITCH: today's realized P&L ${dayPnl.toFixed(2)} breaches the ${(KILL_DAILY_LOSS_FRAC * 100).toFixed(0)}% daily-loss limit — no new entries until the next ET day`);
    notify('world-trader: kill switch', `Daily loss limit hit (${dayPnl.toFixed(2)}). New entries paused until tomorrow.`);
  }
  return active;
}

// Sleep/downtime detection: setInterval timers freeze while the laptop sleeps;
// on wake we defer time exits briefly so they fill on fresh quotes, not the
// pre-sleep stale marks, and we record that the book went unmanaged.
let lastHeartbeat = Date.now();
let wakeGraceUntil = 0;
function heartbeat() {
  const now = Date.now();
  if (now - lastHeartbeat > 2 * 60 * 1000) {
    const mins = Math.round((now - lastHeartbeat) / 60000);
    wakeGraceUntil = now + 5 * 60 * 1000;
    logActivity('info', `Downtime detected (~${mins} min — sleep or outage). Positions were unmanaged; time exits deferred 5 min while quotes refresh.`);
  }
  lastHeartbeat = now;
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

    if (autopilotOn && !killSwitchActive(now)) {
      // 2. Enter: take planned long/short signals (watch = info only).
      // High-confidence signals go first when slots are scarce.
      const CONF_ORDER = { high: 0, medium: 1, low: 2 };
      const actionable = db.prepare(`SELECT * FROM signals WHERE status = 'new' AND plan_entry IS NOT NULL
        AND direction IN ('long','short') AND created_at > ? ORDER BY created_at DESC`).all(now - 24 * 3600 * 1000)
        .sort((a, b) => (CONF_ORDER[a.confidence] ?? 1) - (CONF_ORDER[b.confidence] ?? 1) || b.created_at - a.created_at);
      for (const s of actionable) {
        // Stocks/ETFs only fill during the US session — an event signal firing
        // Saturday would otherwise book an untradeable weekend gap. The signal
        // stays queued and executes at the next open if still fresh.
        if (!marketOpenFor(s.tv_symbol, now)) continue;
        // Intraday setups go stale in minutes, not hours — a 9:50 breakout
        // means nothing at 11:30.
        if (DAY_RULES.has(s.rule) && now - s.created_at > 30 * 60 * 1000) continue;
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
        // Correlated-cluster cap: four rules all reach for the energy/shipping
        // complex — without this the whole book can become one long-oil bet.
        const cluster = CLUSTER_LIMITS.find((c) => c.symbols.has(s.tv_symbol));
        if (cluster) {
          const inCluster = db.prepare(`SELECT COUNT(*) AS c FROM trades WHERE status = 'open' AND symbol IN (${[...cluster.symbols].map(() => '?').join(',')}) AND COALESCE(strategy,'') != ?`)
            .get(...cluster.symbols, SCALP_RULE).c;
          if (inCluster >= cluster.maxOpen) {
            logActivity('skip', `${cluster.name} cluster already has ${inCluster} open positions — ${s.tv_symbol} stays queued`);
            continue;
          }
        }
        try {
          // Day rules carry their own range/VWAP-derived levels and always tag
          // variant 'base' — ADR exit-style variants don't apply intraday.
          let variant, adj;
          if (DAY_RULES.has(s.rule)) {
            variant = 'base';
            adj = sizeAdjustment(s.rule, 'base');
          } else {
            const pick = pickVariant(s.rule);
            if (!pick) { // defensive — base always has factor > 0
              db.prepare("UPDATE signals SET status = 'skipped' WHERE id = ?").run(s.id);
              logActivity('skip', `All ${s.rule} variants paused — ${s.tv_symbol} not traded`);
              continue;
            }
            variant = pick.name;
            adj = pick.adj;
          }
          if (adj.why) logActivity('info', adj.why);
          const confFactor = CONFIDENCE_SIZE[s.confidence] ?? 1;
          const plan = DAY_RULES.has(s.rule)
            ? await buildDayPlan(s, adj.factor * confFactor)
            : await buildPlan(s.direction, s.rule, s.tv_symbol, STRATEGY_VARIANTS[variant], adj.factor * confFactor);
          // Gross-exposure cap: total deployed notional stays within 1× equity.
          const grossOpen = db.prepare("SELECT COALESCE(SUM(entry_price * qty), 0) AS n FROM trades WHERE status = 'open' AND COALESCE(strategy,'') != ?").get(SCALP_RULE).n;
          if (grossOpen + plan.entry * plan.qty > sizingEquity() * GROSS_EXPOSURE_CAP) {
            logActivity('skip', `Gross exposure cap — ${s.tv_symbol} (${(plan.entry * plan.qty).toFixed(0)}) stays queued until notional frees up`);
            continue;
          }
          // Write the executed plan back so the signal card and history show
          // the trade the autopilot actually took, not the baseline sketch.
          db.prepare('UPDATE signals SET plan_entry = ?, plan_stop = ?, plan_target = ?, plan_qty = ?, horizon_days = ? WHERE id = ?')
            .run(plan.entry, plan.stop, plan.target, plan.qty, plan.horizon, s.id);
          // Honest fill: pay half-spread + slippage on the way in.
          const fill = applyFriction(s.tv_symbol, s.direction, plan.entry, true);
          const entryFriction = Math.abs(fill - plan.entry) * plan.qty;
          db.prepare(`INSERT INTO trades (opened_at, symbol, side, qty, entry_price, stop_price, target_price, expires_at, auto, signal_id, thesis, strategy, variant, fees)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
            .run(now, s.tv_symbol, s.direction, plan.qty, fill, plan.stop, plan.target,
              plan.expiresAt ?? (now + plan.horizon * 24 * 3600 * 1000), s.id, s.headline, s.rule, variant, entryFriction);
          db.prepare("UPDATE signals SET status = 'taken' WHERE id = ?").run(s.id);
          logActivity('open', `AUTO opened ${s.direction} ${plan.qty} ${s.tv_symbol} @ ${fill.toFixed(2)} · stop ${plan.stop.toFixed(2)} · target ${plan.target.toFixed(2)} · ${s.rule}/${variant} · exit by ${new Date(now + plan.horizon * 86400000).toISOString().slice(0, 10)} — ${s.headline}`);
          broadcast('fill', { action: 'open', symbol: s.tv_symbol });
        } catch (err) {
          logActivity('info', `Entry failed for ${s.tv_symbol}: ${err.message}`);
        }
      }
    }

    // 3. Manage: stop / target / time exits on open positions — ALWAYS, even
    // with autopilot paused. Pause means "no new entries", never "abandon the
    // stops on live positions" (the scalper has worked this way all along).
    // The scalper manages its own book on real-time prices — excluded here.
    // COALESCE: NULL-strategy rows must NOT be excluded (SQLite 3VL trap).
    const open = db.prepare("SELECT * FROM trades WHERE status = 'open' AND COALESCE(strategy, '') != ?").all(SCALP_RULE);
    if (open.length) {
      const quotes = await getQuotes([...new Set(open.map((t) => t.symbol))]);
      for (const t of open) {
        // ETFs only exit during the session: out-of-hours the quote is a
        // frozen close no broker would fill at.
        if (!marketOpenFor(t.symbol, now)) continue;
        const q = quotes[t.symbol];
        // Never fill exits on stale or failed quotes — wait for a fresh mark.
        if (!Number.isFinite(q?.price) || q.stale) continue;
        const dir = t.side === 'long' ? 1 : -1;
        // Track excursion extremes: how far each trade ran for/against us.
        // This is the data the stop-tuning evolution actually needs.
        const exc = (q.price - t.entry_price) * dir * t.qty;
        db.prepare("UPDATE trades SET mfe = MAX(COALESCE(mfe, 0), ?), mae = MIN(COALESCE(mae, 0), ?) WHERE id = ? AND status = 'open'")
          .run(exc, exc, t.id);
        let reason = null, raw = q.price;
        if (Number.isFinite(t.stop_price) && (q.price - t.stop_price) * dir <= 0) reason = 'stop hit'; // stop-market: gap-through fills at market
        else if (Number.isFinite(t.target_price) && (q.price - t.target_price) * dir >= 0) { reason = 'target hit'; raw = t.target_price; } // limit fills AT the target
        else if (t.expires_at && now >= t.expires_at && now >= wakeGraceUntil) reason = 'time exit';
        if (reason) {
          const fill = applyFriction(t.symbol, t.side, raw, false);
          closeTrade(t, fill, reason, Math.abs(fill - raw) * t.qty);
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

// ---------------------------------------------------------------- day trading strategies
// Intraday rules on delayed Yahoo 5-minute bars (fine for paper trading):
// opening-range breakout, overnight-gap fade, VWAP reversion on liquid US
// names, plus a London-session FX breakout so at least one account trades a
// market that is not the US equity session. All flat before their session ends.
const DAY_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'AAPL', 'NVDA', 'TSLA'];
const FX_PAIRS = ['EURUSD=X', 'GBPUSD=X', 'AUDUSD=X'];
const intradayCache = new Map(); // symbol -> { bars, at }

async function getIntradayBars(symbol) {
  const hit = intradayCache.get(symbol);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000) return hit.bars;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
  const data = await fetchJson(url, { Accept: 'application/json' });
  const r = data?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!q?.close) throw new Error('no intraday bars');
  const bars = [];
  for (let i = 0; i < q.close.length; i++) {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(Number.isFinite)) {
      bars.push({ ts: r.timestamp[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
    }
  }
  intradayCache.set(symbol, { bars, at: Date.now() });
  return bars;
}

const dayId = (rule, sym, now) => `${rule}:${sym}:${etNow(now).day}`;
const sigExists = (id) => Boolean(db.prepare('SELECT 1 FROM signals WHERE id = ?').get(id));

async function scanDayTrades() {
  const now = Date.now();
  // Unentered intraday setups expire fast instead of lingering in the queue.
  db.prepare(`UPDATE signals SET status = 'expired' WHERE status = 'new' AND created_at < ?
    AND rule IN ('orb-15min', 'gap-fade', 'vwap-revert', 'fx-session')`).run(now - 45 * 60 * 1000);
  const m = etNow(now).minutes;
  const dayStart = etDayStart(now);

  if (usMarketOpen(now)) {
    for (const sym of DAY_UNIVERSE) {
      try {
        const needOrb = m >= 9 * 60 + 47 && m <= 11 * 60 + 30 && !sigExists(dayId('orb-15min', sym, now));
        const needGap = m >= 9 * 60 + 35 && m <= 10 * 60 + 15 && !sigExists(dayId('gap-fade', sym, now));
        const needVwap = m >= 10 * 60 && m <= 15 * 60 && !sigExists(dayId('vwap-revert', sym, now));
        if (!needOrb && !needGap && !needVwap) continue;
        const bars = (await getIntradayBars(sym)).filter((b) => b.ts >= dayStart);
        if (bars.length < 4) continue;
        const last = bars[bars.length - 1];
        const prevC = bars[bars.length - 2].c;
        const q = await getQuote(sym);
        const roughQty = (stop) => Math.max(1, Math.floor((sizingEquity() * RISK_PER_TRADE) / Math.max(Math.abs(last.c - stop), last.c * 0.001)));

        // --- 15-minute opening range breakout ---
        if (needOrb) {
          const or = bars.filter((b) => b.ts >= dayStart + (9 * 60 + 30) * 60000 && b.ts < dayStart + (9 * 60 + 45) * 60000);
          if (or.length >= 2) {
            const orh = Math.max(...or.map((b) => b.h));
            const orl = Math.min(...or.map((b) => b.l));
            const range = orh - orl;
            let dirName = null;
            if (range > 0 && range / last.c < 0.04) {
              if (last.c > orh && prevC <= orh) dirName = 'long';
              else if (last.c < orl && prevC >= orl) dirName = 'short';
            }
            if (dirName) {
              const dir = dirName === 'long' ? 1 : -1;
              const stop = (orh + orl) / 2;
              const target = (dirName === 'long' ? orh : orl) + dir * 1.5 * range;
              makeSignal({
                id: dayId('orb-15min', sym, now), rule: 'orb-15min',
                headline: `${sym}: broke ${dirName === 'long' ? 'above' : 'below'} the 15-min opening range`,
                thesis: `First-15-minutes range ${orl.toFixed(2)}–${orh.toFixed(2)} (${((range / last.c) * 100).toFixed(2)}% wide); price ${last.c.toFixed(2)} broke ${dirName === 'long' ? 'out above the high' : 'down through the low'}. Ride the break with the stop at the range midpoint and a 1.5× range target — flat before the close.`,
                direction: dirName, symbols: [sym], tvSymbol: sym, confidence: 'medium', event: null,
                plan: { entry: last.c, stop, target, qty: roughQty(stop), horizonDays: 0.3 },
              });
            }
          }
        }

        // --- overnight gap fade ---
        if (needGap && Number.isFinite(q.prevClose) && q.prevClose > 0) {
          const open = bars[0].o;
          const gap = (open - q.prevClose) / q.prevClose;
          const still = (last.c - q.prevClose) / q.prevClose;
          if (Math.abs(gap) >= 0.004 && Math.abs(gap) <= 0.03 && Math.sign(still) === Math.sign(gap) && Math.abs(still) >= 0.0025) {
            const dirName = gap > 0 ? 'short' : 'long';
            const dir = dirName === 'long' ? 1 : -1;
            const stop = last.c * (1 - dir * 0.6 * Math.abs(gap));
            makeSignal({
              id: dayId('gap-fade', sym, now), rule: 'gap-fade',
              headline: `${sym}: fading the ${(gap * 100).toFixed(1)}% overnight gap ${gap > 0 ? 'up' : 'down'}`,
              thesis: `${sym} opened at ${open.toFixed(2)}, ${(Math.abs(gap) * 100).toFixed(1)}% ${gap > 0 ? 'above' : 'below'} yesterday's close of ${q.prevClose.toFixed(2)}, and is still stretched. Moderate gaps tend to fill — target the prior close, stop at 60% of the gap beyond entry, flat by the close.`,
              direction: dirName, symbols: [sym], tvSymbol: sym,
              confidence: Math.abs(gap) >= 0.01 ? 'medium' : 'low', event: null,
              plan: { entry: last.c, stop, target: q.prevClose, qty: roughQty(stop), horizonDays: 0.3 },
            });
          }
        }

        // --- VWAP reversion ---
        if (needVwap) {
          let pv = 0, vv = 0;
          for (const b of bars) {
            const tp = (b.h + b.l + b.c) / 3;
            pv += tp * (b.v || 0);
            vv += b.v || 0;
          }
          if (vv > 0) {
            const vwap = pv / vv;
            const dev = (last.c - vwap) / vwap;
            const adr = clamp(q.adrPct ?? 0.015, 0.005, 0.06);
            const thr = Math.max(0.003, 0.35 * adr); // stretch threshold scales with the symbol's volatility
            if (Math.abs(dev) >= thr) {
              const dirName = dev > 0 ? 'short' : 'long';
              const dir = dirName === 'long' ? 1 : -1;
              const dist = Math.abs(last.c - vwap);
              const stop = last.c - dir * 0.6 * dist;
              makeSignal({
                id: dayId('vwap-revert', sym, now), rule: 'vwap-revert',
                headline: `${sym}: ${(Math.abs(dev) * 100).toFixed(2)}% ${dev > 0 ? 'above' : 'below'} VWAP — fading back`,
                thesis: `${sym} at ${last.c.toFixed(2)} is stretched ${(Math.abs(dev) * 100).toFixed(2)}% ${dev > 0 ? 'above' : 'below'} the session VWAP of ${vwap.toFixed(2)} (threshold ${(thr * 100).toFixed(2)}% for this symbol's volatility). Fade toward the institutional anchor — target VWAP, stop at 60% of the stretch beyond entry, flat by the close.`,
                direction: dirName, symbols: [sym], tvSymbol: sym,
                confidence: Math.abs(dev) >= 1.5 * thr ? 'medium' : 'low', event: null,
                plan: { entry: last.c, stop, target: vwap, qty: roughQty(stop), horizonDays: 0.3 },
              });
            }
          }
        }
      } catch (err) {
        console.error(`[day] ${sym}: ${err.message}`);
      }
    }
  }

  // --- London-session FX breakout (the non-US-market account) ---
  if (fxMarketOpen(now) && m >= 4 * 60 + 5 && m <= 10 * 60 + 30) {
    for (const pair of FX_PAIRS) {
      try {
        if (sigExists(dayId('fx-session', pair, now))) continue;
        const bars = (await getIntradayBars(pair)).filter((b) => b.ts >= dayStart);
        const or = bars.filter((b) => b.ts >= dayStart + 3 * 3600000 && b.ts < dayStart + 4 * 3600000);
        if (or.length < 6) continue;
        const orh = Math.max(...or.map((b) => b.h));
        const orl = Math.min(...or.map((b) => b.l));
        const range = orh - orl;
        const after = bars.filter((b) => b.ts >= dayStart + 4 * 3600000);
        if (!after.length || range <= 0) continue;
        const last = after[after.length - 1];
        const prevC = after.length >= 2 ? after[after.length - 2].c : or[or.length - 1].c;
        let dirName = null;
        if (last.c > orh && prevC <= orh) dirName = 'long';
        else if (last.c < orl && prevC >= orl) dirName = 'short';
        if (!dirName) continue;
        const dir = dirName === 'long' ? 1 : -1;
        const stop = (orh + orl) / 2;
        const target = (dirName === 'long' ? orh : orl) + dir * 1.5 * range;
        const name = pair.replace('=X', '');
        makeSignal({
          id: dayId('fx-session', pair, now), rule: 'fx-session',
          headline: `${name}: London-session range break ${dirName}`,
          thesis: `${name} first-hour London range ${orl.toFixed(5)}–${orh.toFixed(5)}; price ${last.c.toFixed(5)} broke ${dirName === 'long' ? 'above' : 'below'} it. Session-momentum hypothesis on a non-US market — stop at the range midpoint, 1.5× range target, flat before the New York lunch. Unleveraged.`,
          direction: dirName, symbols: [pair], tvSymbol: pair, confidence: 'medium', event: null,
          plan: { entry: last.c, stop, target, qty: null, horizonDays: 0.3 },
        });
      } catch (err) {
        console.error(`[day] ${pair}: ${err.message}`);
      }
    }
  }
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
// Costs are modeled honestly: Binance spot taker is ~10 bps per side, and
// fills cross the spread (long entries lift the ask, exits hit the bid).
// scalp_fee_bps in settings overrides for lower fee tiers.
const SCALP = {
  tickMs: 500,                            // decision cadence
  lookbackMs: 90 * 1000,                  // momentum window
  histLen: 360,                           // derived — always covers 2× lookback
  enterBps: 20,
  targetBps: 35,
  stopBps: 22,
  maxHoldMs: 10 * 60 * 1000,
  feeBps: clamp(Number(getSetting('scalp_fee_bps', '10')) || 10, 0, 50), // per side
  notional: 5000,                         // per position, virtual dollars
};
// The history buffer must always cover the momentum lookback — an evolved
// lookback beyond the buffer would otherwise silently disable every entry.
function syncScalpDerived() {
  SCALP.histLen = Math.ceil((SCALP.lookbackMs * 2) / SCALP.tickMs);
}
const PAIR_TO_SYM = new Map(Object.entries(SCALP_PAIRS).map(([s, p]) => [p, s]));
const scalpHist = new Map(); // symbol -> [{ts, price}]

// ---- recursive learning: the scalper evolves in generations ----
// Trades are tagged variant = g<gen>. When a generation accumulates enough
// closed trades, the engine diagnoses HOW it won/lost, mutates the parameters
// directionally, retires the generation, and narrates the lesson.
const EVOLVE_MIN_CLOSED = SCALP_TEST ? 6 : 30;
const SCALP_TUNABLE = ['enterBps', 'targetBps', 'stopBps', 'maxHoldMs', 'lookbackMs'];
// Generation seeds and mutations must derive from these production defaults or
// from persisted params — never from the live SCALP object, which test mode
// overrides at runtime and must not be allowed to poison the stored lineage.
const SCALP_DEFAULTS = Object.freeze(Object.fromEntries(SCALP_TUNABLE.map((k) => [k, SCALP[k]])));
let scalpBase = { ...SCALP_DEFAULTS }; // the active generation's persisted params
let scalpGen = 1;

function applyTestOverrides() {
  if (SCALP_TEST) { SCALP.enterBps = 0.5; SCALP.maxHoldMs = 45 * 1000; }
}

function loadScalpGen() {
  let row = db.prepare("SELECT * FROM strategy_params WHERE rule = ? AND status = 'active' ORDER BY gen DESC LIMIT 1").get(SCALP_RULE);
  if (!row) {
    db.prepare("INSERT INTO strategy_params (rule, gen, params, created_at, activated_at, status, note) VALUES (?, 1, ?, ?, ?, 'active', 'starting parameters')")
      .run(SCALP_RULE, JSON.stringify(SCALP_DEFAULTS), Date.now(), Date.now());
    row = db.prepare("SELECT * FROM strategy_params WHERE rule = ? AND status = 'active'").get(SCALP_RULE);
  }
  scalpBase = { ...SCALP_DEFAULTS, ...JSON.parse(row.params) };
  Object.assign(SCALP, scalpBase);
  syncScalpDerived();
  applyTestOverrides();
  scalpGen = row.gen;
}
db.prepare("UPDATE trades SET variant = 'g1' WHERE strategy = ? AND variant = 'scalp'").run(SCALP_RULE);
// One-time migration to the honest fee model: parameters learned against the
// old 2 bps fee answer the wrong cost question — retire that lineage and
// restart at cost-aware defaults so every future lesson is real.
if (getSetting('fee_model', '1') !== '2') {
  const active = db.prepare("SELECT * FROM strategy_params WHERE rule = ? AND status = 'active' ORDER BY gen DESC LIMIT 1").get(SCALP_RULE);
  if (active) {
    db.prepare("UPDATE strategy_params SET status = 'retired', retired_at = ?, note = COALESCE(note, '') || ' — retired: fee model upgraded to realistic taker costs' WHERE id = ?")
      .run(Date.now(), active.id);
    db.prepare("INSERT INTO strategy_params (rule, gen, params, created_at, activated_at, status, note) VALUES (?, ?, ?, ?, ?, 'active', ?)")
      .run(SCALP_RULE, active.gen + 1, JSON.stringify(SCALP_DEFAULTS), Date.now(), Date.now(),
        'fresh start under the honest cost model: ~10 bps/side taker fee plus spread-crossing fills');
    logActivity('evolve', `Fee model upgraded to realistic Binance taker costs — momo-scalper restarted at gen ${active.gen + 1} (enter ${SCALP_DEFAULTS.enterBps}bps · target ${SCALP_DEFAULTS.targetBps}bps · stop ${SCALP_DEFAULTS.stopBps}bps · hold ${SCALP_DEFAULTS.maxHoldMs / 60000}min). Old-fee generations are marked retired.`);
  }
  setSetting('fee_model', '2');
}
loadScalpGen();

function evolveScalper() {
  const s = db.prepare(`SELECT COUNT(*) AS closed,
      SUM(CASE WHEN ${AUTO_PNL_SQL} > 0 THEN 1 ELSE 0 END) AS wins,
      COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl,
      SUM(CASE WHEN exit_reason = 'scalp stop' THEN 1 ELSE 0 END) AS stops,
      SUM(CASE WHEN exit_reason = 'scalp time' THEN 1 ELSE 0 END) AS timeouts,
      SUM(CASE WHEN exit_reason = 'scalp target' THEN 1 ELSE 0 END) AS targets
    FROM trades WHERE status = 'closed' AND strategy = ? AND variant = ?`).get(SCALP_RULE, `g${scalpGen}`);
  if (s.closed < EVOLVE_MIN_CLOSED) return;
  // Entries stop once the sample is full (see scalperTick), so waiting for the
  // stragglers to close means the generation retires on a complete record and
  // the diagnosis below sees every one of its trades.
  const openLeft = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'open' AND strategy = ? AND variant = ?")
    .get(SCALP_RULE, `g${scalpGen}`).n;
  if (openLeft > 0) return;

  const winRate = s.wins / s.closed;
  db.prepare("UPDATE strategy_params SET trades = ?, pnl = ?, win_rate = ?, retired_at = ?, status = 'retired' WHERE rule = ? AND gen = ?")
    .run(s.closed, s.pnl, winRate, Date.now(), SCALP_RULE, scalpGen);

  const p = Object.fromEntries(SCALP_TUNABLE.map((k) => [k, scalpBase[k]]));
  const reasons = [];
  const jitter = (v, f) => v * (1 + (Math.random() * 2 - 1) * f);
  if (s.pnl < 0) {
    const timeoutShare = s.timeouts / s.closed;
    const stopShare = s.stops / s.closed;
    if (timeoutShare >= 0.5) {
      p.enterBps *= 1.35; p.targetBps *= 0.85;
      reasons.push(`${Math.round(timeoutShare * 100)}% of exits were fee-bleeding time-outs — demanding stronger momentum to enter and taking profit sooner`);
    }
    if (stopShare >= 0.45) {
      p.stopBps *= 1.25; p.enterBps *= 1.15;
      reasons.push(`${Math.round(stopShare * 100)}% stopped out — widening the stop and raising the entry bar`);
    }
    if (!reasons.length) {
      p.enterBps *= 1.25; p.maxHoldMs *= 1.2;
      reasons.push('losing with no dominant exit pattern — trading less and holding winners longer');
    }
  } else {
    for (const k of ['enterBps', 'targetBps', 'stopBps']) p[k] = jitter(p[k], 0.12);
    reasons.push('profitable — exploring nearby parameters to keep improving');
  }
  p.enterBps = clamp(p.enterBps, 5, 80);
  p.targetBps = clamp(p.targetBps, Math.max(15, SCALP.feeBps * 1.5), 150);
  p.stopBps = clamp(p.stopBps, 8, 100);
  p.maxHoldMs = clamp(p.maxHoldMs, 60 * 1000, 45 * 60 * 1000);
  p.lookbackMs = clamp(p.lookbackMs, 20 * 1000, 5 * 60 * 1000);

  const newGen = scalpGen + 1;
  db.prepare("INSERT INTO strategy_params (rule, gen, params, created_at, activated_at, status, note) VALUES (?, ?, ?, ?, ?, 'active', ?)")
    .run(SCALP_RULE, newGen, JSON.stringify(p), Date.now(), Date.now(), reasons.join('; '));
  scalpBase = p;
  Object.assign(SCALP, p);
  syncScalpDerived();
  applyTestOverrides();
  scalpGen = newGen;
  logActivity('evolve', `EVOLVED momo-scalper gen ${newGen - 1} → gen ${newGen} after ${s.closed} trades (P&L ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}, ${Math.round(winRate * 100)}% wins, ${s.targets} targets/${s.stops} stops/${s.timeouts} time-outs). Lesson: ${reasons.join('; ')}. New params: enter ${p.enterBps.toFixed(1)}bps · target ${p.targetBps.toFixed(1)}bps · stop ${p.stopBps.toFixed(1)}bps · hold ${(p.maxHoldMs / 60000).toFixed(1)}min`);
  notify('world-trader: scalper evolved', `Gen ${newGen - 1} retired at ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)} over ${s.closed} trades. ${reasons.join('; ')}`);
  broadcast('fill', { action: 'evolve', symbol: SCALP_RULE });
}

// ---- recursive learning for the slow strategies (daily pass) ----
function evolveSlowRules() {
  for (const rule of Object.keys(STRATEGY_META)) {
    if (rule === SCALP_RULE || rule === 'headline-risk') continue;
    const since = ruleTuning.get(rule)?.updated_at || 0;
    const s = db.prepare(`SELECT COUNT(*) AS closed, COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl,
        SUM(CASE WHEN exit_reason = 'stop hit' THEN 1 ELSE 0 END) AS stops,
        SUM(CASE WHEN exit_reason = 'target hit' THEN 1 ELSE 0 END) AS targets,
        SUM(CASE WHEN exit_reason = 'time exit' THEN 1 ELSE 0 END) AS timeouts
      FROM trades WHERE status = 'closed' AND auto = 1 AND strategy = ? AND closed_at > ?`).get(rule, since);
    if (s.closed < 8) continue;
    const t = ruleTuning.get(rule) || { stop_mult: 1, target_mult: 1, horizon_mult: 1 };
    const reasons = [];
    // Each branch reports honestly when its multiplier is pinned at a bound —
    // the log must never claim an adaptation that changed nothing.
    if (s.pnl < 0 && s.stops / s.closed >= 0.5) {
      const next = clamp(t.stop_mult * 1.2, 0.5, 2.5);
      reasons.push(next !== t.stop_mult
        ? `${s.stops}/${s.closed} recent trades stopped out at a net loss — widening stops`
        : `${s.stops}/${s.closed} stopped out at a net loss but stops are already at their widest — holding steady`);
      t.stop_mult = next;
    } else if (s.pnl < 0 && s.timeouts / s.closed >= 0.5) {
      const next = clamp(t.target_mult * 0.85, 0.4, 2.5);
      reasons.push(next !== t.target_mult
        ? `${s.timeouts}/${s.closed} timed out before reaching the target — bringing targets closer`
        : `${s.timeouts}/${s.closed} timed out but targets are already at their closest — holding steady`);
      t.target_mult = next;
    } else if (s.pnl > 0 && s.targets / s.closed >= 0.5) {
      const next = clamp(t.target_mult * 1.15, 0.4, 2.5);
      reasons.push(next !== t.target_mult
        ? `targets hitting ${s.targets}/${s.closed} — stretching for more`
        : `targets hitting ${s.targets}/${s.closed} with targets already stretched to the cap — holding steady`);
      t.target_mult = next;
    } else {
      continue;
    }
    db.prepare(`INSERT INTO rule_tuning (rule, stop_mult, target_mult, horizon_mult, updated_at, note) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule) DO UPDATE SET stop_mult = excluded.stop_mult, target_mult = excluded.target_mult,
        horizon_mult = excluded.horizon_mult, updated_at = excluded.updated_at, note = excluded.note`)
      .run(rule, t.stop_mult, t.target_mult, t.horizon_mult, Date.now(), reasons.join('; '));
    // Append-only history so the learning trail is auditable — the upsert
    // above keeps only the latest state.
    db.prepare('INSERT INTO rule_tuning_history (rule, ts, stop_mult, target_mult, horizon_mult, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rule, Date.now(), t.stop_mult, t.target_mult, t.horizon_mult, reasons.join('; '));
    t.updated_at = Date.now();
    ruleTuning.set(rule, t);
    logActivity('evolve', `TUNED ${rule} after ${s.closed} closed trades (window P&L ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}). Lesson: ${reasons.join('; ')} → stop×${t.stop_mult.toFixed(2)} · target×${t.target_mult.toFixed(2)}`);
  }
}
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
        if (sym) livePrices.set(sym, { price: (bid + ask) / 2, bid, ask, ts: Date.now() });
      } catch { /* malformed frame */ }
    };
    ws.onclose = retry;
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  };
  connect();
}

// Minute candles per scalp pair, persisted for backtesting/replay. The
// in-progress minute lives in memory; completed minutes flush to SQLite.
const liveCandles = new Map(); // symbol -> { ts, o, h, l, c }
function updateCandle(sym, px, now) {
  const minute = Math.floor(now / 60000) * 60000;
  const cur = liveCandles.get(sym);
  if (!cur || cur.ts !== minute) {
    if (cur) {
      db.prepare('INSERT OR REPLACE INTO candles (symbol, ts, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sym, cur.ts, cur.o, cur.h, cur.l, cur.c);
    }
    liveCandles.set(sym, { ts: minute, o: px, h: px, l: px, c: px });
  } else {
    if (px > cur.h) cur.h = px;
    if (px < cur.l) cur.l = px;
    cur.c = px;
  }
}

async function scalperTick() {
  if (scalperRunning) return;
  scalperRunning = true;
  try {
    const now = Date.now();
    const openScalps = db.prepare("SELECT * FROM trades WHERE status = 'open' AND strategy = ?").all(SCALP_RULE);
    // REST fallback when the websocket goes quiet — and ALWAYS when a symbol
    // we hold a position in has gone stale, so open scalps are never abandoned
    // to a dead feed.
    const staleSym = (s) => { const l = livePrices.get(s); return !l || now - l.ts > 10000; };
    const needRest = livePrices.size === 0
      || [...livePrices.values()].every((p) => now - p.ts > 10000)
      || openScalps.some((t) => staleSym(t.symbol));
    if (needRest && now - lastRestFallback > 15000) {
      lastRestFallback = now;
      try {
        const symsParam = encodeURIComponent(JSON.stringify(Object.values(SCALP_PAIRS)));
        const data = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbols=${symsParam}`);
        for (const d of data) {
          const sym = PAIR_TO_SYM.get(d.symbol);
          const px = parseFloat(d.price);
          if (sym && Number.isFinite(px)) livePrices.set(sym, { price: px, bid: px, ask: px, ts: now });
        }
      } catch { /* next fallback window retries */ }
    }

    {
      // Once the active generation has its full sample, stop opening new
      // positions — stragglers drain and evolveScalper retires it on a
      // complete record instead of freezing stats mid-flight.
      const genFull = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND strategy = ? AND variant = ?")
        .get(SCALP_RULE, `g${scalpGen}`).n >= EVOLVE_MIN_CLOSED;
      const killed = killSwitchActive(now);
      for (const sym of Object.keys(SCALP_PAIRS)) {
        const live = livePrices.get(sym);
        if (!live) continue;
        const tickAge = now - live.ts;
        const px = live.price;
        if (tickAge <= 10000) {
          const hist = scalpHist.get(sym) || [];
          hist.push({ ts: now, price: px });
          while (hist.length > SCALP.histLen) hist.shift();
          while (hist.length && now - hist[0].ts > SCALP.lookbackMs * 2) hist.shift(); // drop pre-gap snapshots
          scalpHist.set(sym, hist);
          updateCandle(sym, px, now);
        }

        // Manage open positions on EVERY tick — a paused scalper must still
        // honor its stops/targets/time-outs. A somewhat-stale mark (≤60s,
        // e.g. REST fallback cadence) still beats abandoning the position.
        const open = openScalps.find((t) => t.symbol === sym);
        if (open) {
          if (tickAge > 60000) continue; // minutes-old marks are not fills
          const dir = open.side === 'long' ? 1 : -1;
          // Exits cross the spread: longs sell the bid, shorts cover at the ask.
          const rawExit = dir === 1 ? (live.bid ?? px) : (live.ask ?? px);
          const exitFill = rawExit * (1 - dir * SCALP.feeBps / 10000);
          const movedBps = ((exitFill - open.entry_price) / open.entry_price) * 10000 * dir;
          const exc = (px - open.entry_price) * dir * open.qty;
          db.prepare("UPDATE trades SET mfe = MAX(COALESCE(mfe, 0), ?), mae = MIN(COALESCE(mae, 0), ?) WHERE id = ? AND status = 'open'")
            .run(exc, exc, open.id);
          let reason = null;
          if (movedBps >= SCALP.targetBps) reason = 'scalp target';
          else if (movedBps <= -SCALP.stopBps) reason = 'scalp stop';
          else if (now - open.opened_at >= SCALP.maxHoldMs) reason = 'scalp time';
          if (reason) closeTrade(open, exitFill, reason, Math.abs(exitFill - px) * open.qty); // closeTrade broadcasts the fill
          continue;
        }

        // Entries need everything: enabled, sample open, no kill switch, fresh tick.
        if (!autopilotOn || !scalperOn || genFull || killed || tickAge > 10000) continue;

        // momentum vs the snapshot ~lookbackMs ago; the baseline must itself
        // be fresh — after a sleep/outage gap, price drift would fake momentum.
        const hist = scalpHist.get(sym) || [];
        const cutoff = now - SCALP.lookbackMs;
        let back = null;
        for (const h of hist) { if (h.ts <= cutoff) back = h; else break; }
        if (!back || now - back.ts > SCALP.lookbackMs * 1.5) continue;
        const momBps = ((px - back.price) / back.price) * 10000;
        if (Math.abs(momBps) < SCALP.enterBps) continue;
        const side = momBps > 0 ? 'long' : 'short';
        const dir = side === 'long' ? 1 : -1;
        // Entries cross the spread too: longs lift the ask, shorts hit the bid.
        const rawEntry = dir === 1 ? (live.ask ?? px) : (live.bid ?? px);
        const fill = rawEntry * (1 + dir * SCALP.feeBps / 10000);
        const qty = +(SCALP.notional / fill).toFixed(6);
        db.prepare(`INSERT INTO trades (opened_at, symbol, side, qty, entry_price, stop_price, target_price, expires_at, auto, signal_id, thesis, strategy, variant, fees)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`)
          .run(now, sym, side, qty, fill,
            fill * (1 - dir * SCALP.stopBps / 10000),
            fill * (1 + dir * SCALP.targetBps / 10000),
            now + SCALP.maxHoldMs,
            `momentum ${momBps.toFixed(1)} bps over ${(SCALP.lookbackMs / 1000).toFixed(0)}s`, SCALP_RULE, `g${scalpGen}`,
            Math.abs(fill - px) * qty);
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
      // A failed quote must not silently drop this position's P&L (fake equity
      // dips) — fall back to the last cached mark, then the entry price.
      const mark = Number.isFinite(quotes[t.symbol]?.price) ? quotes[t.symbol].price
        : (quoteCache.get(t.symbol)?.price ?? t.entry_price);
      const pnl = tradePnl(t, mark);
      if (pnl != null) unrealized += pnl;
    }
  }
  const equity = STARTING_EQUITY + realizedTotal() + unrealized;
  lastMarkedEquity = { ts: now, equity };
  db.prepare('INSERT OR REPLACE INTO equity_snapshots (ts, equity) VALUES (?, ?)').run(now, equity);
  // Snapshots are kept forever — they ARE the long-run performance record.
}

// ---------------------------------------------------------------- backtesting
// Daily-bar backtests for the technical family (fully reproducible from
// history), plus replay of RECORDED live signals for the event family (that
// dataset grows every day the server runs). Same variants, same friction
// model, entry on the NEXT bar's open — no look-ahead.
const barsFetchMemo = new Map(); // symbol -> ts of last remote fetch

async function getBarsRange(symbol, rangeDays = 365) {
  const have = db.prepare('SELECT COUNT(*) AS c, MIN(ts) AS minTs, MAX(ts) AS maxTs FROM bars WHERE symbol = ?').get(symbol);
  const lastFetch = barsFetchMemo.get(symbol) || 0;
  const wantFrom = Date.now() - rangeDays * 86400000;
  // Every clause respects a fetch memo — an unsatisfiable freshness condition
  // (short-history symbol, range the fetch can't cover) must degrade to a
  // periodic retry, never a refetch on every call.
  const memoOk = (ms) => Date.now() - lastFetch > ms;
  const needRemote = (!have.c && memoOk(10 * 60 * 1000))
    || (memoOk(12 * 3600 * 1000) && (!have.maxTs || Date.now() - have.maxTs > 36 * 3600 * 1000))
    || (have.c && have.minTs > wantFrom + 30 * 86400000 && memoOk(12 * 3600 * 1000));
  if (needRemote) {
    barsFetchMemo.set(symbol, Date.now()); // set at attempt so failures back off too
    // The fetched range must actually cover wantFrom, or the minTs clause
    // could never be satisfied.
    const range = rangeDays > 335 ? '2y' : rangeDays > 170 ? '1y' : '6mo';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
    const data = await fetchJson(url, { Accept: 'application/json' });
    const r = data?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (q?.close) {
      const ins = db.prepare('INSERT OR REPLACE INTO bars (symbol, ts, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < q.close.length; i++) {
        // Never store the in-progress session's bar as completed history — a
        // mid-session high/low/close would be served frozen for a day.
        if (i === q.close.length - 1 && Date.now() - r.timestamp[i] * 1000 < 24 * 3600 * 1000) continue;
        if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(Number.isFinite)) {
          ins.run(symbol, r.timestamp[i] * 1000, q.open[i], q.high[i], q.low[i], q.close[i]);
        }
      }
    }
  }
  return db.prepare('SELECT ts, o, h, l, c FROM bars WHERE symbol = ? AND ts >= ? ORDER BY ts').all(symbol, wantFrom);
}

// Where the technical rules would have fired, bar by bar. Mirrors scanTechnicals.
function detectTechSignals(bars, rules) {
  const closes = bars.map((b) => b.c);
  const e5 = emaSeries(closes, 5);
  const e20 = emaSeries(closes, 20);
  const out = [];
  for (let i = 30; i < bars.length - 1; i++) {
    if (rules.includes('ma-cross')) {
      const nowAbove = e5[i] > e20[i];
      if (nowAbove !== (e5[i - 1] > e20[i - 1])) out.push({ i, rule: 'ma-cross', direction: nowAbove ? 'long' : 'short' });
    }
    if (rules.includes('rsi-reversal')) {
      const r2 = rsiLast(closes.slice(Math.max(0, i - 62), i + 1), 2);
      if (r2 != null && (r2 < 10 || r2 > 90)) out.push({ i, rule: 'rsi-reversal', direction: r2 < 10 ? 'long' : 'short' });
    }
    if (rules.includes('breakout-20')) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - 20; k < i; k++) {
        if (bars[k].h > hi) hi = bars[k].h;
        if (bars[k].l < lo) lo = bars[k].l;
      }
      if (closes[i] > hi) out.push({ i, rule: 'breakout-20', direction: 'long' });
      else if (closes[i] < lo) out.push({ i, rule: 'breakout-20', direction: 'short' });
    }
  }
  return out;
}

// One trade, simulated honestly on daily bars: signal at bar i's close, entry
// at bar i+1's OPEN (never the signal close), gap-aware stop/target checks,
// and when both stop and target sit inside one bar we assume the STOP hit
// first (conservative).
function simulateTrade(bars, i, direction, variant, rule, symbol, frictionOn = true) {
  const dir = direction === 'short' ? -1 : 1;
  const entryBar = bars[i + 1];
  if (!entryBar) return null;
  const fric = (price, isEntry) => (frictionOn ? applyFriction(symbol, direction, price, isEntry) : price);
  const win = bars.slice(Math.max(0, i - 4), i + 1);
  const adr = clamp(win.reduce((s, b) => s + (b.h - b.l) / b.c, 0) / win.length, 0.008, 0.06);
  const rawEntry = entryBar.o;
  const entry = fric(rawEntry, true);
  const stopDist = rawEntry * clamp(variant.stopAdr * adr, 0.01, 0.08);
  const stop = entry - dir * stopDist;
  const target = entry + dir * variant.targetR * stopDist;
  const horizonDays = Math.max(1, Math.round((RULE_HORIZON_DAYS[rule] ?? 2) * variant.horizonMult));
  const fin = (reason, rawExit, ts, stillOpen = false) => {
    const exit = fric(rawExit, false);
    return {
      openedAt: entryBar.ts, closedAt: ts, entry, exit, reason, stillOpen, stopDist,
      pnlPerShare: (exit - entry) * dir,
      frictionPerShare: frictionOn ? Math.abs(entry - rawEntry) + Math.abs(exit - rawExit) : 0,
    };
  };
  for (let j = i + 1; j < bars.length; j++) {
    const b = bars[j];
    if (j > i + 1) {
      // Overnight gaps fill at the open: through the stop that is worse than
      // the stop, through the target it is better (a resting limit order).
      if (dir === 1 ? b.o <= stop : b.o >= stop) return fin('stop hit (gap)', b.o, b.ts);
      if (dir === 1 ? b.o >= target : b.o <= target) return fin('target hit (gap)', b.o, b.ts);
    }
    if (dir === 1 ? b.l <= stop : b.h >= stop) return fin('stop hit', stop, b.ts);
    if (dir === 1 ? b.h >= target : b.l <= target) return fin('target hit', target, b.ts);
    if (j - (i + 1) >= horizonDays) return fin('time exit', b.c, b.ts);
  }
  const lastB = bars[bars.length - 1];
  return fin('still open at range end', lastB.c, lastB.ts, true);
}

// $100k account per rule: 1% risk sizing, 15% notional cap — like the live
// autopilot. Trades overlap across symbols, so sizing at open may only see
// P&L from trades already CLOSED by that moment (no look-ahead), and the
// equity curve / drawdown are booked in close order (chronological reality).
function accountSim(trades, base = 100000) {
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const closedSoFar = []; // { ts, pnl } of already-sized trades
  let friction = 0, taken = 0;
  for (const t of sorted) {
    let equityAtOpen = base;
    for (const c of closedSoFar) if (c.ts <= t.openedAt) equityAtOpen += c.pnl;
    let qty = Math.floor((equityAtOpen * 0.01) / t.stopDist);
    qty = Math.min(qty, Math.floor((equityAtOpen * MAX_POSITION_FRACTION) / t.entry));
    if (qty < 1) { if (t.stopDist <= equityAtOpen * 0.02) qty = 1; else { t.qty = 0; continue; } }
    t.qty = qty;
    t.pnl = t.pnlPerShare * qty;
    friction += t.frictionPerShare * qty;
    taken++;
    closedSoFar.push({ ts: t.closedAt, pnl: t.pnl });
  }
  const seq = sorted.filter((t) => t.qty).sort((a, b) => a.closedAt - b.closedAt);
  let equity = base, peak = base, maxDD = 0, wins = 0, grossWin = 0, grossLoss = 0;
  const curve = [{ ts: seq.length ? Math.min(...sorted.filter((t) => t.qty).map((t) => t.openedAt)) : Date.now(), balance: base }];
  for (const t of seq) {
    equity += t.pnl;
    if (t.pnl > 0) { wins++; grossWin += t.pnl; } else grossLoss += -t.pnl;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDD) maxDD = equity - peak;
    curve.push({ ts: t.closedAt, balance: equity });
  }
  const ds = curve.length > 600 ? curve.filter((_, i) => i % Math.ceil(curve.length / 600) === 0).concat([curve[curve.length - 1]]) : curve;
  return {
    trades: taken, pnl: equity - base, endEquity: equity,
    winRate: taken ? wins / taken : null,
    // 'inf' sentinel: JSON.stringify turns Infinity into null, which would be
    // indistinguishable from no-data on the client and in stored runs.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 'inf' : null),
    maxDrawdown: maxDD,
    frictionPaid: friction,
    avgHoldDays: taken ? seq.reduce((s, t) => s + (t.closedAt - t.openedAt) / 86400000, 0) / taken : null,
    curve: ds,
    tradeLog: seq.slice(-300).map((t) => ({
      symbol: t.symbol, side: t.direction, openedAt: t.openedAt, closedAt: t.closedAt,
      entry: +t.entry.toFixed(4), exit: +t.exit.toFixed(4), qty: t.qty, pnl: +t.pnl.toFixed(2), reason: t.reason,
    })),
  };
}

const TECH_RULES = ['ma-cross', 'rsi-reversal', 'breakout-20'];

async function runTechnicalBacktest(opts = {}) {
  const rules = (opts.rules || []).filter((r) => TECH_RULES.includes(r));
  const useRules = rules.length ? rules : TECH_RULES;
  const symbols = (opts.symbols || []).map((s) => String(s).toUpperCase()).filter((s) => /^[A-Z^.-]{1,10}$/.test(s));
  const useSymbols = symbols.length ? symbols.slice(0, 24) : TECH_UNIVERSE;
  const variantName = STRATEGY_VARIANTS[opts.variant] ? opts.variant : 'base';
  const rangeDays = clamp(Number(opts.rangeDays) || 365, 60, 730);
  const frictionOn = opts.friction !== false;
  const perRule = Object.fromEntries(useRules.map((r) => [r, []]));
  const errors = [];
  for (const sym of useSymbols) {
    let bars;
    try { bars = await getBarsRange(sym, rangeDays); } catch (err) { errors.push(`${sym}: ${err.message}`); continue; }
    if (bars.length < 40) { errors.push(`${sym}: only ${bars.length} bars`); continue; }
    const busy = {}; // rule -> busy-until ts (one open position per symbol per rule, like live)
    for (const s of detectTechSignals(bars, useRules)) {
      if (bars[s.i].ts < (busy[s.rule] || 0)) continue;
      const t = simulateTrade(bars, s.i, s.direction, STRATEGY_VARIANTS[variantName], s.rule, sym, frictionOn);
      if (!t || t.stillOpen) continue;
      busy[s.rule] = t.closedAt;
      perRule[s.rule].push({ ...t, symbol: sym, direction: s.direction });
    }
  }
  const results = {};
  for (const rule of useRules) results[rule] = accountSim(perRule[rule]);
  return { mode: 'technical', variant: variantName, rangeDays, friction: frictionOn, symbols: useSymbols, rules: useRules, base: 100000, errors, results };
}

// Replay every recorded live signal (event + technical families) against the
// bars that followed it. Young today; more decisive every week the engine runs.
async function replayRecordedSignals(opts = {}) {
  const variantName = STRATEGY_VARIANTS[opts.variant] ? opts.variant : 'base';
  const frictionOn = opts.friction !== false;
  const rows = db.prepare("SELECT * FROM signals WHERE direction IN ('long','short') ORDER BY created_at").all()
    .filter((s) => !DAY_RULES.has(s.rule)); // intraday setups can't be replayed on daily bars
  const perRule = {};
  const errors = [];
  for (const s of rows) {
    try {
      const ageDays = Math.ceil((Date.now() - s.created_at) / 86400000) + 40;
      const bars = await getBarsRange(s.tv_symbol, Math.min(730, Math.max(90, ageDays)));
      let i = bars.findIndex((b) => b.ts > s.created_at) - 1;
      if (i < 5 || i + 1 >= bars.length) continue; // signal too recent — no next bar yet
      const t = simulateTrade(bars, i, s.direction, STRATEGY_VARIANTS[variantName], s.rule, s.tv_symbol, frictionOn);
      if (!t || t.stillOpen) continue;
      (perRule[s.rule] ??= []).push({ ...t, symbol: s.tv_symbol, direction: s.direction });
    } catch (err) {
      errors.push(`${s.tv_symbol}: ${err.message}`);
    }
  }
  const results = {};
  for (const [rule, trades] of Object.entries(perRule)) results[rule] = accountSim(trades);
  return { mode: 'signals', variant: variantName, friction: frictionOn, base: 100000, signalCount: rows.length, errors: errors.slice(0, 10), results };
}

// Counterfactual scoring for signals the autopilot did NOT take — the cheapest
// honest answer to "is the gating saving or costing money?"
async function scoreUntakenSignals() {
  // Newest first: permanently unscoreable stragglers must never starve fresh
  // signals out of the LIMITed batch.
  const rows = db.prepare(`SELECT * FROM signals WHERE outcome_pnl IS NULL AND direction IN ('long','short')
    AND status IN ('expired', 'dismissed', 'skipped') AND created_at < ?
    AND rule NOT IN ('orb-15min', 'gap-fade', 'vwap-revert', 'fx-session')
    ORDER BY created_at DESC LIMIT 15`).all(Date.now() - 3 * 86400000);
  for (const s of rows) {
    try {
      // Window sized from the signal's age so old signals stay scoreable.
      const ageDays = Math.ceil((Date.now() - s.created_at) / 86400000) + 40;
      const bars = await getBarsRange(s.tv_symbol, Math.min(730, Math.max(90, ageDays)));
      let i = bars.findIndex((b) => b.ts > s.created_at) - 1;
      if (i === -2) continue; // no completed bar after the signal yet — retry later
      if (i < 5) {
        // Fewer than 5 bars of history before the signal even at an age-sized
        // window — mark it so the row leaves the queue instead of clogging it.
        db.prepare("UPDATE signals SET outcome_pnl = 0, outcome_note = 'unscoreable — insufficient bar history' WHERE id = ?").run(s.id);
        continue;
      }
      if (i + 1 >= bars.length) continue; // too recent — next bar not final yet
      const t = simulateTrade(bars, i, s.direction, STRATEGY_VARIANTS.base, s.rule, s.tv_symbol, true);
      if (!t || t.stillOpen) continue;
      const qty = s.plan_qty || Math.max(1, Math.floor(10000 / t.entry));
      db.prepare('UPDATE signals SET outcome_pnl = ?, outcome_note = ? WHERE id = ?')
        .run(+(t.pnlPerShare * qty).toFixed(2), `would-have-been: ${t.reason} after ${((t.closedAt - t.openedAt) / 86400000).toFixed(1)}d`, s.id);
    } catch { /* retry next pass */ }
  }
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
  if (rel === 'backtest') rel = 'backtest.html';
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
      const { id, undo } = await readBody(req);
      if (undo) db.prepare("UPDATE signals SET status = 'new' WHERE id = ? AND status = 'dismissed'").run(String(id));
      else db.prepare("UPDATE signals SET status = 'dismissed' WHERE id = ? AND status = 'new'").run(String(id));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/quotes' && req.method === 'GET') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
      if (!symbols.length) return json(res, 400, { error: 'symbols required' });
      return json(res, 200, { quotes: await getQuotes(symbols) });
    }
    if (p === '/api/trades' && req.method === 'GET') {
      // Summary aggregates run in SQL; the row list is capped in SQL too —
      // the old version loaded the whole table per request while the scalper
      // grows it by hundreds of rows a day.
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 400;
      const openRows = db.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC").all();
      const closedRows = db.prepare("SELECT * FROM trades WHERE status = 'closed' ORDER BY opened_at DESC LIMIT ?").all(limit);
      const quotes = openRows.length ? await getQuotes([...new Set(openRows.map((t) => t.symbol))]) : {};
      const enrich = (t) => {
        const q = quotes[t.symbol];
        const pnl = tradePnl(t, q?.price);
        return { ...t, mark: t.status === 'closed' ? t.exit_price : q?.price ?? null, pnl };
      };
      const open = openRows.map(enrich);
      const agg = db.prepare(`SELECT COUNT(*) AS closedCount,
          COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS realized,
          SUM(CASE WHEN ${AUTO_PNL_SQL} > 0 THEN 1 ELSE 0 END) AS wins,
          COALESCE(SUM(CASE WHEN auto = 1 THEN ${AUTO_PNL_SQL} END), 0) AS autoRealized,
          SUM(CASE WHEN auto = 1 THEN 1 ELSE 0 END) AS autoClosed,
          COALESCE(SUM(fees), 0) AS fees
        FROM trades WHERE status = 'closed'`).get();
      const unrealized = open.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const autoOpen = open.filter((t) => t.auto);
      const todayRealized = db.prepare(`SELECT COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS s, COUNT(*) AS c FROM trades WHERE status = 'closed' AND closed_at >= ?`)
        .get(etDayStart(Date.now()));
      const trades = [...open, ...closedRows.map(enrich)].sort((a, b) => b.opened_at - a.opened_at).slice(0, limit);
      return json(res, 200, {
        trades,
        total: agg.closedCount + open.length,
        summary: {
          openCount: open.length, closedCount: agg.closedCount,
          realized: agg.realized, unrealized,
          equity: STARTING_EQUITY + agg.realized + unrealized,
          startingEquity: STARTING_EQUITY,
          winRate: agg.closedCount ? agg.wins / agg.closedCount : null,
          autopilot: autopilotOn,
          claudePnl: agg.autoRealized + autoOpen.reduce((s, t) => s + (t.pnl ?? 0), 0),
          claudeCount: agg.autoClosed + autoOpen.length,
          todayRealized: todayRealized.s, todayTrades: todayRealized.c,
          feesPaid: agg.fees,
          grossExposure: open.reduce((s, t) => s + t.entry_price * t.qty, 0),
          marketOpen: usMarketOpen(),
          killSwitch: killSwitchActive(),
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
    if (p === '/api/evolution' && req.method === 'GET') {
      // The active generation's row shows its RUNNING record, not dashes —
      // otherwise there is no way to judge the current lesson against history.
      const liveStats = db.prepare(`SELECT variant, COUNT(*) AS trades, COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl,
          SUM(CASE WHEN ${AUTO_PNL_SQL} > 0 THEN 1 ELSE 0 END) AS wins
        FROM trades WHERE status = 'closed' AND strategy = ? GROUP BY variant`).all(SCALP_RULE);
      const liveByGen = new Map(liveStats.map((r) => [r.variant, r]));
      return json(res, 200, {
        generations: db.prepare('SELECT * FROM strategy_params ORDER BY rule, gen').all()
          .map((r) => {
            const out = { ...r, params: JSON.parse(r.params) };
            if (r.status === 'active') {
              const live = liveByGen.get(`g${r.gen}`);
              if (live) { out.trades = live.trades; out.pnl = live.pnl; out.win_rate = live.trades ? live.wins / live.trades : null; }
            }
            return out;
          }),
        tuning: db.prepare('SELECT * FROM rule_tuning ORDER BY rule').all(),
        tuningHistory: db.prepare('SELECT * FROM rule_tuning_history ORDER BY id DESC LIMIT 100').all(),
        log: db.prepare("SELECT * FROM activity WHERE kind = 'evolve' ORDER BY id DESC LIMIT 50").all(),
      });
    }
    if (p === '/api/benchmark' && req.method === 'GET') {
      // SPY buy-and-hold from the same start, scaled to $100k — the honest
      // "what if we did nothing" line for the strategy accounts.
      const daysRaw = Number(url.searchParams.get('days'));
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 730) : 90;
      const bars = await getBarsRange('SPY', days);
      if (!bars.length) return json(res, 200, { curve: [] });
      const base = 100000 / bars[0].c;
      return json(res, 200, { symbol: 'SPY', curve: bars.map((b) => ({ ts: b.ts, balance: +(b.c * base).toFixed(2) })) });
    }
    if (p === '/api/daily-pnl' && req.method === 'GET') {
      const rule = url.searchParams.get('rule');
      const days = rule
        ? db.prepare(`SELECT strftime('%Y-%m-%d', closed_at / 1000, 'unixepoch') AS day,
              COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl, COUNT(*) AS trades
            FROM trades WHERE status = 'closed' AND strategy = ? GROUP BY day ORDER BY day`).all(rule)
        : db.prepare(`SELECT strftime('%Y-%m-%d', closed_at / 1000, 'unixepoch') AS day,
              COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl, COUNT(*) AS trades
            FROM trades WHERE status = 'closed' GROUP BY day ORDER BY day`).all();
      return json(res, 200, { days });
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
        // Hyperactive strategies produce thousands of curve points — downsample
        // (cap high enough that client-side range filtering keeps resolution).
        if (curve.length > 2000) {
          const step = Math.ceil(curve.length / 2000);
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
      return json(res, 200, {
        aisstream_key: mask(aisKey), wm_api_key: mask(wmKey), scalper: scalperOn,
        webhook_url: webhookUrl,
        risk_per_trade: RISK_PER_TRADE * 100,
        max_positions: MAX_OPEN_POSITIONS,
        scalp_fee_bps: SCALP.feeBps,
        scalp_notional: SCALP.notional,
      });
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
      if (typeof b.webhook_url === 'string') {
        webhookUrl = b.webhook_url.trim();
        setSetting('webhook_url', webhookUrl);
        if (webhookUrl) {
          logActivity('info', 'Notification webhook saved — alerts will POST there (fills digest, kill switch, evolutions)');
          notify('world-trader connected', 'Notifications are working. You will get evolution lessons, kill-switch alerts, and a daily digest here.');
        } else logActivity('info', 'Notification webhook removed');
      }
      if (Number.isFinite(Number(b.risk_per_trade)) && Number(b.risk_per_trade) > 0) {
        RISK_PER_TRADE = clamp(Number(b.risk_per_trade) / 100, 0.001, 0.05);
        setSetting('risk_per_trade', String(RISK_PER_TRADE * 100));
        logActivity('info', `Risk per trade set to ${(RISK_PER_TRADE * 100).toFixed(2)}% of equity`);
      }
      if (Number.isFinite(Number(b.max_positions)) && Number(b.max_positions) > 0) {
        MAX_OPEN_POSITIONS = clamp(Math.round(Number(b.max_positions)), 1, 30);
        setSetting('max_positions', String(MAX_OPEN_POSITIONS));
        logActivity('info', `Max open positions set to ${MAX_OPEN_POSITIONS}`);
      }
      if (Number.isFinite(Number(b.scalp_fee_bps))) {
        SCALP.feeBps = clamp(Number(b.scalp_fee_bps), 0, 50);
        setSetting('scalp_fee_bps', String(SCALP.feeBps));
        logActivity('info', `Scalper fee model set to ${SCALP.feeBps} bps per side`);
      }
      if (Number.isFinite(Number(b.scalp_notional)) && Number(b.scalp_notional) > 0) {
        SCALP.notional = clamp(Number(b.scalp_notional), 100, 50000);
        setSetting('scalp_notional', String(SCALP.notional));
        logActivity('info', `Scalper notional set to $${SCALP.notional} per position`);
      }
      const mask = (k) => (k ? `••••••••${k.slice(-4)}` : '');
      return json(res, 200, { ok: true, aisstream_key: mask(aisKey), wm_api_key: mask(wmKey) });
    }
    if (p === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        uptimeSec: Math.round((Date.now() - bootTs) / 1000),
        autopilot: autopilotOn, scalper: scalperOn,
        marketOpen: usMarketOpen(), killSwitch: killSwitchActive(),
        equity: lastMarkedEquity.equity,
        lastEventRefresh: eventCache.fetchedAt, feedErrors: eventCache.errors,
        sseClients: sseClients.size,
        scalpGen, scalpParams: { ...scalpBase, feeBps: SCALP.feeBps },
        wakeGraceUntil,
      });
    }
    if (p === '/api/export.json' && req.method === 'GET') {
      const dump = {
        exportedAt: new Date().toISOString(),
        startingEquity: STARTING_EQUITY,
        trades: db.prepare('SELECT * FROM trades ORDER BY opened_at').all(),
        signals: db.prepare('SELECT * FROM signals ORDER BY created_at').all(),
        equity: db.prepare('SELECT * FROM equity_snapshots ORDER BY ts').all(),
        generations: db.prepare('SELECT * FROM strategy_params ORDER BY rule, gen').all(),
        tuning: db.prepare('SELECT * FROM rule_tuning ORDER BY rule').all(),
        tuningHistory: db.prepare('SELECT * FROM rule_tuning_history ORDER BY id').all(),
        activity: db.prepare('SELECT * FROM activity ORDER BY id').all(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="world-trader-export.json"' });
      return res.end(JSON.stringify(dump));
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
          COALESCE(SUM(CASE WHEN status = 'closed' AND ${AUTO_PNL_SQL} < 0 THEN ${AUTO_PNL_SQL} END), 0) AS grossLoss,
          COALESCE(SUM(CASE WHEN status = 'closed' THEN fees END), 0) AS fees,
          AVG(CASE WHEN status = 'closed' THEN closed_at - opened_at END) AS avgHoldMs,
          AVG(CASE WHEN status = 'closed' AND ${AUTO_PNL_SQL} > 0 THEN ${AUTO_PNL_SQL} END) AS avgWin,
          AVG(CASE WHEN status = 'closed' AND ${AUTO_PNL_SQL} < 0 THEN ${AUTO_PNL_SQL} END) AS avgLoss,
          AVG(CASE WHEN status = 'closed' THEN mfe END) AS avgMfe,
          AVG(CASE WHEN status = 'closed' THEN mae END) AS avgMae
        FROM trades WHERE auto = 1 GROUP BY strategy, variant ORDER BY realized DESC`).all();
      // Max drawdown per strategy from the realized P&L sequence.
      const seq = db.prepare(`SELECT strategy, ${AUTO_PNL_SQL} AS pnl FROM trades WHERE status = 'closed' AND auto = 1 ORDER BY closed_at`).all();
      const dd = {}, cum = {}, peak = {};
      for (const r of seq) {
        const k = r.strategy || 'manual';
        cum[k] = (cum[k] || 0) + r.pnl;
        peak[k] = Math.max(peak[k] ?? 0, cum[k]);
        dd[k] = Math.min(dd[k] ?? 0, cum[k] - peak[k]);
      }
      return json(res, 200, { performance: rows, drawdowns: dd });
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
      const live = await getQuote(symbol).catch(() => null);
      if (!Number.isFinite(entry) || entry <= 0) {
        if (!live || live.stale || !Number.isFinite(live.price)) return json(res, 400, { error: `no fresh quote for ${symbol} — market order unavailable right now` });
        entry = applyFriction(symbol, side, live.price, true);
      } else if (live && Number.isFinite(live.price) && Math.abs(entry - live.price) / live.price > 0.05) {
        // Fabricated off-market fills would flow straight into headline equity.
        return json(res, 400, { error: `entry ${entry} is >5% from the live price ${live.price.toFixed(2)} — fills must be near the market` });
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
      const live = await getQuote(t.symbol).catch(() => null);
      if (!Number.isFinite(exit) || exit <= 0) {
        if (!live || live.stale || !Number.isFinite(live.price)) return json(res, 400, { error: `no fresh quote for ${t.symbol} — try again shortly` });
        exit = applyFriction(t.symbol, t.side, live.price, false);
      } else if (live && Number.isFinite(live.price) && Math.abs(exit - live.price) / live.price > 0.05) {
        return json(res, 400, { error: `exit ${exit} is >5% from the live price ${live.price.toFixed(2)} — fills must be near the market` });
      }
      closeTrade(t, exit, 'manual close');
      return json(res, 200, { ok: true, exit_price: exit });
    }
    if (p === '/api/backtest' && req.method === 'POST') {
      const b = await readBody(req);
      const result = b.mode === 'signals' ? await replayRecordedSignals(b) : await runTechnicalBacktest(b);
      const info = db.prepare('INSERT INTO backtests (created_at, label, params, results) VALUES (?, ?, ?, ?)')
        .run(Date.now(), String(b.label || '').slice(0, 80) || null,
          JSON.stringify({ mode: b.mode || 'technical', rules: b.rules, symbols: b.symbols, rangeDays: b.rangeDays, variant: b.variant, friction: b.friction }),
          JSON.stringify(result));
      logActivity('info', `Backtest #${info.lastInsertRowid} complete — ${result.mode} mode, ${Object.keys(result.results).length} strategies scored`);
      return json(res, 200, { id: Number(info.lastInsertRowid), created_at: Date.now(), ...result });
    }
    if (p === '/api/backtests' && req.method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      if (Number.isFinite(id) && id > 0) {
        const row = db.prepare('SELECT * FROM backtests WHERE id = ?').get(id);
        if (!row) return json(res, 404, { error: 'backtest not found' });
        return json(res, 200, { id: row.id, created_at: row.created_at, label: row.label, params: JSON.parse(row.params), ...JSON.parse(row.results) });
      }
      return json(res, 200, {
        backtests: db.prepare('SELECT id, created_at, label, params FROM backtests ORDER BY id DESC LIMIT 50').all()
          .map((r) => ({ ...r, params: JSON.parse(r.params) })),
      });
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

// ---- daily digest (just after the US close) ----
let digestDay = '';
function maybeDailyDigest() {
  const pnow = etNow();
  if (pnow.weekend || pnow.minutes < 16 * 60 + 5 || digestDay === pnow.day) return;
  digestDay = pnow.day;
  const t = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(${AUTO_PNL_SQL}), 0) AS pnl FROM trades WHERE status = 'closed' AND closed_at >= ?`)
    .get(etDayStart(Date.now()));
  const openC = db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'open'").get().c;
  const msg = `Today: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} over ${t.c} closed trades · ${openC} open · equity ${lastMarkedEquity.equity ? '$' + lastMarkedEquity.equity.toFixed(0) : '—'}`;
  logActivity('info', `Daily digest — ${msg}`);
  notify('world-trader daily digest', msg);
}

// ---- nightly maintenance: checkpoint, backup, prune tick candles ----
function nightlyMaintenance() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = path.join(ROOT, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data.db'), path.join(dir, `data-${new Date().toISOString().slice(0, 10)}.db`));
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('data-')).sort();
    while (files.length > 14) fs.unlinkSync(path.join(dir, files.shift()));
    db.prepare('DELETE FROM candles WHERE ts < ?').run(Date.now() - 30 * 86400000);
    console.log('[maint] WAL checkpoint + backup complete');
  } catch (e) { console.error('[maint] failed:', e.message); }
}

server.listen(PORT, HOST, () => {
  console.log(`world-trader listening on http://${HOST}:${PORT}  (paper trading only — no real money · autopilot ${autopilotOn ? 'ON' : 'OFF'} · market ${usMarketOpen() ? 'OPEN' : 'closed'})`);
  refreshEvents()
    .then(() => autopilotTick())
    .catch((e) => console.error('[events] initial refresh failed:', e.message));
  setInterval(() => refreshEvents().catch((e) => console.error('[events] refresh failed:', e.message)), EVENT_REFRESH_MS);
  setInterval(() => autopilotTick(), 60 * 1000);
  refreshPortwatch().catch((e) => console.error('[portwatch] initial fetch failed:', e.message));
  setInterval(() => refreshPortwatch().catch((e) => console.error('[portwatch] refresh failed:', e.message)), 12 * 3600 * 1000);
  scanTechnicals().catch((e) => console.error('[tech] initial scan failed:', e.message));
  setInterval(() => scanTechnicals().catch((e) => console.error('[tech] scan failed:', e.message)), 60 * 60 * 1000);
  scanDayTrades().catch((e) => console.error('[day] initial scan failed:', e.message));
  setInterval(() => scanDayTrades().catch((e) => console.error('[day] scan failed:', e.message)), 3 * 60 * 1000);
  startBinanceStream();
  setInterval(() => scalperTick(), SCALP.tickMs);
  setInterval(() => { try { evolveScalper(); } catch (e) { console.error('[evolve] scalper:', e.message); } }, 60 * 1000);
  setInterval(() => { try { evolveSlowRules(); } catch (e) { console.error('[evolve] rules:', e.message); } }, 6 * 3600 * 1000);
  setInterval(heartbeat, 15 * 1000);
  setInterval(maybeDailyDigest, 5 * 60 * 1000);
  nightlyMaintenance();
  setInterval(nightlyMaintenance, 24 * 3600 * 1000);
  setInterval(() => scoreUntakenSignals().catch((e) => console.error('[score] failed:', e.message)), 3600 * 1000);
  console.log(`[scalper] ${scalperOn ? 'active' : 'paused'} — ${Object.keys(SCALP_PAIRS).length} pairs streaming, decisions every ${SCALP.tickMs}ms, fees ${SCALP.feeBps}bps/side${SCALP_TEST ? ' (TEST MODE)' : ''}`);
  if (aisKey) startAisStream();
});
