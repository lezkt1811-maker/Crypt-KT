# Crypt-KT

Paper-trading bot project. Everything here uses **fake money**. No real orders are placed.

## What's in this repo

- **`index.html`**: the web page ("Ticker & Trigger"). It runs in your browser and can
  simulate a market or read live Coinbase BTC-USD prices. Open it directly in a browser,
  or host it with GitHub Pages.
- **`cloud-bot/`**: the bot that runs every minute on Cloudflare Workers. It uses the same
  momentum rules as the web page, saves every decision to a database, and serves a
  phone dashboard at the Worker's address.

See `cloud-bot/README.md` for setup, and `cloud-bot/DEPLOY_CHECKLIST.md` for a step-by-step
checklist.

## Deploys

Cloudflare is connected to `main`. Pushes that change `cloud-bot/` redeploy the bot automatically.

## Disclaimer

This project is for learning and testing. Paper results don't predict real-money results.
Fees, slippage, and changing markets all affect real trading.
