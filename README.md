# Michael Clark's Autonomous Trading Dashboard

Single-file Polymarket edge terminal. No backend, no build step — pure HTML + Tailwind/Chart.js CDNs + Polymarket public WebSocket.

**Live:** https://polymarket-edge-terminal.vercel.app

## Files
- `index.html` — the entire app
- `.vercel/` — Vercel project link (project: `polymarket-edge-terminal`)

## Deploy
```bash
cd ~/Projects/polymarket-dashboard
vercel --prod --yes
```

## Local
Open `index.html` directly in a browser, or:
```bash
python3 -m http.server 8000
# → http://localhost:8000
```

State persists to `localStorage` (per-origin). Nothing leaves your browser except WebSocket reads to `wss://ws-subscriptions-clob.polymarket.com`.
