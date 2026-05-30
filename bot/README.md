# Polymarket Free-Arb Bot

A small, auditable bot that **only** acts on near risk-free arbitrage:
`best-ask(YES) + best-ask(NO) < $1`. Buying one YES + one NO costs that sum and pays
exactly **$1** at resolution — so if the sum is below $1 (after a fee/slippage buffer),
the difference is locked in regardless of outcome.

**Paper-trading by default. It places nothing until you explicitly authorize live mode.**

## Run it (paper mode — safe, zero install)
```bash
cd bot
node index.js          # scans every 15s, LOGS the arbs it would take, places nothing
ONCE=true node index.js  # single scan, then exit
```
Requires Node 18+ (uses global `fetch`). Paper mode tracks simulated positions in
`bot/state.json` (gitignored).

## What it does each cycle
1. Pulls the top ~150 active **binary** Polymarket markets (Gamma API).
2. Fetches both outcome order books (CLOB API).
3. Flags any market where `askYES + askNO < $1 − buffer`.
4. Sizes the trade to the smaller top-of-book and your per-trade cap.
5. PAPER: records it. LIVE: signs + posts two fill-or-kill buys.

## Hard guardrails (configurable in `.env`, very tight by default)
| Limit | Default | Meaning |
|---|---|---|
| `MAX_PER_TRADE_USD` | $5 | most committed to one arb pair |
| `MAX_EXPOSURE_USD` | $25 | most across all open positions |
| `DAILY_LOSS_KILL_USD` | $20 | bot stops for the day past this realized loss |
| `MAX_OPEN_POSITIONS` | 5 | |
| `MIN_EDGE_CENTS` (+ `EDGE_BUFFER_CENTS`) | 1.0 (+0.5) | minimum edge required after a safety haircut |

A partial-fill / execution error trips the **kill switch** and stops trading for manual review.

## Going LIVE (real money — only after paper proves out)
1. `cd bot && npm i` (installs `dotenv`, `@polymarket/clob-client`, `ethers`).
2. `cp .env.example .env` and set **all three**: `DRY_RUN=false`, `CONFIRM_LIVE=I_UNDERSTAND`,
   `PRIVATE_KEY=` (a funded **Polygon** wallet: USDC to trade + a little MATIC for gas).
3. Keep `MAX_PER_TRADE_USD=5` and watch it for days before raising anything.

`bot/.env` and `bot/state.json` are gitignored — your key never gets committed.

## Honest limitations — read before risking money
- **Real arbs are rare and fast.** Sub-100ms bots take most of them; this bot polls on a
  timer and will miss the fleeting ones. Expect long stretches of "0 actionable arbs."
- **Legs can fail independently.** Fill-or-kill reduces but doesn't eliminate the risk of
  getting one leg and not the other; the kill switch + manual review is the backstop.
- **Resolution/fee/gas risk** eats thin edges — hence the buffer. A "1¢ edge" can be ~0 net.
- **No profit is guaranteed.** This is a tool, not a money printer. Start in paper mode,
  start tiny, and only scale what you've verified with your own eyes.
