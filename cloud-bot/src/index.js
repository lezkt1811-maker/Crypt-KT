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
  feeFlat: 0.5,             // flat fee per trade for balances of $500 or less
  feeRate: 0.001,           // 0.1% per trade for larger balances
  keepBars: 120,            // minute prices kept for the moving averages
  keepDecisions: 1000,      // decision log rows kept
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

async function loadState(db) {
  const row = await db.prepare('SELECT data FROM state WHERE id = 1').first();
  if (row) return JSON.parse(row.data);
  return {
    cash: CONFIG.startingBalance,
    holdings: 0,
    entryPrice: null,
    peak: null,
    startingBalance: CONFIG.startingBalance,
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

function feeFor(value, startingBalance) {
  return startingBalance <= 500 ? CONFIG.feeFlat : value * CONFIG.feeRate;
}

function buy(state, price) {
  const spend = state.cash * 0.5;
  const fee = feeFor(spend, state.startingBalance);
  state.cash -= spend;
  state.holdings += (spend - fee) / price;
  state.entryPrice = price;
  state.peak = price;
  state.trades += 1;
  state.fees += fee;
}

function sell(state, price, exitType) {
  const gross = state.holdings * price;
  const fee = feeFor(gross, state.startingBalance);
  if (price > state.entryPrice) state.wins += 1;
  state.cash += gross - fee;
  state.fees += fee;
  state.holdings = 0;
  state.entryPrice = null;
  state.peak = null;
  if (exitType) state.protectExits += 1;
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
    if (CONFIG.takeProfitPct > 0 && gain >= CONFIG.takeProfitPct) {
      sell(state, price, true);
      return { action: 'TAKE-PROFIT', note: `price up ${(gain * 100).toFixed(2)}% from entry` };
    }
  }

  if (closes.length < 20) return { action: 'WATCH', note: 'gathering price history' };

  const shortMA = average(closes.slice(-5));
  const longMA = average(closes.slice(-20));
  const trend = broaderTrend(closes);

  if (state.holdings === 0 && shortMA > longMA * 1.003) {
    if (CONFIG.trendFilter && trend === 'down') {
      return { action: 'FILTERED', note: 'buy signal, but broader trend is down' };
    }
    buy(state, price);
    return { action: 'BUY', note: `short average ${shortMA.toFixed(2)} above long average ${longMA.toFixed(2)}, trend: ${trend}` };
  }
  if (state.holdings > 0 && shortMA < longMA * 0.997) {
    sell(state, price, false);
    return { action: 'SELL', note: `short average ${shortMA.toFixed(2)} fell below long average ${longMA.toFixed(2)}` };
  }
  return { action: 'WATCH', note: `short ${shortMA.toFixed(2)} vs long ${longMA.toFixed(2)}, trend: ${trend}` };
}

// ---------- One scheduled run ----------

async function runOnce(env) {
  const db = env.DB;
  const minute = Math.floor(Date.now() / 60000);

  // Claim this minute. If another run already claimed it, stop here, so
  // overlapping or repeated executions can't place the same trade twice.
  const claim = await db.prepare('INSERT OR IGNORE INTO runs (ts) VALUES (?)').bind(minute).run();
  if (claim.meta?.changes !== 1) return;
  await db.prepare('DELETE FROM runs WHERE ts NOT IN (SELECT ts FROM runs ORDER BY ts DESC LIMIT 500)').run();

  let price;
  try {
    price = await fetchCurrentPrice();
  } catch (err) {
    // Don't trade on a failed price lookup. Record it and wait for the next run.
    await logDecision(db, minute, 0, 'ERROR', `price fetch failed: ${err.message}`);
    return;
  }

  // First run (or after a gap): fill in recent history so the averages work right away.
  const count = await db.prepare('SELECT COUNT(*) AS n FROM bars').first();
  if (count.n < 35) {
    try {
      for (const [m, close] of await fetchRecentMinutes()) {
        await db.prepare('INSERT OR REPLACE INTO bars (ts, close) VALUES (?, ?)').bind(m, close).run();
      }
    } catch (err) {
      await logDecision(db, minute, price, 'ERROR', `could not load history: ${err.message}`);
      return;
    }
  }

  await saveBar(db, minute, price);
  const closes = await loadCloses(db);

  const state = await loadState(db);
  const { action, note } = decide(state, price, closes);
  state.lastPrice = price;
  state.lastRun = Date.now();
  await saveState(db, state);
  await logDecision(db, minute, price, action, note);
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
  const price = state.lastPrice ?? null;
  const portfolio = price === null ? state.cash : state.cash + state.holdings * price;
  const { results } = await db.prepare('SELECT ts, price, action, note FROM decisions ORDER BY id DESC LIMIT 50').all();
  return json({
    mode: 'PAPER (no real orders)',
    startingBalance: state.startingBalance,
    cash: state.cash,
    holdings: state.holdings,
    entryPrice: state.entryPrice,
    price,
    portfolio,
    profitLoss: portfolio - state.startingBalance,
    trades: state.trades,
    wins: state.wins,
    fees: state.fees,
    protectExits: state.protectExits,
    lastRun: state.lastRun ?? null,
    recentDecisions: results,
  });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/status') return status(env);
    return new Response('Paper-trading bot is running. See /status for numbers. No real orders are placed.\n', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

// Exported for testing.
export { CONFIG, decide, broaderTrend, runOnce };
