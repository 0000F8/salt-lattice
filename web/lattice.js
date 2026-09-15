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
  /** @type {Set<(update: {grantId: string, facts: any[]}) => void>} */
  const standingListeners = new Set();

  w.onmessage = (event) => {
    const data = event.data;
    // Unsolicited pushes (docs/DESIGN.md §7) carry no request `id` — they
    // aren't a reply to anything this client sent, so they're routed to
    // onStandingUpdate listeners instead of the request/response map.
    if (data && data.type === "standingUpdate") {
      for (const listener of standingListeners) {
        listener({ grantId: data.grantId, facts: data.facts, seq: data.seq });
      }
      return;
    }
    const { id, ok, result, error } = data;
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
    /** `force: true` is only for a genuinely key-less device (see docs/DESIGN.md §6 / review #2) — refuses with `root_exists` otherwise. */
    restoreRoot: (raw, { force = false } = {}) => send("restoreRoot", { raw, force }),
    call: (op, args) => send("call", { op, args }),
    destroyCompartment: (compartment) => send("destroyCompartment", { compartment }),
    exportBackup: () => send("exportBackup"),
    importBackup: (blob) => send("importBackup", { blob }),
    encryptBlob: (purpose, bytes) => send("encryptBlob", { purpose, bytes }),
    decryptBlob: (purpose, bytes) => send("decryptBlob", { purpose, bytes }),
    stats: () => send("stats"),
    /**
     * Subscribe to standing-grant pushes (docs/DESIGN.md §7): the worker
     * calls `standing_diff` after every flush and, when a standing grant's
     * `auto` fields changed, calls every registered listener with
     * `{grantId, facts, seq}` instead of replying to a request. Not a
     * worker op itself — sending the actual push to the agent is the app's
     * job. Returns an unsubscribe function.
     */
    onStandingUpdate: (listener) => {
      standingListeners.add(listener);
      return () => standingListeners.delete(listener);
    },
    /**
     * Call ONLY after a standing push from `onStandingUpdate` actually
     * reached the agent's key — pass the same `grantId` and `seq` the
     * update carried. This persists the checkpoint `standing_diff` reads
     * back to compute "since" on every later call, including after a
     * reload; a push that never gets acked is retried on the next flush
     * instead of being lost.
     */
    ackStandingUpdate: (grantId, seq) => send("ackStandingUpdate", { grantId, seq }),
    /** Not a worker op: tears down the underlying Worker (or fake) itself. */
    terminate: () => {
      if (typeof w.terminate === "function") w.terminate();
    },
  };
}
