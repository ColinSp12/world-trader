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
