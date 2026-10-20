# Architecture review

## Verdict (3 sentences, contrarian, honest)
The access-control state machine (grant → evaluate → release → log) is genuinely well built and re-derives authorization at every step instead of trusting stale state — but it is a fortress with nothing in it, because no code path lets a person type a fact into their own Lattice and Ion's measured recall is 2.9%. The design's rigor is spent almost entirely on the crate (42 Rust tests, R1–R14, four rounds of security fixes) while the parts that decide what actually reaches the crate — channel classification, agent identity, fingerprint freshness, multi-device state — live in untested JS glue or aren't wired at all. This reads as a security-engineering exercise that got ahead of the product question of whether a closed, versioned, Rust/wasm graph was ever the right shape for "some facts about one person," when the schema, scale and consumption pattern are all small enough that a JSON blob and a JS filter would have hit every measured gate with a fraction of the toolchain.

## Findings

### F1. There is no way to put a fact into Lattice except a 2.9%-recall model or an agent that already knows the fact
- Kind: premise-attack
- Severity: critical
- Evidence: `salt-fe/src/components/lattice/LatticePage.jsx` is the entire "Your data" surface — search (`runSearch`, :104), a read-only compartment count (:283-304), and Accept/Reject on existing proposals (:171-183, :327-344). No add/edit form exists. `grep -rn "put_node" salt-fe/src` (excluding tests/vendor) returns exactly one call site: `requestHandler.js:230`, reached only from an agent's `[[SALT-LATTICE-PROPOSE]]` (`handleLatticeProposal`) or Ion's extraction (`submitProposals`, called from `ChatInfo.jsx` per `salt-ion/docs/DESIGN.md` §5). `salt-ion/docs/BASELINE.md`: exact recall 2.9% (Qwen 0.5B) / 0.0% (SmolLM 360M), invalid-schema rate 62.6%.
- Attack: A brand-new account has an empty graph. The only fillers are (a) Ion, measured unusable, and (b) an agent proposing facts about the person — which requires the agent to already know the fact, the exact thing the whole grant/request/release flow exists to avoid needing. The elaborate consent machinery has nothing to consent to for the foreseeable future.
- Solution: ship a plain "Add to your data" form using the schema Lattice already exports (`schemaJson()`) and the existing `put_node` op with `author: {kind: "you"}` — no crate change needed, this is pure salt-fe UI.
- Cost: S

### F2. Compaction exists and is called nowhere outside a unit test — every version, forever, replays on every open
- Kind: bottleneck
- Severity: high
- Evidence: `grep -rn "\.compact(" salt-lattice/web salt-lattice/crates salt-fe/src/lattice` matches only `crates/lattice-core/tests/rules.rs:906`. `store.rs:76-78` documents `by_compartment` as "every record ever applied... the durable source `compact` and `versions` read from"; `store.rs:112-113` (DESIGN.md quote) says compaction "not run automatically in phase 1." `finish_open` (`store.rs:159-166`) replays every queued record on every open.
- Attack: nodes keep every version (`R2`), releases append a disclosure entry every time (`R12`), and a standing grant checkpoints after every flush — none of it is ever pruned. The measured 100ms/5,000-node gate (`docs/GATES.md`) is a synthetic fixture of *current* nodes; the real ceiling is total records ever written (versions + disclosures + revoked grants), which only grows, and open time is `O(total records)` since parse+replay touches all of them, not just live state. A daily Ion user with a standing-enabled agent will not notice this for months, then will.
- Solution: call `compact(compartment)` on a cadence (every N opens, or when a compartment's pending byte count crosses a threshold) from `lattice.worker.js`; the crate function and its test already exist.
- Cost: S

### F3. "The person's phone" is a mental model, not an invariant — a second device silently gets a different, empty answer it cannot distinguish from "withheld"
- Kind: premise-attack
- Severity: critical
- Evidence: `salt-lattice/docs/RISKS.md` A3: `bootstrapRoot` (`backup.js:106-121` in my read) restores only the wrapped root key and stops; `importBackup` "appears nowhere outside `src/lattice/vendor/`." `CLAUDE.md`: "A lost phone loses nothing once the first backup landed" — the backup story is framed around one lost device, not concurrent devices. `docs/DESIGN.md` §7 R5: a no-grant/no-match release is required to be byte-identical to a real "nothing to disclose" release, "indistinguishable from absence" by design.
- Attack: Salt is a web app, not a native mobile app — nothing stops signing into saltfor.com on a second browser/device. That device gets a fresh root key and an *empty* graph (data half of restore isn't wired), and R5's own indistinguishability guarantee — built to stop an agent from telling "no grant" from "no data" — now also hides from the *person* that their laptop's Lattice answered an agent with nothing while their phone's Lattice had the fact. There is no cross-device sync of live writes at all, only a single opaque backup blob with version CAS (`PROTOCOL.md` "Salt API"), so two actively-used devices will diverge with no merge and no visible warning.
- Solution: at minimum, wire the already-designed data-restore path (A3's own recommendation) so a new device inherits the graph, not just the key; treat "no backup restored yet" as its own UI state distinct from "nothing to disclose."
- Cost: M

### F4. The closed schema means a one-field product change is a three-repo release train
- Kind: stupid-idea
- Severity: high
- Evidence: schema is a static Rust table (`crates/lattice-core/src/schema.rs`), versioned and exported via `schema_json()`; `salt-api/app/services/lattice_schema.rb` serves a *checked-in copy*, `public/lattice/schema.v1.json` (`PROTOCOL.md` "Salt API"). Adding a field requires, per `salt-lattice/CLAUDE.md`'s own command list: edit `schema.rs` → `cargo test` → `wasm-bindgen`/`wasm-opt` rebuild → `npm run sync-to-fe` (copies into `salt-fe/src/lattice/vendor` *and* `salt-api/public/lattice`) → new releases of salt-lattice, salt-fe and salt-api. Unknown types/fields are dropped silently at every layer (`store.rs` `validate_fields`, and `requestHandler.js:216-218`'s comment: "An unknown type or field... silently drops just that one proposal").
- Attack: the person's owner explicitly asks "who adds `health.pregnancy`?" — the answer today is: a Rust change plus a three-repo coordinated release, weeks not minutes, for a taxonomy that Ion's entire job is to extract *open-ended* facts against. Every fact Ion or an agent surfaces that doesn't fit one of the ~30 existing types (sexuality, immigration status, religion, hobbies outside food/music/travel, mental health beyond `health.condition`) is dropped with no trace and no signal to the person that something was lost — `submitProposals` returns only a `dropped` count nobody surfaces in the UI.
- Solution: add one escape-hatch type per compartment (e.g. `<compartment>.note`, free-text `name`+`note` only) so an unrecognized fact has somewhere to land pending review instead of vanishing; keep the closed schema for everything structured.
- Cost: M

### F5. The rigor is inverted: the untested JS layer makes the trust decisions the heavily-tested Rust layer only rubber-stamps
- Kind: caveat
- Severity: high
- Evidence: `requestHandler.js:120` hardcodes `channel: "private"` on every request object built for the crate, so `access.rs`'s `Channel::Group` refusal (§7 R6, `access.rs:128-133`) can never actually fire from production code — the real "is this a group" decision is `isGroupChat` (`requestHandler.js:72-76`), a heuristic over a locally cached, possibly-stale chat payload, already flagged as dead-code risk in `RISKS.md` A5. Likewise agent identity and key freshness (`fetchAgentFingerprint`, `requestHandler.js:45-48`) come from `GET /api/v1/users/:username`, a plain unauthenticated-of-the-crate REST call the crate has no way to verify (`RISKS.md` A1).
- Attack: this isn't just "one rule is dead code" (already accepted as A5) — it's a structural pattern: every security-relevant classification (group vs. private, which fingerprint is current, which grant is "the" grant) is resolved once, in plain JS, with no analog of the crate's R1–R14/S4–S10 test discipline, then handed to Rust as ground truth the 42-test suite dutifully enforces. The elaborate crate-side proof (`access.rs:106-118`'s tie-break fix, `store.rs`'s field-kind validation) is proving properties of a model whose inputs are the least-scrutinized code in the stack.
- Solution: not a crate fix — a process one: any change to `isGroupChat`/`fetchAgentFingerprint` should carry the same rule-numbered, tested-both-ways discipline `docs/DESIGN.md` demands of the crate, and R6 should be exercised by a test that calls the real requestHandler path, not just `access.rs` directly.
- Cost: S (docs/process), M (actual JS test coverage)

### F6. Rust/wasm/OPFS is a lot of architecture for a ~30-type graph capped at what one person can accumulate
- Kind: premise-attack
- Severity: medium
- Evidence: `docs/DESIGN.md` §1 lists the whole toolchain: `wasm-bindgen`, `wasm-opt -Oz`, a pinned Playwright matrix across Chromium/WebKit/Firefox, a 300KB gzip budget (`docs/GATES.md`: 169.6KB today), plus OPFS + non-extractable WebCrypto keys in a dedicated worker. The measured gate is 5,000 nodes opening in 30-42ms wasm-only (`docs/GATES.md`).
- Attack: `RISKS.md` A1 already accepts that the server is trusted for agent identity binding — so the privacy delta this whole client-side engine buys over doing the identical selector math server-side (still against an at-rest-encrypted store, decrypted only transiently during evaluation) is narrower than the architecture implies: defense against a compromised server reading *historical* plaintext, not against a compromised server routing requests to the wrong "agent." That's real, but 5,000 flat JSON records filtered by string-prefix match is sub-millisecond in plain JS with no wasm at all — the perf gate this design chases is not evidence wasm was necessary, only that wasm also clears a bar plain JS would clear with a much smaller toolchain (no cargo/wasm-bindgen/wasm-opt/binaryen pipeline, no three-engine Playwright matrix, no BigInt-boundary constraints leaking into salt-fe's build).
- Solution: accept for phase 1 (it's built and gated), but the phase-2 "per-compartment random keys" and any further crate investment should be weighed against whether a plain-JS/IndexedDB implementation would have shipped phase 2 already, for a data model this small.
- Cost: — (accept, with the note above)

### F7. `navigator.storage.persist()` is the only defense against eviction, it's best-effort, and the recovery path for "it got evicted anyway" doesn't exist
- Kind: caveat
- Severity: high
- Evidence: `salt-fe/src/lattice/client.js:102-118` `requestPersistentStorage` — "Never throws... just reports unsupported"; called once per open from `LatticePage.jsx:185-188`, not required before use. `docs/DESIGN.md` §6: "The main thread calls `navigator.storage.persist()` on first open and reports the answer" — no gate on the answer. Combined with F3: `importBackup` (the data-restore half) isn't wired anywhere in salt-fe.
- Attack: `persist()` can be denied (common on iOS Safari without an install, and even a granted persist doesn't guarantee immunity under real storage pressure). When OPFS is evicted, IndexedDB's root key may or may not survive independently — nothing in `lattice.worker.js` detects "key present, compartment files gone" versus "compartment files present, key gone" as distinct states, and even if it did, there's no wired restore to recover from either. The person's entire graph disappears with a UI that, per `LatticePage.jsx:39-45`, has no state for this at all (`idle/opening/ready/locked/error` — eviction just looks like a fresh, empty `ready`).
- Solution: detect the has-key-but-empty-compartments state explicitly and route it to the (once built) backup restore rather than silently presenting an empty Lattice as normal.
- Cost: M (depends on F3's restore path landing first)

### F8. Every Lattice request in a group chat permanently pollutes that chat's sidechain list with a one-off Q&A lane
- Kind: bottleneck
- Severity: medium
- Evidence: `requestHandler.js:54-58` `openSidechainWith` calls `POST /api/v1/chats/:id/sidechain` (get-or-create) whenever `isGroupChat` is true (:108-111); the top-level `CLAUDE.md`'s sidechain section describes lanes as durable, named, always-listed UI objects ("`session.sidechains` lists every lane the viewer belongs to," rendered as a persistent chip/entry in `ChatInfo.jsx`). Nothing in the Lattice code path archives, hides, or marks the lane as Lattice-originated afterward.
- Attack: an agent in a 20-person group chat asking once "what cuisine do you like?" creates a permanent, visibly-listed private lane with that agent for every member who ever gets asked — indistinguishable in the UI from a deliberate ongoing coaching/advisor relationship the sidechain feature was built for. Lattice inherits sidechain's UX semantics and lifecycle (no close/archive concept exists per the top-level docs) for a use case (single Q&A) that doesn't want them.
- Solution: tag Lattice-originated sidechains (e.g. `purpose: "lattice"` on creation) so the UI can collapse/label them differently from a real advisor lane, rather than reusing the general-purpose primitive unmodified.
- Cost: S

## The one thing I'd kill or change first
Ship manual fact entry (F1) before anything else. The team has spent four rounds of adversarial review hardening a 42-test Rust access-control engine — real, careful work — that currently has no data to protect and no near-term path to getting any, since Ion measures at 2.9% exact recall and agents can't propose what they don't know. Every dollar spent on crate rigor right now is protecting a hypothetical.

## What is actually good (max 3 bullets; be stingy)
- `release()` re-derives authorization from a fresh `evaluate()` instead of trusting its `facts` argument (`access.rs:238-258`) — closes a real time-of-check/time-of-use gap between offering a consent item and the person approving it.
- R5's byte-identical no-match/no-grant release (`access.rs` `evaluate`/`release`) is genuine adversarial thinking about what a negative answer leaks — rare to see actually enforced rather than just documented.
- `restore_frame` (`store.rs:184-198`) chose "hand back the exact bytes on failure" over an ack/watermark scheme specifically to avoid a race window — the reasoning in the comment is correct and the simpler design really is safer here.
