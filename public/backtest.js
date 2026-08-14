// Backtest page — run daily-bar backtests server-side and render the verdicts.
import { el, api, fmtMoney, fmtPnl, timeAgo, renderTradeLogList } from '/shared.js';

const $ = (id) => document.getElementById(id);
const RULE_TITLES = {
  'ma-cross': 'EMA 5/20 Momentum', 'rsi-reversal': 'RSI(2) Mean Reversion', 'breakout-20': '20-Day Breakout',
  'oil-producer-unrest': 'Oil Producer Unrest', 'chokepoint-disruption': 'Chokepoint Unrest',
  'chokepoint-transit-drop': 'Transit Drop', 'quake-country-etf': 'Earthquake Fade',
  'hurricane-energy': 'Hurricane Energy', 'global-risk-off': 'Global Risk-Off', 'headline-risk': 'Headline Risk',
  'orb-15min': '15-Min Opening Range Breakout', 'gap-fade': 'Overnight Gap Fade',
  'vwap-revert': 'VWAP Reversion', 'fx-session': 'London FX Breakout',
  'ai-news': 'AI & Chips — News Investor', 'software-news': 'Software — News Investor',
};

function setStatus(msg, isErr = false) {
  const s = $('status');
  s.textContent = msg;
  s.style.color = isErr ? 'var(--down)' : '';
  if (msg) setTimeout(() => { if (s.textContent === msg) s.textContent = ''; }, 8000);
}

// Compact equity-curve SVG: area fill, baseline reference, end-point emphasis.
function curveSvg(curve, base) {
  const W = 560, H = 120, P = 6;
  if (!curve || curve.length < 2) return el('div', { class: 'empty' }, 'No trades in this window.');
  const xs = curve.map((p) => p.ts);
  const ys = curve.map((p) => p.balance);
  const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
  const lo = Math.min(...ys, base), hi = Math.max(...ys, base);
  const span = Math.max(hi - lo, base * 0.002);
  const X = (t) => P + ((t - x0) / Math.max(x1 - x0, 1)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const pts = curve.map((p) => `${X(p.ts).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= base;
  const color = up ? 'var(--up)' : 'var(--down)';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'bt-curve');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `equity curve ending at ${Math.round(ys[ys.length - 1])}`);
  svg.innerHTML = `
    <line x1="${P}" y1="${Y(base)}" x2="${W - P}" y2="${Y(base)}" stroke="var(--line-strong, #444)" stroke-dasharray="4 4" stroke-width="1"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${X(xs[xs.length - 1])}" cy="${Y(ys[ys.length - 1])}" r="3.5" fill="${color}"/>`;
  return svg;
}

function statTile(label, value, cls = '') {
  return el('div', { class: 'tile bt-tile' },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: `tile-value ${cls}` }, value));
}

function fmtHold(days) {
  if (!Number.isFinite(days)) return '—';
  return days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(1)}d`;
}

function renderResults(r) {
  const box = $('bt-results');
  box.replaceChildren();
  $('bt-results-title').textContent = `Results ${r.label ? `— ${r.label}` : r.id ? `— run #${r.id}` : ''}`;
  const rules = Object.keys(r.results || {});
  if (!rules.length) {
    box.append(el('div', { class: 'empty' }, r.mode === 'signals'
      ? 'No replayable signals yet — recorded signals need at least one completed next-day bar. Give the engine a few days of signal history and rerun.'
      : 'No results — check symbols and range.'));
    return;
  }
  box.append(el('div', { class: 'note' },
    `${r.mode === 'signals' ? 'Recorded-signal replay' : 'Technical backtest'} · ${r.variant} exits · ${r.friction === false ? 'NO costs (frictionless)' : 'realistic costs'}${r.rangeDays ? ` · ${r.rangeDays} days` : ''}${r.signalCount ? ` · ${r.signalCount} recorded signals` : ''}. Each rule trades its own virtual $100k.`));
  rules.sort((a, b) => (r.results[b].pnl ?? 0) - (r.results[a].pnl ?? 0));
  for (const rule of rules) {
    const x = r.results[rule];
    const card = el('div', { class: 'bt-card' });
    card.append(el('h3', {},
      el('span', {}, RULE_TITLES[rule] || rule),
      el('span', { class: `bt-verdict ${x.pnl >= 0 ? 'pnl-up' : 'pnl-down'}` }, fmtPnl(x.pnl))));
    const tiles = el('div', { class: 'bt-tiles' },
      statTile('Trades', String(x.trades)),
      statTile('Win rate', x.winRate != null ? `${Math.round(x.winRate * 100)}% (n=${x.trades})` : '—'),
      statTile('Profit factor', x.profitFactor === 'inf' ? '∞' : Number.isFinite(x.profitFactor) ? Number(x.profitFactor).toFixed(2) : '—'),
      statTile('Max drawdown', fmtMoney(Math.abs(x.maxDrawdown || 0)), 'pnl-down'),
      statTile('Costs paid', fmtMoney(x.frictionPaid || 0)),
      statTile('Avg hold', fmtHold(x.avgHoldDays)),
      statTile('End equity', fmtMoney(x.endEquity), x.endEquity >= r.base ? 'pnl-up' : 'pnl-down'));
    card.append(tiles);
    card.append(curveSvg(x.curve, r.base || 100000));
    if (x.tradeLog?.length) {
      const det = el('details', { class: 'bt-log' }, el('summary', {}, `Trade log (last ${x.tradeLog.length})`));
      const logBox = el('div', { class: 'scroll', style: 'max-height:260px' });
      // Adapt to the shared broker-tape renderer's trade shape.
      renderTradeLogList(logBox, x.tradeLog.map((t) => ({
        opened_at: t.openedAt, closed_at: t.closedAt, status: 'closed',
        side: t.side, qty: t.qty, symbol: t.symbol,
        entry_price: t.entry, exit_price: t.exit,
        pnl: t.pnl, exit_reason: t.reason, strategy: rule, auto: 1,
      })), x.tradeLog.length * 2); // two fill events (entry + exit) per trade
      det.append(logBox);
      card.append(det);
    }
    box.append(card);
  }
  if (r.errors?.length) box.append(el('div', { class: 'note' }, `Skipped: ${r.errors.join(' · ')}`));
}

async function loadHistory() {
  try {
    const { backtests } = await api('/api/backtests');
    const box = $('bt-history');
    box.replaceChildren();
    if (!backtests.length) { box.append(el('div', { class: 'empty' }, 'Past runs appear here.')); return; }
    for (const b of backtests) {
      box.append(el('button', {
        class: 'bt-hist-row',
        onclick: async () => {
          setStatus(`Loading run #${b.id}…`);
          try { renderResults(await api(`/api/backtests?id=${b.id}`)); setStatus(''); }
          catch (e) { setStatus(`Load failed: ${e.message}`, true); }
        },
      },
      el('span', { class: 'bt-hist-label' }, b.label || `${b.params.mode || 'technical'} · ${b.params.variant || 'base'}${b.params.rangeDays ? ` · ${b.params.rangeDays}d` : ''}`),
      el('span', { class: 'log-meta' }, `#${b.id} · ${timeAgo(b.created_at)}`)));
    }
  } catch { /* history is cosmetic */ }
}

async function run() {
  const btn = $('bt-run');
  const mode = $('bt-mode').value;
  const rules = [...$('bt-rules').querySelectorAll('input:checked')].map((c) => c.value);
  const symbols = $('bt-symbols').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  btn.disabled = true;
  btn.textContent = 'Running… (first run fetches history — up to a minute)';
  try {
    const r = await api('/api/backtest', {
      method: 'POST',
      body: {
        mode, rules, symbols,
        rangeDays: Number($('bt-range').value),
        variant: $('bt-variant').value,
        friction: $('bt-friction').checked,
        label: $('bt-label').value.trim(),
      },
    });
    renderResults(r);
    loadHistory();
    setStatus(`Run #${r.id} complete`);
  } catch (e) {
    setStatus(`Backtest failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run backtest';
  }
}

$('bt-run').addEventListener('click', run);
$('bt-mode').addEventListener('change', () => {
  $('bt-rules').style.opacity = $('bt-mode').value === 'signals' ? 0.4 : 1;
  $('bt-rules').querySelectorAll('input').forEach((c) => { c.disabled = $('bt-mode').value === 'signals'; });
});
$('compact-toggle')?.addEventListener('click', () => {
  document.documentElement.classList.toggle('compact');
  localStorage.setItem('wt-compact', document.documentElement.classList.contains('compact') ? '1' : '0');
});
loadHistory();
