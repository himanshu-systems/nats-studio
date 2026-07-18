//! ns-security — credentials & transport security for NATS Studio.
//!
//! Three pieces, all against the `ns-core` seams:
//! - [`KeyringSecretStore`] — the [`ns_core::SecretStore`] port over the OS
//!   keychain (creds/seeds/passwords never touch SQLite; encrypted-vault fallback
//!   for headless Linux is deferred to Phase 6, ADR-0013).
//! - [`Creds`] — a tolerant parser for NATS `.creds` files (JWT + NKey seed).
//! - [`client_config`] — a `rustls::ClientConfig` builder from
//!   [`ns_core::ResolvedTls`], pinned to the **ring** crypto provider.
//!
//! See docs/architecture/xc-security-model.md and sub-account-security.md.
#![forbid(unsafe_code)]

mod creds;
mod error;
mod secret_store;
mod tls;

pub use creds::Creds;
pub use error::SecurityError;
pub use secret_store::KeyringSecretStore;
pub use tls::client_config;
