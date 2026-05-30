'use strict';
/* ============================================================================
 * CYCLE [BOT] (2026-05-30): SELF-LEARNING wallet curation — recency + anti-luck + scouting.
 * - scoreWallet: realized PnL + win rate + consistency (Sharpe-like) + RECENCY, with an
 *   anti-luck penalty for one-bet-wonders → a copy WEIGHT in [0,1].
 * - discoverCandidates: scans top holders across high-volume markets to grow the wallet pool,
 *   so the bot keeps finding fresh sharp wallets to evaluate (a self-curating talent scout).
 * Read-only against the API. Never trades.
 * ========================================================================== */
const cfg = require('./config');
// fetch with a hard timeout so one hung request can't stall a scoring pass
async function sj(u){
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), 6000);
  try { const r = await fetch(u,{headers:{accept:'application/json'},signal:ac.signal}); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
const fin = v => { const n=Number(v); return Number.isFinite(n)?n:null; };
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
const stdev = xs => { if (xs.length<2) return 0; const m=mean(xs); return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/(xs.length-1)); };
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const DAY = 86400;

async function scoreWallet(addr){
  const [pos, val, act] = await Promise.all([
    sj(`${cfg.DATA_API_URL}/positions?user=${encodeURIComponent(addr)}&sizeThreshold=1&limit=400`),
    sj(`${cfg.DATA_API_URL}/value?user=${encodeURIComponent(addr)}`),
    sj(`${cfg.DATA_API_URL}/activity?user=${encodeURIComponent(addr)}&limit=200`)
  ]);
  const portfolio = Array.isArray(val)&&val[0] ? fin(val[0].value) : null;
  if (!Array.isArray(pos) || !pos.length) return { pnl:0, winRate:0, n:0, sharpe:0, concentration:1, recentFrac:0, portfolio, weight:0, ts:Date.now() };

  const pnls = pos.map(p=>fin(p.cashPnl)).filter(v=>v!=null);
  const n = pnls.length;
  const pnl = pnls.reduce((a,b)=>a+b,0);
  const wins = pnls.filter(v=>v>0).length;
  const winRate = n ? wins/n : 0;
  // consistency: Sharpe-like ratio of position outcomes
  const sd = stdev(pnls); const sharpe = sd ? mean(pnls)/sd : 0;
  // anti-luck: how concentrated are the GAINS in a single position? (1.0 = all from one bet)
  const gains = pnls.filter(v=>v>0); const gainSum = gains.reduce((a,b)=>a+b,0);
  const concentration = gainSum>0 ? Math.max(...gains)/gainSum : 1;
  // recency: fraction of recent (≤45d) trade activity
  let recentFrac = 0.5;
  if (Array.isArray(act) && act.length){
    const trades = act.filter(a=>a.type==='TRADE');
    if (trades.length){ const now = Date.now()/1000; recentFrac = trades.filter(a=>(now-(fin(a.timestamp)||0))<=45*DAY).length / trades.length; }
  }

  // gate: must be net-positive, win ≥ half, and have enough history to trust
  let weight = 0;
  if (pnl > 0 && winRate >= 0.5 && n >= 5){
    weight = clamp(0.3 + winRate*0.5 + clamp(sharpe,0,1)*0.2, 0, 1);
    if (concentration > 0.6) weight *= 0.5;     // gains lean on one lucky bet → halve
    if (concentration > 0.85) weight = 0;       // one-bet wonder → drop
    weight *= clamp(0.4 + recentFrac, 0.4, 1);  // stale wallets down-weighted
  }
  return { pnl, winRate, n, sharpe:+sharpe.toFixed(2), concentration:+concentration.toFixed(2), recentFrac:+recentFrac.toFixed(2), portfolio, weight:+weight.toFixed(3), ts:Date.now() };
}

// score concurrently in small batches (responsive even over a large universe)
async function scoreAll(addrs){
  const out = {}; const BATCH = 6;
  for (let i=0; i<addrs.length; i+=BATCH){
    const slice = addrs.slice(i, i+BATCH);
    const res = await Promise.all(slice.map(a => scoreWallet(a).catch(()=>null)));
    slice.forEach((a,j)=>{ if (res[j]) out[a]=res[j]; });
  }
  return out;
}

// Talent scout: collect distinct large holders across the top markets as candidate wallets.
async function discoverCandidates(maxMarkets){
  const mk = await sj(`${cfg.GAMMA_API_URL}/markets?closed=false&active=true&limit=${maxMarkets||15}&order=volume24hr&ascending=false`);
  if (!Array.isArray(mk)) return [];
  const found = new Set();
  for (const m of mk){
    if (!m.conditionId) continue;
    const h = await sj(`${cfg.DATA_API_URL}/holders?market=${encodeURIComponent(m.conditionId)}&limit=8`);
    for (const grp of (h||[])) for (const x of (grp.holders||[])){
      if (x.proxyWallet && /^0x[a-fA-F0-9]{40}$/.test(x.proxyWallet) && (fin(x.amount)||0) > 5000) found.add(x.proxyWallet.toLowerCase());
    }
    if (found.size >= 60) break;
  }
  return [...found];
}

module.exports = { scoreWallet, scoreAll, discoverCandidates };
