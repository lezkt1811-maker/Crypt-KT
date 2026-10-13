# Crypt bot in the cloud (Stage 1, paper money only)

This version runs every minute on Cloudflare's servers, even when your
computer and browser are off. It uses **fake money** ($20) and the **real**
Bitcoin price from Coinbase. It never places a real order.

Check it any time on your phone at:
`https://crypt-bot.<your-subdomain>.workers.dev`

That page is the dashboard: balance, profit or loss, the live price, a 2-hour
chart with buy and sell markers, and recent decisions. Its raw data is at `/status`.

## One-time setup (about 15 minutes)

You'll need a free Cloudflare account and Node.js installed.

1. **Create a Cloudflare account** at https://dash.cloudflare.com/sign-up (free).
2. **Open a terminal in this folder** (`cloud-bot`) and run:
   ```
   npm install
   npx wrangler login
   ```
   A browser window opens. Click Allow.
3. **Create the database:**
   ```
   npx wrangler d1 create crypt-bot
   ```
   It prints a line like `database_id = "abc123..."`. Copy that id.
4. **Put the id into `wrangler.toml`** in place of `REPLACE_WITH_D1_DATABASE_ID`.
5. **Set up the tables:**
   ```
   npm run migrate
   ```
6. **Put the bot online:**
   ```
   npm run deploy
   ```
   It prints your `workers.dev` address. Open it on your phone to see the dashboard.

The bot starts running on the next minute.

## Checking it

- The main page (`/`) is the phone dashboard. `/status` has the same numbers as raw data.
- "WATCH" means it's waiting. "BUY", "SELL", "STOP-LOSS" and "TAKE-PROFIT"
  are trades, all on paper.
- "ERROR" means the price couldn't be fetched. No trade is made.

## Testing without Cloudflare

```
npm test
```
This runs the trading logic against a fake price feed and a local database.

## Stopping it

In the Cloudflare dashboard, open Workers & Pages, pick `crypt-bot`, and
disable its cron trigger or delete the Worker.

## Important

This is a paper test. Even if it shows a profit, that doesn't mean the
strategy will make money with real funds. Fees, slippage and changing markets
all affect real results.
