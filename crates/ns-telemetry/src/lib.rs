//! `ns-telemetry` — Phase 1 in-app logging: a layered `tracing-subscriber`
//! stack (fmt-to-stderr + `EnvFilter` + an in-app ring buffer) plus a
//! [`LogStore`] handle the rest of the app queries and tails.
//!
//! Scope (see `docs/architecture/sub-logging-observability.md`): this is the
//! minimal Phase-1 slice. Rolling file output (`tracing-appender`), the
//! `LogService` port, server log ingestion, export, and diagnostics bundles
//! land in later phases. `ns-telemetry` is a headless library — no `tauri`
//! dependency.
#![forbid(unsafe_code)]

mod error;
mod layer;
mod store;

pub use error::TelemetryError;
pub use store::{LogStore, DEFAULT_CAPACITY};

use std::sync::OnceLock;

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::{reload, EnvFilter, Registry};

use layer::RingLayer;

/// The environment variable [`init_telemetry`] reads for the initial
/// `EnvFilter` directive string (e.g. `NS_LOG=info,ns_core=debug`). Falls
/// back to `"info"` if unset.
pub const NS_LOG_ENV_VAR: &str = "NS_LOG";

static TELEMETRY: OnceLock<LogStore> = OnceLock::new();

/// Install the process-wide `tracing` subscriber: an `fmt` layer to stderr,
/// an `EnvFilter` read from [`NS_LOG_ENV_VAR`] (default `"info"`), and an
/// in-app ring-buffer layer feeding the returned [`LogStore`].
///
/// # Idempotency
/// Safe to call more than once. If `ns-telemetry` has already installed the
/// global subscriber in this process, the *same* [`LogStore`] is returned
/// and no second subscriber is installed — `tracing` itself panics on a
/// second [`tracing::subscriber::set_global_default`], so this function
/// guards that call and is the only sanctioned entrypoint. If a *different*
/// global default was already installed by someone else first, this returns
/// [`TelemetryError::AlreadyInitialized`] instead of panicking.
///
/// # Errors
/// Returns [`TelemetryError::InvalidDirective`] if [`NS_LOG_ENV_VAR`] is set
/// to an unparseable `EnvFilter` directive string, or
/// [`TelemetryError::AlreadyInitialized`] per above.
pub fn init_telemetry(ring_capacity: usize) -> Result<LogStore, TelemetryError> {
    if let Some(existing) = TELEMETRY.get() {
        return Ok(existing.clone());
    }

    let store = LogStore::new(ring_capacity);

    let directives = std::env::var(NS_LOG_ENV_VAR).unwrap_or_else(|_| "info".to_string());
    let env_filter =
        EnvFilter::try_new(&directives).map_err(|source| TelemetryError::InvalidDirective {
            directive: directives.clone(),
            source,
        })?;
    let (filter_layer, reload_handle) = reload::Layer::new(env_filter);
    store.attach_reload_handle(reload_handle);

    let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
    let ring_layer = RingLayer::new(store.clone());

    let subscriber = Registry::default()
        .with(filter_layer)
        .with(fmt_layer)
        .with(ring_layer);

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|_| TelemetryError::AlreadyInitialized)?;

    // Only the caller whose `set_global_default` above actually won reaches
    // this line (a losing racer returns early via `?`), so this always keeps
    // the store that backs the real installed subscriber.
    Ok(TELEMETRY.get_or_init(|| store).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_telemetry_is_idempotent() {
        init_telemetry(16).expect("first init succeeds");
        tracing::info!(target: "ns_telemetry::tests", "idempotency-marker");
        let second =
            init_telemetry(16).expect("second init is a no-op, not a panic or fresh store");

        // Idempotent: the second handle observes records pushed via the first,
        // proving both refer to the same underlying store/subscriber.
        let records = second.query(10, None);
        assert!(
            records.iter().any(|r| r.message == "idempotency-marker"),
            "expected the second handle to see the marker record: {records:?}"
        );
    }
}
