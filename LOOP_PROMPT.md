# Self-Evolution Loop Prompt (dashboard + trade bot)

Run with `/loop` (or as a recurring task). Two surfaces evolve together:
the **dashboard** (`index.html`) and the **trade bot** (`bot/`).

```
Continue the Polymarket Edge Terminal + Arb-Bot SELF-EVOLUTION loop — GROWTH mode (add real,
money-relevant power; never churn, never fabricate data, never risk funds without explicit
human opt-in). Repo root: /Users/michaelclark/Projects/polymarket-dashboard.
Surfaces:
  • DASHBOARD: index.html (single file, no build step).
  • BOT: bot/ (Node 18+, paper-trading by default; free-arb strategy; hard risk caps).
Prod (dashboard only): https://polymarket-edge-terminal.vercel.app  ·  deploy: `vercel --prod --yes`.
Files: backlog ./BACKLOG.md · ledger ./LEDGER.md · deploy log ./DEPLOY_LOG.md.

IDEMPOTENCY GUARD (FIRST): `git log -1 --oneline`. If the latest commit already covers the
phase/cycle you're about to do, a stale wakeup fired — re-schedule and stop. Trust git.

PHASES (one per wakeup; alternate DISCOVER → BUILD → DISCOVER …):

A) DISCOVER 5 — research, then pick the 5 best next improvements ACROSS BOTH SURFACES.
   1. WebSearch for CURRENT prediction-market edge & execution tech: logical/correlated
      arbitrage, smart-money wallet copy-trading, cross-venue vs sportsbooks, resolution/
      latency, order-routing/fill quality, Polymarket CLOB/data-API changes. Pull 3-6 fresh
      sources; note what works THIS month and what's saturated.
   2. Read BACKLOG.md + LEDGER.md so you don't repeat shipped/rejected ideas.
   3. Choose 5, ordered by money-impact, each tagged [DASH] or [BOT] (or both). For each:
      what it's FOR, the data source (browser/Node-fetchable public API or on-chain; must
      degrade to an honest empty state), the single best implementation, feasibility/CORS.
   4. Write the 5 to BACKLOG.md as the active sprint. NO code changes this phase.
   Standing high-value candidates to seed/refresh:
     [DASH] smart-money wallet ranking & copy view; correlated-market consistency checker;
            auto mispricing scan; alert rules; catalyst/news tracker; backtest-on-history.
     [BOT]  more arb classes (logical/correlated, multi-outcome sum<1); smarter sizing &
            fill-quality (FOK→partial handling); paper-P&L reporting & calibration of the
            bot's own fills; better market filtering; resilience/reconnect; structured logs;
            a "shadow live" mode that signs but cancels (proves signing works, risks $0).

B) BUILD 5 — implement the active sprint.
   - One file for dashboard → edit yourself or strictly serialize agents (no parallel edits
     to index.html). Sub-agents NEVER commit; orchestrator commits. Pass repo root to agents;
     they confirm pwd before editing.
   - HARD RULES (both surfaces): validate/clamp every user & external input; render external
     strings via esc()/safe-url (no XSS); wrap every fetch/WS/RPC call in try/catch → honest
     empty; NEVER fabricate a number (0 is a lie when null/"—" is honest); respect the dark
     theme & mobile-first; tag each change `// CYCLE <N> [TAG] (<DATE>): why`.
   - BOT SAFETY RULES (NON-NEGOTIABLE — the loop must NEVER risk money):
       * Keep DRY_RUN=true the default in config.js. NEVER set DRY_RUN=false, NEVER set
         CONFIRM_LIVE, NEVER create/read/write/commit bot/.env or any PRIVATE_KEY. Going live
         is a HUMAN-ONLY action.
       * bot/.env, bot/state.json, bot/package-lock.json stay gitignored. If you ever see a
         secret about to be staged, abort and fix .gitignore.
       * Preserve or TIGHTEN the risk caps & kill switch — never loosen defaults. New
           strategies ship paper-only and keep per-trade/exposure/daily-loss/max-open caps
           and the partial-fill kill switch.
       * Any new live-execution code stays behind the existing triple gate (DRY_RUN=false +
         CONFIRM_LIVE=I_UNDERSTAND + PRIVATE_KEY) and must be unreachable in paper mode.
   - GATE (must pass before commit):
       DASH: extract inline JS + `node --check`; runtime smoke via preview MCP (load page,
             call every render fn, zero console errors, exercise each new feature).
       BOT:  `node --check` each changed file; then `ONCE=true MARKET_SCAN_LIMIT=40 node
             bot/index.js` must run clean, log "MODE: PAPER", and place NOTHING; confirm
             `git status` shows no .env/state.json/key staged.
     Fix inline until green.
   - Commit (orchestrator only): `feat(loop): cycle <N> — <summary>`. Update LEDGER.md.

DEPLOY THROTTLE (dashboard only; ≤ once per hour unless the human says "deploy now"):
   - Read DEPLOY_LOG.md for the last deploy time. If < 60 min ago, don't deploy — note
     "N commits awaiting next window" and keep cycling.
   - If ≥ 60 min AND there are committed, undeployed dashboard changes: pre-flight (clean
     tree, gate green, HEAD = master), then `vercel --prod --yes`; poll until the prod alias
     actually SERVES the new code (curl the alias, grep a marker string from this cycle —
     Vercel can report a stuck UNKNOWN status, so verify by CONTENT not status). On success
     append {utc-time, commit, deployed-features} to DEPLOY_LOG.md. On error: pull logs,
     report the first error, do NOT promote, keep cycling.
   - The BOT is NOT deployed by the loop. It runs locally in paper mode; the human starts/
     stops it and is the only one who can authorize live.

THEN ScheduleWakeup ~1500s for the next phase. Loop forever until the human says stop/halt/
pause. If 2-3 discover phases in a row surface nothing genuinely new & high-value across
either surface, say so and slow the cadence (~3600s) rather than inventing low-value work.
```

**Knobs:** cycle cadence `~1500s`, deploy window `60 min`. Say "deploy now" to override the
throttle. The bot never goes live from the loop — that stays a deliberate human action.
```
