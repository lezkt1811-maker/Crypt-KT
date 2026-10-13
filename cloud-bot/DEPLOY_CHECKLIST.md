# Deploy checklist: Crypt bot, Stage 1 (paper money only)

Work through these steps in order. Each step says what you should see.
Paper money only: nothing here connects to a real exchange account.

## Before you start

- [ ] A computer with **Node.js 18 or newer** installed.
      Check: open a terminal and type `node -v`. You should see `v18` or higher.
- [ ] A free **Cloudflare account**: https://dash.cloudflare.com/sign-up
- [ ] This repository on your computer, with the `cloud-bot` folder in it.

## 1. Open a terminal in the bot folder

- [ ] Open a terminal and move into the `cloud-bot` folder.
      Check: type `ls`. You should see `wrangler.toml`, `src`, `migrations`, and `package.json`.

## 2. Install the tools

- [ ] Run: `npm install`
      Check: it finishes without red error lines. A "added N packages" message is normal.

## 3. Log in to Cloudflare

- [ ] Run: `npx wrangler login`
      Check: a browser window opens. Click **Allow**. The terminal says you're logged in.

## 4. Create the database

- [ ] Run: `npx wrangler d1 create crypt-bot`
      Check: the output includes a line like `database_id = "abc123..."`. Copy that id.
      (If you see "already exists", skip to step 5 and use the id you already have.)

## 5. Put the database id into the settings

- [ ] Open `wrangler.toml` in any text editor.
- [ ] Replace `REPLACE_WITH_D1_DATABASE_ID` with the id you copied. Keep the quotation marks.
      Check: the line now reads `database_id = "abc123..."` with your id in it.
- [ ] Save the file.

## 6. Create the tables

- [ ] Run: `npm run migrate`
      Check: it lists `0001_init.sql` and `0002_runs.sql`, both with a green check mark.
      If it asks "continue?", type `y` and press Enter.

## 7. Test the logic on your computer (optional but recommended)

- [ ] Run: `npm test`
      Check: the last line says `ALL CHECKS PASSED`.
- [ ] Run: `node test/parity.js`
      Check: the last line says `PARITY OK`.
      These use fake prices only, so they don't touch Cloudflare or Coinbase.

## 8. Put the bot online

- [ ] Run: `npm run deploy`
      Check: the output ends with a web address like
      `https://crypt-bot.<your-name>.workers.dev`. Copy it.
      Also check that the output lists your `DB` database and a cron schedule of `* * * * *`.

## 9. Confirm it's running (wait about 2 minutes first)

- [ ] Open `https://crypt-bot.<your-name>.workers.dev/status` in your browser.
      Check:
  - `"mode"` says `PAPER (no real orders)`.
  - `"lastRun"` has a number, not `null`.
  - `"recentDecisions"` has entries, each with an `"action"` such as `WATCH`, `BUY`, or `SELL`.
  - `"price"` shows the current Bitcoin price.
- [ ] Refresh about a minute later. The newest decision's time should have moved forward.

## 10. Check the Cloudflare dashboard (optional)

- [ ] Go to https://dash.cloudflare.com, then **Workers & Pages**, then **crypt-bot**.
- [ ] Open **Logs** or **Observability** to see each run.
      Check: runs happen about once a minute.

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `"action": "ERROR"` with "price fetch failed" | Cloudflare could not reach Coinbase's price feed. | Wait a few minutes and refresh. If it keeps happening, the network from Cloudflare to Coinbase is blocked. Tell me the exact error text. |
| `"action": "ERROR"` with "could not load history" | The bot couldn't load the first price history. | Same as above. It retries on the next minute. |
| `"lastRun": null` after 5 minutes | The schedule isn't running. | Check that `wrangler.toml` still has `crons = ["* * * * *"]`, then run `npm run deploy` again. |
| `npm run migrate` fails with "database not found" | The id in `wrangler.toml` is wrong. | Run `npx wrangler d1 list`, copy the correct id, and fix step 5. |
| `/status` shows "no such table" | The tables weren't created. | Run `npm run migrate` again, then `npm run deploy`. |
| Numbers stop changing | The bot may be paused or the schedule was turned off. | Check the trigger in the Cloudflare dashboard under **Settings > Triggers**. |

## Stopping the bot

- [ ] In the Cloudflare dashboard, go to **Workers & Pages**, pick **crypt-bot**, and turn off its
      **Triggers** (cron schedule), or delete the Worker.

## Reminder

This is a paper test. Profit on paper doesn't predict profit with real money. Don't add real funds
until a long paper record, after fees, has convinced you.
