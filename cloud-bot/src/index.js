// Paper-trading bot for Cloudflare Workers (Stage 1).
// Every minute it reads the public BTC-USD price from Coinbase, applies the
// same momentum rules as the web page, and records the result in D1.
// It never places real orders and never touches real money.

const CONFIG = {
  startingBalance: 20,      // fake dollars
  trendFilter: true,        // skip buys when the broader trend is down
  stopLossPct: 0.03,        // sell if price falls 3% from its peak (trailing)
  takeProfitPct: 0.06,      // sell if price rises 6% above entry
  trailingStop: true,
  // FEE MODEL - ESTIMATES, NOT VERIFIED ACCOUNT RATES.
  // Coinbase's fee depends on your account tier and 30-day volume, and the full
  // schedule is not published. 0.60% is the entry-tier taker rate cited by
  // third-party sources. Confirm your rate in your Coinbase account and update it here.
  takerFeeRate: 0.006,      // ESTIMATE: 0.60% of the amount traded, per market order
  slippageRate: 0.0005,     // ESTIMATE: 0.05% price impact per fill (spread + slippage)
  feeLabel: 'ESTIMATE: 0.60% taker fee + 0.05% slippage per fill. Not verified against your Coinbase account.',
  priceIntervalMs: 10000,       // refresh the BTC-USD price every 10 seconds
  evalIntervalMs: 20000,        // evaluate the strategy every 20 seconds
  cycleMs: 60000,               // one scheduled run covers one minute of checks
  maxPriceAgeMs: 30000,         // a price older than this is stale: no signal is generated from it
  rateLimitBaseMs: 10000,       // first pause after HTTP 429; doubles on each further 429
  rateLimitMaxMs: 60000,        // longest pause after HTTP 429
  minTradeIntervalMs: 120000,   // minimum time between actual trades (stop-losses are exempt)
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  keepBars: 120,            // minute prices kept for the moving averages
  keepDecisions: 3000,      // decision log rows kept
};

const HEADERS = { 'User-Agent': 'crypt-bot-paper/0.1', Accept: 'application/json' };
const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
const CANDLES_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60';

// ---------- Price data ----------

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`price feed returned HTTP ${res.status}`);
  return res.json();
}

async function fetchCurrentPrice() {
  const data = await fetchJSON(TICKER_URL);
  const price = parseFloat(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('bad price in response');
  return price;
}

// Last ~300 one-minute candles, oldest first: [minuteNumber, close]
async function fetchRecentMinutes() {
  const rows = await fetchJSON(CANDLES_URL); // newest first: [time, low, high, open, close, volume]
  if (!Array.isArray(rows) || rows.length < 25) throw new Error('not enough candle history');
  return rows
    .map((r) => [Math.floor(r[0] / 60), r[4]])
    .reverse();
}

// ---------- Database helpers ----------

// Older saved state has no costBasis or realizedPL. Derive them from cash and
// holdings so that the accounting still reconciles.
function normalize(state) {
  if (state.costBasis === undefined) {
    state.costBasis = state.holdings > 0 ? state.startingBalance - state.cash : 0;
  }
  if (state.realizedPL === undefined) {
    state.realizedPL = state.cash - state.startingBalance + state.costBasis;
  }
  return state;
}

async function loadState(db) {
  const row = await db.prepare('SELECT data FROM state WHERE id = 1').first();
  if (row) return normalize(JSON.parse(row.data));
  return {
    cash: CONFIG.startingBalance,
    holdings: 0,
    entryPrice: null,
    peak: null,
    startingBalance: CONFIG.startingBalance,
    costBasis: 0,       // cash spent on the open position, fee included
    realizedPL: 0,      // profit/loss on closed trades, fees included
    lastValid: null,    // last valid BTC-USD price
    lastValidAt: 0,     // when that price was received (ms)
    lastPriceAt: 0,     // last successful price update (ms)
    lastEvalAt: 0,      // last strategy evaluation (ms)
    lastTradeAt: 0,     // last actual trade (ms)
    rateLimitUntil: 0,  // no price requests until this time (ms)
    rateLimitStep: 0,   // consecutive HTTP 429 responses
    trades: 0,
    wins: 0,
    fees: 0,
    protectExits: 0,
    startedAt: Date.now(),
  };
}

async function saveState(db, state) {
  await db
    .prepare('INSERT INTO state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
    .bind(JSON.stringify(state))
    .run();
}

async function saveBar(db, minute, close) {
  await db.prepare('INSERT OR REPLACE INTO bars (ts, close) VALUES (?, ?)').bind(minute, close).run();
  await db
    .prepare('DELETE FROM bars WHERE ts NOT IN (SELECT ts FROM bars ORDER BY ts DESC LIMIT ?)')
    .bind(CONFIG.keepBars)
    .run();
}

async function loadCloses(db) {
  const { results } = await db
    .prepare('SELECT close FROM bars ORDER BY ts DESC LIMIT ?')
    .bind(CONFIG.keepBars)
    .all();
  return results.map((r) => r.close).reverse();
}

async function logDecision(db, minute, price, action, note) {
  await db
    .prepare('INSERT INTO decisions (ts, price, action, note) VALUES (?, ?, ?, ?)')
    .bind(minute, price, action, note)
    .run();
  await db
    .prepare('DELETE FROM decisions WHERE id NOT IN (SELECT id FROM decisions ORDER BY id DESC LIMIT ?)')
    .bind(CONFIG.keepDecisions)
    .run();
}

// ---------- Strategy (same rules as the web page's Momentum strategy) ----------

function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Trend = 20-minute average now compared with 15 minutes ago.
function broaderTrend(closes) {
  if (closes.length < 35) return 'unknown';
  const now = average(closes.slice(-20));
  const past = average(closes.slice(-35, -15));
  if (now > past * 1.001) return 'up';
  if (now < past * 0.999) return 'down';
  return 'flat';
}

// Buy: half of the cash leaves the account, and the fee comes out of that amount.
// The fill price includes slippage. Signals still use the quoted price.
// Minimum time between actual trades. Stop-losses don't use this check.
function canTrade(state) {
  return Date.now() - (state.lastTradeAt || 0) >= CONFIG.minTradeIntervalMs;
}

function buy(state, price) {
  const spend = state.cash * 0.5;
  const fill = price * (1 + CONFIG.slippageRate);
  const fee = spend * CONFIG.takerFeeRate;
  state.cash -= spend;
  state.holdings += (spend - fee) / fill;
  state.costBasis += spend;
  state.entryPrice = price;
  state.peak = price;
  state.trades += 1;
  state.fees += fee;
  state.lastTradeAt = Date.now();
}

// Sell: the fee comes out of the proceeds. The trade's profit/loss is the net
// proceeds minus the cost basis, so each fee is counted exactly once.
function sell(state, price, exitType) {
  const fill = price * (1 - CONFIG.slippageRate);
  const gross = state.holdings * fill;
  const fee = gross * CONFIG.takerFeeRate;
  const proceeds = gross - fee;
  if (proceeds > state.costBasis) state.wins += 1;
  state.cash += proceeds;
  state.fees += fee;
  state.realizedPL += proceeds - state.costBasis;
  state.costBasis = 0;
  state.holdings = 0;
  state.entryPrice = null;
  state.peak = null;
  if (exitType) state.protectExits += 1;
  state.lastTradeAt = Date.now();
}

// What the open position is worth if sold now, after the exit fee and slippage.
function sellNowValue(state, price) {
  if (!(state.holdings > 0)) return 0;
  return state.holdings * price * (1 - CONFIG.slippageRate) * (1 - CONFIG.takerFeeRate);
}

// Portfolio = cash + value of holdings if sold now. This equals
// starting balance + realized P/L + unrealized P/L.
function accounting(state, price) {
  const netValue = price == null ? 0 : sellNowValue(state, price);
  const holding = state.holdings > 0;
  return {
    portfolio: state.cash + netValue,
    holdingsValue: price == null ? 0 : state.holdings * price,
    holdingsNetValue: netValue,
    unrealizedPL: holding ? netValue - state.costBasis : 0,
    breakEvenPrice: holding
      ? state.costBasis / (state.holdings * (1 - CONFIG.slippageRate) * (1 - CONFIG.takerFeeRate))
      : null,
  };
}

// Returns { action, note } and updates state in place.
function decide(state, price, closes) {
  // Stop-loss and take-profit come first, like on the page.
  if (state.holdings > 0 && state.entryPrice) {
    if (state.peak === null || price > state.peak) state.peak = price;
    const stopRef = CONFIG.trailingStop ? state.peak : state.entryPrice;
    const change = (price - stopRef) / stopRef;
    const gain = (price - state.entryPrice) / state.entryPrice;
    if (CONFIG.stopLossPct > 0 && change <= -CONFIG.stopLossPct) {
      sell(state, price, true);
      return { action: 'STOP-LOSS', note: `price moved ${(change * 100).toFixed(2)}% from ${CONFIG.trailingStop ? 'peak' : 'entry'}` };
    }
    if (CONFIG.takeProfitPct > 0 && gain >= CONFIG.takeProfitPct && canTrade(state)) {
      sell(state, price, true);
      return { action: 'TAKE-PROFIT', note: `price up ${(gain * 100).toFixed(2)}% from entry` };
    }
  }

  if (closes.length < 20) return { action: 'WATCH', note: 'gathering price history' };

  const shortMA = average(closes.slice(-5));
  const longMA = average(closes.slice(-20));
  const trend = broaderTrend(closes);

  if (state.holdings === 0 && shortMA > longMA * 1.001 && state.cash > 0 && canTrade(state)) {
    if (CONFIG.trendFilter && trend === 'down') {
      return { action: 'FILTERED', note: 'buy signal, but broader trend is down' };
    }
    buy(state, price);
    return { action: 'BUY', note: `short average ${shortMA.toFixed(2)} above long average ${longMA.toFixed(2)}, trend: ${trend}` };
  }
  if (state.holdings > 0 && shortMA < longMA * 0.999 && canTrade(state)) {
    sell(state, price, false);
    return { action: 'SELL', note: `short average ${shortMA.toFixed(2)} fell below long average ${longMA.toFixed(2)}` };
  }
  return { action: 'WATCH', note: `short ${shortMA.toFixed(2)} vs long ${longMA.toFixed(2)}, trend: ${trend}` };
}

// ---------- One scheduled run (covers one minute) ----------
// Cloudflare's cron fires once a minute. Inside that minute this loop refreshes
// the price every priceIntervalMs and evaluates the strategy every evalIntervalMs.

async function refreshPrice(db, state, minute) {
  const now = Date.now();
  if (now < (state.rateLimitUntil || 0)) return; // backing off: keep the last valid price
  try {
    const price = await fetchCurrentPrice();
    state.lastValid = price;
    state.lastValidAt = now;
    state.lastPriceAt = now;
    state.lastRun = now;
    state.rateLimitStep = 0;
    state.rateLimitUntil = 0;
    await saveBar(db, minute, price); // the current minute's bar follows the latest price
    await saveState(db, state);
  } catch (err) {
    if (/HTTP 429/.test(err.message)) {
      state.rateLimitStep = (state.rateLimitStep || 0) + 1;
      const delay = Math.min(CONFIG.rateLimitMaxMs, CONFIG.rateLimitBaseMs * 2 ** (state.rateLimitStep - 1));
      state.rateLimitUntil = now + delay;
      await logDecision(db, minute, state.lastValid ?? 0, 'RATE-LIMIT', `Coinbase HTTP 429; pausing price requests for ${delay / 1000}s`);
      await saveState(db, state);
    }
    // Other errors: keep the last valid price. evaluate() refuses stale data.
  }
}

async function evaluate(db, state, minute) {
  const now = Date.now();
  state.lastEvalAt = now;
  state.lastRun = now;
  if (state.lastValid == null || now - (state.lastValidAt || 0) > CONFIG.maxPriceAgeMs) {
    await logDecision(db, minute, state.lastValid ?? 0, 'STALE', 'no fresh price; no signal generated');
    await saveState(db, state);
    return;
  }
  const price = state.lastValid;
  state.lastPrice = price;
  const closes = await loadCloses(db); // includes this minute's bar at the latest price
  const { action, note } = decide(state, price, closes);
  await saveState(db, state);
  await logDecision(db, minute, price, action, note);
}

async function runOnce(env) {
  const db = env.DB;
  const startedAt = Date.now();
  const minute = Math.floor(startedAt / 60000);

  // Claim this minute. If another run already claimed it, stop here, so
  // overlapping or repeated executions can't place the same trade twice.
  const claim = await db.prepare('INSERT OR IGNORE INTO runs (ts) VALUES (?)').bind(minute).run();
  if (claim.meta?.changes !== 1) return;
  await db.prepare('DELETE FROM runs WHERE ts NOT IN (SELECT ts FROM runs ORDER BY ts DESC LIMIT 500)').run();

  // First run (or after a gap): fill in recent history so the averages work right away.
  const count = await db.prepare('SELECT COUNT(*) AS n FROM bars').first();
  if (count.n < 35) {
    try {
      for (const [m, close] of await fetchRecentMinutes()) {
        await db.prepare('INSERT OR REPLACE INTO bars (ts, close) VALUES (?, ?)').bind(m, close).run();
      }
    } catch (err) {
      await logDecision(db, minute, 0, 'ERROR', `could not load history: ${err.message}`);
      return;
    }
  }

  const state = await loadState(db);
  const endAt = startedAt + CONFIG.cycleMs;
  let nextPriceAt = startedAt;
  let nextEvalAt = startedAt;
  while (Date.now() < endAt) {
    const now = Date.now();
    if (now >= nextPriceAt) {
      await refreshPrice(db, state, minute);
      nextPriceAt = now + CONFIG.priceIntervalMs;
    }
    if (now >= nextEvalAt) {
      await evaluate(db, state, minute);
      nextEvalAt = now + CONFIG.evalIntervalMs;
    }
    await CONFIG.sleep(Math.min(nextPriceAt, nextEvalAt, endAt) - Date.now());
  }
}

// ---------- Web endpoints (read-only) ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function status(env) {
  const db = env.DB;
  const state = await loadState(db);
  const price = state.lastValid ?? state.lastPrice ?? null;
  const acct = accounting(state, price);
  const { results } = await db.prepare('SELECT ts, price, action, note FROM decisions ORDER BY id DESC LIMIT 50').all();
  const { results: bars } = await db.prepare('SELECT ts, close FROM bars ORDER BY ts DESC LIMIT ?').bind(CONFIG.keepBars).all();
  const prices = bars.reverse().map((b) => ({ ts: b.ts, close: b.close }));
  return json({
    mode: 'PAPER (no real orders)',
    feeModel: { takerFeeRate: CONFIG.takerFeeRate, slippageRate: CONFIG.slippageRate, label: CONFIG.feeLabel },
    startingBalance: state.startingBalance,
    cash: state.cash,
    holdings: state.holdings,
    holdingsValue: acct.holdingsValue,
    holdingsNetValue: acct.holdingsNetValue,
    costBasis: state.costBasis,
    entryPrice: state.entryPrice,
    price,
    portfolio: acct.portfolio,
    portfolioMarket: state.cash + acct.holdingsValue,
    profitLoss: acct.portfolio - state.startingBalance,
    realizedPL: state.realizedPL,
    unrealizedPL: acct.unrealizedPL,
    feesPaid: state.fees,
    breakEvenPrice: acct.breakEvenPrice,
    trades: state.trades,
    wins: state.wins,
    protectExits: state.protectExits,
    lastRun: state.lastRun ?? null,
    running: state.lastRun ? Date.now() - state.lastRun < 90000 : false,
    lastPriceAt: state.lastPriceAt || null,
    lastEvalAt: state.lastEvalAt || null,
    nextPriceAt: state.lastPriceAt ? state.lastPriceAt + CONFIG.priceIntervalMs : null,
    nextEvalAt: state.lastEvalAt ? state.lastEvalAt + CONFIG.evalIntervalMs : null,
    rateLimitedUntil: state.rateLimitUntil > Date.now() ? state.rateLimitUntil : null,
    lastTradeAt: state.lastTradeAt || null,
    minTradeIntervalMs: CONFIG.minTradeIntervalMs,
    priceIntervalMs: CONFIG.priceIntervalMs,
    evalIntervalMs: CONFIG.evalIntervalMs,
    recentDecisions: results,
    prices,
  });
}

// ---------- Phone dashboard (served at /) ----------
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crypt Bot</title>
<style>
  body { margin: 0; background: #0b0716; color: #e8e3ff; font-family: system-ui, sans-serif; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; color: #ff2fd0; }
  .sub { font-size: 12px; color: #8a7bb8; margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .card { background: #120b22; border: 1px solid #2a1a4d; border-radius: 6px; padding: 12px; }
  .label { font-size: 11px; color: #8a7bb8; text-transform: uppercase; letter-spacing: .08em; }
  .val { font-size: 18px; font-weight: 700; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pos { color: #39ff8f; }
  .neg { color: #ff3860; }
  canvas { width: 100%; height: 220px; display: block; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  td { padding: 6px 4px 6px 0; border-bottom: 1px dashed #2a1a4d; vertical-align: top; }
  .buy { color: #39ff8f; }
  .sell { color: #ff3860; }
  .watch { color: #8a7bb8; }
  .warn { color: #ffb84d; font-size: 12px; margin: 12px 0 0; }
  .section { margin-top: 10px; }
  body { background: #0b0716; min-height: 100vh; }
  .card { border-color: #3d2470; }
  .chartcard { border-color: #ff2fd0; border-width: 2px; }
  .pos { color: #39ff8f; }
  .neg { color: #ff3860; }
  canvas { height: 280px; cursor: crosshair; touch-action: none; }
</style>
</head>
<body>
<h1>Crypt Bot (paper money)</h1>
<div class="sub" id="meta">Loading...</div>
<div class="sub" id="timing">Bot status: loading...</div>

<div class="grid">
  <div class="card"><div class="label">Portfolio (market value)</div><div class="val" id="portfolio">-</div></div>
  <div class="card"><div class="label">Profit / loss if sold now</div><div class="val" id="pl">-</div></div>
  <div class="card"><div class="label">BTC price</div><div class="val" id="price">-</div></div>
  <div class="card"><div class="label">Trades</div><div class="val" id="trades">-</div></div>
  <div class="card"><div class="label">Cash</div><div class="val" id="cash">-</div></div>
  <div class="card"><div class="label">Holding</div><div class="val" id="holding">-</div></div>
</div>

<div class="card section">
  <div class="label">Accounting (fees are estimates)</div>
  <table id="acct"></table>
  <div class="warn" id="feeNote"></div>
</div>

<div class="card section chartcard">
  <div class="label">Price, last 2 hours - touch or hover to inspect <span id="liveTag" style="color:#39ff8f">&#9679; LIVE</span></div>
  <canvas id="chart"></canvas>
</div>

<div class="card section">
  <div class="label">Recent decisions</div>
  <table id="log"></table>
</div>

<div class="warn">Paper trading only. No real money is used.</div>

<script>
var REFRESH_MS = 10000;

function money(n) { return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2); }
function esc(v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function setText(id, text) { document.getElementById(id).textContent = text; }

function clock(ms) { return ms ? new Date(ms).toLocaleTimeString() : '-'; }
function renderTiming(s) {
  var txt = 'Bot: ' + (s.running ? 'RUNNING' : 'NOT RUNNING') +
    ' - last price ' + clock(s.lastPriceAt) +
    ' - next check ' + clock(s.nextEvalAt) +
    ' - price every ' + (s.priceIntervalMs / 1000) + 's, check every ' + (s.evalIntervalMs / 1000) + 's';
  if (s.rateLimitedUntil) txt += ' - Coinbase rate limit, backing off until ' + clock(s.rateLimitedUntil);
  setText('timing', txt);
}

var livePrice = null, livePriceAt = 0;
function liveIsFresh() { return livePrice !== null && Date.now() - livePriceAt < 20000; }

var liveDelay = 10000;
async function refreshLivePrice() {
  try {
    var res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var j = await res.json();
    var p = parseFloat(j.price);
    if (!isFinite(p) || p <= 0) throw new Error('bad price');
    livePrice = p;
    livePriceAt = Date.now();
    liveDelay = 10000;
    setText('liveTag', '● LIVE ' + new Date().toLocaleTimeString());
    if (lastS) render(lastS);
  } catch (e) {
    liveDelay = Math.min(60000, liveDelay * 2);
    setText('liveTag', '● PRICE FEED DOWN - retrying');
  }
  setTimeout(refreshLivePrice, liveDelay);
}

async function load() {
  try {
    var res = await fetch('/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var s = await res.json();
    render(s);
    setText('meta', 'Updated ' + new Date().toLocaleTimeString() + ' - refreshes every 10 seconds');
    renderTiming(s);
  } catch (e) {
    setText('meta', 'Could not load status (' + e.message + '). Retrying...');
  }
}

var lastS = null, hoverX = null;

function netValue(s, p) {
  if (!(s.holdings > 0)) return 0;
  return s.holdings * p * (1 - s.feeModel.slippageRate) * (1 - s.feeModel.takerFeeRate);
}

function signed(n) { return (n >= 0 ? '+' : '') + money(n); }

function render(s) {
  lastS = s;
  var live = liveIsFresh();
  var px = live ? livePrice : s.price;
  if (live && s.prices && s.prices.length) {
    s.prices[s.prices.length - 1] = { ts: s.prices[s.prices.length - 1].ts, close: livePrice };
  }
  var net = px == null ? 0 : netValue(s, px);
  var portfolio = s.cash + net;
  var profitLoss = portfolio - s.startingBalance;
  var holdingsValue = px == null ? 0 : s.holdings * px;
  var unrealized = s.holdings > 0 ? net - s.costBasis : 0;

  setText('portfolio', money(s.cash + holdingsValue));
  var pl = document.getElementById('pl');
  pl.textContent = signed(profitLoss);
  pl.className = 'val ' + (profitLoss >= 0 ? 'pos' : 'neg');
  setText('price', px == null ? '-' : money(px));
  setText('trades', s.trades);
  setText('cash', money(s.cash));
  setText('holding', s.holdings.toFixed(6) + ' BTC');

  var rows = [
    ['Starting balance', money(s.startingBalance)],
    ['Available cash', money(s.cash)],
    ['Bitcoin holdings', s.holdings.toFixed(8) + ' BTC'],
    ['Holdings value at market', money(holdingsValue)],
    ['Value if sold now (after fees)', money(net)],
    ['Trading fees paid', money(s.feesPaid)],
    ['Portfolio at market value', money(s.cash + holdingsValue)],
    ['Portfolio if sold now (after fees)', money(portfolio)],
    ['Realized P/L (closed trades)', signed(s.realizedPL)],
    ['Unrealized P/L (open position)', signed(unrealized)],
    ['Break-even BTC price', s.breakEvenPrice == null ? '-' : money(s.breakEvenPrice)]
  ];
  document.getElementById('acct').innerHTML = rows.map(function (r) {
    return '<tr><td>' + esc(r[0]) + '</td><td style="text-align:right">' + esc(r[1]) + '</td></tr>';
  }).join('');
  setText('feeNote', s.feeModel ? s.feeModel.label : '');

  drawChart(s);
  renderLog(s.recentDecisions);
}

function timeLabel(ts) {
  return new Date(ts * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function drawChart(s) {
  var c = document.getElementById('chart');
  var dpr = window.devicePixelRatio || 1;
  var cssW = c.clientWidth, cssH = c.clientHeight;
  c.width = cssW * dpr;
  c.height = cssH * dpr;
  var g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  var pts = s.prices || [];
  if (pts.length < 2) {
    g.fillStyle = '#8a7bb8';
    g.font = '14px system-ui, sans-serif';
    g.fillText('Waiting for price history...', 10, 30);
    return;
  }

  var vals = pts.map(function (p) { return p.close; });
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var pad0 = ((max - min) * 0.12) || (max * 0.0005);
  min -= pad0; max += pad0;
  var L = 56, R = 16, T = 14, B = 24;
  var w = cssW - L - R, h = cssH - T - B;
  function x(i) { return L + i / (pts.length - 1) * w; }
  function y(v) { return T + (1 - (v - min) / (max - min)) * h; }

  // faint grid with price labels
  g.lineWidth = 1;
  g.font = '11px system-ui, sans-serif';
  for (var k = 0; k <= 4; k++) {
    var gv = min + (max - min) * k / 4, gy = y(gv);
    g.strokeStyle = 'rgba(138,123,184,0.16)';
    g.beginPath(); g.moveTo(L, gy); g.lineTo(cssW - R, gy); g.stroke();
    g.fillStyle = '#8a7bb8';
    g.textAlign = 'right';
    g.fillText('$' + Math.round(gv).toLocaleString(), L - 8, gy + 4);
  }
  g.textAlign = 'left';

  // glowing area under the line
  g.beginPath();
  pts.forEach(function (p, i) { if (i) g.lineTo(x(i), y(p.close)); else g.moveTo(x(i), y(p.close)); });
  g.lineTo(x(pts.length - 1), T + h);
  g.lineTo(x(0), T + h);
  g.closePath();
  var fill = g.createLinearGradient(0, T, 0, T + h);
  fill.addColorStop(0, 'rgba(255,47,208,0.22)');
  fill.addColorStop(1, 'rgba(255,47,208,0)');
  g.fillStyle = fill;
  g.fill();

  function linePath() {
    g.beginPath();
    pts.forEach(function (p, i) { if (i) g.lineTo(x(i), y(p.close)); else g.moveTo(x(i), y(p.close)); });
  }
  var grad = g.createLinearGradient(L, 0, cssW - R, 0);
  grad.addColorStop(0, '#2fe3ff');
  grad.addColorStop(1, '#ff2fd0');
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  linePath();
  g.strokeStyle = grad;
  g.lineWidth = 3;
  g.stroke();
  g.restore();

  // buy and sell markers, labelled so color is never the only cue
  var idx = {};
  pts.forEach(function (p, i) { idx[p.ts] = i; });
  (s.recentDecisions || []).forEach(function (d) {
    if (d.action !== 'BUY' && d.action !== 'SELL') return;
    var i = idx[d.ts];
    if (i === undefined) return;
    var col = d.action === 'BUY' ? '#39ff8f' : '#ff3860';
    var mx = x(i), my = y(pts[i].close);
    g.beginPath(); g.arc(mx, my, 6, 0, Math.PI * 2);
    g.fillStyle = col; g.fill();
    g.fillStyle = col;
    g.font = 'bold 10px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(d.action, mx, d.action === 'BUY' ? my + 18 : my - 10);
    g.textAlign = 'left';
  });

  // pulsing "now" dot at the newest price
  var lx = x(pts.length - 1), ly = y(pts[pts.length - 1].close);
  g.beginPath(); g.arc(lx, ly, 5, 0, Math.PI * 2);
  g.fillStyle = '#2fe3ff'; g.fill();

  // time labels along the bottom
  g.fillStyle = '#8a7bb8';
  g.font = '10px system-ui, sans-serif';
  g.fillText(timeLabel(pts[0].ts), L, cssH - 6);
  g.textAlign = 'right';
  g.fillText('now', cssW - R, cssH - 6);
  g.textAlign = 'left';

  // hover / touch readout
  if (hoverX !== null && hoverX >= L && hoverX <= cssW - R) {
    var hi = Math.round((hoverX - L) / w * (pts.length - 1));
    hi = Math.max(0, Math.min(pts.length - 1, hi));
    var hx = x(hi), hy = y(pts[hi].close);
    g.strokeStyle = 'rgba(232,227,255,0.45)';
    g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, T + h); g.stroke();
    g.setLineDash([]);
    g.beginPath(); g.arc(hx, hy, 5, 0, Math.PI * 2);
    g.fillStyle = '#ffffff'; g.fill();
    var txt = '$' + pts[hi].close.toFixed(2) + '  ' + timeLabel(pts[hi].ts);
    g.font = '12px system-ui, sans-serif';
    var tw = g.measureText(txt).width + 14;
    var bx = Math.min(hx + 10, cssW - R - tw);
    var by = Math.max(T, hy - 34);
    g.fillStyle = 'rgba(11,7,22,0.92)';
    g.fillRect(bx, by, tw, 24);
    g.strokeStyle = '#ff2fd0';
    g.lineWidth = 1;
    g.strokeRect(bx, by, tw, 24);
    g.fillStyle = '#e8e3ff';
    g.fillText(txt, bx + 7, by + 16);
  }
}

(function setupChartHover() {
  var c = document.getElementById('chart');
  function moveTo(clientX) {
    var r = c.getBoundingClientRect();
    hoverX = clientX - r.left;
    if (lastS) drawChart(lastS);
  }
  function clearHover() {
    hoverX = null;
    if (lastS) drawChart(lastS);
  }
  c.addEventListener('mousemove', function (e) { moveTo(e.clientX); });
  c.addEventListener('mouseleave', clearHover);
  c.addEventListener('touchstart', function (e) { moveTo(e.touches[0].clientX); }, { passive: true });
  c.addEventListener('touchmove', function (e) { moveTo(e.touches[0].clientX); }, { passive: true });
  c.addEventListener('touchend', clearHover);
  window.addEventListener('resize', function () { if (lastS) drawChart(lastS); });
})();

function renderLog(list) {
  var t = document.getElementById('log');
  t.innerHTML = '';
  (list || []).slice(0, 25).forEach(function (d) {
    var cls = (d.action === 'BUY' || d.action === 'TAKE-PROFIT') ? 'buy'
      : (d.action === 'SELL' || d.action === 'STOP-LOSS') ? 'sell' : 'watch';
    var time = new Date(d.ts * 60000).toLocaleTimeString();
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + esc(time) + '</td><td class="' + cls + '"><b>' + esc(d.action) + '</b></td><td>' + esc(d.note) + '</td>';
    t.appendChild(tr);
  });
}

load();
setInterval(load, REFRESH_MS);
refreshLivePrice();
</script>
</body>
</html>`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/status') return status(env);
    return new Response(DASHBOARD_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

// Exported for testing.
export { CONFIG, decide, broaderTrend, runOnce, buy, sell, accounting, normalize, refreshPrice, evaluate };
