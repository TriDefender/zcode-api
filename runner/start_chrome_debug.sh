#!/usr/bin/env bash
# Fresh headed Chromium for manual/CDP flow exploration (not Brave).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome}"
PORT="${DEBUG_PORT:-9223}"
PROFILE="${CHROME_PROFILE:-$ROOT/explore-chrome-profile}"
LOG="$ROOT/explore-chrome.log"

mkdir -p "$PROFILE"

if ss -ltn 2>/dev/null | rg -q ":${PORT}\s"; then
  echo "Port $PORT already in use"
  exit 1
fi

export DISPLAY="${DISPLAY:-:0}"

nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --no-sandbox \
  --disable-dev-shm-usage \
  about:blank \
  >"$LOG" 2>&1 &

echo $! > "$ROOT/explore-chrome.pid"
echo "Chromium PID $(cat "$ROOT/explore-chrome.pid")"
echo "CDP: http://127.0.0.1:$PORT"
echo "Profile: $PROFILE"
echo "Log: $LOG"

for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    curl -s "http://127.0.0.1:$PORT/json/version" | head -c 200
    echo ""
    exit 0
  fi
  sleep 0.2
done
echo "Timed out waiting for CDP on port $PORT" >&2
exit 1
