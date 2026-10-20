# Lattice TODO

Written 2026-10-19 from the 2026-09-15 adversarial review and the signed-claims redesign.
Pages: Inside Lattice https://claude.ai/artifact/7HHcXzvaigGw4KfGzXiNcp ·
Lattice Under Attack https://claude.ai/artifact/VHiibXHxL7egRicdkr2EzJ ·
Lattice, Signed https://claude.ai/artifact/6fgDEmK7RSXBrcsBJeQvoW.
Local copies and the six reviewer reports: `docs/review-2026-09-15/`.

Status: every `lattice` branch (salt-lattice, salt-api, salt-fe, salt-claude-agent, salt-agent-sdk,
salt-deploy; salt-ion `ion`) is committed, unpushed, unmerged. Owner parked Lattice on 2026-09-24.
On merge, bump the version past main in package.json, version.rb, whatsNew.js and CHANGELOG.

## Decision first
- [ ] Adopt signed claims as the unit of release (Lattice, Signed). Decisions to take: secp256k1 vs P-256
      claim key; separate claim key vs PGP; specs in the Grains repo; predicates-only default grant.

## Phase 0 · stop the bleeding (small, before anything ships)
- [ ] Standing release path in the crate: `release` re-checks against grant auto selectors, not `request.asks`;
      test with `DisclosureKind::Standing`; ack only what was sent. (security F1, confirmed)
- [ ] Buffer inbound Lattice markers until `status === "ready"`, replay by message id. (agentic F1, impl F4)
- [ ] "Add to your data" form on `/lattice`, schema-driven, `author: {kind: "you"}`. (arch F1, agentic F7, confirmed)
- [ ] `syncGrants` sequential loop; surface `flush_failed`; `doClose` awaits a flush; guard `restoreFrame`
      against a freed store. (impl F2, F3)
- [ ] Consent sheet: quote the agent's `purpose`, cap ~280 chars, strip bidi controls; same in the log. (security F2)
- [ ] Pad release bodies to size buckets (reuse `padBlock`). (crypto F4)
- [ ] Show `author.kind` on every node; "agent-written" filter. (security F5)
- [ ] Limit on `resolveProposalParent` query; SDK dedup on release id; OPFS capability probe before first open;
      `VENDORED_FROM` stamp from `sync-to-fe`; tag Lattice-originated sidechains. (impl F6, sec F7, impl F7, impl F8, arch F8)

## Phase 1 · keys and specs (about a week)
- [ ] Salt authority key in KMS (secp256k1, sign-only); DID at `.well-known/credential-authority` `claims` section.
- [ ] Per-person claim key: generated on device, wrapped under the messages DEK beside the PGP key, registered
      on the account; signed PGP↔DID binding; enrolment on next sign-in.
- [ ] Agent DID at registration; `PATCH /api/v1/agents/did`.
- [ ] Specs + vectors in the Grains repo: `personal-claim/0.1`, `salt-grant/0.1`, `salt-receipt/0.1`,
      `salt-attestation/0.1`; `grains verify` accepts a claim; vectors mirrored into salt-api tests.
- [ ] Attestation endpoint (24 h docs, person-chosen standing fields).

## Phase 2 · signed protocol (about two weeks)
- [ ] Crate: claim builder (canonical JSON minus sig), `tier` on nodes + `ceiling` on grants in `evaluate`,
      predicate ops (`exists none eq in gte lte before after free_between`), sensitive compartments
      (`intimacy`, `belief`, `status`, `mind`: ask-only, never standing/auto/predicate), receipt records.
- [ ] Worker: vendored noble-secp256k1, sign claims/receipts, verify request signatures, claim key in memory while open.
- [ ] SDK: agent key, signed requests, `verifyClaim` offline, claim cache with expiry, receipts, revocation, dedup;
      salt-claude-agent hands claims to the model as data.
- [ ] Web: tier picker + ceiling on the Personal data card, predicates-only default for new agents, consent sheet
      shows predicates as questions, capture-at-answer chips in lanes.
- [ ] Wire: claims in releases; grants countersigned on create/update; drop the per-request fingerprint fetch.
- [ ] Per-grant daily predicate/release budget from the receipt log, refused with the empty payload. (security F6)
- [ ] Mixed requests: auto subset at once, ask remainder later (no latency tell). (security F4, agentic F6)
- [ ] Trusted-write nodes unreleasable to other audiences until reviewed once; delegation tasks scanned for
      received facts (log `lattice_fact_forwarded` at minimum). (agentic F2, F3)

## Phase 3 · the store (about two weeks)
- [ ] Server-sequenced frames: `lattice_frames` table, `POST/GET /api/v1/lattice/frames`, content-free cable
      event, claims mutex endpoint; ULID records, server-seq ordering; OPFS as cache; backup row keeps `key_wrap`
      only. Retires the seq collision, the empty second device, eviction. (impl F1, arch F3, F7)
- [ ] Per-compartment random keys wrapped by the derived key; destroy deletes the wrap. (crypto F1)
- [ ] Frame index in the AAD + per-device high-water mark in IndexedDB. (crypto F2)
- [ ] Bind `compact` on the wasm class; compaction by snapshot frame past a threshold. (datastore F1, impl F5)
- [ ] Tombstone list in the encrypted backup manifest; write down that a wiped device has no rollback defence. (crypto F3, sec F8)
- [ ] Dedup on agent/Ion proposals (type+name+parent), singleton `identity.person`, cascade delete,
      per-agent disclosure-log index, schema version stamp on records + additive-only policy. (datastore F6–F10)
- [ ] Honest perf fixture: thousands of single writes, every field populated, gate `wallMs`, run on the iOS Simulator. (datastore F2, F3)
- [ ] Indexes: (compartment, type) → ids; adjacency map for traverse. (datastore F4, F5)
- [ ] Escape-hatch free-text type per compartment; one-line note when an ask names a type that does not exist. (arch F4, agentic F5)

## Accept and write down (RISKS.md)
- [ ] A1: agent identity is server-asserted until messages/requests are signed; no stronger client-side fix exists today.
- [ ] A3: first restore onto a wiped device has no rollback defence in this architecture.
- [ ] A6: unbounded until the per-agent budget lands.
- [ ] Rust/wasm stays for phase 1 because of the 300 KB gate, not performance.

## Ion
- [ ] Order of fillers: manual entry → capture-at-answer chips → recall (works) → extraction (grammar-constrained
      decoding, then LoRA) only once the owner's own labelled conversations exist.

## Ops before this ships
- [ ] Apply salt-deploy `lattice` (`'wasm-unsafe-eval'` in CSP, `saltfor-models` bucket), then
      `MODELS_BUCKET=saltfor-models ../salt-ion/scripts/upload-models.sh`.
