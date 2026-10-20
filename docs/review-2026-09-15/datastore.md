# Datastore review

## Verdict
This is a hand-rolled append-only log wearing a graph-database's clothing: `evaluate`, `standing_diff`, and `search` all do a full scan of every accepted node on every call, and there is no way to compact the on-disk log at all — not "not automatic," but not bound to the wasm surface, so nobody can shrink these files even by hand today. The one number this design leans on for credibility — 5,000 nodes opening under 100ms — was produced by a fixture that writes everything in one batched flush using only 19 top-level types with only required fields populated, which is a cheaper system than the one two years of per-action Ion proposals, accepts, and standing-push checkpoints will actually produce. None of this is fatal at "a few thousand facts about one person" scale, but the gate is currently evidence about a system that will never occur in production.

## Findings

### F1. Compaction exists in Rust and is unreachable from JS
- Kind: bottleneck | Severity: critical
- Evidence: `store.rs:209` implements `Store::compact`; DESIGN.md §5 says it's "not run automatically in phase 1." But `crates/lattice-wasm/src/lib.rs:86-158` binds only `new, schema_json, load_frame, finish_open, take_frame, restore_frame, pending_compartments, call` — no `compact`. `grep -rn "compact" web/*.js ../salt-fe/src/lattice/*.js` returns zero hits.
- Attack: every edit, accept/reject, and `standing_checkpoint` ack is a new appended frame (`store.rs:242-252`, `lattice.worker.js:273-301`). The file only grows. No one can shrink it even manually.
- Solution: bind `compact` on the wasm class (the Rust already exists) and have the worker call it when a compartment's frame count crosses a threshold.
- Cost: S + M.

### F2. The perf gate benchmarks a fixture that cannot occur in production
- Kind: stupid-idea / premise-attack | Severity: critical
- Evidence: `fixtures.rs:44-68`'s `populate()` runs inside one `call("build_fixture", {count: 5000})` (`perf.spec.js:37`), one worker message, so `doCall`'s single `flushPending()` (`lattice.worker.js:566-572`) turns 5,000 writes into **one frame per compartment**. Real usage flushes after *every* mutating call (`lattice.worker.js:260-272`), so a real store accumulates thousands of small frames. `decryptCompartmentFramesTolerant` (`crypto.js:177-190`) decrypts frames in a sequential loop, one `await subtle.decrypt` per frame — cost scales with frame count, invisible when count is 1. `doOpen` (`lattice.worker.js:429-437`) also excludes all IO/decrypt from the gated `loadMs`, and `wallMs` — the number that would show this — is recorded but never gated, and was measured against this same one-frame file.
- Attack: a real device after two years has thousands of frames per compartment, each needing its own OPFS read and its own awaited WebCrypto call. The gate's 42-53ms `wallMs` says nothing about that file.
- Solution: build a second fixture issuing thousands of separate `call()`s (one write each) and gate `wallMs`, not just `loadMs`, against it.
- Cost: M.

### F3. The fixture also understates per-node cost: top-level types only, required fields only
- Kind: caveat | Severity: high
- Evidence: `fixtures.rs:44-50` populates only `name` plus required fields; DESIGN.md's changelog admits "nested-type fixtures were skipped for the perf test."
- Attack: `validate_parent`'s (`store.rs:913-941`) parent lookup is untested by the gate at any scale, and real optional fields (notes, free text) make on-disk records 2-5x the bytes the fixture measures — feeding directly into F1's growth and F2's frame-count reality.
- Solution: populate every field, and note the gap in `docs/GATES.md`'s caveats.
- Cost: S.

### F4. `evaluate`, `standing_diff`, `search` are full scans, no index, on every call
- Kind: bottleneck | Severity: high
- Evidence: `access.rs:149` `evaluate()` iterates every accepted node regardless of `request.asks`. `access.rs:361` `standing_diff()` visits every accepted node before filtering by seq. `query.rs:300-333` `search()` rebuilds its token index "fresh from the current accepted nodes on every call," by design.
- Attack: a grant scoped to one field still costs a full-graph walk, and it happens on *every flush* via `pushStandingUpdates` (`lattice.worker.js:334-363`). Writes get slower as history accumulates, not just opens.
- Solution: a `(compartment, type) -> node_id` index for scoping, and a seq-sorted structure so `standing_diff` doesn't visit unchanged nodes.
- Cost: M.

### F5. `traverse` multiplies cost by depth × frontier × total links
- Kind: bottleneck | Severity: medium
- Evidence: `query.rs:210-258` — at each of up to 4 depth levels, for every frontier node, the code scans `accepted_links()` in full. No `from`/`to` adjacency index exists.
- Attack: a `relationships` compartment with a few hundred links makes a depth-4 both-direction traverse O(frontier × total_links) per level, recomputed from scratch every call.
- Solution: a `node_id -> Vec<link_id>` adjacency map, maintained incrementally on `put_link`/`delete_link`.
- Cost: M.

### F6. No dedup: the same proposed fact can land as N pending nodes forever
- Kind: caveat | Severity: high
- Evidence: `store.rs:364-416` `put_node` always mints a fresh id when `input.id` is `None` — no existence lookup. `requestHandler.js:216-218` says outright: "Neither caller pre-checks that itself." `salt-ion/docs/BASELINE.md` shows the untuned model already at ~63% invalid, near-zero exact precision — likely to re-propose overlapping facts across sessions as it slowly converges, not converge cleanly.
- Attack: Ion re-extracting "likes Japanese food" from 40 conversations over two years produces 40 near-identical pending nodes, none superseding the others, each a permanent version once reviewed.
- Solution: before an agent/ion `put_node`, look up an existing accepted-or-pending node of the same type/name under the same parent and edit it instead of creating.
- Cost: M.

### F7. No uniqueness constraints — schema has no notion of "singleton" or "unique"
- Kind: caveat | Severity: medium
- Evidence: `schema.rs:118-129`'s `TypeDef` has no singleton/unique flag; `put_node` never checks for an existing node before creating.
- Attack: two `identity.person` roots, or two "Japanese" `preferences.food.cuisine` nodes, can coexist as `Accepted`. `query.rs:150-156`'s `ExactTypeNamed` then returns both, and a single-result caller like `requestHandler.js:194-206`'s `resolveProposalParent` (`list[0].id`) picks whichever sorts first by `(created, id)` — silently arbitrary once a duplicate exists.
- Solution: the F6 existence check closes most of this; treat `identity.person` as an explicit singleton.
- Cost: S, given F6.

### F8. Delete never touches children; edit never re-checks the parent is alive
- Kind: caveat | Severity: medium
- Evidence: `store.rs:543-557` `delete_node` sets only the target's own status; nothing scans for `parent == id`. `validate_parent` (`store.rs:913-941`) checks only the parent's type, never its status.
- Attack: delete a `preferences.food` node with three `cuisine` children — they stay `Accepted`, fully queryable and releasable to an agent, pointing at nothing live, and remain freely editable forever since edits never re-check parent status.
- Solution: cascade-delete same-relation children, or require `parent_node.status == Accepted` in `validate_parent`.
- Cost: S-M.

### F9. Closed schema has a version constant and no migration path
- Kind: premise-attack | Severity: high
- Evidence: `schema.rs:5` `SCHEMA_VERSION: u32 = 1` is surfaced read-only via `schema_json()`; the load path (`apply_record`, `store.rs:237-305`) never validates against the schema at all. A repo-wide search for "migrat" across the crate and the API's lattice controllers/models finds nothing except an unrelated Rails migration comment.
- Attack: rename `preferences.food.cuisine` to `preferences.food.style` in a future version. `query`'s path parser (`query.rs:19-49`) and `Selector::parse` (`access.rs:21-39`) both require the *current* schema table to resolve a path, so old nodes become unreachable by `query`/`evaluate`, while `search` (which never consults the schema) keeps surfacing them under a type string the UI won't recognize. A newly-required field is silently absent on every pre-existing node — `required` is enforced only at write time (`store.rs:961-999`), never backfilled. This isn't hypothetical: the design already changed enum values, required-field lists, and field kinds three times while unshipped, per DESIGN.md's own changelog — the exact kind of change that, post-launch, orphans real people's history instead of being a pre-launch footnote.
- Solution: stamp each record with the `SCHEMA_VERSION` it was written under, and adopt an additive-only policy (never rename/remove, only add) as the cheap version of a real migration hook.
- Cost: M.

### F10. Edits store the full field set every time; the disclosure log has no index
- Kind: caveat | Severity: medium
- Evidence: `model.rs`'s `PutNodeInput` doc: an edit "replaces the whole field set — PUT semantics, not a merge." `store.rs:789-818` `disclosure_log` clones and reverses the *entire* history on every call, even scoped to one agent.
- Attack: editing one field on a 20-field node rewrites all 20 (growth scales with field count, not edit size). A 5,000-entry disclosure log after two years of standing pushes pays a full scan on every paged fetch.
- Solution: a `BTreeMap<agent_id, Vec<index>>` side index for the log (cheap); delta storage for edits is a bigger change, likely not worth it at this scale.
- Cost: S / L.

## The one thing I'd kill or change first
Kill the perf gate's fixture methodology (F2), not the 100ms budget. Replace the single-batch write with thousands of individual `call()`s — the real pattern of one proposal, one accept, one checkpoint at a time — and gate `wallMs` against that file. Everything else here (unbounded growth, unindexed scans, no dedup) is tolerable at today's scale, but nobody has a number for when it stops being tolerable, because the only number that exists was measured against a store shape production will never produce.

## What is actually good
- `release`'s re-derivation of authorization from a fresh `evaluate` rather than trusting caller-supplied facts (`access.rs:238-296`) is a genuinely disciplined access-control pattern, independent of storage concerns.
- Compartment-as-encryption-unit is the right granularity for a tight wasm budget — it explains, if not excuses, why this isn't eight SQLite-wasm databases: SQLite would fix F1/F4/F5 almost for free via real indexes and auto-vacuum, but at 500KB-1MB+ compiled it blows past the 300KB gzip gate this project is visibly proud of holding.
- The flush-failure recovery (`restore_frame`) and truncated-trailing-frame tolerance show real attention to an append-only log's failure modes, even though its *growth* was left unaddressed.
