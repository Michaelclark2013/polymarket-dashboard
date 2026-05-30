# Run the bot 24/7 on a VPS (never stops, even when your Mac is off)

This is the only way to eliminate downtime gaps — the bot runs on an always-on server
instead of your laptop. Paper-mode by default; live still requires the triple opt-in.

## 1. Get a cheap server (~$5/month)
Any small Ubuntu 22.04/24.04 box works. Popular options:
- **DigitalOcean** "Basic Droplet" ($4–6/mo) · **Hetzner** CX22 (~€4/mo) · **Vultr** / **Linode** ($5/mo).
- Pick **Ubuntu 24.04**, the smallest plan (1 vCPU / 1 GB RAM is plenty). Add your SSH key.

> I can't create or pay for the server for you — that step is yours. Everything after is one command.

## 2. SSH in and run one command
```bash
ssh root@YOUR_SERVER_IP        # or your user
curl -fsSL https://raw.githubusercontent.com/Michaelclark2013/polymarket-dashboard/master/bot/deploy/setup-vps.sh | bash
```
That installs Node, clones the repo, installs deps, and registers a **systemd service**
that runs the bot 24/7 and restarts it on crash *and* on reboot. Done.

## 3. Watch it
The monitor binds to port 8787 on the server. Don't open it to the public — tunnel over SSH:
```bash
ssh -L 8787:localhost:8787 root@YOUR_SERVER_IP
# then open http://localhost:8787 in your browser
```
Or just tail the logs: `journalctl -u pmbot -f`

## Common commands
| Action | Command |
|---|---|
| Live logs | `journalctl -u pmbot -f` |
| Status | `systemctl status pmbot` |
| Update to latest | `cd ~/polymarket-dashboard && git pull && sudo systemctl restart pmbot` |
| Stop permanently | `sudo systemctl disable --now pmbot` |
| Report / backtest | `cd ~/polymarket-dashboard/bot && node report.js` · `node backtest.js` |

## Going live on the VPS (only after paper proves out)
SSH in, then: `cd ~/polymarket-dashboard/bot && npm i && cp .env.example .env`, edit `.env`
(PRIVATE_KEY etc.), run `node preflight.js --set-allowance`, set `DRY_RUN=false` +
`CONFIRM_LIVE=I_UNDERSTAND`, then `sudo systemctl restart pmbot`. Your key stays on the
server only (`.env` is gitignored). Start at $5/trade.

## Alternative: Docker
A `bot/Dockerfile` is included if you prefer containers:
`docker build -t pm-bot ./bot && docker run -d --restart=always -p 127.0.0.1:8787:8787 --name pm-bot pm-bot`
