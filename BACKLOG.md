# Backlog — Self-Evolution Loop

## ACTIVE SPRINT — Growth Cycle 3 (DISCOVER 2026-05-30) — BUILD next, ordered by value
7. **[DASH/BOT] Combinatorial executability check** — fetch real best-asks for each leg of a
   Σ<$1 basket before flagging, recompute executable Σ; avoids illiquid-longshot traps. HIGH.
8. **[DASH] Watchlist of smart wallets** — save inspected wallets (localStorage); one button to
   refresh all and show their NEWEST positions as a feed (honest "copy trading" surface). HIGH.
5. **[DASH] Alert engine** — user thresholds (edge≥X, free-arb, combinatorial Σ<$1) → toast + log.
4. **[DASH] Auto cross-venue (Kalshi) reference** for the REF column (graceful fallback + manual).

## BOT "MOST-SUCCESSFUL" BUILDOUT TRACK (follow BOT_BUILDOUT.md — strict priority order)
Build latency-tolerant edges + execution quality; paper-first; loop never enables live.
- T2-#4 [BOT] Live WebSocket order feed (replace 15s REST polling; react on-change)  ← NEXT
- T1-#1 [BOT] Combinatorial multi-leg paper executor (buy neg-risk basket when Σ best-asks<$1) ← NEXT
- T1-#2 [BOT] Smart-money copy (watch sharp wallets via activity API; mirror new positions, sized down)
- T1-#3 [BOT] Cross-venue arb (Polymarket vs Kalshi/sportsbooks matching layer)
- T2-#5 [BOT] Maker-side + liquidity rewards (post resting orders where EV flips positive)
- T2-#6 [BOT] Reliability: partial-leg recovery, fee+gas EV, fill reconciliation, realized P&L, audit log
- T3-#7 [BOT] Niche-market model (under-covered sports/politics/weather — durable retail edge)
AVOID: single-market arb as primary, latency/Chainlink front-running, hype "98% win" patterns.

## LIVE-READINESS TRACK (ongoing; live path stays GATED + paper-default — loop NEVER enables it)
SHIPPED: real clob-client signing path (signatureType/funder), preflight.js readiness checker
(creds + USDC balance + allowance, optional --set-allowance), pre-trade balance/allowance guard,
fill-or-kill orders, full live runbook. Wallet keys/secrets gitignored.
NEXT: fill reconciliation → state, real realized-P&L tracking, partial-fill recovery, tick/min-
size validation, resolved-position redeem, on-chain exposure refresh, structured audit log,
optional market-order mode. (All paper-default; live requires the human's triple opt-in.)

## SHIPPED — Growth Cycle 2 BUILD (2026-05-30) — commit 928310c
- #6 [DASH] Smart-money whale view — /holders?market=cid → top holders per outcome; 🐋 button
  in Discover; click a whale → inspect their wallet. Verified live (no fabricated fields).

## SHIPPED — Growth Cycle 1 BUILD (2026-05-30) — commit a997338
- #1 [DASH] Combinatorial arb scan (neg-risk/mutually-exclusive only; Σ<$1 buy-all signals;
  verified live vs Gamma; false-positive independent-market bug caught & fixed in smoke test).
- #2 [DASH] Smart-money wallet inspector (Polymarket Data API: value/positions/activity;
  pivoted from leaderboard which has no public API; no fabricated fields).
- #3 [BOT] Multi-outcome buy-all arb (paper-only; safety-critical neg-risk filter; caps intact).

## ARCHIVE — Growth Cycle 1 (DISCOVER 2026-05-29)
Research basis: combinatorial/logical arb edges persist far longer than single-market arb
(median 3.6s and <200ms windows → bot-only); 7,000+ markets show measurable combinatorial
mispricing; $40M extracted Apr'24–Apr'25. Smart-money wallet tracking is well-supported by
Polymarket's Data API + leaderboards. Ordered by money-impact.

1. **[DASH][BOT] Logical / combinatorial arb consistency checker** — HIGHEST VALUE.
   FOR: surface mispricings that DON'T need sub-100ms speed (multi-outcome event groups where
   Σ outcome prices ≠ 1; temporal nesting like "before June" ≤ "before July"; "A or B" vs A,B).
   DATA: Gamma `/events` groups related markets + their outcomes (browser-fetchable; degrade
   to honest empty). IMPL: new Scanner panel — fetch event groups, compute Σ best-ask across
   mutually-exclusive outcomes (<$1 → buy-all arb) and monotonic/temporal violations, rank by
   edge, one-click → Analyzer. Later mirror as a [BOT] paper strategy (multi-leg, paper-only).
   FEASIBILITY: high; Gamma events endpoint is public.

2. **[DASH] Smart-money wallet tracker** (the X-post idea, done honestly).
   FOR: rank top Polymarket wallets by realized PnL / win-rate, view their open + recent
   positions, one-click a market → Analyzer. DATA: Polymarket Data API (leaderboard +
   `/positions?user=` + `/activity`); degrade to "unavailable" on CORS/network. IMPL: new
   "Smart Money" tab; cache results; show wallet, win%, PnL, recent entries. NO fabricated
   stats — show "—" when a field is missing. (Foundation for a future opt-in copy strategy.)

3. **[BOT] Multi-outcome arb + focus-watchlist polling** (paper-only, caps preserved).
   FOR: extend the bot past binary to multi-outcome markets (Σ all outcome best-asks < $1 →
   buy all → guaranteed $1) AND add a small "focus" watchlist polled faster (e.g. 2-3s) to
   actually catch the fast single-market arbs the 15s scan misses. SAFETY: stays paper by
   default; per-trade/exposure/daily-loss/max-open caps + kill switch unchanged or tighter.

4. **[DASH] Auto cross-venue (Kalshi) reference for the REF column.**
   FOR: replace the manual cross-venue ref price with an auto-pull so the Scanner's arb gap is
   live. DATA: Kalshi public markets API (CORS uncertain → degrade gracefully; keep manual
   override). IMPL: fuzzy-match Polymarket question → Kalshi market, fill `ref`, flag gaps ≥3¢.

5. **[DASH] Alert engine.**
   FOR: user-defined triggers (edge ≥ X, free-arb detected, combinatorial violation, a tracked
   smart-money wallet enters a market) → visual + optional sound + localStorage log. IMPL:
   rules stored in state.settings; evaluated on each Live/Scanner refresh; non-blocking toast.

## SHIPPED (do not redo)
- Cycle 1 (fix): XSS escape, proto-pollution guard, localStorage crash-proofing, WS data-
  integrity, MC clamp, EV relabel, a11y/mobile.
- Cycle 2 (feat): 20 features — free-arb detector, discovery, slippage/fee-adj EV,
  microstructure suite, cluster risk + heat, calibration/Brier, risk-adjusted stats,
  edge→ROI fit, bootstrap projection, catalyst tracking.
- Bot v0.1: paper-default free-arb bot, hard caps, kill switch.

## REJECTED / OUT OF SCOPE (with reason)
- Latency arb (Chainlink feed front-run) — needs sub-second infra we don't have.
- Pure single-market arb as primary edge — windows <200ms, taken by HFT bots; keep detector
  only as opportunistic.
- Auto-enabling live bot trading — human-only, never from the loop.
