// Offline tests: runs the real worker code against an in-memory SQLite database
// and a fake Coinbase feed. No network access, no real orders.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker, { CONFIG, decide, broaderTrend, runOnce } from '../src/index.js';

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('ok -', msg);
  else { failures++; console.log('FAIL -', msg); }
}

// Minimal D1-style wrapper over node:sqlite (prepare/bind/first/all/run).
function makeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_runs.sql']) {
    db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  const api = (stmt, args) => ({
    first: async () => stmt.get(...args) ?? null,
    all: async () => ({ results: stmt.all(...args) }),
    run: async () => { const info = stmt.run(...args); return { meta: { changes: info.changes } }; },
  });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return { ...api(stmt, []), bind: (...args) => api(stmt, args) };
    },
  };
}

// Fake feed and clock.
let NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
Date.now = () => NOW;
let currentPrice = 64000;
let feedDown = false;
let seedPrice = 64000;
globalThis.fetch = async (url) => {
  if (feedDown) return new Response('unavailable', { status: 503 });
  if (url.includes('/ticker')) return Response.json({ price: String(currentPrice) });
  if (url.includes('/candles')) {
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push([Math.floor(NOW / 1000) - (i + 1) * 60, 0, 0, 0, seedPrice, 1]);
    return Response.json(rows); // newest first
  }
  return new Response('not found', { status: 404 });
};

const env = { DB: makeD1() };
async function tick(price) {
  currentPrice = price;
  NOW += 60000;
  await runOnce(env);
}
async function statusJSON() {
  const res = await worker.fetch(new Request('https://x.test/status'), env);
  return res.json();
}

// ---------- unit tests ----------
{
  const flat = Array(40).fill(100);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 200 - i);
  check(broaderTrend(flat) === 'flat', 'trend: flat prices read as flat');
  check(broaderTrend(up) === 'up', 'trend: rising prices read as up');
  check(broaderTrend(down) === 'down', 'trend: falling prices read as down');
  check(broaderTrend([1, 2, 3]) === 'unknown', 'trend: too little history reads as unknown');

  const base = () => ({ cash: 10, holdings: 0.1, entryPrice: 100, peak: 110, startingBalance: 20, trades: 1, wins: 0, fees: 0, protectExits: 0 });
  const closes = Array(20).fill(100);
  let s = base();
  const r1 = decide(s, 106, closes);
  check(r1.action === 'STOP-LOSS', 'trailing stop: falls 3.6% from peak triggers STOP-LOSS');
  s = base(); s.peak = 106.5;
  const r2 = decide(s, 106.5, closes);
  check(r2.action === 'TAKE-PROFIT', 'take-profit: +6.5% from entry triggers TAKE-PROFIT');
  check(CONFIG.startingBalance === 20 && CONFIG.feeFlat === 0.5, 'config: $20 start with flat $0.50 fee, like the page');
}

// ---------- end-to-end paper run ----------
{
  // Rising then falling prices. Expect one BUY and one exit.
  const path = [];
  let p = 64000;
  for (let i = 0; i < 12; i++) { p *= 1.003; path.push(p); }   // rising
  for (let i = 0; i < 15; i++) { p *= 0.995; path.push(p); }   // falling
  for (const price of path) await tick(price);

  const st = await statusJSON();
  const decisions = st.recentDecisions.slice().reverse();
  const actions = decisions.map((d) => d.action);
  check(actions.includes('BUY'), 'paper run: bot bought during the rise');
  // Duplicate protection: repeating a run in the same minute must add nothing.
  {
    const before = (await statusJSON()).recentDecisions.length;
    await runOnce(env);
    await runOnce(env);
    const after = (await statusJSON()).recentDecisions.length;
    check(after === before, 'duplicate: repeated runs in the same minute add no decisions');
  }
  check(actions.some((a) => a === 'SELL' || a === 'STOP-LOSS' || a === 'TAKE-PROFIT'), 'paper run: bot exited during the fall');
  check(st.mode.startsWith('PAPER'), 'status says PAPER mode');
  check(Math.abs(st.fees - 0.5 * (actions.filter((a) => a === 'BUY').length + actions.filter((a) => ['SELL', 'STOP-LOSS', 'TAKE-PROFIT'].includes(a)).length)) < 1e-9, 'fees: $0.50 per buy and per sell');
  check(Math.abs(st.profitLoss - (st.portfolio - 20)) < 1e-9, 'P/L equals portfolio minus $20 start');
  check(decisions.length === path.length, `one decision logged per run (${decisions.length} of ${path.length})`);
  const bars = await env.DB.prepare('SELECT COUNT(*) AS n FROM bars').first();
  check(bars.n <= CONFIG.keepBars, `price history capped at ${CONFIG.keepBars} minutes (has ${bars.n})`);
  console.log('   actions:', actions.join(', '));
  console.log('   final P/L: $' + st.profitLoss.toFixed(2) + ', trades: ' + st.trades + ', fees: $' + st.fees.toFixed(2));
}

// ---------- overlap: two simultaneous runs for one minute ----------
{
  const before = (await statusJSON()).recentDecisions.length;
  NOW += 60000;
  await Promise.all([runOnce(env), runOnce(env)]);
  const after = (await statusJSON()).recentDecisions.length;
  check(after === before + 1, 'overlap: two simultaneous runs for one minute make exactly one decision');
}

// ---------- feed failure: no trading on bad data ----------
{
  const before = await statusJSON();
  feedDown = true;
  NOW += 60000;
  await runOnce(env);
  feedDown = false;
  const after = await statusJSON();
  check(after.recentDecisions[0].action === 'ERROR', 'feed down: records an ERROR decision');
  check(after.cash === before.cash && after.holdings === before.holdings, 'feed down: cash and holdings unchanged');
}

// ---------- phone dashboard ----------
{
  const page = await worker.fetch(new Request('https://x.test/'), env);
  const html = await page.text();
  check(page.headers.get('Content-Type').startsWith('text/html'), 'dashboard: root serves HTML');
  check(html.includes('Crypt Bot') && html.includes("fetch('/status'"), 'dashboard: page reads /status');
  check(html.trimStart().startsWith('<!doctype html>') && html.trimEnd().endsWith('</html>'), 'dashboard: page is a complete HTML document');
  const st = await statusJSON();
  check(Array.isArray(st.prices) && st.prices.length > 0 && st.prices.length <= CONFIG.keepBars, `status: includes price history for the chart (${st.prices.length} points)`);
  check(st.prices.every((p) => typeof p.ts === 'number' && typeof p.close === 'number'), 'status: each price point has a time and a close');
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
