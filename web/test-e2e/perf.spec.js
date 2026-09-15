// The open-performance gate (docs/DESIGN.md §5, §10): build a 5,000-node
// store, flush (implicit: the worker flushes after every mutating `call`),
// close, reopen, and measure first `loadFrame` -> `finishOpen` returning
// inside the worker. Chromium and WebKit are hard-gated at under 100 ms;
// Firefox is recorded in docs/GATES.md but not asserted (see
// scripts/write-gates.mjs, the globalTeardown that reads the JSON this
// writes).
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
  expect(typeof loadMs).toBe("number");

  mkdirSync(gatesDir, { recursive: true });
  writeFileSync(
    path.join(gatesDir, `${testInfo.project.name}.json`),
    JSON.stringify({ browser: testInfo.project.name, nodeCount: 5000, loadMs }),
  );

  if (testInfo.project.name !== "firefox") {
    expect(loadMs).toBeLessThan(100);
  }
});
