#!/bin/sh
set -e

echo "[start] Démarrage Xvfb sur :99..."
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac &
XVFB_PID=$!

# Attendre que Xvfb soit prêt
for i in $(seq 1 10); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "[start] Xvfb prêt (${i}s)"
    break
  fi
  echo "[start] Attente Xvfb... ${i}s"
  sleep 1
done

export DISPLAY=:99
echo "[start] DISPLAY=${DISPLAY}"
echo "[start] Lancement node server.js..."
exec node server.js
