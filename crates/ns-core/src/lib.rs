//! ns-core — the kernel: strongly-typed IDs, the `DomainError` contract + neutral
//! `CoreError`, secret redaction, a `Clock`, cancellation/task registries, the
//! internal event envelope + `EventPublisher` port, and the infrastructure **port
//! traits** (SecretStore, repositories, NATS client) that adapters implement and
//! the binary wires up. Depends only on `ns-types`.
//!
//! See docs/architecture/00-conventions-and-workspace.md (sections 7 & 10) and
//! docs/architecture/dependency-graph.md (the port-injection pattern).
#![forbid(unsafe_code)]

mod clock;
mod config;
mod error;
mod event;
mod ids;
mod ports;
mod redact;
mod runtime;

pub use clock::{Clock, SystemClock};
pub use config::default_settings;
pub use error::{CoreError, DomainError};
pub use event::{Event, EventPublisher, Topic};
pub use ids::{ConnectionId, SessionId, SubscriptionId, TaskId};
pub use ports::{
    ConnectSpec, ConnectionProfileRepo, NatsClient, NatsClientFactory, ResolvedAuth, ResolvedTls,
    SecretStore, SettingsRepo,
};
pub use redact::{Redacted, SecretString};
pub use runtime::{CancellationRegistry, TaskRegistry};

pub use ns_types::ErrorCode;
