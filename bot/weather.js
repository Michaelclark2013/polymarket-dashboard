'use strict';
/* ============================================================================
 * CYCLE [BOT] (2026-05-30): WEATHER-EDGE scanner (Kalshi daily high-temp markets).
 * The most defensible *retail* edge: free elite forecasts (Open-Meteo) + thin, under-watched
 * markets + no speed war + DAILY resolution (fast honest validation).
 * For each Kalshi high-temp contract, compute a model probability from the forecast (normal
 * around the predicted high, σ widening with lead time) and flag where the MARKET price
 * diverges. Read-only. Measures whether an edge exists — does NOT trade.
 * Trading it live is a separate step (needs a Kalshi account; this needs nothing).
 * ========================================================================== */
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const sj = u => fetch(u,{headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
const fin = v => { const n=Number(v); return Number.isFinite(n)?n:null; };

// erf → normal CDF
function erf(x){ const s=x<0?-1:1; x=Math.abs(x); const t=1/(1+0.3275911*x);
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x); return s*y; }
const cdf = z => 0.5*(1+erf(z/Math.SQRT2));

const CITIES = [
  { code:'NYC',     series:'KXHIGHNY',  lat:40.71, lon:-74.01, tz:'America/New_York' },
  { code:'Chicago', series:'KXHIGHCHI', lat:41.88, lon:-87.63, tz:'America/Chicago' },
  { code:'LA',      series:'KXHIGHLAX', lat:34.05, lon:-118.24,tz:'America/Los_Angeles' },
  { code:'Miami',   series:'KXHIGHMIA', lat:25.77, lon:-80.19, tz:'America/New_York' },
  { code:'Austin',  series:'KXHIGHAUS', lat:30.27, lon:-97.74, tz:'America/Chicago' },
  { code:'Denver',  series:'KXHIGHDEN', lat:39.74, lon:-104.99,tz:'America/Denver' },
];
const MON = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};

// ticker date "26MAY30" → "2026-05-30"
function tickerDate(ticker){
  const m = /-(\d{2})([A-Z]{3})(\d{2})-/.exec(ticker); if(!m) return null;
  const mo = MON[m[2]]; if(mo==null) return null;
  return `20${m[1]}-${String(mo+1).padStart(2,'0')}-${m[3]}`;
}
function modelProb(strike_type, floor, cap, mean, sd){
  if (strike_type==='greater') return 1 - cdf((floor - mean)/sd);          // P(high > floor)
  if (strike_type==='less')    return cdf((cap - mean)/sd);                // P(high < cap)
  if (strike_type==='between') return cdf((cap+0.5 - mean)/sd) - cdf((floor-0.5 - mean)/sd); // inclusive bucket
  return null;
}

async function scanWeather(minEdge=0.07){
  const today = new Date().toISOString().slice(0,10);
  const out = [];
  for (const c of CITIES){
    const [mk, fc] = await Promise.all([
      sj(`${KALSHI}/markets?series_ticker=${c.series}&status=open&limit=60`),
      sj(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&forecast_days=10&timezone=${encodeURIComponent(c.tz)}`)
    ]);
    const markets = (mk&&mk.markets)||[];
    const fmap = {}; if (fc&&fc.daily) fc.daily.time.forEach((d,i)=>{ fmap[d]=fin(fc.daily.temperature_2m_max[i]); });
    for (const m of markets){
      const date = tickerDate(m.ticker); const mean = fmap[date]; if (date==null || mean==null) continue;
      const lead = Math.max(0, Math.round((Date.parse(date)-Date.parse(today))/86400000));
      const sd = Math.min(7, 1.8 + 1.3*lead);                 // forecast uncertainty grows with lead time
      const p = modelProb(m.strike_type, fin(m.floor_strike), fin(m.cap_strike), mean, sd);
      if (p==null || !Number.isFinite(p)) continue;
      const yb = fin(m.yes_bid), ya = fin(m.yes_ask);
      if (yb==null || ya==null || (yb===0 && ya===0)) continue;  // no liquidity
      const edgeYes = p - ya/100;                 // buy YES if model > ask
      const edgeNo  = yb/100 - p;                  // buy NO if model < bid (sell-equivalent)
      const side = edgeYes>=edgeNo ? 'YES' : 'NO';
      const edge = Math.max(edgeYes, edgeNo);
      if (edge < minEdge) continue;
      out.push({ city:c.code, ticker:m.ticker, title:(m.title||m.subtitle||'').replace(/\*/g,''), date, lead,
                 forecast:+mean.toFixed(1), modelP:+p.toFixed(3), yes_bid:yb, yes_ask:ya, side,
                 cost:+(side==='YES'?ya/100:(100-yb)/100).toFixed(2), edge:+edge.toFixed(3) });
    }
  }
  return out.sort((a,b)=>b.edge-a.edge);
}
module.exports = { scanWeather, CITIES };

if (require.main === module){
  (async()=>{
    const e = await scanWeather(Number(process.env.MIN_EDGE)||0.05);
    console.log(`\n=== WEATHER EDGE SCAN (Kalshi high-temp vs Open-Meteo forecast) ===`);
    if (!e.length){ console.log('No edges ≥ threshold right now — markets are tracking the forecast (efficient). That itself is the honest answer.\n'); return; }
    for (const x of e.slice(0,25))
      console.log(`  ${x.city.padEnd(8)} ${x.date} lead${x.lead}  fc ${x.forecast}°  ${x.title.slice(0,34).padEnd(34)}  modelP ${(x.modelP*100).toFixed(0).padStart(3)}%  mkt ${x.yes_bid}/${x.yes_ask}  → BUY ${x.side} edge +${(x.edge*100).toFixed(1)}¢`);
    console.log(`\n${e.length} candidate edge(s). Indicative — model σ is an assumption; verify before trusting. Daily resolution = fast to validate in paper.\n`);
  })();
}
