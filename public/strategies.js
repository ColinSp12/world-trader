import { el, api, fmtPnl, renderTradeLogList } from '/shared.js';

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
const RANGES = [
  ['1D', 24 * 3600e3], ['2D', 48 * 3600e3], ['1W', 7 * 86400e3],
  ['1M', 30 * 86400e3], ['3M', 90 * 86400e3], ['All', null],
];
let detailRange = '1D';

// Window the curve to a range, carrying the prior balance in as an anchor
// point so the line always spans the full window.
function rangedCurve(curve, rangeMs) {
  if (!rangeMs) return curve;
  const start = Date.now() - rangeMs;
  const before = curve.filter((p) => p.ts < start);
  const inRange = curve.filter((p) => p.ts >= start);
  const anchorBal = before.length ? before[before.length - 1].balance : (inRange[0]?.balance ?? curve[0].balance);
  const pts = [{ ts: start, balance: anchorBal }, ...inRange];
  return pts.length >= 2 ? pts : curve.slice(-2);
}

const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function detailCurve(curve, base, onHover, onLeave) {
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
  const first = curve[0].balance;
  const color = last > first ? 'var(--up)' : last < first ? 'var(--down)' : 'var(--accent)';
  const linePts = curve.map((p) => `${X(p.ts).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');
  svg.append(mk('polygon', { points: `${X(minX).toFixed(1)},${Y(minY)} ${linePts} ${X(maxX).toFixed(1)},${Y(minY)}`, fill: color, opacity: 0.07 }));
  svg.append(mk('polyline', { points: linePts, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  svg.append(mk('text', { x: padL, y: h - 7, fill: 'var(--muted)', 'font-size': 11 }, fmtWhen(minX)));
  svg.append(mk('text', { x: w - padR, y: h - 7, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, fmtWhen(maxX)));
  // hover crosshair — value/date surface in the header, Wealthsimple-style
  const cross = mk('line', { y1: padT, y2: h - padB, stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0 });
  const dot = mk('circle', { r: 4, fill: color, opacity: 0 });
  svg.append(cross, dot);
  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (w / rect.width);
    let best = curve[0];
    for (const p of curve) if (Math.abs(X(p.ts) - px) < Math.abs(X(best.ts) - px)) best = p;
    cross.setAttribute('x1', X(best.ts)); cross.setAttribute('x2', X(best.ts)); cross.setAttribute('opacity', 0.5);
    dot.setAttribute('cx', X(best.ts)); dot.setAttribute('cy', Y(best.balance)); dot.setAttribute('opacity', 1);
    if (onHover) onHover(best);
  });
  svg.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
    if (onLeave) onLeave();
  });
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

  // ---- Wealthsimple-style chart card: big value header + range pills ----
  const windowed = rangedCurve(a.curve, RANGES.find(([k]) => k === detailRange)?.[1] ?? null);
  const winStart = windowed[0];
  const winDelta = a.balance - winStart.balance;
  const winPct = winStart.balance ? (winDelta / winStart.balance) * 100 : 0;
  const deltaText = (d, pct, label) =>
    `${fmtPnl(d)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${label}`;
  const valEl = el('div', { class: 'chart-val' }, moneyFmt.format(a.balance));
  const deltaEl = el('div', {
    class: `chart-delta ${winDelta > 0 ? 'pnl-up' : winDelta < 0 ? 'pnl-down' : 'dim'}`,
  }, deltaText(winDelta, winPct, detailRange === 'All' ? 'all time' : `past ${detailRange}`));
  const onHover = (p) => {
    valEl.textContent = moneyFmt.format(p.balance);
    const d = p.balance - winStart.balance;
    const pc = winStart.balance ? (d / winStart.balance) * 100 : 0;
    deltaEl.className = `chart-delta ${d > 0 ? 'pnl-up' : d < 0 ? 'pnl-down' : 'dim'}`;
    deltaEl.textContent = deltaText(d, pc, fmtWhen(p.ts));
  };
  const onLeave = () => {
    valEl.textContent = moneyFmt.format(a.balance);
    deltaEl.className = `chart-delta ${winDelta > 0 ? 'pnl-up' : winDelta < 0 ? 'pnl-down' : 'dim'}`;
    deltaEl.textContent = deltaText(winDelta, winPct, detailRange === 'All' ? 'all time' : `past ${detailRange}`);
  };
  const pills = el('span', { class: 'tabbtns range-pills' },
    ...RANGES.map(([key]) => el('button', {
      class: key === detailRange ? 'active' : '',
      onclick: () => { detailRange = key; renderDetail(a, base); },
    }, key)));
  const chartCard = el('div', { class: 'panel chart-card' },
    el('div', { class: 'chart-card-head' },
      el('div', {}, valEl, deltaEl),
      pills,
    ),
    detailCurve(windowed, base, onHover, onLeave),
  );

  const mainCol = el('div', { class: 'detail-main' },
    el('div', { class: 'detail-head' },
      el('button', { class: 'btn', onclick: () => { location.hash = ''; } }, '← All strategies'),
      el('h2', {}, a.title),
      a.watchOnly ? el('span', { class: 'chip' }, 'watch-only') : el('span', { class: 'chip auto' }, 'auto-trades'),
    ),
    el('p', { class: 'strategies-intro' }, a.description),
    el('div', { class: 'tiles' },
      tile('P&L', fmtPnl(delta), delta > 0 ? 'up' : delta < 0 ? 'down' : ''),
      tile('Unrealized', fmtPnl(a.unrealized), a.unrealized > 0 ? 'up' : a.unrealized < 0 ? 'down' : ''),
      tile('Trades', String(a.openCount + a.closedCount)),
      tile('Win rate', a.winRate == null ? '—' : `${Math.round(a.winRate * 100)}%`),
    ),
    chartCard,
  );

  const tapeBox = el('div', { class: 'scroll' });
  const tape = el('section', { class: 'panel detail-tape' },
    el('h2', {}, 'Live fills'),
    tapeBox,
  );
  grid.replaceChildren(el('div', { class: 'detail-layout' }, mainCol, tape));

  try {
    const trades = await strategyTrades(a.rule);
    renderTradeLogList(tapeBox, trades, 200);
  } catch {
    tapeBox.append(el('div', { class: 'empty' }, 'Fills unavailable right now.'));
  }
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

// live fills: refresh the page data the moment a trade happens
let fillTimer = null;
const es = new EventSource('/api/stream');
es.onmessage = (ev) => {
  try {
    const d = JSON.parse(ev.data);
    if (d.type === 'fill') {
      clearTimeout(fillTimer);
      fillTimer = setTimeout(() => { tradesCacheAt = 0; load(); }, 1500);
    }
  } catch { /* ignore */ }
};
