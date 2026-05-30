#!/usr/bin/env node
'use strict';
/* ============================================================================
 * GOAL REPORT — honest progress of the paper account toward its target.
 *   cd bot && node goal.js
 * Reads state.json (real equity = seed + realized P&L). Computes the compounding
 * rate the goal REQUIRES vs what the bot has ACTUALLY done, and a truthful ETA.
 * No fabrication: if there isn't enough history to estimate a rate, it says so.
 * ========================================================================== */
const fs = require('fs');
const cfg = require('./config');
const usd = v => (v<0?'-$':'$') + Math.abs(Number(v)||0).toLocaleString(undefined,{maximumFractionDigits:2});
const pct = v => v==null ? '—' : (v>=0?'+':'') + (v*100).toFixed(2) + '%';

let s; try { s = JSON.parse(fs.readFileSync(__dirname+'/state.json','utf8')); }
catch { s = { realizedTotal:0, startedAt:Date.now(), startCapital:cfg.START_CAPITAL, closedLog:[] }; }

const start = s.startCapital != null ? s.startCapital : cfg.START_CAPITAL;
const eq = start + (s.realizedTotal||0);
const goal = cfg.GOAL_USD;
const daysElapsed = Math.max((Date.now() - (s.startedAt||Date.now()))/86400000, 0);
const daysLeft = Math.max(cfg.GOAL_DAYS - daysElapsed, 0);
const reqDaily = (daysLeft>0 && eq>0) ? Math.pow(goal/eq, 1/daysLeft)-1 : null;
const gotDaily = (daysElapsed>=1 && start>0) ? Math.pow(eq/start, 1/daysElapsed)-1 : null;
const etaYears = (gotDaily!=null && gotDaily>0 && eq<goal) ? (Math.log(goal/eq)/Math.log(1+gotDaily))/365 : null;
const closed = (s.closedLog||[]).length;

console.log(`\n=== GOAL REPORT ===  (honest — real equity only)`);
console.log(`  seed ${usd(start)} → equity ${usd(eq)}  (realized ${usd(s.realizedTotal||0)}, ${closed} closed trades)`);
console.log(`  target ${usd(goal)} in ${cfg.GOAL_DAYS} days · day ${daysElapsed.toFixed(1)} · ${daysLeft.toFixed(1)} left`);
console.log(`  progress: ${(eq/goal*100).toFixed(5)}% of goal\n`);
console.log(`  required compounding rate from here : ${pct(reqDaily)} / day, EVERY day, with no losing days`);
console.log(`  actual compounding rate so far      : ${gotDaily==null?'collecting (need ≥1 day of history)':pct(gotDaily)+' / day'}`);
console.log(`  ETA at the actual rate              : ${etaYears==null?'— (no positive rate yet)':etaYears>10000?'effectively never':etaYears.toFixed(1)+' years'}\n`);
console.log(`  Reality: a ${reqDaily!=null?pct(reqDaily):'~3%'}/day no-loss streak for a year is not achievable by`);
console.log(`  legitimate prediction-market arbitrage or copy-trading. This report exists to keep the`);
console.log(`  ambition VISIBLE and HONEST — the bot compounds what it really earns, nothing more.\n`);
