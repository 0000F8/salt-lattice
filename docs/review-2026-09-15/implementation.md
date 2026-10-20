# Implementation review

## Verdict (3 sentences, contrarian, honest)
Every failure path *within one call* is genuinely well engineered — takeFrame/restoreFrame, truncated-frame recovery, byte-identical denies — but the concurrency model around those calls was never designed at all, only the single-caller happy path was. The worker protocol has no serialization between messages and the store has no cross-session sequence coordination, so the two scenarios the brief asked about (a burst, and two tabs) are not edge cases here: one is guaranteed by the app's own grant-sync code, and the other silently drops writes on the very first concurrent session. The 2026-09-15 adversarial review (RISKS.md, A1–A6) never touched concurrency at all — this is a blind spot in the *prior* review, not just the code.

## Findings

### F1. Two tabs/devices open at once can silently and permanently drop each other's writes
- Kind: bottleneck / stupid-idea (the missing piece is coordination, not a bug in existing logic)
- Severity: critical
- Evidence: `store.rs:159-166` derives `next_seq` purely from what *this* `Store` instance loaded (`self.next_seq = self.next_seq.max(record.seq + 1)`, line 163) — there is no on-disk counter. `store.rs:237-240`: `apply_record` treats a repeated seq as already-applied and returns without indexing it (`if !self.applied_seqs.insert(record.seq) { return; }`). No `BroadcastChannel`, no `navigator.locks`, no cross-tab handshake anywhere (`grep -rn "BroadcastChannel|navigator.locks" salt-lattice/web salt-fe/src/lattice` — zero hits; `grep -in "tab" salt-lattice/docs/*.md salt-lattice/CLAUDE.md` — zero hits).
- Attack: open Salt on phone and laptop at the same moment (a stated real use case for a "person's own record"). Both workers read the same on-disk files at open and compute the *identical* `next_seq`. Each tab's first write commits at that same seq. Whichever tab flushes second appends a second record carrying the SAME seq into the SAME OPFS file. The next time anything reopens that compartment and sees both records, the second is silently discarded by the idempotency check — no error, no conflict marker, the bytes sit on disk forever as inert garbage. This isn't probabilistic: with no intervening write, it's the *first* write from each session that collides.
- Solution: at minimum, take a Web Locks API lock (`navigator.locks.request`) per compartment before flushing, and refuse `open()` (or downgrade to read-only) in a second context while another holds the write lock — accept, because a full multi-writer merge protocol is out of scope for phase 1, but "detect and refuse" is not.
- Cost: M

### F2. `syncGrants`'s own `Promise.all` guarantees the OPFS burst race it wasn't designed for
- Kind: bottleneck
- Severity: critical
- Evidence: `sync.js:36-54` fires every agent's `set_grant`/`revoke_grant` concurrently via `Promise.all`, each a separate `handle.call(...)` (`lattice.js`'s `send()` posts immediately, no client-side queue). All of them touch the `system` compartment. `lattice.worker.js:716-724`'s `self.onmessage` is `async` but not serialized — message N+1 starts running before message N's `flushPending()` (`:273-301`) resolves, because `doCall`'s mutation+`takeFrame` (line 282) is synchronous but the encrypt+append that follows is not. `appendToCompartmentFile` (`:201-221`) opens an *exclusive* `createSyncAccessHandle()` at line 204 with no coordination against a second in-flight flush for the same compartment.
- Attack: any person with 2+ agent grants gets N concurrent flushes against `system.frames` on every login. When two overlap, `createSyncAccessHandle()` throws for the loser; `flushPending`'s catch (`:289-295`) correctly calls `lattice.restoreFrame` and rejects with `flush_failed` — but `sync.js:42` and `:52` catch that rejection with bare `.catch(() => {})`. The grant update is not lost (it's re-queued for the next flush) but the person and every log see total silence: no error, no retry signal, and the grant may sit unflushed until some unrelated later call happens to touch a compartment.
- Solution: serialize `set_grant`/`revoke_grant` calls with a simple `for` loop + `await` instead of `Promise.all` (removes the self-inflicted concurrency for the one call site that's cheap to fix), and stop swallowing `flush_failed` — at minimum surface it to Sentry/console so a genuinely stuck sync is visible.
- Cost: S

### F3. `close()` frees the store without flushing, and is invoked fire-and-forget on logout
- Kind: bottleneck / caveat
- Severity: high
- Evidence: `lattice.worker.js:499-507`'s `doClose` calls `lattice.free()` and nulls `lattice`/`rootKey` with **no call to `flushPending()` first**. `client.js:76-93`'s `lockLattice` says explicitly: "Deliberately never awaits `singleton` itself" and fires `handle.close()` without awaiting it; `LatticeRequestHandler.jsx:41-46` calls `lockLattice()` (no `await`) the instant `active` flips false (logout, or the account turns out to be an Agent).
- Attack: any write whose flush hasn't yet succeeded (including one just restored by F2's `restoreFrame` path, waiting for a future call to retry it) is discarded the moment logout races an in-flight or pending flush — contradicting `DESIGN.md`'s own "await means on disk" invariant, which only covers a write's *own* promise, not data already re-queued from an earlier failure. Worse: if `close()` runs while another call's `flushPending` catch block is executing `lattice.restoreFrame(compartment, plaintext)` (`:290`), `lattice` is already `null`, that line throws a raw `TypeError`, and the plaintext in that closure is simply lost — no `flush_failed` is ever surfaced because the exception happens inside the handler that was going to produce it.
- Solution: make `doClose` `await flushPending()` (best-effort, swallow errors — data still lost, but only genuinely-unflushable data, not routinely-pending data) before freeing; guard the `restoreFrame` call in the catch block against `lattice` having gone null.
- Cost: S

### F4. Incoming-agent-request handling has no readiness gate on bootstrap
- Kind: bottleneck
- Severity: high
- Evidence: `LatticeRequestHandler.jsx` runs two independent `useEffect`s off the same `active` flag: one performs `runBootstrap` (open → persist → `syncGrants` → `ready`, lines 41-107) and a *separate* one (lines 109-127) subscribes to incoming messages the instant `active` is true, with no dependency on the first effect's completion, despite the file's own comment (lines 52-58) insisting on strict ordering because "evaluate()/release() are meaningless before the worker has both a root and the current grants loaded."
- Attack: a `chat_opened`/first-message webhook (CLAUDE.md: these fire independently and can arrive very early) reaching `handleLatticeRequest` (`requestHandler.js:102-124`) before `open()` resolves hits `requireLattice()`'s `not_open` throw; the whole promise chain is caught only by `console.error(...)` at `LatticeRequestHandler.jsx:123` — the agent's request is dropped with no reply at all (not even the designed byte-identical deny). One arriving after `open()` but before `syncGrants` finishes sees no grant yet in the crate and gets R5's byte-identical deny — indistinguishable to the agent AND the person from a genuinely revoked grant.
- Solution: gate the incoming-message subscription (or just `handleIncomingUserMessage`'s dispatch) on `status === "ready"` from `latticeSlice`, queuing/dropping-with-a-visible-reason rather than racing bootstrap.
- Cost: S

### F5. `compact()` exists, is correct, and is dead code — every compartment file grows forever
- Kind: bottleneck
- Severity: medium
- Evidence: `store.rs:209-216` implements `compact` (rewrite a compartment as one frame). Two differently-shaped searches confirm it is never invoked in production: `grep -rn "\.compact(" salt-lattice/crates salt-lattice/web salt-fe/src/lattice` matches only `store.rs`'s own definition and `tests/rules.rs:906`; and `api.rs`'s op dispatcher (`:119-244`, the only surface `lattice-wasm` binds to JS) has no `"compact"` case at all — it isn't even reachable from JS as a numbered op, only as a Rust-internal method nobody calls.
- Attack: every mutating call appends one frame (`flushPending`, `:273-301`); F1/F2 show this can include retried/duplicate-adjacent frames too. Given F2's finding that `system` gets a flush on every grant sync, every standing checkpoint (`doAckStandingUpdate`, `:392-398`), and every disclosure log entry, that one file accumulates a frame per event for the account's entire lifetime with no compaction ever running. `docs/GATES.md` only measures a synthetic, freshly-built 5,000-node fixture loaded once — there is no gate for "open time after a year of real incremental writes," which is the actual phone-battery-relevant number.
- Solution: call `compact` opportunistically (e.g., after N flushes, or above a size threshold) from the worker, writing the compacted frame via `writeWholeCompartmentFile`-style replace rather than append; needs the fix from F1 first (a whole-file rewrite is the single most dangerous op to run with a second tab open).
- Cost: M

### F6. Query results are unbounded, fully-serialized JSON, and untested past 5,000 nodes
- Kind: bottleneck
- Severity: medium
- Evidence: `query.rs:78` makes `QueryInput.limit` optional, and `:166-167` only truncates `if let Some(limit)`. `requestHandler.js:200` (`resolveProposalParent`) calls `handle.call("query", { path, status: "accepted" })` with **no limit** on a live, reachable path (every agent proposal). Each such call round-trips full `Node` objects (fields + author + version + timestamps) through three copies: `serde_json` serialize inside wasm, `JSON.parse` in the worker, then a structured-clone `postMessage` to the main thread. `docs/GATES.md` gates only the 5,000-node open path; nothing in the repo measures `query`/`search` cost, and nothing exists at the 50,000-node scale the design's own perf fixture (`api.rs:107-109`, `default_fixture_count = 5000`) could trivially be parameterized to test.
- Attack: as a person's graph grows well past the one size ever measured, an unbounded `query` (already shipping in `resolveProposalParent`) degrades linearly with graph size on every single agent proposal, serialized behind the same single-message-queue worker that F2 shows is already contended.
- Solution: give `resolveProposalParent`'s query call an explicit small `limit` (it only needs to know if *a* matching node exists); add a `build_fixture`-driven gate at 50,000 nodes for `query`/`search`, not just `open`.
- Cost: S (call site fix) / M (new gate)

### F7. No OPFS/sync-access-handle capability check anywhere
- Kind: caveat
- Severity: medium
- Evidence: `grep -n "createSyncAccessHandle"` finds four bare call sites in `lattice.worker.js` (`:182,204,227,240`), none behind a `typeof` guard; `grep -n "getDirectory"` likewise bare at `:161`. Compare to Ion, which CLAUDE.md documents as "feature-detects and degrades to one plain line" for WebGPU — Lattice has no equivalent, confirmed by the same grep finding zero `isSupported`/`feature-detect`-shaped code in either `salt-lattice/web` or `salt-fe/src/lattice`.
- Attack: the claimed floor (CLAUDE.md: "iOS 15.2 / Chrome 109") is asserted, not verified — CLAUDE.md itself admits "The iOS Simulator run is still owed." Any context below the floor, or one that restricts OPFS (some in-app/webview browsers), throws a raw browser `TypeError` deep in `compartmentsDir()`/`readCompartmentFile()`; `toWireError` (`:697-714`) forwards the raw message, and `LatticeRequestHandler.jsx:95` surfaces it as `setLatticeError(String(err.message))` — a bare engine error string, not "Lattice isn't available in this browser."
- Solution: one capability check at the top of `getLattice()`/before the first `open()` (`typeof navigator.storage?.getDirectory === "function"` plus a real `createSyncAccessHandle` probe), degrading to a plain-language unsupported state.
- Cost: S

### F8. The vendor-drop has no drift protection across two independent git repos
- Kind: bottleneck
- Severity: low
- Evidence: `scripts/sync-to-fe.mjs` is the only mechanism keeping `salt-fe/src/lattice/vendor/*` in sync with `salt-lattice/web/*` + `pkg/*`; it is a manual `npm run` step. Confirmed byte-identical today (`diff web/lattice.js ../salt-fe/src/lattice/vendor/lattice.js` and `crypto.js` both exit 0; `lattice.worker.js` differs only in the documented single import-path rewrite). No hash, version stamp, or CI check ties the vendored copy to a source commit — `grep -n "vendor" salt-fe/package.json` shows only a Prettier-ignore entry, nothing that verifies freshness.
- Attack: a future fix to `lattice.worker.js` or the crate (e.g., fixing F1-F4) that lands in `salt-lattice` but where someone forgets `npm run sync-to-fe` ships silently stale — salt-fe's tests all pass against the vendor copy, so nothing fails CI in either repo.
- Solution: have `sync-to-fe.mjs` write a short `VENDORED_FROM` file (source repo commit SHA + timestamp) into the vendor dir, and a cheap salt-fe test that just asserts the file exists and is non-empty (can't check the SHA against anything without cross-repo CI, but at least a stale copy becomes visible on inspection).
- Cost: S

## The one thing I'd kill or change first
Fix F1 before anything else ships: add a Web Locks (or equivalent) guard so a second concurrent `open()` against the same OPFS storage either refuses cleanly or waits, instead of silently colliding sequence numbers. Every other finding here degrades gracefully (retries, restores, or errors loudly); F1 is the only one that deletes a person's own data with no trace and no way to know it happened — and it's the one scenario ("second device") the product description makes routine, not exotic.

## What is actually good (max 3 bullets; be stingy)
- The single-writer failure-atomicity contract — `takeFrame`/`restoreFrame` (`store.rs:179-198`), `flush_failed` propagation, and truncated-trailing-frame recovery on `open()` (`crypto.js`'s `decodeFramesTolerant` + `lattice.worker.js:449-463`) — is correctly reasoned about for the one-writer case it was built for.
- R5's byte-identical deny path (verified by a real unit test, `wasm.test.js:184`) shows real discipline about not leaking grant existence through timing/shape, even though F1/F2 show the surrounding orchestration doesn't hold to the same standard.
- Backup packaging (`crypto.js:214-336`) — 4 KB-bucket padding plus a separately-keyed encrypted manifest — is genuinely careful cryptographic engineering, a level above the concurrency work reviewed here.
