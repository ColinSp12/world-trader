import { el, api, timeAgo, fmtPnl, fmtPrice, safeUrl } from '/shared.js';

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
  tiles.replaceChildren(
    tile('Account equity', moneyFmt.format(summary.equity), null, `${fmtPnl(dayDelta)} all-time`, sparkline(equityHistory)),
    tile("Claude's P&L", fmtPnl(summary.claudePnl), summary.claudePnl, `${summary.claudeCount} autopilot trade${summary.claudeCount === 1 ? '' : 's'}`),
    tile('Unrealized P&L', fmtPnl(summary.unrealized), summary.unrealized, `${summary.openCount} open position${summary.openCount === 1 ? '' : 's'}`),
    tile('Realized P&L', fmtPnl(summary.realized), summary.realized, `${summary.closedCount} closed`),
    tile('Win rate', summary.winRate == null ? '—' : `${Math.round(summary.winRate * 100)}%`, null, 'of closed trades'),
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
}

// ---- blotter ----
function pnlCell(v) {
  return el('td', { class: Number.isFinite(v) ? (v >= 0 ? 'pnl-up' : 'pnl-down') : '' }, fmtPnl(v));
}

function renderBlotter(data) {
  const { trades } = data;
  const box = document.getElementById('blotter');
  box.replaceChildren();
  if (!trades.length) {
    box.append(el('div', { class: 'empty' }, 'No paper trades yet — the autopilot opens them automatically when actionable signals appear.'));
    return;
  }
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      ...['Symbol', '', 'Strategy', 'Side', 'Qty', 'Entry', 'Stop', 'Target', 'Mark/Exit', 'P&L', 'Opened', 'Exit', ''].map((h) => el('th', {}, h)))),
  );
  const tbody = el('tbody');
  for (const t of trades) {
    tbody.append(el('tr', { class: t.status === 'closed' ? 'row-closed' : '' },
      el('td', { class: 'sym', style: 'cursor:pointer', onclick: () => loadChart(t.symbol) }, t.symbol),
      el('td', { style: 'text-align:left' }, t.auto ? el('span', { class: 'chip auto', title: 'opened by autopilot' }, 'auto') : null),
      el('td', { class: 'dim', style: 'text-align:left' }, t.auto ? `${t.strategy || ''} · ${t.variant || ''}` : 'manual'),
      el('td', {}, t.side),
      el('td', {}, t.qty),
      el('td', {}, fmtPrice(t.entry_price)),
      el('td', { class: 'dim' }, fmtPrice(t.stop_price)),
      el('td', { class: 'dim' }, fmtPrice(t.target_price)),
      el('td', {}, fmtPrice(t.mark)),
      pnlCell(t.pnl),
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
  table.append(tbody);
  box.append(table);
}

// ---- strategy performance ----
function renderPerformance(rows) {
  const box = document.getElementById('perf');
  box.replaceChildren();
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
function showBlotterTab(which) {
  document.getElementById('blotter').hidden = which !== 'trades';
  document.getElementById('perf').hidden = which !== 'perf';
  document.getElementById('tab-trades').classList.toggle('active', which === 'trades');
  document.getElementById('tab-perf').classList.toggle('active', which === 'perf');
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
async function loadAll() {
  try {
    const [trades, activity, perf, eq] = await Promise.all([api('/api/trades'), api('/api/activity'), api('/api/performance'), api('/api/equity-history')]);
    equityHistory = eq.history;
    renderTiles(trades.summary);
    renderBlotter(trades);
    renderActivity(activity.activity);
    renderPerformance(perf.performance);
  } catch (err) {
    setStatus(`Load failed: ${err.message}`);
  }
}

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
