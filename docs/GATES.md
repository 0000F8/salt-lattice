# Gates (docs/DESIGN.md §1, §5, §10)

Generated 2026-09-15T10:11:52.325Z by `scripts/write-gates.mjs` (Playwright globalTeardown).

## Machine

- CPU: Apple M1 Pro
- macOS: 12.6

## Wasm size gate (§1: under 300 KB gzip)

- raw: 431338 bytes (421.2 KB)
- gzip-9: 173663 bytes (169.6 KB) — gate: PASS
- brotli: 138030 bytes (134.8 KB)

## Open gate (§5: 5,000-node store, first `loadFrame` -> `finishOpen` returning, under 100 ms)

`loadMs` is wasm-only (excludes OPFS/WebCrypto) and is gated (must be under 100 ms) on Chromium and WebKit; Firefox is recorded but not gated.

`wallMs` is the whole `open()` call, message-in to reply-out — IO (OPFS reads) + AES-GCM decrypt + `loadFrame` + `finishOpen` — what a phone actually waits for. Recorded on every browser; never gated (no on-device measurement exists yet to gate it against).

| Browser | Nodes | loadMs | Gate | wallMs |
|---|---|---|---|---|
| chromium | 5000 | 30.30 | PASS | 42.80 |
| firefox | 5000 | 167.00 | recorded only | 192.00 |
| webkit | 5000 | 42.00 | PASS | 53.00 |

## Caveats

- These are desktop-browser numbers on the machine above, not the iOS 16 Simulator gate CLAUDE.md notes as still owed.
- WebKit and Firefox here are Playwright's bundled desktop builds pinned to `@playwright/test` 1.48.0 (see package.json), because this machine (macOS 12/mac12-arm64) isn't supported by Playwright releases newer than that. That version predates the fix for GHSA-7mvr-c777-76hp (TLS validation during browser-binary download); the risk is confined to the one-time `playwright install` step, not to running these tests, so it was accepted rather than left on a machine-incompatible newer release.
- Firefox's number is noisy run to run (a few hundred ms of variance observed) and is not gated for that reason; Chromium and WebKit were consistently well under 100 ms across repeated runs.
- `wallMs` includes this run's OPFS + WebCrypto overhead on desktop Chromium/WebKit/Firefox, not on-device iOS Safari; treat it as directional until the iOS 16 Simulator run above happens.

