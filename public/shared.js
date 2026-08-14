// Shared helpers — all rendering uses textContent (event data is external text).
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Feed URLs are external, untrusted data — only http(s) may reach href/window.open.
export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch { return null; }
}

export function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export function fmtMoney(v) {
  if (!Number.isFinite(v)) return '—';
  return money.format(v);
}
export function fmtPnl(v) {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '−') + money.format(Math.abs(v));
}

export function fmtPrice(v) {
  if (!Number.isFinite(v)) return '—';
  return v >= 1000 ? v.toFixed(0) : v.toFixed(2);
}

export const KIND_LABEL = { unrest: 'Unrest', conflict: 'Conflict', quake: 'Earthquake', natural: 'Natural' };
export const SEV_LABEL = ['info', 'minor', 'major', 'severe'];

// Strategy family identity — one color per family, used everywhere a
// strategy is named so the eye learns who did what.
export const RULE_FAMILY = {
  'oil-producer-unrest': 'event', 'chokepoint-disruption': 'event', 'chokepoint-transit-drop': 'event',
  'quake-country-etf': 'event', 'hurricane-energy': 'event', 'global-risk-off': 'event', 'headline-risk': 'event',
  'ma-cross': 'tech', 'rsi-reversal': 'tech', 'breakout-20': 'tech',
  'momo-scalper': 'hyper',
};
export function famDot(strategy) {
  return el('span', { class: `fam-dot fam-${RULE_FAMILY[strategy] || 'manual'}`, title: RULE_FAMILY[strategy] || 'manual' });
}

// Broker-style fill log: green buys, red sells, signed P&L on every exit.
// Shared by the Trades page log and the per-strategy detail view.
const lastNewestByBox = new WeakMap(); // per-container newest-fill marker for flash-on-arrival
export function renderTradeLogList(box, trades, cap = 250) {
  box.replaceChildren();
  const qtyFmt = (q) => (Number.isInteger(q) ? q : Number(q.toFixed(4)));
  const events = [];
  for (const t of trades) {
    events.push({
      ts: t.opened_at,
      buy: t.side === 'long',
      label: `${t.side === 'long' ? 'BUY' : 'SELL SHORT'} ${qtyFmt(t.qty)} ${t.symbol} @ ${fmtPrice(t.entry_price)}`,
      tag: t.auto ? `${t.strategy || ''}` : 'manual',
      strategy: t.strategy,
    });
    if (t.status === 'closed') {
      const pct = t.entry_price * t.qty ? (t.pnl / (t.entry_price * t.qty)) * 100 : null;
      events.push({
        ts: t.closed_at,
        buy: t.side !== 'long',
        label: `${t.side === 'long' ? 'SELL' : 'BUY TO COVER'} ${qtyFmt(t.qty)} ${t.symbol} @ ${fmtPrice(t.exit_price)}`,
        pnl: t.pnl, pct,
        tag: t.exit_reason || 'closed',
        strategy: t.strategy,
      });
    }
  }
  if (!events.length) {
    box.append(el('div', { class: 'empty' }, 'Trade fills appear here — green for buys, red for sells, with profit on every exit.'));
    return;
  }
  events.sort((a, b) => b.ts - a.ts);
  const prevNewest = lastNewestByBox.get(box) ?? Infinity; // first render: nothing flashes
  lastNewestByBox.set(box, events[0].ts);
  for (const ev of events.slice(0, cap)) {
    box.append(el('div', { class: `log-row ${ev.buy ? 'buy' : 'sell'}${ev.ts > prevNewest ? ' fresh' : ''}` },
      el('span', { class: 'log-arrow' }, ev.buy ? '▲' : '▼'),
      el('span', { class: 'log-main' },
        el('span', { class: 'log-label' }, ev.label),
        ev.pnl != null
          ? el('span', { class: `log-pnl ${ev.pnl >= 0 ? 'pnl-up' : 'pnl-down'}` },
              `${fmtPnl(ev.pnl)}${Number.isFinite(ev.pct) ? ` (${ev.pct >= 0 ? '+' : ''}${ev.pct.toFixed(2)}%)` : ''}`)
          : null,
        el('span', { class: 'log-meta' }, famDot(ev.strategy), `${ev.tag} · ${timeAgo(ev.ts)}`),
      ),
    ));
  }
}
