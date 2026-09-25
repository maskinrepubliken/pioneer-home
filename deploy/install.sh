#!/usr/bin/env bash
# One-time setup on the Pi. Run as the pi user from the repo checkout: sudo bash deploy/install.sh
# Idempotent: safe to re-run after changes to the unit files.
set -euo pipefail
REPO=/opt/pioneer-home
cd "$(dirname "$0")/.."

echo "== directories"
sudo mkdir -p /etc/pioneer-home "$REPO/state"
sudo chown pi:pi "$REPO/state"

echo "== environment files"
for f in engine gpio; do
  if [ ! -f "/etc/pioneer-home/$f.env" ] && [ -f "deploy/$f.env.example" ]; then
    sudo cp "deploy/$f.env.example" "/etc/pioneer-home/$f.env"
    echo "   created /etc/pioneer-home/$f.env from example (edit it!)"
  fi
done
sudo chown root:pi /etc/pioneer-home/*.env
sudo chmod 640 /etc/pioneer-home/*.env

echo "== systemd units"
for unit in deploy/systemd/*.service; do
  name=$(basename "$unit")
  sudo ln -sf "$REPO/$unit" "/etc/systemd/system/$name"
done
sudo systemctl daemon-reload
sudo systemctl enable pioneer-engine.service

echo
echo "Done. Next:"
echo "  sudo nano /etc/pioneer-home/engine.env      # check DRY_RUN and MQTT_URL"
echo "  sudo systemctl start pioneer-engine && journalctl -u pioneer-engine -f"
echo "  (pioneer-gpio is installed but not enabled until Phase 4)"
