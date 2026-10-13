// Offline tests: runs the real worker code against an in-memory SQLite database
// and a fake Coinbase feed. No network access, no real orders.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker, { CONFIG, decide, broaderTrend, runOnce, buy, sell, accounting, normalize, refreshPrice } from '../src/index.js';

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
CONFIG.sleep = async (ms) => { NOW += Math.max(0, ms); };
CONFIG.priceIntervalMs = 60000;   // one price and one check per minute for the e2e checks
CONFIG.evalIntervalMs = 60000;
CONFIG.minTradeIntervalMs = 0;
async function tick(price) {
  currentPrice = price;
  NOW += 60000;
  await runOnce(env);
}
async function loadStateForTest() {
  const row = await env.DB.prepare('SELECT data FROM state WHERE id = 1').first();
  return row ? normalize(JSON.parse(row.data)) : normalize({ cash: 20, holdings: 0, entryPrice: null, peak: null, startingBalance: 20, trades: 0, wins: 0, fees: 0, protectExits: 0 });
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
  check(CONFIG.startingBalance === 20 && CONFIG.takerFeeRate === 0.006, 'config: $20 start, fee is a labelled percentage estimate');
  check(/ESTIMATE/.test(CONFIG.feeLabel), 'config: fee is labelled as an estimate');
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
    const minuteStart = NOW;
    const before = (await statusJSON()).recentDecisions.length;
    await runOnce(env);
    const afterFirst = (await statusJSON()).recentDecisions.length;
    NOW = minuteStart; // a repeated trigger arriving in the same minute
    await runOnce(env);
    const afterRepeat = (await statusJSON()).recentDecisions.length;
    check(afterFirst - before === 1 && afterRepeat === afterFirst, 'duplicate: the first run makes one check; a repeat in the same minute adds none');
  }
  check(actions.some((a) => a === 'SELL' || a === 'STOP-LOSS' || a === 'TAKE-PROFIT'), 'paper run: bot exited during the fall');
  check(st.mode.startsWith('PAPER'), 'status says PAPER mode');
  check(st.feesPaid > 0 && st.realizedPL !== undefined, 'fees: recorded as a percentage of each trade');
  check(Math.abs(st.portfolio - (st.cash + st.holdingsNetValue)) < 1e-9, 'portfolio = cash + holdings if sold now (after fees)');
  check(Math.abs(st.portfolio - (st.startingBalance + st.realizedPL + st.unrealizedPL)) < 1e-9, 'accounting reconciles: portfolio = start + realized + unrealized');
  check(Math.abs(st.profitLoss - (st.portfolio - 20)) < 1e-9, 'P/L equals portfolio minus $20 start');
  check(decisions.length === path.length, `one decision logged per run (${decisions.length} of ${path.length})`);
  const bars = await env.DB.prepare('SELECT COUNT(*) AS n FROM bars').first();
  check(bars.n <= CONFIG.keepBars, `price history capped at ${CONFIG.keepBars} minutes (has ${bars.n})`);
  console.log('   actions:', actions.join(', '));
  console.log('   final P/L: $' + st.profitLoss.toFixed(2) + ', trades: ' + st.trades + ', fees: $' + st.feesPaid.toFixed(2));
}

// ---------- full buy-and-sell cycle with fees and slippage ----------
{
  const fee = CONFIG.takerFeeRate, slip = CONFIG.slippageRate;
  const fresh = () => ({ cash: 20, holdings: 0, entryPrice: null, peak: null, startingBalance: 20, costBasis: 0, realizedPL: 0, trades: 0, wins: 0, fees: 0, protectExits: 0 });

  // Buy at $100, sell at $110, computed by hand from the same rules.
  const st = fresh();
  buy(st, 100);
  const spend = 10, buyFee = spend * fee, buyQty = (spend - buyFee) / (100 * (1 + slip));
  check(Math.abs(st.cash - 10) < 1e-12, 'cycle: half the cash leaves on the buy');
  check(Math.abs(st.holdings - buyQty) < 1e-12, 'cycle: BTC received = (spend - buy fee) / filled price');
  check(Math.abs(st.costBasis - 10) < 1e-12, 'cycle: cost basis includes the buy fee');

  const openAt105 = accounting(st, 105);
  const expectedOpenNet = buyQty * 105 * (1 - slip) * (1 - fee);
  check(Math.abs(openAt105.portfolio - (10 + expectedOpenNet)) < 1e-9, 'cycle: open position valued after exit fee and slippage');
  check(Math.abs(openAt105.portfolio - (20 + openAt105.unrealizedPL)) < 1e-9, 'cycle: open portfolio = $20 + unrealized P/L');
  check(Math.abs(accounting(st, openAt105.breakEvenPrice).portfolio - 20) < 1e-9, 'cycle: break-even price returns exactly the cost basis');

  sell(st, 110, false);
  const gross = buyQty * 110 * (1 - slip), sellFee = gross * fee, proceeds = gross - sellFee;
  check(Math.abs(st.cash - (10 + proceeds)) < 1e-9, 'cycle: cash after sell = leftover cash + net proceeds');
  check(Math.abs(st.fees - (buyFee + sellFee)) < 1e-9, 'cycle: fees paid = buy fee + sell fee, each counted once');
  check(Math.abs(st.realizedPL - (proceeds - 10)) < 1e-9, 'cycle: realized P/L = net proceeds - cost basis');
  check(Math.abs(st.cash - (20 + st.realizedPL)) < 1e-9, 'cycle: final cash reconciles to $20 + realized P/L');
  check(Math.abs(accounting(st, 110).portfolio - (20 + st.realizedPL)) < 1e-9, 'cycle: portfolio after exit = $20 + realized P/L');

  // Flat price: the round trip must lose money (fees and slippage), never show a profit.
  const flat = fresh();
  buy(flat, 100);
  sell(flat, 100, false);
  check(flat.realizedPL < 0, 'cycle: flat price round trip loses money to fees and slippage');
  check(flat.wins === 0, 'cycle: a round trip that loses after fees is not counted as a win');

  // Older saved state (fee was a flat $0.50, no costBasis/realizedPL) still reconciles.
  const old = normalize({ cash: 10, holdings: 0.000114, startingBalance: 20, fees: 0.5, trades: 1, wins: 0 });
  check(Math.abs(old.costBasis - 10) < 1e-12 && Math.abs(old.realizedPL) < 1e-12, 'migration: old open position gets cost basis and zero realized P/L');
  check(Math.abs(accounting(old, 83000).portfolio - (20 + accounting(old, 83000).unrealizedPL)) < 1e-9, 'migration: old state reconciles');
}

// ---------- 10-second prices, 20-second checks ----------
{
  const saved = { p: CONFIG.priceIntervalMs, e: CONFIG.evalIntervalMs };
  CONFIG.priceIntervalMs = 10000;
  CONFIG.evalIntervalMs = 20000;
  let tickerCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/ticker')) tickerCalls += 1;
    return realFetch(url, opts);
  };
  try {
    NOW += 60000;
    const before = (await statusJSON()).recentDecisions.length;
    await runOnce(env);
    const after = (await statusJSON()).recentDecisions.length;
    check(tickerCalls === 6, `timing: one minute makes 6 price requests (every 10s), got ${tickerCalls}`);
    check(after - before === 3, `timing: one minute makes 3 strategy checks (every 20s), got ${after - before}`);
  } finally {
    globalThis.fetch = realFetch;
    CONFIG.priceIntervalMs = saved.p;
    CONFIG.evalIntervalMs = saved.e;
  }
}

// ---------- HTTP 429: exponential backoff, no repeated requests while limited ----------
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('rate limited', { status: 429 }); };
  try {
    const state = await loadStateForTest();
    const db = env.DB;
    const t0 = Date.now();
    await refreshPrice(db, state, 1);
    check(calls === 1 && state.rateLimitStep === 1 && state.rateLimitUntil === t0 + 10000, 'backoff: first HTTP 429 pauses requests for 10 seconds');
    await refreshPrice(db, state, 1);
    check(calls === 1, 'backoff: no request is sent while paused');
    NOW += 10000;
    await refreshPrice(db, state, 1);
    check(calls === 2 && state.rateLimitStep === 2 && state.rateLimitUntil === Date.now() + 20000, 'backoff: second HTTP 429 doubles the pause to 20 seconds');
    NOW += 20000; await refreshPrice(db, state, 1);
    NOW += 40000; await refreshPrice(db, state, 1);
    NOW += 60000; await refreshPrice(db, state, 1);
    check(state.rateLimitStep === 5 && state.rateLimitUntil === Date.now() + CONFIG.rateLimitMaxMs, 'backoff: pause is capped at 60 seconds');
    globalThis.fetch = async () => Response.json({ price: '83100.25' });
    NOW += CONFIG.rateLimitMaxMs;
    await refreshPrice(db, state, 1);
    check(state.lastValid === 83100.25 && state.rateLimitStep === 0 && state.rateLimitUntil === 0, 'backoff: a successful request clears the limit');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------- stale data: never generate a signal from an old or missing price ----------
{
  const state = await loadStateForTest();
  state.lastValid = 83000; state.lastValidAt = Date.now() - 31000;
  const decisionsBefore = (await statusJSON()).recentDecisions.length;
  const cashBefore = state.cash;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    await refreshPrice(env.DB, state, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  const { evaluate } = await import('../src/index.js');
  await evaluate(env.DB, state, 1);
  const last = (await statusJSON()).recentDecisions[0];
  check(last.action === 'STALE' && state.cash === cashBefore && state.holdings === 0, 'stale: a price older than 30s records STALE and trades nothing');
}

// ---------- minimum time between trades ----------
{
  const saved = CONFIG.minTradeIntervalMs;
  CONFIG.minTradeIntervalMs = 120000;
  try {
    const st = { cash: 20, holdings: 0, entryPrice: null, peak: null, startingBalance: 20, costBasis: 0, realizedPL: 0, trades: 0, wins: 0, fees: 0, protectExits: 0, lastTradeAt: 0 };
    const up = Array(15).fill(100).concat(Array(5).fill(101));
    const down = Array(15).fill(100).concat(Array(5).fill(99.5));
    NOW += 600000;
    const first = decide(st, 101, up);
    check(first.action === 'BUY', 'spacing: a clear buy signal trades when no trade happened recently');
    const blocked = decide(st, 99.5, down);
    check(blocked.action === 'WATCH' && st.holdings > 0, 'spacing: a sell signal within the minimum interval is not traded');
    NOW += 120000;
    const later = decide(st, 99.5, down);
    check(later.action === 'SELL' && st.holdings === 0, 'spacing: the sell trades once the minimum interval has passed');
    const stop = { cash: 10, holdings: 0.1, entryPrice: 100, peak: 110, startingBalance: 20, costBasis: 10, realizedPL: 0, trades: 1, wins: 0, fees: 0, protectExits: 0, lastTradeAt: Date.now() };
    const stopped = decide(stop, 106, Array(20).fill(100));
    check(stopped.action === 'STOP-LOSS', 'spacing: stop-loss is never blocked by the minimum interval');
  } finally {
    CONFIG.minTradeIntervalMs = saved;
  }
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
  check(after.recentDecisions[0].action === 'STALE', 'feed down: records STALE (no signal from old data)');
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
