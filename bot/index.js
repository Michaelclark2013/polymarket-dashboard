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
const { getBinaryMarkets, getNegRiskEvents, findBinaryArbs, findMultiArbs, buildArb } = require('./lib');
const { LiveFeed } = require('./feed');
const { pollFollowed } = require('./copy');
const { scoreAll } = require('./learn');

const STATE_FILE = __dirname + '/state.json';
const todayKey = () => new Date().toISOString().slice(0,10); // UTC day

function loadState(){
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); if (s.day !== todayKey()){ s.day = todayKey(); s.dailyRealized = 0; s.killed = false; } return s; }
  catch { return { day: todayKey(), dailyRealized: 0, killed: false, open: [], realizedTotal: 0, trades: 0 }; }
}
function saveState(s){ try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch(e){ log('WARN could not persist state: '+e.message); } }
function exposure(s){ return s.open.reduce((a,p)=>a+p.cost,0); }
const usd = v => (v<0?'-$':'$') + Math.abs(v).toFixed(2);
const recentLogs = []; // ring buffer for the live monitor
function log(...a){ const line = `[${new Date().toISOString()}] ` + a.join(' '); console.log(line); recentLogs.push(line); if (recentLogs.length>200) recentLogs.shift(); }
const STATUS = { feed:null, groups:()=>0 }; // populated by runWithFeed

/* ---- CYCLE [BOT] (2026-05-30): built-in live monitor (no deps; Node http) ---- */
function startMonitor(){
  if (!cfg.MONITOR_PORT) return;
  const http = require('http');
  http.createServer((req,res)=>{
    if (req.url === '/status'){
      const s = loadState();
      const body = JSON.stringify({
        mode: cfg.LIVE ? 'LIVE' : 'PAPER', killed: !!s.killed,
        ws: STATUS.feed ? (STATUS.feed.connected?'live':'reconnecting') : 'rest',
        books: STATUS.feed ? STATUS.feed.bookCount() : 0, groups: STATUS.groups(),
        wallets: cfg.FOLLOW_WALLETS.length, trades: s.trades||0, open: (s.open||[]).length,
        exposure: exposure(s), dailyPnl: s.dailyRealized||0,
        caps: { perTrade: cfg.MAX_PER_TRADE_USD, exposure: cfg.MAX_EXPOSURE_USD, dailyKill: cfg.DAILY_LOSS_KILL_USD, maxOpen: cfg.MAX_OPEN_POSITIONS },
        positions: (s.open||[]).map(p=>({ market:p.market, kind:p.kind, cost:p.cost, pairs:p.pairs, locked:p.lockedProfit||0, source:p.source||'', when:p.openedAt })),
        scores: Object.entries(s.walletScores||{}).map(([w,v])=>({ w, winRate:v.winRate, pnl:v.pnl, n:v.n, weight:v.weight })).sort((a,b)=>b.weight-a.weight),
        logs: recentLogs.slice(-60)
      });
      res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'}); res.end(body); return;
    }
    res.writeHead(200,{'content-type':'text/html'}); res.end(MONITOR_HTML);
  }).listen(cfg.MONITOR_PORT, ()=> log(`[monitor] live status page → http://localhost:${cfg.MONITOR_PORT}`));
}
const MONITOR_HTML = `<!doctype html><html><head><meta charset=utf-8><title>Bot Monitor</title>
<meta name=viewport content="width=device-width,initial-scale=1"><style>
body{background:#0a0a0b;color:#e4e4e7;font:13px ui-monospace,Menlo,monospace;margin:0;padding:16px}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}
.card{background:#18181b;border:1px solid #27272a;border-radius:8px;padding:10px 14px;min-width:120px}
.k{font-size:10px;color:#71717a;letter-spacing:.1em}.v{font-size:20px;font-weight:700;margin-top:2px}
.g{color:#22c55e}.r{color:#ef4444}.a{color:#f59e0b}.c{color:#22d3ee}
h1{font-size:14px;letter-spacing:.1em;color:#a1a1aa;margin:0 0 12px}
pre{background:#000;border:1px solid #27272a;border-radius:8px;padding:10px;max-height:46vh;overflow:auto;white-space:pre-wrap;font-size:11px;color:#a1a1aa}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #27272a}
.dot{display:inline-block;width:8px;height:8px;border-radius:9px;margin-right:6px}
</style></head><body>
<h1>🤖 POLYMARKET BOT — LIVE MONITOR <span id=dot class=dot></span><span id=mode></span></h1>
<div class=row id=kpis></div>
<div id=postbl></div>
<h1 style="margin-top:14px">🧠 SELF-LEARNING — followed wallet scores</h1><div id=scoretbl style=color:#71717a>scoring…</div>
<h1 style="margin-top:14px">ACTIVITY LOG</h1><pre id=log>connecting…</pre>
<script>
async function tick(){ try{
  const s=await (await fetch('/status')).json();
  document.getElementById('mode').textContent=' '+s.mode+(s.killed?' · KILLED':'');
  document.getElementById('dot').style.background = s.ws==='live'?'#22c55e':(s.ws==='reconnecting'?'#f59e0b':'#71717a');
  const kpi=(k,v,c)=>'<div class=card><div class=k>'+k+'</div><div class="v '+(c||'')+'">'+v+'</div></div>';
  const $=n=>'$'+Number(n||0).toFixed(2);
  document.getElementById('kpis').innerHTML=
    kpi('WS FEED',s.ws.toUpperCase(),s.ws==='live'?'g':'a')+kpi('BOOKS',s.books,'c')+kpi('GROUPS',s.groups)+
    kpi('FOLLOWING',s.wallets+' wallets')+kpi('OPEN',s.open+' / '+s.caps.maxOpen)+
    kpi('EXPOSURE',$(s.exposure)+' / '+$(s.caps.exposure),'a')+kpi('TRADES',s.trades)+
    kpi('DAILY P/L',$(s.dailyPnl),s.dailyPnl>=0?'g':'r');
  if(s.positions.length){ let h='<table><tr><th>market</th><th>kind</th><th>cost</th><th>locked</th><th>source</th></tr>';
    for(const p of s.positions) h+='<tr><td>'+(p.market||'').slice(0,52)+'</td><td>'+p.kind+'</td><td>'+$(p.cost)+'</td><td>'+(p.locked?$(p.locked):'-')+'</td><td>'+(p.source||'').slice(0,12)+'</td></tr>';
    document.getElementById('postbl').innerHTML=h+'</table>'; } else document.getElementById('postbl').innerHTML='<div style=color:#71717a>no open paper positions yet — waiting for an arb or a followed-wallet buy</div>';
  if(s.scores&&s.scores.length){ let h='<table><tr><th>wallet</th><th>win%</th><th>realized P/L</th><th>positions</th><th>copy weight</th></tr>';
    for(const w of s.scores){ const ok=w.weight>0; h+='<tr><td>'+w.w.slice(0,12)+'…</td><td>'+(w.winRate*100).toFixed(0)+'%</td><td class="'+(w.pnl>=0?'g':'r')+'">'+$(w.pnl)+'</td><td>'+w.n+'</td><td class="'+(ok?'g':'r')+'">'+w.weight.toFixed(2)+(ok?'':' (dropped)')+'</td></tr>'; }
    document.getElementById('scoretbl').innerHTML=h+'</table>'; }
  else document.getElementById('scoretbl').innerHTML='<span style=color:#71717a>scoring wallets… (first pass runs at startup, then every 30m)</span>';
  document.getElementById('log').textContent=s.logs.join('\\n');
  document.getElementById('log').scrollTop=1e9;
}catch(e){ document.getElementById('log').textContent='monitor offline: '+e.message; } }
tick(); setInterval(tick,2000);
</script></body></html>`;

let liveClient = null;
async function getLiveClient(){
  if (liveClient) return liveClient;
  // lazy-load heavy deps ONLY when actually going live, so paper mode needs zero npm install
  const { ClobClient } = require('@polymarket/clob-client');
  const { ethers } = require('ethers');
  const wallet = new ethers.Wallet(cfg.PRIVATE_KEY);
  const funder = cfg.FUNDER_ADDRESS || await wallet.getAddress();
  const l1 = new ClobClient(cfg.CLOB_API_URL, cfg.CHAIN_ID, wallet);
  const creds = await l1.createOrDeriveApiKey();
  liveClient = new ClobClient(cfg.CLOB_API_URL, cfg.CHAIN_ID, wallet, creds, cfg.SIGNATURE_TYPE, funder);
  return liveClient;
}
// Verify the wallet can actually trade BEFORE placing anything (real money safety).
let _liveReadyChecked = false;
async function ensureLiveReady(s){
  if (!cfg.LIVE || _liveReadyChecked) return true;
  const { AssetType, COLLATERAL_TOKEN_DECIMALS } = require('@polymarket/clob-client');
  const client = await getLiveClient();
  const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const bal = Number(ba.balance) / 10**COLLATERAL_TOKEN_DECIMALS;
  const allow = Number(ba.allowance) / 10**COLLATERAL_TOKEN_DECIMALS;
  log(`live wallet USDC balance ${usd(bal)} · exchange allowance ${usd(allow)}`);
  if (bal < cfg.MIN_USDC_BALANCE){ s.killed=true; saveState(s); log(`USDC balance ${usd(bal)} < MIN_USDC_BALANCE ${usd(cfg.MIN_USDC_BALANCE)} — refusing to trade.`); return false; }
  if (allow <= 0){ s.killed=true; saveState(s); log('USDC allowance is 0 — run `node preflight.js --set-allowance` first. Refusing to trade.'); return false; }
  _liveReadyChecked = true;
  return true;
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
  // CYCLE 1 BUILD [BOT] (2026-05-30): generic multi-leg arb (binary YES+NO or multi-outcome buy-all)
  const legStr = arb.legs.map(l=>`${l.label||'?'}@${l.price}`).join(' + ');
  log(`${tag} ${arb.kind.toUpperCase()} ARB → "${arb.market}" buy ${arb.pairs}× [${legStr}] | cost ${usd(arb.cost)} | locked ${usd(arb.lockedProfit)} (${arb.edgeCents.toFixed(2)}¢)`);
  try {
    const fills = [];
    for (const leg of arb.legs){ fills.push(await buyLeg(leg.token, leg.price, arb.pairs)); }
    s.open.push({ market: arb.market, kind: arb.kind, legs: arb.legs.map(l=>({token:l.token,label:l.label,price:l.price})),
                  pairs: arb.pairs, cost: arb.cost, lockedProfit: arb.lockedProfit, openedAt: Date.now(), mode: tag, fills });
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
  const binArbs = await findBinaryArbs(markets);
  // CYCLE 1 BUILD [BOT] (2026-05-30): also scan multi-outcome (neg-risk) event groups
  const events = await getNegRiskEvents(Math.min(60, cfg.MARKET_SCAN_LIMIT)) || [];
  const multiArbs = await findMultiArbs(events);
  const arbs = [...binArbs, ...multiArbs].sort((a,b)=>b.lockedProfit - a.lockedProfit);
  log(`scanned ${markets.length} binary + ${events.length} multi-outcome events · ${arbs.length} actionable arb(s) · exposure ${usd(exposure(s))} · dailyP/L ${usd(s.dailyRealized)}`);
  if (arbs.length && cfg.LIVE && !(await ensureLiveReady(s))) return; // real-money preflight gate
  for (const arb of arbs){
    const s2 = loadState(); // re-read so caps reflect this cycle's fills
    if (s2.killed) break;
    await executeArb(arb, s2);
  }
}

/* ---- CYCLE [BOT] (2026-05-30): T2-#4 event-driven detection over the live WS feed ---- */
async function runWithFeed(){
  const feed = new LiveFeed(log);
  let groups = [], tokenGroups = new Map();
  const lastActed = new Map(); // market → ts, simple cooldown to avoid re-firing the same arb every tick
  async function refreshGroups(){
    const markets = await getBinaryMarkets(cfg.MARKET_SCAN_LIMIT) || [];
    const events  = await getNegRiskEvents(Math.min(60, cfg.MARKET_SCAN_LIMIT)) || [];
    groups = [
      ...markets.map(m=>({ kind:'binary', q:m.q, legs:[{token:m.yes,label:'YES'},{token:m.no,label:'NO'}] })),
      ...events.map(e=>({ kind:'multi', q:e.q, legs:e.legs.map(l=>({token:l.token,label:l.label})) }))
    ];
    tokenGroups = new Map();
    for (const g of groups) for (const l of g.legs){ const a = tokenGroups.get(l.token)||[]; a.push(g); tokenGroups.set(l.token, a); }
    feed.setAssets([...tokenGroups.keys()]);
    feed.resubscribe();
  }
  feed.onUpdate = async (token) => {
    const gs = tokenGroups.get(token); if (!gs) return;
    for (const g of gs){
      if (Date.now() - (lastActed.get(g.q)||0) < 30000) continue; // 30s cooldown per market
      const legBooks = g.legs.map(l=>({ token:l.token, label:l.label, book: feed.getBook(l.token) }));
      const arb = buildArb(g.kind, g.q, legBooks);
      if (!arb) continue;
      lastActed.set(g.q, Date.now());
      const s = loadState();
      if (s.killed) return;
      if (s.dailyRealized <= -cfg.DAILY_LOSS_KILL_USD){ s.killed=true; saveState(s); log(`Daily loss kill hit. Stopping.`); return; }
      if (cfg.LIVE && !(await ensureLiveReady(s))) return;
      await executeArb(arb, s);
    }
  };
  STATUS.feed = feed; STATUS.groups = ()=>groups.length; // expose to the live monitor
  await refreshGroups();
  if (!feed.connect()) return false;            // ws unavailable → caller falls back to REST
  setInterval(()=>refreshGroups().catch(e=>log('refresh error: '+e.message)), 60000);
  setInterval(()=>{ const s=loadState(); log(`[ws] ${feed.connected?'live':'reconnecting'} · ${feed.bookCount()} books · ${groups.length} groups · open ${s.open.length} · exposure ${usd(exposure(s))} · dailyP/L ${usd(s.dailyRealized)}`); }, 15000);
  return true;
}

/* ---- CYCLE [BOT] T1-#2 (2026-05-30): smart-money copy — mirror followed wallets' new buys ---- */
async function mirrorCopy(sig){
  const s = loadState();
  if (s.killed) return;
  if (s.open.length >= cfg.MAX_OPEN_POSITIONS) return log('[copy] max open reached — skip.');
  // SELF-LEARNING: scale by the wallet's learned quality weight; skip wallets that aren't winning
  const sc = (s.walletScores||{})[sig.wallet];
  const weight = sc ? sc.weight : cfg.COPY_UNSCORED_WEIGHT;
  if (weight <= 0){ return log(`[copy] skip ${sig.wallet.slice(0,10)} — learned weight 0 (not profitable).`); }
  // size down: a fraction of the whale's USDC × learned weight, clamped to the per-trade cap and exposure room
  const room = Math.max(0, cfg.MAX_EXPOSURE_USD - exposure(s));
  const usdcTarget = Math.min(sig.usdc * cfg.COPY_FRACTION * weight, cfg.MAX_PER_TRADE_USD, room);
  if (usdcTarget < 0.5) return; // too small to bother
  const shares = sig.price>0 ? usdcTarget/sig.price : 0;
  if (shares < 1) return;
  const cost = shares*sig.price;
  const tag = cfg.LIVE ? 'LIVE' : 'PAPER';
  log(`${tag} COPY ← ${sig.wallet.slice(0,10)} bought "${(sig.title||'').slice(0,40)}" ${sig.outcome} @${sig.price} | mirror ${Math.round(shares)} sh ($${cost.toFixed(2)})`);
  try {
    const fill = await buyLeg(sig.token, sig.price, shares); // paper: records; live: signs+posts (gated)
    s.open.push({ market: `COPY:${sig.title}`, kind:'copy', source: sig.wallet, legs:[{token:sig.token,label:sig.outcome,price:sig.price}],
                  pairs: Math.round(shares), cost, lockedProfit: 0, openedAt: Date.now(), mode: tag, fills:[fill] });
    s.trades++; saveState(s);
    log(`${tag} copy filled. open=${s.open.length} exposure=${usd(exposure(s))}`);
  } catch(e){ log(`[copy] execution error: ${e.message}`); s.killed=true; saveState(s); }
}
function startCopyLoop(){
  if (!cfg.FOLLOW_WALLETS.length){ log('[copy] no FOLLOW_WALLETS set — add sharp wallets (from the dashboard Smart $ tab) to enable smart-money copy.'); return; }
  log(`[copy] following ${cfg.FOLLOW_WALLETS.length} wallet(s) · mirror ${(cfg.COPY_FRACTION*100).toFixed(1)}% of their size (capped $${cfg.MAX_PER_TRADE_USD}) · min $${cfg.COPY_MIN_USDC}`);
  const tick = async () => {
    try {
      const s = loadState(); if (s.killed) return;
      if (cfg.LIVE && !(await ensureLiveReady(s))) return;
      const r = await pollFollowed(sig => mirrorCopy(sig).catch(e=>log('[copy] '+e.message)));
      if (r.newSignals) log(`[copy] ${r.newSignals} new signal(s) from ${r.followed} wallet(s)`);
    } catch(e){ log('[copy] poll error: '+e.message); }
  };
  tick(); setInterval(tick, cfg.COPY_POLL_MS);
}
/* ---- CYCLE [BOT] (2026-05-30): self-learning wallet scoring loop ---- */
function startLearnLoop(){
  if (!cfg.FOLLOW_WALLETS.length) return;
  const tick = async () => {
    try {
      const scores = await scoreAll(cfg.FOLLOW_WALLETS);
      const s = loadState(); s.walletScores = scores; saveState(s);
      const ranked = Object.entries(scores).sort((a,b)=>b[1].weight-a[1].weight);
      const live = ranked.filter(([,v])=>v.weight>0).length;
      log(`[learn] scored ${ranked.length} wallets · ${live} pass (net-positive & ≥50% win) · ` +
          ranked.slice(0,3).map(([w,v])=>`${w.slice(0,8)}=${(v.winRate*100).toFixed(0)}%/${usd(v.pnl)}→w${v.weight.toFixed(2)}`).join(' '));
    } catch(e){ log('[learn] '+e.message); }
  };
  tick(); setInterval(tick, cfg.SCORE_INTERVAL_MS);
}

(async function main(){
  log('='.repeat(70));
  log(`Polymarket free-arb bot starting — MODE: ${cfg.LIVE ? '*** LIVE (REAL MONEY) ***' : 'PAPER (dry-run, no orders placed)'}`);
  log(`caps: $${cfg.MAX_PER_TRADE_USD}/trade · $${cfg.MAX_EXPOSURE_USD} exposure · $${cfg.DAILY_LOSS_KILL_USD} daily-loss kill · ${cfg.MAX_OPEN_POSITIONS} open · min edge ${cfg.MIN_EDGE_CENTS}¢`);
  if (!cfg.DRY_RUN && !cfg.LIVE) log('WARNING: DRY_RUN=false but live not fully authorized (need CONFIRM_LIVE=I_UNDERSTAND + PRIVATE_KEY). Staying in PAPER mode.');
  log('='.repeat(70));

  if (cfg.ONCE){ await scan(); if (cfg.FOLLOW_WALLETS.length){ const s=loadState(); if(!s.killed) await pollFollowed(sig=>mirrorCopy(sig)); } log('ONCE=true → done.'); return; }
  startMonitor(); // live status web page
  const feedOn = new LiveFeed().available();
  if (feedOn){ log('detection: live WebSocket feed (event-driven).'); await runWithFeed(); }
  else { log('detection: REST polling fallback (install ws for the live feed: cd bot && npm i ws).');
    await scan(); setInterval(()=>{ scan().catch(e=>log('scan error: '+e.message)); }, cfg.POLL_MS); }
  startCopyLoop(); // smart-money copy runs alongside arb detection
  startLearnLoop(); // self-learning: re-score followed wallets, auto-curate who to copy
})();
