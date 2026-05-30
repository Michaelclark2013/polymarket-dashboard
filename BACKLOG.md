# Backlog — Self-Evolution Loop

## ACTIVE SPRINT — Growth Cycle 1 (DISCOVER 2026-05-29)
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
