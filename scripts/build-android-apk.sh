#!/usr/bin/env bash
# Build the Android APK inside the zcode-android-build container
# (image llama-android-builder:latest = JDK17 + Gradle 8.5 + Android SDK 35).
#
# Usage: bun run build:android-apk [assembleDebug|assembleRelease]
#
# Two modes:
#   1. Long-lived container `zcode-android-build-e` (recommended — Gradle caches
#      stay warm; the container keeps android-35/build-tools-35 installed via
#      sdkmanager on top of the image's android-34). Started once:
#        docker run -d --name zcode-android-build-e \
#          -v "<repo-root>:/work" -v zcode-gradle-cache:/root/.gradle \
#          -w /work/Android-APP llama-android-builder:latest sleep infinity
#   2. One-shot fallback: docker run --rm with the same mounts (re-downloads
#      Gradle/AGP deps unless the zcode-gradle-cache volume exists).
#
# Prereq before packaging: assets/server_bundle/server.cjs must exist —
#   bun run build:android-bundle
#   cp dist/android/server.cjs Android-APP/app/src/main/assets/server_bundle/
set -euo pipefail

TASK="${1:-assembleDebug}"
CONTAINER="zcode-android-build-e"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Git Bash: convert /e/zcodeplus -> E:/zcodeplus and stop MSYS path mangling
case "$ROOT" in
  /[a-z]/*) DRIVE="${ROOT:1:1}"; ROOT="${DRIVE^^}:/${ROOT:3}" ;;
esac
export MSYS_NO_PATHCONV=1

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker start "$CONTAINER" >/dev/null 2>&1 || true
  exec docker exec -w /work/Android-APP "$CONTAINER" gradle "$TASK"
fi

echo "[build-android-apk] container $CONTAINER not found — one-shot docker run" >&2
exec docker run --rm \
  -v "$ROOT:/work" \
  -v zcode-gradle-cache:/root/.gradle \
  -w /work/Android-APP \
  llama-android-builder:latest \
  gradle "$TASK"
