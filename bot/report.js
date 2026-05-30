#!/usr/bin/env node
'use strict';
/* ============================================================================
 * PAPER P&L REPORT — the hard number on whether the bot's strategies work.
 *   cd bot && node report.js
 * Reads state.json, marks every open position to market (live best-BID = what you could
 * exit for now), and prints unrealized P&L by strategy + realized totals. Read-only.
 * ========================================================================== */
const fs = require('fs');
const { getBook } = require('./lib');
const STATE = __dirname + '/state.json';
const usd = v => (v<0?'-$':'$') + Math.abs(Number(v)||0).toFixed(2);

(async function(){
  let s; try { s = JSON.parse(fs.readFileSync(STATE,'utf8')); } catch { console.log('No state.json yet — bot has not recorded any (paper) trades.'); return; }
  const open = s.open||[];
  console.log(`\n=== PAPER P&L REPORT ===  day ${s.day} · trades ${s.trades||0} · open ${open.length} · killed ${!!s.killed}`);
  console.log(`realized (recorded): ${usd(s.realizedTotal||0)} · daily realized: ${usd(s.dailyRealized||0)}\n`);
  if (!open.length){ console.log('No open positions to mark.\n'); return; }

  const byKind = {};
  let totCost=0, totMtm=0;
  for (const p of open){
    // exit value = sum over legs of (best-bid × shares). For arb baskets, value at resolution is
    // exactly $1 × pairs; here we show LIVE mark-to-market (conservative — what you could sell for now).
    let mtm = 0, priced = true;
    for (const leg of (p.legs||[])){
      const b = await getBook(leg.token);
      const bid = b && b.bids[0] ? b.bids[0].price : null;
      if (bid==null){ priced = false; break; }
      mtm += bid * p.pairs;
    }
    const cost = p.cost||0;
    const pnl = priced ? mtm - cost : null;
    totCost += cost; if (priced) totMtm += mtm;
    const k = p.kind||'?'; byKind[k] = byKind[k] || {cost:0, pnl:0, n:0, locked:0};
    byKind[k].cost += cost; byKind[k].n++; byKind[k].locked += (p.lockedProfit||0); if (priced) byKind[k].pnl += pnl;
    console.log(`  [${k}] ${(p.market||'').slice(0,46)}  cost ${usd(cost)}  mtm ${priced?usd(mtm):'—'}  uP/L ${pnl==null?'—':usd(pnl)}${p.lockedProfit?`  (locked ${usd(p.lockedProfit)})`:''}`);
  }
  console.log('\n--- by strategy ---');
  for (const [k,v] of Object.entries(byKind))
    console.log(`  ${k}: ${v.n} pos · cost ${usd(v.cost)} · unrealized ${usd(v.pnl)}${v.locked?` · arb locked-at-resolution ${usd(v.locked)}`:''}`);
  console.log(`\nTOTAL: cost ${usd(totCost)} · live MTM ${usd(totMtm)} · unrealized P/L ${usd(totMtm-totCost)}`);
  console.log('(MTM = exit at current best-bid; arb baskets settle to $1/pair at resolution, shown as locked.)\n');
})();
