#!/usr/bin/env bash
# Keep-alive supervisor: restarts the bot if it ever exits, so unattended data-gathering
# survives crashes/network blips. Paper mode by default (see .env to go live).
#   bash run.sh           (or: nohup bash run.sh > /tmp/pmbot.log 2>&1 &)
cd "$(dirname "$0")" || exit 1
while true; do
  echo "[run.sh] starting bot $(date -u +%FT%TZ)"
  node index.js
  echo "[run.sh] bot exited ($?). restarting in 3s…"
  sleep 3
done
