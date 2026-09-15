#!/usr/bin/env bash
# Build crates/lattice-wasm -> pkg/ (docs/DESIGN.md §1, §8).
#
# Steps: cargo build (release, wasm32-unknown-unknown) -> wasm-bindgen
# (--target web, so `web/lattice.worker.js` can `import init from
# './pkg/lattice_wasm.js'` with no bundler) -> wasm-opt -Oz in place.
# Prints raw / gzip -9 / brotli sizes of the final .wasm so `npm run size`
# (scripts/check-size.mjs) can gate on the gzip number (300 KB, DESIGN §1).
#
# Requires: `source ~/.cargo/env` (or ~/.cargo/bin on PATH), the
# wasm32-unknown-unknown target, the `wasm-bindgen` CLI matching the
# `wasm-bindgen` crate version pinned in crates/lattice-wasm/Cargo.toml
# exactly, and `wasm-opt` (binaryen). wasm-pack is NOT required or used.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PKG_DIR="$ROOT_DIR/pkg"
WASM_OUT="target/wasm32-unknown-unknown/release/lattice_wasm.wasm"

echo "==> cargo build --release --target wasm32-unknown-unknown -p lattice-wasm"
cargo build --release --target wasm32-unknown-unknown -p lattice-wasm

echo "==> wasm-bindgen --target web --out-dir pkg --out-name lattice_wasm"
rm -rf "$PKG_DIR"
wasm-bindgen --target web --out-dir "$PKG_DIR" --out-name lattice_wasm "$WASM_OUT"

BINDGEN_WASM="$PKG_DIR/lattice_wasm_bg.wasm"

echo "==> wasm-opt -Oz"
wasm-opt -Oz "$BINDGEN_WASM" -o "$BINDGEN_WASM"

raw_size=$(wc -c < "$BINDGEN_WASM" | tr -d ' ')
gzip_size=$(gzip -9 -c "$BINDGEN_WASM" | wc -c | tr -d ' ')
if command -v brotli >/dev/null 2>&1; then
  brotli_size=$(brotli -c -q 11 "$BINDGEN_WASM" | wc -c | tr -d ' ')
else
  brotli_size="(brotli not installed)"
fi

human() {
  # $1 = bytes (or a non-numeric placeholder, printed as-is)
  if ! [[ "$1" =~ ^[0-9]+$ ]]; then
    echo "$1"
    return
  fi
  awk -v b="$1" 'BEGIN { printf "%.1f KB", b / 1024 }'
}

echo ""
echo "pkg/lattice_wasm_bg.wasm sizes:"
echo "  raw:    $raw_size bytes ($(human "$raw_size"))"
echo "  gzip-9: $gzip_size bytes ($(human "$gzip_size"))"
echo "  brotli: $brotli_size bytes ($(human "$brotli_size"))"
echo ""
echo "Wrote: $PKG_DIR (lattice_wasm.js, lattice_wasm_bg.wasm, lattice_wasm.d.ts)"
