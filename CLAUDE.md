# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lattice is a typed, hierarchical graph of facts about one person, stored encrypted on the person's own phone inside the Salt web app (`../salt-fe`). Agents reach it through Salt one granted request at a time. Rust compiled to WebAssembly, run in a Web Worker, persisted in the Origin Private File System (OPFS).

This directory is one repo inside the `salt` multi-root workspace; `../CLAUDE.md` describes every sibling and is loaded alongside this file. Ion (`../salt-ion`) is the second project: the on-device model that fills Lattice.

**Status (2026-09-15, branch `lattice`):** phase 1 built and gated; phase 2 (Salt integration) on the `lattice` branches of `salt-api`, `salt-fe`, `salt-agent-sdk`, `salt-claude-agent`, `salt-deploy`; Ion on `salt-ion`'s `ion` branch. Nothing pushed or deployed. The specs are the contract: `docs/DESIGN.md` (crate, worker, rules R1–R14, plus a "Decided while building" list that records every choice the spec left open), `docs/PROTOCOL.md` (wire markers and the Salt API), `docs/SCHEMA.md` (generated), `docs/GATES.md` (generated measurements). Proposal: https://claude.ai/artifact/SSPnMuXJuhj2BdSzBFu3Xc.

## Commands

Rust is installed by rustup but `~/.cargo/bin` is **not** on PATH in non-interactive shells: `source ~/.cargo/env` first. wasm-bindgen CLI 0.2.128 must match the crate pin in `crates/lattice-wasm/Cargo.toml` exactly; `wasm-opt` comes from Homebrew binaryen; wasm-pack is not used.

```bash
source ~/.cargo/env
cargo test -p lattice-core                      # the crate: rules R1–R14, round trips, perf fixture
cargo test -p lattice-core -- r5_               # one rule by name prefix
UPDATE_SCHEMA_DOC=1 cargo test -p lattice-core schema_doc_is_fresh   # regenerate docs/SCHEMA.md after a schema change
cargo clippy -p lattice-core -p lattice-wasm -- -D warnings && cargo fmt --check

npm run build:wasm        # cargo → wasm-bindgen --target web → wasm-opt -Oz → pkg/ (prints raw/gzip/brotli)
npm run size              # fails if pkg/lattice_wasm_bg.wasm is over 300 KB gzip
npm run export-schema     # pkg → docs/schema.v1.json
npm test                  # vitest, node: web/test (crypto helpers, wasm via initSync, client with a fake worker)
npm run test:browsers     # Playwright on Chromium, WebKit, Firefox: web/test-e2e (real worker, OPFS, WebCrypto, perf gate)
npx playwright test -c web/playwright.config.js --project=webkit web/test-e2e/perf.spec.js   # one browser, one spec
npm run sync-to-fe        # copies pkg + web into ../salt-fe/src/lattice/vendor and the schema into ../salt-api/public/lattice
```

`test:browsers` regenerates `docs/GATES.md` in its global teardown; commit it with the change that moved a number. Playwright is pinned to 1.48.0 because this Mac runs macOS 12, which newer releases refuse to install browsers on. WebKit's OPFS throws under an ephemeral context, so `web/test-e2e/fixtures.js` uses one persistent context per project and resets storage per test.

## Layout and boundaries

- `crates/lattice-core`: pure Rust, deps `serde` + `serde_json` only. Modules `schema` (closed, versioned type table; every type name starts with its compartment), `ids` (ULIDs from an injected `Env`), `model`, `store` (log-structured records, per-compartment frames, versions, proposals, destroy markers, compaction), `query` (paths, filters, traverse, search), `access` (grants, most-specific selector, evaluate, release, standing diff, disclosure log), `api` (one `call(op, json)` dispatcher, the only surface the wasm crate binds), `fixtures` (the 5,000-node perf store).
- `crates/lattice-wasm`: `Lattice` class = constructor, `schemaJson`, `loadFrame`, `finishOpen`, `takeFrame`, `restoreFrame`, `pendingCompartments`, `call`. JSON strings and `Uint8Array` only; no 64-bit types cross the boundary (the glue must stay BigInt-free for salt-fe's es2019 target).
- `web/lattice.worker.js` owns everything the core must not: OPFS (`lattice/v1/<compartment>`), the non-extractable HKDF root key in IndexedDB `lattice-keys`, per-compartment AES-256-GCM keys derived on demand, frame encryption, flushing after every mutating call before replying, backup export/import, `encryptBlob`/`decryptBlob` for Ion. It imports nothing outside `web/` and `pkg/`. `web/lattice.js` is the promise client; `web/crypto.js` the pure helpers (take a `subtle`).
- **Crypto lives in the worker, never in Rust.** The core only ever sees plaintext records. Keep it that way; it is what keeps the wasm small and the key material in one place.
- **No vault dependency.** Nothing here imports from `salt-fe`'s vault modules and the schema has no type a private key, seed phrase, password or account number could land in (R14). The single touchpoint is `salt-fe/src/lattice/backupKey.js`, which wraps the raw root key under the vault's messages DEK for the backup row (PROTOCOL.md "Key backup").

## Design decisions (settled)

- Tree of typed nodes plus typed links; closed versioned schema; compartments (`identity health finances preferences relationships schedule work`, plus `system` for grants and the log) are the unit of encryption and of access; every write is a kept version; agent writes land `pending` unless the grant trusts that compartment; pending, rejected, deleted and destroyed-compartment nodes never reach a release.
- Access: grant → request → evaluate → release → log. Deny by default. `channel: group` refuses at the core. A no-grant, revoked, wrong-fingerprint or no-data release is byte-identical (R5). Fact authorship is masked to `you` or `agent`. Standing release is opt-in per grant, auto fields only, diffs since a sequence number, 90-day expiry.
- Phone budget: wasm under 300 KB gzip (165 KB today); 5,000-node open under 100 ms wasm-only on Chromium and WebKit (31 / 43 ms; wall time with IO and decrypt 44 / 78 ms on this M1 Pro, Firefox slower and recorded only). The iOS Simulator run is still owed.
- Floors: Lattice iOS 15.2 / Chrome 109 (OPFS sync handles, worker-only in WebKit). WebGPU is Ion's floor only (default-on from iOS 26; behind Settings › Safari › Feature Flags on iOS 18.x, which the owner runs); Ion feature-detects and degrades to one plain line.
- Backup (owner, 2026-09-15): the vault's messages DEK wraps the root key; the ciphertext and the encrypted log go to `salt-api` as `lattice_backups` (`key_wrap`, `blob`, version CAS). A lost phone loses nothing once the first backup landed.
- Destroying a compartment deletes its file and writes a marker; writes to it are refused afterwards. Per-compartment random keys (destroy the key instead) are the recorded phase 2 option.
- Flush safety: `takeFrame` hands the worker the plaintext; if the encrypt+append fails the worker calls `restoreFrame` with the same bytes, so a failed flush is retried rather than lost.

## Housekeeping

`.omc/`, `pkg/`, `target/`, `node_modules/`, `test-results/`, `playwright-report/` are ignored. `.omc/` is created relative to the shell cwd and `salt-deploy` refuses to deploy a dirty tree.
