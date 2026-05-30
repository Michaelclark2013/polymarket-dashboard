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
    if (!Array.isArray(toks) || toks.length !== 2) continue;
    out.push({ q: m.question || '(untitled)', yes: toks[0], no: toks[1] });
  }
  return out;
}

/* CYCLE 1 BUILD [BOT] (2026-05-30): multi-outcome (neg-risk) event groups for combinatorial arb. */
async function getNegRiskEvents(limit){
  const raw = await safeJson(`${cfg.GAMMA_API_URL}/events?closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`);
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const ev of raw){
    const mkts = Array.isArray(ev.markets) ? ev.markets : [];
    // CYCLE 1 BUILD [BOT] (2026-05-30): ONLY neg-risk events are mutually-exclusive (exactly one wins).
    // Buying all outcomes is a guaranteed-$1 arb ONLY when mutually exclusive — never trust mkts.length alone,
    // or independent markets would be mistaken for a "risk-free" basket. Safety-critical filter.
    if (!(ev.negRisk === true || ev.enableNegRisk === true) || mkts.length < 2) continue;
    const legs = [];
    for (const m of mkts){
      let toks = []; try { toks = JSON.parse(m.clobTokenIds || '[]'); } catch {}
      if (toks[0]) legs.push({ token: toks[0], label: (m.groupItemTitle || m.question || '').slice(0,40) });
    }
    if (legs.length >= 3 && legs.length <= 12) out.push({ q: ev.title || ev.slug || '(event)', legs });
  }
  return out;
}

async function getBook(tokenId){
  const d = await safeJson(`${cfg.CLOB_API_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!d) return null;
  const map = a => (a||[]).map(x=>({ price: fin(x.price), size: fin(x.size) })).filter(l=>l.price!=null && l.size!=null);
  return { bids: map(d.bids).sort((a,b)=>b.price-a.price), asks: map(d.asks).sort((a,b)=>a.price-b.price) };
}

function walk(levels, shares){
  let need = shares, cost = 0, filled = 0;
  for (const l of levels){ if (need<=0) break; const take = Math.min(need, l.size); cost += take*l.price; filled += take; need -= take; }
  return { avg: filled ? cost/filled : 0, filled, cleared: need<=0 };
}

/*
 * Generic multi-leg BUY-ALL arb: buying 1 share of each mutually-exclusive outcome costs
 * Σ best-ask and pays exactly $1 at resolution (exactly one wins). If Σ < $1 (after buffer),
 * the gap is locked profit. Binary YES+NO is the 2-leg case. Returns sorted best-first.
 * arb shape: { kind, market, legs:[{token,price,label,size}], pairs, sum, edgeCents, cost, lockedProfit }
 */
function buildArb(kind, market, legBooks){
  if (legBooks.some(b => !b.book || !b.book.asks[0])) return null;
  const legs = legBooks.map(b => ({ token: b.token, label: b.label||'', price: b.book.asks[0].price, size: b.book.asks[0].size }));
  const sum = legs.reduce((a,l)=>a+l.price, 0);
  const rawEdge = 1 - sum;
  const minNet = (cfg.MIN_EDGE_CENTS + cfg.EDGE_BUFFER_CENTS) / 100;
  if (rawEdge < minNet) return null;
  const maxByBook = Math.min(...legs.map(l=>l.size));
  const maxByCap  = sum > 0 ? cfg.MAX_PER_TRADE_USD / sum : 0;
  const pairs = Math.floor(Math.min(maxByBook, maxByCap));
  if (pairs < 1) return null;
  return { kind, market, legs, sum, edgeCents: rawEdge*100, pairs, cost: pairs*sum, lockedProfit: pairs*rawEdge };
}

async function findBinaryArbs(markets){
  const arbs = [];
  for (const m of markets){
    const [by, bn] = await Promise.all([ getBook(m.yes), getBook(m.no) ]);
    const arb = buildArb('binary', m.q, [{token:m.yes,label:'YES',book:by},{token:m.no,label:'NO',book:bn}]);
    if (arb) arbs.push(arb);
  }
  return arbs;
}

async function findMultiArbs(events){
  const arbs = [];
  for (const ev of events){
    const books = await Promise.all(ev.legs.map(l=>getBook(l.token)));
    const arb = buildArb('multi', ev.q, ev.legs.map((l,i)=>({ token:l.token, label:l.label, book:books[i] })));
    if (arb) arbs.push(arb);
  }
  return arbs;
}

module.exports = { safeJson, getBinaryMarkets, getNegRiskEvents, getBook, walk, findBinaryArbs, findMultiArbs };
