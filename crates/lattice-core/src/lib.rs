//! `lattice-core`: pure Rust core for Lattice (see `docs/DESIGN.md`).
//!
//! No wasm deps, no crypto, no OS randomness. The wrapper (`lattice-wasm` /
//! `web/lattice.worker.js`) owns encryption, storage and randomness, and
//! hands this crate an [`ids::Env`] plus plaintext bytes.

pub mod access;
pub mod api;
pub mod error;
pub mod ids;
pub mod model;
pub mod query;
pub mod schema;
pub mod store;

#[cfg(feature = "fixtures")]
pub mod fixtures;

pub use error::{Error, LatticeResult};
pub use ids::Env;
pub use store::Store;
