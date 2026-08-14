import { el, api, fmtPnl } from '/shared.js';

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
  return el('div', { class: 'strategy-card' },
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
];

async function load() {
  try {
    const d = await api('/api/strategy-accounts');
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
    document.getElementById('status').textContent = `${d.accounts.filter((a) => !a.watchOnly).length} live strategies`;
  } catch (err) {
    document.getElementById('status').textContent = `error: ${err.message}`;
  }
}

load();
setInterval(load, 60 * 1000);
