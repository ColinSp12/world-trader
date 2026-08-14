import { el, api, timeAgo, fmtPnl, fmtPrice, safeUrl, renderTradeLogList, famDot } from '/shared.js';

let currentSymbol = localStorage.getItem('wt-chart-symbol') || 'USO';
let signalsCache = [];
let activeSignalId = null;

// Panels pause their refresh while hovered — a poll must never reset the
// scroll position mid-read or yank a button out from under the cursor.
const hoverPause = new Set();
const pendingRender = new Map();
for (const id of ['blotter', 'tradelog', 'signals']) {
  const n = document.getElementById(id);
  n.addEventListener('mouseenter', () => hoverPause.add(id));
  n.addEventListener('mouseleave', () => {
    hoverPause.delete(id);
    const fn = pendingRender.get(id);
    if (fn) { pendingRender.delete(id); fn(); }
  });
}
function renderUnlessHovered(id, fn) {
  if (hoverPause.has(id)) pendingRender.set(id, fn);
  else fn();
}
// Clicks INSIDE a paused panel must see their result immediately — Dismiss/
// Undo/Close would otherwise appear to do nothing until the mouse left.
function forceRender(id) {
  const fn = pendingRender.get(id);
  pendingRender.delete(id);
  if (fn) fn();
}

// ---- TradingView chart ----
// The free embed widgets have no runtime setSymbol API; the officially
// documented pattern is to recreate the container + config script per symbol.
function loadChart(symbol) {
  currentSymbol = symbol.toUpperCase().trim();
  localStorage.setItem('wt-chart-symbol', currentSymbol);
  document.getElementById('chart-symbol').textContent = currentSymbol;
  updateChartPositions();
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
    // Yahoo FX symbols carry an =X suffix TradingView doesn't understand.
    symbol: currentSymbol.replace(/=X$/, ''),
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

// ---- watchlist (editable, persisted) ----
const DEFAULT_WATCHLIST = ['SPY', 'QQQ', 'USO', 'XLE', 'GLD', 'UNG', 'VIXY', 'ITA', 'FRO', 'ZIM', 'EWT', 'BTCUSD'];
function getWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem('wt-watchlist'));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fall through */ }
  return DEFAULT_WATCHLIST;
}
function renderWatchlist() {
  const wl = document.getElementById('watchlist');
  wl.replaceChildren();
  for (const sym of getWatchlist()) {
    wl.append(el('button', {
      class: 'sym-btn', dataset: { sym },
      title: `chart ${sym} · Alt-click to remove from watchlist`,
      onclick: (e) => {
        if (e.altKey) {
          const next = getWatchlist().filter((s) => s !== sym);
          localStorage.setItem('wt-watchlist', JSON.stringify(next));
          renderWatchlist();
        } else loadChart(sym);
      },
    }, sym));
  }
  wl.append(el('button', {
    class: 'sym-btn wl-add', title: 'add the charted symbol to the watchlist',
    onclick: () => {
      const list = getWatchlist();
      if (!list.includes(currentSymbol)) {
        localStorage.setItem('wt-watchlist', JSON.stringify([...list, currentSymbol]));
        renderWatchlist();
      }
    },
  }, '+'));
  highlightWatchlist();
}
renderWatchlist();
function highlightWatchlist() {
  document.querySelectorAll('#watchlist .sym-btn').forEach((b) => b.classList.toggle('active', b.dataset.sym === currentSymbol));
}

// ---- open-position overlay for the charted symbol ----
function updateChartPositions() {
  let box = document.getElementById('chart-positions');
  if (!box) {
    box = el('div', { id: 'chart-positions', class: 'chart-positions' });
    document.querySelector('#chart-panel .chart-head')?.after(box);
  }
  const open = (lastTradesData.trades || []).filter((t) => t.status === 'open'
    && (t.symbol === currentSymbol || t.symbol.replace('-USD', 'USD') === currentSymbol));
  box.replaceChildren();
  if (!open.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const t of open) {
    box.append(el('span', { class: `pos-chip ${Number.isFinite(t.pnl) && t.pnl < 0 ? 'neg' : 'pos'}` },
      famDot(t.strategy),
      `${t.side} ${t.qty} @ ${fmtPrice(t.entry_price)}`,
      t.stop_price ? ` · stop ${fmtPrice(t.stop_price)}` : '',
      t.target_price ? ` · tgt ${fmtPrice(t.target_price)}` : '',
      el('b', { class: Number.isFinite(t.pnl) ? (t.pnl >= 0 ? 'pnl-up' : 'pnl-down') : '' }, ` ${fmtPnl(t.pnl)}`)));
  }
}

document.getElementById('load-symbol').addEventListener('click', () => {
  const v = document.getElementById('symbol-input').value.trim();
  if (v) loadChart(v);
});
document.getElementById('symbol-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) loadChart(v); }
});

let statusTimer = null;
function setStatus(msg, isErr = false) {
  const s = document.getElementById('status');
  s.textContent = msg;
  s.classList.toggle('err', isErr);
  clearTimeout(statusTimer);
  // Status messages expire — a stale "Trade failed" must not sit in the
  // header for hours looking current.
  if (msg) statusTimer = setTimeout(() => { s.textContent = ''; s.classList.remove('err'); }, 10000);
}
document.getElementById('status').setAttribute('aria-live', 'polite');
document.getElementById('toasts').setAttribute('aria-live', 'polite');

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
      input.placeholder = val ? 'saved (' + val.slice(-4) + ')' : 'not set';
    }
    document.getElementById('set-scalper').checked = Boolean(s.scalper);
    document.getElementById('set-webhook').value = s.webhook_url || '';
    document.getElementById('set-risk').value = s.risk_per_trade ?? '';
    document.getElementById('set-maxpos').value = s.max_positions ?? '';
    document.getElementById('set-feebps').value = s.scalp_fee_bps ?? '';
    document.getElementById('set-notional').value = s.scalp_notional ?? '';
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
  body.webhook_url = document.getElementById('set-webhook').value.trim();
  const numVal = (id) => { const v = Number(document.getElementById(id).value); return Number.isFinite(v) && v > 0 ? v : undefined; };
  if (numVal('set-risk') !== undefined) body.risk_per_trade = numVal('set-risk');
  if (numVal('set-maxpos') !== undefined) body.max_positions = numVal('set-maxpos');
  const fee = Number(document.getElementById('set-feebps').value);
  if (Number.isFinite(fee) && fee >= 0 && document.getElementById('set-feebps').value !== '') body.scalp_fee_bps = fee;
  if (numVal('set-notional') !== undefined) body.scalp_notional = numVal('set-notional');
  try {
    await api('/api/settings', { method: 'POST', body });
    toast(body.aisstream_key ? 'Saved — ships switching to global chokepoint coverage (check the Map)' : 'Settings saved');
    settingsDlg.close();
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  }
});
document.getElementById('clear-webhook').addEventListener('click', async (e) => {
  e.preventDefault();
  document.getElementById('set-webhook').value = '';
  await api('/api/settings', { method: 'POST', body: { webhook_url: '' } });
  toast('Webhook cleared — notifications off');
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

let signalView = 'new';
document.querySelectorAll('#signal-tabs button').forEach((b) => b.addEventListener('click', () => {
  signalView = b.dataset.v;
  document.querySelectorAll('#signal-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderSignals();
}));

// Signal history: what was taken, dismissed, expired — and for untaken
// signals, what they WOULD have returned (scored by the counterfactual job).
function renderSignalHistory(box) {
  const past = signalsCache.filter((s) => s.status !== 'new').slice(0, 40);
  if (!past.length) {
    box.append(el('div', { class: 'empty' }, 'No signal history yet — taken, dismissed, and expired signals land here with their would-have-been outcomes.'));
    return;
  }
  for (const s of past) {
    box.append(el('div', { class: 'sig-hist-row' },
      el('span', { class: `chip ${s.status}` }, s.status),
      el('span', { class: 'sig-hist-main' },
        el('button', { class: 'sym-btn', onclick: () => loadChart(s.tv_symbol) }, s.tv_symbol),
        el('span', {}, ` ${s.headline.slice(0, 70)}`),
        s.outcome_pnl != null
          ? el('span', { class: `log-pnl ${s.outcome_pnl >= 0 ? 'pnl-up' : 'pnl-down'}`, title: s.outcome_note || '' }, ` ${fmtPnl(s.outcome_pnl)}` )
          : null,
        el('span', { class: 'log-meta' }, famDot(s.rule), `${s.rule} · ${timeAgo(s.created_at)}`)),
      s.status === 'dismissed'
        ? el('button', {
            class: 'btn ghost small', onclick: async () => {
              await api('/api/signals/dismiss', { method: 'POST', body: { id: s.id, undo: true } });
              await loadSignals();
              forceRender('signals');
            },
          }, 'Undo')
        : null));
  }
}

function renderSignals() {
  renderUnlessHovered('signals', () => renderSignalsNow());
}
function renderSignalsNow() {
  const box = document.getElementById('signals');
  box.replaceChildren();
  const fresh = signalsCache.filter((s) => s.status === 'new');
  document.getElementById('sig-count').textContent = fresh.length ? `(${fresh.length})` : '';
  if (signalView === 'history') { renderSignalHistory(box); return; }
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
            forceRender('signals');
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
  updateTicketPreview(); // programmatic .value writes fire no input events
}

async function loadSignals() {
  const data = await api('/api/signals');
  signalsCache = data.signals;
  renderSignals();
}

// ---- manual ticket ----
// A prefilled signal id only stays attached while the symbol still matches —
// typing a different symbol must not mis-attribute the trade to the signal.
document.getElementById('symbol-input').addEventListener('input', () => {
  const sig = signalsCache.find((s) => s.id === activeSignalId);
  const typed = document.getElementById('symbol-input').value.trim().toUpperCase();
  if (sig && typed && typed !== sig.tv_symbol) activeSignalId = null;
});
// Live notional preview so the cost of the ticket is visible before placing.
function updateTicketPreview() {
  let box = document.getElementById('ticket-preview');
  if (!box) {
    box = el('div', { id: 'ticket-preview', class: 'plan-meta' });
    document.getElementById('place-trade')?.before(box);
  }
  const qty = Number(document.getElementById('ticket-qty').value);
  const entry = Number(document.getElementById('ticket-entry').value);
  if (!Number.isFinite(qty) || qty <= 0) { box.textContent = 'enter a positive quantity'; return; }
  box.textContent = Number.isFinite(entry) && entry > 0
    ? `notional ≈ $${(qty * entry).toFixed(0)}`
    : 'market order — fills at the live quote (+ spread/slippage)';
}
for (const id of ['ticket-qty', 'ticket-entry']) document.getElementById(id).addEventListener('input', updateTicketPreview);
updateTicketPreview();

document.getElementById('place-trade').addEventListener('click', async () => {
  const btn = document.getElementById('place-trade');
  // The typed symbol wins over whatever the chart currently shows.
  const typed = document.getElementById('symbol-input').value.trim().toUpperCase();
  const symbol = typed || currentSymbol;
  const qty = Number(document.getElementById('ticket-qty').value);
  if (!Number.isFinite(qty) || qty <= 0) { setStatus('Quantity must be a positive number', true); return; }
  const num = (id) => { const v = Number(document.getElementById(id).value); return Number.isFinite(v) && v > 0 ? v : undefined; };
  // Attribution resolved at PLACE time: the trade only joins to the signal
  // when the symbols actually match — an emptied input falling back to the
  // charted symbol must never attribute a different symbol's trade.
  const sig = signalsCache.find((s) => s.id === activeSignalId);
  const attributed = sig && sig.tv_symbol === symbol ? sig : null;
  const body = {
    symbol,
    side: document.getElementById('ticket-side').value,
    qty,
    entry_price: num('ticket-entry'),
    stop_price: num('ticket-stop'),
    target_price: num('ticket-target'),
    signal_id: attributed ? activeSignalId : null,
  };
  if (attributed) body.thesis = attributed.headline;
  btn.disabled = true; btn.textContent = 'Placing…';
  try {
    const r = await api('/api/trades', { method: 'POST', body });
    toast(`Opened ${body.side} ${body.qty} ${symbol} @ ${r.entry_price.toFixed(2)} (paper)`, 'open');
    activeSignalId = null;
    for (const id of ['ticket-entry', 'ticket-stop', 'ticket-target']) document.getElementById(id).value = '';
    updateTicketPreview(); // cleared entry now means market order — say so
    if (typed) loadChart(typed);
    await loadAll();
  } catch (err) {
    setStatus(`Trade failed: ${err.message}`, true);
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
  const todayPnl = (summary.todayRealized ?? 0);
  document.title = `World Trader · ${moneyFmt.format(summary.equity)}`;
  tiles.replaceChildren(
    tile('Account equity', moneyFmt.format(summary.equity), null, `${fmtPnl(dayDelta)} all-time`, sparkline(equityHistory)),
    tile('Today', fmtPnl(todayPnl), todayPnl, `${summary.todayTrades ?? 0} closed today (ET) · gross exposure ${moneyFmt.format(summary.grossExposure ?? 0)}`),
    tile("Claude's P&L", fmtPnl(summary.claudePnl), summary.claudePnl, `${summary.claudeCount} autopilot trade${summary.claudeCount === 1 ? '' : 's'}`),
    tile('Unrealized P&L', fmtPnl(summary.unrealized), summary.unrealized, `${summary.openCount} open position${summary.openCount === 1 ? '' : 's'} · fees paid ${moneyFmt.format(summary.feesPaid ?? 0)}`),
    el('div', { class: 'tile tile-ring' },
      el('div', {},
        el('div', { class: 'label' }, 'Win rate'),
        el('div', { class: 'value' }, summary.winRate == null ? '—' : `${Math.round(summary.winRate * 100)}%`),
        el('div', { class: 'sub' }, `n = ${summary.closedCount} closed`),
      ),
      winRing(summary.winRate)),
    tile('Autopilot', summary.killSwitch ? 'HALTED' : summary.autopilot ? 'ON' : 'PAUSED',
      summary.killSwitch ? -1 : summary.autopilot ? 1 : -1,
      summary.killSwitch ? 'daily-loss kill switch — entries resume tomorrow' : 'opens & exits trades',
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
    ['today', todayPnl, fmtPnl, vals[1]],
    ['claude', summary.claudePnl, fmtPnl, vals[2]],
    ['unreal', summary.unrealized, fmtPnl, vals[3]],
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

document.getElementById('blotter-sym').addEventListener('input', () => renderBlotter(lastTradesData));
document.getElementById('blotter-sort').addEventListener('change', () => renderBlotter(lastTradesData));

const BLOTTER_MAX_ROWS = 150;
function renderBlotter(data) {
  lastTradesData = data;
  updateChartPositions();
  renderUnlessHovered('blotter', () => renderBlotterNow(data));
}
function renderBlotterNow(data) {
  const symFilter = document.getElementById('blotter-sym').value.trim().toUpperCase();
  const sortMode = document.getElementById('blotter-sort').value;
  let all = data.trades.filter((t) => blotterFilter === 'all' || t.status === blotterFilter);
  if (symFilter) all = all.filter((t) => t.symbol.includes(symFilter));
  if (sortMode === 'pnl') all = [...all].sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity));
  else if (sortMode === 'pnl-asc') all = [...all].sort((a, b) => (a.pnl ?? Infinity) - (b.pnl ?? Infinity));
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
      el('td', { class: 'dim', title: new Date(t.opened_at).toLocaleString() }, timeAgo(t.opened_at)),
      el('td', { class: 'dim', style: 'text-align:left' }, t.status === 'closed' ? (t.exit_reason || 'closed') : (t.expires_at ? `by ${new Date(t.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'open')),
      el('td', {}, t.status === 'open'
        ? el('button', {
            class: 'btn danger small', onclick: async () => {
              try {
                const r = await api('/api/trades/close', { method: 'POST', body: { id: t.id } });
                setStatus(`Closed ${t.symbol} @ ${r.exit_price.toFixed(2)}`);
                await loadAll();
                forceRender('blotter');
                forceRender('tradelog');
              } catch (err) { setStatus(`Close failed: ${err.message}`, true); }
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
  renderUnlessHovered('tradelog', () => renderTradeLogList(document.getElementById('tradelog'), trades, 250));
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

// ---- keyboard shortcuts for the daily loop ----
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); document.getElementById('symbol-input').focus(); }
  else if (e.key === 't') { const d = document.getElementById('manual-ticket'); d.open = !d.open; }
  else if (e.key === '1') showBlotterTab('trades');
  else if (e.key === '2') showBlotterTab('perf');
  else if (e.key === '3') showBlotterTab('engine');
});

// ---- init ----
// The chart never waits on the API, and one failed request must not blank the
// whole page — each loader guards itself.
const params = new URLSearchParams(location.search);
const wantedSignal = params.get('signal');
const wantedSymbol = params.get('symbol');
if (wantedSymbol) currentSymbol = wantedSymbol.toUpperCase().trim();

loadChart(currentSymbol);
(async () => {
  try { await loadSignals(); } catch (err) { setStatus(`Signals unavailable: ${err.message}`, true); }
  try { await loadAll(); } catch { /* loadAll sets its own status */ }
  if (wantedSignal) {
    const s = signalsCache.find((x) => x.id === wantedSignal);
    if (s) {
      loadChart(s.tv_symbol);
      document.getElementById(`sig-${s.id}`)?.scrollIntoView({ block: 'nearest' });
    }
  }
})();

setInterval(() => loadAll().catch(() => {}), 20 * 1000);
setInterval(() => loadSignals().catch(() => {}), 60 * 1000);
