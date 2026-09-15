// The main-thread client (docs/DESIGN.md §9). Talks to `lattice.worker.js`
// by `postMessage`, one in-flight request map keyed by an incrementing id.
// No wasm, no crypto, no OPFS here — this file only knows about messages.

/**
 * @param {{workerUrl?: string, wasmUrl: string, worker?: Worker}} options
 *   `workerUrl` is passed to `new Worker(workerUrl, {type: "module"})` when
 *   `worker` isn't supplied directly (tests can inject a fake worker object
 *   with `postMessage`/`onmessage`, since jsdom doesn't implement real
 *   Workers). `wasmUrl` is threaded into every `open()` call automatically
 *   (the worker only uses it the first time; see lattice.worker.js).
 * @returns {Promise<Handle>}
 */
export async function openLattice({ workerUrl, wasmUrl, worker } = {}) {
  if (!wasmUrl) {
    throw new Error("openLattice requires wasmUrl");
  }
  if (!worker && !workerUrl) {
    throw new Error("openLattice requires either workerUrl or worker");
  }

  const w = worker ?? new Worker(workerUrl, { type: "module" });

  let nextId = 1;
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>} */
  const inFlight = new Map();

  w.onmessage = (event) => {
    const { id, ok, result, error } = event.data;
    const pending = inFlight.get(id);
    if (!pending) return;
    inFlight.delete(id);
    if (ok) {
      pending.resolve(result);
    } else {
      pending.reject(error ?? { code: "unknown", message: "worker failed with no error detail" });
    }
  };

  w.onerror = (event) => {
    const err = { code: "worker_error", message: event?.message ?? "worker script error" };
    for (const pending of inFlight.values()) {
      pending.reject(err);
    }
    inFlight.clear();
  };

  function send(op, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      inFlight.set(id, { resolve, reject });
      w.postMessage({ id, op, args });
    });
  }

  return {
    open: (args = {}) => send("open", { wasmUrl, ...args }),
    close: () => send("close"),
    hasRoot: () => send("hasRoot"),
    createRoot: () => send("createRoot"),
    restoreRoot: (raw) => send("restoreRoot", { raw }),
    call: (op, args) => send("call", { op, args }),
    destroyCompartment: (compartment) => send("destroyCompartment", { compartment }),
    exportBackup: () => send("exportBackup"),
    importBackup: (blob) => send("importBackup", { blob }),
    encryptBlob: (purpose, bytes) => send("encryptBlob", { purpose, bytes }),
    decryptBlob: (purpose, bytes) => send("decryptBlob", { purpose, bytes }),
    stats: () => send("stats"),
    /** Not a worker op: tears down the underlying Worker (or fake) itself. */
    terminate: () => {
      if (typeof w.terminate === "function") w.terminate();
    },
  };
}
