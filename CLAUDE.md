# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lattice is a typed, hierarchical graph of facts about one person, stored encrypted on the person's own phone inside the Salt web app (`../salt-fe`). Agents reach it through Salt one granted request at a time. Rust compiled to WebAssembly, run in a Web Worker, persisted in the Origin Private File System (OPFS).

This directory is one repo inside the `salt` multi-root workspace; `../CLAUDE.md` describes every sibling (`salt-api`, `salt-fe`, `salt-ion`, …) and is loaded alongside this file. Ion (`../salt-ion`) is the second project: the on-device model that fills Lattice. It starts only after Lattice's schema is stable.

**Status (2026-09-15):** `crates/lattice-core` is built: schema, ids, model, store, query, access and api modules, `cargo test -p lattice-core` green (22 tests: R1-R14 + schema doc freshness + store round trip + idempotent open + the 5,000-node perf fixture), `cargo fmt`/`cargo clippy -p lattice-core -- -D warnings` clean, and it builds for `wasm32-unknown-unknown`. `crates/lattice-wasm` (the wasm-bindgen wrapper) and `web/` (the worker) are being filled in next. The design below comes from the accepted proposal at https://claude.ai/artifact/SSPnMuXJuhj2BdSzBFu3Xc and is the spec to build against; decisions made while building the crate are recorded in `docs/DESIGN.md`'s "Decided while building" section.

## Toolchain

Rust 1.98 with the `wasm32-unknown-unknown` target is installed via rustup, but `~/.cargo/bin` is **not** on PATH in non-interactive shells. Prefix commands or source the env first:

```bash
source ~/.cargo/env          # or: ~/.cargo/bin/cargo ...
cargo --version
rustup target list --installed   # aarch64-apple-darwin, wasm32-unknown-unknown
```

`rustfmt`/`clippy` components are installed. Not installed yet: `wasm-pack`, `wasm-bindgen` (the CLI; the `wasm-bindgen` crate is a normal dependency of `crates/lattice-wasm`), `wasm-opt`. Node 22 is available. `.gitignore` already reserves `target/`, `pkg/`, `dist/`, `node_modules/`.

Commands for `crates/lattice-core` (run from the repo root; source `~/.cargo/env` first):

```bash
cargo test -p lattice-core                 # 22 tests: R1-R14, schema doc freshness, store round trip, idempotent open, perf fixture
cargo fmt -p lattice-core
cargo clippy -p lattice-core -- -D warnings
UPDATE_SCHEMA_DOC=1 cargo test -p lattice-core schema_doc_is_fresh   # regenerate docs/SCHEMA.md after a schema.rs change
cargo build -p lattice-core --target wasm32-unknown-unknown          # sanity-check wasm compatibility
```

Everything under `crates/lattice-wasm` and `web/` still needs its own build/test/lint commands recorded here once those exist: the plan is a Node test suite for the wasm module, and the same suite run in Chromium, WebKit and Firefox through Playwright (Salt's device matrix already runs an iOS 16 Simulator, so the platform floors are testable).

## Design decisions (settled)

### Data model
- **A tree of typed nodes with typed links across it.** The tree is the ontology (`Person → Preferences → Food → Cuisine`); links are typed edges between any two nodes (`attends`, `works_with`, `prefers_over`). Every fact still has a nameable path.
- **The schema is closed and versioned.** Agents pick from the type list and cannot add to it. New types ship with releases and the worker migrates.
- **Every node carries** `id`, `type` (from the schema, never free text), `parent`, typed `fields`, `compartment`, `author` (`{kind, fingerprint}`), `status` (`accepted | pending | rejected`), `created`, `updated`.
- **Provenance is core.** Every change is a new version and the old one is kept. Anything an agent writes starts `pending` unless the grant trusts that agent's writes in that compartment. Agent-written text is data, never instructions.
- **Queries:** path lookups (`preferences/food/*`), typed edge traversal to a bounded depth, field filters, and a small on-device full-text index over names and notes. Semantic search is an Ion feature, not Lattice's.

### Compartments and keys
- **Each top-level branch is a compartment** (identity, health, finances, preferences, relationships, schedule, work, …). A compartment is the unit of encryption (its own AES-256-GCM key) and of access (grants name compartments and fields, never nodes). Destroying a compartment key is how "delete my health data" is meant to work.
- **Lattice's root key is its own.** Generated on the device by WebCrypto, non-extractable, in its own IndexedDB entry; compartment keys are derived from it with HKDF and never stored. Never derived from the login password, never wrapped by a vault key; its lock state is independent of the vault's (an agent request never prompts for the vault password, the vault's idle lock never closes Lattice).
- **The vault boundary is structural:** a separate worker, a separate OPFS directory, no import from `salt-fe`'s vault modules (`walletVault.js`, `VaultProvider.jsx`, `vaultRewrap.js`), and no schema type for anything the vault holds (private keys, mnemonics, recovery words). The release path must not be able to reach one even by mistake.
- **Backup (decided 2026-09-15): the vault stores Lattice's wrapped root key as opaque bytes**, so the vault's recovery ladder (guardians → recovery words) also recovers the graph. The vault never interprets those bytes, and this is the only vault touchpoint. The key alone does not survive a lost phone: the encrypted log must also have an off-device copy, mirrored to `salt-api` as opaque ciphertext the way `wallets.encrypted_payload` is (same zero-knowledge posture; the server sees a blob and a version). Where exactly that blob lives (a column vs. Active Storage) is decided when phase 2 starts.

### Phone budget
- Wasm module **under 300 KB compressed**: no SQLite-in-wasm, no general graph engine. A purpose-built log-structured file plus an in-memory index.
- **Open in under 100 ms** for a few thousand nodes (gate: 5,000 nodes on the iOS 16 Simulator): read the log, decrypt compartments on demand, build the index.
- **Everything runs in the worker.** The main thread talks to it by message. Decrypted nodes live only in the worker, only while a compartment is unlocked.
- Platform floor is **iOS 15.2 / Chrome 109** (OPFS sync access handles, worker-only in WebKit, which the design already assumes). Wasm threads are not required (single worker); SIMD is an optional speed-up, so build both variants. The owner's phone runs iOS 18.5, which is fully inside Lattice's floor; nothing in this repo needs iOS 26.
- **WebGPU is Ion's floor, not Lattice's:** on by default from iOS 26 / Chrome Android 121, behind Settings › Safari › Feature Flags on iOS 18.x (every iOS browser is WebKit, so Chrome on iOS changes nothing). Ion must feature-detect `navigator.gpu` at run time: embedding recall runs on the CPU everywhere; generative extraction without a GPU is shown as unavailable on this device in one plain line (or, if a CPU mode ships, as slow and on purpose), never as an error. Lattice's grant, request and release paths never depend on it.
- iOS evicts a site's storage after seven days without a visit unless installed to the Home Screen: call `navigator.storage.persist()` and treat Salt's install prompt as data safety. A web app gets no background time on iOS, so every flow assumes the phone answers when the app is next open.
- One app, one writer: Lattice lives inside Salt's origin; one tab writes at a time, others read.

### Access model
Grant → request → evaluate → release → log. Denied unless granted, one request at a time, logged every time. **Rules decide access; no model is ever in the loop for a release decision.**

- Opening a chat shares nothing; sending a message shares nothing. Only a request under a grant releases data.
- A grant names compartments and fields, each marked `auto` or `ask`. The agent receives field names only, never values. Grants bind to the agent's key fingerprint; a key change stops automatic release until re-approved.
- The request is a structured ask with a purpose inside an encrypted message, using a `[[SALT-…]]` marker like Salt's existing ones.
- `auto` fields are answered; `ask` fields open Salt's own consent sheet (first-party chrome, never the agent's); everything else is silently omitted. **Omission is indistinguishable from absence.**
- Release goes only to that agent's key in a private lane. **Group chats never receive personal data**; a request from a group is answered, if at all, in a sidechain with that one agent.
- Authorship is masked on release: a fact written by one agent and released to another is labelled "written by an agent", never which one.
- Revocation stops future releases and cannot recall what was sent; the UI says so plainly.
- **Standing release** is opt-in per grant, for `auto` fields only: current values pushed to the agent's key at grant time and as diffs on change while the app is open, each push logged. Expires after 90 days and is renewed from the consent sheet.
- Grains' server-side agent memory (`remember`/`facts`) stays out of this; it is the agent's notebook, never the person's record.

## Build order and gates
1. **Phase 1, this repo:** Rust crate with schema, nodes, links, versions, compartments, grants, request evaluation, release, disclosure log, proposals; compiled to wasm and wrapped by a worker that owns OPFS and WebCrypto. Gate: under 300 KB compressed, 5,000-node store opens in under 100 ms on the iOS 16 Simulator, every access rule above has a failing-then-passing test.
2. **Phase 2, `salt-api` / `salt-fe`:** grants on the Agent access page, the request marker, the consent sheet, the disclosure log screen, standing release with expiry, an agent SDK helper. Nothing in the vault modules is touched. Gate: the concierge asks for a cuisine preference and gets it, a group-chat request is refused, the log shows both.
3. **Phase 3, `salt-ion`:** embedding recall first, then extraction with constrained decoding, fine-tune only if a measured baseline says so.

## Open decisions
- **Backup blob location** in `salt-api` (column vs. Active Storage) and its sync cadence. The key half is settled (see Compartments and keys).

## Housekeeping
`.omc/` is ignored here on purpose: it is created relative to the shell cwd, and `salt-deploy` refuses to deploy a dirty tree.
