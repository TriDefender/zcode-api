#!/system/bin/sh
export HOME=/data/data/com.zcode.proxy/files
export ZCODE_PROXY_CREDENTIAL_SECRET=7e9c07a8e65ab485c5e02f53a5a925d7e77278cd9b612f9fb6514ca47ea22f5b
NATIVE_DIR=""
for d in /data/app/*/com.zcode.proxy-*/lib/arm64; do
  if [ -f "$d/libnode.so" ]; then NATIVE_DIR="$d"; break; fi
done
if [ -z "$NATIVE_DIR" ]; then echo "ERROR: cannot find libnode.so"; exit 1; fi
export LD_LIBRARY_PATH="$NATIVE_DIR"
cd /data/data/com.zcode.proxy/files
"$NATIVE_DIR/libnode.so" --no-warnings import-cred.cjs "$1" "$2"