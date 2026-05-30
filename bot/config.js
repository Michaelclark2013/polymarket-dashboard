'use strict';
/* ============================================================================
 * Polymarket free-arb bot — CONFIG
 * Paper-trading by DEFAULT. Live trading requires THREE explicit opt-ins
 * (DRY_RUN=false, CONFIRM_LIVE=I_UNDERSTAND, and a PRIVATE_KEY present).
 * Loads from environment / bot/.env (see .env.example). Never hardcode keys.
 * ========================================================================== */
try { require('dotenv').config({ path: __dirname + '/.env' }); } catch { /* dotenv optional in paper mode */ }

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => v == null ? d : /^(1|true|yes)$/i.test(String(v));

const config = {
  // --- mode ---
  DRY_RUN:      bool(process.env.DRY_RUN, true),          // default TRUE = paper. Must be explicitly false to go live.
  CONFIRM_LIVE: process.env.CONFIRM_LIVE || '',           // must equal 'I_UNDERSTAND' to allow live orders

  // --- strategy: free arbitrage (YES-ask + NO-ask < $1) ---
  FEE_BPS: num(process.env.FEE_BPS, 0),                  // trading fee in bps (Polymarket ~0; configurable for honesty)
  GAS_USD: num(process.env.GAS_USD, 0.02),               // approx cost per fill (entry+exit each charged)
  MIN_EDGE_CENTS: num(process.env.MIN_EDGE_CENTS, 1.0),   // require >= this edge (¢) after the buffer below, to cover fees/slippage
  EDGE_BUFFER_CENTS: num(process.env.EDGE_BUFFER_CENTS, 0.5), // safety haircut subtracted from raw edge
  MARKET_SCAN_LIMIT: num(process.env.MARKET_SCAN_LIMIT, 150), // how many top-by-volume markets to scan per cycle

  // --- bankroll & goal (the account COMPOUNDS from this seed; caps below are absolute ceilings) ---
  START_CAPITAL: num(process.env.START_CAPITAL, 20),       // paper bankroll seed ($). equity = this + realizedTotal.
  GOAL_USD:      num(process.env.GOAL_USD, 1000000),       // the ambition. tracked honestly; never fabricated.
  GOAL_DAYS:     num(process.env.GOAL_DAYS, 365),          // deadline for the goal, in days from first run.
  PER_TRADE_FRACTION: num(process.env.PER_TRADE_FRACTION, 0.20), // per-trade size as a fraction of current equity (compounding)

  // --- HARD risk limits (absolute ceilings; effective caps are min(these, bankroll-derived)) ---
  MAX_PER_TRADE_USD:  num(process.env.MAX_PER_TRADE_USD, 5),    // max $ committed to one arb pair
  MAX_EXPOSURE_USD:   num(process.env.MAX_EXPOSURE_USD, 25),    // max total $ in open positions
  DAILY_LOSS_KILL_USD:num(process.env.DAILY_LOSS_KILL_USD, 20), // stop the bot for the day if realized loss exceeds this
  MAX_OPEN_POSITIONS: num(process.env.MAX_OPEN_POSITIONS, 5),

  // --- loop ---
  POLL_MS: num(process.env.POLL_MS, 15000),              // scan cadence
  ONCE:    bool(process.env.ONCE, false),               // run a single scan then exit (good for testing)
  MONITOR_PORT: num(process.env.MONITOR_PORT, 8787),    // live status web page (0 = off)

  // --- smart-money copy (T1-#2): mirror NEW positions of sharp wallets you follow ---
  // Latency-tolerant edge: a slow client CAN catch these (alpha lives minutes, not ms).
  FOLLOW_WALLETS: (process.env.FOLLOW_WALLETS||'').split(',').map(s=>s.trim()).filter(Boolean), // 0x addresses (env overrides file)
  COPY_FRACTION: num(process.env.COPY_FRACTION, 0.02),   // size = whale's USDC size × this, clamped to MAX_PER_TRADE_USD
  COPY_POLL_MS:  num(process.env.COPY_POLL_MS, 20000),   // how often to poll followed wallets' activity
  COPY_MIN_USDC: num(process.env.COPY_MIN_USDC, 50),     // ignore a whale trade smaller than this (noise)
  DATA_API_URL:  process.env.DATA_API_URL || 'https://data-api.polymarket.com',
  SCORE_INTERVAL_MS: num(process.env.SCORE_INTERVAL_MS, 1800000), // re-score followed wallets every 30m (self-learning)
  COPY_UNSCORED_WEIGHT: num(process.env.COPY_UNSCORED_WEIGHT, 0.4), // cautious size for not-yet-scored wallets
  // exit logic for copy positions (mirror whale exits + TP/stop)
  COPY_TP_PCT:   num(process.env.COPY_TP_PCT, 0.25),    // take profit at +25% mark-to-market
  COPY_STOP_PCT: num(process.env.COPY_STOP_PCT, 0.40),  // stop loss at -40% mark-to-market
  MANAGE_MS:     num(process.env.MANAGE_MS, 15000),     // how often to mark-to-market + apply exits
  COPY_CHASE_MAX: num(process.env.COPY_CHASE_MAX, 0.05),// don't mirror if current ask > whale entry × (1+this)
  FOLLOW_MAX:    num(process.env.FOLLOW_MAX, 15),       // auto-follow the top-N scored wallets
  DISCOVER_MARKETS: num(process.env.DISCOVER_MARKETS, 15), // markets to scan for candidate wallets

  // --- live wallet (only read when going live) ---
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  // Signature type: 0 = EOA (a normal wallet whose key you exported and which HOLDS the USDC),
  // 1 = Polymarket email/magic proxy, 2 = Polymarket browser-wallet (Gnosis Safe) proxy.
  // If your funds sit in a Polymarket UI account, set this + FUNDER_ADDRESS to that proxy wallet.
  SIGNATURE_TYPE: num(process.env.SIGNATURE_TYPE, 0),
  FUNDER_ADDRESS: process.env.FUNDER_ADDRESS || '',     // defaults to the signer address when empty
  AUTO_SET_ALLOWANCE: bool(process.env.AUTO_SET_ALLOWANCE, false), // preflight may set USDC allowance if true
  MIN_USDC_BALANCE: num(process.env.MIN_USDC_BALANCE, 0), // refuse to live-trade below this USDC balance (0 = use MAX_EXPOSURE_USD)
  CLOB_API_URL: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
  GAMMA_API_URL: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
  CHAIN_ID: num(process.env.CHAIN_ID, 137),             // Polygon
};
config.MIN_USDC_BALANCE = config.MIN_USDC_BALANCE || config.MAX_EXPOSURE_USD;

// fall back to follow_wallets.json if FOLLOW_WALLETS env not set
if (!config.FOLLOW_WALLETS.length){
  try { const f = require('./follow_wallets.json'); if (Array.isArray(f.wallets)) config.FOLLOW_WALLETS = f.wallets.filter(w=>/^0x[a-fA-F0-9]{40}$/.test(w)); } catch {}
}

config.LIVE = !config.DRY_RUN && config.CONFIRM_LIVE === 'I_UNDERSTAND' && !!config.PRIVATE_KEY;

module.exports = config;
