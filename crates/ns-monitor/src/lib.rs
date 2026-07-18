//! ns-monitor — reads the NATS server HTTP monitoring endpoint (`/varz` server
//! metrics, `/connz` client connections) over plain http. Stateless; the bin
//! passes the base URL per call. `reqwest` is confined to this crate (spine 5.2.6).
#![forbid(unsafe_code)]

mod error;
mod service;

pub use error::MonitorError;
pub use service::MonitorService;
