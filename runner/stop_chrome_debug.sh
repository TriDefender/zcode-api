#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/explore-chrome.pid"
if [[ -f "$PID_FILE" ]]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi
pkill -f "remote-debugging-port=${DEBUG_PORT:-9223}.*explore-chrome-profile" 2>/dev/null || true
echo "stopped"
