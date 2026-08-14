// Money-path regression tests. Runs the real server against a throwaway DB:
//   C:\Users\colin\tools\node\node.exe --test tests\
// No external network is required for the assertions (quote lookups for the
// fake symbol fail fast and the sanity check correctly steps aside).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PORT = 3666;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `wt-test-${process.pid}.db`);
let child;

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

before(async () => {
  child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const { data } = await api('/api/health');
      if (data.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up on the test port');
});

after(() => {
  child?.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* already gone */ }
  }
});

test('health endpoint reports a sane engine', async () => {
  const { status, data } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(typeof data.uptimeSec, 'number');
  assert.equal(data.killSwitch, false);
});

test('ticket validation: qty and symbol are required', async () => {
  assert.equal((await api('/api/trades', { method: 'POST', body: { symbol: 'SPY', qty: 0 } })).status, 400);
  assert.equal((await api('/api/trades', { method: 'POST', body: { symbol: 'SPY', qty: -5 } })).status, 400);
  assert.equal((await api('/api/trades', { method: 'POST', body: { qty: 10 } })).status, 400);
});

test('open → close round trip books exact P&L', async () => {
  // Fake symbol: no live quote exists, so the explicit entry is accepted as-is.
  const open = await api('/api/trades', {
    method: 'POST',
    body: { symbol: 'ZZZTESTX', side: 'long', qty: 10, entry_price: 100 },
  });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  assert.equal(open.data.entry_price, 100);

  const close = await api('/api/trades/close', {
    method: 'POST',
    body: { id: open.data.id, exit_price: 105 },
  });
  assert.equal(close.status, 200, JSON.stringify(close.data));

  const { data } = await api('/api/trades?limit=10');
  const t = data.trades.find((x) => x.id === open.data.id);
  assert.equal(t.status, 'closed');
  assert.equal(t.pnl, 50); // (105 - 100) * 10
  assert.equal(data.summary.realized, 50);
  assert.equal(data.summary.equity, 100050);
  assert.equal(data.summary.todayRealized, 50);
});

test('short P&L math is signed correctly', async () => {
  const open = await api('/api/trades', {
    method: 'POST',
    body: { symbol: 'ZZZSHORTX', side: 'short', qty: 4, entry_price: 50 },
  });
  assert.equal(open.status, 200);
  const close = await api('/api/trades/close', { method: 'POST', body: { id: open.data.id, exit_price: 45 } });
  assert.equal(close.status, 200);
  const { data } = await api('/api/trades?limit=10');
  const t = data.trades.find((x) => x.id === open.data.id);
  assert.equal(t.pnl, 20); // short 4 @ 50 covered at 45
});

test('double close is rejected, not double-counted', async () => {
  const open = await api('/api/trades', {
    method: 'POST',
    body: { symbol: 'ZZZDOUBLE', side: 'long', qty: 1, entry_price: 10 },
  });
  await api('/api/trades/close', { method: 'POST', body: { id: open.data.id, exit_price: 11 } });
  const again = await api('/api/trades/close', { method: 'POST', body: { id: open.data.id, exit_price: 99 } });
  assert.equal(again.status, 400);
  const { data } = await api('/api/trades?limit=20');
  const t = data.trades.find((x) => x.id === open.data.id);
  assert.equal(t.exit_price, 11);
});

test('risk knobs persist through settings', async () => {
  const post = await api('/api/settings', { method: 'POST', body: { risk_per_trade: 2, max_positions: 5 } });
  assert.equal(post.status, 200);
  const { data } = await api('/api/settings');
  assert.equal(data.risk_per_trade, 2);
  assert.equal(data.max_positions, 5);
});

test('export and backtest listings respond', async () => {
  const bt = await api('/api/backtests');
  assert.equal(bt.status, 200);
  assert.ok(Array.isArray(bt.data.backtests));
  const ex = await api('/api/export.json');
  assert.equal(ex.status, 200);
  assert.ok(Array.isArray(ex.data.trades));
});
