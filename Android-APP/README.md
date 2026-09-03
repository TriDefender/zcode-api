# ZCode Proxy — Android Build

This document explains how to build the Android APK from source. The Android
app wraps the TypeScript proxy server (bundled as a Node.js CJS bundle) inside
a Kotlin shell; OAuth login happens in the system browser via Custom Tabs.

## Prerequisites

- **Bun** 1.4.0 (pinned — CI and release builds use exactly this version) —
  for building the TS bundle
- **JDK 17** (Temurin recommended)
- **Android SDK** with platform `android-35` and build-tools `35.0.0`
- **GNU binutils** (`ar`, `tar`, `xz`) on PATH — only needed if you re-extract
  the Termux Node.js `.deb` packages via `scripts/extract-termux-deps.sh` (the
  extracted `.so` files are committed in `app/src/main/jniLibs/arm64-v8a/`)

## Build steps

```bash
# 1. Install JS deps
bun install

# 2. Build the esbuild CJS bundle (outputs dist/android/server.cjs)
bun run build:android-bundle
cp dist/android/server.cjs Android-APP/app/src/main/assets/server_bundle/server.cjs

# 3. Build the debug APK (Node binary + dependency .so files are committed
#    in jniLibs — nothing is downloaded at build time)
cd Android-APP
./gradlew assembleDebug

# 4. Sideload onto a device (USB debugging enabled)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Release build (signed)

Requires GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The
release CI workflow (`.github/workflows/release.yml`, manual dispatch with a
`vX.Y.Z` tag input) builds a signed APK. For local signed builds:

```bash
cd Android-APP
./gradlew assembleRelease \
  -PandroidSigning.keystoreFile=/path/to/release.keystore \
  -PandroidSigning.storePassword=... \
  -PandroidSigning.keyAlias=... \
  -PandroidSigning.keyPassword=...
```

## Architecture

- `Android-APP/` — Gradle project; everything Android-specific lives here.
- `Android-APP/app/src/main/java/com/zcode/proxy/` — Kotlin shell.
- `Android-APP/app/src/main/assets/server_bundle/` — tracked sidecar assets
  (`config.example.yaml`, `webui.txt`, `zcode_system.json`); `server.cjs` is
  gitignored build output — regenerate via `bun run build:android-bundle` +
  copy `dist/android/server.cjs` into it before building (Gradle's
  `checkServerBundle` preBuild task fails with a hint if it is missing).
- `Android-APP/app/src/main/jniLibs/arm64-v8a/` — committed Node.js binary
  (`libnode.so`) + Termux dependency `.so` files, extracted once via
  `scripts/extract-termux-deps.sh`.
- `Android-APP/gradle/node-binary.lock.json` — pinned URLs and SHA256s.

## OAuth flow

1. App taps "Login with {provider}" → `ControlClient.startOAuth(provider)`.
2. Node starts the OAuth flow and returns the authorize URL:
   - **zai** — server-mediated CLI flow (`/oauth/cli/init` +
     `/oauth/cli/poll/{flow_id}` at zcode.z.ai); no localhost callback.
   - **bigmodel** — auth-code flow; Node also starts the localhost callback
     server (port `ZCODE_OAUTH_CALLBACK_PORT`).
3. App opens the URL with `CustomTabsIntent.launchUrl()` — the system browser
   handles login (OAuth providers block embedded WebViews).
4. User authenticates in the browser:
   - **zai**: Node polls the server until authorization completes.
   - **bigmodel**: the provider redirects to
     `http://127.0.0.1:<port>/oauth/callback/...`, which Node's callback
     server receives directly (no Kotlin-side interception).
5. Node exchanges the code / resolves the coding-plan API key and persists the
   encrypted credential; the app reflects login state via `status`.

## Known limitations (v1)

- **Start-plan tier untested on Android** — the in-process happy-dom captcha
  solver is bundled into `server.cjs` (jsdom was removed from the project
  entirely), but the tier has not been validated on-device. Coding-plan
  (direct upstream) is the supported tier on Android v1.
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
