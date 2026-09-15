//! wasm-bindgen wrapper around `lattice-core` (`docs/DESIGN.md` §8). Exposes
//! exactly one class, `Lattice`, with the surface the worker
//! (`web/lattice.worker.js`) drives. JSON strings cross the JS boundary;
//! bytes cross as `Uint8Array`. No `u64`/`i64` appears in any exported
//! signature (BigInt-free glue) — `Env`'s `now_ms`/`random_u64` are internal
//! to `lattice-core` and never exported themselves.
//!
//! This crate owns no crypto and no storage: it only ever sees plaintext
//! bytes handed to it by the worker (already decrypted) and hands plaintext
//! back for the worker to encrypt. `Env` is built from `js-sys` so it works
//! in both a Web Worker and Node (for the vitest suite, which loads this
//! module via `initSync`): `Date.now()` is available as a global in both,
//! and `crypto.getRandomValues` is reached through `js_sys::global()` +
//! `Reflect` rather than `web_sys::window()`, which does not exist in a
//! worker.

use js_sys::{Function, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use lattice_core::{Env, Store};

/// `globalThis.crypto` — reached via `js_sys::global()` (not
/// `web_sys::window()`) so this works in a Web Worker, a Service Worker, or
/// Node, not just a document context.
fn crypto_obj() -> JsValue {
    let global = js_sys::global();
    Reflect::get(&global, &JsValue::from_str("crypto"))
        .expect("globalThis.crypto must exist (worker, window, or Node >= 19)")
}

/// One fresh `u64` from `crypto.getRandomValues` (8 random bytes, read
/// little-endian). No `getrandom` crate: this is the one place Lattice
/// touches randomness, and it is real CSPRNG output in every host this
/// module runs in.
fn random_u64() -> u64 {
    let crypto = crypto_obj();
    let get_random_values = Reflect::get(&crypto, &JsValue::from_str("getRandomValues"))
        .expect("crypto.getRandomValues must exist")
        .dyn_into::<Function>()
        .expect("crypto.getRandomValues is callable");
    let arr = Uint8Array::new_with_length(8);
    get_random_values
        .call1(&crypto, &arr)
        .expect("crypto.getRandomValues call succeeds");
    let mut bytes = [0u8; 8];
    arr.copy_to(&mut bytes);
    u64::from_le_bytes(bytes)
}

/// `Date.now()`, truncated to `u64` milliseconds. `js_sys::Date::now()` is a
/// bare global lookup, so this works the same in a worker or Node.
fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

fn make_env() -> Env {
    Env {
        now_ms: Box::new(now_ms),
        random_u64: Box::new(random_u64),
    }
}

/// Turn a `lattice_core::Error` into the thrown `JsValue` for the two
/// methods (`loadFrame`) whose §8 surface is `void`: the TS signature stays
/// `void` (a `Result<(), JsValue>` return only ever contributes its `Ok`
/// side to the declared type; `Err` becomes a thrown exception), while the
/// thrown value is still a structured `{code, message}` JSON string rather
/// than an opaque string, matching the shape `call`'s own errors use.
fn to_js_error(e: lattice_core::Error) -> JsValue {
    JsValue::from_str(&serde_json::json!({ "code": e.code, "message": e.message }).to_string())
}

/// The `Lattice` class (`docs/DESIGN.md` §8). One instance per worker; the
/// worker owns its lifetime and never shares it across compartments'
/// encryption (that stays in JS).
#[wasm_bindgen]
pub struct Lattice {
    store: Store,
}

#[wasm_bindgen]
impl Lattice {
    #[allow(clippy::new_without_default)]
    #[wasm_bindgen(constructor)]
    pub fn new() -> Lattice {
        Lattice {
            store: Store::new(make_env()),
        }
    }

    /// The schema, verbatim (`lattice_core::schema::schema_json()`). Static
    /// per build; does not depend on the store's contents.
    #[wasm_bindgen(js_name = schemaJson)]
    pub fn schema_json(&self) -> String {
        lattice_core::schema::schema_json()
    }

    /// Queue one decrypted frame's plaintext for `compartment`. Call once
    /// per frame read from disk, then `finishOpen()` once all frames for
    /// this open are queued. Idempotent across repeated opens (loading a
    /// compartment later is just another `loadFrame` + `finishOpen`).
    #[wasm_bindgen(js_name = loadFrame)]
    pub fn load_frame(&mut self, compartment: &str, bytes: &[u8]) -> Result<(), JsValue> {
        self.store
            .load_frame(compartment, bytes)
            .map_err(to_js_error)
    }

    /// Sort everything queued by `loadFrame` since the last call and apply
    /// it, building the in-memory index. Never fails: a bad frame is
    /// rejected by `loadFrame` itself, before it reaches here.
    #[wasm_bindgen(js_name = finishOpen)]
    pub fn finish_open(&mut self) {
        self.store.finish_open();
    }

    /// The plaintext to encrypt and append to `compartment`'s file: every
    /// record written since the last `takeFrame` for it. Empty
    /// (zero-length) when nothing is pending — the worker should skip the
    /// encrypt+append step rather than write an empty frame.
    #[wasm_bindgen(js_name = takeFrame)]
    pub fn take_frame(&mut self, compartment: &str) -> Vec<u8> {
        self.store.take_frame(compartment)
    }

    /// JSON array of compartment names with anything unflushed. The worker
    /// flushes every one of these after each mutating `call`, before
    /// replying, so a caller's `await` means "on disk" (`docs/DESIGN.md`
    /// §5).
    #[wasm_bindgen(js_name = pendingCompartments)]
    pub fn pending_compartments(&self) -> String {
        serde_json::to_string(&self.store.pending_compartments())
            .expect("Vec<String> always serializes")
    }

    /// The one dispatcher for every domain operation (§3–§7) plus `stats`
    /// and `build_fixture`. Never throws: every failure is
    /// `{"error": {"code", "message"}}` in the returned string, per
    /// `lattice_core::api::call`'s own contract (a Rust panic here would be
    /// a bug, not a caller error).
    pub fn call(&mut self, op: &str, args_json: &str) -> String {
        lattice_core::api::call(&mut self.store, op, args_json)
    }
}
