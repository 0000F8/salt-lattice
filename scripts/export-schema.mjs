#!/usr/bin/env node
// Writes docs/schema.v1.json from the built wasm's Lattice.schemaJson()
// (docs/DESIGN.md §2, §8). Run `scripts/build-wasm.sh` first. Node-only,
// uses `initSync` synchronously (no bundler, no fetch).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgDir = path.join(rootDir, "pkg");
const outPath = path.join(rootDir, "docs", "schema.v1.json");

const { Lattice, initSync } = await import(path.join(pkgDir, "lattice_wasm.js"));
const wasmBytes = readFileSync(path.join(pkgDir, "lattice_wasm_bg.wasm"));
initSync({ module: wasmBytes });

const lattice = new Lattice();
const schema = JSON.parse(lattice.schemaJson());

writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
console.log(`Wrote ${path.relative(rootDir, outPath)} (schema version ${schema.version}, ${schema.types.length} types, ${schema.links.length} links)`);
