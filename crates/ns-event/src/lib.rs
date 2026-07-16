//! `ns-event` — the internal async event bus for NATS Studio (spine §3 / §9).
//!
//! Feature services publish [`ns_core::Event`]s through the injected
//! [`ns_core::EventPublisher`] port; [`EventBus`] is the concrete implementation.
//! It fans events out over a single bounded [`tokio::sync::broadcast`] channel and
//! stamps each with a monotonic **per-topic** sequence number for UI gap
//! detection. The `EventBridge` in `ns-ipc` is the sole translator of these events
//! into Tauri events for the WebView — feature crates never import `tauri`.
//!
//! See `docs/architecture/sub-core-runtime.md`.
#![forbid(unsafe_code)]

mod bus;
mod error;

pub use bus::{EventBus, DEFAULT_CAPACITY};
pub use error::EventError;

#[cfg(test)]
mod tests {
    use super::*;
    use ns_core::{Event, EventPublisher, Topic};
    use ns_types::{
        ConnectionStatus, ConnectionStatusDto, EventPayload, NotificationDto, NotificationLevel,
    };
    use time::OffsetDateTime;
    use tokio::sync::broadcast::error::RecvError;

    fn connection_event(id: &str) -> Event {
        Event::new(
            EventPayload::ConnectionStatusChanged(ConnectionStatusDto {
                connection_id: id.into(),
                status: ConnectionStatus::Connected,
                last_error: None,
                rtt_ms: Some(3),
            }),
            Some(id.into()),
            OffsetDateTime::UNIX_EPOCH,
        )
    }

    fn notification_event() -> Event {
        Event::new(
            EventPayload::Notification(NotificationDto {
                id: "n1".into(),
                level: NotificationLevel::Info,
                title: "hello".into(),
                body: None,
                ts: "1970-01-01T00:00:00Z".into(),
            }),
            None,
            OffsetDateTime::UNIX_EPOCH,
        )
    }

    #[test]
    fn seq_increments_per_topic_independently() {
        let bus = EventBus::new();

        // Two events on the ConnectionStatus topic -> 1, 2.
        let a = bus.emit(connection_event("c1"));
        let b = bus.emit(connection_event("c1"));
        assert_eq!(a.seq, 1);
        assert_eq!(b.seq, 2);
        assert_eq!(a.topic, Topic::ConnectionStatus);

        // A different topic keeps its own counter, starting fresh at 1.
        let n = bus.emit(notification_event());
        assert_eq!(n.topic, Topic::Notification);
        assert_eq!(n.seq, 1);

        // The ConnectionStatus counter is unaffected by the Notification publish.
        let c = bus.emit(connection_event("c1"));
        assert_eq!(c.seq, 3);

        assert_eq!(bus.current_seq(Topic::ConnectionStatus), 3);
        assert_eq!(bus.current_seq(Topic::Notification), 1);
        assert_eq!(bus.current_seq(Topic::Metrics), 0);
    }

    #[tokio::test]
    async fn subscriber_receives_published_events() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        assert_eq!(bus.receiver_count(), 1);

        // Publish through the port trait to exercise the real seam.
        (&bus as &dyn EventPublisher).publish(connection_event("c1"));

        let received = rx.recv().await.expect("event delivered");
        assert_eq!(received.topic, Topic::ConnectionStatus);
        assert_eq!(received.seq, 1);
        match &received.payload {
            EventPayload::ConnectionStatusChanged(dto) => assert_eq!(dto.connection_id, "c1"),
            other => panic!("unexpected payload: {other:?}"),
        }
    }

    #[test]
    fn publishing_with_no_subscribers_does_not_panic() {
        let bus = EventBus::new();
        assert_eq!(bus.receiver_count(), 0);

        // Must not panic and must still advance the seq counter.
        let e = bus.emit(connection_event("c1"));
        assert_eq!(e.seq, 1);

        (&bus as &dyn EventPublisher).publish(notification_event());
        assert_eq!(bus.current_seq(Topic::Notification), 1);
    }

    #[test]
    fn clone_shares_underlying_state() {
        let bus = EventBus::new();
        let clone = bus.clone();

        // A publish on the clone advances the counter observed through the original.
        clone.emit(connection_event("c1"));
        assert_eq!(bus.current_seq(Topic::ConnectionStatus), 1);

        // Subscribers registered on either handle are visible from both.
        let _rx = bus.subscribe();
        assert_eq!(clone.receiver_count(), 1);
    }

    #[tokio::test]
    async fn lagging_subscriber_surfaces_gap() {
        // Small capacity so we can force a lag deterministically.
        let bus = EventBus::with_capacity(2);
        let mut rx = bus.subscribe();

        // Overflow the retained window (capacity 2, four sent) without receiving.
        for _ in 0..4 {
            bus.emit(connection_event("c1"));
        }

        // The next recv reports the gap; map it to the domain error.
        let err = rx.recv().await.expect_err("expected a lag");
        let mapped = EventError::from_recv(err);
        assert!(mapped.is_lagged(), "expected Lagged, got {mapped:?}");
        match mapped {
            EventError::Lagged { skipped } => assert_eq!(skipped, 2),
            other => panic!("unexpected error: {other:?}"),
        }

        // After absorbing the lag, the receiver resumes from the retained events.
        let next = rx.recv().await.expect("resumes after lag");
        assert_eq!(next.seq, 3);
    }

    #[tokio::test]
    async fn closed_bus_surfaces_closed() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        drop(bus);

        let err = rx.recv().await.expect_err("expected closed");
        assert_eq!(EventError::from_recv(err), EventError::Closed);
        assert_eq!(EventError::from_recv(RecvError::Closed), EventError::Closed);
    }
}
