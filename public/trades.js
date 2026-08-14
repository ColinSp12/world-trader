import { el, api, timeAgo, fmtPnl, fmtPrice, safeUrl, renderTradeLogList, famDot } from '/shared.js';

let currentSymbol = 'USO';
let signalsCache = [];
let activeSignalId = null;

// ---- TradingView chart ----
// The free embed widgets have no runtime setSymbol API; the officially
// documented pattern is to recreate the container + config script per symbol.
function loadChart(symbol) {
  currentSymbol = symbol.toUpperCase().trim();
  document.getElementById('chart-symbol').textContent = currentSymbol;
  const outer = document.getElementById('tv-chart');
  outer.replaceChildren();

  const container = el('div', { class: 'tradingview-widget-container', style: 'height:100%;width:100%' },
    el('div', { class: 'tradingview-widget-container__widget', style: 'height:calc(100% - 24px);width:100%' }),
    el('div', { class: 'tradingview-widget-copyright', style: 'font-size:11px;padding:2px 8px' },
      el('a', { href: 'https://www.tradingview.com/', rel: 'noopener nofollow', target: '_blank' }, 'Charts by TradingView')),
  );
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.innerHTML = JSON.stringify({
    autosize: true,
    symbol: currentSymbol,
    interval: '60',
    timezone: 'exchange',
    theme: 'dark',
    style: '1',
    locale: 'en',
    withdateranges: true,
    allow_symbol_change: true,
    save_image: false,
    calendar: false,
    support_host: 'https://www.tradingview.com',
  });
  container.append(script);
  outer.append(container);
  highlightWatchlist();
}

// ---- watchlist ----
const WATCHLIST = ['SPY', 'QQQ', 'USO', 'XLE', 'GLD', 'UNG', 'VIXY', 'ITA', 'FRO', 'ZIM', 'EWT', 'BTCUSD'];
{
  const wl = document.getElementById('watchlist');
  for (const sym of WATCHLIST) {
    wl.append(el('button', { class: 'sym-btn', dataset: { sym }, onclick: () => loadChart(sym) }, sym));
  }
}
function highlightWatchlist() {
  document.querySelectorAll('#watchlist .sym-btn').forEach((b) => b.classList.toggle('active', b.dataset.sym === currentSymbol));
}

document.getElementById('load-symbol').addEventListener('click', () => {
  const v = document.getElementById('symbol-input').value.trim();
  if (v) loadChart(v);
});
document.getElementById('symbol-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) loadChart(v); }
});

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// ---- toasts ----
function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const t = el('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('gone'); setTimeout(() => t.remove(), 400); }, 6500);
  while (box.children.length > 4) box.firstChild.remove();
}

// ---- settings dialog ----
const settingsDlg = document.getElementById('settings-dialog');
document.getElementById('open-settings').addEventListener('click', async () => {
  try {
    const s = await api('/api/settings');
    for (const [id, val] of [['set-ais', s.aisstream_key], ['set-wm', s.wm_api_key]]) {
      const input = document.getElementById(id);
      input.value = '';
      input.placeholder = val || 'not set';
    }
    document.getElementById('set-scalper').checked = Boolean(s.scalper);
  } catch { /* dialog still usable */ }
  settingsDlg.showModal();
});
document.getElementById('set-scalper').addEventListener('change', async (e) => {
  await api('/api/settings', { method: 'POST', body: { scalper: e.target.checked } });
  toast(`Crypto scalper ${e.target.checked ? 'enabled' : 'paused'}`);
});
document.getElementById('close-settings').addEventListener('click', () => settingsDlg.close());
document.getElementById('save-settings').addEventListener('click', async () => {
  const body = {};
  const ais = document.getElementById('set-ais').value.trim();
  const wm = document.getElementById('set-wm').value.trim();
  if (ais) body.aisstream_key = ais;
  if (wm) body.wm_api_key = wm;
  if (!Object.keys(body).length) { settingsDlg.close(); return; }
  try {
    await api('/api/settings', { method: 'POST', body });
    toast(body.aisstream_key ? 'Saved — ships switching to global chokepoint coverage (check the Map)' : 'Settings saved');
    settingsDlg.close();
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  }
});
document.getElementById('clear-ais').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/settings', { method: 'POST', body: { aisstream_key: null } });
  document.getElementById('set-ais').placeholder = 'not set';
  toast('aisstream key cleared — ships back to Baltic demo');
});
document.getElementById('clear-wm').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/settings', { method: 'POST', body: { wm_api_key: null } });
  document.getElementById('set-wm').placeholder = 'not set';
  toast('WorldMonitor key cleared');
});

// ---- suggested trades (plan cards) ----
function planRow(s) {
  if (!Number.isFinite(s.plan_entry)) {
    return el('div', { class: 'plan-meta' }, 'pricing plan… (next engine tick)');
  }
  const risk = Math.abs(s.plan_entry - s.plan_stop) * s.plan_qty;
  const rMult = Math.abs(s.plan_target - s.plan_entry) / (Math.abs(s.plan_entry - s.plan_stop) || 1);
  const exitBy = new Date(Date.now() + s.horizon_days * 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return el('div', {},
    el('div', { class: 'plan-row' },
      el('div', { class: 'kv' }, el('span', {}, 'Entry'), el('b', {}, fmtPrice(s.plan_entry))),
      el('div', { class: 'kv' }, el('span', {}, 'Stop'), el('b', { class: 'stop' }, fmtPrice(s.plan_stop))),
      el('div', { class: 'kv' }, el('span', {}, 'Target'), el('b', { class: 'target' }, fmtPrice(s.plan_target))),
      el('div', { class: 'kv' }, el('span', {}, 'Size'), el('b', {}, s.plan_qty)),
    ),
    el('div', { class: 'plan-meta' }, `risk ~$${risk.toFixed(0)} for ${rMult.toFixed(1)}R reward · auto-exit by ${exitBy} or at stop/target`),
  );
}

function renderSignals() {
  const box = document.getElementById('signals');
  box.replaceChildren();
  const fresh = signalsCache.filter((s) => s.status === 'new');
  document.getElementById('sig-count').textContent = fresh.length ? `(${fresh.length})` : '';
  if (!fresh.length) {
    box.append(el('div', { class: 'empty' }, 'Queue is clear — actionable signals are auto-traded within a minute and move to Positions. New signals appear as world events come in (checked every 5 min).'));
    return;
  }
  for (const s of fresh) {
    const isWatch = s.direction === 'watch';
    const srcUrl = safeUrl(s.event?.url);
    box.append(el('div', { class: 'sig-card', id: `sig-${s.id}` },
      el('div', { class: 'head' },
        el('button', { class: 'sym-big', onclick: () => loadChart(s.tv_symbol) }, s.tv_symbol),
        el('span', { class: `chip ${s.direction}` }, isWatch ? 'watch' : s.direction),
        el('span', { class: `chip ${s.confidence}` }, s.confidence),
        isWatch ? el('span', { class: 'chip' }, 'info only') : el('span', { class: 'chip auto' }, 'auto-trades'),
      ),
      el('div', { class: 'headline' }, s.headline),
      planRow(s),
      el('div', { class: 'thesis' }, s.thesis.length > 180 ? s.thesis.slice(0, 180) + '…' : s.thesis),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { loadChart(s.tv_symbol); prefillTicket(s); } }, 'Take manually'),
        el('button', {
          class: 'btn ghost', onclick: async () => {
            await api('/api/signals/dismiss', { method: 'POST', body: { id: s.id } });
            await loadSignals();
          },
        }, 'Dismiss'),
        srcUrl ? el('a', { class: 'btn ghost', href: srcUrl, target: '_blank', rel: 'noopener' }, 'Source ↗') : null,
        el('span', { class: 'age' }, timeAgo(s.created_at)),
      ),
    ));
  }
}

function prefillTicket(s) {
  activeSignalId = s.id;
  document.getElementById('manual-ticket').open = true;
  document.getElementById('symbol-input').value = s.tv_symbol;
  document.getElementById('ticket-side').value = s.direction === 'short' ? 'short' : 'long';
  if (Number.isFinite(s.plan_qty)) document.getElementById('ticket-qty').value = s.plan_qty;
  if (Number.isFinite(s.plan_stop)) document.getElementById('ticket-stop').value = s.plan_stop.toFixed(2);
  if (Number.isFinite(s.plan_target)) document.getElementById('ticket-target').value = s.plan_target.toFixed(2);
}

async function loadSignals() {
  const data = await api('/api/signals');
  signalsCache = data.signals;
  renderSignals();
}

// ---- manual ticket ----
document.getElementById('place-trade').addEventListener('click', async () => {
  const btn = document.getElementById('place-trade');
  // The typed symbol wins over whatever the chart currently shows.
  const typed = document.getElementById('symbol-input').value.trim().toUpperCase();
  const symbol = typed || currentSymbol;
  const num = (id) => { const v = Number(document.getElementById(id).value); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const body = {
    symbol,
    side: document.getElementById('ticket-side').value,
    qty: Number(document.getElementById('ticket-qty').value),
    entry_price: num('ticket-entry'),
    stop_price: num('ticket-stop'),
    target_price: num('ticket-target'),
    signal_id: activeSignalId,
  };
  const sig = signalsCache.find((s) => s.id === activeSignalId);
  if (sig) body.thesis = sig.headline;
  btn.disabled = true; btn.textContent = 'Placing…';
  try {
    const r = await api('/api/trades', { method: 'POST', body });
    setStatus(`Opened ${body.side} ${body.qty} ${symbol} @ ${r.entry_price.toFixed(2)} (paper)`);
    activeSignalId = null;
    for (const id of ['ticket-entry', 'ticket-stop', 'ticket-target']) document.getElementById(id).value = '';
    if (typed) loadChart(typed);
    await loadAll();
  } catch (err) {
    setStatus(`Trade failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Place paper trade';
  }
});

// ---- tiles ----
function tile(label, value, polarity, sub, extra) {
  return el('div', { class: 'tile' },
    el('div', { class: 'label' }, label),
    el('div', { class: `value ${Number.isFinite(polarity) ? (polarity > 0 ? 'up' : polarity < 0 ? 'down' : '') : ''}` }, value),
    sub != null ? el('div', { class: 'sub' }, sub) : null,
    extra || null,
  );
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Count-up animation: tiles glide to their new value instead of snapping.
function animateValue(node, from, to, fmt) {
  if (!Number.isFinite(from) || from === to) { node.textContent = fmt(to); return; }
  const t0 = performance.now();
  const dur = 500;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    node.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const prevTileVals = {};

// Tiny SVG donut for the win-rate tile.
function winRing(rate) {
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const r = 16, c = 2 * Math.PI * r;
  const svg = mk('svg', { width: 40, height: 40, viewBox: '0 0 40 40', class: 'win-ring' });
  svg.append(mk('circle', { cx: 20, cy: 20, r, fill: 'none', stroke: 'var(--grid)', 'stroke-width': 5 }));
  if (rate != null) {
    svg.append(mk('circle', {
      cx: 20, cy: 20, r, fill: 'none',
      stroke: rate >= 0.5 ? 'var(--up)' : 'var(--down)', 'stroke-width': 5,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${(rate * c).toFixed(1)} ${c.toFixed(1)}`,
      transform: 'rotate(-90 20 20)',
    }));
  }
  return svg;
}

// Tiny single-series equity sparkline for the equity tile.
function sparkline(points, w = 150, h = 34) {
  if (!points || points.length < 2) return null;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.equity);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;
  const pts = points.map((p) =>
    `${(((p.ts - minX) / spanX) * w).toFixed(1)},${(h - 3 - ((p.equity - minY) / spanY) * (h - 6)).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('aria-label', 'equity history');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', 'var(--accent)');
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('stroke-linecap', 'round');
  svg.append(poly);
  return svg;
}

let equityHistory = [];

function renderTiles(summary) {
  const tiles = document.getElementById('tiles');
  const dayDelta = summary.equity - summary.startingEquity;
  document.title = `World Trader · ${moneyFmt.format(summary.equity)}`;
  tiles.replaceChildren(
    tile('Account equity', moneyFmt.format(summary.equity), null, `${fmtPnl(dayDelta)} all-time`, sparkline(equityHistory)),
    tile("Claude's P&L", fmtPnl(summary.claudePnl), summary.claudePnl, `${summary.claudeCount} autopilot trade${summary.claudeCount === 1 ? '' : 's'}`),
    tile('Unrealized P&L', fmtPnl(summary.unrealized), summary.unrealized, `${summary.openCount} open position${summary.openCount === 1 ? '' : 's'}`),
    tile('Realized P&L', fmtPnl(summary.realized), summary.realized, `${summary.closedCount} closed`),
    el('div', { class: 'tile tile-ring' },
      el('div', {},
        el('div', { class: 'label' }, 'Win rate'),
        el('div', { class: 'value' }, summary.winRate == null ? '—' : `${Math.round(summary.winRate * 100)}%`),
        el('div', { class: 'sub' }, 'of closed trades'),
      ),
      winRing(summary.winRate)),
    tile('Autopilot', summary.autopilot ? 'ON' : 'PAUSED', summary.autopilot ? 1 : -1, 'opens & exits trades',
      el('button', {
        class: 'btn', style: 'margin-top:6px',
        onclick: async () => {
          const r = await api('/api/autopilot', { method: 'POST', body: { on: !summary.autopilot } });
          setStatus(`Autopilot ${r.autopilot ? 'enabled' : 'paused'}`);
          await loadAll();
        },
      }, summary.autopilot ? 'Pause' : 'Resume')),
  );
  // glide the money tiles to their new values
  const vals = tiles.querySelectorAll('.tile .value');
  const targets = [
    ['equity', summary.equity, (v) => moneyFmt.format(v), vals[0]],
    ['claude', summary.claudePnl, fmtPnl, vals[1]],
    ['unreal', summary.unrealized, fmtPnl, vals[2]],
    ['real', summary.realized, fmtPnl, vals[3]],
  ];
  for (const [key, to, fmt, node] of targets) {
    if (node) animateValue(node, prevTileVals[key], to, fmt);
    prevTileVals[key] = to;
  }
}

// ---- blotter ----
function pnlCell(v) {
  return el('td', { class: Number.isFinite(v) ? (v >= 0 ? 'pnl-up' : 'pnl-down') : '' }, fmtPnl(v));
}

let blotterFilter = 'all';
let lastTradesData = { trades: [] };
document.querySelectorAll('#blotter-filters button').forEach((b) => b.addEventListener('click', () => {
  blotterFilter = b.dataset.f;
  document.querySelectorAll('#blotter-filters button').forEach((x) => x.classList.toggle('active', x === b));
  showBlotterTab('trades');
  renderBlotter(lastTradesData);
}));

const BLOTTER_MAX_ROWS = 150;
function renderBlotter(data) {
  lastTradesData = data;
  const all = data.trades.filter((t) => blotterFilter === 'all' || t.status === blotterFilter);
  const trades = all.slice(0, BLOTTER_MAX_ROWS);
  const truncated = all.length - trades.length;
  const box = document.getElementById('blotter');
  box.replaceChildren();
  if (!trades.length) {
    box.append(el('div', { class: 'empty' }, blotterFilter === 'all'
      ? 'No paper trades yet — the autopilot opens them automatically when actionable signals appear.'
      : `No ${blotterFilter} trades.`));
    return;
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      ...['Symbol', '', 'Strategy', 'Side', 'Qty', 'Entry', 'Stop', 'Target', 'Mark/Exit', 'P&L', 'P&L %', 'Opened', 'Exit', ''].map((h) => el('th', {}, h)))),
  );
  const tbody = el('tbody');
  for (const t of trades) {
    const pnlPct = Number.isFinite(t.pnl) && t.entry_price * t.qty !== 0 ? (t.pnl / (t.entry_price * t.qty)) * 100 : null;
    tbody.append(el('tr', { class: t.status === 'closed' ? 'row-closed' : '' },
      el('td', { class: 'sym', style: 'cursor:pointer', onclick: () => loadChart(t.symbol) }, t.symbol),
      el('td', { style: 'text-align:left' }, t.auto ? el('span', { class: 'chip auto', title: 'opened by autopilot' }, 'auto') : null),
      el('td', { class: 'dim', style: 'text-align:left' }, famDot(t.strategy), t.auto ? `${t.strategy || ''} · ${t.variant || ''}` : 'manual'),
      el('td', {}, t.side),
      el('td', {}, t.qty),
      el('td', {}, fmtPrice(t.entry_price)),
      el('td', { class: 'dim' }, fmtPrice(t.stop_price)),
      el('td', { class: 'dim' }, fmtPrice(t.target_price)),
      el('td', {}, fmtPrice(t.mark)),
      pnlCell(t.pnl),
      el('td', { class: Number.isFinite(pnlPct) ? (pnlPct >= 0 ? 'pnl-up' : 'pnl-down') : '' }, Number.isFinite(pnlPct) ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '—'),
      el('td', { class: 'dim' }, timeAgo(t.opened_at)),
      el('td', { class: 'dim', style: 'text-align:left' }, t.status === 'closed' ? (t.exit_reason || 'closed') : (t.expires_at ? `by ${new Date(t.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'open')),
      el('td', {}, t.status === 'open'
        ? el('button', {
            class: 'btn danger small', onclick: async () => {
              try {
                const r = await api('/api/trades/close', { method: 'POST', body: { id: t.id } });
                setStatus(`Closed ${t.symbol} @ ${r.exit_price.toFixed(2)}`);
                await loadAll();
              } catch (err) { setStatus(`Close failed: ${err.message}`); }
            },
          }, 'Close')
        : null),
    ));
  }
  const totalPnl = all.reduce((s, t) => s + (t.pnl ?? 0), 0);
  tbody.append(el('tr', { class: 'blotter-total' },
    el('td', { style: 'text-align:left' }, `Total (${all.length})`),
    ...Array.from({ length: 8 }, () => el('td')),
    pnlCell(totalPnl),
    el('td'), el('td'), el('td'), el('td'),
  ));
  table.append(tbody);
  box.append(table);
  if (truncated > 0) box.append(el('div', { class: 'note' }, `Showing latest ${BLOTTER_MAX_ROWS} rows (${truncated} older hidden) — Export CSV has everything.`));
}

// ---- equity chart (performance tab) ----
function equityChart(points) {
  if (!points || points.length < 2) {
    return el('div', { class: 'empty' }, 'Equity curve appears after a few snapshots (recorded every 10 minutes).');
  }
  const w = 680, h = 170, padL = 58, padR = 12, padT = 12, padB = 22;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.equity);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxY - minY < 1) { maxY += 50; minY -= 50; }
  const X = (t) => padL + ((t - minX) / (maxX - minX || 1)) * (w - padL - padR);
  const Y = (v) => padT + ((maxY - v) / (maxY - minY)) * (h - padT - padB);
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = mk('svg', { viewBox: `0 0 ${w} ${h}`, class: 'equity-chart', role: 'img', 'aria-label': 'Account equity over time' });
  for (const v of [minY, maxY]) {
    svg.append(mk('line', { x1: padL, x2: w - padR, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(mk('text', { x: padL - 6, y: Y(v) + 4, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, '$' + Math.round(v).toLocaleString()));
  }
  const linePts = points.map((p) => `${X(p.ts).toFixed(1)},${Y(p.equity).toFixed(1)}`).join(' ');
  svg.append(mk('polygon', { points: `${X(minX).toFixed(1)},${Y(minY)} ${linePts} ${X(maxX).toFixed(1)},${Y(minY)}`, fill: 'var(--accent)', opacity: 0.08 }));
  svg.append(mk('polyline', { points: linePts, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const fmtT = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  svg.append(mk('text', { x: padL, y: h - 6, fill: 'var(--muted)', 'font-size': 11 }, fmtT(minX)));
  svg.append(mk('text', { x: w - padR, y: h - 6, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 11 }, fmtT(maxX)));
  // crosshair + tooltip
  const cross = mk('line', { y1: padT, y2: h - padB, stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0 });
  const dot = mk('circle', { r: 3.5, fill: 'var(--accent)', opacity: 0 });
  const tip = mk('text', { fill: 'var(--ink)', 'font-size': 11.5, 'text-anchor': 'middle', opacity: 0 });
  svg.append(cross, dot, tip);
  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (w / rect.width);
    let best = points[0];
    for (const p of points) if (Math.abs(X(p.ts) - px) < Math.abs(X(best.ts) - px)) best = p;
    cross.setAttribute('x1', X(best.ts)); cross.setAttribute('x2', X(best.ts)); cross.setAttribute('opacity', 0.5);
    dot.setAttribute('cx', X(best.ts)); dot.setAttribute('cy', Y(best.equity)); dot.setAttribute('opacity', 1);
    tip.setAttribute('x', Math.min(Math.max(X(best.ts), padL + 45), w - 55));
    tip.setAttribute('y', Math.max(Y(best.equity) - 10, 15));
    tip.setAttribute('opacity', 1);
    tip.textContent = `$${Math.round(best.equity).toLocaleString()} · ${fmtT(best.ts)}`;
  });
  svg.addEventListener('mouseleave', () => {
    for (const n of [cross, dot, tip]) n.setAttribute('opacity', 0);
  });
  return el('div', { class: 'equity-wrap' }, svg);
}

// ---- strategy performance ----
function renderPerformance(rows) {
  const box = document.getElementById('perf');
  box.replaceChildren();
  box.append(equityChart(equityHistory));
  if (!rows.length) {
    box.append(el('div', { class: 'empty' }, 'No autopilot trades yet — per-strategy results appear here as trades close.'));
    return;
  }
  const totals = rows.reduce((a, r) => ({
    total: a.total + r.total, open: a.open + r.open, closed: a.closed + r.closed,
    wins: a.wins + r.wins, realized: a.realized + r.realized,
    grossWin: a.grossWin + r.grossWin, grossLoss: a.grossLoss + r.grossLoss,
  }), { total: 0, open: 0, closed: 0, wins: 0, realized: 0, grossWin: 0, grossLoss: 0 });
  const pf = (r) => (r.grossLoss < 0 ? (r.grossWin / -r.grossLoss).toFixed(2) : (r.grossWin > 0 ? '∞' : '—'));
  const winPct = (r) => (r.closed ? `${Math.round((r.wins / r.closed) * 100)}%` : '—');
  const row = (r, label, cls = '') => el('tr', { class: cls },
    el('td', { style: 'text-align:left' }, label),
    el('td', {}, `${r.total}${r.open ? ` (${r.open} open)` : ''}`),
    el('td', {}, winPct(r)),
    el('td', { class: r.realized > 0 ? 'pnl-up' : r.realized < 0 ? 'pnl-down' : '' }, fmtPnl(r.realized)),
    el('td', {}, pf(r)),
  );
  const table = el('table', {},
    el('thead', {}, el('tr', {}, ...['Strategy · variant', 'Trades', 'Win %', 'Realized P&L', 'Profit factor'].map((h) => el('th', {}, h)))),
    el('tbody', {},
      row(totals, 'ALL — Claude combined', 'perf-total'),
      ...rows.map((r) => row(r, `${r.strategy} · ${r.variant}`)),
    ),
  );
  box.append(table);
  box.append(el('div', { class: 'note' }, 'Sizing adapts automatically: a combo that is net-negative after 5 closed trades runs at half size, after 10 it is paused (base variants drop to quarter-size probes instead). Winners keep full size.'));
}

document.getElementById('tab-trades').addEventListener('click', () => showBlotterTab('trades'));
document.getElementById('tab-perf').addEventListener('click', () => showBlotterTab('perf'));
document.getElementById('tab-engine').addEventListener('click', () => showBlotterTab('engine'));
function showBlotterTab(which) {
  const panes = { trades: 'blotter', perf: 'perf', engine: 'activity' };
  for (const [tab, pane] of Object.entries(panes)) {
    document.getElementById(pane).hidden = tab !== which;
    document.getElementById(`tab-${tab}`).classList.toggle('active', tab === which);
  }
}

// ---- trade log tape (broker-style: green buys, red sells, signed P&L) ----
function renderTradeLog(trades) {
  renderTradeLogList(document.getElementById('tradelog'), trades, 250);
}

// ---- activity feed ----
const KIND_ICON = { open: '▶', close: '■', plan: '◇', skip: '⏭', info: '·' };
function renderActivity(items) {
  const box = document.getElementById('activity');
  box.replaceChildren();
  if (!items.length) {
    box.append(el('div', { class: 'empty' }, 'The autopilot logs every plan, entry, and exit here.'));
    return;
  }
  for (const a of items) {
    box.append(el('div', { class: `act act-${a.kind}` },
      el('span', { class: 'act-time' }, new Date(a.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
      el('span', { class: 'act-icon' }, KIND_ICON[a.kind] || '·'),
      el('span', {}, a.message),
    ));
  }
}

// ---- load loop ----
let lastActivityId = null;
function watchActivity(items) {
  if (!items.length) return;
  if (lastActivityId !== null) {
    for (const a of items) {
      if (a.id <= lastActivityId) break;
      if (a.kind === 'open' || a.kind === 'close' || a.kind === 'evolve') toast(a.message, a.kind);
    }
  }
  lastActivityId = items[0].id;
}

// ---- "what's Claude thinking" ticker: rotates the engine's own narration ----
let thinkItems = [];
let thinkIdx = -1;
function updateThinkFeed(items) {
  const wasEmpty = !thinkItems.length;
  thinkItems = items.filter((a) => ['plan', 'skip', 'info', 'evolve'].includes(a.kind)).slice(0, 15);
  if (wasEmpty && thinkItems.length) rotateThink();
}
function rotateThink() {
  if (!thinkItems.length) return;
  thinkIdx = (thinkIdx + 1) % thinkItems.length;
  const m = document.getElementById('think-msg');
  const a = thinkItems[thinkIdx];
  m.classList.remove('swap');
  void m.offsetWidth; // restart the fade
  m.classList.add('swap');
  m.classList.toggle('evolve', a.kind === 'evolve');
  m.textContent = `${a.message} · ${timeAgo(a.ts)}`;
}
setInterval(rotateThink, 7000);

// ---- compact density toggle ----
document.getElementById('compact-toggle').addEventListener('click', () => {
  const on = document.documentElement.classList.toggle('compact');
  localStorage.setItem('wt-compact', on ? '1' : '0');
});

async function loadAll() {
  try {
    const [trades, activity, perf, eq] = await Promise.all([api('/api/trades'), api('/api/activity'), api('/api/performance'), api('/api/equity-history')]);
    equityHistory = eq.history;
    renderTiles(trades.summary);
    renderBlotter(trades);
    renderTradeLog(trades.trades);
    renderActivity(activity.activity);
    renderPerformance(perf.performance);
    watchActivity(activity.activity);
    updateThinkFeed(activity.activity);
  } catch (err) {
    setStatus(`Load failed: ${err.message}`);
  }
}

// ---- live stream: prices tick in real time, fills refresh instantly ----
const LIVE_SYMS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'LTC-USD'];
const liveEls = new Map();
function usMarketOpen() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return et.getDay() >= 1 && et.getDay() <= 5 && mins >= 570 && mins < 960; // 9:30–16:00 ET
}
{
  const bar = document.getElementById('livebar');
  bar.append(el('span', { class: 'live-dot', id: 'stream-dot', title: 'streaming' }));
  for (const sym of LIVE_SYMS) {
    const px = el('span', { class: 'lp-px' }, '—');
    bar.append(el('button', {
      class: 'live-pair', onclick: () => loadChart(sym.replace('-USD', 'USD')),
    }, el('span', { class: 'lp-sym' }, sym.replace('-USD', '')), px));
    liveEls.set(sym, { px, last: null });
  }
  const mkt = el('span', { class: 'mkt-chip', id: 'mkt-chip' });
  bar.append(el('span', { style: 'flex:1' }), mkt);
  const updateMkt = () => {
    const open = usMarketOpen();
    mkt.textContent = `US equities ${open ? 'OPEN' : 'CLOSED'} · crypto 24/7`;
    mkt.classList.toggle('open', open);
  };
  updateMkt();
  setInterval(updateMkt, 60 * 1000);
}

function setStreamHealth(alive) {
  for (const d of document.querySelectorAll('.live-dot')) d.classList.toggle('dead', !alive);
}

let fillRefreshTimer = null;
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => setStreamHealth(true);
  es.onerror = () => setStreamHealth(false);
  es.onmessage = (ev) => {
    setStreamHealth(true);
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === 'prices') {
      for (const [sym, price] of Object.entries(d.prices || {})) {
        const e = liveEls.get(sym);
        if (!e || !Number.isFinite(price)) continue;
        const dir = e.last == null ? 0 : Math.sign(price - e.last);
        e.px.textContent = price >= 1000 ? price.toFixed(1) : price >= 10 ? price.toFixed(2) : price.toFixed(4);
        if (dir) {
          e.px.classList.remove('up', 'down');
          void e.px.offsetWidth; // restart the flash animation
          e.px.classList.add(dir > 0 ? 'up' : 'down');
        }
        e.last = price;
      }
    } else if (d.type === 'fill') {
      // debounce: bursts of scalp fills collapse into one refresh
      clearTimeout(fillRefreshTimer);
      fillRefreshTimer = setTimeout(loadAll, 1200);
    }
  };
  // EventSource reconnects automatically after errors
}
connectStream();

// ---- init ----
const params = new URLSearchParams(location.search);
const wantedSignal = params.get('signal');

(async () => {
  await loadSignals();
  await loadAll();
  if (wantedSignal) {
    const s = signalsCache.find((x) => x.id === wantedSignal);
    if (s) {
      loadChart(s.tv_symbol);
      document.getElementById(`sig-${s.id}`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  loadChart(currentSymbol);
})();

setInterval(loadAll, 20 * 1000);
setInterval(loadSignals, 60 * 1000);
