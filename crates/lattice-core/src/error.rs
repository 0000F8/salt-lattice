//! A single error type shared by every module, cheap enough to build on
//! every rejected write without leaning on `format!` in hot paths.

use std::fmt;

/// A typed, codeable error. `code` is a stable machine-readable string (what
/// `api::call` puts under `error.code`); `message` is for humans/logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

pub type LatticeResult<T> = Result<T, Error>;
