// The real worker, on a real page, on Chromium/WebKit/Firefox
// (docs/DESIGN.md §10): root create/restore, write/read across reload,
// destroy, backup export/import. Everything here talks to
// `window.__lattice` (a handle from web/lattice.js) through
// page.evaluate() — bytes cross the Node<->browser boundary as plain
// Arrays (Playwright's evaluate serialization doesn't reliably round-trip
// typed arrays), converted back with Uint8Array.from on the receiving side.
import { test, expect, resetLatticeStorage } from "./fixtures.js";

async function openWorkerHandle(page) {
  await page.evaluate(async () => {
    const { openLattice } = await import("/lattice.js");
    window.__lattice = await openLattice({
      workerUrl: "/lattice.worker.js",
      wasmUrl: "/pkg/lattice_wasm_bg.wasm",
    });
  });
}

/** A real page reload followed by re-creating the worker handle: OPFS/IndexedDB survive, the previous `window.__lattice` and its worker do not. */
async function reloadAndReconnect(page) {
  await page.reload();
  await openWorkerHandle(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await resetLatticeStorage(page);
  await openWorkerHandle(page);
});

test("root create + restore re-derives the same compartment keys", async ({ page }) => {
  const beforeCreate = await page.evaluate(() => window.__lattice.hasRoot());
  expect(beforeCreate.hasRoot).toBe(false);

  const raw = await page.evaluate(async () => {
    const raw = await window.__lattice.createRoot();
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

test("restoreRoot refuses an active root without force; force replaces it and old ciphertext becomes unreadable", async ({
  page,
}) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));
  await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.food",
      fields: { name: "Food" },
      author: { kind: "you" },
    }),
  );

  const otherRaw = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);

  const refused = await page.evaluate(
    (raw) => window.__lattice.restoreRoot(Uint8Array.from(raw)).catch((e) => e),
    otherRaw,
  );
  expect(refused.code).toBe("root_exists");

  // The refusal touched nothing: the original root and its data still work.
  const stillThere = await page.evaluate(() => window.__lattice.call("query", { path: "preferences/food" }));
  expect(stillThere).toHaveLength(1);

  await page.evaluate((raw) => window.__lattice.restoreRoot(Uint8Array.from(raw), { force: true }), otherRaw);

  // force genuinely swapped the operative key: the compartment file is
  // still on disk (still encrypted under the OLD root), so opening it
  // under the NEW root must fail to decrypt rather than silently reading
  // nothing or reusing a stale in-memory index.
  const openAfterForce = await page.evaluate(() =>
    window.__lattice.open({ compartments: ["preferences"] }).then(
      (r) => ({ ok: r }),
      (e) => ({ err: e }),
    ),
  );
  expect(openAfterForce.err).toBeDefined();

  // The new root itself is live and usable for fresh writes.
  const hasRoot = await page.evaluate(() => window.__lattice.hasRoot());
  expect(hasRoot.hasRoot).toBe(true);
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

test("open() drops a truncated trailing frame instead of failing the whole compartment", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));

  // Two separate flushes -> two on-disk frames, so a corruption confined to
  // the trailing one must leave the first fully intact (review S9).
  await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.food",
      fields: { name: "Food" },
      author: { kind: "you" },
    }),
  );
  await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.music",
      fields: { name: "Music" },
      author: { kind: "you" },
    }),
  );

  await page.evaluate(() => window.__lattice.close());

  const warnings = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });

  // Truncate the compartment file's last few bytes via a throwaway worker:
  // createSyncAccessHandle (the only OPFS write API that supports an
  // in-place truncate+write) is worker-only in WebKit, and
  // createWritable() isn't implemented in every engine either — a plain
  // dedicated worker is the one thing all three support (the lattice
  // worker itself isn't holding any handle open at this point; closed
  // above).
  await page.evaluate(async () => {
    const workerCode = `
      self.onmessage = async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle("lattice")).getDirectoryHandle("v1");
        const handle = await dir.getFileHandle("preferences.frames");
        const access = await handle.createSyncAccessHandle();
        const size = access.getSize();
        access.truncate(size - 5); // land inside the second frame's body
        access.flush();
        access.close();
        self.postMessage({ ok: true });
      };
    `;
    const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" })));
    await new Promise((resolve) => {
      worker.onmessage = () => resolve();
      worker.postMessage("go");
    });
    worker.terminate();
  });

  const opened = await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));
  expect(opened.hasRoot).toBe(true);

  const food = await page.evaluate(() => window.__lattice.call("query", { path: "preferences/food" }));
  expect(food).toHaveLength(1); // the first, complete frame survived

  const music = await page.evaluate(() => window.__lattice.call("query", { path: "preferences/music" }));
  expect(music).toHaveLength(0); // the second, truncated frame was correctly dropped

  expect(warnings.some((w) => w.includes("truncated trailing frame"))).toBe(true);
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

  // Review B5: the manifest naming "preferences" and its size is encrypted,
  // so the compartment name must not appear anywhere in the exported bytes.
  const backupAsText = Buffer.from(backup).toString("latin1");
  expect(backupAsText).not.toContain("preferences");

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

test("importBackup refuses an unsupported version and an unknown compartment name", async ({ page }) => {
  const raw = await page.evaluate(async () => Array.from(await window.__lattice.createRoot()));
  await page.evaluate(() => window.__lattice.open({ compartments: [] }));

  // The manifest is encrypted (review B5): to build a validly-encrypted but
  // semantically-wrong backup for this test, re-derive the SAME
  // manifest key the worker uses, from the same raw root bytes — HKDF is
  // deterministic, so this reconstructs the exact CryptoKey without the
  // test ever reaching into the worker's private state.
  const badVersion = await page.evaluate(async (rawBytes) => {
    const { importRootKey, deriveBlobKey, encodeBackup } = await import("/crypto.js");
    const rootKey = await importRootKey(crypto.subtle, Uint8Array.from(rawBytes));
    const manifestKey = await deriveBlobKey(crypto.subtle, rootKey, "backup-manifest");
    const blob = await encodeBackup(crypto.subtle, manifestKey, { version: 99, files: [] }, []);
    return window.__lattice.importBackup(blob).catch((e) => e);
  }, raw);
  expect(badVersion.code).toBe("invalid_backup");
  expect(badVersion.message).toMatch(/version/);

  const badCompartment = await page.evaluate(async (rawBytes) => {
    const { importRootKey, deriveBlobKey, encodeBackup } = await import("/crypto.js");
    const rootKey = await importRootKey(crypto.subtle, Uint8Array.from(rawBytes));
    const manifestKey = await deriveBlobKey(crypto.subtle, rootKey, "backup-manifest");
    const files = [{ name: "not_a_real_compartment", bytes: new Uint8Array([1, 2, 3]) }];
    const manifest = { version: 1, files: files.map((f) => ({ name: f.name, size: f.bytes.length })) };
    const blob = await encodeBackup(crypto.subtle, manifestKey, manifest, files);
    return window.__lattice.importBackup(blob).catch((e) => e);
  }, raw);
  expect(badCompartment.code).toBe("invalid_backup");
  expect(badCompartment.message).toMatch(/unknown compartment/);
});

test("a standing grant pushes an onStandingUpdate after a matching write flushes", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));

  const grant = await page.evaluate(() =>
    window.__lattice.call("set_grant", {
      agent_id: "agent-1",
      agent_fingerprint: "fp-1",
      rules: [{ selector: "preferences.food.cuisine.strength", mode: "auto" }],
      standing: { expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000 },
    }),
  );

  // The app resolves and supplies the agent's CURRENT key fingerprint
  // (security review B3/S10) — without this, pushStandingUpdates has
  // nothing to pass standing_diff's now-required agent_fingerprint and
  // skips the grant entirely; see the dedicated test below.
  await page.evaluate(() => window.__lattice.setAgentFingerprints({ "agent-1": "fp-1" }));

  await page.evaluate(() => {
    window.__standingUpdates = [];
    window.__lattice.onStandingUpdate((update) => window.__standingUpdates.push(update));
  });

  // A write that does NOT match the grant's selector (different type):
  // must not produce a push.
  await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.food",
      fields: { name: "Food" },
      author: { kind: "you" },
    }),
  );

  const food = await page.evaluate(() => window.__lattice.call("query", { path: "preferences/food" }));
  await page.evaluate(
    (foodId) =>
      window.__lattice.call("put_node", {
        type: "preferences.food.cuisine",
        parent: foodId,
        fields: { name: "Japanese", strength: 0.8 },
        author: { kind: "you" },
      }),
    food[0].id,
  );

  // The push is a separate, unsolicited worker message, not part of the
  // put_node reply's own promise resolution — wait for it explicitly.
  await expect.poll(() => page.evaluate(() => window.__standingUpdates.length)).toBeGreaterThan(0);

  const updates = await page.evaluate(() => window.__standingUpdates);
  expect(updates).toHaveLength(1); // the non-matching write pushed nothing
  expect(updates[0].grantId).toBe(grant.id);
  expect(updates[0].facts.some((f) => f.field === "strength" && f.value === 0.8)).toBe(true);
});

test("a standing push is skipped when the agent's fingerprint is unknown or has rotated", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open({ compartments: ["preferences"] }));

  const grant = await page.evaluate(() =>
    window.__lattice.call("set_grant", {
      agent_id: "agent-1",
      agent_fingerprint: "fp-1",
      rules: [{ selector: "preferences.food.cuisine.strength", mode: "auto" }],
      standing: { expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000 },
    }),
  );

  await page.evaluate(() => {
    window.__standingUpdates = [];
    window.__lattice.onStandingUpdate((update) => window.__standingUpdates.push(update));
  });

  const food = await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "preferences.food",
      fields: { name: "Food" },
      author: { kind: "you" },
    }),
  );

  // No setAgentFingerprints call yet: the worker has never been told
  // agent-1's current key, so a fully matching write must push nothing.
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
  expect(await page.evaluate(() => window.__standingUpdates)).toHaveLength(0);

  // A rotated (wrong) fingerprint must also push nothing — the crate
  // itself refuses standing_diff for a fingerprint mismatch (review B3).
  await page.evaluate(() => window.__lattice.setAgentFingerprints({ "agent-1": "fp-ROTATED" }));
  await page.evaluate(
    (foodId) =>
      window.__lattice.call("put_node", {
        type: "preferences.food.cuisine",
        parent: foodId,
        fields: { name: "Thai", strength: 0.5 },
        author: { kind: "you" },
      }),
    food.id,
  );
  expect(await page.evaluate(() => window.__standingUpdates)).toHaveLength(0);

  // The correct current fingerprint unblocks the push.
  await page.evaluate(() => window.__lattice.setAgentFingerprints({ "agent-1": "fp-1" }));
  await page.evaluate(
    (foodId) =>
      window.__lattice.call("put_node", {
        type: "preferences.food.cuisine",
        parent: foodId,
        fields: { name: "Korean", strength: 0.9 },
        author: { kind: "you" },
      }),
    food.id,
  );
  await expect.poll(() => page.evaluate(() => window.__standingUpdates.length)).toBeGreaterThan(0);
  const updates = await page.evaluate(() => window.__standingUpdates);
  expect(updates[0].grantId).toBe(grant.id);
});

test("standing push is re-announced after a reload without an ack, and silent after an ack", async ({ page }) => {
  await page.evaluate(() => window.__lattice.createRoot());
  await page.evaluate(() => window.__lattice.open());

  const grant = await page.evaluate(() =>
    window.__lattice.call("set_grant", {
      agent_id: "agent-1",
      agent_fingerprint: "fp-1",
      rules: [{ selector: "preferences.food.cuisine.strength", mode: "auto" }],
      standing: { expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000 },
    }),
  );

  // agentFingerprints is in-memory per worker session (never persisted —
  // it's app-supplied, refreshed after grant sync), so every fresh session
  // below (the initial one and after each reload) needs its own call.
  await page.evaluate(() => window.__lattice.setAgentFingerprints({ "agent-1": "fp-1" }));

  await page.evaluate(() => {
    window.__standingUpdates = [];
    window.__lattice.onStandingUpdate((update) => window.__standingUpdates.push(update));
  });

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

  await expect.poll(() => page.evaluate(() => window.__standingUpdates.length)).toBe(1);
  const firstPush = await page.evaluate(() => window.__standingUpdates[0]);
  expect(firstPush.grantId).toBe(grant.id);
  expect(typeof firstPush.seq).toBe("number");
  expect(firstPush.facts.some((f) => f.field === "strength" && f.value === 0.8)).toBe(true);

  // --- Reload WITHOUT acking -------------------------------------------
  // No checkpoint was ever recorded for this grant, so standing_diff
  // defaults to the grant's creation seq (docs/DESIGN.md "Decided while
  // building"): the same fact is "new" again on the next flush.
  await reloadAndReconnect(page);
  await page.evaluate(() => window.__lattice.open());
  await page.evaluate(() => window.__lattice.setAgentFingerprints({ "agent-1": "fp-1" }));
  await page.evaluate(() => {
    window.__standingUpdates = [];
    window.__lattice.onStandingUpdate((update) => window.__standingUpdates.push(update));
  });

  // A write that doesn't match the grant's selector, purely to trigger a
  // flush (and therefore a pushStandingUpdates pass) after the reload.
  await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "health.condition",
      fields: { name: "Unrelated" },
      author: { kind: "you" },
    }),
  );

  await expect.poll(() => page.evaluate(() => window.__standingUpdates.length)).toBe(1);
  const reannounced = await page.evaluate(() => window.__standingUpdates[0]);
  expect(reannounced.grantId).toBe(grant.id);
  expect(reannounced.facts.some((f) => f.field === "strength" && f.value === 0.8)).toBe(true);

  // --- Ack it, then reload again ----------------------------------------
  await page.evaluate(
    ({ grantId, seq }) => window.__lattice.ackStandingUpdate(grantId, seq),
    { grantId: reannounced.grantId, seq: reannounced.seq },
  );

  await reloadAndReconnect(page);
  await page.evaluate(() => window.__lattice.open());
  await page.evaluate(() => window.__lattice.setAgentFingerprints({ "agent-1": "fp-1" }));
  await page.evaluate(() => {
    window.__standingUpdates = [];
    window.__lattice.onStandingUpdate((update) => window.__standingUpdates.push(update));
  });

  await page.evaluate(() =>
    window.__lattice.call("put_node", {
      type: "health.condition",
      fields: { name: "Another unrelated write" },
      author: { kind: "you" },
    }),
  );

  // pushStandingUpdates runs synchronously inside the same awaited flush as
  // the write above, so by the time that call resolves any push it was
  // going to send has already happened — no arbitrary wait needed to prove
  // silence, only to prove a message arrived (the `expect.poll`s above).
  const afterAck = await page.evaluate(() => window.__standingUpdates);
  expect(afterAck).toHaveLength(0);
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
