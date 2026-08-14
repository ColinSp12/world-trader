import { el, api, fmtPnl, famDot, renderTradeLogList } from '/shared.js';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Fixed categorical palette for the compare overlay (never cycled).
const COMPARE_COLORS = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#d0a215', '#c65f9c'];

// ---- compare view: normalized % overlay + sortable leaderboard ----
let leaderSort = 'pnl';
function compareOverlay(accounts, base) {
  const active = accounts.filter((a) => !a.watchOnly && a.curve.length >= 2);
  const top = [...active].sort((x, y) => Math.abs(y.balance - base) - Math.abs(x.balance - base)).slice(0, 6);
  if (top.length < 2) return null;
  const w = 900, h = 190, padL = 46, padR = 92, padT = 10, padB = 20;
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const minX = Math.min(...top.map((a) => a.curve[0].ts));
  const maxX = Date.now();
  const pct = (b) => ((b - base) / base) * 100;
  let minY = 0, maxY = 0;
  for (const a of top) for (const p of a.curve) { minY = Math.min(minY, pct(p.balance)); maxY = Math.max(maxY, pct(p.balance)); }
  const span = Math.max(maxY - minY, 0.1);
  minY -= span * 0.1; maxY += span * 0.1;
  const X = (t) => padL + ((t - minX) / (maxX - minX || 1)) * (w - padL - padR);
  const Y = (v) => padT + ((maxY - v) / (maxY - minY)) * (h - padT - padB);
  const svg = mk('svg', { viewBox: `0 0 ${w} ${h}`, class: 'equity-chart', role: 'img', 'aria-label': 'strategy return comparison' });
  svg.append(mk('line', { x1: padL, x2: w - padR, y1: Y(0), y2: Y(0), stroke: 'var(--muted)', 'stroke-dasharray': '4,4', opacity: 0.5, 'stroke-width': 1 }));
  svg.append(mk('text', { x: padL - 5, y: Y(0) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10.5 }, '0%'));
  for (const v of [minY + span * 0.1, maxY - span * 0.1]) {
    svg.append(mk('text', { x: padL - 5, y: Y(v) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10.5 }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`));
  }
  top.forEach((a, i) => {
    const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
    const pts = [...a.curve.map((p) => `${X(p.ts).toFixed(1)},${Y(pct(p.balance)).toFixed(1)}`),
      `${X(maxX).toFixed(1)},${Y(pct(a.balance)).toFixed(1)}`].join(' ');
    svg.append(mk('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', opacity: 0.9 }));
    svg.append(mk('circle', { cx: X(maxX), cy: Y(pct(a.balance)), r: 2.5, fill: color }));
    svg.append(mk('text', { x: X(maxX) + 5, y: Y(pct(a.balance)) + 3.5, fill: color, 'font-size': 10.5 },
      `${a.title.length > 14 ? a.title.slice(0, 13) + '…' : a.title} ${pct(a.balance) >= 0 ? '+' : ''}${pct(a.balance).toFixed(2)}%`));
  });
  return el('div', { class: 'panel' },
    el('h2', {}, 'Head to head — % return on $100k'),
    svg,
    el('div', { class: 'dim-note' }, 'Top movers overlaid on one % scale — the honest comparison the individual cards cannot give you.'));
}

function leaderboard(accounts, base, perf) {
  const rows = accounts.filter((a) => !a.watchOnly);
  const dd = perf?.drawdowns || {};
  const sorters = {
    pnl: (x, y) => (y.balance - base) - (x.balance - base),
    win: (x, y) => (y.winRate ?? -1) - (x.winRate ?? -1),
    trades: (x, y) => (y.closedCount + y.openCount) - (x.closedCount + x.openCount),
    dd: (x, y) => (dd[x.rule] ?? 0) - (dd[y.rule] ?? 0),
  };
  rows.sort(sorters[leaderSort] || sorters.pnl);
  const head = (label, key) => el('th', {
    class: leaderSort === key ? 'sortable active' : 'sortable',
    role: 'button', tabindex: 0,
    onclick: () => { leaderSort = key; route(); },
  }, label + (leaderSort === key ? ' ↓' : ''));
  return el('div', { class: 'panel' },
    el('h2', {}, 'Leaderboard'),
    el('div', { style: 'overflow-x:auto' }, el('table', { class: 'mini-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', { style: 'text-align:left' }, 'Strategy'),
        head('P&L', 'pnl'), head('Win rate', 'win'), head('Trades', 'trades'), head('Max DD', 'dd'))),
      el('tbody', {}, ...rows.map((a, i) => {
        const delta = a.balance - base;
        return el('tr', { class: 'clickable', onclick: () => { location.hash = a.rule; } },
          el('td', {}, String(i + 1)),
          el('td', { style: 'text-align:left' }, famDot(a.rule), ` ${a.title}`),
          el('td', { class: delta > 0 ? 'pnl-up' : delta < 0 ? 'pnl-down' : '' }, fmtPnl(delta)),
          el('td', {}, a.winRate != null ? `${Math.round(a.winRate * 100)}% (n=${a.closedCount})` : '—'),
          el('td', {}, String(a.closedCount + a.openCount)),
          el('td', { class: dd[a.rule] < 0 ? 'pnl-down' : '' }, dd[a.rule] != null ? fmtPnl(dd[a.rule]) : '—'));
      })))));
}

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
  return el('div', {
    class: `strategy-card clickable fam-border-${a.family}`,
    role: 'button', tabindex: 0, 'aria-label': `open ${a.title} detail`,
    onclick: () => { location.hash = a.rule; },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = a.rule; } },
  },
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
        a.winRate != null ? `${Math.round(a.winRate * 100)}% win (n=${a.closedCount})` : null,
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

function detailCurve(curve, base, onHover, onLeave, benchmark = null, markers = []) {
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
  // SPY buy-and-hold benchmark, rebased to the window's starting balance —
  // the "what if we did nothing" line.
  if (benchmark?.length >= 2) {
    const inWin = benchmark.filter((p) => p.ts >= minX - 86400e3 && p.ts <= maxX);
    if (inWin.length >= 2) {
      const scale = first / inWin[0].balance;
      const clampY = (v) => Math.min(Math.max(v, minY), maxY);
      const bPts = inWin.map((p) => `${X(Math.max(p.ts, minX)).toFixed(1)},${Y(clampY(p.balance * scale)).toFixed(1)}`).join(' ');
      svg.append(mk('polyline', { points: bPts, fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.4, 'stroke-dasharray': '5,4', opacity: 0.75 }));
      const bl = inWin[inWin.length - 1];
      svg.append(mk('text', { x: X(bl.ts) - 4, y: Y(clampY(bl.balance * scale)) - 5, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10.5 }, 'SPY'));
    }
  }
  // Evolution moments: violet markers where a new generation went live.
  for (const m of markers) {
    if (m.ts < minX || m.ts > maxX) continue;
    svg.append(mk('line', { x1: X(m.ts), x2: X(m.ts), y1: padT, y2: h - padB, stroke: 'var(--hyper, #9085e9)', 'stroke-width': 1, opacity: 0.5, 'stroke-dasharray': '2,3' }));
    const tri = mk('path', { d: `M ${X(m.ts) - 4} ${h - padB} L ${X(m.ts) + 4} ${h - padB} L ${X(m.ts)} ${h - padB - 7} Z`, fill: 'var(--hyper, #9085e9)' });
    tri.append(mk('title', {}, m.label));
    svg.append(tri);
  }
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
  // Generation-activation markers on the curve — connect "the engine changed
  // parameters" to "the curve changed shape".
  const genMarkers = (evoCache?.generations || [])
    .filter((g) => g.rule === a.rule && g.activated_at)
    .map((g) => ({ ts: g.activated_at, label: `gen ${g.gen} activated — ${(g.note || '').slice(0, 120)}` }));
  const chartCard = el('div', { class: 'panel chart-card' },
    el('div', { class: 'chart-card-head' },
      el('div', {}, valEl, deltaEl),
      pills,
    ),
    detailCurve(windowed, base, onHover, onLeave, benchCache, genMarkers),
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

  // generation history — the recursive-learning trail for this strategy
  const gens = (evoCache?.generations || []).filter((g) => g.rule === a.rule);
  if (gens.length) {
    const fmtParams = (p) => `enter ${p.enterBps?.toFixed(1)}bps · tgt ${p.targetBps?.toFixed(1)} · stop ${p.stopBps?.toFixed(1)} · hold ${(p.maxHoldMs / 60000).toFixed(1)}m`;
    mainCol.append(el('div', { class: 'panel' },
      el('h2', {}, `Generations — the strategy evolving (${gens.length})`),
      el('div', { style: 'overflow-x:auto' }, el('table', { class: 'mini-table' },
        el('thead', {}, el('tr', {}, ...['Gen', 'Status', 'Parameters', 'Trades', 'P&L', 'Win %', 'Lesson learned'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...gens.map((g) => el('tr', {},
          el('td', { style: 'text-align:left; font-weight:600' }, `g${g.gen}`),
          el('td', { style: 'text-align:left' }, g.status === 'active' ? '● live' : 'retired'),
          el('td', { style: 'text-align:left; font-size:11px' }, fmtParams(g.params)),
          el('td', {}, g.status === 'retired' ? g.trades : '—'),
          el('td', { class: g.status === 'retired' ? (g.pnl > 0 ? 'pnl-up' : g.pnl < 0 ? 'pnl-down' : '') : '' }, g.status === 'retired' ? fmtPnl(g.pnl) : '—'),
          el('td', {}, g.win_rate != null ? `${Math.round(g.win_rate * 100)}%` : '—'),
          el('td', { style: 'text-align:left; font-size:11px; max-width: 300px; white-space: normal' }, g.note || ''),
        ))),
      )),
    ));
  }
  const tune = (evoCache?.tuning || []).find((t) => t.rule === a.rule);
  if (tune) {
    mainCol.append(el('div', { class: 'panel', style: 'padding: 10px 14px' },
      el('div', { class: 'dim-note' }, `🧠 learned tuning: stop×${tune.stop_mult.toFixed(2)} · target×${tune.target_mult.toFixed(2)} — ${tune.note || ''}`)));
  }

  // This strategy's own daily P&L calendar + its slice of the learning log.
  try {
    const daily = await api(`/api/daily-pnl?rule=${encodeURIComponent(a.rule)}`);
    if (daily.days?.length) mainCol.append(heatmap(daily.days, `Daily P&L — ${a.title}`));
  } catch { /* calendar is optional */ }
  const myLog = (evoCache?.log || []).filter((l) => l.message.includes(a.rule)).slice(0, 12);
  if (myLog.length) mainCol.append(learningLog(myLog, `🧠 Learning log — ${a.title}`));

  const tapeBox = el('div', { class: 'scroll' });
  const tape = el('section', { class: 'panel detail-tape' },
    el('h2', {}, 'Live fills'),
    tapeBox,
  );
  grid.replaceChildren(el('div', { class: 'detail-layout' }, mainCol, tape));

  try {
    const trades = await strategyTrades(a.rule);
    // flashKey keeps new-fill flashes working across re-renders (the tape box
    // element is recreated every render, so a WeakMap key would never match).
    renderTradeLogList(tapeBox, trades, 200, `tape-${a.rule}`);
  } catch {
    tapeBox.append(el('div', { class: 'empty' }, 'Fills unavailable right now.'));
  }
}

// ---- daily P&L calendar heatmap (GitHub-style) ----
function heatmap(days, title = 'Daily P&L — last 12 weeks') {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const grid = el('div', { class: 'heatmap' });
  const monthRow = el('div', { class: 'hm-months' });
  // Step in UTC epoch days — the server buckets /api/daily-pnl by UTC day, and
  // local-time stepping duplicates/skips a day when the window spans a DST shift.
  const todayUtc = Math.floor(Date.now() / 86400000);
  let lastMonth = '';
  for (let w = 11; w >= 0; w--) {
    // Month label above the column where a new month starts.
    const colTop = new Date((todayUtc - (w * 7 + 6)) * 86400000);
    const mLabel = colTop.toLocaleString(undefined, { month: 'short' });
    monthRow.append(el('span', { class: 'hm-month' }, mLabel !== lastMonth ? mLabel : ''));
    lastMonth = mLabel;
    const col = el('div', { class: 'hm-col' });
    for (let d = 6; d >= 0; d--) {
      const key = new Date((todayUtc - (w * 7 + d)) * 86400000).toISOString().slice(0, 10);
      const rec = byDay.get(key);
      const cell = el('span', {
        class: 'hm-cell',
        title: rec ? `${key}: ${rec.pnl >= 0 ? '+' : '−'}$${Math.abs(rec.pnl).toFixed(2)} · ${rec.trades} trade${rec.trades === 1 ? '' : 's'}` : key,
      });
      if (rec && rec.pnl !== 0) {
        const a = 0.3 + 0.7 * Math.min(1, Math.abs(rec.pnl) / maxAbs);
        cell.style.background = rec.pnl > 0 ? `rgba(12, 163, 12, ${a.toFixed(2)})` : `rgba(208, 59, 59, ${a.toFixed(2)})`;
      }
      col.append(cell);
    }
    grid.append(col);
  }
  return el('div', { class: 'panel hm-panel' },
    el('h2', {}, title),
    monthRow,
    grid,
    el('div', { class: 'dim-note' }, 'green = profitable day · red = losing day · intensity = size (UTC days)'));
}

// ---- learning log: the engine narrating what it changed and why ----
function learningLog(items, title = '🧠 Learning log') {
  return el('div', { class: 'panel' },
    el('h2', {}, title),
    el('div', { class: 'scroll', style: 'max-height: 240px' },
      ...items.map((a) => el('div', { class: 'act act-evolve' },
        el('span', { class: 'act-time' }, new Date(a.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        el('span', { class: 'act-icon' }, '◆'),
        el('span', {}, a.message)))),
  );
}

function renderGrid(d) {
  const grid = document.getElementById('grid');
  grid.replaceChildren();
  const overlay = compareOverlay(d.accounts, d.base);
  if (overlay) grid.append(overlay);
  grid.append(leaderboard(d.accounts, d.base, perfCache));
  if (dailyCache?.days?.length) grid.append(heatmap(dailyCache.days));
  for (const [family, title, sub] of FAMILIES) {
    const members = d.accounts.filter((a) => a.family === family);
    if (!members.length) continue;
    grid.append(el('div', { class: 'family-head' },
      el('h2', {}, title),
      el('span', { class: 'dim-note' }, sub),
    ));
    grid.append(el('div', { class: 'family-grid' }, ...members.map((a) => card(a, d.base))));
  }
  if (evoCache?.log?.length) grid.append(learningLog(evoCache.log));
}

let dataCache = null;
let evoCache = null;
let dailyCache = null;
let perfCache = null;
let benchCache = null;
async function load() {
  if (document.hidden) return; // no point polling a hidden tab
  try {
    [dataCache, evoCache, dailyCache, perfCache] = await Promise.all([
      api('/api/strategy-accounts'), api('/api/evolution'), api('/api/daily-pnl'),
      api('/api/performance').catch(() => null),
    ]);
    if (!benchCache) {
      api('/api/benchmark?days=180').then((b) => { benchCache = b.curve; }).catch(() => {});
    }
    route();
    document.getElementById('status').textContent = `${dataCache.accounts.filter((a) => !a.watchOnly).length} live strategies`;
  } catch (err) {
    document.getElementById('status').textContent = `error: ${err.message}`;
  }
}

function route() {
  if (!dataCache) return;
  let rule = '';
  try { rule = decodeURIComponent(location.hash.slice(1)); } catch { rule = ''; } // a malformed hash must not blank the page
  const account = rule ? dataCache.accounts.find((a) => a.rule === rule) : null;
  if (account) renderDetail(account, dataCache.base);
  else renderGrid(dataCache);
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
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
