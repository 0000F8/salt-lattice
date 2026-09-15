# Lattice design (phase 1 contract)

This is the spec the crate, the wasm wrapper and the worker are built against. Where the proposal
(https://claude.ai/artifact/SSPnMuXJuhj2BdSzBFu3Xc) and this file differ, this file wins: it records the
decisions made while building. Rules named **R1..R14** must each have a failing-then-passing test.

## 1. Layout

```
Cargo.toml                    workspace
crates/lattice-core/          pure Rust, no wasm deps: schema, nodes, links, versions, store, index,
                              queries, grants, evaluation, release, disclosure log, proposals
crates/lattice-wasm/          wasm-bindgen wrapper; JSON strings across the boundary; one `call` entry
web/                          lattice.worker.js (OPFS + WebCrypto + wasm), lattice.js (main-thread client),
                              tests (vitest in node, Playwright in Chromium/WebKit/Firefox)
docs/                         this file, SCHEMA.md (generated from the crate), GATES.md (measurements)
```

Dependencies (keep this list short; every crate costs size): `serde`, `serde_json`, `wasm-bindgen`, `js-sys`.
Nothing else without a measured reason. No crypto in Rust: **WebCrypto does all encryption in the worker**;
the core only ever sees plaintext records. No `getrandom`: the core takes an `Env { now_ms, random_u64 }`
supplied by the wrapper (js-sys `Date.now()` and `crypto.getRandomValues`).

Profile: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`; `wasm-opt -Oz` after
`wasm-bindgen`. Gate: the `.wasm` **under 300 KB after gzip -9** (also record brotli).

## 2. Compartments and the schema

Compartments are a closed enum: `identity, health, finances, preferences, relationships, schedule, work,
system`. `system` holds grants, the disclosure log and the destroy markers; it never holds a fact about
the person and grants can never name it.

A node type is a dotted name whose **first segment is its compartment**, e.g. `preferences.food.cuisine`.
The schema is a static table in the crate (`schema.rs`), versioned by `SCHEMA_VERSION` (starts at 1),
exported verbatim by `schema_json()` and rendered to `docs/SCHEMA.md` by a test that fails when the file
is stale. Each `TypeDef` has: `name`, `parent: Option<type name>` (the type it nests under; a node of a
nested type MUST point `parent` at a node of exactly that type; a top-level type has `parent = None`),
`fields: [FieldDef { name, kind, required }]` with `kind` in `text | number | bool | date | enum(values)`.
Every type has a `name: text` field (what a row is called) and an optional `note: text`; those two are what
full-text search indexes. `LinkDef { name, from: [types], to: [types] }` lists the typed edges; `attends`,
`works_with`, `prefers_over`, `related_to`, `lives_at`, `works_at` at minimum.

Initial types (the crate may add, never invent free-form): identity.person (the root; name, birthday,
pronouns, languages), identity.location (name, kind enum home|work|other, city, country),
identity.contact_channel (name, kind enum email|phone|handle, value); preferences.food (name,
note), preferences.food.cuisine (name, strength number 0..1, note), preferences.food.dish,
preferences.food.restriction (name, kind enum allergy|diet|dislike, severity enum), preferences.music
(name), preferences.music.genre, preferences.music.artist, preferences.travel (name), preferences.travel.style,
preferences.travel.place; relationships.person (name, relation enum partner|family|friend|colleague|other,
note), relationships.person.detail (name, value), relationships.pet (name, species); schedule.routine (name,
days enum-list, time, note), schedule.event (name, starts date, ends date, place, note); work.employer (name,
city), work.role (name, since date), work.project (name, note); health.condition (name, since date, note),
health.allergy (name, severity enum), health.medication (name, dose, schedule); finances.budget (name,
amount number, currency, period enum), finances.goal (name, amount number, currency, by date), finances.subscription
(name, amount, currency, period enum, note). **There is deliberately no type for a private key, seed phrase,
password, account number or card** (R14 tests that no type or field in the schema matches those words).

Closed schema (R1): a node whose type or field is not in the schema is refused with a typed error; an agent
cannot register a type.

## 3. Nodes, versions, links, proposals

```
Node { id, type, parent: Option<id>, fields: {name: value}, compartment, author: {kind: you|agent|ion,
       fingerprint: Option<hex>}, status: accepted|pending|rejected|deleted, version: u32,
       created: u64 ms, updated: u64 ms }
Link { id, type, from: node id, to: node id, author, created, status: accepted|pending|deleted }
```

Ids are `n_`/`l_`/`g_`/`d_` + 26-char Crockford ULID built from `Env` (time + random). Every write is a
**new version**; the store keeps every version (R2: after three edits, `versions(id)` returns three and the
current node is the last). `status` changes are versions too. Delete is a version with `status = deleted`;
deleted and rejected nodes are invisible to every query and every release but stay in `versions`.

**Proposals (R3):** a write whose author is an agent lands `pending` unless the grant for that
fingerprint lists the node's compartment in `trusted_writes`, in which case it lands `accepted`. A write by
`you` or `ion` with no grant: `you` lands accepted, `ion` always lands pending. `accept(id)` / `reject(id)`
move a pending node. Pending nodes are never released (R4).

## 4. Queries

- `query { path, filters, status?, limit? }`: `path` is the type path with `/` separators and an optional
  trailing `*` or name: `preferences/food/*` = every node whose type starts with `preferences.food`;
  `preferences/food/cuisine` = that exact type; `preferences/food/cuisine/Japanese` = that type with
  `fields.name == "Japanese"` (case-insensitive). `filters: [{field, op: eq|ne|contains|gt|lt, value}]`.
  Default status filter is `accepted` only.
- `traverse { from, link_types?, depth (1..=4), direction: out|in|both }` returns nodes and the links walked.
- `search { text, limit }`: on-device full-text over `name` and `note`, lowercase Unicode-alphanumeric
  tokens, prefix match on the last token, ranked by hits then recency.

## 5. Store format and the open path

The core is log-structured. A `Record { seq, ts, compartment, body }` with body one of `Node`, `Link`,
`Grant`, `RevokeGrant`, `Disclosure`, `DestroyCompartment`. `seq` is global and monotonic. On disk the
worker keeps **one file per compartment** in the OPFS directory `lattice/v1/`, made of frames:
`[u32 LE plaintext-independent length][12-byte nonce][AES-256-GCM ciphertext+tag]`. A frame's plaintext is
newline-separated JSON records. The core never sees frames' ciphertext:

- `open()` → the wrapper calls `load_frame(compartment, plaintext_bytes)` for each decrypted frame, then
  `finish_open()`, which sorts by `seq` and builds the index. Compartments not loaded are simply absent;
  loading one later is `load_frame` + `finish_open` again (idempotent).
- Writes accumulate per compartment; `take_frame(compartment) -> bytes` hands the wrapper the plaintext of
  everything written since the last take, which the worker encrypts and appends. `pending_compartments()`
  says which have anything to flush. The worker flushes after every mutating call before answering it, so
  a caller's `await` means "on disk".
- Gate: a store of 5,000 nodes (built by the perf test, spread across compartments) opens in **under
  100 ms** measured inside the worker from first `load_frame` to `finish_open` returning, on Playwright
  WebKit and Chromium on this machine; the number and the machine go in `docs/GATES.md`. The iOS 16
  Simulator run is owed and noted as such.

Compaction: `compact(compartment)` returns one frame plaintext with only current versions + the
versions list, for the worker to rewrite the file; not run automatically in phase 1.

## 6. Keys (worker, not core)

- Root: 32 random bytes from `crypto.getRandomValues`, imported as a **non-extractable HKDF** `CryptoKey`
  and stored as that object in IndexedDB database `lattice-keys`, store `keys`, key `root`. Never derived
  from any password. Never touches Salt's vault modules; the worker has no import of them.
- The raw 32 bytes exist in the worker exactly once, at generation, and are returned by `create_root()` to
  the app **so the app can hand them to the vault as opaque bytes** for backup (the one documented
  touchpoint, done by a glue module in salt-fe, never inside the worker). `restore_root(raw)` re-imports
  them on a new device.
- Compartment key = HKDF-SHA256(root, salt = `"lattice/v1"`, info = compartment name) → AES-256-GCM,
  non-extractable, derived on demand, never stored. AAD for every frame = `"lattice/v1/" + compartment`.
- `destroy_compartment(c)` (R11): deletes the compartment's file, and the core records a
  `DestroyCompartment` marker in `system`; nodes of that compartment vanish from every query. Since keys are
  derived, "destroy" is the file deletion plus the marker, which makes any later restore of that file refuse
  to load it. (Per-compartment random keys would let us destroy the key instead; recorded as a phase 2
  option in CLAUDE.md.)
- The main thread calls `navigator.storage.persist()` on first open and reports the answer.

## 7. Grants, requests, evaluation, release, log

```
Grant { id, agent_id: string (Salt user id), agent_fingerprint: hex, rules: [{selector, mode: auto|ask}],
        trusted_writes: [compartment], standing: Option<{ expires_at }>, created, revoked: Option<u64> }
Selector: "compartment.*" | "type.*" | "type.field"  (most specific wins; `system.*` refused)
Request { id, agent_id, agent_fingerprint, purpose: string, asks: [selector], channel: private|group }
```

- `evaluate(request) -> Evaluation { auto: [Fact], ask: [ConsentItem], omitted: usize }`. Only `accepted`
  nodes. For each ask selector, the grant rule that applies is the most specific matching one; `auto` →
  the fact goes in `auto`; `ask` → `ConsentItem { selector, node_id, field, value }` (values are shown
  to the person on the consent sheet, never sent until approved); no rule → counted in `omitted` and
  nothing else. `omitted` never leaves the phone; the release payload has no field that could carry it.
- `release(request_id, facts) -> (ReleasePayload, DisclosureEntry)`. `ReleasePayload { request_id,
  facts: [Fact { path, type, field, value, author: you|agent, updated }] }`. `DisclosureEntry { id, ts,
  agent_id, agent_fingerprint, grant_id, request_id, purpose, kind: on_demand|standing, fields: [{path,
  field}] }` is appended to `system` (R12: every release writes exactly one entry, and `disclosure_log
  {agent_id?, limit, before?}` returns them newest first).
- `standing_diff(grant_id, since_seq) -> Option<[Fact]>`: facts under that grant's `auto` selectors changed
  since `since_seq`; `None` when the grant is revoked, expired, or has no standing. The worker calls it after
  every flush and the app sends the push; each push goes through `release(kind = standing)`.

Rules, each a test:
- **R5** No grant, revoked grant (`revoked` set), expired standing (only affects `standing_diff`), or a
  fingerprint that differs from the grant's for the same `agent_id` → `evaluate` returns
  `{auto: [], ask: [], omitted: n}` and `release` produces a payload **byte-identical** to the one produced
  for an agent with a valid grant whose selector matches no data. Omission is indistinguishable from absence.
- **R6** `channel: group` → `evaluate` returns `Err(GroupChannel)`; nothing is computed. (salt-fe redirects
  to a sidechain and re-asks with `private`.)
- **R7** `Fact.author` is only ever `you` or `agent` — never a fingerprint, id or name (test that a fact
  written by agent A and released to agent B carries `agent`).
- **R8** A selector naming `system.*` in a grant is refused at `set_grant`.
- **R9** `ask` items are never in `auto`; approving a subset releases exactly that subset.
- **R10** A grant `rules` change is a new grant version (grants are records too; `list_grants` returns
  current ones; revoked ones stay in the log).
- **R13** Standing: a grant with `standing.expires_at < now` yields `None` from `standing_diff`, and
  `evaluate` for the same grant still works on demand.

## 8. Wasm surface (`crates/lattice-wasm`)

Exactly these exports, to keep glue small: `class Lattice { constructor(); schemaJson(): string;
loadFrame(compartment: string, bytes: Uint8Array): void; finishOpen(): void; takeFrame(compartment):
Uint8Array; pendingCompartments(): string; call(op: string, argsJson: string): string }`. `call` dispatches
every op named in §3–§7 plus `stats` (node/link/version counts per compartment, seq) and returns
`{"ok": ...}` or `{"error": {"code", "message"}}`; a Rust panic is a bug and tests assert none.

## 9. Worker protocol (`web/lattice.worker.js`)

Messages `{id, op, args}` → `{id, ok: true, result}` | `{id, ok: false, error: {code, message}}`. Ops:
`open {compartments?}`, `close`, `createRoot` (returns raw bytes once), `restoreRoot {raw}`, `hasRoot`,
`destroyCompartment {compartment}`, `exportBackup` (the encrypted files concatenated with a manifest; still
ciphertext), `importBackup {blob}`, `stats`, and passthrough `call {op, args}`. `web/lattice.js` exposes
`openLattice({workerUrl?}) -> { call(op, args), ... }` as promises. The worker never imports anything from
outside `web/`.

## 10. Tests and gates

- `cargo test -p lattice-core`: every rule R1–R14, schema doc freshness, store round trip (write → take →
  load → identical queries), 5,000-node build + serialize used by the perf test.
- `web/`: vitest (node) loading the wasm via `initSync`, covering the worker's pure parts (frame encoding,
  HKDF/AES via Node's WebCrypto) and the client; Playwright (`web/playwright.config.js`) running the real
  worker on Chromium, WebKit and Firefox: root create/restore, write/read across reload, destroy, backup
  export/import, and the 100 ms open gate with the numbers written to `docs/GATES.md`.
- `npm run size` prints the compressed wasm size and fails over 300 KB.

## Decided while building (`crates/lattice-core`, 2026-09-15)

DESIGN.md above left the following open; each was resolved while writing the crate so the wasm wrapper and
worker can build against a settled contract. `cargo test -p lattice-core` is green (22 tests: R1–R14, schema
doc freshness, store round trip, idempotent open, the 5,000-node perf fixture), `cargo fmt` is clean and
`cargo clippy -p lattice-core -- -D warnings` is clean. The crate also builds for `wasm32-unknown-unknown`
today even without `lattice-wasm` filled in yet.

- **`FieldKind::EnumList`**: §2's kind list (`text|number|bool|date|enum(values)`) doesn't cover
  `schedule.routine`'s `days`. Added a fifth kind, `enum_list(values)`, used only there. `identity.person.languages`
  stays plain `text` (no free-text-list kind exists) — a comma-separated string.
- **Concrete enum value sets** the design named without spelling out: `finances.budget.period` /
  `finances.subscription.period` = `weekly|monthly|yearly`; `preferences.food.restriction.severity` /
  `health.allergy.severity` = `mild|moderate|severe`.
- **Link `from`/`to` endpoint sets** (§2 named the six links with no endpoints): `attends` and `works_at`/`lives_at`
  run from `identity.person` or `relationships.person` to `schedule.event` / `work.employer` / `identity.location`
  respectively; `works_with` and `related_to` connect people to people (`related_to` restricted to
  `relationships.person`, since it's the "how the people you know relate to each other" edge); `prefers_over`
  connects any two nodes of the same preference-leaf type (cuisine/dish/genre/artist/style/place) to each other.
- **Required fields**: only `name` and the fields §2 explicitly showed as clearly load-bearing
  (`identity.location.kind`, `identity.contact_channel.kind`/`value`, `preferences.food.restriction.kind`,
  and the three `finances.*` `amount`/`currency`) are `required: true`. Everything else is optional — closed
  schema (R1) doesn't need every field mandatory, and being permissive here is easy to tighten later.
- **Fact.path** is the query-path-shaped string DESIGN.md §4 already uses for reads (e.g.
  `preferences/food/cuisine/Japanese`: the type's dotted segments joined by `/`, plus the node's `name`), not
  a raw node id — an agent gets something legible, never an opaque ULID, and it doubles as the `path` a
  `DisclosureEntry.fields` entry logs.
- **Author masking on release (R7)**: `Ion`-authored facts are masked as `you`, not `agent` — Ion is
  described in the top-level CLAUDE.md as on-device and first-party ("fills Lattice from the person's own
  conversations"), so it reads as the person's own record, not a third party's. Only a genuine `Agent` author
  masks to `agent`.
- **Grant versioning mechanics (R10)**: `set_grant` for an `agent_id` that already has a current grant
  appends a `RevokeGrant` record for the old grant *and* a fresh `Grant` record (new id) in the same call;
  `list_grants()` returns one current (non-revoked) grant per agent, `all_grants_including_revoked()` is the
  full history for anything that needs it (tests, an eventual admin view).
- **`release`'s exact signature** is `release(store, request, facts, kind)`, not literally
  `release(request_id, facts)` as §7's prose shorthand suggests — `api::call`'s dispatcher is stateless
  between calls (no `Request` is ever persisted; it isn't a `RecordBody` variant), so the caller passes the
  whole `Request` each time. The payload itself still depends on nothing but `request.id` and `facts`, which
  is what makes R5's byte-identical claim hold.
- **Selector validity is checked at `set_grant` time**, not just at evaluation time: a rule whose selector
  doesn't parse against the schema is refused outright (`invalid_selector`), which is also how the `system.*`
  guard (R8) generalizes to any selector that would resolve into the `system` compartment, not just the
  literal string `"system.*"`.
- **Delete only ever runs as `you`** (`delete_node`/`delete_link` take no author). An agent's pending
  *create*/*edit* proposal can be rejected, but there is no pending-delete concept — a pending node's status
  is just `Pending`, and `accept()` on it can only restore the proposed fields, not "restore, then also
  delete." Agent-initiated deletion is deferred to phase 2 if it turns out to be needed, with its own
  representation rather than overloading `Status`.
- **Compaction and frame IO are direct `Store` methods, not `api::call` ops.** `load_frame`/`finish_open`/
  `take_frame`/`pending_compartments`/`compact` all move raw bytes, which don't round-trip through the
  `{"ok"/"error"}` JSON envelope cleanly; §8's wasm surface already lists them as separate `Lattice` methods
  alongside `call`, so `lattice-wasm` should bind them the same way (`compact` wasn't in the §8 list —
  treat it like `takeFrame`: a `Uint8Array`-returning method, not a `call` op).
- **Nested-type fixtures were skipped for the perf test.** `fixtures::populate` only ever writes top-level
  (parentless) types — there are 19 of them across every non-`system` compartment, so 5,000 nodes still
  spread realistically — rather than also building `preferences.food.cuisine`-under-`preferences.food` style
  parent chains, which would have added bookkeeping without changing what the open-time gate measures.
- **Query `status` filter**: `QueryInput.status` is `None` (accepted-only, the DESIGN.md default), `Some("all")`
  (bypass the filter — needed by `r11_destroy_compartment`'s test, and by any future "show me pending
  proposals" UI), or the name of one `Status` variant.

## Decided while building, round 2 (review fixes, 2026-09-15)

A review of the `lattice` branch (`crates/lattice-core`, `crates/lattice-wasm`, `web/`) found three blockers
and two should-fix items on the crate side (destroy-compartment disclosure leak, no flush-failure recovery,
no re-check on consent/release); this round closes all of them. `cargo test -p lattice-core` is green (31
tests: the original 22 plus 9 new — a destroy-leak regression test, a `put_link`-into-a-destroyed-compartment
test, `restore_frame` recovery + a malformed-bytes rejection, a consent-recheck test, two `release`
re-validation tests, a most-specific-selector-conflict test, and a `standing_diff` revoked/round-trip test),
`cargo fmt` and `cargo clippy --workspace --all-targets -- -D warnings` are both clean, and `pkg/` was
rebuilt via `scripts/build-wasm.sh` (164.6 KB gzip, still well under the 300 KB gate).

- **Destroyed-compartment writes are now refused outright** (`compartment_destroyed`), in both `put_node`
  (checked right after the type resolves the compartment) and `put_link` (checked against the `from` node's
  compartment). Previously nothing stopped a write from landing `Accepted` in a destroyed compartment, and
  since `evaluate`/`standing_diff` didn't filter on `is_destroyed` either (unlike `query`/`traverse`/`search`,
  which already did), that data could be disclosed to an agent even though the person's own UI showed
  nothing — the one place destruction didn't actually mean "vanishes from every query" (§6). `evaluate` and
  `standing_diff` also gained the same `!store.is_destroyed(&node.compartment)` filter as defense in depth,
  matching `query.rs`'s existing pattern: given the write-refusal, a live node in a destroyed compartment
  should never occur (`purge_compartment` removes every node of that compartment from the index the instant
  it's destroyed), but the filter costs nothing and protects against that invariant changing later.
- **Flush-failure recovery: `restore_frame(compartment, bytes)`, not `ack_frame`.** `take_frame` is
  unchanged (still destructive — removes the compartment's pending records and hands back the bytes). The
  new `Store::restore_frame`/wasm `restoreFrame` takes those exact bytes back on a failed encrypt+append and
  re-queues them onto `pending_out`, ahead of anything written during the failed attempt (which was never
  removed — `take_frame` doesn't block new writes). Chosen over `ack_frame` because an ack design needs a
  watermark (a count or last-seq) to avoid a race where a write landing between `take_frame` and `ack_frame`
  gets silently dropped by a bare "clear everything currently pending" ack; `restore_frame` only ever touches
  what a specific `take_frame` call returned, so it has no such race and needed no new in-flight/checkpoint
  state in `Store`. Full rationale was also handed to the worker-side agent via the session's coordination
  file so `web/lattice.worker.js`'s `flushPending` can wire its catch block to call it.
- **`consent_item_to_fact` now re-checks `Status::Accepted` and `!is_destroyed`** before building the `Fact`
  (`not_found` otherwise). Time passes between `evaluate()` offering a `ConsentItem` and the person approving
  it; a delete, reject, or compartment destroy in that window must not still let the stale offered value out.
- **`release` no longer trusts its `facts` parameter.** It now calls `evaluate` again internally and keeps
  only facts that still appear in the fresh `auto` set or match a fresh `ask` item (via
  `consent_item_to_fact`, which is what makes the destroyed/deleted case above apply here too); anything else
  — a revoked grant, a since-deleted node, or a fact that was never actually authorized at all — is dropped
  rather than released and logged. This closes the gap where authorization lived entirely in not-yet-written
  JS glue: the crate is now the one place that decides what a `release` call is allowed to actually disclose,
  regardless of what a caller (buggy glue, or a compromised page calling `release` directly) passes in. The
  *approval* half — which `ask` items the person actually consented to — still has to come from the caller,
  since that's a one-time interactive choice nothing in the crate can re-derive; only the *authorization*
  half (is this still something the current grant state allows right now) is re-checked.

## Decided while building, round 3 (persisted standing checkpoint, 2026-09-15)

Follow-up from the team lead: the worker's standing-push watermark ("what seq have we already pushed for this
grant") lived only in worker memory, so a reload re-announced facts already sent. Fixed by moving the
watermark into the store as a `system`-compartment record, the same way grants and the disclosure log are.
`cargo test -p lattice-core` is green (33 tests: the prior 31 plus 2 new — a reload round trip proving the
checkpoint survives, and a check that an uncheckpointed grant defaults to its own creation seq rather than 0),
`cargo fmt` and `cargo clippy --workspace --all-targets -- -D warnings` are both clean. No wasm-bindgen
*surface* change was needed — both pieces below go through the existing generic `call(op, args)` passthrough,
so `crates/lattice-wasm/src/lib.rs` itself is untouched. `pkg/` still needed a rebuild, though (an earlier
note in this same round claimed otherwise and was wrong): the compiled `.wasm` statically embeds
`lattice-core`'s logic, so the new `standing_checkpoint` match arm, the checkpoint lookup inside
`standing_diff`, and `last_pushed_seq` on `list_grants` only exist in `pkg/` after rebuilding from the
updated source — an unchanged JS-facing signature doesn't mean an unchanged binary. Rebuilt via
`scripts/build-wasm.sh` (167.8 KB gzip, still under the 300 KB gate). The op name and shape were written to
the session's coordination file for the worker-side agent before implementing, per the standing setup for
cross-agent contract changes on this branch.

- **New `system` record, `StandingCheckpoint { grant_id, seq, ts }`**, and a new op,
  `standing_checkpoint {grant_id, seq}`, that commits one. Last-write-wins per `grant_id` — there is no
  history of checkpoints, only the current watermark (`Store::standing_checkpoints`, `Store::last_pushed_seq`).
  A caller (the worker) calls this once a standing push has actually succeeded, with the highest seq among
  the facts it just pushed.
- **`standing_diff`'s `since_seq` is now `Option<u64>`.** `None` (the new preferred form; the `api::call`
  arg can be omitted or `null`) defers to `Store::default_since_seq(grant_id)`: the grant's last checkpoint,
  or — for a grant that has never been checkpointed — the seq the grant itself was created at (`Store`
  gained `grant_created_seq`, populated the same way `node_seq` already was, whenever a `Grant` record is
  applied). Defaulting to the grant's *creation* seq rather than `0` matters: without it, a brand-new grant's
  first standing diff would include any pre-existing `auto`-visible data written before the grant ever
  existed, not just data going forward. Passing an explicit `since_seq` still works unchanged (still exactly
  the old behavior) — nothing about existing callers breaks, this only adds a default for callers that omit it.
  The practical effect for the worker: it no longer needs to track the watermark in memory *at all* — call
  `standing_diff` with no `since_seq` every time, `standing_checkpoint` once the push succeeds.
- **`list_grants` rows gain `last_pushed_seq: Option<u64>`.** Not part of the persisted `Grant` record itself
  (it changes independently of a grant's rules, via its own `StandingCheckpoint` record) — assembled at read
  time into a new `GrantSummary` view type (`Grant` plus `last_pushed_seq`, `Deref`s to `Grant` so existing
  call sites reading `grant.id`/`grant.agent_id`/etc. off a `list_grants()` result needed no changes).
  Read-only / informational; `standing_diff`'s own default doesn't go through this field, it reads the same
  underlying checkpoint index directly.

## Decided while building, round 4 (adversarial security review, 2026-09-15)

The security review at the crate layer found two blockers (B2, B3) and three should-fix items (S4, S5, S6,
S10) whose fix or half-fix lives in `crates/lattice-core`; the rest of that review's findings are `web/`,
`salt-fe`, `salt-api` or `salt-agent-sdk` items outside this crate. `cargo test -p lattice-core` is green (42
tests: the prior 33 plus 9 new — one per finding below, plus a dedicated `s6_*` test per validation added),
`cargo fmt` and `cargo clippy --workspace --all-targets -- -D warnings` are both clean. Verified each new
test actually depends on its fix (not just asserts something already true) by stashing the four changed
source files and confirming `tests/rules.rs` fails to even compile without them (the new tests call
`access::standing_diff` with its new signature/return type and reference `store::MAX_TEXT_LEN`/
`MAX_FIELDS_PER_NODE`, none of which existed before this round) — the review's own probes had already
demonstrated B2/S4/S5's wrong runtime output against the pre-fix code, so between the two, every fix here is
shown to matter, not just asserted to.

- **B2 — `Selector::Type(t)` now matches its subtree**: `type_name == t || type_name.starts_with(&format!("{t}."))`,
  matching how `*` already works in a query path (§4 — `preferences/food/*` means every type starting with
  `preferences.food`, not only that exact type). Before this fix, a narrowing rule like
  `preferences.food.* = ask` did nothing against a broader `preferences.* = auto` rule: every nested type
  (`preferences.food.cuisine`, `.dish`, `.restriction`, including allergies) still matched only the
  compartment-level rule and released automatically. This is a correction to this round's own earlier
  description of `type.*` (round 1's schema/access notes described "all fields of that exact type" — that
  was the bug, not the spec).
- **B3 — `standing_diff` now requires `agent_fingerprint`**, and returns `None` when it doesn't match the
  grant's, the same `revoked.is_none() && fingerprint == request.fingerprint` shape `evaluate` already uses.
  Made the parameter *required* rather than optional-with-a-permissive-default on purpose: an on-demand
  request already refuses a rotated key via `grant_is_valid_for`, but nothing stopped a standing push from
  being computed and sent to whatever key the caller happened to encrypt for, forever, past a key rotation —
  and a required parameter means a caller cannot forget to resolve and pass the agent's *current* fingerprint
  (not the grant's own stored one, which trivially "matches itself" and defeats the check).
- **S4 — a specificity tie between an `ask` rule and an `auto` rule now always resolves to `ask`.**
  `best_rule`'s ranking key changed from `sel.specificity()` to `(sel.specificity(), rule.mode == GrantMode::Ask)`;
  since `Iterator::max_by_key` returns the *last* maximum and `false < true`, an `ask` rule is now strictly
  greater than an `auto` rule at equal specificity regardless of which one a grant lists first. This can only
  arise from a duplicate or malformed grant (the UI has no way to construct two rules on the identical
  selector), but the crate shouldn't depend on that either.
- **S5 — `find_field` now refuses an unknown type outright**, even for the two implicit field names. Before
  this fix, `find_field("preferences.nonexistent", "name")` returned `Some(NAME_FIELD)` without checking
  `preferences.nonexistent` is real, so `Selector::parse("preferences.nonexistent.name")` "validated" — a
  typo'd narrowing `ask` selector silently matched nothing while a broader `auto` rule kept releasing, the
  same failure shape as B2.
- **S6 — every declared field kind is now enforced, and two caps were added.** `validate_value` handled only
  `Enum`/`EnumList` before this fix and let `Text`/`Number`/`Bool`/`Date` fall through unchecked, so any JSON
  value at all (an object, an array, ...) was accepted for those. This mattered because a trusted-write
  agent's node lands `Accepted` with no person in the loop and its author is masked to `agent` on release
  (R7) — an unvalidated field was a usable, attributed-to-nobody-specific channel between agents through the
  person's own store. Fixed: `Text`/`Date` require a string, `Number` an f64, `Bool` a bool (all
  `invalid_field_value` otherwise). Two caps, both documented here per the review's request: a `Text`/`Date`
  value is refused past **`store::MAX_TEXT_LEN` = 2,000 characters**, and a node is refused past
  **`store::MAX_FIELDS_PER_NODE` = 32 fields** (`too_many_fields`) — long enough for any legitimate value,
  short enough that a single field or a bloated node can't become an unbounded channel or an unbounded write.
  Separately, `set_grant` validates `trusted_writes` against the compartment enum now too (`invalid_compartment`
  for a non-compartment string) and refuses `"system"` specifically (`grant_names_system`) the same way a
  rule selector already was — it was previously validated server-side only, and the crate shouldn't rely on
  that.
- **S10 — `standing_diff` returns `{facts, max_seq}`, and `max_seq` (not the store's global seq counter) is
  the value `standing_checkpoint` documents as correct to ack.** `max_seq` is the highest seq actually
  represented in the returned `facts` — computed by tracking a running max only when a fact is pushed, seeded
  at the resolved `since_seq` so an empty diff still returns a safe, no-op value. Before this fix a caller
  reading `stats().seq` (the store's live global counter) to build the ack value could mark a write that
  landed during the network round trip to the ack as already pushed, when it was never actually sent — the
  new contract makes that race structurally impossible: the value that gets acked can never be newer than
  what was actually in the payload that went out.
