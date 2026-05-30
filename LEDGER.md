# Coverage Ledger — Polymarket Edge Terminal (maintenance/polish loop)

Single-file client-side app (`index.html`). No backend/auth/DB; localStorage only;
live data via Polymarket public WebSocket + REST book snapshot. Prod:
https://polymarket-edge-terminal.vercel.app (Vercel project `polymarket-edge-terminal`).

Gate (no build/typecheck/test): JS syntax check of the inline script via `node --check`.
Deploy: `vercel --prod --yes`.

---

## Cycle 1 — 2026-05-29
Surfaces swept (2 parallel read-only audit agents + orchestrator full read):
- **Agent A** — render-boundary/XSS, data integrity, resilience, unbounded growth.
- **Agent B** — a11y/mobile, numeric/financial correctness, honest-data.

Fixed:
- `[SECURITY] :422` — stored/self-XSS: factor name interpolated into `value="..."`
  attribute unescaped → `esc(f.name)`.
- `[SECURITY] :370` — prototype pollution: `deepMerge` over crafted localStorage
  (`__proto__`/`constructor`/`prototype`) → skip dangerous keys.
- `[RESILIENCE] :369` — `save()` `localStorage.setItem` could throw (quota / Safari
  private mode) and abort the calling handler → wrapped in try/catch.
- `[DATA-INTEGRITY] :888–912` — WS frames coerced numerics with no finite check; a NaN
  mid is auto-copied into open positions (4s interval) corrupting P&L and persisting to
  localStorage → drop non-finite book levels / price-changes / trade prices. Same edit
  caps `bids`/`asks` at 200 levels (was unbounded → quota risk).
- `[CORRECTNESS] :586` — Monte-Carlo `# trades` (`m_n`) was unclamped → entering a huge
  value freezes/OOMs the tab → `clamp(…,1,5000)`.
- `[HONESTY] :143` — analyzer readout labeled "EV per $1" actually shows EV per share
  (cost = price, not $1) → relabeled "EV per share".
- `[A11Y] :54,:317-318,:431,:818,:953` — added `aria-label` to the unlabeled bankroll
  input, the two Live-tab inputs (placeholder-only), and the icon-only `×` remove buttons
  (factor / scanner / live card).
- `[MOBILE] :316-318` — Live-tab `w-80`/`w-40` fixed inputs forced horizontal scroll at
  375px → `w-full sm:w-80` / `w-full sm:w-40` + `flex-wrap` on the row.

Verified clean (no action): text-context interpolations all `esc()`'d; REST `fetch` +
WS connect have try/catch → honest empty; `JSON.parse` in `load()` guarded; `trades`
array already capped at 40; Kelly/edge/percentile math correct; dates use local-TZ on
epoch ms (honest); div-by-zero paths guarded.

Deliberately NOT changed (by design / would be churn): demo seed data (clearly "EX:"
prefixed); dead `mtm` local (`:642`); per-frame `save()` (try/catch already prevents the
crash; debounce is an optimization, deferred); ambiguous NO-side "FAIR PROBABILITY" label.

Status: real fixes shipped. Next cycle should rotate to fresh surfaces — suggest: Chart.js
lifecycle/leaks, tab-switch render side-effects, input validation on Analyzer/Sizer number
fields, and full keyboard/focus pass.

---

## Cycle 2 — 2026-05-29 (FEATURE build, user-requested: "make it more powerful / make money")
Shipped 20 profit-oriented features into index.html (all external fetches degrade to an
honest empty/unavailable state — never fabricate). Browser-smoke-tested via preview MCP
(all render paths ok, no console errors; gamma API + clob book fetches confirmed working
live from the browser — free-arb detector validated against real order books).

Data/alpha: #1 live market discovery (Gamma API) + analyzer autocomplete datalist;
#2 discovery screener (top-by-volume, filterable, → analyze); #3 cross-venue reference
price column + arb gap in Scanner; #4 FREE-ARB detector (YES-ask+NO-ask<\$1 / bids>\$1)
against live clob books; #5 catalyst date + countdown on positions.
Microstructure (Live cards): #6 spread/spread%; #7 slippage/fill-price probe (walk ladder);
#8 liquidity within ±band; #9 imbalance trend sparkline; #10 microprice; #11 VWAP + buy-flow
% + trades/min.
Risk (Sizer/Dashboard): #12 cluster exposure bars + 25% cap warning; #13 portfolio heat
gauge + budget; #14 concurrent-bet Kelly haircut (1/√n); #15 fee+slippage-adjusted NET EV
(blocks negative-EV trades); #16 theta/days-to-catalyst.
Analytics: #17 probability calibration curve + Brier score (resolved trades only, honest
coverage note); #18 Sharpe/Sortino/profit-factor/exp-per-day/lose-streak/CAGR;
#19 edge→ROI least-squares fit + R²; #20 bootstrap projection from YOUR real closed-trade
ROIs (needs ≥5 trades, else honest "need more data").

State additions: settings{feeBps,riskBudgetPct,probeShares,slipBand}; positions/closed gain
pEntry/cluster/tokenId/catalyst/outcome (deepMerge defaults old localStorage safely).
Correctness bonus: Analyzer→Sizer handoff now passes SIDE-adjusted prob/price (was passing
YES values for NO bets).

Gate: node --check on extracted inline JS = PASS. Preview smoke test = PASS.
Commit: cycle 2. Deploy: see deploy log below.

---

## Bot v0.1 — 2026-05-29
Created bot/ — paper-default free-arb bot (Node 18+), hard risk caps ($5/trade, $25 exposure,
$20 daily-loss kill, 5 open), kill switch on partial-fill/error, triple-gated live mode,
secrets gitignored. Ran a real paper scan (60 markets, 0 arbs — honest). Commit b2b1c5b.

## Growth Loop — DISCOVER cycle 1 — 2026-05-29
Fresh web scan (smart-money tooling + combinatorial arb research). Wrote 5-item active sprint
to BACKLOG.md (logical/combinatorial arb checker; smart-money wallet tracker; bot multi-
outcome arb + focus polling; auto Kalshi ref; alert engine). No code changes this phase.
Next phase: BUILD (scheduled ~25m). Note: dashboard cycle-2 still NOT live (Vercel stuck —
see DEPLOY_LOG.md); resolve before next deploy window.
