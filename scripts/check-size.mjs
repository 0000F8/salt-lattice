#!/usr/bin/env node
// `npm run size`: prints the compressed wasm size and fails (non-zero exit)
// over the 300 KB gzip gate (docs/DESIGN.md §1). Run `scripts/build-wasm.sh`
// first; this script only measures pkg/lattice_wasm_bg.wasm, it doesn't build it.

import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GZIP_GATE_BYTES = 300 * 1024;

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wasmPath = path.join(rootDir, "pkg", "lattice_wasm_bg.wasm");

if (!existsSync(wasmPath)) {
  console.error(`missing ${path.relative(rootDir, wasmPath)} — run \`npm run build:wasm\` first`);
  process.exit(1);
}

const bytes = readFileSync(wasmPath);
const gzipped = gzipSync(bytes, { level: 9 });

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

console.log(`pkg/lattice_wasm_bg.wasm: raw ${bytes.length} bytes (${kb(bytes.length)}), gzip-9 ${gzipped.length} bytes (${kb(gzipped.length)})`);

if (gzipped.length > GZIP_GATE_BYTES) {
  console.error(`FAIL: gzip size ${kb(gzipped.length)} exceeds the ${kb(GZIP_GATE_BYTES)} gate`);
  process.exit(1);
}

console.log(`OK: under the ${kb(GZIP_GATE_BYTES)} gate`);
