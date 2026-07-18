//! `ns-jetstream` — JetStream stream management (list / get / create / delete /
//! purge). Built on the `ns-core` `NatsClientProvider` + `JetStreamManager` ports
//! (the bin injects `ns-connection` + the `async-nats` adapter); this crate never
//! links `async-nats`. The shared foundation reused by later JetStream features
//! (Consumers, KV, Object Store).
//!
//! See docs/architecture/.
#![forbid(unsafe_code)]

mod error;
mod service;

pub use error::JetStreamError;
pub use service::JetStreamService;
