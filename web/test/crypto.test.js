// Pure crypto/frame helpers (web/crypto.js), exercised against Node's
// WebCrypto so this suite needs no wasm and no browser (docs/DESIGN.md §10).
import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import {
  concatBytes,
  encodeFrame,
  decodeFrames,
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
  it("round-trips a manifest and its files", () => {
    const files = [
      { name: "identity", bytes: new Uint8Array([1, 2, 3]) },
      { name: "preferences", bytes: new Uint8Array([4, 5]) },
    ];
    const manifest = {
      version: 1,
      exportedAt: 123,
      files: files.map((f) => ({ name: f.name, size: f.bytes.length })),
    };
    const blob = encodeBackup(manifest, files);
    const decoded = decodeBackup(blob);
    expect(decoded.manifest.version).toBe(1);
    expect(decoded.files.map((f) => f.name)).toEqual(["identity", "preferences"]);
    expect(Array.from(decoded.files[0].bytes)).toEqual([1, 2, 3]);
    expect(Array.from(decoded.files[1].bytes)).toEqual([4, 5]);
  });

  it("round-trips an empty backup (no compartments written yet)", () => {
    const manifest = { version: 1, exportedAt: 1, files: [] };
    const decoded = decodeBackup(encodeBackup(manifest, []));
    expect(decoded.files).toEqual([]);
  });
});
