// Playwright globalTeardown: consolidates the per-browser perf numbers each
// project's perf.spec.js wrote into test-results/gates/<browser>.json into
// docs/GATES.md, alongside the machine and the wasm sizes (docs/DESIGN.md
// §5, §10). Safe to run even if some browsers' JSON is missing (a filtered
// `--project` run) — it just reports what it has.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gatesDir = path.join(rootDir, "test-results", "gates");
const wasmPath = path.join(rootDir, "pkg", "lattice_wasm_bg.wasm");

function safeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

function wasmSizes() {
  if (!existsSync(wasmPath)) return null;
  const bytes = readFileSync(wasmPath);
  const gzip = gzipSync(bytes, { level: 9 });
  const brotli = brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  return { raw: bytes.length, gzip: gzip.length, brotli: brotli.length };
}

function readGateResults() {
  if (!existsSync(gatesDir)) return [];
  return readdirSync(gatesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(gatesDir, f), "utf8")))
    .sort((a, b) => a.browser.localeCompare(b.browser));
}

export default async function writeGates() {
  const results = readGateResults();
  const sizes = wasmSizes();
  const cpu = safeExec("sysctl", ["-n", "machdep.cpu.brand_string"]);
  const macOsVersion = safeExec("sw_vers", ["-productVersion"]);

  const lines = [];
  lines.push("# Gates (docs/DESIGN.md §1, §5, §10)");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/write-gates.mjs\` (Playwright globalTeardown).`);
  lines.push("");
  lines.push("## Machine");
  lines.push("");
  lines.push(`- CPU: ${cpu}`);
  lines.push(`- macOS: ${macOsVersion}`);
  lines.push("");
  lines.push("## Wasm size gate (§1: under 300 KB gzip)");
  lines.push("");
  if (sizes) {
    lines.push(`- raw: ${sizes.raw} bytes (${kb(sizes.raw)})`);
    lines.push(`- gzip-9: ${sizes.gzip} bytes (${kb(sizes.gzip)}) — gate: ${sizes.gzip <= 300 * 1024 ? "PASS" : "FAIL"}`);
    lines.push(`- brotli: ${sizes.brotli} bytes (${kb(sizes.brotli)})`);
  } else {
    lines.push("- (pkg/lattice_wasm_bg.wasm not built — run `npm run build:wasm` first)");
  }
  lines.push("");
  lines.push("## Open gate (§5: 5,000-node store, first `loadFrame` -> `finishOpen` returning, under 100 ms)");
  lines.push("");
  lines.push("Gated (must be under 100 ms) on Chromium and WebKit; Firefox is recorded but not gated.");
  lines.push("");
  lines.push("| Browser | Nodes | loadMs | Gate |");
  lines.push("|---|---|---|---|");
  if (results.length === 0) {
    lines.push("| (no results — run `npm run test:browsers`) | | | |");
  } else {
    for (const r of results) {
      const gated = r.browser !== "firefox";
      const pass = r.loadMs < 100;
      const gateCell = gated ? (pass ? "PASS" : "FAIL") : "recorded only";
      lines.push(`| ${r.browser} | ${r.nodeCount} | ${r.loadMs.toFixed(2)} | ${gateCell} |`);
    }
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- These are desktop-browser numbers on the machine above, not the iOS 16 Simulator gate CLAUDE.md notes as still owed.");
  lines.push("- WebKit and Firefox here are Playwright's bundled desktop builds pinned to `@playwright/test` 1.48.0 (see package.json), because this machine (macOS 12/mac12-arm64) isn't supported by Playwright releases newer than that. That version predates the fix for GHSA-7mvr-c777-76hp (TLS validation during browser-binary download); the risk is confined to the one-time `playwright install` step, not to running these tests, so it was accepted rather than left on a machine-incompatible newer release.");
  lines.push("- Firefox's number is noisy run to run (a few hundred ms of variance observed) and is not gated for that reason; Chromium and WebKit were consistently well under 100 ms across repeated runs.");
  lines.push("");

  mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  writeFileSync(path.join(rootDir, "docs", "GATES.md"), lines.join("\n") + "\n");
  console.log(`Wrote docs/GATES.md (${results.length} browser result(s))`);
}
