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
  MIN_EDGE_CENTS: num(process.env.MIN_EDGE_CENTS, 1.0),   // require >= this edge (¢) after the buffer below, to cover fees/slippage
  EDGE_BUFFER_CENTS: num(process.env.EDGE_BUFFER_CENTS, 0.5), // safety haircut subtracted from raw edge
  MARKET_SCAN_LIMIT: num(process.env.MARKET_SCAN_LIMIT, 150), // how many top-by-volume markets to scan per cycle

  // --- HARD risk limits (very tight defaults) ---
  MAX_PER_TRADE_USD:  num(process.env.MAX_PER_TRADE_USD, 5),    // max $ committed to one arb pair
  MAX_EXPOSURE_USD:   num(process.env.MAX_EXPOSURE_USD, 25),    // max total $ in open positions
  DAILY_LOSS_KILL_USD:num(process.env.DAILY_LOSS_KILL_USD, 20), // stop the bot for the day if realized loss exceeds this
  MAX_OPEN_POSITIONS: num(process.env.MAX_OPEN_POSITIONS, 5),

  // --- loop ---
  POLL_MS: num(process.env.POLL_MS, 15000),              // scan cadence
  ONCE:    bool(process.env.ONCE, false),               // run a single scan then exit (good for testing)

  // --- live wallet (only read when going live) ---
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',
  CLOB_API_URL: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
  GAMMA_API_URL: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
  CHAIN_ID: num(process.env.CHAIN_ID, 137),             // Polygon
};

config.LIVE = !config.DRY_RUN && config.CONFIRM_LIVE === 'I_UNDERSTAND' && !!config.PRIVATE_KEY;

module.exports = config;
