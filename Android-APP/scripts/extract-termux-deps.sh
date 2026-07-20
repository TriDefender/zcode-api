#!/usr/bin/env bash
# Download Termux dep .debs and extract their .so files
set -e
cd /tmp/node-extract/deps

declare -A urls
urls[libc++]="pool/main/libc/libc++/libc++_29_aarch64.deb"
urls[openssl]="pool/main/o/openssl/openssl_1:3.6.3_aarch64.deb"
urls[c-ares]="pool/main/c/c-ares/c-ares_1.34.8_aarch64.deb"
urls[libicu]="pool/main/libi/libicu/libicu_78.3_aarch64.deb"
urls[libsqlite]="pool/main/libs/libsqlite/libsqlite_3.53.3_aarch64.deb"
urls[zlib]="pool/main/z/zlib/zlib_1.3.2_aarch64.deb"

for pkg in "${!urls[@]}"; do
    url="https://packages.termux.dev/apt/termux-main/${urls[$pkg]}"
    echo "=== Downloading $pkg ==="
    curl -sL -o "${pkg}.deb" "$url"
    ls -lh "${pkg}.deb"
done

echo ""
echo "=== Extracting .so files ==="
for deb in *.deb; do
    pkg="${deb%.deb}"
    rm -rf "$pkg"
    mkdir -p "$pkg"
    (cd "$pkg" && ar -x "../$deb" && xz -d -k data.tar.xz 2>/dev/null)
    echo "--- $pkg ---"
    tar -tf "$pkg/data.tar" 2>/dev/null | grep -E '\.so(\.|$)' | head -10
done
