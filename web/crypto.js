// Pure frame-encoding and HKDF/AES-GCM helpers (docs/DESIGN.md §5, §6, and
// the worker's `encryptBlob`/`decryptBlob` extension). Every function here
// takes a `subtle` (a `SubtleCrypto`) as a parameter instead of reaching for
// a global, so this module is unit-testable under Node (`node:crypto`'s
// `webcrypto.subtle`) exactly the same way it runs inside the worker
// (`self.crypto.subtle`). No OPFS, no IndexedDB, no `postMessage` here —
// that all lives in `lattice.worker.js`, which imports this module.
//
// On-disk frame format for one compartment's file (§5): the file is a
// sequence of frames, each `[u32 LE length][12-byte nonce][ciphertext+tag]`,
// where `length` is the byte length of the nonce+ciphertext+tag that
// follows (not the plaintext length — the plaintext is never on disk).
// `encryptCompartmentFrame`/`decryptCompartmentFrames` produce/consume a
// whole file's worth of these; `takeFrame` on the wasm side hands back one
// plaintext batch per flush, so one on-disk frame == one flush.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Fixed HKDF salt for every derivation in Lattice (§6). */
export const HKDF_SALT = encoder.encode("lattice/v1");

/** AAD for a compartment frame: binds ciphertext to the compartment it's decrypted for. */
export function frameAad(compartment) {
  return encoder.encode(`lattice/v1/${compartment}`);
}

/** AAD for a named blob (Ion's `encryptBlob`/`decryptBlob`). */
export function blobAad(purpose) {
  return encoder.encode(`lattice/v1/blob/${purpose}`);
}

function lengthPrefixed(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Wrap one nonce+ciphertext pair (already concatenated) as a length-prefixed on-disk frame. */
export function encodeFrame(nonceAndCiphertext) {
  return lengthPrefixed(nonceAndCiphertext);
}

/**
 * Split a compartment file's bytes into its individual frames (each still
 * `nonce + ciphertext+tag`, length prefix stripped). Throws on a truncated
 * length or body rather than returning a partial, silently-wrong result.
 */
export function decodeFrames(bytes) {
  const frames = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      throw new Error("lattice: truncated frame length prefix");
    }
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.length) {
      throw new Error("lattice: truncated frame body");
    }
    frames.push(bytes.subarray(offset, offset + len));
    offset += len;
  }
  return frames;
}

function randomNonce() {
  return globalThis.crypto.getRandomValues(new Uint8Array(12));
}

/**
 * Import 32 raw root bytes as a non-extractable HKDF base key (§6). The raw
 * bytes themselves are never kept around after this — the caller
 * (`lattice.worker.js`) is responsible for that policy; this function is
 * just the WebCrypto call.
 */
export function importRootKey(subtle, rawBytes) {
  return subtle.importKey("raw", rawBytes, "HKDF", false, ["deriveKey"]);
}

async function deriveAesGcmKey(subtle, rootKey, info) {
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: encoder.encode(info) },
    rootKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Compartment key = HKDF-SHA256(root, salt="lattice/v1", info=compartment) -> AES-256-GCM (§6). */
export function deriveCompartmentKey(subtle, rootKey, compartment) {
  return deriveAesGcmKey(subtle, rootKey, compartment);
}

/** Blob key = HKDF-SHA256(root, salt="lattice/v1", info="blob/"+purpose) -> AES-256-GCM. */
export function deriveBlobKey(subtle, rootKey, purpose) {
  return deriveAesGcmKey(subtle, rootKey, `blob/${purpose}`);
}

/** Encrypt one plaintext batch for `compartment`, returning a ready-to-append on-disk frame. */
export async function encryptCompartmentFrame(subtle, key, compartment, plaintext) {
  const nonce = randomNonce();
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: frameAad(compartment) }, key, plaintext),
  );
  return encodeFrame(concatBytes([nonce, ciphertext]));
}

/** Decrypt every frame in a compartment file's bytes, returning one plaintext Uint8Array per frame, in file order. */
export async function decryptCompartmentFrames(subtle, key, compartment, fileBytes) {
  const frames = decodeFrames(fileBytes);
  const plaintexts = [];
  for (const frame of frames) {
    const nonce = frame.subarray(0, 12);
    const ciphertext = frame.subarray(12);
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: frameAad(compartment) },
      key,
      ciphertext,
    );
    plaintexts.push(new Uint8Array(plaintext));
  }
  return plaintexts;
}

/** Encrypt an opaque blob under a purpose-scoped key. Output is `nonce || ciphertext+tag` (no length prefix: callers hold one blob, not a concatenated file). */
export async function encryptBlob(subtle, key, purpose, plaintext) {
  const nonce = randomNonce();
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: blobAad(purpose) }, key, plaintext),
  );
  return concatBytes([nonce, ciphertext]);
}

/** Decrypt a blob produced by `encryptBlob`. */
export async function decryptBlob(subtle, key, purpose, bytes) {
  const nonce = bytes.subarray(0, 12);
  const ciphertext = bytes.subarray(12);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: blobAad(purpose) },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

/**
 * Backup packaging (`exportBackup`/`importBackup`, §9): a small JSON
 * manifest followed by each compartment file's bytes, each length-prefixed.
 * Every byte here is already ciphertext (a compartment file) — this module
 * never sees a root key or plaintext to build one.
 */
export function encodeBackup(manifest, files) {
  const parts = [lengthPrefixed(encoder.encode(JSON.stringify(manifest)))];
  for (const file of files) {
    parts.push(lengthPrefixed(file.bytes));
  }
  return concatBytes(parts);
}

/**
 * Reverses `encodeBackup`, validating the byte layout is fully
 * self-consistent (review #8's structural half — the worker adds the
 * semantic checks, manifest version and known-compartment names, since
 * those need the schema): every declared file block must actually be
 * present at full length, and no bytes may be left over once every declared
 * file has been read. A short manifest that undercounts its own files used
 * to silently drop the trailing ones instead of failing import outright.
 */
export function decodeBackup(bytes) {
  if (bytes.length < 4) {
    throw new Error("lattice: backup is too short to contain a manifest");
  }
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const manifestLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + manifestLen > bytes.length) {
    throw new Error("lattice: truncated backup manifest");
  }
  const manifestBytes = bytes.subarray(offset, offset + manifestLen);
  offset += manifestLen;

  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
  } catch (e) {
    throw new Error(`lattice: backup manifest is not valid JSON: ${e.message}`);
  }
  if (typeof manifest !== "object" || manifest === null || !Array.isArray(manifest.files)) {
    throw new Error("lattice: backup manifest has no files array");
  }

  const files = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.name !== "string" || entry.name.length === 0) {
      throw new Error("lattice: backup manifest has a file entry with no name");
    }
    if (offset + 4 > bytes.length) {
      throw new Error(`lattice: backup is missing the file block for "${entry.name}"`);
    }
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.length) {
      throw new Error(`lattice: backup's file block for "${entry.name}" is truncated`);
    }
    const fileBytes = bytes.subarray(offset, offset + len);
    offset += len;
    files.push({ name: entry.name, bytes: fileBytes });
  }

  if (offset !== bytes.length) {
    throw new Error("lattice: backup has trailing bytes the manifest doesn't account for");
  }

  return { manifest, files };
}
