//! `Env` (the clock/randomness the wrapper supplies) and ULID-based ids.
//!
//! No `getrandom`, no `chrono`, no `ulid`/`uuid` crate: the core takes an
//! `Env { now_ms, random_u64 }` and encodes ids itself. Ids are
//! `<prefix><26-char Crockford ULID>`.

/// Clock + randomness supplied by the wrapper. In the browser, `now_ms` is
/// `js_sys::Date::now()` and `random_u64` is built from
/// `crypto.getRandomValues`; in tests, use [`Env::fixed`].
pub struct Env {
    pub now_ms: Box<dyn Fn() -> u64>,
    pub random_u64: Box<dyn Fn() -> u64>,
}

impl Env {
    /// A deterministic clock/rng for tests: `now_ms` starts at `start_ms` and
    /// ticks up by 1 on every read (so successive ids/timestamps are
    /// strictly ordered without needing real time to pass); `random_u64` is
    /// a seeded xorshift64* stream.
    pub fn fixed(start_ms: u64, seed: u64) -> Self {
        use std::cell::Cell;
        use std::rc::Rc;

        let clock = Rc::new(Cell::new(start_ms));
        let now_ms = move || {
            let v = clock.get();
            clock.set(v + 1);
            v
        };

        let state = Rc::new(Cell::new(if seed == 0 { 0x9E3779B97F4A7C15 } else { seed }));
        let random_u64 = move || {
            let mut x = state.get();
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            state.set(x);
            x
        };

        Env {
            now_ms: Box::new(now_ms),
            random_u64: Box::new(random_u64),
        }
    }

    /// Current time in ms. Named `tick` (not `now_ms`) to avoid shadowing
    /// the callable field of the same name.
    pub fn tick(&self) -> u64 {
        (self.now_ms)()
    }

    /// One fresh 64-bit random value.
    pub fn rand(&self) -> u64 {
        (self.random_u64)()
    }
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Encode a 128-bit value as a 26-character Crockford base32 string
/// (the standard ULID text encoding: 26 * 5 = 130 bits, top 2 always zero).
fn encode_crockford(mut value: u128) -> String {
    let mut chars = [0u8; 26];
    for slot in chars.iter_mut().rev() {
        *slot = CROCKFORD[(value & 0x1F) as usize];
        value >>= 5;
    }
    // SAFETY: every byte comes from CROCKFORD, which is ASCII.
    String::from_utf8(chars.to_vec()).expect("crockford alphabet is ASCII")
}

/// Build a ULID (48-bit ms timestamp + 80 bits of randomness) and prefix it,
/// e.g. `generate_id(env, "n_")` -> `"n_01ARZ3NDEKTSV4RRFFQ69G5FAV"`.
pub fn generate_id(env: &Env, prefix: &str) -> String {
    let ts = (env.tick() as u128) & 0xFFFF_FFFF_FFFF; // 48 bits
    let r1 = env.rand() as u128; // 64 bits
    let r2 = (env.rand() as u128) & 0xFFFF; // 16 bits
    let value = (ts << 80) | (r1 << 16) | r2;
    format!("{prefix}{}", encode_crockford(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_prefixed() {
        let env = Env::fixed(1_000, 42);
        let a = generate_id(&env, "n_");
        let b = generate_id(&env, "n_");
        assert!(a.starts_with("n_"));
        assert!(b.starts_with("n_"));
        assert_eq!(a.len(), 2 + 26);
        assert_ne!(a, b);
    }
}
