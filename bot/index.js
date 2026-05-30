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
const { getBinaryMarkets, getNegRiskEvents, findBinaryArbs, findMultiArbs, buildArb, getBook, resolvedPrice } = require('./lib');
const feeCost = (notional, txs=1) => notional*((cfg.FEE_BPS||0)/10000) + (cfg.GAS_USD||0)*txs;
const { LiveFeed } = require('./feed');
const { pollFollowed } = require('./copy');
const { scoreAll, discoverCandidates } = require('./learn');
const { scanWeather } = require('./weather');

const STATE_FILE = process.env.STATE_FILE || __dirname + '/state.json'; // override for isolated tests
const todayKey = () => new Date().toISOString().slice(0,10); // UTC day

function loadState(){
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); if (s.day !== todayKey()){ s.day = todayKey(); s.dailyRealized = 0; s.killed = false; }
    if (s.startedAt == null) s.startedAt = Date.now();              // start the goal clock on first sight
    if (s.startCapital == null) s.startCapital = cfg.START_CAPITAL; // lock the seed so the goalposts can't move
    return s; }
  catch { return { day: todayKey(), dailyRealized: 0, killed: false, open: [], realizedTotal: 0, trades: 0, startedAt: Date.now(), startCapital: cfg.START_CAPITAL }; }
}
function saveState(s){ try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch(e){ log('WARN could not persist state: '+e.message); } }
function exposure(s){ return s.open.reduce((a,p)=>a+p.cost,0); }
const usd = v => (v<0?'-$':'$') + Math.abs(v).toFixed(2);
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v)); // FIX (2026-05-30): was undefined → silently killed every copy trade

/* ---- CYCLE [BOT] (2026-05-30): real bankroll model — the account COMPOUNDS from START_CAPITAL.
 * equity = seed + realized P&L. Effective caps are the SMALLER of the absolute ceiling and a
 * bankroll-derived size, so we (a) never deploy cash we don't have, (b) grow bet size as we win. */
function equity(s){ return (s.startCapital != null ? s.startCapital : cfg.START_CAPITAL) + (s.realizedTotal||0); }
function caps(s){
  const eq = Math.max(0, equity(s));
  return {
    exposure: Math.min(cfg.MAX_EXPOSURE_USD, eq),                       // can't risk more than the bankroll holds
    perTrade: Math.min(cfg.MAX_PER_TRADE_USD, eq * cfg.PER_TRADE_FRACTION),
  };
}
// Honest progress toward the goal — NO fabrication. Required vs actual compounding rate + truthful ETA.
function goalProgress(s){
  const eq = equity(s), start = (s.startCapital != null ? s.startCapital : cfg.START_CAPITAL), goal = cfg.GOAL_USD;
  const daysElapsed = Math.max((Date.now() - (s.startedAt||Date.now()))/86400000, 0);
  const daysLeft = Math.max(cfg.GOAL_DAYS - daysElapsed, 0);
  const reqDaily  = (daysLeft>0 && eq>0)        ? Math.pow(goal/eq, 1/daysLeft)-1 : null; // needed from here
  const gotDaily  = (daysElapsed>=1 && start>0) ? Math.pow(eq/start, 1/daysElapsed)-1 : null; // actual so far
  let etaDays = null;
  if (gotDaily!=null && gotDaily>0 && eq>0 && eq<goal) etaDays = Math.log(goal/eq)/Math.log(1+gotDaily);
  return { equity:+eq.toFixed(2), start, goal, pct: goal>0?eq/goal:0,
           daysElapsed:+daysElapsed.toFixed(2), daysLeft:+daysLeft.toFixed(1),
           reqDaily, gotDaily, etaDays, onTrack: (gotDaily!=null && reqDaily!=null && gotDaily>=reqDaily) };
}
const recentLogs = []; // ring buffer for the live monitor
function log(...a){ const line = `[${new Date().toISOString()}] ` + a.join(' '); console.log(line); recentLogs.push(line); if (recentLogs.length>200) recentLogs.shift(); }
const STATUS = { feed:null, groups:()=>0 }; // populated by runWithFeed
// unattended robustness: never let a stray async error kill the data-gathering process
process.on('unhandledRejection', e => log('[guard] unhandledRejection: ' + (e&&e.message||e)));
process.on('uncaughtException',  e => log('[guard] uncaughtException: ' + (e&&e.message||e)));

/* ---- CYCLE [BOT] (2026-05-30): built-in live monitor (no deps; Node http) ---- */
function startMonitor(){
  if (!cfg.MONITOR_PORT) return;
  const http = require('http');
  http.createServer((req,res)=>{
    if (req.url === '/status'){
      const s = loadState();
      // real derived metrics from actual closed paper trades (NO fabrication)
      const cl = s.closedLog || []; const cpnls = cl.map(x=>x.pnl);
      const cwins = cpnls.filter(p=>p>0).length;
      const winRate = cpnls.length ? cwins/cpnls.length : null;
      const m = cpnls.length ? cpnls.reduce((a,b)=>a+b,0)/cpnls.length : 0;
      const sd = cpnls.length>1 ? Math.sqrt(cpnls.reduce((a,b)=>a+(b-m)**2,0)/(cpnls.length-1)) : 0;
      const sharpe = sd ? +(m/sd).toFixed(2) : null;
      const bestWin = cpnls.length ? Math.max(...cpnls) : null;
      let cum=0; const pnlSeries = cl.map(x=>{ cum+=x.pnl; return +cum.toFixed(2); });
      const body = JSON.stringify({
        mode: cfg.LIVE ? 'LIVE' : 'PAPER', killed: !!s.killed,
        ws: STATUS.feed ? (STATUS.feed.connected?'live':'reconnecting') : 'rest',
        books: STATUS.feed ? STATUS.feed.bookCount() : 0, groups: STATUS.groups(),
        wallets: (Array.isArray(s.activeWallets)&&s.activeWallets.length) ? s.activeWallets.length : cfg.FOLLOW_WALLETS.length, trades: s.trades||0, open: (s.open||[]).length,
        closed: cl.length, winRate, sharpe, bestWin, pnlSeries: pnlSeries.slice(-80),
        exposure: exposure(s), dailyPnl: s.dailyRealized||0, realized: s.realizedTotal||0, copyFracMult: s.copyFracMult||1,
        equity: equity(s), goal: goalProgress(s),
        caps: { perTrade: caps(s).perTrade, exposure: caps(s).exposure, dailyKill: cfg.DAILY_LOSS_KILL_USD, maxOpen: cfg.MAX_OPEN_POSITIONS },
        positions: (s.open||[]).map(p=>({ market:p.market, kind:p.kind, cost:p.cost, pairs:p.pairs, locked:p.lockedProfit||0, source:p.source||'', when:p.openedAt })),
        scores: Object.entries(s.walletScores||{}).map(([w,v])=>({ w, winRate:v.winRate, pnl:v.pnl, n:v.n, weight:v.weight })).sort((a,b)=>b.weight-a.weight),
        forecast: s.forecast || forecast(s), probHist: (s.probHist||[]).map(x=>({t:x.ts, p:x.p})),
        weatherEdges: s.weatherEdges || [], weatherCheckedAt: s.weatherCheckedAt || null,
        logs: recentLogs.slice(-60)
      });
      res.writeHead(200,{'content-type':'application/json','access-control-allow-origin':'*'}); res.end(body); return;
    }
    res.writeHead(200,{'content-type':'text/html'}); res.end(MONITOR_HTML);
  }).listen(cfg.MONITOR_PORT, ()=> log(`[monitor] live status page → http://localhost:${cfg.MONITOR_PORT}`));
}
const MONITOR_HTML = `<!doctype html><html><head><meta charset=utf-8><title>Bot Monitor</title>
<meta name=viewport content="width=device-width,initial-scale=1"><style>
:root{--bg:#0a0a0b;--panel:#141417;--ink:#e4e4e7;--line:#2a2a2e;--grn:#22c55e;--red:#ef4444;--amb:#f59e0b}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:12px ui-monospace,Menlo,monospace;margin:0;padding:10px}
.bar{display:flex;align-items:center;gap:14px;border:1px solid var(--line);background:var(--panel);padding:8px 12px;margin-bottom:8px;flex-wrap:wrap}
.bar .ttl{font-size:18px;font-weight:800;letter-spacing:.05em}.bar .sub{font-size:9px;color:#8a8a8f;letter-spacing:.12em}
.bar .tag{font-size:10px;letter-spacing:.16em;color:#a1a1aa}.clock{margin-left:auto;font-size:15px;font-weight:800;color:var(--grn)}
.ribbon{display:flex;border:1px solid var(--line);background:#000;color:var(--ink);margin-bottom:8px;flex-wrap:wrap}
.ribbon div{padding:5px 12px;border-right:1px solid var(--line);font-size:10px;letter-spacing:.08em}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
.box{border:1px solid var(--line);background:var(--panel);padding:10px 12px}
.lbl{font-size:9px;letter-spacing:.13em;color:#8a8a8f}.big{font-size:38px;font-weight:800;line-height:1.05}
.kpis{display:flex;gap:16px;margin-top:8px;flex-wrap:wrap}.kpis .num{font-size:18px;font-weight:800}
.g{color:var(--grn)}.r{color:var(--red)}.a{color:var(--amb)}
.pills{display:flex;gap:6px;border:1px solid var(--line);background:var(--panel);padding:8px;margin-bottom:8px;flex-wrap:wrap}
.pill{flex:1;min-width:88px;border:1px solid var(--line);padding:6px 8px;font-size:10px;letter-spacing:.08em;background:#1b1b1f}
.pill.on{background:#6c4ad6;color:#fff;border-color:#6c4ad6}.pill b{display:block;font-size:8px;color:#777}.pill.on b{color:#ddd}
h2{font-size:11px;letter-spacing:.14em;border:1px solid var(--line);background:#000;color:var(--ink);margin:0 0 6px;padding:5px 10px}
table{width:100%;border-collapse:collapse;font-size:11px;background:var(--panel)}
td,th{text-align:left;padding:3px 8px;border-bottom:1px solid var(--line)}th{font-size:9px;letter-spacing:.08em;color:#8a8a8f}
pre{border:1px solid var(--line);background:#000;color:#9fe6b0;padding:8px;height:38vh;overflow:auto;white-space:pre-wrap;font-size:10px;margin:0}
canvas{background:#000;border:1px solid var(--line)}
.bot3{display:grid;grid-template-columns:1.1fr .9fr 1fr;gap:8px}
.gauge{height:8px;background:#2a2a2e;border:1px solid var(--line);margin-top:4px}.gauge>div{height:100%;background:var(--grn)}
@media(max-width:760px){.grid,.bot3{grid-template-columns:1fr}}
</style></head><body>
<div class=bar><div><div class=ttl>CLAUDE × POLYMARKET</div><div class=sub>ARB · SMART-MONEY COPY · SELF-LEARN AGENT</div></div>
  <div class=tag>KELLY-CAPPED · ON-CHAIN DATA · PAPER</div><div class=clock id=clock>--:--:-- UTC</div></div>
<div class=ribbon id=ribbon></div>
<div class=box style="margin-bottom:8px;border-color:#6c4ad6">
  <div class=lbl>🎯 GOAL · $20 → $1,000,000 IN 365 DAYS — honest tracker, real equity only (no fabrication)</div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:baseline;margin-top:5px">
    <div><span class=lbl>EQUITY </span><span class=num id=g_eq>—</span></div>
    <div><span class=lbl>OF GOAL </span><span class=num id=g_pct>—</span></div>
    <div><span class=lbl>DAY </span><span class=num id=g_day>—</span></div>
    <div><span class=lbl>NEED/DAY </span><span class=num id=g_req>—</span></div>
    <div><span class=lbl>ACTUAL/DAY </span><span class=num id=g_got>—</span></div>
    <div><span class=lbl>ETA@RATE </span><span class=num id=g_eta>—</span></div>
  </div>
  <div class=gauge style=margin-top:6px><div id=g_bar style="width:0%;background:#6c4ad6"></div></div></div>
<div class=grid>
  <div class=box><div class=lbl>PAPER ACCOUNT · REALIZED PnL</div><div class=big id=pnlbig>$0</div>
    <div class=kpis>
      <div><div class=lbl>CLOSED</div><div class=num id=k_closed>0</div></div>
      <div><div class=lbl>WIN RATE</div><div class=num id=k_win>—</div></div>
      <div><div class=lbl>SHARPE</div><div class=num id=k_sharpe>—</div></div>
      <div><div class=lbl>OPEN</div><div class=num id=k_open>0</div></div>
    </div>
    <div class=lbl style=margin-top:8px>EXPOSURE / CAP <span id=k_exp></span></div><div class=gauge><div id=expbar style=width:0%></div></div>
  </div>
  <div class=box><div class=lbl>★ BEST PAPER TRADE</div><div class="big g" id=bestwin>—</div>
    <div class=lbl style=margin-top:8px>SIZE DIAL (auto-tuned)</div><div class=num id=k_dial>1.00×</div>
    <div class=lbl style=margin-top:8px>FREE-ARB BOOKS · GROUPS</div><div class=num id=k_books>0 · 0</div></div>
  <div class=box><div class=lbl>📈 CUMULATIVE PAPER PnL</div><canvas id=pnlchart width=380 height=130 style=width:100%;margin-top:4px></canvas></div>
</div>
<div class=pills id=pills></div>
<div class=box style=margin-bottom:8px><div class=lbl>📈 P(PROFIT · NEXT 24H) — Monte-Carlo over the bot's OWN realized trades · honest: shows "collecting" until 8+ closed</div>
  <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:4px">
    <div class=big id=oddsbig>—</div><div id=oddsmeta style="font-size:10px;color:#555"></div>
    <canvas id=oddschart width=420 height=58 style="flex:1;min-width:220px"></canvas></div></div>
<div class=box style=margin-bottom:8px><div class=lbl>🌤 WEATHER EDGE · Kalshi high-temp vs Open-Meteo forecast (research — separate venue, not auto-traded) <span id=wxmeta style=color:#666></span></div>
  <div id=wxtbl style=color:#666;margin-top:4px>checking…</div></div>
<div class=bot3>
  <div><h2>⚡ TRADE LOG · LIVE</h2><pre id=log>connecting…</pre></div>
  <div><h2>OPEN POSITIONS</h2><div id=postbl></div></div>
  <div><h2>🧠 TOP WALLETS · SELF-SCORED</h2><div id=scoretbl style=color:#666>scoring…</div></div>
</div>
<script>
const CYC=['SCAN','DETECT','VALIDATE','SIZE','FILL','SETTLE']; let cstep=0;
const $n=n=>(n<0?'-$':'$')+Math.abs(Number(n)||0).toFixed(2);
function clk(){ const e=document.getElementById('clock'); if(e) e.textContent=new Date().toISOString().slice(11,19)+' UTC'; }
setInterval(clk,1000); clk();
function drawLine(id,arr,lo,hi,color,zero){ const cv=document.getElementById(id); if(!cv)return; const ctx=cv.getContext('2d'),W=cv.width,H=cv.height; ctx.clearRect(0,0,W,H);
  if(!arr||arr.length<2){ ctx.fillStyle='#999';ctx.font='11px monospace';ctx.fillText('building…',8,H/2); return; }
  let mn=lo,mx=hi; if(mn==null){ mn=Math.min(...arr,zero?0:arr[0]); mx=Math.max(...arr,zero?0:arr[0]); } const rng=(mx-mn)||1;
  if(zero&&mn<0&&mx>0){ const zy=H-((0-mn)/rng)*H; ctx.strokeStyle='#ddd';ctx.beginPath();ctx.moveTo(0,zy);ctx.lineTo(W,zy);ctx.stroke(); }
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();
  arr.forEach((v,i)=>{ const x=i/(arr.length-1)*W,y=H-((v-mn)/rng)*H; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });ctx.stroke(); }
async function tick(){ try{
  const s=await (await fetch('/status')).json();
  document.getElementById('ribbon').innerHTML=[
    '<div><b>'+s.mode+(s.killed?' · KILLED':'')+'</b></div>','<div>WS '+s.ws.toUpperCase()+'</div>',
    '<div>FOLLOWING '+s.wallets+'</div>','<div>TRADES '+s.trades+'</div>','<div>OPEN '+s.open+'/'+s.caps.maxOpen+'</div>',
    '<div>DAILY '+$n(s.dailyPnl)+'</div>','<div>EXPOSURE '+$n(s.exposure)+'/'+$n(s.caps.exposure)+'</div>'].join('');
  const g=s.goal||{};
  document.getElementById('g_eq').textContent=$n(s.equity!=null?s.equity:(g.equity||0));
  document.getElementById('g_pct').textContent=g.pct!=null?(g.pct*100).toFixed(4)+'%':'—';
  document.getElementById('g_day').textContent=(g.daysElapsed!=null?g.daysElapsed.toFixed(1):'—')+' / '+(g.daysLeft!=null?Math.round(g.daysElapsed+g.daysLeft):'—');
  document.getElementById('g_req').textContent=g.reqDaily!=null?'+'+(g.reqDaily*100).toFixed(2)+'%':'—';
  const gg=document.getElementById('g_got'); gg.textContent=g.gotDaily==null?'collecting…':((g.gotDaily>=0?'+':'')+(g.gotDaily*100).toFixed(2)+'%'); gg.className='num '+(g.onTrack?'g':'r');
  document.getElementById('g_eta').textContent=g.etaDays==null?'—':(g.etaDays>3650?'>10 yr':(g.etaDays/365).toFixed(1)+' yr');
  document.getElementById('g_bar').style.width=Math.min(100,(g.pct||0)*100)+'%';
  const pb=document.getElementById('pnlbig'); pb.textContent=$n(s.realized); pb.className='big '+(s.realized>=0?'g':'r');
  document.getElementById('k_closed').textContent=s.closed;
  document.getElementById('k_win').textContent=s.winRate==null?'—':(s.winRate*100).toFixed(0)+'%';
  document.getElementById('k_sharpe').textContent=s.sharpe==null?'—':s.sharpe;
  document.getElementById('k_open').textContent=s.open;
  document.getElementById('k_exp').textContent=$n(s.exposure)+' / '+$n(s.caps.exposure);
  document.getElementById('expbar').style.width=(s.caps.exposure?Math.min(100,s.exposure/s.caps.exposure*100):0)+'%';
  document.getElementById('bestwin').textContent=s.bestWin==null?'—':'+$'+s.bestWin.toFixed(2);
  document.getElementById('k_dial').textContent=(s.copyFracMult||1).toFixed(2)+'×';
  document.getElementById('k_books').textContent=s.books+' · '+s.groups;
  cstep=(cstep+1)%CYC.length;
  document.getElementById('pills').innerHTML=CYC.map((c,i)=>'<div class="pill'+(i===cstep?' on':'')+'"><b>0'+(i+1)+'</b>'+c+'</div>').join('');
  const f=s.forecast||{}, ob=document.getElementById('oddsbig'), om=document.getElementById('oddsmeta');
  if(f.p==null||f.conf==='none'){ ob.textContent='collecting…'; ob.className='big'; om.innerHTML='no closed paper trades yet — a real % appears once results are booked.'; }
  else{ ob.textContent=(f.p*100).toFixed(0)+'%'; ob.className='big '+(f.p>=0.5?'g':f.p>=0.25?'a':'r');
    om.innerHTML='confidence <b>'+f.conf+'</b> · '+f.n+' closed · ~'+f.ratePerDay+'/day<br>24h P/L med '+$n(f.median)+' · P5 '+$n(f.p5)+' · P95 '+$n(f.p95); }
  drawLine('oddschart',(s.probHist||[]).filter(x=>x.p!=null).map(x=>x.p),0,1,'#6c4ad6');
  drawLine('pnlchart',s.pnlSeries||[],null,null,'#138a3e',true);
  if(s.positions.length){ let h='<table><tr><th>MARKET</th><th>KIND</th><th>COST</th></tr>';
    for(const p of s.positions) h+='<tr><td>'+(p.market||'').slice(0,38)+'</td><td>'+p.kind+'</td><td>'+$n(p.cost)+'</td></tr>';
    document.getElementById('postbl').innerHTML=h+'</table>'; }
  else document.getElementById('postbl').innerHTML='<div style=color:#888;padding:6px>flat — waiting for an arb or a followed-wallet buy</div>';
  if(s.scores&&s.scores.length){ let h='<table><tr><th>WALLET</th><th>WIN</th><th>PnL</th><th>W</th></tr>';
    for(const w of s.scores.slice(0,10)){ const ok=w.weight>0; h+='<tr><td>'+w.w.slice(0,10)+'…</td><td>'+(w.winRate*100).toFixed(0)+'%</td><td class="'+(w.pnl>=0?'g':'r')+'">'+$n(w.pnl)+'</td><td class="'+(ok?'g':'r')+'">'+w.weight.toFixed(2)+'</td></tr>'; }
    document.getElementById('scoretbl').innerHTML=h+'</table>'; }
  const wm=document.getElementById('wxmeta'), wt=document.getElementById('wxtbl');
  if(wm) wm.textContent = s.weatherCheckedAt ? '· checked '+new Date(s.weatherCheckedAt).toISOString().slice(11,16)+'Z' : '';
  if(wt){ const we=s.weatherEdges||[];
    if(!we.length) wt.innerHTML='<span style=color:#888>no edges right now — markets unquoted or tracking the forecast (honest). Re-checks every 10 min.</span>';
    else{ let h='<table><tr><th>CITY</th><th>MARKET</th><th>FC</th><th>MODEL</th><th>MKT</th><th>SIDE</th><th>EDGE</th></tr>';
      for(const x of we) h+='<tr><td>'+x.city+'</td><td>'+(x.title||'').slice(0,34)+'</td><td>'+x.forecast+'°</td><td>'+(x.modelP*100).toFixed(0)+'%</td><td>'+x.yes_bid+'/'+x.yes_ask+'</td><td>'+x.side+'</td><td class=g>+'+(x.edge*100).toFixed(1)+'¢</td></tr>';
      wt.innerHTML=h+'</table>'; } }
  const lg=document.getElementById('log'); lg.textContent=(s.logs||[]).join('\\n'); lg.scrollTop=1e9;
}catch(e){ const lg=document.getElementById('log'); if(lg) lg.textContent='monitor offline: '+e.message; } }
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
  // bankroll-aware sizing: budget = smaller of (per-trade cap, remaining exposure room); both compound with equity.
  const cap = caps(s), room = Math.max(0, cap.exposure - exposure(s)), budget = Math.min(cap.perTrade, room);
  if (budget < arb.sum) return log(`no bankroll room: budget ${usd(budget)} < 1 unit ${usd(arb.sum)} (equity ${usd(equity(s))}) — skipping.`);
  if (arb.cost > budget){ // downsize to fit the bankroll (bounded by book-limited pairs)
    const pairs = Math.min(arb.pairs, Math.floor(budget / arb.sum));
    if (pairs < 1) return log(`per-trade budget ${usd(budget)} too small for "${arb.market}" — skipping.`);
    arb.pairs = pairs; arb.cost = +(pairs*arb.sum).toFixed(4); arb.lockedProfit = +(pairs*(1-arb.sum)).toFixed(4);
  }

  const tag = cfg.LIVE ? 'LIVE' : 'PAPER';
  // CYCLE 1 BUILD [BOT] (2026-05-30): generic multi-leg arb (binary YES+NO or multi-outcome buy-all)
  const legStr = arb.legs.map(l=>`${l.label||'?'}@${l.price}`).join(' + ');
  log(`${tag} ${arb.kind.toUpperCase()} ARB → "${arb.market}" buy ${arb.pairs}× [${legStr}] | cost ${usd(arb.cost)} | locked ${usd(arb.lockedProfit)} (${arb.edgeCents.toFixed(2)}¢)`);
  try {
    const fills = [];
    for (const leg of arb.legs){ fills.push(await buyLeg(leg.token, leg.price, arb.pairs)); }
    s.open.push({ market: arb.market, kind: arb.kind, cid: arb.cid||'', legs: arb.legs.map(l=>({token:l.token,label:l.label,price:l.price})),
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
      ...markets.map(m=>({ kind:'binary', q:m.q, cid:m.cid||'', legs:[{token:m.yes,label:'YES'},{token:m.no,label:'NO'}] })),
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
      arb.cid = g.cid || '';
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
// CYCLE [BOT] (2026-05-30): closed-loop — effective copy weight blends the wallet's own track
// record (learn.js) with HOW OUR copies of it have actually performed (paper realized).
function copyWeight(s, wallet){
  const sc = (s.walletScores||{})[wallet];
  let w = sc ? sc.weight : cfg.COPY_UNSCORED_WEIGHT;
  const cs = (s.copyStats||{})[wallet];
  if (cs && cs.n >= 3){
    if (cs.realized < 0) return 0;                         // our copies of this wallet LOSE → stop copying it
    w *= clamp(1 + cs.realized/Math.max(1, cs.cost||1), 0.5, 1.5); // tilt by our realized ROI on it
  }
  return clamp(w, 0, 1.5);
}
async function mirrorCopy(sig){
  const s = loadState();
  if (s.killed) return;
  if (s.open.length >= cfg.MAX_OPEN_POSITIONS) return log('[copy] max open reached — skip.');
  const weight = copyWeight(s, sig.wallet);
  if (weight <= 0){ return log(`[copy] skip ${sig.wallet.slice(0,10)} — weight 0 (their record or our copies of them losing).`); }
  // ENTRY DISCIPLINE (#3): don't chase — only mirror if we can still get in near the whale's price,
  // and use the REAL current ask as our entry (we pay the ask, not their fill).
  const book = await getBook(sig.token);
  const ask = book && book.asks[0] ? book.asks[0].price : null;
  const entry = ask != null ? ask : sig.price;
  if (ask != null && sig.price > 0 && ask > sig.price * (1 + cfg.COPY_CHASE_MAX))
    return log(`[copy] skip ${sig.wallet.slice(0,8)} "${(sig.title||'').slice(0,30)}" — chased: ask ${ask} > entry ${sig.price}×${(1+cfg.COPY_CHASE_MAX)}`);
  const fracMult = clamp(s.copyFracMult || 1, 0.5, 2);    // auto-tuned global sizing dial
  const cap = caps(s);                                     // bankroll-aware: compounds with equity
  const room = Math.max(0, cap.exposure - exposure(s));
  const usdcTarget = Math.min(sig.usdc * cfg.COPY_FRACTION * weight * fracMult, cap.perTrade, room);
  if (usdcTarget < 0.5) return;
  const shares = entry>0 ? usdcTarget/entry : 0;
  if (shares < 1) return;
  const cost = shares*entry;
  const tag = cfg.LIVE ? 'LIVE' : 'PAPER';
  log(`${tag} COPY ← ${sig.wallet.slice(0,10)} BUY "${(sig.title||'').slice(0,38)}" ${sig.outcome} entry@${entry.toFixed(3)} | ${Math.round(shares)} sh ($${cost.toFixed(2)}) w${weight.toFixed(2)}×${fracMult.toFixed(2)}`);
  try {
    const fill = await buyLeg(sig.token, entry, shares);
    s.open.push({ market: `COPY:${sig.title}`, kind:'copy', source: sig.wallet, token: sig.token, cid: sig.conditionId||'',
                  legs:[{token:sig.token,label:sig.outcome,price:entry}], entry,
                  pairs: Math.round(shares), shares: Math.round(shares), cost, lockedProfit: 0, openedAt: Date.now(), mode: tag, fills:[fill] });
    s.trades++; saveState(s);
    log(`${tag} copy filled. open=${s.open.length} exposure=${usd(exposure(s))}`);
  } catch(e){ log(`[copy] execution error: ${e.message}`); s.killed=true; saveState(s); }
}
// shared close: book realized P&L (net of fees #2), attribute to source, feed forecast, remove
function bookClose(s, pos, pnl, reason){
  pnl -= feeCost((pos.cost||0) + Math.max(0,pnl) + (pos.cost||0), 2); // fees on entry+exit notional
  s.realizedTotal = (s.realizedTotal||0) + pnl;
  s.dailyRealized = (s.dailyRealized||0) + pnl;
  if (pos.source){
    s.copyStats = s.copyStats || {};
    const cs = s.copyStats[pos.source] = s.copyStats[pos.source] || { realized:0, cost:0, n:0, wins:0 };
    cs.realized += pnl; cs.cost += pos.cost||0; cs.n++; if (pnl>0) cs.wins++;
    s.copyFracMult = clamp((s.copyFracMult||1) + (pnl>0 ? 0.05 : -0.08), 0.5, 2); // auto-tune sizing
  }
  s.closedLog = s.closedLog || []; s.closedLog.push({ pnl, ts: Date.now() }); if (s.closedLog.length>500) s.closedLog.shift();
  s.open = s.open.filter(x => x !== pos);
  log(`${cfg.LIVE?'LIVE':'PAPER'} EXIT ${pos.kind} "${(pos.market||'').slice(0,36)}" (${reason}) → net P/L ${usd(pnl)} | realized ${usd(s.realizedTotal)}`);
}
// EXIT (#1): realize a copy position at an exit price
function closeCopy(s, pos, exitPx, reason){ bookClose(s, pos, (exitPx - pos.entry) * (pos.shares||pos.pairs||0), reason); }
// mirror whale exits + take-profit/stop + RESOLUTION settlement (real $1/$0)
async function manageOpen(){
  const s = loadState(); if (s.killed || !(s.open||[]).length) return;
  let changed = false;
  for (const p of [...s.open]){
    // RESOLUTION (#1): if the market settled, book the real outcome and skip MTM
    if (p.cid){
      try {
        if (p.kind === 'copy'){
          const rp = await resolvedPrice(p.cid, p.token);
          if (rp != null){ closeCopy(s, p, rp, `resolved ${rp?'WON':'LOST'}`); changed = true; continue; }
        } else if (p.kind === 'binary'){ // arb basket: exactly one leg pays $1 → realize locked profit
          const { getClobMarket } = require('./lib'); const m = await getClobMarket(p.cid);
          if (m && m.closed){ bookClose(s, p, p.lockedProfit||0, 'resolved (arb settled)'); changed = true; continue; }
        }
      } catch {}
    }
    if (p.kind !== 'copy') continue;
    const b = await getBook(p.token); const bid = b && b.bids[0] ? b.bids[0].price : null;
    if (bid == null) continue;
    const roi = p.entry>0 ? (bid - p.entry)/p.entry : 0;
    if (roi >= cfg.COPY_TP_PCT){ closeCopy(s, p, bid, `take-profit +${(roi*100).toFixed(0)}%`); changed = true; }
    else if (roi <= -cfg.COPY_STOP_PCT){ closeCopy(s, p, bid, `stop ${(roi*100).toFixed(0)}%`); changed = true; }
  }
  if (changed) saveState(s);
}
// a followed wallet SOLD → exit our matching copy of theirs
function onWhaleSell(sig){
  const s = loadState(); if (s.killed) return;
  const pos = (s.open||[]).find(p => p.kind==='copy' && p.source===sig.wallet && p.token===sig.token);
  if (!pos) return;
  closeCopy(s, pos, sig.price, `mirrored ${sig.wallet.slice(0,8)} exit`); saveState(s);
}
function onCopySignal(sig){ return sig.side === 'SELL' ? onWhaleSell(sig) : mirrorCopy(sig); }
function startManageLoop(){ const t=()=>manageOpen().catch(e=>log('[manage] '+e.message)); t(); setInterval(t, cfg.MANAGE_MS); }
// the bot follows a DYNAMIC active set (top-scored), maintained by the learn loop; falls back to the seed list
function activeWallets(s){ const a = s.activeWallets; return (Array.isArray(a) && a.length) ? a : cfg.FOLLOW_WALLETS; }
function startCopyLoop(){
  if (!cfg.FOLLOW_WALLETS.length){ log('[copy] no seed wallets — add some to follow_wallets.json; the scout will still discover more.'); }
  log(`[copy] mirror ${(cfg.COPY_FRACTION*100).toFixed(1)}% of size (capped $${cfg.MAX_PER_TRADE_USD}) · min $${cfg.COPY_MIN_USDC} · no-chase ${(cfg.COPY_CHASE_MAX*100).toFixed(0)}%`);
  const tick = async () => {
    try {
      const s = loadState(); if (s.killed) return;
      if (cfg.LIVE && !(await ensureLiveReady(s))) return;
      const r = await pollFollowed(sig => { try { onCopySignal(sig); } catch(e){ log('[copy] '+e.message); } }, activeWallets(s));
      if (r.newSignals) log(`[copy] ${r.newSignals} new signal(s) from ${r.followed} active wallet(s)`);
    } catch(e){ log('[copy] poll error: '+e.message); }
  };
  tick(); setInterval(tick, cfg.COPY_POLL_MS);
}
/* ---- CYCLE [BOT] (2026-05-30): self-learning loop — SCOUT new wallets + score (recency/anti-luck) + auto-follow top-N ---- */
function startLearnLoop(){
  const tick = async () => {
    try {
      const discovered = await discoverCandidates(cfg.DISCOVER_MARKETS);
      const seed = cfg.FOLLOW_WALLETS.map(w=>w.toLowerCase());
      const universe = [...new Set([...seed, ...discovered])].slice(0, 40); // bound the work (scored concurrently)
      const scores = await scoreAll(universe);
      const ranked = Object.entries(scores).filter(([,v])=>v.weight>0).sort((a,b)=>b[1].weight-a[1].weight);
      const active = ranked.slice(0, cfg.FOLLOW_MAX).map(([w])=>w);
      const s = loadState(); s.walletScores = scores; s.activeWallets = active; saveState(s);
      log(`[learn] scouted ${universe.length} wallets · ${ranked.length} pass · following top ${active.length} · ` +
          ranked.slice(0,3).map(([w,v])=>`${w.slice(0,8)}=${(v.winRate*100).toFixed(0)}%/${usd(v.pnl)}(sh${v.sharpe},c${v.concentration})→w${v.weight}`).join(' '));
    } catch(e){ log('[learn] '+e.message); }
  };
  tick(); setInterval(tick, cfg.SCORE_INTERVAL_MS);
}

/* ---- CYCLE [BOT] (2026-05-30): honest 24h profit-odds forecast (Monte Carlo over OUR own paper results) ---- */
function poisson(lambda){ if (lambda<=0) return 0; const L=Math.exp(-lambda); let k=0,p=1; do{ k++; p*=Math.random(); }while(p>L); return k-1; }
function forecast(s){
  const logd = s.closedLog || [];
  const n = logd.length;
  if (n < 1) return { p:null, conf:'none', n:0, ratePerDay:0, median:0, p5:0, p95:0 };
  const now = Date.now();
  const last24 = logd.filter(x=>now-x.ts<=86400000).length;
  const elapsedDays = Math.max((now - logd[0].ts)/86400000, 1/24);
  const ratePerDay = last24 > 0 ? last24 : n/elapsedDays;   // expected trades in next 24h
  const pnls = logd.map(x=>x.pnl);
  const SIMS = 2000; const dist = new Array(SIMS); let wins = 0;
  for (let i=0;i<SIMS;i++){
    const k = poisson(ratePerDay); let tot = 0;
    for (let j=0;j<k;j++) tot += pnls[(Math.random()*n)|0];
    dist[i] = tot; if (tot > 0) wins++;
  }
  dist.sort((a,b)=>a-b);
  const p = wins/SIMS;
  const conf = n>=25 ? 'high' : n>=8 ? 'medium' : 'low';
  return { p, conf, n, ratePerDay:+ratePerDay.toFixed(2),
           median:+dist[SIMS>>1].toFixed(2), p5:+dist[(SIMS*0.05)|0].toFixed(2), p95:+dist[(SIMS*0.95)|0].toFixed(2) };
}
function startForecastLoop(){
  const tick = () => { try {
    const s = loadState(); const f = forecast(s);
    s.probHist = s.probHist || []; s.probHist.push({ ts: Date.now(), p: f.p, n: f.n }); if (s.probHist.length>240) s.probHist.shift();
    s.forecast = f; saveState(s);
  } catch(e){ log('[forecast] '+e.message); } };
  tick(); setInterval(tick, 60000);
}
/* ---- CYCLE [BOT] (2026-05-30): weather-edge watch (Kalshi high-temp vs Open-Meteo forecast) ---- */
function startWeatherLoop(){
  const tick = async () => { try {
    const edges = await scanWeather(0.07);
    const s = loadState(); s.weatherEdges = edges.slice(0,12); s.weatherCheckedAt = Date.now(); saveState(s);
    if (edges.length) log(`[weather] ${edges.length} edge(s) — top: ${edges[0].city} ${edges[0].title.slice(0,28)} model ${(edges[0].modelP*100).toFixed(0)}% mkt ${edges[0].yes_bid}/${edges[0].yes_ask} → BUY ${edges[0].side} +${(edges[0].edge*100).toFixed(1)}¢`);
  } catch(e){ log('[weather] '+e.message); } };
  tick(); setInterval(tick, 600000); // every 10 min
}

(async function main(){
  log('='.repeat(70));
  log(`Polymarket free-arb bot starting — MODE: ${cfg.LIVE ? '*** LIVE (REAL MONEY) ***' : 'PAPER (dry-run, no orders placed)'}`);
  { const s0 = loadState(); saveState(s0); const gp = goalProgress(s0); // persist startedAt/seed + print honest goal status
    log(`bankroll: equity ${usd(gp.equity)} (seed ${usd(gp.start)}) · goal ${usd(gp.goal)} in ${cfg.GOAL_DAYS}d · day ${gp.daysElapsed.toFixed(1)} · need +${gp.reqDaily!=null?(gp.reqDaily*100).toFixed(2):'—'}%/day compounded`);
    log(`reality check: +${gp.reqDaily!=null?(gp.reqDaily*100).toFixed(2):'—'}%/day every day with no losing days is not achievable by real arb/copy. This tracks ACTUAL results honestly.`); }
  log(`caps: $${cfg.MAX_PER_TRADE_USD}/trade · $${cfg.MAX_EXPOSURE_USD} exposure ceilings · per-trade ${(cfg.PER_TRADE_FRACTION*100).toFixed(0)}% of equity · $${cfg.DAILY_LOSS_KILL_USD} daily-loss kill · ${cfg.MAX_OPEN_POSITIONS} open · min edge ${cfg.MIN_EDGE_CENTS}¢`);
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
  startManageLoop(); // exit logic: mirror whale exits + take-profit/stop, realize P&L (closed loop)
  startWeatherLoop(); // weather-edge watch (Kalshi temp markets vs free forecast) — surfaces when liquid
  startForecastLoop(); // honest 24h profit-odds estimate from our own results
})();
