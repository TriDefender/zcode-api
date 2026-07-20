#!/usr/bin/env python3
"""Parse the Termux Packages index and emit download URLs for our deps."""
import sys

needed = ["libc++", "openssl", "c-ares", "libicu", "libsqlite", "zlib"]
with open("/tmp/node-extract/packages.txt") as f:
    txt = f.read()

for stanza in txt.split("\n\n"):
    if not stanza.strip():
        continue
    fields = {}
    for line in stanza.split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip()
    pkg = fields.get("Package", "")
    if pkg in needed:
        print(f"{pkg}|{fields.get('Version','')}|{fields.get('Filename','')}|{fields.get('SHA256','')}")
