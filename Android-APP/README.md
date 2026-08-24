# ZCode Proxy — Android Build

This document explains how to build the Android APK from source. The Android
app wraps the TypeScript proxy server (bundled as a Node.js CJS bundle) inside
a Kotlin shell; OAuth login happens in an embedded Android System WebView.

## Prerequisites

- **Bun** (latest stable) — for building the TS bundle
- **JDK 17** (Temurin recommended)
- **Android SDK** with platform `android-35` and build-tools `35.0.0`
- **GNU binutils** (`ar`, `tar`, `xz`) on PATH — needed by the `downloadNodeBinary`
  Gradle task to extract the Termux Node.js `.deb` package
- **readelf** (binutils) on PATH — for the DT_NEEDED closure check

## Build steps

```bash
# 1. Install JS deps
bun install

# 2. Build the esbuild CJS bundle (outputs dist/android/server.cjs)
bun run build:android-bundle

# 3. Build the debug APK (downloads Node.js + deps, copies the bundle)
cd android
./gradlew assembleDebug

# 4. Sideload onto a device (USB debugging enabled)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Release build (signed)

Requires GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The
release CI workflow builds a signed APK automatically on tag push
(`vX.Y.Z`). For local signed builds:

```bash
cd android
./gradlew assembleRelease \
  -PandroidSigning.keystoreFile=/path/to/release.keystore \
  -PandroidSigning.storePassword=... \
  -PandroidSigning.keyAlias=... \
  -PandroidSigning.keyPassword=...
```

## Architecture

- `android/` — Gradle project; everything Android-specific lives here.
- `android/buildSrc/src/main/kotlin/DownloadNodeBinaryTask.kt` — pinned Node.js
  binary + dependency `.so` extraction.
- `android/app/src/main/java/com/zcode/proxy/` — Kotlin shell.
- `Android-APP/app/src/main/assets/server_bundle/` — committed in the repo
  (canonical); regenerate via `bun run build:android-bundle` + copy
  `dist/android/server.cjs` into it (see BUILD in `Android-APP/AGENTS.md`).
- `android/gradle/node-binary.lock.json` — pinned URLs and SHA256s.

## OAuth flow

1. App taps "Login with {provider}" → `ControlClient.startOAuth(provider)`.
2. Node side starts the localhost callback server (port
   `ZCODE_OAUTH_CALLBACK_PORT`) and returns the authorize URL.
3. App launches `OAuthWebViewActivity` with the URL; Android System WebView
   loads it.
4. User authenticates against chat.z.ai / bigmodel.cn in-page.
5. Provider redirects to `http://127.0.0.1:<port>/oauth/callback/...?authCode=...&state=...`.
6. `WebViewClient.shouldOverrideUrlLoading` intercepts (host == `127.0.0.1`)
   and forwards the code + state via `ControlClient.deliverOAuthCode`.
7. Node validates state, exchanges at `zcode.z.ai/api/v1/oauth/token`, persists
   the credential.

## Known limitations (v1)

- **Start-plan tier untested on Android** — the in-process happy-dom captcha
  solver is now bundled into `server.cjs` (the jsdom exclusion is gone), but
  the tier has not been validated on-device. Coding-plan (direct upstream
  API key) is the supported tier on Android v1.
- **Not Play Store-distributed** — APK is sideload-only. Play Store rejects apps
  that launch external binaries from `jniLibs/`.
- **arm64-v8a only** — no x86 / armeabi-v7a support. Covers 99%+ of modern
  Android devices.
- **No iOS build** — Android only for v1.

## Permissions

- `INTERNET` — proxy server + upstream HTTPS
- `ACCESS_NETWORK_STATE` — detect connectivity changes
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` — keep Node.js alive
  when the app is backgrounded
- `POST_NOTIFICATIONS` — required on Android 13+ for the foreground service
  notification
- `WAKE_LOCK` — prevent CPU sleep during long LLM calls
