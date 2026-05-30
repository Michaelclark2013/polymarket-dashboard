'use strict';
/* Polymarket data + arb detection helpers. Pure Node (global fetch, Node 18+). */
const cfg = require('./config');

async function safeJson(url){
  try { const r = await fetch(url, { headers: { 'accept':'application/json' } }); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}
const fin = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/* Active BINARY markets (exactly 2 outcome tokens) ranked by volume. */
async function getBinaryMarkets(limit){
  const raw = await safeJson(`${cfg.GAMMA_API_URL}/markets?closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`);
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw){
    let toks = []; try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch {}
    if (!Array.isArray(toks) || toks.length !== 2) continue; // free-arb only well-defined for binary YES/NO
    out.push({ q: m.question || '(untitled)', yes: toks[0], no: toks[1],
               vol: fin(m.volume) || fin(m.volume24hr) || 0, end: m.endDate || null });
  }
  return out;
}

async function getBook(tokenId){
  const d = await safeJson(`${cfg.CLOB_API_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!d) return null;
  const map = a => (a||[]).map(x=>({ price: fin(x.price), size: fin(x.size) })).filter(l=>l.price!=null && l.size!=null);
  return { bids: map(d.bids).sort((a,b)=>b.price-a.price), asks: map(d.asks).sort((a,b)=>a.price-b.price) };
}

/* Walk asks to fill `shares`, return avg fill price and whether fully cleared. */
function walk(levels, shares){
  let need = shares, cost = 0, filled = 0;
  for (const l of levels){ if (need<=0) break; const take = Math.min(need, l.size); cost += take*l.price; filled += take; need -= take; }
  return { avg: filled ? cost/filled : 0, filled, cleared: need<=0 };
}

/*
 * Find actionable BUY-BOTH arbs: best-ask(YES) + best-ask(NO) < $1.
 * Buying 1 YES + 1 NO costs (askY+askN) and pays exactly $1 at resolution → risk-free if sum<1.
 * We size to the smaller top-of-book ask and to the per-trade $ cap, and require an edge
 * after a configurable buffer (covers fees/slippage/gas). Returns sorted best-first.
 */
async function findArbs(markets){
  const minNet = (cfg.MIN_EDGE_CENTS + cfg.EDGE_BUFFER_CENTS) / 100; // required raw edge
  const arbs = [];
  for (const m of markets){
    const [by, bn] = await Promise.all([ getBook(m.yes), getBook(m.no) ]);
    if (!by || !bn || !by.asks[0] || !bn.asks[0]) continue;
    const askY = by.asks[0].price, askN = bn.asks[0].price;
    const sum = askY + askN;
    const rawEdge = 1 - sum;
    if (rawEdge < minNet) continue;
    // size limited by top-of-book on both legs and the per-trade $ cap
    const maxPairsByBook = Math.min(by.asks[0].size, bn.asks[0].size);
    const maxPairsByCap  = sum > 0 ? cfg.MAX_PER_TRADE_USD / sum : 0;
    const pairs = Math.floor(Math.min(maxPairsByBook, maxPairsByCap));
    if (pairs < 1) continue;
    const cost = pairs * sum;
    const lockedProfit = pairs * rawEdge; // guaranteed $ at resolution (pre-fee)
    arbs.push({ market: m.q, yes: m.yes, no: m.no, askY, askN, sum,
                edgeCents: rawEdge*100, pairs, cost, lockedProfit });
  }
  return arbs.sort((a,b)=>b.lockedProfit - a.lockedProfit);
}

module.exports = { safeJson, getBinaryMarkets, getBook, walk, findArbs };
