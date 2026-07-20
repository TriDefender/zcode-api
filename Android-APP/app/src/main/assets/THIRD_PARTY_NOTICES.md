# Third Party Notices

This APK bundles the following third-party software.

## Node.js

- License: MIT (https://nodejs.org/en/about/licenses/)
- Source: https://github.com/nodejs/node
- Bundled as: `libnode.so` (Termux prebuilt v24.17.0 LTS, ARM64)
- Pinned URL: https://packages.termux.dev/apt/termux-main/pool/main/n/nodejs-lts/nodejs-lts_24.17.0_aarch64.deb

## Node.js shared library dependencies

All bundled as `.so` files in `jniLibs/arm64-v8a/`. Sources are the matching
Termux `.deb` packages (https://packages.termux.dev/apt/termux-main/).

### libc++ (LLVM C++ Runtime)
- License: Apache-2.0 WITH LLVM-exception (https://llvm.org/LICENSE.txt)

### OpenSSL
- License: Apache-2.0 (https://www.openssl.org/source/license.html)

### c-ares
- License: MIT (https://c-ares.org/license.html)

### ICU (libicu)
- License: ICU (https://unicode.org/copyright.html)

### libsqlite
- License: Public Domain (https://sqlite.org/copyright.html)

### zlib
- License: zlib (https://www.zlib.net/zlib_license.html)

## Application-level dependencies

- esbuild — MIT (https://github.com/evanw/esbuild)
- jsdom — MIT (https://github.com/jsdom/jsdom) — NOT bundled into the Android APK (excluded via esbuild `--external:jsdom`)
- yaml — ISC (https://github.com/eemeli/yaml)
