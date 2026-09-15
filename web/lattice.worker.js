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

let wasmReady = false;
let lattice = null; // the wasm `Lattice` instance, or null before/after open/close
let rootKey = null; // non-extractable HKDF CryptoKey, or null while locked
const loadedCompartments = new Set();

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
 */
async function flushPending() {
  const pending = JSON.parse(lattice.pendingCompartments());
  for (const compartment of pending) {
    const plaintext = lattice.takeFrame(compartment);
    if (plaintext.length === 0) continue;
    requireRootKey();
    const key = await deriveCompartmentKey(subtleCrypto(), rootKey, compartment);
    const frame = await encryptCompartmentFrame(subtleCrypto(), key, compartment, plaintext);
    await appendToCompartmentFile(compartment, frame);
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

async function doRestoreRoot({ raw } = {}) {
  const bytes = toUint8Array(raw);
  if (bytes.length !== 32) {
    throw { code: "bad_request", message: "restoreRoot requires exactly 32 bytes" };
  }
  const key = await importRootKey(subtleCrypto(), bytes);
  await storeRootKeyInIndexedDb(key);
  rootKey = key;
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
  await deleteCompartmentFile(compartment);
  loadedCompartments.delete(compartment);
  await flushPending(); // the DestroyCompartment marker lands in `system`
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
    version: 1,
    exportedAt: Date.now(),
    files: files.map((f) => ({ name: f.name, size: f.bytes.length })),
  };
  return { blob: encodeBackup(manifest, files) };
}

async function doImportBackup({ blob } = {}) {
  const { files } = decodeBackup(toUint8Array(blob));
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
