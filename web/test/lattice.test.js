// web/lattice.js (the main-thread client) exercised against a fake worker
// object, since jsdom/Node don't implement real Workers (docs/DESIGN.md
// §9-§10: "vitest ... covering ... the client").
import { describe, it, expect, vi } from "vitest";
import { openLattice } from "../lattice.js";

/** A fake Worker: `handler(msg, worker)` decides how/when to reply. */
function makeFakeWorker(handler) {
  const worker = {
    postMessage(msg) {
      Promise.resolve().then(() => handler(msg, worker));
    },
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
  };
  return worker;
}

const WASM_URL = "/pkg/lattice_wasm_bg.wasm";

describe("openLattice", () => {
  it("resolves call() with the worker's result", async () => {
    const worker = makeFakeWorker((msg, w) => {
      w.onmessage({ data: { id: msg.id, ok: true, result: { echoed: msg.op, args: msg.args } } });
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    const result = await handle.call("stats", {});
    expect(result).toEqual({ echoed: "call", args: { op: "stats", args: {} } });
  });

  it("rejects call() with the worker's structured error", async () => {
    const worker = makeFakeWorker((msg, w) => {
      w.onmessage({ data: { id: msg.id, ok: false, error: { code: "boom", message: "nope" } } });
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    await expect(handle.call("put_node", {})).rejects.toEqual({ code: "boom", message: "nope" });
  });

  it("threads wasmUrl into open() automatically", async () => {
    let seenArgs;
    const worker = makeFakeWorker((msg, w) => {
      seenArgs = msg.args;
      w.onmessage({ data: { id: msg.id, ok: true, result: {} } });
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    await handle.open({ compartments: ["identity"] });
    expect(seenArgs).toEqual({ wasmUrl: WASM_URL, compartments: ["identity"] });
  });

  it("threads wasmUrl into open() even with no args given", async () => {
    let seenArgs;
    const worker = makeFakeWorker((msg, w) => {
      seenArgs = msg.args;
      w.onmessage({ data: { id: msg.id, ok: true, result: {} } });
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    await handle.open();
    expect(seenArgs).toEqual({ wasmUrl: WASM_URL });
  });

  it("dispatches concurrent requests independently by id", async () => {
    const worker = makeFakeWorker((msg, w) => {
      const delay = msg.op === "hasRoot" ? 10 : 0;
      setTimeout(() => w.onmessage({ data: { id: msg.id, ok: true, result: msg.op } }), delay);
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    const [a, b] = await Promise.all([handle.hasRoot(), handle.stats()]);
    expect(a).toBe("hasRoot");
    expect(b).toBe("stats");
  });

  it("routes every method to its own op name with the right args shape", async () => {
    const seen = [];
    const worker = makeFakeWorker((msg, w) => {
      seen.push(msg);
      w.onmessage({ data: { id: msg.id, ok: true, result: null } });
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });

    await handle.close();
    await handle.hasRoot();
    await handle.createRoot();
    await handle.restoreRoot(new Uint8Array(32));
    await handle.destroyCompartment("health");
    await handle.exportBackup();
    await handle.importBackup(new Uint8Array([1]));
    await handle.encryptBlob("embedding", new Uint8Array([1]));
    await handle.decryptBlob("embedding", new Uint8Array([1]));
    await handle.stats();

    expect(seen.map((m) => m.op)).toEqual([
      "close",
      "hasRoot",
      "createRoot",
      "restoreRoot",
      "destroyCompartment",
      "exportBackup",
      "importBackup",
      "encryptBlob",
      "decryptBlob",
      "stats",
    ]);
    expect(seen.find((m) => m.op === "restoreRoot").args).toEqual({ raw: new Uint8Array(32) });
    expect(seen.find((m) => m.op === "destroyCompartment").args).toEqual({ compartment: "health" });
    expect(seen.find((m) => m.op === "encryptBlob").args).toEqual({ purpose: "embedding", bytes: new Uint8Array([1]) });
  });

  it("rejects every in-flight request on a worker error", async () => {
    const worker = makeFakeWorker(() => {}); // never replies
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    const first = handle.stats();
    const second = handle.hasRoot();
    worker.onerror({ message: "crashed" });
    await expect(first).rejects.toEqual({ code: "worker_error", message: "crashed" });
    await expect(second).rejects.toEqual({ code: "worker_error", message: "crashed" });
  });

  it("rejects with a generic error when the worker replies ok:false with no error detail", async () => {
    const worker = makeFakeWorker((msg, w) => {
      w.onmessage({ data: { id: msg.id, ok: false } });
    });
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    await expect(handle.stats()).rejects.toEqual({ code: "unknown", message: "worker failed with no error detail" });
  });

  it("terminate() tears down the underlying worker", async () => {
    const worker = makeFakeWorker(() => {});
    const handle = await openLattice({ wasmUrl: WASM_URL, worker });
    handle.terminate();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("requires wasmUrl", async () => {
    await expect(openLattice({ worker: makeFakeWorker(() => {}) })).rejects.toThrow(/wasmUrl/);
  });

  it("requires workerUrl or worker", async () => {
    await expect(openLattice({ wasmUrl: WASM_URL })).rejects.toThrow(/workerUrl or worker/);
  });
});
