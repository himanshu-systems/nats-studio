//! ns-connection — the connection manager service. Owns the live-connection
//! registry and status state machine on top of the `ns-core` ports (repo,
//! secret store, NATS client factory, event publisher, clock). Headless and
//! mock-testable; the binary injects the real adapters.
//!
//! See docs/architecture/sub-connection-manager.md.
#![forbid(unsafe_code)]

mod error;
mod service;

pub use error::ConnectionError;
pub use service::ConnectionService;
