//! ns-core — the kernel: port traits, the `DomainError` contract, strongly-typed
//! IDs, cancellation, and the settings model. Depends only on `ns-types`.
//!
//! See docs/architecture/00-conventions-and-workspace.md (sections 7 & 10).
#![forbid(unsafe_code)]

use std::fmt;

pub use ns_types::ErrorCode;

/// Implemented by every crate public error enum so the IPC boundary can map any
/// failure to a stable `ErrorCode` + a secret-safe user message (spine section 7.2).
pub trait DomainError: std::error::Error {
    fn code(&self) -> ErrorCode;
    fn retriable(&self) -> bool {
        false
    }
    fn user_message(&self) -> String {
        self.to_string()
    }
}

/// Strongly-typed connection identifier (spine section 6.2). Serialized as a string.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConnectionId(pub uuid::Uuid);

impl ConnectionId {
    #[must_use]
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl Default for ConnectionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for ConnectionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
