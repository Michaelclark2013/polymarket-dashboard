# Bot Buildout Doctrine — "Most-Successful Bot" track for the self-evolution cycle

This is the standing instruction the loop follows when choosing and building BOT work.
Paste the COMMAND block into a DISCOVER/BUILD cycle, or treat it as always-on guidance.

## Thesis (why we build what we build)
On Polymarket in 2026, edge comes from ONE of two things: being faster than everyone
(infrastructure we can't win as retail), or holding an edge that **doesn't decay in
milliseconds**. So we deliberately build toward **latency-tolerant edges + clean execution**,
and we refuse the speed war and the hype.

## Build priority (highest profit-per-effort first)
**TIER 1 — latency-tolerant edges (build first):**
1. Combinatorial / logical-arb EXECUTION — buy a neg-risk basket when Σ best-asks < $1; these
   mispricings persist (seconds, not ms) and are the most defensible money path. Multi-leg with
   safe partial-fill handling. (Detector already exists; build the executor.)
2. Smart-money copy — watch a curated set of sharp wallets via the activity API; detect a NEW
   position within seconds; mirror it sized-down under our caps. Rides genuine alpha.
3. Cross-venue arb — same event priced differently on Polymarket vs Kalshi/sportsbooks; matching
   layer + the other venue's API.

**TIER 2 — execution quality (this decides win/lose more than strategy):**
4. Replace REST timer polling with the live WebSocket order feed; react on-change, not on a 15s
   tick. Biggest single upgrade — turns "sees arbs after they're gone" into "catches them."
5. Maker-side + liquidity rewards — post resting orders where it flips marginal EV positive.
6. Reliability: partial-leg recovery, fee+gas-aware EV, capital efficiency, fill reconciliation
   into state, real realized-P&L, structured audit log, monitoring/alerting, reconnect.

**TIER 3 — where retail can out-think the market:**
7. A genuine model on NICHE/illiquid markets (under-covered sports/politics/weather) — the only
   place a "model" durably makes money. Not BTC 15-min candles.

## Anti-patterns — do NOT build
- Single-market YES+NO arb as the PRIMARY strategy (HFT owns the <200ms window; keep only as
  opportunistic).
- Latency / Chainlink-feed front-running (needs sub-second co-located infra we don't have).
- Anything justified by "98% win rate" screenshots (survivorship/lucky-streak bait).

## Non-negotiable rules (unchanged, every build)
- Paper-default. Live stays TRIPLE-gated (DRY_RUN=false + CONFIRM_LIVE=I_UNDERSTAND +
  PRIVATE_KEY). The loop NEVER enables live, never sets DRY_RUN=false, never touches .env/keys.
- Risk caps + kill switch may only be TIGHTENED. New strategies ship paper-only.
- Never fabricate data; degrade every external call to an honest empty. Wrap all I/O in try/catch.
- Each strategy must be PROVEN in paper (logged signals + simulated fills + P&L) before it is
  even considered live-eligible.

## Acceptance criteria per build (gate before commit)
`node --check` all changed bot files; run `ONCE=true node bot/index.js` → must log MODE: PAPER,
place nothing, no secret staged; new strategy must emit clear paper signals on live data; update
LEDGER.md + BACKLOG.md with what was built and its paper result.

---

## COMMAND (drop into a cycle phase)
```
For BOT work this cycle, follow BOT_BUILDOUT.md. Build strictly in priority order (Tier 1 →
Tier 2 → Tier 3), one coherent increment per BUILD phase, highest profit-per-effort first:
currently #4 live WebSocket order feed (replace 15s REST polling) + #1 combinatorial multi-leg
paper executor are the top two — do those before anything else. Honor the non-negotiable rules
(paper-default, triple-gated live, loop never enables live, caps only tighten, no fabricated
data, honest-empty on failure). Gate per the acceptance criteria, commit, update LEDGER/BACKLOG,
then continue the loop. Skip deploy (disabled). Never chase the anti-patterns listed.
```
