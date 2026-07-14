//! The internal event envelope and the `EventPublisher` port (spine section 9).
//!
//! Services publish `Event`s through the `EventPublisher` port (implemented by
//! `ns-event`); the `EventBridge` in `ns-ipc` later translates bus events into
//! Tauri events for the WebView. Feature crates never import `tauri`.

use ns_types::EventPayload;
use time::OffsetDateTime;

/// A UI-relevant event topic. Maps 1:1 to a `ns://…` Tauri event name in the bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Topic {
    ConnectionStatus,
    ServerInfo,
    Metrics,
    Log,
    TaskProgress,
    Notification,
}

impl Topic {
    /// The namespaced URI the `EventBridge` emits under.
    #[must_use]
    pub fn as_uri(self) -> &'static str {
        match self {
            Topic::ConnectionStatus => "ns://connection/status",
            Topic::ServerInfo => "ns://server/info",
            Topic::Metrics => "ns://monitor/metrics",
            Topic::Log => "ns://log",
            Topic::TaskProgress => "ns://task/progress",
            Topic::Notification => "ns://notification",
        }
    }

    /// The topic a given payload belongs to.
    #[must_use]
    pub fn of(payload: &EventPayload) -> Topic {
        match payload {
            EventPayload::ConnectionStatusChanged(_) => Topic::ConnectionStatus,
            EventPayload::ServerInfoUpdated(_) => Topic::ServerInfo,
            EventPayload::MetricsTick(_) => Topic::Metrics,
            EventPayload::LogEmitted(_) => Topic::Log,
            EventPayload::TaskProgress(_) => Topic::TaskProgress,
            EventPayload::Notification(_) => Topic::Notification,
        }
    }
}

/// The internal event envelope produced by services and consumed by the bridge.
/// `seq` is assigned per-topic by the bus for UI gap detection.
#[derive(Debug, Clone)]
pub struct Event {
    pub topic: Topic,
    pub connection_id: Option<String>,
    pub seq: u64,
    pub ts: OffsetDateTime,
    pub payload: EventPayload,
}

impl Event {
    /// Build an event for `payload`, deriving the topic and stamping the time.
    /// `seq` starts at 0; the bus assigns the real per-topic sequence on publish.
    #[must_use]
    pub fn new(payload: EventPayload, connection_id: Option<String>, ts: OffsetDateTime) -> Self {
        Self {
            topic: Topic::of(&payload),
            connection_id,
            seq: 0,
            ts,
            payload,
        }
    }
}

/// Port for emitting domain events onto the internal bus. Implemented by `ns-event`.
pub trait EventPublisher: Send + Sync {
    fn publish(&self, event: Event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ns_types::{ConnectionStatus, ConnectionStatusDto};

    #[test]
    fn topic_derives_from_payload() {
        let payload = EventPayload::ConnectionStatusChanged(ConnectionStatusDto {
            connection_id: "c1".into(),
            status: ConnectionStatus::Connected,
            last_error: None,
            rtt_ms: Some(3),
        });
        assert_eq!(Topic::of(&payload), Topic::ConnectionStatus);
        assert_eq!(Topic::ConnectionStatus.as_uri(), "ns://connection/status");
    }
}
