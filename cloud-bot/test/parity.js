// Parity check: the same price path goes through the web page's strategy code
// (index.html, run headless) and the cloud worker. Their decisions should match.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import { runOnce, CONFIG } from '../src/index.js';

// ---- shared price path (deterministic) ----
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const path = [];
let p = 64000;
for (let i = 0; i < 12; i++) { p *= 1.003; path.push(p); }
for (let i = 0; i < 15; i++) { p *= 0.995; path.push(p); }
for (let i = 0; i < 160; i++) { p *= 1 + (rand() - 0.5) * 0.006; path.push(p); }
const SEED_CLOSES = Array(120).fill(64000);

// ---- page side: run index.html's script in a sandbox ----
const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const pageJS = html.match(/<script>([\s\S]*)<\/script>/)[1];
const els = {};
const defaults = { sourceSel: 'sim', strategySel: 'momentum', trendFilterSel: 'on', stopLossSel: '0.03', takeProfitSel: '0.06', trailingSel: 'on', balanceSel: '20', speedSel: '700', btSourceSel: 'sim' };
const ctxStub = new Proxy(function () {}, { get: (t, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : ctxStub), apply: () => ctxStub, set: () => true });
function el(id) {
  if (!els[id]) {
    els[id] = { id, value: defaults[id] ?? '', textContent: '', innerHTML: '', disabled: false, className: '', clientWidth: 300, clientHeight: 200, children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {},
      getContext() { return ctxStub; }, allEntries: [],
      prepend(c) { this.children.unshift(c); this.allEntries.push(c); },
      appendChild(c) { this.children.push(c); },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); },
      get lastChild() { return this.children[this.children.length - 1]; } };
  }
  return els[id];
}
const sandbox = {
  document: { getElementById: el, createElement: () => ({ className: '', innerHTML: '', appendChild() {} }) },
  window: { addEventListener() {} }, devicePixelRatio: 1,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  console, Date, Math, JSON, Promise, Error, Number, parseFloat, isFinite, Array, Object, String, Map, Set,
  fetch: async () => { throw new Error('no network in parity test'); },
};
vm.createContext(sandbox);
vm.runInContext(pageJS, sandbox);
vm.runInContext(`reset(); history = ${JSON.stringify(SEED_CLOSES)}; price = history[history.length-1]; longMAHistory = [];`, sandbox);

const tagOf = (html) => (html.match(/class="tag">([^<]+)</) || [])[1];
function pageStep(price) {
  const log = el('log');
  const before = log.allEntries.length;
  vm.runInContext(`pushPoint(${price}); decide();`, sandbox);
  const tags = log.allEntries.slice(before).map((c) => tagOf(c.innerHTML));
  if (tags.includes('STOP-LOSS')) return 'STOP-LOSS';
  if (tags.includes('TAKE-PROFIT')) return 'TAKE-PROFIT';
  if (tags.includes('BUY')) return 'BUY';
  if (tags.includes('SELL')) return 'SELL';
  if (tags.includes('FILTERED')) return 'FILTERED';
  return 'WATCH';
}

// ---- worker side ----
const db = new DatabaseSync(':memory:');
for (const f of ['0001_init.sql', '0002_runs.sql']) db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
const wrap = (sql) => {
  const stmt = db.prepare(sql);
  const api = (args) => ({
    first: async () => stmt.get(...args) ?? null,
    all: async () => ({ results: stmt.all(...args) }),
    run: async () => { const i = stmt.run(...args); return { meta: { changes: i.changes } }; },
  });
  return { ...api([]), bind: (...args) => api(args) };
};
const env = { DB: { prepare: wrap } };
// The page makes one decision per tick with no trade spacing, so match that here:
// one price and one check per minute, and no minimum time between trades.
CONFIG.sleep = async (ms) => { NOW += Math.max(0, ms); };
CONFIG.priceIntervalMs = 60000;
CONFIG.evalIntervalMs = 60000;
CONFIG.minTradeIntervalMs = 0;
let NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
Date.now = () => NOW;
let current = 64000;
globalThis.fetch = async (url) => {
  if (url.includes('/ticker')) return Response.json({ price: String(current) });
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push([Math.floor(NOW / 1000) - (i + 1) * 60, 0, 0, 0, 64000, 1]);
  return Response.json(rows);
};
async function workerStep(price) {
  current = price;
  NOW += 60000;
  await runOnce(env);
  const row = await wrap('SELECT action FROM decisions ORDER BY id DESC LIMIT 1').first();
  return row.action;
}

// ---- compare ----
const pageActions = [];
const workerActions = [];
for (const price of path) {
  pageActions.push(pageStep(price));
  workerActions.push(await workerStep(price));
}
const mismatches = [];
pageActions.forEach((a, i) => { if (a !== workerActions[i]) mismatches.push({ step: i, page: a, worker: workerActions[i] }); });
const count = (arr, name) => arr.filter((a) => a === name).length;
for (const name of ['BUY', 'SELL', 'STOP-LOSS', 'TAKE-PROFIT', 'FILTERED', 'WATCH']) {
  console.log(`${name.padEnd(12)} page: ${String(count(pageActions, name)).padStart(3)}   worker: ${String(count(workerActions, name)).padStart(3)}`);
}
console.log(`steps compared: ${path.length}, mismatches: ${mismatches.length}`);
if (mismatches.length) { console.log(mismatches.slice(0, 15)); process.exitCode = 1; }
else console.log('PARITY OK: page and worker make the same decision on every step');
