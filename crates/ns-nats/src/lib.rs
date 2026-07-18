//! ns-nats — the `async-nats` adapter. Implements the `ns_core::NatsClient` and
//! `ns_core::NatsClientFactory` ports; the ONLY crate that imports `async-nats`
//! (spine ADR-0001). Everyone else talks to the port traits in `ns-core`.
//!
//! See docs/architecture/sub-connection-manager.md.
#![forbid(unsafe_code)]

mod client;
mod error;
mod jetstream;

pub use client::{AsyncNatsClient, AsyncNatsFactory};
pub use error::NatsError;
pub use jetstream::AsyncJetStream;
