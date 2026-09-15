#!/usr/bin/env node
// Copies the built wasm + browser client into salt-fe's vendor directory,
// and the exported schema into salt-api's public assets (per the team
// lead's brief: "another agent is building on those repos' `lattice`
// branches; just copy files, do not commit there").
//
// Run after `npm run build:wasm` and `npm run export-schema`. Destination
// files are flattened into one directory (no `pkg/` subfolder), so
// lattice.worker.js's `./pkg/lattice_wasm.js` import is rewritten to
// `./lattice_wasm.js` on the way out — this is the one place that rewrite
// happens; the source file in web/ is untouched.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgDir = path.join(rootDir, "pkg");
const webDir = path.join(rootDir, "web");
const docsDir = path.join(rootDir, "docs");

const feVendorDir = path.join(rootDir, "..", "salt-fe", "src", "lattice", "vendor");
const apiSchemaDir = path.join(rootDir, "..", "salt-api", "public", "lattice");

function requireFile(p, hint) {
  if (!existsSync(p)) {
    throw new Error(`missing ${path.relative(rootDir, p)} — ${hint}`);
  }
  return p;
}

function main() {
  requireFile(path.join(pkgDir, "lattice_wasm.js"), "run `npm run build:wasm` first");
  requireFile(path.join(pkgDir, "lattice_wasm_bg.wasm"), "run `npm run build:wasm` first");
  requireFile(path.join(docsDir, "schema.v1.json"), "run `npm run export-schema` first");

  mkdirSync(feVendorDir, { recursive: true });
  mkdirSync(apiSchemaDir, { recursive: true });

  // Flat copies: lattice_wasm.js, lattice_wasm_bg.wasm, lattice.js, crypto.js.
  copyFileSync(path.join(pkgDir, "lattice_wasm.js"), path.join(feVendorDir, "lattice_wasm.js"));
  copyFileSync(path.join(pkgDir, "lattice_wasm_bg.wasm"), path.join(feVendorDir, "lattice_wasm_bg.wasm"));
  copyFileSync(path.join(webDir, "lattice.js"), path.join(feVendorDir, "lattice.js"));
  copyFileSync(path.join(webDir, "crypto.js"), path.join(feVendorDir, "crypto.js"));

  // lattice.worker.js needs its `./pkg/lattice_wasm.js` import rewritten to
  // `./lattice_wasm.js` — vendor/ has everything flattened as siblings.
  const workerSrc = readFileSync(path.join(webDir, "lattice.worker.js"), "utf8");
  const needle = 'from "./pkg/lattice_wasm.js"';
  if (!workerSrc.includes(needle)) {
    throw new Error(`web/lattice.worker.js no longer imports ${needle} — update sync-to-fe.mjs's rewrite`);
  }
  const workerOut = workerSrc.replace(needle, 'from "./lattice_wasm.js"');
  writeFileSync(path.join(feVendorDir, "lattice.worker.js"), workerOut);

  // Schema, for salt-api to serve at GET /api/.well-known or similar (see
  // docs/PROTOCOL.md's `GET /schema`: "checked-in copy
  // public/lattice/schema.v1.json").
  copyFileSync(path.join(docsDir, "schema.v1.json"), path.join(apiSchemaDir, "schema.v1.json"));

  console.log("Synced to:");
  console.log(`  ${path.relative(rootDir, feVendorDir)}/{lattice_wasm.js, lattice_wasm_bg.wasm, lattice.worker.js, lattice.js, crypto.js}`);
  console.log(`  ${path.relative(rootDir, apiSchemaDir)}/schema.v1.json`);
}

main();
