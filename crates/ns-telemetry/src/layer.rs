//! [`RingLayer`]: the `tracing_subscriber` [`Layer`] that feeds [`LogStore`].
//!
//! Captures the `message` field (via a [`Visit`] impl), the event's target
//! and level, and an RFC-3339 timestamp (via [`ns_core::SystemClock`]), then
//! pushes the resulting [`ns_types::LogRecordDto`] into the attached
//! [`LogStore`]. Span-field lifting (`connectionId`/`correlationId`) is a
//! later-phase concern (see `docs/architecture/sub-logging-observability.md`
//! §b) — Phase 1 always records these as `None`.

use std::fmt;

use ns_core::{Clock, SystemClock};
use ns_types::{LogLevel, LogRecordDto};
use tracing::field::{Field, Visit};
use tracing::Subscriber;
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

use crate::store::LogStore;

/// Bridges `tracing` events into a [`LogStore`]'s ring + broadcast fan-out.
pub(crate) struct RingLayer {
    store: LogStore,
}

impl RingLayer {
    pub(crate) fn new(store: LogStore) -> Self {
        Self { store }
    }
}

impl<S> Layer<S> for RingLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);

        let record = LogRecordDto {
            ts: SystemClock.now_rfc3339(),
            level: map_level(*event.metadata().level()),
            target: event.metadata().target().to_string(),
            message: visitor.message.unwrap_or_default(),
            connection_id: None,
            correlation_id: None,
        };
        self.store.record(record);
    }
}

/// Maps a `tracing::Level` to the wire [`LogLevel`].
fn map_level(level: tracing::Level) -> LogLevel {
    match level {
        tracing::Level::TRACE => LogLevel::Trace,
        tracing::Level::DEBUG => LogLevel::Debug,
        tracing::Level::INFO => LogLevel::Info,
        tracing::Level::WARN => LogLevel::Warn,
        tracing::Level::ERROR => LogLevel::Error,
    }
}

/// Collects the `message` field of an event. Formatting via `record_debug`
/// is deliberate and quote-free: `tracing`'s macros record the message as a
/// `fmt::Arguments`, whose `Debug` impl is identical to its `Display` impl
/// (i.e. the already-formatted text, not a debug-quoted string).
#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.message = Some(format!("{value:?}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::Registry;

    #[test]
    fn event_lands_in_store_with_expected_fields() {
        let store = LogStore::new(8);
        let subscriber = Registry::default().with(RingLayer::new(store.clone()));

        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(target: "ns_telemetry::test_target", "something happened: {}", 42);
        });

        let records = store.query(10, None);
        assert_eq!(records.len(), 1);
        let rec = &records[0];
        assert_eq!(rec.level, LogLevel::Warn);
        assert_eq!(rec.target, "ns_telemetry::test_target");
        assert_eq!(rec.message, "something happened: 42");
        assert!(rec.ts.contains('T'), "expected RFC-3339-ish ts: {}", rec.ts);
        assert!(rec.connection_id.is_none());
        assert!(rec.correlation_id.is_none());
    }

    #[test]
    fn maps_all_tracing_levels() {
        assert_eq!(map_level(tracing::Level::TRACE), LogLevel::Trace);
        assert_eq!(map_level(tracing::Level::DEBUG), LogLevel::Debug);
        assert_eq!(map_level(tracing::Level::INFO), LogLevel::Info);
        assert_eq!(map_level(tracing::Level::WARN), LogLevel::Warn);
        assert_eq!(map_level(tracing::Level::ERROR), LogLevel::Error);
    }
}
