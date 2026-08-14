// Maintenance utility: purge every trade made under the old flattering
// simulation (pre honest-cost model), keeping only trades whose fills paid
// real costs. Also clears the equity curve and cost-contaminated tuning.
// Cutover = the moment the honest cost model went live (the scalper's
// 'fresh start' generation activation). Run with the server STOPPED:
//   node scripts/reset-to-honest-trades.mjs
// A backup of data.db is strongly recommended first (see backups/).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const db = new DatabaseSync(path.join(import.meta.dirname, '..', 'data.db'));
const row = db.prepare("SELECT activated_at, gen FROM strategy_params WHERE rule = 'momo-scalper' AND note LIKE 'fresh start under the honest cost model%' ORDER BY gen DESC LIMIT 1").get();
if (!row) throw new Error('cutover generation not found — aborting, nothing deleted');
const cut = row.activated_at;
const pre = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open FROM trades WHERE opened_at < ?").get(cut);
const post = db.prepare('SELECT COUNT(*) AS c FROM trades WHERE opened_at >= ?').get(cut);
const t = db.prepare('DELETE FROM trades WHERE opened_at < ?').run(cut);
const eq = db.prepare('DELETE FROM equity_snapshots').run(); // old curve reflects the old ledger
const rt = db.prepare('DELETE FROM rule_tuning').run();       // learning derived from fake-cost trades
const rth = db.prepare('DELETE FROM rule_tuning_history').run();
const act = db.prepare("DELETE FROM activity WHERE ts < ? AND kind IN ('open', 'close', 'scalp')").run(cut);
console.log(JSON.stringify({
  cutover: new Date(cut).toISOString(),
  deletedTrades: Number(t.changes),
  ofWhichOpen: Number(pre.open),
  keptRealTrades: post.c,
  clearedSnapshots: Number(eq.changes),
  clearedTuning: Number(rt.changes) + Number(rth.changes),
  clearedFillActivity: Number(act.changes),
}, null, 2));
