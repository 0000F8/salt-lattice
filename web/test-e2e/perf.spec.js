// The open-performance gate (docs/DESIGN.md §5, §10): build a 5,000-node
// store, flush (implicit: the worker flushes after every mutating `call`),
// close, reopen, and measure two numbers from the worker's `open()` result
// (`timings`, set in web/lattice.worker.js's `doOpen`):
//   - loadMs: first `loadFrame` -> `finishOpen` returning, wasm-only,
//     excludes OPFS/WebCrypto. Hard-gated under 100 ms on Chromium and
//     WebKit; Firefox is recorded but not asserted.
//   - wallMs: the whole `open()` call, message-in to reply-out (IO +
//     decrypt + loadFrame + finishOpen) — what a phone actually waits for.
//     Recorded for all three browsers, never gated (docs/GATES.md says so
//     plainly rather than asserting a number nobody has measured on-device
//     yet).
// Both land in docs/GATES.md via scripts/write-gates.mjs, the globalTeardown
// that reads the JSON this test writes.
import { test, expect, resetLatticeStorage } from "./fixtures.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootDir = path.dirname(webDir);
const gatesDir = path.join(rootDir, "test-results", "gates");

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await resetLatticeStorage(page);
  await page.evaluate(async () => {
    const { openLattice } = await import("/lattice.js");
    window.__lattice = await openLattice({
      workerUrl: "/lattice.worker.js",
      wasmUrl: "/pkg/lattice_wasm_bg.wasm",
    });
  });
});

test("5,000-node store opens in under 100ms (first loadFrame -> finishOpen)", async ({ page }, testInfo) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: [] }));
  await page.evaluate(() => window.__lattice.call("build_fixture", { count: 5000 }));

  // Free the wasm instance and root key so the reopen below does a genuine
  // read-from-disk, not a read from an already-warm in-memory index.
  await page.evaluate(() => window.__lattice.close());

  const opened = await page.evaluate(() => window.__lattice.open());
  const loadMs = opened.timings.loadMs;
  const wallMs = opened.timings.wallMs;
  expect(typeof loadMs).toBe("number");
  expect(typeof wallMs).toBe("number");

  mkdirSync(gatesDir, { recursive: true });
  writeFileSync(
    path.join(gatesDir, `${testInfo.project.name}.json`),
    JSON.stringify({ browser: testInfo.project.name, nodeCount: 5000, loadMs, wallMs }),
  );

  if (testInfo.project.name !== "firefox") {
    expect(loadMs).toBeLessThan(100);
  }
  // wallMs (IO + decrypt + loadFrame + finishOpen) is recorded-only on
  // every browser, per the team lead: the doc should say what opening
  // actually feels like, not just what the store itself costs.
});
