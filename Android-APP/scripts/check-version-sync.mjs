#!/usr/bin/env node
// Reads version from package.json, src/index.ts (VERSION const), and
// android/app/build.gradle.kts (versionName); exits non-zero on mismatch.
// Wired into the Gradle `check` phase and CI verification.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function readVersion(file, matcher) {
  const content = readFileSync(join(repoRoot, file), "utf-8");
  const m = content.match(matcher);
  if (!m) throw new Error(`Version not found in ${file} (pattern: ${matcher})`);
  return m[1];
}

const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;
const srcVersion = readVersion("src/index.ts", /VERSION\s*=\s*"([^"]+)"/);
const gradleVersion = readVersion("android/app/build.gradle.kts", /versionName\s*=\s*"([^"]+)"/);

const srcMatchesPkg = pkgVersion === srcVersion;
const gradleMatchesPkg = gradleVersion === pkgVersion || gradleVersion === `${pkgVersion}-android`;

console.log(`package.json:           ${pkgVersion}`);
console.log(`src/index.ts VERSION:   ${srcVersion}`);
console.log(`android versionName:    ${gradleVersion}`);

if (!srcMatchesPkg) {
  console.error(`MISMATCH: package.json=${pkgVersion} vs src/index.ts=${srcVersion}`);
  process.exit(1);
}
if (!gradleMatchesPkg) {
  console.error(`MISMATCH: package.json=${pkgVersion} vs android=${gradleVersion}`);
  process.exit(1);
}
console.log("OK: all versions in sync.");
