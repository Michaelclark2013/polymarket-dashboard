#!/usr/bin/env node
'use strict';
/* ============================================================================
 * Polymarket FREE-ARB bot — paper-trading by default.
 *
 *   node bot/index.js            # paper mode (safe; places nothing)
 *   ONCE=true node bot/index.js  # single scan then exit
 *   (live mode requires .env: DRY_RUN=false, CONFIRM_LIVE=I_UNDERSTAND, PRIVATE_KEY=…)
 *
 * Strategy: only acts on near risk-free YES-ask + NO-ask < $1 mispricings.
 * Guardrails: per-trade cap, total exposure cap, daily-loss kill switch, max open.
 * ========================================================================== */
const fs = require('fs');
const cfg = require('./config');
const { getBinaryMarkets, findArbs } = require('./lib');

const STATE_FILE = __dirname + '/state.json';
const todayKey = () => new Date().toISOString().slice(0,10); // UTC day

function loadState(){
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); if (s.day !== todayKey()){ s.day = todayKey(); s.dailyRealized = 0; s.killed = false; } return s; }
  catch { return { day: todayKey(), dailyRealized: 0, killed: false, open: [], realizedTotal: 0, trades: 0 }; }
}
function saveState(s){ try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch(e){ log('WARN could not persist state: '+e.message); } }
function exposure(s){ return s.open.reduce((a,p)=>a+p.cost,0); }
const usd = v => (v<0?'-$':'$') + Math.abs(v).toFixed(2);
function log(...a){ console.log(`[${new Date().toISOString()}]`, ...a); }

let liveClient = null;
async function getLiveClient(){
  if (liveClient) return liveClient;
  // lazy-load heavy deps ONLY when actually going live, so paper mode needs zero npm install
  const { ClobClient } = require('@polymarket/clob-client');
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(cfg.PRIVATE_KEY);
  const client = new ClobClient(cfg.CLOB_API_URL, cfg.CHAIN_ID, wallet);
  const creds = await client.createOrDeriveApiKey();
  liveClient = new ClobClient(cfg.CLOB_API_URL, cfg.CHAIN_ID, wallet, creds);
  return liveClient;
}

// Place a single market BUY leg. Paper: just records. Live: signs + posts a FOK buy.
async function buyLeg(tokenId, price, shares){
  if (!cfg.LIVE){ return { paper:true, tokenId, price, shares }; }
  const client = await getLiveClient();
  const { Side, OrderType } = require('@polymarket/clob-client');
  const order = await client.createOrder({ tokenID: tokenId, price, size: shares, side: Side.BUY });
  return await client.postOrder(order, OrderType.FOK); // fill-or-kill: don't sit resting on an arb leg
}

async function executeArb(arb, s){
  // risk gates (re-checked at execution time)
  if (s.killed) return log('KILL SWITCH active — skipping.');
  if (s.open.length >= cfg.MAX_OPEN_POSITIONS) return log('max open positions reached — skipping.');
  if (exposure(s) + arb.cost > cfg.MAX_EXPOSURE_USD) return log(`exposure cap: ${usd(exposure(s))}+${usd(arb.cost)} > ${usd(cfg.MAX_EXPOSURE_USD)} — skipping.`);
  if (arb.cost > cfg.MAX_PER_TRADE_USD) return log('per-trade cap exceeded — skipping.');

  const tag = cfg.LIVE ? 'LIVE' : 'PAPER';
  log(`${tag} ARB → "${arb.market}" buy ${arb.pairs} YES@${arb.askY} + ${arb.pairs} NO@${arb.askN} | cost ${usd(arb.cost)} | locked ${usd(arb.lockedProfit)} (${arb.edgeCents.toFixed(2)}¢)`);
  try {
    const ry = await buyLeg(arb.yes, arb.askY, arb.pairs);
    const rn = await buyLeg(arb.no,  arb.askN, arb.pairs);
    s.open.push({ market: arb.market, yes: arb.yes, no: arb.no, pairs: arb.pairs, cost: arb.cost,
                  lockedProfit: arb.lockedProfit, openedAt: Date.now(), mode: tag,
                  fills: { yes: ry, no: rn } });
    s.trades++;
    saveState(s);
    log(`${tag} filled. open=${s.open.length} exposure=${usd(exposure(s))}`);
  } catch(e){
    log(`EXECUTION ERROR (leg may be partially filled — check your account): ${e.message}`);
    // safest action on partial failure: stop for manual review
    s.killed = true; saveState(s);
    log('KILL SWITCH engaged after execution error. Resolve manually, then clear state.json killed flag.');
  }
}

async function scan(){
  const s = loadState();
  if (s.killed){ log('Bot is in KILL state for today (daily loss limit or execution error). Not trading.'); return; }
  if (s.dailyRealized <= -cfg.DAILY_LOSS_KILL_USD){ s.killed = true; saveState(s); log(`Daily loss ${usd(s.dailyRealized)} hit kill limit. Stopping for the day.`); return; }

  const markets = await getBinaryMarkets(cfg.MARKET_SCAN_LIMIT);
  if (!markets){ log('Could not load markets (network/CORS/API). Honest no-op this cycle.'); return; }
  const arbs = await findArbs(markets);
  log(`scanned ${markets.length} binary markets · ${arbs.length} actionable arb(s) · exposure ${usd(exposure(s))} · dailyP/L ${usd(s.dailyRealized)}`);
  for (const arb of arbs){
    const s2 = loadState(); // re-read so caps reflect this cycle's fills
    if (s2.killed) break;
    await executeArb(arb, s2);
  }
}

(async function main(){
  log('='.repeat(70));
  log(`Polymarket free-arb bot starting — MODE: ${cfg.LIVE ? '*** LIVE (REAL MONEY) ***' : 'PAPER (dry-run, no orders placed)'}`);
  log(`caps: $${cfg.MAX_PER_TRADE_USD}/trade · $${cfg.MAX_EXPOSURE_USD} exposure · $${cfg.DAILY_LOSS_KILL_USD} daily-loss kill · ${cfg.MAX_OPEN_POSITIONS} open · min edge ${cfg.MIN_EDGE_CENTS}¢`);
  if (!cfg.DRY_RUN && !cfg.LIVE) log('WARNING: DRY_RUN=false but live not fully authorized (need CONFIRM_LIVE=I_UNDERSTAND + PRIVATE_KEY). Staying in PAPER mode.');
  log('='.repeat(70));

  await scan();
  if (cfg.ONCE){ log('ONCE=true → done.'); return; }
  setInterval(()=>{ scan().catch(e=>log('scan error: '+e.message)); }, cfg.POLL_MS);
})();
