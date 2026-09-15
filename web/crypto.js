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

/**
 * Like `decodeFrames`, but tolerant of a truncated TRAILING frame (review
 * S9): returns every complete frame plus `truncatedAt` (the byte offset
 * right after the last complete frame) instead of throwing when the last
 * one is partial. Frames are only ever appended, never inserted or edited
 * in place, so under normal operation a truncation can only physically
 * occur at the very end of the file (a write interrupted mid-flush); this
 * is deliberately permissive on that assumption, for `open()`'s recovery
 * path specifically. `decodeFrames` (strict) is still what every other
 * caller should use.
 */
export function decodeFramesTolerant(bytes) {
  const frames = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) {
      return { frames, truncatedAt: offset };
    }
    const len = view.getUint32(offset, true);
    const bodyStart = offset + 4;
    if (bodyStart + len > bytes.length) {
      return { frames, truncatedAt: offset };
    }
    frames.push(bytes.subarray(bodyStart, bodyStart + len));
    offset = bodyStart + len;
  }
  return { frames, truncatedAt: null };
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

/**
 * Like `decryptCompartmentFrames`, but built on `decodeFramesTolerant`
 * (review S9): returns `{plaintexts, truncatedAt}` instead of throwing when
 * the file ends in a partial frame, so `open()` can drop just that trailing
 * frame (and truncate the on-disk file to match) instead of failing the
 * whole compartment.
 */
export async function decryptCompartmentFramesTolerant(subtle, key, compartment, fileBytes) {
  const { frames, truncatedAt } = decodeFramesTolerant(fileBytes);
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
  return { plaintexts, truncatedAt };
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

const BACKUP_PAD_BLOCK = 4096;

/**
 * Pad `bytes` to a multiple of `blockSize` with a 4-byte LE true-length
 * prefix embedded inside the padded block itself, so the exact original
 * bytes come back from `unpadBlock` while the padded block's own length is
 * always a round multiple of `blockSize` (review B5: without this, the
 * backup blob's per-compartment section lengths reveal each compartment's
 * exact byte size to the server; padding coarsens that to 4 KB buckets).
 */
function padBlock(bytes, blockSize = BACKUP_PAD_BLOCK) {
  const withLen = concatBytes([uint32LE(bytes.length), bytes]);
  const total = Math.ceil(withLen.length / blockSize) * blockSize;
  const padded = new Uint8Array(total); // zero-filled tail
  padded.set(withLen, 0);
  return padded;
}

function uint32LE(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** Reverses `padBlock`: reads the embedded true length and returns exactly the original bytes, ignoring the zero-fill tail. */
function unpadBlock(padded) {
  if (padded.length < 4) {
    throw new Error("lattice: padded backup block is too short to contain a length prefix");
  }
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const len = view.getUint32(0, true);
  if (4 + len > padded.length) {
    throw new Error("lattice: padded backup block's embedded length exceeds the block itself");
  }
  return padded.subarray(4, 4 + len);
}

/**
 * Backup packaging (`exportBackup`/`importBackup`, §9). The manifest (which
 * names every compartment and its size) is itself encrypted as a blob under
 * `manifestKey` (`deriveBlobKey(root, "backup-manifest")` — review B5: the
 * server holding the backup row must not learn which compartments exist or
 * how large each is, and a plaintext manifest at offset zero told it both).
 * Each compartment's ciphertext is padded to a 4 KB block before being
 * length-prefixed, so the wire-visible section lengths only ever reveal a
 * coarse (4 KB-bucketed) size, never the exact one. Every compartment byte
 * here is already ciphertext from its own AES-256-GCM frame — this only
 * adds a second, independent encryption layer around the *inventory*
 * (names/sizes), not the facts themselves.
 */
export async function encodeBackup(subtle, manifestKey, manifest, files) {
  const encryptedManifest = await encryptBlob(
    subtle,
    manifestKey,
    "backup-manifest",
    encoder.encode(JSON.stringify(manifest)),
  );
  const parts = [lengthPrefixed(encryptedManifest)];
  for (const file of files) {
    parts.push(lengthPrefixed(padBlock(file.bytes)));
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
export async function decodeBackup(subtle, manifestKey, bytes) {
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
  const encryptedManifest = bytes.subarray(offset, offset + manifestLen);
  offset += manifestLen;

  let manifest;
  try {
    const manifestPlaintext = await decryptBlob(subtle, manifestKey, "backup-manifest", encryptedManifest);
    manifest = JSON.parse(decoder.decode(manifestPlaintext));
  } catch (e) {
    throw new Error(`lattice: backup manifest failed to decrypt or parse: ${e.message}`);
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
    const paddedBytes = bytes.subarray(offset, offset + len);
    offset += len;
    files.push({ name: entry.name, bytes: unpadBlock(paddedBytes) });
  }

  if (offset !== bytes.length) {
    throw new Error("lattice: backup has trailing bytes the manifest doesn't account for");
  }

  return { manifest, files };
}
