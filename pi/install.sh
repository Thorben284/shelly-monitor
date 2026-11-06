#!/usr/bin/env bash
# Jarvis / Energie-Zentrale auf dem Raspberry Pi installieren.
# Aufruf im Projektordner:  bash pi/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
USER_NAME="$(id -un)"

echo "== Node.js prüfen"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 20 oder neuer fehlt. Installieren mit:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
node -v

echo "== Abhängigkeiten installieren"
npm ci --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "== .env angelegt – bitte jetzt ausfüllen:  nano $DIR/.env"
fi

echo "== Zeitzone prüfen (für Briefing und Termine)"
timedatectl show -p Timezone --value || true

echo "== Dienst einrichten (startet automatisch beim Booten)"
sed -e "s#__DIR__#$DIR#g" -e "s#__USER__#$USER_NAME#g" pi/jarvis.service | sudo tee /etc/systemd/system/jarvis.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis.service
sleep 2
systemctl --no-pager --lines=8 status jarvis.service || true

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Fertig. Im Heimnetz:  http://$IP:3000/jarvis"
echo "Logs ansehen:         journalctl -u jarvis -f"
echo "Nach .env-Änderung:   sudo systemctl restart jarvis"
