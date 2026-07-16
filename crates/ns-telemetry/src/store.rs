//! [`LogStore`]: a clone-cheap, ring-buffered handle to captured log records.
//!
//! Mirrors `ns_event::EventBus`'s shape: an `Arc`-backed handle fanning
//! records out over a bounded [`tokio::sync::broadcast`] channel, plus a
//! bounded drop-oldest ring buffer for point-in-time queries ([`LogStore::query`]).
//! [`crate::layer::RingLayer`] (the `tracing_subscriber` `Layer` attached by
//! [`crate::init_telemetry`]) is the only writer.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use ns_types::{LogLevel, LogRecordDto};
use tokio::sync::broadcast;
use tracing_subscriber::{reload, EnvFilter, Registry};

use crate::error::TelemetryError;

/// Default ring capacity used by callers that don't override it — enough
/// recent history for a live Logs view without unbounded memory growth.
pub const DEFAULT_CAPACITY: usize = 10_000;

/// The `reload::Handle` type wired in by [`crate::init_telemetry`],
/// parameterized over the concrete [`Registry`] subscriber the filter layer
/// is composed into.
type ReloadHandle = reload::Handle<EnvFilter, Registry>;

struct Inner {
    ring: Mutex<VecDeque<Arc<LogRecordDto>>>,
    capacity: usize,
    tx: broadcast::Sender<Arc<LogRecordDto>>,
    reload: OnceLock<ReloadHandle>,
}

/// A clone-cheap handle (`Arc` inside) to the in-app log ring + live fan-out.
///
/// Returned by [`crate::init_telemetry`]. Also constructible directly via
/// [`LogStore::new`] for hermetic unit tests that drive
/// [`crate::layer::RingLayer`] with `tracing::subscriber::with_default`
/// rather than the process-wide global subscriber.
#[derive(Clone)]
pub struct LogStore {
    inner: Arc<Inner>,
}

impl LogStore {
    /// Create a store whose ring buffer retains at most `capacity` records
    /// (oldest dropped first) and whose broadcast channel retains the same
    /// window per-subscriber before a lagging subscriber observes a gap.
    ///
    /// # Panics
    /// Panics if `capacity` is `0` (both the ring and the broadcast channel
    /// require a capacity of at least 1).
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "LogStore capacity must be >= 1");
        let (tx, _rx) = broadcast::channel(capacity);
        Self {
            inner: Arc::new(Inner {
                ring: Mutex::new(VecDeque::with_capacity(capacity)),
                capacity,
                tx,
                reload: OnceLock::new(),
            }),
        }
    }

    /// Push `record` into the ring (dropping the oldest entry if at
    /// capacity) and broadcast it to live subscribers.
    ///
    /// Never blocks and never fails: a send with no live receivers is
    /// silently dropped, matching `ns_event::EventBus::emit`'s contract.
    pub(crate) fn record(&self, record: LogRecordDto) {
        let shared = Arc::new(record);
        {
            let mut ring = self
                .inner
                .ring
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if ring.len() == self.inner.capacity {
                ring.pop_front();
            }
            ring.push_back(Arc::clone(&shared));
        }
        let _ = self.inner.tx.send(shared);
    }

    /// The most recent records (newest first), optionally filtered to those
    /// at or above `min_level`, capped at `limit`.
    #[must_use]
    pub fn query(&self, limit: usize, min_level: Option<LogLevel>) -> Vec<LogRecordDto> {
        let ring = self
            .inner
            .ring
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        ring.iter()
            .rev()
            .filter(|record| {
                min_level.is_none_or(|min| level_rank(record.level) >= level_rank(min))
            })
            .take(limit)
            .map(|record| (**record).clone())
            .collect()
    }

    /// Subscribe to newly captured records as they are pushed.
    ///
    /// The returned receiver only sees records pushed *after* it subscribes;
    /// existing history is available via [`LogStore::query`].
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<LogRecordDto>> {
        self.inner.tx.subscribe()
    }

    /// The number of records currently retained in the ring.
    #[must_use]
    pub fn len(&self) -> usize {
        self.inner
            .ring
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// Whether the ring currently holds no records.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Wire in the `EnvFilter` reload handle built by [`crate::init_telemetry`].
    /// A no-op (keeps the first) if a handle is already attached.
    pub(crate) fn attach_reload_handle(&self, handle: ReloadHandle) {
        let _ = self.inner.reload.set(handle);
    }

    /// Adjust the runtime log level filter to `directives` (`EnvFilter`
    /// syntax, e.g. `"info,ns_core=debug"`).
    ///
    /// # Limitations
    /// Only takes effect for a store returned by [`crate::init_telemetry`]:
    /// the reload handle is wired in at global-subscriber construction time.
    /// A store built directly via [`LogStore::new`] (e.g. in unit tests,
    /// which drive [`crate::layer::RingLayer`] with
    /// `tracing::subscriber::with_default` instead of installing a global
    /// subscriber) has no attached filter to reload, and this returns
    /// [`TelemetryError::LevelControlUnavailable`]. This is the documented
    /// fallback the crate charter allows in lieu of reload everywhere.
    ///
    /// # Errors
    /// Returns [`TelemetryError::InvalidDirective`] if `directives` fails to
    /// parse, or [`TelemetryError::LevelControlUnavailable`] if no reload
    /// handle is attached. The previously active filter is left in place in
    /// both error cases.
    pub fn set_level(&self, directives: &str) -> Result<(), TelemetryError> {
        let handle = self
            .inner
            .reload
            .get()
            .ok_or(TelemetryError::LevelControlUnavailable)?;
        let filter =
            EnvFilter::try_new(directives).map_err(|source| TelemetryError::InvalidDirective {
                directive: directives.to_string(),
                source,
            })?;
        handle.reload(filter)?;
        Ok(())
    }
}

/// Severity ordering for [`LogLevel`] (`ns_types` intentionally leaves this
/// type comparison-free; the ordering is a `ns-telemetry`-local concern).
fn level_rank(level: LogLevel) -> u8 {
    match level {
        LogLevel::Trace => 0,
        LogLevel::Debug => 1,
        LogLevel::Info => 2,
        LogLevel::Warn => 3,
        LogLevel::Error => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(level: LogLevel, message: &str) -> LogRecordDto {
        LogRecordDto {
            ts: "1970-01-01T00:00:00Z".into(),
            level,
            target: "test::target".into(),
            message: message.into(),
            connection_id: None,
            correlation_id: None,
        }
    }

    #[test]
    fn ring_drops_oldest_at_capacity() {
        let store = LogStore::new(2);
        store.record(record(LogLevel::Info, "one"));
        store.record(record(LogLevel::Info, "two"));
        store.record(record(LogLevel::Info, "three"));

        assert_eq!(store.len(), 2);
        let all = store.query(10, None);
        // Newest-first; "one" was evicted when "three" pushed the ring over capacity.
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].message, "three");
        assert_eq!(all[1].message, "two");
    }

    #[test]
    fn query_respects_limit() {
        let store = LogStore::new(10);
        for i in 0..5 {
            store.record(record(LogLevel::Info, &format!("msg-{i}")));
        }
        let page = store.query(2, None);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].message, "msg-4");
        assert_eq!(page[1].message, "msg-3");
    }

    #[test]
    fn query_respects_min_level() {
        let store = LogStore::new(10);
        store.record(record(LogLevel::Trace, "trace-msg"));
        store.record(record(LogLevel::Warn, "warn-msg"));
        store.record(record(LogLevel::Error, "error-msg"));

        let page = store.query(10, Some(LogLevel::Warn));
        assert_eq!(page.len(), 2);
        assert!(page.iter().all(|r| r.level != LogLevel::Trace));
        assert_eq!(page[0].message, "error-msg");
        assert_eq!(page[1].message, "warn-msg");
    }

    #[tokio::test]
    async fn subscriber_receives_new_records() {
        let store = LogStore::new(10);
        let mut rx = store.subscribe();

        store.record(record(LogLevel::Info, "live"));

        let received = rx.recv().await.expect("record delivered");
        assert_eq!(received.message, "live");
    }

    #[test]
    fn set_level_without_reload_handle_errors() {
        let store = LogStore::new(4);
        let err = store.set_level("info").expect_err("no handle attached");
        assert!(matches!(err, TelemetryError::LevelControlUnavailable));
    }

    #[test]
    fn set_level_reloads_attached_filter() {
        let store = LogStore::new(4);
        let (_filter_layer, handle): (reload::Layer<EnvFilter, Registry>, ReloadHandle) =
            reload::Layer::new(EnvFilter::new("info"));
        store.attach_reload_handle(handle);

        store.set_level("debug").expect("valid directive reloads");

        let err = store
            .set_level("bogus_target=not_a_real_level")
            .expect_err("invalid directive rejected");
        assert!(matches!(err, TelemetryError::InvalidDirective { .. }));
    }

    #[test]
    fn is_empty_reports_correctly() {
        let store = LogStore::new(4);
        assert!(store.is_empty());
        store.record(record(LogLevel::Info, "x"));
        assert!(!store.is_empty());
    }
}
