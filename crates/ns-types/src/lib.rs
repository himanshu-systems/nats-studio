//! ns-types — the frozen source of truth for every value that crosses the IPC
//! boundary. Rust -> TypeScript via typeshare. Additive-only; breaking changes
//! require an ADR + an `appSchemaVersion` bump.
//!
//! See docs/architecture/00-conventions-and-workspace.md (sections 6 & 7).
#![forbid(unsafe_code)]

mod app;
mod connection;
mod error;
mod event;
mod jetstream;
mod kv;
mod message;
mod monitor;
mod settings;

pub use app::*;
pub use connection::*;
pub use error::*;
pub use event::*;
pub use jetstream::*;
pub use kv::*;
pub use message::*;
pub use monitor::*;
pub use settings::*;

/// Wire alias for 64-bit unsigned integers. typeshare maps `U64` to the TS
/// `number` type via `typeshare.toml` (it rejects bare `u64`). Values that could
/// exceed 2^53 must be modelled as string DTO fields instead.
pub type U64 = u64;
