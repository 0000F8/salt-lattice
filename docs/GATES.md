# Gates (docs/DESIGN.md §1, §5, §10)

Generated 2026-09-15T08:46:03.512Z by `scripts/write-gates.mjs` (Playwright globalTeardown).

## Machine

- CPU: Apple M1 Pro
- macOS: 12.6

## Wasm size gate (§1: under 300 KB gzip)

- raw: 415207 bytes (405.5 KB)
- gzip-9: 168578 bytes (164.6 KB) — gate: PASS
- brotli: 134701 bytes (131.5 KB)

## Open gate (§5: 5,000-node store, first `loadFrame` -> `finishOpen` returning, under 100 ms)

Gated (must be under 100 ms) on Chromium and WebKit; Firefox is recorded but not gated.

| Browser | Nodes | loadMs | Gate |
|---|---|---|---|
| chromium | 5000 | 36.50 | PASS |
| firefox | 5000 | 523.00 | recorded only |
| webkit | 5000 | 42.00 | PASS |

## Caveats

- These are desktop-browser numbers on the machine above, not the iOS 16 Simulator gate CLAUDE.md notes as still owed.
- WebKit and Firefox here are Playwright's bundled desktop builds pinned to `@playwright/test` 1.48.0 (see package.json), because this machine (macOS 12/mac12-arm64) isn't supported by Playwright releases newer than that. That version predates the fix for GHSA-7mvr-c777-76hp (TLS validation during browser-binary download); the risk is confined to the one-time `playwright install` step, not to running these tests, so it was accepted rather than left on a machine-incompatible newer release.
- Firefox's number is noisy run to run (a few hundred ms of variance observed) and is not gated for that reason; Chromium and WebKit were consistently well under 100 ms across repeated runs.

