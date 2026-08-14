import { el, api, fmtPnl, fmtPrice, timeAgo } from '/shared.js';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Balance-over-time mini chart with the $100k base as a dashed reference line.
function balanceCurve(curve, base, w = 300, h = 84) {
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = mk('svg', { viewBox: `0 0 ${w} ${h}`, class: 'balance-curve' });
  const pad = 6;
  const xs = curve.map((p) => p.ts);
  const ys = curve.map((p) => p.balance).concat([base]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxY - minY, base * 0.004); // keep flat curves visibly flat, not zoomed to noise
  const mid = (maxY + minY) / 2;
  minY = mid - span / 2 - span * 0.15;
  maxY = mid + span / 2 + span * 0.15;
  const X = (t) => pad + ((t - minX) / (maxX - minX || 1)) * (w - pad * 2);
  const Y = (v) => pad + ((maxY - v) / (maxY - minY)) * (h - pad * 2);
  svg.append(mk('line', { x1: pad, x2: w - pad, y1: Y(base), y2: Y(base), stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4,4', opacity: 0.5 }));
  const last = curve[curve.length - 1].balance;
  const color = last > base ? 'var(--up)' : last < base ? 'var(--down)' : 'var(--muted)';
  const pts = curve.map((p) => `${X(p.ts).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');
  svg.append(mk('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const lastPt = curve[curve.length - 1];
  svg.append(mk('circle', { cx: X(lastPt.ts), cy: Y(lastPt.balance), r: 3, fill: color }));
  return svg;
}

function card(a, base) {
  const delta = a.balance - base;
  return el('div', { class: 'strategy-card clickable', onclick: () => { location.hash = a.rule; } },
    el('div', { class: 'head' },
      el('h3', {}, a.title),
      a.watchOnly ? el('span', { class: 'chip' }, 'watch-only') : el('span', { class: 'chip auto' }, 'auto-trades'),
    ),
    el('div', { class: 'balance-row' },
      el('span', { class: 'balance' }, moneyFmt.format(a.balance)),
      el('span', { class: `delta ${delta > 0 ? 'pnl-up' : delta < 0 ? 'pnl-down' : 'dim'}` }, delta === 0 ? '±$0' : fmtPnl(delta)),
    ),
    balanceCurve(a.curve, base),
    el('div', { class: 'stats' },
      [`${a.closedCount + a.openCount} trade${a.closedCount + a.openCount === 1 ? '' : 's'}`,
        a.openCount ? `${a.openCount} open` : null,
        a.winRate != null ? `${Math.round(a.winRate * 100)}% win` : null,
      ].filter(Boolean).join(' · ') || 'no trades yet',
    ),
    el('p', { class: 'desc' }, a.description),
  );
}

const FAMILIES = [
  ['event', 'Event-driven — world data', 'Signals from worldmonitor.app events, news threat scores, and IMF PortWatch ship counts.'],
  ['tech', 'Technical — price action', 'Classic rules scanned hourly over 12 liquid ETFs: momentum, mean reversion, breakouts. The control group.'],
  ['hyper', 'Day trading — hyperactive', 'Real-time crypto scalping, dozens to hundreds of round trips a day, fees baked into every fill.'],
];

// ---- detail view: click a card to see just that strategy ----
function detailCurve(curve, base) {
  const w = 900, h = 230, padL = 62, padR = 14, padT = 14, padB = 24;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = mk('svg', { viewBox: `0 0 ${w} ${h}`, class: 'equity-chart' });
  const xs = curve.map((p) => p.ts);
  const ys = curve.map((p) => p.balance).concat([base]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxY - minY, base * 0.002);
  const mid = (maxY + minY) / 2;
  minY = mid - span * 0.65;
  maxY = mid + span * 0.65;
  const X = (t) => padL + ((t - minX) / (maxX - minX || 1)) * (w - padL - padR);
  const Y = (v) => padT + ((maxY - v) / (maxY - minY)) * (h - padT - padB);
  for (const v of [minY, base, maxY]) {
    svg.append(mk('line', { x1: padL, x2: w - padR, y1: Y(v), y2: Y(v), stroke: v === base ? 'var(--muted)' : 'var(--grid)', 'stroke-width': 1, 'stroke-dasharray': v === base ? '4,4' : 'none', opacity: v === base ? 0.55 : 1 }));
    svg.append(mk('text', { x: padL - 6, y: Y(v) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, '$' + Math.round(v).toLocaleString()));
  }
  const last = curve[curve.length - 1].balance;
  const color = last > base ? 'var(--up)' : last < base ? 'var(--down)' : 'var(--accent)';
  const pts = curve.map((p) => `${X(p.ts).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');
  svg.append(mk('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  const fmtT = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  svg.append(mk('text', { x: padL, y: h - 7, fill: 'var(--muted)', 'font-size': 11 }, fmtT(minX)));
  svg.append(mk('text', { x: w - padR, y: h - 7, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, fmtT(maxX)));
  return svg;
}

let tradesCache = null;
let tradesCacheAt = 0;
async function strategyTrades(rule) {
  if (!tradesCache || Date.now() - tradesCacheAt > 30000) {
    tradesCache = (await api('/api/trades')).trades;
    tradesCacheAt = Date.now();
  }
  return tradesCache.filter((t) => t.strategy === rule);
}

async function renderDetail(a, base) {
  const grid = document.getElementById('grid');
  const delta = a.balance - base;
  const tile = (label, value, cls = '') => el('div', { class: 'tile' },
    el('div', { class: 'label' }, label),
    el('div', { class: `value ${cls}` }, value));
  grid.replaceChildren(
    el('div', { class: 'detail-head' },
      el('button', { class: 'btn', onclick: () => { location.hash = ''; } }, '← All strategies'),
      el('h2', {}, a.title),
      a.watchOnly ? el('span', { class: 'chip' }, 'watch-only') : el('span', { class: 'chip auto' }, 'auto-trades'),
    ),
    el('p', { class: 'strategies-intro' }, a.description),
    el('div', { class: 'tiles' },
      tile('Balance', moneyFmt.format(a.balance)),
      tile('P&L', fmtPnl(delta), delta > 0 ? 'up' : delta < 0 ? 'down' : ''),
      tile('Unrealized', fmtPnl(a.unrealized), a.unrealized > 0 ? 'up' : a.unrealized < 0 ? 'down' : ''),
      tile('Trades', String(a.openCount + a.closedCount)),
      tile('Win rate', a.winRate == null ? '—' : `${Math.round(a.winRate * 100)}%`),
    ),
    el('div', { class: 'panel', style: 'padding: 10px 14px' }, detailCurve(a.curve, base)),
  );
  try {
    const trades = await strategyTrades(a.rule);
    if (trades.length) {
      const table = el('table', { class: 'mini-table' },
        el('thead', {}, el('tr', {}, ...['Side', 'Symbol', 'Qty', 'Entry', 'Exit', 'P&L', 'Opened', 'Exit reason'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...trades.slice(0, 200).map((t) => el('tr', {},
          el('td', { class: t.side === 'long' ? 'pnl-up' : 'pnl-down', style: 'text-align:left' }, t.side),
          el('td', { style: 'text-align:left; font-weight:600' }, t.symbol),
          el('td', {}, t.qty),
          el('td', {}, fmtPrice(t.entry_price)),
          el('td', {}, t.exit_price != null ? fmtPrice(t.exit_price) : '—'),
          el('td', { class: Number.isFinite(t.pnl) ? (t.pnl >= 0 ? 'pnl-up' : 'pnl-down') : '' }, fmtPnl(t.pnl)),
          el('td', { class: 'dim' }, timeAgo(t.opened_at)),
          el('td', { class: 'dim', style: 'text-align:left' }, t.status === 'closed' ? (t.exit_reason || 'closed') : 'open'),
        ))),
      );
      grid.append(el('div', { class: 'panel' },
        el('h2', {}, `Trades (${trades.length}${trades.length > 200 ? ', latest 200 shown' : ''})`),
        el('div', { style: 'overflow-x:auto' }, table)));
    }
  } catch { /* trades table optional */ }
}

function renderGrid(d) {
  const grid = document.getElementById('grid');
  grid.replaceChildren();
  for (const [family, title, sub] of FAMILIES) {
    const members = d.accounts.filter((a) => a.family === family);
    if (!members.length) continue;
    grid.append(el('div', { class: 'family-head' },
      el('h2', {}, title),
      el('span', { class: 'dim-note' }, sub),
    ));
    grid.append(el('div', { class: 'family-grid' }, ...members.map((a) => card(a, d.base))));
  }
}

let dataCache = null;
async function load() {
  try {
    dataCache = await api('/api/strategy-accounts');
    route();
    document.getElementById('status').textContent = `${dataCache.accounts.filter((a) => !a.watchOnly).length} live strategies`;
  } catch (err) {
    document.getElementById('status').textContent = `error: ${err.message}`;
  }
}

function route() {
  if (!dataCache) return;
  const rule = decodeURIComponent(location.hash.slice(1));
  const account = rule ? dataCache.accounts.find((a) => a.rule === rule) : null;
  if (account) renderDetail(account, dataCache.base);
  else renderGrid(dataCache);
}

window.addEventListener('hashchange', route);
load();
setInterval(load, 30 * 1000);
