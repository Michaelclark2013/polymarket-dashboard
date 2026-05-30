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

## Going LIVE (real money) — full runbook
Do this only after paper mode has proven profitable. Every step is reversible until step 7.

```bash
cd bot
npm i                                  # 1. install live deps (clob-client, ethers, dotenv)
cp .env.example .env                   # 2. create your env
#    edit .env → set PRIVATE_KEY (and SIGNATURE_TYPE/FUNDER_ADDRESS if funds are in a Polymarket UI account)
# 3. fund that wallet with USDC.e on Polygon (+ a little MATIC for gas)
node preflight.js --set-allowance      # 4. approve USDC for the exchange + verify readiness (places NO trades)
node preflight.js                      # 5. should print "READY"
#    edit .env → DRY_RUN=false  and  CONFIRM_LIVE=I_UNDERSTAND      # 6. arm live
node index.js                          # 7. LIVE. Starts at $5/trade.
```

**Wallet types (the #1 gotcha):**
- If you exported the private key of a normal wallet that **holds the USDC itself** → `SIGNATURE_TYPE=0` (default), leave `FUNDER_ADDRESS` blank.
- If your money sits in a **Polymarket UI account** (email/magic or browser-wallet) → set `SIGNATURE_TYPE=1` (or `2`) and `FUNDER_ADDRESS=` your Polymarket proxy/deposit address.
- `preflight.js` shows the signer + funder it will use and your actual USDC balance/allowance, so you catch a mismatch *before* trading.

**Built-in real-money guards (in addition to the caps):**
- Three locks to even arm live: `DRY_RUN=false` **and** `CONFIRM_LIVE=I_UNDERSTAND` **and** a `PRIVATE_KEY`.
- Before the first live order each run, the bot re-checks USDC balance ≥ `MIN_USDC_BALANCE` and allowance > 0 — otherwise it trips the kill switch and trades nothing.
- Orders are fill-or-kill; a partial/failed leg trips the kill switch for manual review.

`bot/.env`, `bot/state.json`, `bot/node_modules` are gitignored — your key never gets committed.

## Honest limitations — read before risking money
- **Real arbs are rare and fast.** Sub-100ms bots take most of them; this bot polls on a
  timer and will miss the fleeting ones. Expect long stretches of "0 actionable arbs."
- **Legs can fail independently.** Fill-or-kill reduces but doesn't eliminate the risk of
  getting one leg and not the other; the kill switch + manual review is the backstop.
- **Resolution/fee/gas risk** eats thin edges — hence the buffer. A "1¢ edge" can be ~0 net.
- **No profit is guaranteed.** This is a tool, not a money printer. Start in paper mode,
  start tiny, and only scale what you've verified with your own eyes.
