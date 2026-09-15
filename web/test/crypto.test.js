// Pure crypto/frame helpers (web/crypto.js), exercised against Node's
// WebCrypto so this suite needs no wasm and no browser (docs/DESIGN.md §10).
import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import {
  concatBytes,
  encodeFrame,
  decodeFrames,
  decodeFramesTolerant,
  importRootKey,
  deriveCompartmentKey,
  deriveBlobKey,
  encryptCompartmentFrame,
  decryptCompartmentFrames,
  encryptBlob,
  decryptBlob,
  encodeBackup,
  decodeBackup,
} from "../crypto.js";

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomRoot() {
  return webcrypto.getRandomValues(new Uint8Array(32));
}

describe("frame encode/decode", () => {
  it("round-trips a single frame", () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const [decoded] = decodeFrames(encodeFrame(body));
    expect(Array.from(decoded)).toEqual(Array.from(body));
  });

  it("round-trips multiple frames concatenated as one file", () => {
    const a = encodeFrame(new Uint8Array([1, 2, 3]));
    const b = encodeFrame(new Uint8Array([9, 9]));
    const frames = decodeFrames(concatBytes([a, b]));
    expect(frames.length).toBe(2);
    expect(Array.from(frames[0])).toEqual([1, 2, 3]);
    expect(Array.from(frames[1])).toEqual([9, 9]);
  });

  it("handles an empty file as zero frames", () => {
    expect(decodeFrames(new Uint8Array(0))).toEqual([]);
  });

  it("throws on a truncated length prefix", () => {
    expect(() => decodeFrames(new Uint8Array([1, 2]))).toThrow();
  });

  it("throws on a truncated frame body", () => {
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint32(0, 10, true);
    expect(() => decodeFrames(bad)).toThrow();
  });
});

describe("HKDF/AES-GCM compartment keys", () => {
  it("derives an AES-256-GCM key from a root key", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const key = await deriveCompartmentKey(subtle, root, "preferences");
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.algorithm.length).toBe(256);
    expect(key.extractable).toBe(false);
  });

  it("encrypts and decrypts a compartment frame round trip", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const key = await deriveCompartmentKey(subtle, root, "preferences");
    const plaintext = encoder.encode('{"hello":"world"}\n');
    const frame = await encryptCompartmentFrame(subtle, key, "preferences", plaintext);
    const [decrypted] = await decryptCompartmentFrames(subtle, key, "preferences", frame);
    expect(decoder.decode(decrypted)).toBe('{"hello":"world"}\n');
  });

  it("concatenates multiple flushes into one file and decrypts each frame in order", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const key = await deriveCompartmentKey(subtle, root, "preferences");
    const frame1 = await encryptCompartmentFrame(subtle, key, "preferences", encoder.encode("one"));
    const frame2 = await encryptCompartmentFrame(subtle, key, "preferences", encoder.encode("two"));
    const plaintexts = await decryptCompartmentFrames(subtle, key, "preferences", concatBytes([frame1, frame2]));
    expect(plaintexts.map((p) => decoder.decode(p))).toEqual(["one", "two"]);
  });

  it("refuses to decrypt under the wrong compartment's AAD", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const key = await deriveCompartmentKey(subtle, root, "preferences");
    const frame = await encryptCompartmentFrame(subtle, key, "preferences", encoder.encode("secret"));
    await expect(decryptCompartmentFrames(subtle, key, "health", frame)).rejects.toThrow();
  });

  it("refuses to decrypt with a different root's derived key", async () => {
    const rootA = await importRootKey(subtle, randomRoot());
    const rootB = await importRootKey(subtle, randomRoot());
    const keyA = await deriveCompartmentKey(subtle, rootA, "preferences");
    const keyB = await deriveCompartmentKey(subtle, rootB, "preferences");
    const frame = await encryptCompartmentFrame(subtle, keyA, "preferences", encoder.encode("secret"));
    await expect(decryptCompartmentFrames(subtle, keyB, "preferences", frame)).rejects.toThrow();
  });
});

describe("blob encrypt/decrypt (Ion's purpose-scoped blobs)", () => {
  it("round-trips a named blob", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const key = await deriveBlobKey(subtle, root, "embedding");
    const plaintext = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptBlob(subtle, key, "embedding", plaintext);
    const decrypted = await decryptBlob(subtle, key, "embedding", encrypted);
    expect(Array.from(decrypted)).toEqual([10, 20, 30]);
  });

  it("refuses to decrypt under the wrong purpose's AAD", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const key = await deriveBlobKey(subtle, root, "embedding");
    const encrypted = await encryptBlob(subtle, key, "embedding", new Uint8Array([1]));
    await expect(decryptBlob(subtle, key, "other", encrypted)).rejects.toThrow();
  });

  it("derives different keys for different purposes", async () => {
    const root = await importRootKey(subtle, randomRoot());
    const keyA = await deriveBlobKey(subtle, root, "embedding");
    const keyB = await deriveBlobKey(subtle, root, "diagnostics");
    const encrypted = await encryptBlob(subtle, keyA, "embedding", new Uint8Array([1, 2, 3]));
    // Same AAD purpose string, different derived key -> still refused.
    await expect(decryptBlob(subtle, keyB, "embedding", encrypted)).rejects.toThrow();
  });
});

describe("backup packaging", () => {
  async function manifestKey() {
    const root = await importRootKey(subtle, randomRoot());
    return deriveBlobKey(subtle, root, "backup-manifest");
  }

  it("round-trips a manifest and its files", async () => {
    const key = await manifestKey();
    const files = [
      { name: "identity", bytes: new Uint8Array([1, 2, 3]) },
      { name: "preferences", bytes: new Uint8Array([4, 5]) },
    ];
    const manifest = {
      version: 1,
      exportedAt: 123,
      files: files.map((f) => ({ name: f.name, size: f.bytes.length })),
    };
    const blob = await encodeBackup(subtle, key, manifest, files);
    const decoded = await decodeBackup(subtle, key, blob);
    expect(decoded.manifest.version).toBe(1);
    expect(decoded.files.map((f) => f.name)).toEqual(["identity", "preferences"]);
    expect(Array.from(decoded.files[0].bytes)).toEqual([1, 2, 3]);
    expect(Array.from(decoded.files[1].bytes)).toEqual([4, 5]);
  });

  it("round-trips an empty backup (no compartments written yet)", async () => {
    const key = await manifestKey();
    const manifest = { version: 1, exportedAt: 1, files: [] };
    const decoded = await decodeBackup(subtle, key, await encodeBackup(subtle, key, manifest, []));
    expect(decoded.files).toEqual([]);
  });

  // Review B5: the manifest (compartment names and sizes) is now encrypted
  // under its own purpose-scoped key, and each compartment's ciphertext is
  // padded to a 4 KB block — the server holding this backup must not learn
  // which compartments exist or their exact sizes.
  it("does not leak the compartment name in the encoded bytes", async () => {
    const key = await manifestKey();
    const manifest = { version: 1, files: [{ name: "health", size: 3 }] };
    const blob = await encodeBackup(subtle, key, manifest, [{ name: "health", bytes: new Uint8Array([1, 2, 3]) }]);
    // Scan the raw bytes as latin1 text: the name must not appear anywhere.
    const asText = Buffer.from(blob).toString("latin1");
    expect(asText).not.toContain("health");
  });

  it("pads every compartment's on-wire section to a 4 KB multiple regardless of its true size", async () => {
    const key = await manifestKey();
    const manifest = { version: 1, files: [{ name: "identity", size: 3 }] };
    const blob = await encodeBackup(subtle, key, manifest, [{ name: "identity", bytes: new Uint8Array([1, 2, 3]) }]);

    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const manifestLen = view.getUint32(0, true);
    const fileBlockLen = view.getUint32(4 + manifestLen, true);
    expect(fileBlockLen % 4096).toBe(0);
    expect(fileBlockLen).toBeGreaterThan(0);
  });

  it("a different manifest key fails to decrypt (each backup's manifest is bound to its own root)", async () => {
    const key = await manifestKey();
    const otherKey = await manifestKey();
    const manifest = { version: 1, files: [] };
    const blob = await encodeBackup(subtle, key, manifest, []);
    await expect(decodeBackup(subtle, otherKey, blob)).rejects.toThrow(/failed to decrypt/);
  });

  // Review #8: decodeBackup used to trust the manifest's declared file
  // count outright, so a short manifest silently dropped trailing files
  // instead of failing import outright.
  it("refuses a manifest that undercounts its own files (trailing bytes left over)", async () => {
    const key = await manifestKey();
    const files = [
      { name: "identity", bytes: new Uint8Array([1, 2, 3]) },
      { name: "preferences", bytes: new Uint8Array([4, 5]) },
    ];
    // Manifest only lists the first file, but both files' bytes are present.
    const manifest = { version: 1, exportedAt: 1, files: [{ name: "identity", size: 3 }] };
    const blob = await encodeBackup(subtle, key, manifest, files);
    await expect(decodeBackup(subtle, key, blob)).rejects.toThrow(/trailing bytes/);
  });

  it("refuses a manifest whose declared file block is missing (overcounts its own files)", async () => {
    const key = await manifestKey();
    const manifest = {
      version: 1,
      exportedAt: 1,
      files: [{ name: "identity", size: 3 }, { name: "preferences", size: 5 }],
    };
    // Only one file's bytes actually follow the manifest.
    const blob = await encodeBackup(subtle, key, manifest, [{ name: "identity", bytes: new Uint8Array([1, 2, 3]) }]);
    await expect(decodeBackup(subtle, key, blob)).rejects.toThrow(/missing the file block/);
  });

  it("refuses a manifest with no files array", async () => {
    const key = await manifestKey();
    const blob = await encodeBackup(subtle, key, { version: 1 }, []);
    await expect(decodeBackup(subtle, key, blob)).rejects.toThrow(/no files array/);
  });

  it("refuses a manifest with an unnamed file entry", async () => {
    const key = await manifestKey();
    const manifest = { version: 1, files: [{ size: 3 }] };
    const blob = await encodeBackup(subtle, key, manifest, [{ name: "whatever", bytes: new Uint8Array([1, 2, 3]) }]);
    await expect(decodeBackup(subtle, key, blob)).rejects.toThrow(/no name/);
  });

  it("refuses bytes too short to contain a manifest at all", async () => {
    const key = await manifestKey();
    await expect(decodeBackup(subtle, key, new Uint8Array([1, 2]))).rejects.toThrow(/too short/);
  });

  it("refuses a truncated manifest length prefix", async () => {
    const key = await manifestKey();
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint32(0, 1000, true); // claims a 1000-byte manifest that isn't there
    await expect(decodeBackup(subtle, key, bad)).rejects.toThrow(/truncated backup manifest/);
  });
});

describe("decodeFramesTolerant (review S9)", () => {
  it("returns every complete frame and no truncation point for a well-formed file", () => {
    const a = encodeFrame(new Uint8Array([1, 2, 3]));
    const b = encodeFrame(new Uint8Array([9, 9]));
    const { frames, truncatedAt } = decodeFramesTolerant(concatBytes([a, b]));
    expect(frames.map((f) => Array.from(f))).toEqual([[1, 2, 3], [9, 9]]);
    expect(truncatedAt).toBeNull();
  });

  it("drops a truncated trailing frame and reports where the good data ends", () => {
    const good = encodeFrame(new Uint8Array([1, 2, 3]));
    const partial = encodeFrame(new Uint8Array([9, 9, 9, 9])).subarray(0, 5); // length prefix + a few body bytes, cut short
    const { frames, truncatedAt } = decodeFramesTolerant(concatBytes([good, partial]));
    expect(frames.map((f) => Array.from(f))).toEqual([[1, 2, 3]]);
    expect(truncatedAt).toBe(good.length);
  });

  it("reports truncatedAt 0 when even the first frame's length prefix is incomplete", () => {
    const { frames, truncatedAt } = decodeFramesTolerant(new Uint8Array([1, 2]));
    expect(frames).toEqual([]);
    expect(truncatedAt).toBe(0);
  });

  it("handles an empty file as zero frames, no truncation", () => {
    const { frames, truncatedAt } = decodeFramesTolerant(new Uint8Array(0));
    expect(frames).toEqual([]);
    expect(truncatedAt).toBeNull();
  });
});
