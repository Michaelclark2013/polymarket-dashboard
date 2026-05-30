'use strict';
/* ============================================================================
 * CYCLE [BOT] (2026-05-30): T2-#4 live WebSocket order-book feed.
 * Maintains in-memory books for a set of tokens via Polymarket's CLOB market WS and
 * fires onUpdate(token) on every change → event-driven arb detection (vs 15s REST polling).
 * `ws` is lazy-required; if not installed the bot falls back to REST polling. Paper-safe:
 * this module only READS market data, never places orders.
 * ========================================================================== */
let WS = null; try { WS = require('ws'); } catch { /* optional — REST fallback */ }
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const fin = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

class LiveFeed {
  constructor(log){ this.books = new Map(); this.assets = []; this.ws = null; this.onUpdate = null;
    this.connected = false; this.log = log || (()=>{}); this._reconnect = null; this._want = false; }
  available(){ return !!WS; }
  bookCount(){ return this.books.size; }
  getBook(token){ return this.books.get(token) || null; }
  setAssets(ids){ this.assets = [...new Set(ids)].filter(Boolean); }

  connect(){
    if (!WS){ this.log('ws module not installed (npm i ws) — REST fallback.'); return false; }
    this._want = true; this._open(); return true;
  }
  stop(){ this._want = false; clearTimeout(this._reconnect); try { this.ws && this.ws.close(); } catch {} }

  _open(){
    if (!this._want) return;
    try {
      this.ws = new WS(WS_URL);
      this.ws.on('open', () => { this.connected = true; this.log(`[ws] connected · subscribing ${this.assets.length} assets`); this._subscribe(); });
      this.ws.on('message', (raw) => { let data; try { data = JSON.parse(raw.toString()); } catch { return; } (Array.isArray(data)?data:[data]).forEach(m=>this._handle(m)); });
      this.ws.on('error', () => { this.connected = false; });
      this.ws.on('close', () => { this.connected = false; if (this._want){ clearTimeout(this._reconnect); this._reconnect = setTimeout(()=>this._open(), 2000); } });
    } catch { this.connected = false; if (this._want){ clearTimeout(this._reconnect); this._reconnect = setTimeout(()=>this._open(), 2000); } }
  }
  resubscribe(){ if (this.connected) this._subscribe(); }
  _subscribe(){ try { if (this.assets.length) this.ws.send(JSON.stringify({ type:'Market', assets_ids: this.assets })); } catch {} }

  _handle(m){
    if (!m || !m.event_type) return;
    const id = m.asset_id || m.market; if (!id) return;
    let b = this.books.get(id); if (!b){ b = { bids:[], asks:[] }; this.books.set(id, b); }
    const lvl = x => ({ price: fin(x.price), size: fin(x.size) });
    const okv = l => l.price!=null && l.size!=null;
    if (m.event_type === 'book'){
      b.bids = (m.bids||[]).map(lvl).filter(okv).sort((a,c)=>c.price-a.price).slice(0,200);
      b.asks = (m.asks||[]).map(lvl).filter(okv).sort((a,c)=>a.price-c.price).slice(0,200);
    } else if (m.event_type === 'price_change'){
      (m.changes||[]).forEach(ch=>{
        const side = ch.side==='BUY' ? 'bids' : 'asks';
        const price = fin(ch.price), size = fin(ch.size);
        if (price==null || size==null) return;
        const arr = b[side]; const i = arr.findIndex(x=>x.price===price);
        if (size===0){ if (i>=0) arr.splice(i,1); }
        else { if (i>=0) arr[i].size=size; else arr.push({price,size}); }
        arr.sort((a,c)=> side==='bids' ? c.price-a.price : a.price-c.price);
        if (arr.length>200) arr.length=200;
      });
    } else return; // ignore last_trade etc. for arb purposes
    if (this.onUpdate) this.onUpdate(id);
  }
}
module.exports = { LiveFeed };
