// The Lattice worker (docs/DESIGN.md §6, §9). Owns OPFS, IndexedDB and
// WebCrypto; the wasm module never sees ciphertext or keys, only plaintext
// bytes handed to it via `loadFrame`/`takeFrame`. ES module, no imports
// outside `web/` and `./pkg` (the wasm-bindgen output built by
// scripts/build-wasm.sh). No top-level await: wasm is initialized lazily,
// inside the `open` handler, because that's the first message that carries
// `wasmUrl` — `await` inside a handler is fine, a module-level `await init(...)`
// at import time is not used here on purpose.

import init, { Lattice } from "./pkg/lattice_wasm.js";
import {
  importRootKey,
  deriveCompartmentKey,
  deriveBlobKey,
  encryptCompartmentFrame,
  decryptCompartmentFrames,
  encryptBlob as encryptBlobBytes,
  decryptBlob as decryptBlobBytes,
  encodeBackup,
  decodeBackup,
} from "./crypto.js";

const DB_NAME = "lattice-keys";
const STORE_NAME = "keys";
const ROOT_KEY_ID = "root";
const OPFS_DIR = ["lattice", "v1"];

const BACKUP_VERSION = 1;

let wasmReady = false;
let lattice = null; // the wasm `Lattice` instance, or null before/after open/close
let rootKey = null; // non-extractable HKDF CryptoKey, or null while locked
let cachedSchema = null; // schemaJson() is static per build; cached once so importBackup can validate compartment names even after close()
const loadedCompartments = new Set();
const lastPushedSeq = new Map(); // grantId -> highest seq already pushed via a standing update, this worker session only

// --------------------------------------------------------------- plumbing

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function subtleCrypto() {
  return crypto.subtle;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw { code: "bad_request", message: "expected bytes (Uint8Array/ArrayBuffer/Array)" };
}

function requireLattice() {
  if (!lattice) {
    throw { code: "not_open", message: "call open() before using the lattice" };
  }
  return lattice;
}

function requireRootKey() {
  if (!rootKey) {
    throw { code: "locked", message: "no root key: call createRoot() or restoreRoot() first" };
  }
  return rootKey;
}

/**
 * The static schema (compartments/types/links), cached once. Reused by
 * `importBackup`'s validation (review #8) even when `lattice` is currently
 * null (e.g. right after `close()`, which the backup-restore flow uses
 * deliberately to force a genuine read-from-disk on the next `open()`): a
 * throwaway `Lattice` is spun up only for this, since `schemaJson()` never
 * depends on a store's contents, and wasm-bindgen's own finalizer reclaims
 * it once GC'd even though nothing calls `.free()` on it explicitly.
 */
function requireSchema() {
  if (cachedSchema) return cachedSchema;
  if (!wasmReady) {
    throw { code: "not_open", message: "call open() before this" };
  }
  const source = lattice ?? new Lattice();
  cachedSchema = JSON.parse(source.schemaJson());
  return cachedSchema;
}

/** Parse the JSON string `lattice.call(op, argsJson)` returns and throw its `error`, or return its `ok` value. */
function unwrapCallResult(resultJson) {
  const parsed = JSON.parse(resultJson);
  if (parsed.error) {
    throw parsed.error;
  }
  return parsed.ok;
}

// -------------------------------------------------------------- IndexedDB

function openKeysDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeRootKeyInIndexedDb(key) {
  const db = await openKeysDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(key, ROOT_KEY_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function loadRootKeyFromIndexedDb() {
  const db = await openKeysDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(ROOT_KEY_ID);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------- OPFS

async function compartmentsDir() {
  let dir = await navigator.storage.getDirectory();
  for (const segment of OPFS_DIR) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

function fileNameFor(compartment) {
  return `${compartment}.frames`;
}

/** Every byte ever written for `compartment`, or a zero-length array if the file doesn't exist yet. */
async function readCompartmentFile(compartment) {
  const dir = await compartmentsDir();
  let handle;
  try {
    handle = await dir.getFileHandle(fileNameFor(compartment));
  } catch (e) {
    if (e && e.name === "NotFoundError") return new Uint8Array(0);
    throw e;
  }
  const access = await handle.createSyncAccessHandle();
  try {
    const size = access.getSize();
    const buf = new Uint8Array(size);
    access.read(buf, { at: 0 });
    return buf;
  } finally {
    access.close();
  }
}

/** Append one already-encrypted frame to `compartment`'s file. */
async function appendToCompartmentFile(compartment, frameBytes) {
  const dir = await compartmentsDir();
  const handle = await dir.getFileHandle(fileNameFor(compartment), { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    const size = access.getSize();
    access.write(frameBytes, { at: size });
    access.flush();
  } finally {
    access.close();
  }
}

/** Overwrite `compartment`'s file wholesale (used by `importBackup`; the bytes are still ciphertext, never decrypted here). */
async function writeWholeCompartmentFile(compartment, bytes) {
  const dir = await compartmentsDir();
  const handle = await dir.getFileHandle(fileNameFor(compartment), { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

async function deleteCompartmentFile(compartment) {
  const dir = await compartmentsDir();
  try {
    await dir.removeEntry(fileNameFor(compartment));
  } catch (e) {
    if (!(e && e.name === "NotFoundError")) throw e;
  }
}

/**
 * Encrypt and append every compartment the store has unflushed writes for.
 * Called after every mutating `call`, before replying, so a caller's
 * `await` means "on disk" (§5).
 *
 * `takeFrame` is destructive (review #3): if the encrypt+append for a
 * compartment fails partway (OPFS quota, a `createSyncAccessHandle`
 * conflict from an overlapping flush on the same compartment, ...), the
 * plaintext is handed back to `restoreFrame(compartment, bytes)`, which
 * re-queues it ahead of anything written since — never lost, and picked up
 * by the next successful flush attempt for that compartment. The caller
 * gets a typed `flush_failed` error rather than a silent success, so it
 * knows the write it just made is not yet durable.
 */
async function flushPending() {
  const pending = JSON.parse(lattice.pendingCompartments());
  if (pending.length === 0) return;
  // Fail fast, before any destructive takeFrame, if we can't possibly
  // encrypt anything — nothing to restore because nothing was taken.
  requireRootKey();

  let flushedAny = false;
  for (const compartment of pending) {
    const plaintext = lattice.takeFrame(compartment);
    if (plaintext.length === 0) continue;
    try {
      const key = await deriveCompartmentKey(subtleCrypto(), rootKey, compartment);
      const frame = await encryptCompartmentFrame(subtleCrypto(), key, compartment, plaintext);
      await appendToCompartmentFile(compartment, frame);
      flushedAny = true;
    } catch (e) {
      lattice.restoreFrame(compartment, plaintext);
      throw {
        code: "flush_failed",
        message: `failed to flush compartment "${compartment}": ${e && e.message ? e.message : String(e)}`,
      };
    }
  }

  if (flushedAny) {
    await pushStandingUpdates();
  }
}

/**
 * DESIGN.md §7: "The worker calls [standing_diff] after every flush and the
 * app sends the push." This is the worker's half: for every non-revoked,
 * non-expired standing grant, ask the store what changed since the last
 * push and — if anything did — advance the watermark and tell the main
 * thread via an unsolicited `{type: "standingUpdate"}` message (no request
 * `id`; see web/lattice.js's `onStandingUpdate`). Sending the push itself is
 * the app's job (salt-fe, phase 2) and is out of scope here.
 *
 * The watermark (`lastPushedSeq`) is in-memory only, for this worker
 * session: there is no persisted "last pushed seq" record in phase 1, so a
 * fresh session (page reload) starts every grant back at seq 0 and may
 * re-announce facts it already pushed before the reload. That's a known
 * phase-1 gap, not silently swallowed — flagged here rather than solved,
 * since fixing it means a new persisted record type, which is
 * crates/lattice-core's call, not this worker's.
 *
 * Best-effort: never throws. A standing-push failure must not fail the
 * caller's own write, which already succeeded and is durable by the time
 * this runs.
 */
async function pushStandingUpdates() {
  if (!lattice) return;
  try {
    const grantsResult = JSON.parse(lattice.call("list_grants", "{}"));
    if (grantsResult.error) return;
    const grants = grantsResult.ok;
    if (!grants || grants.length === 0) return;

    const statsResult = JSON.parse(lattice.call("stats", "{}"));
    const currentSeq = statsResult.ok ? statsResult.ok.seq : null;
    const nowMs = Date.now();

    for (const grant of grants) {
      if (grant.revoked || !grant.standing) continue;
      if (grant.standing.expires_at && grant.standing.expires_at < nowMs) continue;

      const sinceSeq = lastPushedSeq.get(grant.id) ?? 0;
      const diffResult = JSON.parse(
        lattice.call("standing_diff", JSON.stringify({ grant_id: grant.id, since_seq: sinceSeq })),
      );
      if (diffResult.error) continue;
      const facts = diffResult.ok;
      if (!facts || facts.length === 0) continue;

      if (currentSeq !== null) {
        lastPushedSeq.set(grant.id, currentSeq);
      }
      self.postMessage({ type: "standingUpdate", grantId: grant.id, facts });
    }
  } catch {
    // Best-effort — see doc comment above.
  }
}

// -------------------------------------------------------------------- ops

async function doOpen({ wasmUrl, compartments } = {}) {
  // Wall-clock time for the whole op, message-in to reply-out: IO (OPFS
  // reads), AES-GCM decrypt, loadFrame and finishOpen — everything a phone
  // actually waits for. Recorded alongside `loadMs` (the wasm-only number
  // below, which excludes IO/decrypt on purpose) so docs/GATES.md reports
  // both what the store itself costs and what opening genuinely feels like.
  const wallStart = now();

  if (!wasmReady) {
    if (!wasmUrl) {
      throw { code: "bad_request", message: "open requires wasmUrl on its first call" };
    }
    await init({ module_or_path: wasmUrl });
    wasmReady = true;
  }
  if (!lattice) {
    lattice = new Lattice();
  }
  if (!rootKey) {
    rootKey = await loadRootKeyFromIndexedDb();
  }

  const schema = JSON.parse(lattice.schemaJson());
  cachedSchema = schema;
  const targets = compartments ?? schema.compartments;

  const timings = {};
  if (rootKey) {
    // Read + decrypt every target compartment FIRST, entirely outside the
    // timed window: the gate (§5) measures the store's own open cost (first
    // `loadFrame` -> `finishOpen` returning), not OPFS/WebCrypto latency. An
    // earlier version interleaved read/decrypt/loadFrame per compartment in
    // one loop, which meant every compartment after the first had its
    // OPFS+AES-GCM time counted inside the "load" measurement — on this
    // machine that alone was the difference between a passing and a
    // failing WebKit number (see docs/GATES.md).
    const decoded = [];
    for (const compartment of targets) {
      const fileBytes = await readCompartmentFile(compartment);
      if (fileBytes.length > 0) {
        const key = await deriveCompartmentKey(subtleCrypto(), rootKey, compartment);
        const frames = await decryptCompartmentFrames(subtleCrypto(), key, compartment, fileBytes);
        decoded.push({ compartment, frames });
      }
      loadedCompartments.add(compartment);
    }

    let firstLoadAt = null;
    for (const { compartment, frames } of decoded) {
      for (const plaintext of frames) {
        if (firstLoadAt === null) firstLoadAt = now();
        lattice.loadFrame(compartment, plaintext);
      }
    }
    lattice.finishOpen();
    if (firstLoadAt !== null) {
      timings.loadMs = now() - firstLoadAt;
    }
  }

  let persisted = null;
  if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) {
    persisted = await navigator.storage.persist();
  }

  timings.wallMs = now() - wallStart;

  return {
    hasRoot: !!rootKey,
    loadedCompartments: [...loadedCompartments],
    timings,
    persisted,
  };
}

function doClose() {
  if (lattice) {
    lattice.free();
    lattice = null;
  }
  rootKey = null;
  loadedCompartments.clear();
  return { closed: true };
}

async function doCreateRoot() {
  const existing = rootKey ?? (await loadRootKeyFromIndexedDb());
  if (existing) {
    throw { code: "root_exists", message: "a root key already exists; call restoreRoot to replace it" };
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await importRootKey(subtleCrypto(), raw);
  await storeRootKeyInIndexedDb(key);
  rootKey = key;
  return { raw };
}

async function doRestoreRoot({ raw, force } = {}) {
  const bytes = toUint8Array(raw);
  if (bytes.length !== 32) {
    throw { code: "bad_request", message: "restoreRoot requires exactly 32 bytes" };
  }
  // Mirror createRoot's guard (review #2): restoreRoot is documented as
  // being for a genuinely key-less device. Overwriting an active root
  // silently and irreversibly discards the current non-extractable key —
  // there is no way to recover it — and if any writes are still unflushed
  // at that moment, the next flush would encrypt them under the NEW root
  // and append them to a file whose earlier frames are under the OLD root,
  // producing a file that can never be fully decrypted with a single key.
  const existing = rootKey ?? (await loadRootKeyFromIndexedDb());
  if (existing && !force) {
    throw {
      code: "root_exists",
      message: "a root key already exists; pass { force: true } to replace it (only for a genuinely key-less device)",
    };
  }
  const key = await importRootKey(subtleCrypto(), bytes);
  await storeRootKeyInIndexedDb(key);
  rootKey = key;
  if (force) {
    // Drop the wasm instance entirely so the caller must re-`open()`: a
    // fresh Lattice has no pending writes that could otherwise get
    // mis-encrypted under the new root on the next flush (see above).
    // Whatever was unflushed under the old root is lost either way — it
    // was never promised as durable (§5's "await means on disk" invariant
    // only covers what actually reached a successful flush).
    if (lattice) {
      lattice.free();
      lattice = null;
    }
    loadedCompartments.clear();
  }
  return { restored: true };
}

async function doHasRoot() {
  if (!rootKey) {
    rootKey = await loadRootKeyFromIndexedDb();
  }
  return { hasRoot: !!rootKey };
}

async function doCall({ op, args } = {}) {
  const lat = requireLattice();
  const resultJson = lat.call(op, JSON.stringify(args ?? {}));
  const result = unwrapCallResult(resultJson);
  await flushPending();
  return result;
}

async function doDestroyCompartment({ compartment } = {}) {
  const lat = requireLattice();
  const resultJson = lat.call("destroy_compartment", JSON.stringify({ compartment }));
  const result = unwrapCallResult(resultJson);
  // Persist the `system` DestroyCompartment marker BEFORE deleting the
  // compartment's file (review #7). A crash between these two steps then
  // leaves an inert leftover file that next `open()` still refuses to load
  // (shielded by the now-durable marker), instead of the other order's
  // failure mode: an unmarked file that a later `importBackup` of an older
  // snapshot could resurrect as if it were never destroyed. If the flush
  // itself fails, this throws (flush_failed) and the file is correctly
  // left in place rather than deleted out from under an unpersisted marker.
  await flushPending();
  await deleteCompartmentFile(compartment);
  loadedCompartments.delete(compartment);
  return result;
}

async function doExportBackup() {
  const lat = requireLattice();
  const schema = JSON.parse(lat.schemaJson());
  const files = [];
  for (const compartment of schema.compartments) {
    const bytes = await readCompartmentFile(compartment);
    if (bytes.length > 0) {
      files.push({ name: compartment, bytes });
    }
  }
  const manifest = {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    files: files.map((f) => ({ name: f.name, size: f.bytes.length })),
  };
  return { blob: encodeBackup(manifest, files) };
}

async function doImportBackup({ blob } = {}) {
  // decodeBackup already validates byte-level structure (truncated/trailing
  // data); this adds the semantic checks review #8 found missing:
  // manifest version, and that every named file is a real compartment. Not
  // a confidentiality issue either way (AEAD's AAD and the HKDF `info` are
  // both bound to the true compartment name, so a mislabeled file just
  // fails to decrypt later at open() rather than leaking anything) — this
  // is about failing clearly and immediately instead of cryptically later.
  const { manifest, files } = decodeBackup(toUint8Array(blob));
  if (manifest.version !== BACKUP_VERSION) {
    throw {
      code: "invalid_backup",
      message: `unsupported backup version ${manifest.version} (expected ${BACKUP_VERSION})`,
    };
  }
  const validCompartments = new Set(requireSchema().compartments);
  for (const file of files) {
    if (!validCompartments.has(file.name)) {
      throw { code: "invalid_backup", message: `backup names an unknown compartment "${file.name}"` };
    }
  }
  for (const file of files) {
    await writeWholeCompartmentFile(file.name, file.bytes);
  }
  loadedCompartments.clear(); // caller must re-`open` the restored compartments to read them back
  return { restored: files.map((f) => f.name) };
}

async function doEncryptBlob({ purpose, bytes } = {}) {
  requireRootKey();
  const key = await deriveBlobKey(subtleCrypto(), rootKey, purpose);
  const out = await encryptBlobBytes(subtleCrypto(), key, purpose, toUint8Array(bytes));
  return { bytes: out };
}

async function doDecryptBlob({ purpose, bytes } = {}) {
  requireRootKey();
  const key = await deriveBlobKey(subtleCrypto(), rootKey, purpose);
  const out = await decryptBlobBytes(subtleCrypto(), key, purpose, toUint8Array(bytes));
  return { bytes: out };
}

// --------------------------------------------------------------- dispatch

async function handleOp(op, args) {
  switch (op) {
    case "open":
      return doOpen(args);
    case "close":
      return doClose();
    case "createRoot":
      return doCreateRoot();
    case "restoreRoot":
      return doRestoreRoot(args);
    case "hasRoot":
      return doHasRoot();
    case "destroyCompartment":
      return doDestroyCompartment(args);
    case "exportBackup":
      return doExportBackup();
    case "importBackup":
      return doImportBackup(args);
    case "stats":
      return doCall({ op: "stats", args: {} });
    case "call":
      return doCall(args);
    case "encryptBlob":
      return doEncryptBlob(args);
    case "decryptBlob":
      return doDecryptBlob(args);
    default:
      throw { code: "unknown_op", message: `no such worker op: ${op}` };
  }
}

function toWireError(err) {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return { code: String(err.code), message: String(err.message) };
  }
  // A `Result<(), JsValue>` from lattice-wasm throws its `Err` value as-is;
  // `to_js_error` in crates/lattice-wasm encodes it as a `{code,message}`
  // JSON string, so recover the structured shape here too.
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err);
      if (parsed && parsed.code && parsed.message) return parsed;
    } catch {
      // not JSON — fall through to the generic string case below
    }
    return { code: "error", message: err };
  }
  return { code: "error", message: (err && err.message) || String(err) };
}

self.onmessage = async (event) => {
  const { id, op, args } = event.data;
  try {
    const result = await handleOp(op, args);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: toWireError(err) });
  }
};
