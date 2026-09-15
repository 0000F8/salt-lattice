// The real worker, on a real page, on Chromium/WebKit/Firefox
// (docs/DESIGN.md §10): root create/restore, write/read across reload,
// destroy, backup export/import. Everything here talks to
// `window.__lattice` (a handle from web/lattice.js) through
// page.evaluate() — bytes cross the Node<->browser boundary as plain
// Arrays (Playwright's evaluate serialization doesn't reliably round-trip
// typed arrays), converted back with Uint8Array.from on the receiving side.
import { test, expect, resetLatticeStorage } from "./fixtures.js";

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

test("root create + restore re-derives the same compartment keys", async ({ page }) => {
  const beforeCreate = await page.evaluate(() => window.__lattice.hasRoot());
  expect(beforeCreate.hasRoot).toBe(false);

  const raw = await page.evaluate(async () => {
    const { raw } = await window.__lattice.createRoot();
    return Array.from(raw);
  });
  expect(raw).toHaveLength(32);

  // A second createRoot must refuse rather than silently orphan existing ciphertext.
  const secondCreate = await page.evaluate(() => window.__lattice.createRoot().catch((e) => e));
  expect(secondCreate.code).toBe("root_exists");

  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));
  const food = await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.food",
      fields: { name: "Food" },
      author: { kind: "you" },
    }),
  );
  await page.evaluate(
    (foodId) =>
      window.__lattice.call("put_node", {
        type: "preferences.food.cuisine",
        parent: foodId,
        fields: { name: "Japanese", strength: 0.8 },
        author: { kind: "you" },
      }),
    food.id,
  );

  // Simulate a fresh device that has the OPFS files (an off-device backup
  // restored) but lost the IndexedDB root key entry, and must recover it
  // from the vault-wrapped raw bytes (docs/PROTOCOL.md "Key backup").
  await page.evaluate(() => window.__lattice.close());
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase("lattice-keys");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
  );

  const hasRootAfterWipe = await page.evaluate(() => window.__lattice.hasRoot());
  expect(hasRootAfterWipe.hasRoot).toBe(false);

  await page.evaluate((rawBytes) => window.__lattice.restoreRoot(Uint8Array.from(rawBytes)), raw);
  const hasRootAfterRestore = await page.evaluate(() => window.__lattice.hasRoot());
  expect(hasRootAfterRestore.hasRoot).toBe(true);

  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));
  const found = await page.evaluate(() => window.__lattice.call("query", { path: "preferences/food/cuisine" }));
  expect(found).toHaveLength(1);
  expect(found[0].fields.name).toBe("Japanese");
});

test("write and read back across a real page reload", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open());

  const node = await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "identity.person",
      fields: { name: "Ada" },
      author: { kind: "you" },
    }),
  );
  expect(node.fields.name).toBe("Ada");

  await page.reload();
  await page.evaluate(async () => {
    const { openLattice } = await import("/lattice.js");
    window.__lattice = await openLattice({
      workerUrl: "/lattice.worker.js",
      wasmUrl: "/pkg/lattice_wasm_bg.wasm",
    });
  });

  const hasRoot = await page.evaluate(() => window.__lattice.hasRoot());
  expect(hasRoot.hasRoot).toBe(true);

  await page.evaluate(() => window.__lattice.open());
  const found = await page.evaluate(() => window.__lattice.call("query", { path: "identity/person" }));
  expect(found.map((n) => n.id)).toContain(node.id);
});

test("destroy compartment removes its data and stays destroyed after reopen", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: ["health"] }));

  const node = await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "health.condition",
      fields: { name: "Seasonal allergies" },
      author: { kind: "you" },
    }),
  );
  expect(node.id).toMatch(/^n_/);

  let found = await page.evaluate(() => window.__lattice.call("query", { path: "health/condition" }));
  expect(found).toHaveLength(1);

  await page.evaluate(() => window.__lattice.destroyCompartment("health"));
  found = await page.evaluate(() => window.__lattice.call("query", { path: "health/condition" }));
  expect(found).toHaveLength(0);

  // Prove it's gone from disk, not just the in-memory index: free the wasm
  // instance and root key, then reopen from scratch.
  await page.evaluate(() => window.__lattice.close());
  await page.evaluate(() => window.__lattice.open({ compartments: ["health"] }));
  found = await page.evaluate(() => window.__lattice.call("query", { path: "health/condition" }));
  expect(found).toHaveLength(0);
});

test("backup export -> wipe OPFS -> import -> read back", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));

  const food = await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.food",
      fields: { name: "Food" },
      author: { kind: "you" },
    }),
  );
  await page.evaluate(
    (foodId) =>
      window.__lattice.call("put_node", {
        type: "preferences.food.cuisine",
        parent: foodId,
        fields: { name: "Thai", strength: 0.6 },
        author: { kind: "you" },
      }),
    food.id,
  );

  const backup = await page.evaluate(async () => {
    const { blob } = await window.__lattice.exportBackup();
    return Array.from(blob);
  });
  expect(backup.length).toBeGreaterThan(0);

  await page.evaluate(() => window.__lattice.close());

  // Wipe OPFS entirely, simulating data loss. The async directory API
  // (getDirectory/removeEntry) works from the main thread; only
  // createSyncAccessHandle is worker-only, and the worker never leaves one
  // open between messages.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("lattice", { recursive: true }).catch(() => {});
  });

  await page.evaluate((blob) => window.__lattice.importBackup(Uint8Array.from(blob)), backup);

  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));
  const found = await page.evaluate(() => window.__lattice.call("query", { path: "preferences/food/cuisine" }));
  expect(found).toHaveLength(1);
  expect(found[0].fields.name).toBe("Thai");
});

test("encryptBlob/decryptBlob round-trips through a real worker", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  const roundtrip = await page.evaluate(async () => {
    const { bytes } = await window.__lattice.encryptBlob("embedding", Uint8Array.from([1, 2, 3]));
    const { bytes: decrypted } = await window.__lattice.decryptBlob("embedding", bytes);
    return Array.from(decrypted);
  });
  expect(roundtrip).toEqual([1, 2, 3]);
});
