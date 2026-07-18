//! ns-pubsub — core NATS publish / subscribe / request. Built on the `ns-core`
//! `NatsClientProvider` port (the bin injects `ns-connection`) and `ns-inspector`
//! for payload decoding. Streaming subscriptions are driven by the caller.
//!
//! See docs/architecture/sub-pubsub.md.
#![forbid(unsafe_code)]

mod error;
mod service;

pub use error::PubSubError;
pub use service::PubSubService;
