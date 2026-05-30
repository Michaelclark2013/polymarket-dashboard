#!/usr/bin/env node
'use strict';
/* ============================================================================
 * BACKTEST — validate the copy strategy on a wallet's REAL history, offline, fast.
 *   node backtest.js                  # backtest the active/seed followed wallets
 *   node backtest.js 0xWALLET ...     # backtest specific wallets
 * Replays each wallet's activity, FIFO-pairs their BUY→SELL round-trips per token, applies
 * our copy sizing + fees, and reports realized P&L / win rate / Sharpe. Round-trips still
 * open at the end are settled via market resolution when available, else skipped (flagged).
 * Read-only. No trades. The honest "would this have made money?" check.
 * ========================================================================== */
const cfg = require('./config');
const { resolvedPrice } = require('./lib');
const sj = u => fetch(u,{headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
const fin = v => { const n=Number(v); return Number.isFinite(n)?n:null; };
const usd = v => (v<0?'-$':'$') + Math.abs(Number(v)||0).toFixed(2);
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
const stdev = xs => { if (xs.length<2) return 0; const m=mean(xs); return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/(xs.length-1)); };
const feeCost = (notional, txs=2) => notional*((cfg.FEE_BPS||0)/10000) + (cfg.GAS_USD||0)*txs;

async function backtestWallet(addr){
  const acts = await sj(`${cfg.DATA_API_URL}/activity?user=${encodeURIComponent(addr)}&limit=500`);
  if (!Array.isArray(acts)) return null;
  const trades = acts.filter(a=>a.type==='TRADE' && a.asset && (a.side==='BUY'||a.side==='SELL'))
                     .map(a=>({ ts:fin(a.timestamp)||0, side:a.side, token:String(a.asset), price:fin(a.price),
                                shares:fin(a.size), usdc:fin(a.usdcSize), cid:a.conditionId||'' }))
                     .filter(t=>t.price!=null && t.shares!=null).sort((a,b)=>a.ts-b.ts);
  const lots = {}; // token → queue of our mirrored buys
  const pnls = []; let openCount = 0, settled = 0;
  for (const t of trades){
    if (t.side==='BUY'){
      if ((t.usdc||0) < cfg.COPY_MIN_USDC) continue;
      const usdcTarget = Math.min((t.usdc||0)*cfg.COPY_FRACTION, cfg.MAX_PER_TRADE_USD);
      const shares = t.price>0 ? usdcTarget/t.price : 0;
      if (shares < 1) continue;
      (lots[t.token] = lots[t.token]||[]).push({ shares, entry:t.price, cost:shares*t.price, cid:t.cid });
    } else { // SELL → close our FIFO lots at their sell price
      let q = lots[t.token]||[]; let rem = t.shares;
      while (rem > 0 && q.length){ const lot=q[0]; const sh=Math.min(rem, lot.shares);
        let pnl = (t.price - lot.entry)*sh; pnl -= feeCost(lot.cost + Math.max(0,pnl), 2);
        pnls.push(pnl); lot.shares-=sh; rem-=sh; if (lot.shares<=1e-9) q.shift(); }
    }
  }
  // settle leftover open lots via resolution
  for (const token of Object.keys(lots)){
    for (const lot of lots[token]){
      if (lot.shares < 1) continue;
      const rp = lot.cid ? await resolvedPrice(lot.cid, token) : null;
      if (rp != null){ let pnl=(rp-lot.entry)*lot.shares; pnl-=feeCost(lot.cost,2); pnls.push(pnl); settled++; }
      else openCount++;
    }
  }
  const total = pnls.reduce((a,b)=>a+b,0); const wins = pnls.filter(p=>p>0).length;
  return { addr, n:pnls.length, total, winRate: pnls.length? wins/pnls.length : 0,
           avg: mean(pnls), sharpe: stdev(pnls)? mean(pnls)/stdev(pnls):0, openUnsettled:openCount, settledByResolution:settled };
}

(async function(){
  let wallets = process.argv.slice(2).filter(w=>/^0x[a-fA-F0-9]{40}$/.test(w));
  if (!wallets.length){
    try { const st = JSON.parse(require('fs').readFileSync(__dirname+'/state.json','utf8')); wallets = st.activeWallets||[]; } catch {}
    if (!wallets.length) wallets = cfg.FOLLOW_WALLETS;
  }
  if (!wallets.length){ console.log('No wallets to backtest. Pass 0x addresses or set follow_wallets.json.'); return; }
  console.log(`\n=== COPY BACKTEST === ${wallets.length} wallet(s) · frac ${cfg.COPY_FRACTION} · cap $${cfg.MAX_PER_TRADE_USD} · min $${cfg.COPY_MIN_USDC} · fee ${cfg.FEE_BPS}bps+$${cfg.GAS_USD}/fill\n`);
  let agg=[];
  for (const w of wallets){ const r = await backtestWallet(w); if (!r){ console.log(`  ${w.slice(0,12)} … no data`); continue; }
    agg.push(r);
    console.log(`  ${w.slice(0,12)}…  trades ${String(r.n).padStart(3)}  win ${(r.winRate*100).toFixed(0).padStart(3)}%  P/L ${usd(r.total).padStart(10)}  avg ${usd(r.avg)}  Sharpe ${r.sharpe.toFixed(2)}  (open ${r.openUnsettled})`);
  }
  const tot = agg.reduce((a,r)=>a+r.total,0); const N = agg.reduce((a,r)=>a+r.n,0);
  const w = agg.reduce((a,r)=>a+r.winRate*r.n,0)/(N||1);
  console.log(`\nPORTFOLIO: ${agg.length} wallets · ${N} simulated round-trips · win ${(w*100).toFixed(0)}% · total ${usd(tot)}`);
  console.log('(Backtest of THEIR history under our copy rules — past performance, not a forecast. Open positions excluded unless resolved.)\n');
})();
