#!/usr/bin/env bash
# One-command VPS bootstrap for the Polymarket paper bot (Ubuntu/Debian).
# Installs Node 20 + git, clones the repo, installs deps, and registers a systemd
# service that runs 24/7 (restart on crash AND on reboot). Paper-mode by default.
#
#   curl -fsSL https://raw.githubusercontent.com/Michaelclark2013/polymarket-dashboard/master/bot/deploy/setup-vps.sh | bash
#   (or: git clone … && bash bot/deploy/setup-vps.sh)
set -euo pipefail
REPO="https://github.com/Michaelclark2013/polymarket-dashboard.git"
DIR="$HOME/polymarket-dashboard"

echo "==> installing node + git (if needed)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs git
fi

echo "==> fetching repo → $DIR"
if [ -d "$DIR/.git" ]; then (cd "$DIR" && git pull --ff-only); else git clone "$REPO" "$DIR"; fi

echo "==> installing bot deps"
cd "$DIR/bot" && npm install --omit=dev --no-audit --no-fund

echo "==> installing systemd service (24/7, restart on crash + boot)"
sudo tee /etc/systemd/system/pmbot.service >/dev/null <<EOF
[Unit]
Description=Polymarket paper bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$DIR/bot
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=MONITOR_PORT=8787

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pmbot

echo ""
echo "✅ DONE — bot is running 24/7 in PAPER mode."
echo "   logs:    journalctl -u pmbot -f"
echo "   status:  systemctl status pmbot"
echo "   monitor: ssh -L 8787:localhost:8787 $USER@<this-server>  then open http://localhost:8787"
echo "   update:  cd $DIR && git pull && sudo systemctl restart pmbot"
echo "   stop:    sudo systemctl disable --now pmbot"
