#!/usr/bin/env node
'use strict';
/* ============================================================================
 * LIVE READINESS PREFLIGHT — verifies everything needed to trade real money,
 * WITHOUT placing a single order.
 *
 *   cd bot && npm i
 *   node preflight.js                 # check key, address, API creds, USDC balance + allowance
 *   node preflight.js --set-allowance # additionally approve USDC for the exchange (one-time, on-chain)
 *
 * Reads bot/.env (PRIVATE_KEY, SIGNATURE_TYPE, FUNDER_ADDRESS, …). Never commits anything.
 * ========================================================================== */
const cfg = require('./config');

const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = m => console.log('  \x1b[31m✗\x1b[0m ' + m);
const warn = m => console.log('  \x1b[33m!\x1b[0m ' + m);
const usd = v => '$' + Number(v).toLocaleString(undefined,{maximumFractionDigits:2});

(async function main(){
  const setAllow = process.argv.includes('--set-allowance');
  console.log('\n=== Polymarket bot — LIVE READINESS PREFLIGHT ===\n');

  // 1) deps present
  let ClobClient, ethers, Side, OrderType, AssetType, COLLATERAL_TOKEN_DECIMALS;
  try {
    ({ ClobClient, Side, OrderType, AssetType, COLLATERAL_TOKEN_DECIMALS } = require('@polymarket/clob-client'));
    ethers = require('ethers');
    ok('live deps installed (@polymarket/clob-client, ethers)');
  } catch { bad('live deps missing — run `npm i` in bot/.'); process.exit(1); }

  // 2) private key
  if (!cfg.PRIVATE_KEY){ bad('PRIVATE_KEY not set in bot/.env — cannot go live.'); process.exit(1); }
  let wallet, addr;
  try { wallet = new ethers.Wallet(cfg.PRIVATE_KEY); addr = await wallet.getAddress(); ok('PRIVATE_KEY valid → signer ' + addr); }
  catch { bad('PRIVATE_KEY is not a valid key.'); process.exit(1); }
  const funder = cfg.FUNDER_ADDRESS || addr;
  if (cfg.SIGNATURE_TYPE === 0 && cfg.FUNDER_ADDRESS && cfg.FUNDER_ADDRESS.toLowerCase() !== addr.toLowerCase())
    warn('SIGNATURE_TYPE=0 (EOA) but FUNDER_ADDRESS differs from signer — usually wrong. For a Polymarket UI account use SIGNATURE_TYPE 1 or 2.');
  console.log(`     signatureType=${cfg.SIGNATURE_TYPE} · funder=${funder}`);

  // 3) API credentials (L1-signed)
  let client;
  try {
    const l1 = new ClobClient(cfg.CLOB_API_URL, cfg.CHAIN_ID, wallet);
    const creds = await l1.createOrDeriveApiKey();
    client = new ClobClient(cfg.CLOB_API_URL, cfg.CHAIN_ID, wallet, creds, cfg.SIGNATURE_TYPE, funder);
    ok('CLOB API credentials derived (signing works)');
  } catch(e){ bad('could not derive API creds: ' + e.message); process.exit(1); }

  // 4) USDC balance + allowance
  let bal=0, allow=0;
  try {
    const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    bal = Number(ba.balance)/10**COLLATERAL_TOKEN_DECIMALS;
    allow = Number(ba.allowance)/10**COLLATERAL_TOKEN_DECIMALS;
    (bal>0?ok:warn)(`USDC balance: ${usd(bal)}`);
    (allow>0?ok:warn)(`exchange allowance: ${usd(allow)}`);
  } catch(e){ bad('balance/allowance check failed: ' + e.message); }

  // 5) optionally set allowance
  if (setAllow){
    if (allow > 0) ok('allowance already set — nothing to do.');
    else { try { console.log('  … submitting USDC allowance approval (on-chain, costs a little MATIC)…');
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      ok('allowance approval submitted. Re-run preflight to confirm.'); }
      catch(e){ bad('updateBalanceAllowance failed: ' + e.message); } }
  }

  // verdict
  console.log('\n--- VERDICT ---');
  const ready = bal >= cfg.MIN_USDC_BALANCE && allow > 0;
  if (ready) ok(`READY. To go live set in bot/.env: DRY_RUN=false, CONFIRM_LIVE=I_UNDERSTAND. Caps: ${usd(cfg.MAX_PER_TRADE_USD)}/trade, ${usd(cfg.MAX_EXPOSURE_USD)} exposure.`);
  else {
    if (bal < cfg.MIN_USDC_BALANCE) warn(`fund the wallet: USDC ${usd(bal)} < required ${usd(cfg.MIN_USDC_BALANCE)} (deposit USDC.e to ${funder} on Polygon).`);
    if (allow <= 0) warn('set allowance: run `node preflight.js --set-allowance` (needs a little MATIC for gas).');
    console.log('  NOT ready for live yet — fix the above. Bot stays in paper mode regardless.');
  }
  console.log('');
})();
