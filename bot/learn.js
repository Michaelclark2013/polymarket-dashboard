'use strict';
/* ============================================================================
 * CYCLE [BOT] (2026-05-30): SELF-LEARNING wallet curation.
 * Periodically scores each followed wallet by its REAL realized performance (Polymarket
 * Data API positions → cashPnl + win rate) and produces a copy WEIGHT in [0,1]. The bot
 * then sizes copies by weight and stops copying wallets that aren't actually winning —
 * so the system gets smarter about WHO to follow over time, with no human input.
 * Read-only against the API. Never trades.
 * ========================================================================== */
const cfg = require('./config');
const sj = u => fetch(u,{headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
const fin = v => { const n=Number(v); return Number.isFinite(n)?n:null; };

// Score one wallet from its current positions' realized/MTM cashPnl + hit rate.
async function scoreWallet(addr){
  const pos = await sj(`${cfg.DATA_API_URL}/positions?user=${encodeURIComponent(addr)}&sizeThreshold=1&limit=300`);
  const val = await sj(`${cfg.DATA_API_URL}/value?user=${encodeURIComponent(addr)}`);
  const portfolio = Array.isArray(val)&&val[0] ? fin(val[0].value) : null;
  if (!Array.isArray(pos) || !pos.length) return { pnl:0, winRate:0, n:0, portfolio, weight:0, ts:Date.now() };
  let pnl=0, wins=0, n=0;
  for (const p of pos){ const c = fin(p.cashPnl); if (c==null) continue; pnl+=c; n++; if (c>0) wins++; }
  const winRate = n ? wins/n : 0;
  // Only copy wallets that are net-positive AND win at least half their positions.
  // Weight scales with win rate; everyone else → 0 (dropped).
  const weight = (pnl > 0 && winRate >= 0.5) ? Math.min(1, 0.4 + winRate*0.6) : 0;
  return { pnl, winRate, n, portfolio, weight, ts:Date.now() };
}

async function scoreAll(addrs){
  const out = {};
  for (const a of addrs){ try { out[a] = await scoreWallet(a); } catch {} }
  return out;
}

module.exports = { scoreWallet, scoreAll };
