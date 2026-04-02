#!/bin/sh
set -e
echo "[start] Démarrage Xvfb..."
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac &
sleep 3
export DISPLAY=:99
echo "[start] DISPLAY=${DISPLAY}"
exec node server.js
