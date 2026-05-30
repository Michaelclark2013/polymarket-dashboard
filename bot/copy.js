'use strict';
/* ============================================================================
 * CYCLE [BOT] T1-#2 (2026-05-30): smart-money COPY.
 * Polls the Polymarket activity feed for a set of wallets you follow and emits their
 * NEW buy trades, so the bot can mirror them (sized-down, under all caps). Latency-tolerant:
 * wallet alpha persists minutes, so a slow client can realistically capture it.
 * Read-only here (just detection); execution + risk handled by the caller. Paper-safe.
 * ========================================================================== */
const cfg = require('./config');
const fin = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
async function safeJson(url){ try { const r = await fetch(url,{headers:{accept:'application/json'}}); if(!r.ok) return null; return await r.json(); } catch { return null; } }

// per-wallet high-water timestamp so we only emit trades we haven't seen
const lastSeen = new Map();

/*
 * Poll each followed wallet once. Calls onCopy(signal) for each NEW qualifying BUY:
 *   signal = { wallet, token, price, shares, usdc, title, outcome, conditionId, ts }
 * On the first poll of a wallet we only set the high-water mark (no backfill spam).
 */
async function pollFollowed(onCopy){
  const wallets = cfg.FOLLOW_WALLETS;
  if (!wallets.length) return { followed: 0, newSignals: 0 };
  let newSignals = 0;
  for (const w of wallets){
    const acts = await safeJson(`${cfg.DATA_API_URL}/activity?user=${encodeURIComponent(w)}&limit=40`);
    if (!Array.isArray(acts)) continue;
    const trades = acts.filter(a => a.type === 'TRADE' && a.side === 'BUY' && a.asset)
                       .map(a => ({ ts: fin(a.timestamp)||0, token: a.asset, price: fin(a.price), shares: fin(a.size),
                                    usdc: fin(a.usdcSize), title: a.title||'', outcome: a.outcome||'', conditionId: a.conditionId||'' }))
                       .filter(t => t.price!=null && t.shares!=null)
                       .sort((a,b)=>a.ts-b.ts);
    const hw = lastSeen.get(w);
    const maxTs = trades.length ? trades[trades.length-1].ts : (hw||0);
    if (hw === undefined){ lastSeen.set(w, maxTs); continue; } // first sight: set mark, don't backfill
    for (const t of trades){
      if (t.ts <= hw) continue;                              // already seen
      if ((t.usdc||0) < cfg.COPY_MIN_USDC) continue;         // ignore dust
      newSignals++;
      onCopy({ wallet: w, ...t });
    }
    lastSeen.set(w, Math.max(maxTs, hw));
  }
  return { followed: wallets.length, newSignals };
}

module.exports = { pollFollowed };
